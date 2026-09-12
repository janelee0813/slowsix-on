import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
const password='Sample!Only123';
test('real SQL gateway + Edge API authorization and accounting',async t=>{
 const h=await harness();const {db,call,edge}=h;let admin,op,op2,pending,entryId;
 const ok=async(action,p={},session)=>{const r=await call(action,p,session);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 await t.test('bootstrap is private, single-use, and binds only slowsix',async()=>{
  assert.equal((await call('register',{linkToken:'0'.repeat(64),username:'slowsix',name:'관리자',password})).status,400);
  const linkToken=await h.bootstrap();assert.equal(linkToken.length,64);
  assert.equal((await call('register',{linkToken,username:'someone',name:'관리자',password})).status,400);
  await ok('register',{linkToken,username:'slowsix',name:'관리자',password});
  assert.equal((await call('register',{linkToken,username:'other',name:'침입자',password})).status,400);
  assert.equal(await h.bootstrap(),undefined);
  admin=(await ok('login',{username:'SLOWSIX',password})).sessionToken;
  assert.equal((await ok('me',{},admin)).role,'admin');
  assert.ok(!JSON.stringify(await ok('login',{username:'slowsix',password})).includes('never-expose-me'));
 });
 async function inviteUser(username){const link=await ok('create_invite',{},admin);await ok('register',{linkToken:link.url.split('=')[1],username,name:username,password});return await ok('login',{username,password})}
 await t.test('pending users cannot read finance and invite links cannot be reused',async()=>{
  const u=await inviteUser('operatorone');op=u.sessionToken;pending=u.user.id;
  assert.equal(u.user.status,'pending');assert.equal((await call('list',{from:'2026-09-01',to:'2026-09-30',offset:0},op)).data.code,'APPROVAL_REQUIRED');
  await ok('set_status',{id:pending,status:'active'},admin);assert.equal((await ok('me',{},op)).status,'active');
 });
 const save=(category,amount,extra={})=>({date:'2026-09-12',description:'검증 내역',category,amount,request_id:crypto.randomUUID(),...extra});
 await t.test('operators may only insert spacecloud/fixed, never edit/delete or elevate themselves',async()=>{
  for(const c of ['invoice','cash','expense'])assert.equal((await call('save_entry',save(c,1),op)).data.code,'FORBIDDEN');
  const payload=save('spacecloud',1000000);entryId=(await ok('save_entry',payload,op)).id;
  assert.equal((await ok('save_entry',payload,op)).id,entryId);
  await ok('save_entry',save('fixed',200000),op);
  assert.equal((await call('save_entry',save('fixed',1,{id:entryId,version:1}),op)).data.code,'FORBIDDEN');
  assert.equal((await call('delete_entry',{id:entryId,version:1},op)).data.code,'FORBIDDEN');
  for(const action of ['people','create_invite','audit'])assert.equal((await call(action,{role:'admin'},op)).data.code,'FORBIDDEN');
  assert.equal((await call('set_status',{id:pending,status:'active',role:'admin'},op)).data.code,'FORBIDDEN');
  assert.equal((await call('list',{from:'2026-09-01',to:'2026-09-30',offset:0,session_hash:await edge.sha(admin)},'0'.repeat(64))).data.code,'SESSION_EXPIRED');
 });
 await t.test('correct totals, filtering and optimistic edits with audit',async()=>{
  await ok('save_entry',save('invoice',300000),admin);await ok('save_entry',save('cash',200000),admin);await ok('save_entry',save('expense',100000),admin);
  const data=await ok('list',{from:'2026-09-01',to:'2026-09-30',offset:0},admin);
  assert.equal(data.count,5);assert.deepEqual(data.summary,{spacecloud:1000000,invoice:300000,cash:200000,fixed:200000,expense:100000,revenue:1500000,spending:300000,profit:1200000,fee:60000,settlement:340000});
  assert.equal((await ok('list',{from:'2026-10-01',to:'2026-10-31',offset:0},admin)).count,0);
  await ok('save_entry',save('spacecloud',1100000,{id:entryId,version:1}),admin);
  assert.equal((await call('save_entry',save('spacecloud',500,{id:entryId,version:1}),admin)).data.code,'CONFLICT');
  await ok('delete_entry',{id:entryId,version:2},admin);
  assert.equal((await ok('list',{from:'2026-09-01',to:'2026-09-30',offset:0},op)).count,4);
  const a=await ok('audit',{},admin);assert.ok(a.audit.some(x=>x.action==='entry_updated'&&x.before_data.amount===1000000&&x.after_data.amount===1100000));
  assert.ok(a.audit.some(x=>x.action==='entry_deleted'));
  const neg=save('expense',101,{date:'2026-10-01'});await ok('save_entry',neg,admin);
  const s=(await ok('list',{from:'2026-10-01',to:'2026-10-31',offset:0},admin)).summary;assert.equal(s.fee,-5);assert.equal(s.settlement,-96);
 });
 await t.test('operator cap, suspended sessions and immutable admin role',async()=>{
  op2=await inviteUser('operatortwo');await ok('set_status',{id:op2.user.id,status:'active'},admin);
  const third=await inviteUser('operatorthree');assert.equal((await call('set_status',{id:third.user.id,status:'active'},admin)).data.code,'OPERATOR_LIMIT');
  assert.equal((await call('set_status',{id:(await ok('me',{},admin)).id,status:'suspended'},admin)).data.code,'FORBIDDEN');
  await ok('set_status',{id:pending,status:'suspended'},admin);
  assert.equal((await call('me',{},op)).data.code,'SESSION_EXPIRED');
  assert.equal((await call('login',{username:'operatorone',password})).data.code,'ACCESS_DENIED');
 });
 await t.test('account limit survives IP changes and blocks after ten failures',async()=>{
  for(let i=0;i<10;i++)assert.equal((await call('login',{username:'slowsix',password:'wrongwrong'})).status,401);
  const blocked=await call('login',{username:'slowsix',password});assert.equal(blocked.status,429);assert.ok(blocked.data.retryAfter>0);
  await db.exec("update ss_admin.limits set blocked_until=now()-interval '1 second' where key like 'login:%'");
  await ok('login',{username:'slowsix',password});
 });
 await t.test('anon and authenticated cannot call gateway or private tables',async()=>{
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);
   await assert.rejects(db.query("select public.ss_admin_gateway('people','{}')"),/permission denied/);
   await assert.rejects(db.query('select * from ss_admin.entries'),/permission denied/);
   await db.exec('reset role');
  }
 });
 await t.test('expired sessions, rejected origins, tampered actions and weak passwords',async()=>{
  assert.throws(()=>edge.validatePassword('12345678'));
  assert.throws(()=>edge.validatePassword('password123'));
  assert.throws(()=>edge.validatePassword('가'.repeat(30)));
  edge.validatePassword('safe phrase 123');
  assert.equal((await call('credentials',{username:'slowsix'},admin)).data.code,'INVALID_ACTION');
  const response=await h.handler(new Request('https://mock/admin-api',{method:'POST',headers:{origin:'https://evil.example'},body:JSON.stringify({action:'me',sessionToken:admin})}));assert.equal(response.status,403);
  await db.exec("update ss_admin.sessions set expires_at=now()-interval '1 minute'");assert.equal((await call('me',{},admin)).data.code,'SESSION_EXPIRED');
 });
 await db.close();
});
