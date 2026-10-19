// Dashboard-only connectivity diagnostic and explicit one-time admin test. Never returns credentials.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };
export const templates:Record<string,string>={requested:'ppur_2026091713562747407967598',awaiting_payment:'ppur_2026091713565824417631569',confirmed:'ppur_2026091713573124417016883',rejected:'ppur_2026091713580424417116780',cancelled:'ppur_2026091713583347407004301'};
export function bookingMessage(job:any){
 const b=job.snapshot,stamp=(v:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v));
 const words:Record<string,string>={var1:job.booking_id,var2:('슬로우식스'+String(b.space).toUpperCase()+' '+stamp(b.starts_at)+'~'+stamp(b.ends_at)).slice(0,100)};
 if(['requested','awaiting_payment','confirmed'].includes(job.kind)){words.var3=String(b.guests);words.var4=Number(b.total_amount).toLocaleString('en-US');}
 return {account:'slowsix',messageType:'ALT',senderProfile:'@slowsix',templateCode:templates[job.kind],duplicateFlag:'N',targetCount:1,targets:[{to:job.phone,name:String(b.nickname).slice(0,100),changeWord:words}],isResend:'N',refKey:String(job.id).replaceAll('-','')};
}
export async function workerAuthorized(req:Request,raw:string,secret:string|undefined){
 const timestamp=req.headers.get('x-ss-timestamp')||'',signature=req.headers.get('x-ss-signature')||'';
 if(!secret||secret.length<32||!/^\d{13}$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>60000||!/^[a-f0-9]{64}$/.test(signature))return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 return crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g)!,x=>parseInt(x,16)),new TextEncoder().encode(`ppurio-worker\n${timestamp}\n${raw}`));
}
export function makeHandler(env: (name: string) => string | undefined, fetcher = fetch) {
 return async (req: Request) => {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  const raw=await req.text();if(raw.length>16000)return json({error:'INVALID_REQUEST'},413);let input:any;try{input=JSON.parse(raw||'{}');}catch{return json({error:'INVALID_REQUEST'},400);}if(!input||typeof input!=='object'||Array.isArray(input))return json({error:'INVALID_REQUEST'},400);
  const worker=input.action==='dispatch'&&await workerAuthorized(req,raw,env('PPURIO_RELAY_SECRET')?.trim());
  let secretKeys: unknown[] = [];
  try { secretKeys = Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}')); } catch { /* deny malformed configuration */ }
  const apiKey = req.headers.get('apikey');
  const secretAuthorized = Boolean(apiKey && secretKeys.some(key => typeof key === 'string' && key.length > 20 && key === apiKey));
  if (!(service && req.headers.get('Authorization') === `Bearer ${service}`) && !secretAuthorized && !worker) return json({ error: 'FORBIDDEN' }, 403);
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if(input.action==='dispatch'&&!worker)return json({error:'FORBIDDEN'},403);
  const account = env('PPURIO_ACCOUNT')?.trim();
  const key = env('PPURIO_ACCESS_KEY')?.trim();
  if (account !== 'slowsix' || !key) return json({ error: 'SETTINGS_REQUIRED', accountMatches: account === 'slowsix', accessKeyPresent: Boolean(key) }, 400);
  try {

   if(input.route==='fixie'){
    const relaySecret=env('PPURIO_RELAY_SECRET')?.trim();
    if(!relaySecret||relaySecret.length<32)return json({error:'RELAY_SECRET_REQUIRED',messageSent:false},503);
    const relay=async(action:string,authorization:string,payload?:unknown)=>{
     const body=JSON.stringify({action,authorization,...(payload?{payload}:{})}),timestamp=String(Date.now());
     const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(relaySecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
     const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode(`ppurio-relay\n${timestamp}\n${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
     const response=await fetcher('https://slowsixon.com/api/ppurio-relay',{method:'POST',headers:{'Content-Type':'application/json','x-ss-timestamp':timestamp,'x-ss-signature':signature},body,redirect:'error',signal:AbortSignal.timeout(25000)});
     return {response,result:await response.json(),body};
    };
    if(worker){
     if(!service)return json({error:'SETTINGS_REQUIRED'},503);
     const rpc=async(action:string,p:any={})=>{const r=await fetcher('https://qhvwwdrwfzwpehfjntbv.supabase.co/rest/v1/rpc/ss_ppurio_worker',{method:'POST',headers:{apikey:service,Authorization:`Bearer ${service}`,'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('DATABASE');return r.json();};
     const job=await rpc('claim');if(!job.id)return json({state:'idle'});
     let state='retry',provider_code:string|null=null,message_key:string|null=null;
     try{
      const auth=await relay('token',`Basic ${btoa(`${account}:${key}`)}`);
      if(auth.response.ok&&auth.result.status===200&&typeof auth.result.data?.token==='string'){
       const payload=bookingMessage(job);await rpc('dispatch',{id:job.id,lease:job.lease});state='unknown';
       const sent=await relay('kakao',`Bearer ${auth.result.data.token}`,payload);
       provider_code=sent.result.data?.code==null?null:String(sent.result.data.code);message_key=sent.result.data?.messageKey??null;
       state=sent.response.ok&&sent.result.status===200&&provider_code==='1000'?'sent':sent.response.ok&&sent.result.status===400?'failed':'unknown';
      }else provider_code=String(auth.result.data?.code??'AUTHENTICATION');
     }catch{/* An interrupted dispatch must never be retried blindly. */}
     await rpc('finish',{id:job.id,lease:job.lease,state,provider_code,message_key});
     return json({state});
    }
    const {response,result,body}=await relay('token',`Basic ${btoa(`${account}:${key}`)}`);
    const tag=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
    if(response.status===403)return json({stage:'relay',authenticated:false,relayHttpStatus:403,error:'FORBIDDEN',keyTag:await tag(relaySecret),bodyTag:await tag(body),messageSent:false},502);
    if(!response.ok)return json({stage:'relay',authenticated:false,relayHttpStatus:response.status,error:['FIXIE_CONFIGURATION','PROXY_CONNECTION_FAILED','FORBIDDEN'].includes(result.error)?result.error:'RELAY_FAILED',messageSent:false},502);
    if(input.action==='send_test'){
     const testId='slowsix-admin-test-20261019-01';
     if(input.testId!==testId)return json({error:'TEST_CONFIRMATION_REQUIRED',messageSent:false},400);
     if(result.status!==200||typeof result.data?.token!=='string')return json({stage:'token',authenticated:false,providerCode:result.data?.code??null,messageSent:false},502);
     if(!service)return json({error:'SETTINGS_REQUIRED',messageSent:false},503);
     const dbHeaders={'apikey':service,'Authorization':`Bearer ${service}`,'Content-Type':'application/json'};
     const dbUrl='https://qhvwwdrwfzwpehfjntbv.supabase.co/rest/v1/ss_ppurio_test_runs';
     // Persistent claim before dispatch: a double click, retry, or ambiguous timeout never sends twice.
     const claim=await fetcher(dbUrl,{method:'POST',headers:{...dbHeaders,Prefer:'return=representation'},body:JSON.stringify({id:testId,state:'attempted'}),signal:AbortSignal.timeout(15000)});
     if(claim.status===409)return json({error:'TEST_ALREADY_ATTEMPTED',messageSent:false},409);
     if(!claim.ok)return json({error:'TEST_LOG_REQUIRED',messageSent:false},503);
     let state='unknown',providerCode:string|null=null,messageKey:string|null=null;
     try{
      const sent=await relay('kakao_test',`Bearer ${result.data.token}`);
      providerCode=sent.result.data?.code==null?null:String(sent.result.data.code);
      messageKey=typeof sent.result.data?.messageKey==='string'?sent.result.data.messageKey:null;
      state=sent.response.ok&&sent.result.status===200&&providerCode==='1000'?'accepted':'rejected';
     }catch{/* Preserve unknown attempt; never retry automatically. */}
     const saved=await fetcher(dbUrl+'?id=eq.'+testId,{method:'PATCH',headers:dbHeaders,body:JSON.stringify({state,provider_code:providerCode,message_key:messageKey}),signal:AbortSignal.timeout(15000)}).then(r=>r.ok).catch(()=>false);
     return json({stage:'kakao_test',messageSubmitted:state==='accepted',deliveryConfirmed:false,providerCode,messageKey,state,resultSaved:saved},state==='accepted'?200:502);
    }
    return json({stage:'token',route:'fixie',authenticated:result.status===200&&typeof result.data?.token==='string'&&result.data.token.length>0,providerHttpStatus:result.status,providerCode:result.data?.code??null,messageSent:false});
   }
   const response = await fetcher('https://message.ppurio.com/v1/token', {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${account}:${key}`)}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
   });
   const data = await response.json();
   return json({ stage: 'token', authenticated: response.ok && typeof data.token === 'string' && data.token.length > 0, providerHttpStatus: response.status, providerCode: typeof data.code === 'number' || typeof data.code === 'string' ? data.code : null, messageSent: false });
  } catch {
   return json({ stage: 'token', authenticated: false, error: 'PROVIDER_CONNECTION_FAILED', messageSent: false }, 502);
  }
 };
}
if (typeof Deno !== 'undefined') Deno.serve(makeHandler(name => Deno.env.get(name)));
