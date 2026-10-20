import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness} from './harness.mjs';
import {bookingCard} from '../assets/membership-shared.js';
import {JSDOM} from 'jsdom';
test('short codes backfill without changing reservations, remain unique and preserve UUID authorization',async()=>{
 const h=await harness({through:'202610200001_crew_benefits.sql'}),{db}=h;
 const ok=async(a,p={},s)=>{const r=await h.call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 try{
  const password='CodeTesting!2026';await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',password,name:'관리자'});const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const linkToken=(await ok('member_invite',{tier:'crew'},admin)).url.split('=')[1];await ok('register',{linkToken,username:'codemember',password,name:'테스트',phone:'01000000000',gender:'여성',age_group:'30대',purposes:['보드게임']});const person=(await ok('member_people',{},admin)).items[0];await ok('member_person_save',{id:person.id,version:person.version,tier:'crew',status:'active'},admin);const session=(await ok('login',{username:'codemember',password})).sessionToken;
  const st=new Date(Date.now()+864000000);st.setUTCMinutes(0,0,0);const p={id:crypto.randomUUID(),starts_at:st.toISOString(),ends_at:new Date(+st+7200000).toISOString(),guests:6,use_coupon:false,note:''};
  const old=await ok('member_request',p,session);const migration=await readFile(new URL('../supabase/migrations/202610200002_short_booking_codes.sql',import.meta.url),'utf8');await db.exec(migration);
  const current=await ok('member_request',p,session);assert.equal(current.id,old.id);assert.equal(current.total_amount,old.total_amount);assert.equal(current.version,old.version);assert.equal(current.status,old.status);assert.equal(current.booking_code,'SS-000001');
  const jobs=(await db.query('select snapshot from ss_admin.alimtalk_jobs')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].snapshot.booking_code,current.booking_code);assert.equal(jobs[0].snapshot.total_amount,old.total_amount);
  await db.exec(migration);assert.equal((await ok('member_request',p,session)).booking_code,current.booking_code);const second=await ok('member_request',{...p,id:crypto.randomUUID(),starts_at:new Date(+st+86400000).toISOString(),ends_at:new Date(+st+86400000+7200000).toISOString()},session);assert.equal(second.booking_code,'SS-000002');
  await db.query("select setval('ss_admin.bookings_booking_number_seq',999999,true)");const third=await ok('member_request',{...p,id:crypto.randomUUID(),starts_at:new Date(+st+172800000).toISOString(),ends_at:new Date(+st+172800000+7200000).toISOString()},session);assert.equal(third.booking_code,'SS-1000000');
  const dom=new JSDOM();globalThis.document=dom.window.document;try{assert.match(bookingCard(current).textContent,/예약번호: SS-000001/);assert.equal(bookingCard(current).textContent.includes(current.id),false);}finally{delete globalThis.document;dom.window.close();}
  await db.exec('set role anon');await assert.rejects(()=>db.query('select booking_code from ss_admin.bookings'));await assert.rejects(()=>db.query("select nextval('ss_admin.bookings_booking_number_seq')"));await db.exec('reset role');
 }finally{await db.close();}
});
