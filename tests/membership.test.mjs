import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {harness} from './harness.mjs';
const password='TestMembership!27';
const future=(days=2,hour=10)=>{const d=new Date(Date.now()+days*86400000+9*3600000).toISOString().slice(0,10);return d+'T'+String(hour).padStart(2,'0')+':00:00+09:00';};
const payload=(days=2,hour=10,extra={})=>{const starts_at=future(days,hour);return {id:crypto.randomUUID(),starts_at,ends_at:new Date(Date.parse(starts_at)+2*3600000).toISOString(),guests:6,use_coupon:true,note:'테스트 요청',...extra};};
test('membership permissions, price snapshots, coupon and booking lifecycle',async t=>{
 const h=await harness(),{db,call}=h;const ok=async(a,p={},s)=>{const r=await call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const boot=await h.bootstrap();await ok('register',{username:'slowsix',password,name:'관리자',linkToken:boot});let admin=(await ok('login',{username:'slowsix',password})).sessionToken;
 const opLink=await ok('create_invite',{},admin);await ok('register',{username:'operator',password,name:'운영자',linkToken:opLink.url.split('=')[1]});const opResult=await ok('login',{username:'operator',password});const op=opResult.sessionToken;await ok('set_status',{id:opResult.user.id,status:'active'},admin);
 const join=async(username,tier)=>{const link=await ok('member_invite',{tier},admin),linkToken=link.url.split('=')[1];assert.match(link.url,/membership.html#invite=/);assert.equal((await ok('link_info',{linkToken})).tier,tier);await ok('register',{username,password,name:username,linkToken,gender:'여성',age_group:'30대',purposes:['보드게임','친목모임'],tier:'crew',role:'admin'});assert.equal((await call('register',{username:username+'x',password,name:'x',linkToken})).data.code,'LINK_INVALID');assert.equal((await call('login',{username,password})).data.code,'APPROVAL_REQUIRED');const pending=(await ok('member_people',{},admin)).items.find(x=>x.username===username);assert.equal(pending.status,'pending');assert.equal((await call('member_person_save',{id:pending.id,version:pending.version,tier,status:'active'},op)).data.code,'FORBIDDEN');await ok('member_person_save',{id:pending.id,version:pending.version,tier,status:'active'},admin);return await ok('login',{username,password});};
 const friend=await join('frienduser','friends'),crew=await join('crewuser','crew');const f=friend.sessionToken,c=crew.sessionToken;let booking;
 await t.test('all membership profile fields are required without consuming the invitation on failure',async()=>{
  const linkToken=(await ok('member_invite',{tier:'friends'},admin)).url.split('=')[1];
  const base={linkToken,username:'requireduser',password,name:'필수 회원',gender:'남성',age_group:'20대',purposes:['보드게임']};
  for(const patch of [{gender:''},{age_group:''},{purposes:[]},{gender:'응답 안 함'},{age_group:'응답 안 함'},{gender:null},{age_group:null},{purposes:null}]){
   assert.equal((await call('register',{...base,...patch})).data.code,'INVALID_ENTRY');
  }
  assert.equal((await ok('link_info',{linkToken})).kind,'member');await ok('register',base);
 });
 await t.test('invitation grants exact tier; operators and members cannot access admin functions',async()=>{
  assert.equal(friend.user.role,'member');assert.equal((await ok('member_home',{},f)).tier,'friends');
  for(const action of ['member_home','member_people','member_bookings','member_calendar','member_inbox'])assert.equal((await call(action,{from:future(1),to:future(30)},op)).data.code,'FORBIDDEN');
  for(const action of ['people','audit','recurring_list','list','member_people','member_invites','member_settings','member_inbox'])assert.equal((await call(action,action==='list'?{from:'2026-09-01',to:'2026-09-30',offset:0}:{},f)).data.code,'FORBIDDEN');
  assert.equal((await call('member_invite',{tier:'crew'},f)).data.code,'FORBIDDEN');
  assert.equal((await ok('people',{},admin)).people.some(x=>x.role==='member'),false);
 });
 await t.test('weekday/weekend cross-midnight prices and forged totals are calculated on server',async()=>{
  let friday=2;while(new Date(Date.parse(future(friday))+9*3600000).getUTCDay()!==5)friday++;
  const p=payload(friday,23);const q=await ok('member_quote',{...p,tier:'crew',base_amount:0,total_amount:1},f);
  assert.equal(q.base_amount,27000);assert.equal(q.discount_percent,12);assert.equal(q.total_amount,20760);
  const cq=await ok('member_quote',p,c);assert.equal(cq.total_amount,18600);
  for(const patch of [{guests:5},{guests:14},{starts_at:future(2,10).replace(':00:',':30:')},{ends_at:future(1)}])assert.equal((await call('member_quote',{...p,...patch},f)).status,400);
  booking=await ok('member_request',{...p,total_amount:0},f);assert.equal(booking.total_amount,q.total_amount);
  assert.equal((await ok('member_request',p,f)).id,booking.id);
  assert.equal((await ok('member_home',{},f)).coupon_remaining,0);
 });
 await t.test('availability is private and overlapping requests are blocked',async()=>{
  const p={from:new Date(Date.now()).toISOString(),to:new Date(Date.now()+30*86400000).toISOString()};
  const calendar=await ok('member_calendar',p,c);assert.ok(calendar.items.length);assert.deepEqual(Object.keys(calendar.items[0]).sort(),['ends_at','starts_at']);
  assert.equal((await ok('member_bookings',p,c)).items.length,0);
  assert.equal((await call('member_request',{...payload(),starts_at:booking.starts_at,ends_at:booking.ends_at},c)).data.code,'TIME_UNAVAILABLE');
  assert.equal((await call('member_cancel',{id:booking.id,version:1},c)).data.code,'FORBIDDEN');
  const p2=payload(20);const [a,b]=await Promise.all([call('member_request',p2,c),call('member_request',{...p2,id:crypto.randomUUID()},c)]);assert.deepEqual([a.status,b.status].sort(),[200,400]);
 });
 await t.test('rejection restores coupon, confirmation keeps it used and prices never change',async()=>{
  await ok('member_status',{id:booking.id,version:1,status:'rejected',admin_note:'일정 중복'},admin);assert.equal((await ok('member_home',{},f)).coupon_remaining,1);
  booking=await ok('member_request',payload(23),f);assert.equal((await call('member_status',{id:booking.id,version:1,status:'confirmed'},admin)).data.code,'INVALID_TRANSITION');
  assert.equal((await call('member_status',{id:booking.id,version:1,status:'awaiting_payment'},admin)).data.code,'PAYMENT_NOTE_REQUIRED');
  await ok('member_status',{id:booking.id,version:1,status:'awaiting_payment',payment_note:'테스트 은행 123 / 오늘까지'},admin);
  assert.equal((await ok('member_home',{},f)).coupon_remaining,0);
  const member=(await ok('member_people',{},admin)).items.find(x=>x.id===friend.user.id);await ok('member_person_save',{id:member.id,version:member.version,tier:'crew',status:'active'},admin);
  const confirmed=await ok('member_status',{id:booking.id,version:2,status:'confirmed'},admin);assert.equal(confirmed.discount_percent,12);assert.equal(confirmed.total_amount,booking.total_amount);
  assert.equal((await call('member_cancel',{id:booking.id,version:3},f)).data.code,'CANCEL_REQUIRES_ADMIN');
  assert.equal((await call('member_status',{id:booking.id,version:1,status:'cancelled'},admin)).data.code,'CONFLICT');
  await ok('member_status',{id:booking.id,version:3,status:'cancelled'},admin);assert.equal((await ok('member_home',{},f)).coupon_remaining,2);
  assert.ok((await ok('member_home',{},f)).notifications.some(n=>n.message.includes('확정')));
 });
 await t.test('crew has exactly two coupons and monthly issuance/restoration is bounded',async()=>{
  await ok('member_request',payload(25),c);assert.equal((await ok('member_home',{},c)).coupon_remaining,0);
  assert.equal((await call('member_request',payload(26),c)).data.code,'COUPON_UNAVAILABLE');
  const noCoupon=await ok('member_request',payload(26,10,{use_coupon:false}),c);assert.equal(noCoupon.coupon_amount,0);
  await db.query("update ss_admin.bookings set coupon_month=(date_trunc('month',now() at time zone 'Asia/Seoul')-interval '1 month')::date where member_id=$1 and coupon_slot is not null",[crew.user.id]);
  assert.equal((await ok('member_home',{},c)).coupon_remaining,2);
  const fresh=await ok('member_request',payload(27),c);assert.equal((await ok('member_home',{},c)).coupon_remaining,1);
  await ok('member_cancel',{id:fresh.id,version:1},c);assert.equal((await ok('member_home',{},c)).coupon_remaining,2);
 });
 await t.test('admin blocks, revocation, notifications and suspension are enforced',async()=>{
  admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const block=payload(28);await ok('member_block_save',block,admin);assert.equal((await call('member_request',block,f)).data.code,'TIME_UNAVAILABLE');
  await ok('member_block_delete',{id:block.id},admin);await ok('member_request',block,f);
  const link=await ok('member_invite',{tier:'friends'},admin);const invites=(await ok('member_invites',{},admin)).items;await ok('member_revoke',{id:invites.find(x=>!x.used_at&&!x.revoked_at).id},admin);assert.equal((await call('link_info',{linkToken:link.url.split('=')[1]})).data.code,'LINK_INVALID');
  const home=await ok('member_home',{},admin);assert.ok(home.notifications.some(n=>n.message.includes('요청')));await ok('member_read',{through:Math.max(...home.notifications.map(n=>Number(n.id)))},admin);assert.ok((await ok('member_home',{},admin)).notifications.every(n=>n.read_at));
  const me=(await ok('member_people',{},admin)).items.find(x=>x.id===friend.user.id);await ok('member_person_save',{id:me.id,version:me.version,tier:'friends',status:'suspended'},admin);assert.equal((await call('member_home',{},f)).data.code,'SESSION_EXPIRED');
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);try{await assert.rejects(db.query('select * from ss_admin.bookings'));await assert.rejects(db.query("select ss_admin.finance_gateway('people','{}')"));}finally{await db.exec('reset role');}}
  await db.exec(await readFile(new URL('../supabase/migrations/202609150007_coupon_wallet.sql',import.meta.url),'utf8'));assert.ok((await ok('member_inbox',{},admin)).items.length);
 });
 await t.test('only administrators may delete members; sessions revoked and history protected',async()=>{
  const fresh=await join('deletetest','friends');const member=(await ok('member_people',{},admin)).items.find(x=>x.id===fresh.user.id);
  assert.equal((await call('member_delete',{id:member.id,version:member.version},op)).data.code,'FORBIDDEN');assert.equal((await call('member_delete',{id:member.id,version:member.version},f)).status!==200,true);
  const crewMember=(await ok('member_people',{},admin)).items.find(x=>x.id===crew.user.id);assert.equal((await call('member_delete',{id:crewMember.id,version:crewMember.version},admin)).data.code,'MEMBER_HAS_BOOKINGS');
  await ok('member_delete',{id:member.id,version:member.version},admin);assert.equal((await ok('member_people',{},admin)).items.some(x=>x.id===member.id),false);assert.equal((await call('member_home',{},fresh.sessionToken)).data.code,'SESSION_EXPIRED');assert.equal((await call('login',{username:'deletetest',password})).data.code,'ACCESS_DENIED');
  assert.equal((await call('member_person_save',{id:member.id,version:member.version+1,tier:'friends',status:'active'},admin)).data.code,'CONFLICT');
 });
 await t.test('external reservations are masked on server and block requests; feed errors fail closed',async()=>{
  const p=payload(33,18,{use_coupon:false}),ical=v=>v.replace(/[-:]/g,'').replace(/\.000Z$/,'Z');
  const raw='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:'+ical(new Date(p.starts_at).toISOString())+'\r\nDTEND:'+ical(p.ends_at)+'\r\nSUMMARY:홍길동\r\nDESCRIPTION:private@example.com 01012345678\r\nEND:VEVENT\r\nEND:VCALENDAR';
  h.setCalendarFeed(raw);assert.equal((await call('member_request',p,c)).data.code,'TIME_UNAVAILABLE');
  const data=await ok('member_calendar',{from:future(32),to:future(35)},c);const event=data.items.find(x=>x.source==='spacecloud');assert.equal(event.masked_name,'홍**');assert.ok(!JSON.stringify(data).includes('길동'));assert.ok(!JSON.stringify(data).includes('private@'));assert.deepEqual(Object.keys(event).sort(),['ends_at','masked_name','source','starts_at']);
  const parsed=h.edge.parseReservationFeed('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260918T230000\nDTEND:20260919T010000\nSUMMARY:김가\n 나\nEND:VEVENT\nEND:VCALENDAR');assert.equal(parsed[0].masked_name,'김**');assert.equal(parsed[0].starts_at,'2026-09-18T14:00:00.000Z');
  assert.equal(h.edge.parseReservationFeed(raw.replace('SUMMARY:홍길동','STATUS:CANCELLED\r\nSUMMARY:홍길동')).length,0);
  assert.throws(()=>h.edge.parseReservationFeed(raw.replace('BEGIN:VEVENT','BEGIN:VEVENT\r\nRRULE:FREQ=DAILY')));
  assert.throws(()=>h.edge.parseReservationFeed('not a calendar'));
  h.setCalendarFeed(null);assert.equal((await call('member_request',payload(34,18,{use_coupon:false}),c)).data.code,'EXTERNAL_CALENDAR_UNAVAILABLE');
 });
 await t.test('session browsing allowance does not weaken the ten-attempt login limit',async()=>{const fresh=(await ok('login',{username:'slowsix',password})).sessionToken;for(let i=0;i<105;i++)await ok('member_home',{},fresh);});
 await db.close();
});
