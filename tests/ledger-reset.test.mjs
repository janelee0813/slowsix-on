import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness} from './harness.mjs';
test('ledger reset archives all finance records, preserves other data, and can safely recover',async()=>{
 const h=await harness(),ok=async(action,p={},sessionToken)=>{const r=await h.call(action,p,sessionToken);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 try{
  await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',password:'ResetTest!2026',name:'관리자'});
  const admin=(await ok('login',{username:'slowsix',password:'ResetTest!2026'})).sessionToken;
  const periods=[{from:'2026-09-01',to:'2026-09-30',offset:0},{from:'2026-10-01',to:'2026-10-31',offset:0}];
  for(const p of periods){await ok('save_entry',{date:p.from,description:'초기화 전 기록',category:'cash',amount:10000,request_id:crypto.randomUUID()},admin);await ok('save_fee',{...p,amount:500,version:0},admin);}
  await ok('recurring_save',{id:crypto.randomUUID(),version:0,description:'초기화 전 월세',category:'fixed',amount:1000,start_month:'2026-09-01',end_month:null},admin);
  const beforePeople=await h.db.query('select * from ss_admin.people'),beforeSessions=await h.db.query('select * from ss_admin.sessions');
  await h.db.query("insert into ss_admin.booking_blocks(id,space,starts_at,ends_at,note,created_by) select gen_random_uuid(),'p','2026-11-01T00:00:00Z','2026-11-01T01:00:00Z','유지할 예약 일정',id from ss_admin.people where role='admin'");
  const beforeBlocks=await h.db.query('select * from ss_admin.booking_blocks');
  const reset=await readFile(new URL('../supabase/reset-ledger-202610.sql',import.meta.url),'utf8');
  await h.db.exec(reset);
  for(const p of periods){const list=await ok('list',p,admin);assert.equal(list.count,0);assert.equal(list.summary.revenue,0);assert.equal(list.summary.spending,0);assert.equal(list.summary.fee,null);assert.equal(list.summary.settlement,null);}
  assert.equal((await ok('recurring_list',{},admin)).items.length,0);
  assert.deepEqual(await h.db.query('select * from ss_admin.people'),beforePeople);
  assert.deepEqual(await h.db.query('select * from ss_admin.sessions'),beforeSessions);
  assert.deepEqual(await h.db.query('select * from ss_admin.booking_blocks'),beforeBlocks);
  const archive=(await h.db.query("select snapshot from ss_admin.ledger_archives where id='restart-2026-10'")).rows[0].snapshot;
  assert.equal(archive.entries.length,2);assert.equal(archive.fees.length,2);assert.equal(archive.recurring.length,1);
  for(const role of ['anon','authenticated','service_role']){await h.db.exec('set role '+role);await assert.rejects(h.db.query('select * from ss_admin.ledger_archives'),/permission denied/);await h.db.exec('reset role');}
  await ok('save_entry',{date:'2026-10-15',description:'새로운 10월 기록',category:'cash',amount:25000,request_id:crypto.randomUUID()},admin);
  await ok('save_fee',{...periods[1],amount:900,version:0},admin);
  await h.db.exec(reset); // Retry never clears post-reset work.
  let october=await ok('list',periods[1],admin);assert.equal(october.count,1);assert.equal(october.summary.fee,900);
  await h.db.exec(await readFile(new URL('../supabase/restore-ledger-202610.sql',import.meta.url),'utf8'));
  october=await ok('list',periods[1],admin);assert.equal(october.count,3);assert.equal(october.summary.fee,900);assert.equal(october.summary.revenue,35000);assert.equal(october.summary.fixed,1000);
  assert.equal((await ok('list',periods[0],admin)).summary.fee,500);
 }finally{await h.db.close();}
});
