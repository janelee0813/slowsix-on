import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {readFile} from 'node:fs/promises';import {transform} from 'esbuild';import {harness} from './harness.mjs';import {makeWorker} from '../api/ppurio-worker.mjs';import {approvedPayload} from '../api/ppurio-relay.mjs';
const {code}=await transform(await readFile(new URL('../supabase/functions/ppurio-test/index.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {makeHandler,workerAuthorized,bookingMessage}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const secret='dedicated-relay-secret-32-characters-for-tests',timestamp=String(Date.now()),body=JSON.stringify({action:'dispatch',route:'fixie'});
const sign=(purpose='ppurio-worker')=>createHmac('sha256',secret).update(`${purpose}\n${timestamp}\n${body}`).digest('hex');
const workerRequest=()=>new Request('https://test',{method:'POST',body,headers:{'x-ss-timestamp':timestamp,'x-ss-signature':sign()}});
const job={id:crypto.randomUUID(),lease:crypto.randomUUID(),booking_id:crypto.randomUUID(),kind:'confirmed',phone:'01000000000',snapshot:{nickname:'테스트',space:'p',starts_at:'2026-10-20T05:00:00Z',ends_at:'2026-10-20T07:00:00Z',guests:8,total_amount:28160}};
test('worker signature is scoped and anonymous/admin-body dispatch cannot bypass it',async()=>{
 assert.equal(await workerAuthorized(workerRequest(),body,secret),true);
 const cross=new Request('https://test',{headers:{'x-ss-timestamp':timestamp,'x-ss-signature':sign('ppurio-relay')}});
 assert.equal(await workerAuthorized(cross,body,secret),false);
 const h=makeHandler(k=>({SUPABASE_SERVICE_ROLE_KEY:'private-service',PPURIO_RELAY_SECRET:secret})[k],()=>{throw Error('no network');});
 assert.equal((await h(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer private-service'},body}))).status,403);
});
test('all five booking templates preserve snapshot values and disallow arbitrary recipients or templates',()=>{
 for(const kind of ['requested','awaiting_payment','confirmed','rejected','cancelled']){
  const p=bookingMessage({...job,kind});assert.equal(approvedPayload(p).targets[0].to,job.phone);assert.match(p.targets[0].changeWord.var2,/슬로우식스P 2026-10-20 14:00/);
  if(['rejected','cancelled'].includes(kind))assert.deepEqual(Object.keys(p.targets[0].changeWord),['var1','var2']);else assert.equal(p.targets[0].changeWord.var4,'28,160');
  for(const patch of [{templateCode:'other'},{isResend:'Y'},{targets:[{...p.targets[0],to:'not-a-phone'}]}])assert.throws(()=>approvedPayload({...p,...patch}));
 }
});
test('worker claims before send, records dispatch before provider and preserves unknown timeouts',async()=>{
 for(const uncertain of [false,true]){
  const steps=[];let final;
  const h=makeHandler(k=>({SUPABASE_SERVICE_ROLE_KEY:'private-service',PPURIO_RELAY_SECRET:secret,PPURIO_ACCOUNT:'slowsix',PPURIO_ACCESS_KEY:'private-api-key'})[k],async(url,o)=>{
   const p=JSON.parse(o.body);
   if(url.endsWith('/rpc/ss_ppurio_worker')){steps.push(p.p_action);if(p.p_action==='claim')return Response.json(job);if(p.p_action==='finish')final=p.p;return Response.json({});}
   if(p.action==='token'){steps.push('token');return Response.json({status:200,data:{token:'private-token'}});}
   assert.equal(p.action,'kakao');steps.push('provider');assert.equal(steps.at(-2),'dispatch');if(uncertain)throw Error('timeout');return Response.json({status:200,data:{code:1000,messageKey:'accepted'}});
  });
  const r=await h(workerRequest());assert.equal(r.status,200);assert.equal((await r.json()).state,uncertain?'unknown':'sent');assert.equal(final.state,uncertain?'unknown':'sent');assert.deepEqual(steps,['claim','token','dispatch','provider','finish']);
 }
});
test('scheduler bridge rejects untrusted requests and signs only a fixed worker action',async()=>{
 const sync='a'.repeat(64);let calls=0;const out=()=>({setHeader(){},status(n){this.code=n;return this;},json(v){this.data=v;return this;}});
 const h=makeWorker({env:{SPACECLOUD_SYNC_SECRET:sync,PPURIO_RELAY_SECRET:secret},fetcher:async(url,o)=>{calls++;assert.equal(url,'https://qhvwwdrwfzwpehfjntbv.supabase.co/functions/v1/ppurio-test');assert.equal(await workerAuthorized(new Request(url,o),o.body,secret),true);assert.deepEqual(JSON.parse(o.body),{action:'dispatch',route:'fixie'});return Response.json({state:'idle'});}});
 const denied=out();await h({method:'POST',headers:{}},denied);assert.equal(denied.code,403);assert.equal(calls,0);
 const good=out();await h({method:'POST',headers:{authorization:'Bearer '+sync},body:{phone:'evil'}},good);assert.equal(good.code,200);assert.equal(calls,1);
});
test('booking outbox is atomic, private, immutable and never retries an uncertain dispatch',async()=>{
 const h=await harness(),{db,call}=h;const ok=async(a,p={},s)=>{const r=await call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 try{
  const password='TestMembers!27';await ok('register',{username:'slowsix',password,name:'관리자',linkToken:await h.bootstrap()});const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
  const linkToken=(await ok('member_invite',{tier:'friends'},admin)).url.split('=')[1];const reg={username:'notifyuser',password,name:'알림테스트',gender:'여성',age_group:'30대',purposes:['보드게임'],phone:'01000000000',linkToken};
  assert.equal((await call('register',{...reg,phone:''})).data.code,'PHONE_REQUIRED');await ok('register',reg);const member=(await ok('member_people',{},admin)).items[0];await ok('member_person_save',{id:member.id,version:member.version,tier:'friends',status:'active'},admin);const session=(await ok('login',{username:reg.username,password})).sessionToken;
  const home=await ok('member_home',{},session);assert.equal(home.phone,reg.phone);await db.query("update ss_admin.members set phone='' where person_id=$1",[member.id]);
  const starts_at=new Date(Date.now()+86400000*10);starts_at.setUTCMinutes(0,0,0);const p={id:crypto.randomUUID(),starts_at:starts_at.toISOString(),ends_at:new Date(+starts_at+7200000).toISOString(),guests:6,use_coupon:false,note:'',space:'on'};
  assert.equal((await call('member_request',p,session)).data.code,'PHONE_REQUIRED');await ok('member_phone_save',{phone:reg.phone,version:home.phone_version},session);
  const b=await ok('member_request',p,session);await ok('member_request',p,session);assert.equal((await db.query('select count(*)::int n from ss_admin.alimtalk_jobs')).rows[0].n,1);
  const rpc=async(a,p={})=>(await db.query('select public.ss_ppurio_worker($1,$2::jsonb) r',[a,JSON.stringify(p)])).rows[0].r;
  let j=await rpc('claim');assert.equal(j.phone,'01051667412');assert.equal(j.kind,'requested');assert.equal(j.snapshot.total_amount,b.total_amount);await rpc('dispatch',{id:j.id,lease:j.lease});await rpc('finish',{id:j.id,lease:j.lease,state:'sent',provider_code:'1000'});
  await ok('member_status',{id:b.id,version:1,status:'awaiting_payment',payment_note:'테스트 입금 안내'},admin);await ok('member_status',{id:b.id,version:2,status:'confirmed'},admin);
  assert.equal((await db.query("select state from ss_admin.alimtalk_jobs where kind='awaiting_payment'")).rows[0].state,'skipped');j=await rpc('claim');assert.equal(j.kind,'confirmed');assert.equal(j.phone,reg.phone);
  await rpc('dispatch',{id:j.id,lease:j.lease});await assert.rejects(()=>rpc('finish',{id:j.id,lease:j.lease,state:'retry'}));await db.query("update ss_admin.alimtalk_jobs set lease_until=now()-interval '1 minute' where id=$1",[j.id]);assert.deepEqual(await rpc('claim'),{});
  assert.equal((await db.query('select state from ss_admin.alimtalk_jobs where id=$1',[j.id])).rows[0].state,'unknown');assert.equal((await call('member_alimtalk_retry',{id:j.id},admin)).data.code,'CONFLICT');assert.equal((await call('member_alimtalk',{},session)).data.code,'FORBIDDEN');
  await db.exec('set role anon');await assert.rejects(()=>db.query("select public.ss_ppurio_worker('claim','{}')"));await db.exec('reset role');
 }finally{await db.close();}
});
