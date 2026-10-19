import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import {verify} from '../api/ppurio-relay.mjs';
const {code}=await transform(await readFile(new URL('../supabase/functions/ppurio-test/index.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {makeHandler}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const settings={SUPABASE_SERVICE_ROLE_KEY:'private-service',PPURIO_ACCOUNT:'slowsix',PPURIO_ACCESS_KEY:'private-access',PPURIO_RELAY_SECRET:'relay-only-secret-long-enough-for-signing-123456'};
test('anonymous and member requests cannot use messaging credentials',async()=>{
 const handler=makeHandler(k=>settings[k],()=>{throw Error('must not call provider');});
 for(const key of ['', 'public-anon', 'member-token']) assert.equal((await handler(new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${key}`}}))).status,403);
});
test('diagnostic only requests token and never exposes provider secrets',async()=>{
 let calls=0;
 const handler=makeHandler(k=>settings[k],async(url,options)=>{
  calls++;assert.equal(url,'https://message.ppurio.com/v1/token');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Basic '+btoa('slowsix:private-access'));
  return Response.json({token:'private-token',code:1000,description:'private-access'});
 });
 const result=await handler(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer private-service'}}));
 const body=await result.text();assert.equal(calls,1);assert.ok(!body.includes('private'));assert.equal(JSON.parse(body).authenticated,true);assert.equal(JSON.parse(body).messageSent,false);
});
test('IP rejection is reported without leaking the raw response',async()=>{
 const handler=makeHandler(k=>settings[k],async()=>Response.json({code:3003,description:'private'},{status:400}));
 const result=await handler(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer private-service'}}));
 assert.deepEqual(await result.json(),{stage:'token',authenticated:false,providerHttpStatus:400,providerCode:3003,messageSent:false});
});
test('dashboard secret key works while public apikey cannot authenticate',async()=>{
 let calls=0;
 const keys={...settings,SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_test_server_only_123'})};
 const handler=makeHandler(k=>keys[k],async()=>{calls++;return Response.json({token:'private-token'});});
 for(const [apikey,status] of [['sb_publishable_public',403],['sb_secret_test_server_only_123',200]]) {
  const response=await handler(new Request('https://test',{method:'POST',headers:{apikey,Authorization:'Bearer public-anon'}}));
  assert.equal(response.status,status);
 }
 assert.equal(calls,1);
});
test('Fixie route signs the relay request and never exposes the returned token',async()=>{
 const service='private-service-long-enough-for-signing-123456';
 const handler=makeHandler(k=>({...settings,SUPABASE_SERVICE_ROLE_KEY:service})[k],async(url,options)=>{
  assert.equal(url,'https://slowsixon.com/api/ppurio-relay');
  assert.equal(verify(settings.PPURIO_RELAY_SECRET,options.headers['x-ss-timestamp'],options.headers['x-ss-signature'],options.body),true);
  assert.equal(JSON.parse(options.body).action,'token');
  return Response.json({status:200,data:{token:'private-token',code:1000}});
 });
 const result=await handler(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer '+service},body:JSON.stringify({route:'fixie'})}));
 assert.deepEqual(await result.json(),{stage:'token',route:'fixie',authenticated:true,providerHttpStatus:200,providerCode:1000,messageSent:false});
});

test('Fixie requires dedicated shared secret and never falls back to database credentials',async()=>{
 let calls=0;
 const handler=makeHandler(k=>({...settings,PPURIO_RELAY_SECRET:undefined})[k],async()=>{calls++;throw Error('must not call');});
 const response=await handler(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer private-service'},body:JSON.stringify({route:'fixie'})}));
 assert.equal(response.status,503);assert.equal(calls,0);assert.deepEqual(await response.json(),{error:'RELAY_SECRET_REQUIRED',messageSent:false});
});
const testId='slowsix-admin-test-20261019-01';
const testRequest=()=>new Request('https://test',{method:'POST',headers:{Authorization:'Bearer private-service'},body:JSON.stringify({route:'fixie',action:'send_test',testId})});
test('explicit test is persistently claimed before sending, and cannot be sent a second time',async()=>{
 let claimed=false,sends=0,patch;
 const handler=makeHandler(k=>settings[k],async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url==='https://slowsixon.com/api/ppurio-relay'){
   if(body.action==='token')return Response.json({status:200,data:{token:'private-token'}});
   assert.equal(claimed,true);assert.equal(body.action,'kakao_test');sends++;return Response.json({status:200,data:{code:1000,messageKey:'accepted-key'}});
  }
  assert.match(url,/\/rest\/v1\/ss_ppurio_test_runs/);
  if(options.method==='POST'){
   if(claimed)return Response.json({}, {status:409});
   claimed=true;assert.deepEqual(body,{id:testId,state:'attempted'});return Response.json([body],{status:201});
  }
  assert.equal(options.method,'PATCH');patch=body;return new Response(null,{status:204});
 });
 const first=await handler(testRequest());assert.equal(first.status,200);assert.equal((await first.json()).messageSubmitted,true);assert.equal(patch.state,'accepted');
 const second=await handler(testRequest());assert.equal(second.status,409);assert.equal(sends,1);
});
test('ambiguous send timeout remains recorded and is not automatically retried',async()=>{
 let claimed=false,sends=0,patch;
 const handler=makeHandler(k=>settings[k],async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url==='https://slowsixon.com/api/ppurio-relay'){
   if(body.action==='token')return Response.json({status:200,data:{token:'private-token'}});
   sends++;throw Error('private-provider-error');
  }
  if(options.method==='POST'){if(claimed)return Response.json({},{status:409});claimed=true;return Response.json([body],{status:201});}
  patch=body;return new Response(null,{status:204});
 });
 const first=await handler(testRequest());assert.equal(first.status,502);assert.equal((await first.json()).state,'unknown');assert.equal(patch.state,'unknown');
 assert.equal((await handler(testRequest())).status,409);assert.equal(sends,1);
});
test('missing test storage blocks dispatch and ordinary diagnostic never creates test records',async()=>{
 let sends=0;
 const handler=makeHandler(k=>settings[k],async(url,options)=>{
  if(url==='https://slowsixon.com/api/ppurio-relay'){assert.equal(JSON.parse(options.body).action,'token');return Response.json({status:200,data:{token:'private-token'}});}
  if(options.method==='POST')return Response.json({}, {status:404});sends++;throw Error('must not send');
 });
 const res=await handler(testRequest());assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'TEST_LOG_REQUIRED',messageSent:false});assert.equal(sends,0);
});
test('test log migration enforces unique claims and denies public/member writes',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  const sql=await readFile(new URL('../supabase/migrations/202610190001_ppurio_test.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);
   await assert.rejects(()=>db.query("insert into public.ss_ppurio_test_runs(id,state) values ('forbidden','attempted')"));
   await assert.rejects(()=>db.query('select * from public.ss_ppurio_test_runs'));
   await db.exec('reset role');
  }
  await db.exec('set role service_role');await db.query("insert into public.ss_ppurio_test_runs(id,state) values ('unique','attempted')");
  await assert.rejects(()=>db.query("insert into public.ss_ppurio_test_runs(id,state) values ('unique','attempted')"));
 }finally{await db.close();}
});
