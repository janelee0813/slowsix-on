import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';

test('calendars show only provider events, preserve overlapping external events and refresh without stale cache',async()=>{
 const h=await harness(),ok=async(a,p={},s)=>{const r=await h.call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 try{
  const password='ScheduleTest!2026';
  await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',password,name:'관리자'});
  const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const link=await ok('member_invite',{tier:'friends'},admin);
  await ok('register',{linkToken:link.url.split('=')[1],username:'schedulefriend',password,name:'비공개닉네임',gender:'여성',age_group:'30대',phone:'01000000000',purposes:['보드게임']});
  const person=(await ok('member_people',{},admin)).items[0];
  await ok('member_person_save',{id:person.id,version:person.version,tier:'friends',status:'active'},admin);
  const member=(await ok('login',{username:'schedulefriend',password})).sessionToken;
  const date=new Date(Date.now()+10*86400000).toISOString().slice(0,10);
  const period={from:date+'T00:00:00+09:00',to:date+'T23:59:59+09:00'};
  const compact=date.replaceAll('-','');
  const next=new Date(Date.parse(date)+86400000).toISOString().slice(0,10).replaceAll('-','');
  const scFeed=`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${compact}T120000\nDTEND:${compact}T130000\nSUMMARY:홍길동\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:${compact}T183000\nDTEND:${compact}T193000\nSUMMARY:김철수\nEND:VEVENT\nEND:VCALENDAR`;
  const gongFeed='BEGIN:VCALENDAR\n'+[1,2,3].map(branch=>`BEGIN:VEVENT\nDTSTART;VALUE=DATE:${compact}\nDTEND;VALUE=DATE:${next}\nSUMMARY:${branch}호점 12-13 김철수\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:${compact}\nDTEND;VALUE=DATE:${next}\nSUMMARY:${branch}호점 18:30-19:30 홍길동\nEND:VEVENT`).join('\n')+'\nEND:VCALENDAR';
  const payload={starts_at:date+'T18:00:00+09:00',ends_at:date+'T20:00:00+09:00',use_coupon:false,note:'비공개 요청사항'};
  let cancelled;
  for(const space of ['on','p','d']){
   const booking=await ok('member_request',{...payload,id:crypto.randomUUID(),space,guests:space==='p'?8:6},member);
   if(space==='on')cancelled=await ok('member_request',{...payload,id:crypto.randomUUID(),space,guests:6,starts_at:date+'T21:00:00+09:00',ends_at:date+'T22:00:00+09:00'},member);
   await ok('member_block_save',{id:crypto.randomUUID(),space,starts_at:date+'T09:00:00+09:00',ends_at:date+'T10:00:00+09:00',note:'비공개 점검사유'},admin);
   await ok('member_status',{id:booking.id,version:booking.version,status:'awaiting_payment',payment_note:'입금 안내'},admin);await ok('member_status',{id:booking.id,version:booking.version+1,status:'confirmed'},admin);assert.ok(booking.id);
  }
  await ok('member_cancel',{id:cancelled.id,version:cancelled.version},member);
  h.setCalendarFeed(scFeed);h.setGongFeed(gongFeed);
  for(const space of ['on','p','d']){
   const publicData=await ok('public_calendar',{...period,space});
   const memberData=await ok('member_calendar',{...period,space},member);
   assert.deepEqual(publicData.items,memberData.items);
   assert.equal(publicData.items.length,2);assert.ok(publicData.items.some(x=>x.starts_at===new Date(date+'T18:30:00+09:00').toISOString()&&x.ends_at===new Date(date+'T19:30:00+09:00').toISOString()));assert.ok(publicData.items.every(x=>['spacecloud','gongjipsa'].includes(x.source)));assert.ok((await ok('member_bookings',{...period,space},member)).items.some(x=>x.status==='confirmed'));
   assert.ok(publicData.items.every(x=>x.space===space));
   assert.ok(publicData.items.every(x=>Object.keys(x).every(k=>['starts_at','ends_at','space','source','masked_name'].includes(k))));
   assert.doesNotMatch(JSON.stringify(publicData),/비공개|길동|철수|member_id|username|total_amount|session|ical_uid/);
  }
  assert.equal((await h.call('member_people')).status,401);
  assert.equal((await h.call('public_calendar',{...period,space:'2'})).data.code,'INVALID_ENTRY');
  assert.equal((await h.call('public_calendar',{from:'2026-01-01',to:'2026-12-01',space:'on'})).data.code,'INVALID_PERIOD');
  await h.db.exec('set role anon');
  await assert.rejects(h.db.query('select public.ss_public_schedule($1)',[JSON.stringify({...period,space:'on'})]),/permission denied/);
  await h.db.exec('reset role');
  h.setCalendarFeed(scFeed.replaceAll('T120000','T140000').replaceAll('T130000','T150000'));const refreshed=await ok('public_calendar',{...period,space:'on'});assert.ok(refreshed.items.some(x=>x.starts_at===new Date(date+'T14:00:00+09:00').toISOString()));assert.ok(!refreshed.items.some(x=>x.starts_at===new Date(date+'T12:00:00+09:00').toISOString()));
  h.setCalendarFeed(null);
  const failing=await h.call('public_calendar',{...period,space:'on'});
  // Provider failure must not be hidden by previously fetched data.
  const handler=h.edge.makeHandler(k=>({SUPABASE_SERVICE_ROLE_KEY:'key',SUPABASE_ANON_KEY:'anon',SPACECLOUD_ICAL_UID:'feed'}[k]),async url=>new URL(url).hostname==='api.spacecloud.kr'?new Response('',{status:503}):Response.json({allowed:true,items:[]}));
  const response=await handler(new Request('https://slowsixon.com/api/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'public_calendar',...period,space:'on'})}));
  assert.equal(response.status,503);assert.equal((await response.json()).code,'EXTERNAL_CALENDAR_UNAVAILABLE');
  assert.equal(failing.status,503);assert.equal(failing.data.code,'EXTERNAL_CALENDAR_UNAVAILABLE');
 }finally{await h.db.close();}
});
