import {timingSafeEqual} from 'node:crypto';
import {HostCalendar,reconcile,SyncError} from '../server/spacecloud.mjs';

export function authorized(value,secret){
 if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))return false;
 const a=Buffer.from(value||''),b=Buffer.from('Bearer '+secret);
 return a.length===b.length&&timingSafeEqual(a,b);
}
export function makeSyncHandler({env=process.env,fetcher=fetch,launch}={}){
 return async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if(!authorized(req.headers.authorization,env.SPACECLOUD_SYNC_SECRET))return res.status(401).json({error:'UNAUTHORIZED'});
  const key=env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key||!env.SPACECLOUD_EMAIL||!env.SPACECLOUD_PASSWORD)return res.status(503).json({error:'CONFIGURATION'});
  async function rpc(action,p={}){
   const response=await fetcher('https://qhvwwdrwfzwpehfjntbv.supabase.co/rest/v1/rpc/ss_spacecloud_worker',{
    method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p}),signal:AbortSignal.timeout(15000)
   });
   if(!response.ok)throw new SyncError('NETWORK');return response.json();
  }
  let browser,job,adapter,timer,timedOut=false;
  try{
   job=await rpc('claim');if(!job.id)return res.status(200).json({state:'idle'});
   const run=async()=>{
    if(launch)browser=await launch();
    else{
     const [{default:chromium},{chromium:playwright}]=await Promise.all([import('@sparticuz/chromium'),import('playwright-core')]);
     browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
    }
    if(timedOut){await browser.close();throw new SyncError('INTERRUPTED');}
    const context=await browser.newContext({locale:'ko-KR',timezoneId:'Asia/Seoul'}),page=await context.newPage();
    page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(20000);
    adapter=new HostCalendar(page,{email:env.SPACECLOUD_EMAIL,password:env.SPACECLOUD_PASSWORD});
    await adapter.connect();await reconcile(adapter,job);
   };
   await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new SyncError('INTERRUPTED'));},140000);})]);
   await browser?.close();browser=null;
   await rpc('finish',{id:job.id,lease:job.lease,revision:job.revision,logged_in:true});
   return res.status(200).json({state:'processed'});
  }catch(e){
   // Do not log page content, credentials, cookies, names, or provider errors.
   await browser?.close().catch(()=>{});browser=null;
   const code=e instanceof SyncError?e.code:'UI_CHANGED';
   if(job?.id)await rpc('finish',{id:job.id,lease:job.lease,revision:job.revision,error:code,logged_in:!!adapter?.loggedIn}).catch(()=>{});
   return res.status(503).json({error:code});
  }finally{clearTimeout(timer);await browser?.close().catch(()=>{});}
 };
}
export default makeSyncHandler();
