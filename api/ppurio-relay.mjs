import https from 'node:https';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {HttpsProxyAgent} from 'https-proxy-agent';

const endpoint='https://message.ppurio.com/v1/token';
export const sign=(secret,timestamp,body)=>createHmac('sha256',secret).update(`ppurio-relay\n${timestamp}\n${body}`).digest('hex');
export function verify(secret,timestamp,signature,body,now=Date.now()){
 if(typeof secret!=='string'||secret.length<32||typeof timestamp!=='string'||typeof signature!=='string'||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!/^[a-f0-9]{64}$/.test(signature))return false;
 return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(secret,timestamp,body),'hex'));
}
export function proxyRequest(proxy,authorization){
 const url=new URL(proxy);
 if(!['http:','https:'].includes(url.protocol)||!url.hostname.endsWith('.usefixie.com')||!url.username||!url.password)throw Error('FIXIE_CONFIGURATION');
 const agent=new HttpsProxyAgent(url,{timeout:12000});
 return new Promise((resolve,reject)=>{
  const req=https.request(endpoint,{method:'POST',agent,headers:{Authorization:authorization}},res=>{
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
  req.end();
 });
}
export function makeHandler({env=process.env,request=proxyRequest,now=Date.now}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{return res.status(400).json({error:'INVALID_REQUEST'});}
  const raw=JSON.stringify(body??{});
  if(raw.length>2048)return res.status(413).json({error:'INVALID_REQUEST'});
  if(!verify(env.SUPABASE_SERVICE_ROLE_KEY,req.headers['x-ss-timestamp'],req.headers['x-ss-signature'],raw,now()))return res.status(403).json({error:'FORBIDDEN'});
  if(body?.action!=='token'||typeof body.authorization!=='string'||!/^Basic [A-Za-z0-9+/=]+$/.test(body.authorization))return res.status(400).json({error:'INVALID_REQUEST'});
  if(!env.FIXIE_URL)return res.status(503).json({error:'FIXIE_CONFIGURATION'});
  try{
   const {status,data}=await request(env.FIXIE_URL,body.authorization);
   // Only the authenticated Supabase diagnostic receives the token. Never log it.
   const code=typeof data.code==='string'||typeof data.code==='number'?data.code:null;
   return res.status(200).json({status,data:{code,token:status===200&&typeof data.token==='string'?data.token:undefined}});
  }catch{return res.status(502).json({error:'PROXY_CONNECTION_FAILED'});}
 };
}
export default makeHandler();
