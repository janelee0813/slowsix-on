import https from 'node:https';
import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {HttpsProxyAgent} from 'https-proxy-agent';

const endpoint='https://message.ppurio.com';
export const testPayload=()=>({account:'slowsix',messageType:'ALT',senderProfile:'@slowsix',templateCode:'ppur_2026091713562747407967598',duplicateFlag:'N',targetCount:1,targets:[{to:'01051667412',name:'연동 테스트 (실제 예약 아님)',changeWord:{var1:'TEST-20261019-01',var2:'2026-10-20 14:00~15:00 (테스트)',var3:'6',var4:'10,560'}}],isResend:'N',refKey:'slowsix-admin-test-20261019-01'});
export const templateCodes={requested:'ppur_2026091713562747407967598',awaiting_payment:'ppur_2026091713565824417631569',confirmed:'ppur_2026091713573124417016883',rejected:'ppur_2026091713580424417116780',cancelled:'ppur_2026091713583347407004301'};
export function approvedPayload(p){
 if(!p||p.account!=='slowsix'||p.senderProfile!=='@slowsix'||p.messageType!=='ALT'||!Object.values(templateCodes).includes(p.templateCode)||p.isResend!=='N'||p.targetCount!==1||!Array.isArray(p.targets)||p.targets.length!==1||!/^[a-f0-9]{32}$/.test(p.refKey))throw Error('INVALID_PAYLOAD');
 const t=p.targets[0],w=t.changeWord;
 if(!/^010[0-9]{8}$/.test(t.to)||typeof t.name!=='string'||!t.name||t.name.length>100||!w||Object.keys(w).some(k=>!['var1','var2','var3','var4'].includes(k))||Object.values(w).some(v=>typeof v!=='string'||v.length>100)||!w.var1||!w.var2)throw Error('INVALID_PAYLOAD');
 if([templateCodes.requested,templateCodes.awaiting_payment,templateCodes.confirmed].includes(p.templateCode)&&(!/^[0-9]{1,2}$/.test(w.var3)||!/^[0-9,]+$/.test(w.var4)))throw Error('INVALID_PAYLOAD');
 return {account:'slowsix',senderProfile:'@slowsix',messageType:'ALT',templateCode:p.templateCode,duplicateFlag:'N',targetCount:1,targets:[{to:t.to,name:t.name,changeWord:{...w}}],isResend:'N',refKey:p.refKey};
}
export const sign=(secret,timestamp,body)=>createHmac('sha256',secret).update(`ppurio-relay\n${timestamp}\n${body}`).digest('hex');
export function verify(secret,timestamp,signature,body,now=Date.now()){
 if(typeof secret!=='string'||secret.length<32||typeof timestamp!=='string'||typeof signature!=='string'||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!/^[a-f0-9]{64}$/.test(signature))return false;
 return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(secret,timestamp,body),'hex'));
}
export function proxyRequest(proxy,authorization,path='/v1/token',payload){
 if(!['/v1/token','/v1/kakao'].includes(path))throw Error('INVALID_ENDPOINT');
 const url=new URL(proxy);
 if(!['http:','https:'].includes(url.protocol)||!url.hostname.endsWith('.usefixie.com')||!url.username||!url.password)throw Error('FIXIE_CONFIGURATION');
 const agent=new HttpsProxyAgent(url,{timeout:12000});
 return new Promise((resolve,reject)=>{
  const req=https.request(endpoint+path,{method:'POST',agent,headers:{Authorization:authorization,...(payload?{'Content-Type':'application/json'}:{})}},res=>{
   let text='';
   res.setEncoding('utf8');
   res.on('data',chunk=>{text+=chunk;if(text.length>32768)req.destroy(Error('RESPONSE_TOO_LARGE'));});
   res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(text)});}catch{reject(Error('INVALID_RESPONSE'));}});
   res.on('error',reject);
  });
  // Includes connection, TLS, and response; no retries or redirect following.
  const timer=setTimeout(()=>req.destroy(Error('TIMEOUT')),15000);
  req.on('error',reject);
  req.on('close',()=>{clearTimeout(timer);agent.destroy();});
  req.end(payload?JSON.stringify(payload):undefined);
 });
}
export function makeHandler({env=process.env,request=proxyRequest,now=Date.now,report=event=>console.error(JSON.stringify(event))}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{return res.status(400).json({error:'INVALID_REQUEST'});}
  const raw=JSON.stringify(body??{});
  if(raw.length>2048)return res.status(413).json({error:'INVALID_REQUEST'});
  const secret=env.PPURIO_RELAY_SECRET?.trim();
  if(!verify(secret,req.headers['x-ss-timestamp'],req.headers['x-ss-signature'],raw,now())){
   // Diagnostic metadata only: never log the key, signature, request body or token.
   let keyKind=!secret?'missing':secret.startsWith('sb_secret_')?'secret':'other',projectMatches=false,serviceRole=false;
   if(secret?.split('.').length===3){keyKind='jwt';try{const claims=JSON.parse(Buffer.from(secret.split('.')[1],'base64url').toString());projectMatches=claims.ref==='qhvwwdrwfzwpehfjntbv';serviceRole=claims.role==='service_role';}catch{}}
   report({event:'ppurio_relay_auth_rejected',keyTag:secret?createHash('sha256').update(secret).digest('hex').slice(0,16):null,bodyTag:createHash('sha256').update(raw).digest('hex').slice(0,16),keyKind,projectMatches,serviceRole,timestampValid:typeof req.headers['x-ss-timestamp']==='string'&&Math.abs(now()-Number(req.headers['x-ss-timestamp']))<=60000,signaturePresent:typeof req.headers['x-ss-signature']==='string'});
   return res.status(403).json({error:'FORBIDDEN'});
  }
  const sending=['kakao_test','kakao'].includes(body?.action);
  if(!['token','kakao_test','kakao'].includes(body?.action)||typeof body.authorization!=='string'||!(sending?/^Bearer [A-Za-z0-9._~+\/-]+=*$/:/^Basic [A-Za-z0-9+/=]+$/).test(body.authorization))return res.status(400).json({error:'INVALID_REQUEST'});
  let payload;try{payload=body.action==='kakao'?approvedPayload(body.payload):sending?testPayload():undefined;}catch{return res.status(400).json({error:'INVALID_PAYLOAD'});}
  if(!env.FIXIE_URL)return res.status(503).json({error:'FIXIE_CONFIGURATION'});
  try{
   const {status,data}=await request(env.FIXIE_URL,body.authorization,sending?'/v1/kakao':'/v1/token',payload);
   // Only the authenticated Supabase diagnostic receives the token. Never log it.
   const code=typeof data.code==='string'||typeof data.code==='number'?data.code:null;
   if(sending)return res.status(200).json({status,data:{code,messageKey:typeof (data.messageKey??data.messsageKey)==='string'?(data.messageKey??data.messsageKey):undefined}});
   return res.status(200).json({status,data:{code,token:status===200&&typeof data.token==='string'?data.token:undefined}});
  }catch{return res.status(502).json({error:'PROXY_CONNECTION_FAILED'});}
 };
}
export default makeHandler();
