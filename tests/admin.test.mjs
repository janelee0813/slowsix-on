import test from 'node:test';
import {readFile} from 'node:fs/promises';
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
  await ok('save_fee',{from:'2026-09-01',to:'2026-09-30',amount:73000,version:0},admin);
  const data=await ok('list',{from:'2026-09-01',to:'2026-09-30',offset:0},admin);
  assert.equal(data.count,5);assert.deepEqual(data.summary,{spacecloud:1000000,invoice:300000,cash:200000,fixed:200000,expense:100000,revenue:1500000,spending:300000,fee_mode:'manual',fee_version:1,profit:1200000,fee:73000,settlement:327000});
  assert.equal((await ok('list',{from:'2026-10-01',to:'2026-10-31',offset:0},admin)).count,0);
  await ok('save_entry',save('spacecloud',1100000,{id:entryId,version:1}),admin);
  assert.equal((await call('save_entry',save('spacecloud',500,{id:entryId,version:1}),admin)).data.code,'CONFLICT');
  await ok('delete_entry',{id:entryId,version:2},admin);
  assert.equal((await ok('list',{from:'2026-09-01',to:'2026-09-30',offset:0},op)).count,4);
  const a=await ok('audit',{},admin);assert.ok(a.audit.some(x=>x.action==='entry_updated'&&x.before_data.amount===1000000&&x.after_data.amount===1100000));
  assert.ok(a.audit.some(x=>x.action==='entry_deleted'));
  const neg=save('expense',101,{date:'2026-10-01'});await ok('save_entry',neg,admin);
  await ok('save_fee',{from:'2026-10-01',to:'2026-10-31',amount:-7,version:0},admin);
  const s=(await ok('list',{from:'2026-10-01',to:'2026-10-31',offset:0},admin)).summary;assert.equal(s.profit,-101);assert.equal(s.fee,-7);assert.equal(s.settlement,-94);
 });
 await t.test('manual fee persists by exact period, accepts zero and rejects operators/stale writes',async()=>{
  const period={from:'2026-08-12',to:'2026-09-11'};
  const summary=async()=> (await ok('list',{...period,offset:0},op)).summary;
  await db.query("insert into ss_admin.period_profits(period_start,period_end,amount,updated_by) select '2026-08-12','2026-09-11',999999,id from ss_admin.people where role='admin'");
  await db.exec(await readFile(new URL('../supabase/migrations/202609150003_recurring_expenses.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609150004_membership.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609150005_member_approval.sql',import.meta.url),'utf8'));
  assert.equal((await ok('list',{from:'2026-09-01',to:'2026-09-30',offset:0},admin)).summary.fee,73000);
  assert.equal((await call('save_profit',{...period,amount:1,version:0},admin)).data.code,'INVALID_ACTION');
  assert.equal((await db.query('select amount from ss_admin.period_profits')).rows[0].amount,999999);
  assert.equal((await summary()).profit,0);assert.equal((await summary()).fee,null);assert.equal((await summary()).settlement,null);
  assert.equal((await call('save_fee',{...period,amount:999,version:0,role:'admin'},op)).data.code,'FORBIDDEN');
  await ok('save_fee',{...period,amount:1000010,version:0},admin);
  assert.equal((await summary()).fee,1000010);assert.equal((await summary()).settlement,-1000010);
  assert.equal((await call('save_fee',{...period,amount:123,version:0},admin)).data.code,'CONFLICT');
  await ok('save_fee',{...period,amount:0,version:1},admin);
  assert.equal((await summary()).profit,0);assert.equal((await summary()).fee,0);
  assert.equal((await ok('list',{from:'2026-08-12',to:'2026-09-10',offset:0},admin)).summary.fee,null);
  await ok('save_entry',save('cash',50000,{date:'2026-09-01'}),admin);
  const changed=await summary();assert.equal(changed.profit,50000);assert.equal(changed.revenue,50000);assert.equal(changed.settlement,50000);
  for(const amount of [null,'0',1.5,1e12+1])assert.equal((await call('save_fee',{...period,amount,version:2},admin)).data.code,'INVALID_ENTRY');
  assert.equal((await call('save_fee',{from:'2026-09-12',to:'2026-08-11',amount:1,version:0},admin)).data.code,'INVALID_PERIOD');
  const audit=await ok('audit',{},admin);assert.ok(audit.audit.some(a=>a.action==='fee_saved'&&a.before_data?.amount===1000010&&a.after_data.amount===0));
 });
 await t.test('all data columns sort globally with blank amounts last',async()=>{
  admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const period={from:'2026-11-12',to:'2026-12-11'};
  await db.query("insert into ss_admin.entries(entry_date,description,category,amount,created_by,updated_by,request_id) select date '2026-11-12'+(i%20),lpad(i::text,3,'0'),(array['spacecloud','invoice','cash','fixed','expense'])[1+i%5],i,u.id,u.id,gen_random_uuid() from generate_series(1,205) i cross join ss_admin.people u where u.role='admin'");
  for(const key of ['date','author','description','spacecloud','invoice','cash','fixed','expense'])for(const dir of ['asc','desc']){
   const rows=[];for(const offset of [0,100,200]){const result=await ok('list',{...period,offset,sort_by:key,sort_dir:dir},admin);assert.equal(result.sort_supported,true);rows.push(...result.entries);}
   assert.equal(rows.length,205);
   const value=r=>key==='date'?r.entry_date:key==='author'?r.author:key==='description'?r.description:r.category===key?r.amount:null;
   const values=rows.map(value),present=values.filter(v=>v!==null);assert.deepEqual(values.slice(0,present.length),present);
   for(let i=1;i<present.length;i++)assert.ok(dir==='asc'?present[i-1]<=present[i]:present[i-1]>=present[i]);
  }
  assert.equal((await call('list',{...period,offset:0,sort_by:'untrusted'},admin)).data.code,'INVALID_ENTRY');
 });
 await t.test('persistent sessions stay revocable and both roles may change only their own nickname',async()=>{
  // Get fresh sessions so the large sorting test does not exhaust the request window.
  admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const me=await ok('me',{},admin),beforeOp=await ok('me',{},op);
  assert.equal((await db.query("select expires_at::text as expiry from ss_admin.sessions where token_hash=$1",[await edge.sha(admin)])).rows[0].expiry,'infinity');
  await ok('update_name',{name:'새 관리자',id:beforeOp.id,role:'operator'},admin);
  await ok('update_name',{name:'새 운영자',id:me.id,role:'admin'},op);
  assert.equal((await ok('me',{},admin)).username,'slowsix');assert.equal((await ok('me',{},admin)).name,'새 관리자');
  assert.equal((await ok('me',{},op)).role,'operator');assert.equal((await ok('me',{},op)).name,'새 운영자');
  assert.equal((await call('update_name',{name:'  '},op)).status,400);
  const extra=(await ok('login',{username:'slowsix',password})).sessionToken;await ok('logout',{},extra);assert.equal((await call('me',{},extra)).data.code,'SESSION_EXPIRED');
 });
 await t.test('recurring expenses expand once per cycle, preserve permissions and update all totals',async()=>{
  admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const rule={id:crypto.randomUUID(),version:0,description:'반복 월세',category:'fixed',amount:700000,start_month:'2040-12-01',end_month:'2041-02-01'};
  assert.equal((await call('recurring_save',rule,op)).data.code,'FORBIDDEN');
  const id=(await ok('recurring_save',rule,admin)).id;
  assert.equal((await ok('recurring_save',rule,admin)).id,id);
  const general={...rule,id:crypto.randomUUID(),description:'정기 청소',category:'expense',amount:100000,end_month:null};
  await ok('recurring_save',general,admin);
  assert.equal((await ok('recurring_list',{},op)).items.length,2);
  const period={from:'2040-12-12',to:'2041-01-11',offset:0};
  await ok('save_fee',{...period,amount:3000,version:0},admin);
  await ok('save_entry',save('cash',1000000,{date:'2041-01-05'}),admin);
  const a=await ok('list',period,admin),b=await ok('list',period,op);
  assert.equal(a.count,3);assert.deepEqual(a,b);assert.equal(a.summary.fixed,700000);assert.equal(a.summary.expense,100000);
  assert.equal(a.summary.spending,800000);assert.equal(a.summary.profit,200000);assert.equal(a.summary.settlement,897000);
  assert.equal(a.entries.filter(r=>r.recurring_id).length,2);assert.ok(a.entries.filter(r=>r.recurring_id).every(r=>r.entry_date==='2040-12-12'));
  assert.equal((await db.query("select count(*)::int n from ss_admin.entries where entry_date between '2040-12-12' and '2041-01-11'")).rows[0].n,1);
  assert.equal((await ok('list',{from:'2040-12-01',to:'2040-12-11',offset:0},admin)).count,0);
  assert.equal((await ok('list',{from:'2041-02-12',to:'2041-03-11',offset:0},admin)).count,2);
  assert.equal((await ok('list',{from:'2041-03-12',to:'2041-04-11',offset:0},admin)).count,1);
  assert.equal((await ok('list',{from:'2040-12-12',to:'2041-03-11',offset:0,sort_by:'fixed',sort_dir:'desc'},admin)).count,7);
  const revised={...rule,version:1,end_month:'2040-12-01'};
  await ok('recurring_save',revised,admin);
  assert.equal((await ok('list',period,admin)).summary.fixed,700000);
  assert.equal((await ok('list',{from:'2041-01-12',to:'2041-02-11',offset:0},admin)).summary.fixed,0);
  assert.equal((await call('recurring_save',{...revised,amount:1},admin)).data.code,'CONFLICT');
  for(const bad of [{start_month:'2040-12-12'},{end_month:'2040-11-01'},{category:'cash'},{amount:1.5},{description:' ' }])assert.equal((await call('recurring_save',{...rule,id:crypto.randomUUID(),...bad},admin)).data.code,'INVALID_ENTRY');
  assert.equal((await call('recurring_delete',{id:general.id,version:1},op)).data.code,'FORBIDDEN');
  await ok('recurring_delete',{id:general.id,version:1},admin);
  assert.equal((await ok('list',period,admin)).summary.expense,0);
  assert.equal((await call('recurring_save',general,admin)).data.code,'CONFLICT');
  const audit=await ok('audit',{},admin);assert.ok(audit.audit.some(r=>r.action==='recurring_saved'));assert.ok(audit.audit.some(r=>r.action==='recurring_deleted'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609150003_recurring_expenses.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609150004_membership.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609150005_member_approval.sql',import.meta.url),'utf8'));
  assert.equal((await ok('list',period,admin)).summary.fixed,700000);
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
   await assert.rejects(db.query('select * from ss_admin.period_profits'),/permission denied/);
   await assert.rejects(db.query('select * from ss_admin.period_fees'),/permission denied/);
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
