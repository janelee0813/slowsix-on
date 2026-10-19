import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler,sign,verify} from '../api/ppurio-relay.mjs';
const secret='server-secret-for-unit-tests-1234567890';
const now=1780000000000,timestamp=String(now);
function response(){return {headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};}
test('relay rejects absent, altered, stale and future signatures',()=>{
 const raw=JSON.stringify({action:'token',authorization:'Basic abc='});
 const signature=sign(secret,timestamp,raw);
 assert.equal(verify(secret,timestamp,signature,raw,now),true);
 for(const args of [[secret,timestamp,'',raw,now],[secret,timestamp,signature,raw+'x',now],[secret,timestamp,signature,raw,now+61000],[secret,timestamp,signature,raw,now-61000]])assert.equal(verify(...args),false);
});
test('only signed token requests use proxy and do not return raw provider errors',async()=>{
 let calls=0;
 const handler=makeHandler({env:{PPURIO_RELAY_SECRET:secret,FIXIE_URL:'http://test:test@example.usefixie.com:80'},now:()=>now,request:async()=>{calls++;return {status:400,data:{code:'3003',description:'private credentials'}};}});
 const body={action:'token',authorization:'Basic abc='};
 const headers={'x-ss-timestamp':timestamp,'x-ss-signature':sign(secret,timestamp,JSON.stringify(body))};
 const res=response();await handler({method:'POST',body,headers},res);
 assert.equal(calls,1);assert.deepEqual(res.body,{status:400,data:{code:'3003',token:undefined}});
 const unauth=response();await handler({method:'POST',body,headers:{}},unauth);assert.equal(unauth.code,403);assert.equal(calls,1);
 const unsupported={action:'send',authorization:'Basic abc=',url:'https://evil.test'};
 const invalid=response();await handler({method:'POST',body:unsupported,headers:{...headers,'x-ss-signature':sign(secret,timestamp,JSON.stringify(unsupported))}},invalid);assert.equal(invalid.code,400);assert.equal(calls,1);
});
test('relay trims copied whitespace and logs only safe authentication metadata',async()=>{
 const events=[];
 const body={action:'token',authorization:'Basic cHJpdmF0ZQ=='};
 const handler=makeHandler({env:{PPURIO_RELAY_SECRET:'\n'+secret+'\n',FIXIE_URL:'http://test:test@example.usefixie.com:80'},now:()=>now,report:e=>events.push(e),request:async()=>({status:200,data:{token:'private-token'}})});
 const good=response();await handler({method:'POST',body,headers:{'x-ss-timestamp':timestamp,'x-ss-signature':sign(secret,timestamp,JSON.stringify(body))}},good);
 assert.equal(good.code,200);assert.equal(events.length,0);
 const bad=response();await handler({method:'POST',body,headers:{'x-ss-timestamp':timestamp,'x-ss-signature':'0'.repeat(64)}},bad);
 assert.equal(bad.code,403);assert.equal(events[0].keyTag.length,16);assert.equal(events[0].bodyTag.length,16);const {keyTag,bodyTag,...metadata}=events[0];assert.deepEqual([metadata],[{event:'ppurio_relay_auth_rejected',keyKind:'other',projectMatches:false,serviceRole:false,timestampValid:true,signaturePresent:true}]);
 for(const value of [secret,body.authorization,'private-token','0'.repeat(64)])assert.ok(!JSON.stringify(events).includes(value));
});
