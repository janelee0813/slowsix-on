import test from 'node:test';import assert from 'node:assert/strict';import {harness} from './harness.mjs';
test('coupon wallet, repeated grants, exclusive use, expiry and free-hour pricing',async()=>{
 const h=await harness(),{db,call}=h,password='CouponTest!2026';const ok=async(a,p={},s)=>{const r=await call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',name:'관리자',password});const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
 const join=async username=>{const linkToken=(await ok('member_invite',{tier:'friends'},admin)).url.split('=')[1];await ok('register',{linkToken,username,password,name:username,gender:'여성',age_group:'30대',purposes:['보드게임']});const person=(await ok('member_people',{},admin)).items.find(p=>p.username===username);await ok('member_person_save',{id:person.id,version:person.version,tier:'friends',status:'active'},admin);return {id:person.id,session:(await ok('login',{username,password})).sessionToken};};
 const member=await join('couponuser'),other=await join('otheruser');const wallet=async()=> (await ok('member_coupon_wallet',{},member.session)).items;
 const issue=async kind=>{const p={id:crypto.randomUUID(),member_id:member.id,kind,expires_at:new Date(Date.now()+60*86400000).toISOString()};await ok('member_coupon_issue',p,admin);return p;};
 let day=new Date(Date.now()+4*86400000);while(new Date(day.getTime()+9*3600000).getUTCDay()!==2)day=new Date(day.getTime()+86400000);const date=new Date(day.getTime()+9*3600000).toISOString().slice(0,10);
 const booking=(coupon_id,start=10,hours=3)=>{const starts_at=date+'T'+String(start).padStart(2,'0')+':00:00+09:00';return {id:crypto.randomUUID(),starts_at,ends_at:new Date(Date.parse(starts_at)+hours*3600000).toISOString(),guests:6,use_coupon:false,coupon_id,note:''};};
 try{
  const a=await issue('discount5000');await ok('member_coupon_issue',a,admin);assert.equal((await wallet()).filter(c=>c.kind==='discount5000').length,1);await issue('discount5000');assert.equal((await wallet()).filter(c=>c.kind==='discount5000').length,2);
  assert.equal((await call('member_coupon_issue',{...a,id:crypto.randomUUID()},member.session)).data.code,'FORBIDDEN');
  assert.equal((await call('member_quote',booking(a.id),other.session)).data.code,'COUPON_UNAVAILABLE');
  assert.equal((await call('member_request',{...booking(a.id),use_coupon:true},member.session)).data.code,'INVALID_ENTRY');
  const p=booking(a.id),r=await ok('member_request',p,member.session);assert.equal(r.coupon_amount,5000);assert.equal(r.total_amount,26680);assert.equal((await wallet()).find(c=>c.id===a.id).state,'held');assert.equal((await ok('member_request',p,member.session)).id,r.id);
  assert.equal((await call('member_quote',booking(a.id,15),member.session)).data.code,'COUPON_UNAVAILABLE');
  await ok('member_cancel',{id:r.id,version:1},member.session);assert.equal((await wallet()).find(c=>c.id===a.id).state,'available');
  const night=await issue('night');assert.equal((await call('member_quote',booking(night.id,10),member.session)).data.code,'COUPON_NOT_APPLICABLE');
  const q=await ok('member_quote',booking(night.id,0,9),member.session);assert.equal(q.total_amount,0);assert.equal(q.coupon_amount,95040);
  const partial=await ok('member_quote',booking(night.id,8,3),member.session);assert.equal(partial.coupon_amount,10560);assert.equal(partial.total_amount,21120);
  const hours=await issue('hours3');const short=await ok('member_quote',booking(hours.id,10,2),member.session);assert.equal(short.total_amount,0);const long=await ok('member_quote',booking(hours.id,10,4),member.session);assert.equal(long.coupon_amount,31680);assert.equal(long.total_amount,10560);
  const held=await ok('member_request',booking(hours.id,10,4),member.session);await ok('member_status',{id:held.id,version:1,status:'awaiting_payment',payment_note:'테스트'},admin);await ok('member_status',{id:held.id,version:2,status:'confirmed'},admin);assert.equal((await wallet()).find(c=>c.id===hours.id).state,'used');
  await db.query("update ss_admin.special_coupons set expires_at=now()-interval '1 day' where id=$1",[hours.id]);await ok('member_status',{id:held.id,version:3,status:'cancelled'},admin);assert.equal((await wallet()).find(c=>c.id===hours.id).state,'expired');assert.equal((await call('member_quote',booking(hours.id),member.session)).data.code,'COUPON_UNAVAILABLE');
  assert.equal((await ok('member_coupon_wallet',{},other.session)).items.some(c=>c.id===a.id),false);
 }finally{await db.close();}
});
