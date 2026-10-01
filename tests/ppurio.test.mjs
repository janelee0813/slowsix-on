import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const {code}=await transform(await readFile(new URL('../supabase/functions/ppurio-test/index.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {makeHandler}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const settings={SUPABASE_SERVICE_ROLE_KEY:'private-service',PPURIO_ACCOUNT:'slowsix',PPURIO_ACCESS_KEY:'private-access'};
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
