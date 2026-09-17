import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
const event=(branch,time,date='20271001',end='20271002',extra='')=>`BEGIN:VEVENT\nDTSTART;VALUE=DATE:${date}\nDTEND;VALUE=DATE:${end}\nSUMMARY:${branch}호점 ${time} 홍길동\n${extra}\nEND:VEVENT`;
const feed=(...events)=>'BEGIN:VCALENDAR\n'+events.join('\n')+'\nEND:VCALENDAR';
test('Gongjipsa title times, midnight, masking, filtering and fail-closed parsing',async()=>{
 const h=await harness();try{
 const parse=h.edge.parseGongjipsaFeed;
 const raw=feed(event(1,'19-23'),event(2,'00-24'),event(3,'20-07','20271001','20271003'),event(3,'10:30-13:30'));
 const d=parse(raw,'d'),p=parse(raw,'p');assert.equal(d.length,1);assert.equal(p.length,2);
 assert.equal(d[0].starts_at,'2027-10-01T10:00:00.000Z');assert.equal(d[0].ends_at,'2027-10-01T14:00:00.000Z');
 assert.equal(p[0].ends_at,'2027-10-01T22:00:00.000Z');assert.equal(p[1].starts_at,'2027-10-01T01:30:00.000Z');
 assert.equal(d[0].masked_name,'홍**');assert.ok(!JSON.stringify([...d,...p]).includes('길동'));
 assert.equal(parse(feed(event(1,'23-01')),'d')[0].ends_at,'2027-10-01T16:00:00.000Z');
 assert.equal(parse(feed(event(3,'00-24')),'p')[0].ends_at,'2027-10-01T15:00:00.000Z');
 assert.equal(parse(feed(event(1,'19-23'),event(1,'19-23')),'d').length,1);
 assert.equal(parse(feed(event(1,'19-23','20271001','20271002','STATUS:CANCELLED')),'d').length,0);
 assert.equal(parse(feed(event(2,'invalid')),'p').length,0);
 assert.throws(()=>parse(feed(event(1,'bad')),'d'));
 assert.throws(()=>parse(feed(event(3,'25-26')),'p'));
 assert.throws(()=>parse(feed(event(3,'19-23','20271001','20271002','RRULE:FREQ=DAILY')),'p'));
 }finally{await h.db.close();}
});
test('booking availability, blocks, coupons and SpaceCloud outbox are scoped correctly',async()=>{
 const h=await harness(),ok=async(a,p={},s)=>{const r=await h.call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 try{
 const password='SpaceBooking!2026';await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',password,name:'관리자'});const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
 const link=await ok('member_invite',{tier:'friends'},admin);await ok('register',{linkToken:link.url.split('=')[1],username:'spacefriend',password,name:'친구',gender:'여성',age_group:'30대',purposes:['보드게임']});const member=(await ok('member_people',{},admin)).items[0];await ok('member_person_save',{id:member.id,version:member.version,tier:'friends',status:'active'},admin);const token=(await ok('login',{username:'spacefriend',password})).sessionToken;
 const date=new Date(Date.now()+10*86400000).toISOString().slice(0,10),starts_at=date+'T18:00:00+09:00',ends_at=date+'T20:00:00+09:00';
 const payload={id:crypto.randomUUID(),starts_at,ends_at,guests:6,use_coupon:false,note:''};const period={from:date+'T00:00:00+09:00',to:date+'T23:59:00+09:00'};
 const on=await ok('member_request',payload,token);assert.equal(on.space,'on');
 const p=await ok('member_request',{...payload,id:crypto.randomUUID(),space:'p',guests:8,use_coupon:true},token);assert.equal(p.space,'p');for(const [space,guests] of [['p',10],['d',13]])assert.equal((await h.call('member_quote',{...payload,space,guests},token)).data.code,'INVALID_BOOKING');assert.equal((await h.call('member_quote',{...payload,space:'p',guests:7},token)).data.code,'INVALID_BOOKING');
 const d=await ok('member_request',{...payload,id:crypto.randomUUID(),space:'d'},token);assert.equal(d.space,'d');
 assert.equal((await h.call('member_request',{...payload,id:crypto.randomUUID(),space:'p',guests:8},token)).data.code,'TIME_UNAVAILABLE');
 assert.equal((await h.call('member_request',{...payload,space:'d'},token)).data.code,'CONFLICT');
 for(const space of ['on','p','d']){const cal=await ok('member_calendar',{...period,space},token);assert.equal(cal.items.length,1);assert.equal(cal.items[0].space,space);const b=await ok('member_bookings',{...period,space},token);assert.equal(b.items.length,1);assert.equal(b.items[0].space,space);}
 const jobs=(await h.db.query('select booking_id from ss_admin.sc_jobs')).rows;assert.deepEqual(jobs.map(x=>x.booking_id),[on.id]);
 assert.equal((await h.call('member_sc_retry',{id:p.id},admin)).data.code,'INVALID_ENTRY');
 assert.equal((await h.call('member_calendar',{...period,space:'2'},token)).data.code,'INVALID_ENTRY');
 const next={...payload,starts_at:date+'T21:00:00+09:00',ends_at:date+'T23:00:00+09:00'};
 assert.equal((await h.call('member_request',{...next,id:crypto.randomUUID(),space:'d',use_coupon:true},token)).data.code,'COUPON_UNAVAILABLE');
 await ok('member_block_save',{id:crypto.randomUUID(),space:'d',starts_at:next.starts_at,ends_at:next.ends_at,note:'점검'},admin);
 assert.equal((await h.call('member_request',{...next,id:crypto.randomUUID(),space:'d'},token)).data.code,'TIME_UNAVAILABLE');
 await ok('member_request',{...next,id:crypto.randomUUID(),space:'p',guests:8},token);
 const late={...payload,starts_at:date+'T12:00:00+09:00',ends_at:date+'T14:00:00+09:00'};
 h.setGongFeed(feed(event(1,'12-14',date.replaceAll('-',''),new Date(Date.parse(date)+86400000).toISOString().slice(0,10).replaceAll('-',''))));
 assert.equal((await h.call('member_request',{...late,id:crypto.randomUUID(),space:'d'},token)).data.code,'TIME_UNAVAILABLE');
 await ok('member_request',{...late,id:crypto.randomUUID(),space:'p',guests:8},token);
 h.setGongFeed(null);
 assert.equal((await h.call('member_request',{...late,id:crypto.randomUUID(),space:'d'},token)).data.code,'EXTERNAL_CALENDAR_UNAVAILABLE');
 await ok('member_request',{...late,id:crypto.randomUUID(),space:'on'},token);
 }finally{await h.db.close();}
});
