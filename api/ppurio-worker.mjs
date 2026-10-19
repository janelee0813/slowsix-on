import {createHmac,timingSafeEqual} from 'node:crypto';
function authorized(value,secret){if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))return false;const a=Buffer.from(value||''),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);}
const anon='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFodnd3ZHJ3Znp3cGVoZmpudGJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDk3MzksImV4cCI6MjEwNDc4NTczOX0.0fhW_bYEb9QedKLMb8DDnP8BYnP8aJtfywXLdyUA9ww';
export function makeWorker({env=process.env,fetcher=fetch,now=Date.now}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if(!authorized(req.headers.authorization,env.SPACECLOUD_SYNC_SECRET))return res.status(403).json({error:'FORBIDDEN'});
  const secret=env.PPURIO_RELAY_SECRET?.trim();if(!secret||secret.length<32)return res.status(503).json({error:'CONFIGURATION'});
  const body=JSON.stringify({action:'dispatch',route:'fixie'}),timestamp=String(now());
  const signature=createHmac('sha256',secret).update(`ppurio-worker\n${timestamp}\n${body}`).digest('hex');
  try{
   const response=await fetcher('https://qhvwwdrwfzwpehfjntbv.supabase.co/functions/v1/ppurio-test',{method:'POST',headers:{Authorization:'Bearer '+anon,'Content-Type':'application/json','x-ss-timestamp':timestamp,'x-ss-signature':signature},body,redirect:'error',signal:AbortSignal.timeout(55000)});
   const data=await response.json();return res.status(response.ok?200:502).json({state:['idle','sent','failed','unknown','retry'].includes(data.state)?data.state:'error'});
  }catch{return res.status(502).json({state:'error'});}
 };
}
export default makeWorker();
