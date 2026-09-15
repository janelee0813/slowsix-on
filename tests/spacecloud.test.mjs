import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {HostCalendar,calendarURL,segments,classifyRows,reconcile} from '../server/spacecloud.mjs';
import {authorized,makeSyncHandler} from '../api/spacecloud-sync.mjs';

const sample={id:'12345678-1234-4123-8123-123456789abc',desired:'blocked',starts_at:'2026-12-31T14:00:00Z',ends_at:'2026-12-31T17:00:00Z'};
test('host profile redirect is accepted after login and for an existing host session',async()=>{
 for(const signedIn of [false,true]){
  let url='',fills=0;const visits=[],profile='https://partner.spacecloud.kr/auth/mypage';
  const page={goto:async target=>{visits.push(target);url=signedIn&&target.endsWith('/auth/login')?profile:target;},url:()=>url,
   waitForFunction:async()=>{},locator:()=>({waitFor:async()=>{},count:async()=>1,fill:async()=>{fills++;}}),
   getByText:()=>({click:async()=>{url=profile;}}),
   waitForURL:async predicate=>{assert.equal(predicate(new URL(url)),true);assert.equal(predicate(new URL('https://partner.spacecloud.kr/auth/login')),false);}
  };
  const host=new HostCalendar(page,{email:'local-fixture',password:'local-fixture'});await host.connect();
  assert.equal(host.loggedIn,true);assert.equal(visits.at(-1),calendarURL);assert.equal(fills,signedIn?0:2);
 }
});
test('overnight synchronization is idempotent and releases only its exact markers',async()=>{
 const parts=segments(sample);assert.deepEqual(parts.map(p=>[p.date,p.start,p.end]),[['2026-12-31',23,24],['2027-01-01',0,2]]);
 let store=[],adds=0,removes=0;
 const adapter={rows:async date=>store.filter(r=>r.date===date),add:async p=>{adds++;store.push({...p,name:p.marker,external:true});},remove:async p=>{removes++;store=store.filter(r=>r.name!==p.marker);}};
 await reconcile(adapter,sample);await reconcile(adapter,sample);assert.equal(adds,2);
 store.push({date:'2027-01-01',name:'ordinary external reservation',start:4,end:5,external:true});
 await reconcile(adapter,{...sample,desired:'released'});await reconcile(adapter,{...sample,desired:'released'});assert.equal(removes,2);assert.equal(store.length,1);
 assert.throws(()=>classifyRows([{...parts[0],name:parts[0].marker,external:true,end:22}],parts[0]),/UNVERIFIED/);
});
test('conflicts on the second day cause no writes, partial writes reconcile without duplicates',async()=>{
 const parts=segments(sample);let store=[{date:parts[1].date,name:'other',start:1,end:3,external:true}],adds=0;
 const adapter={rows:async d=>store.filter(r=>r.date===d),add:async p=>{adds++;store.push({...p,name:p.marker,external:true});},remove:async()=>{}};
 await assert.rejects(reconcile(adapter,sample),/TIME_CONFLICT/);assert.equal(adds,0);
 store=[{...parts[0],name:parts[0].marker,external:true}];await reconcile(adapter,sample);assert.equal(adds,1);
 store.push({...store[0]});await assert.rejects(reconcile(adapter,sample),/UNVERIFIED/);
});
test('server rejects unauthorized requests before launching browser or touching database',async()=>{
 const secret='a'.repeat(64);assert.ok(authorized('Bearer '+secret,secret));assert.equal(authorized('Bearer x',secret),false);assert.equal(authorized('Bearer ',''),false);
 let touched=false,status;
 const response={setHeader(){},status(v){status=v;return this;},json(v){return v;}};
 const handler=makeSyncHandler({env:{SPACECLOUD_SYNC_SECRET:secret},fetcher:async()=>{touched=true;},launch:async()=>{touched=true;}});
 await handler({method:'POST',headers:{}},response);assert.equal(status,401);assert.equal(touched,false);
 await handler({method:'POST',headers:{authorization:'Bearer '+secret}},response);assert.equal(status,503);assert.equal(touched,false);
});
test('worker reports only safe failure stage metadata, never provider errors or credentials',async()=>{
 const reports=[],calls=[],secret='a'.repeat(64);
 const handler=makeSyncHandler({env:{SPACECLOUD_SYNC_SECRET:secret,SUPABASE_SERVICE_ROLE_KEY:'private-service-key',SPACECLOUD_EMAIL:'private-email',SPACECLOUD_PASSWORD:'private-password'},
  report:event=>reports.push(event),
  fetcher:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return new Response(JSON.stringify(body.p_action==='claim'?{...sample,lease:'test-lease',revision:1}:{}));},
  launch:async()=>{throw new Error('private-password private-email secret provider page');}
 });
 const res={setHeader(){},status(){return this;},json(value){return value;}};
 await handler({method:'POST',headers:{authorization:'Bearer '+secret}},res);
 assert.equal(reports[0].stage,'browser_launch');assert.equal(reports[0].kind,'runtime');
 assert.equal(calls.at(-1).p.error,'UI_CHANGED');assert.equal(calls.at(-1).p.logged_in,false);
 assert.equal(/private-|secret provider/.test(JSON.stringify(reports)),false);
});
test('durable queue permissions, single worker, cancellation during a write, interrupted recovery',async()=>{
 const h=await harness(),ok=async(a,p={},s)=>{const r=await h.call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const worker=async(a,p={})=>(await h.db.query('select public.ss_spacecloud_worker($1,$2::jsonb) as r',[a,JSON.stringify(p)])).rows[0].r;
 try{
  const password='LocalTest!2026';await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',password,name:'관리자'});
  const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const invite=await ok('member_invite',{tier:'friends'},admin);await ok('register',{linkToken:invite.url.split('=')[1],username:'testmember',password,name:'테스트',gender:'여성',age_group:'30대',purposes:['보드게임']});
  const person=(await ok('member_people',{},admin)).items[0];await ok('member_person_save',{id:person.id,version:person.version,tier:'friends',status:'active'},admin);
  const member=(await ok('login',{username:'testmember',password})).sessionToken;
  assert.equal((await h.call('member_sc_state',{},member)).status,403);
  assert.equal((await h.call('member_sc_enable',{enabled:true},admin)).data.code,'SC_NOT_CONNECTED');
  const day=new Date(Date.now()+10*86400000).toISOString().slice(0,10),id=crypto.randomUUID(),request={id,starts_at:day+'T01:00:00Z',ends_at:day+'T04:00:00Z',guests:6,use_coupon:false,note:''};
  const b=await ok('member_request',request,member);
  assert.deepEqual(await worker('claim'),{}); // default off, heartbeat only
  await ok('member_sc_enable',{enabled:true},admin);
  const job=await worker('claim');assert.equal(job.id,id);assert.deepEqual(await worker('claim'),{});
  await ok('member_cancel',{id,version:b.version},member);
  await worker('finish',{...job,logged_in:true});
  let state=(await ok('member_sc_state',{},admin)).items[0];assert.equal(state.state,'pending');assert.equal(state.desired,'released');
  const release=await worker('claim');assert.equal(release.desired,'released');
  await assert.rejects(worker('finish',{...release,lease:crypto.randomUUID(),logged_in:true}),/CONFLICT/);
  await worker('finish',{...release,logged_in:true});assert.equal((await ok('member_sc_state',{},admin)).items[0].state,'released');
  const id2=crypto.randomUUID();await ok('member_request',{...request,id:id2},member);
  const job2=await worker('claim');assert.equal(job2.id,id2);
  await h.db.query("update ss_admin.sc_jobs set lease_until=now()-interval '1 minute' where booking_id=$1",[id2]);
  assert.deepEqual(await worker('claim'),{});assert.equal((await ok('member_sc_state',{},admin)).items.find(j=>j.booking_id===id2).state,'review');
  await assert.rejects(worker('finish',{...job2,logged_in:true}),/CONFLICT/);
  await ok('member_sc_retry',{id:id2},admin);const retry=await worker('claim');
  await worker('finish',{...retry,error:'LOGIN_REQUIRED',logged_in:false});
  assert.equal((await ok('member_sc_state',{},admin)).settings.enabled,false);
  assert.deepEqual(await worker('claim'),{});
  // Existing request retry is valid even after its time appears in the external feed.
  h.setCalendarFeed('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:'+day.replaceAll('-','')+'T010000Z\r\nDTEND:'+day.replaceAll('-','')+'T040000Z\r\nSUMMARY:SSO-test\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal((await ok('member_request',{...request,id:id2},member)).id,id2);
  const grants=await h.db.query("select has_function_privilege('anon','public.ss_spacecloud_worker(text,jsonb)','execute') as allowed");assert.equal(grants.rows[0].allowed,false);
 }finally{await h.db.close();}
});
