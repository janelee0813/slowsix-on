// Deploy as `admin-api`. Only this function has service-role access.
// Auth passwords are managed by Supabase Auth; browser clients never receive Auth JWTs.
// Financial RPCs require a separate random, expiring session on every call.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };
const project = 'https://qhvwwdrwfzwpehfjntbv.supabase.co';
const site = 'https://slowsixon.com';
const allowedOrigins = new Set([site, 'https://www.slowsixon.com']);
const publicActions = new Set(['login','link_info','register']);
const actions = new Set(['me','logout','list','save_entry','delete_entry','people','set_status','create_invite','revoke_invite','audit']);
const errors: Record<string,string> = {
 LINK_INVALID:'링크가 만료되었거나 이미 사용되었습니다. 새 링크를 요청해주세요.',
 USERNAME_TAKEN:'사용할 수 없는 아이디입니다.', DUPLICATE:'이미 사용 중인 아이디 또는 중복 요청입니다.',
 SESSION_EXPIRED:'로그인이 만료되었습니다. 다시 로그인해주세요.', ACCESS_DENIED:'접근이 중지된 계정입니다. 관리자에게 문의해주세요.',
 APPROVAL_REQUIRED:'관리자 승인 후 이용할 수 있습니다.', FORBIDDEN:'이 작업을 수행할 권한이 없습니다.',
 OPERATOR_LIMIT:'활성 운영자는 최대 2명입니다. 기존 운영자의 접근을 먼저 해제해주세요.',
 CONFLICT:'다른 사람이 변경한 내역입니다. 새로고침 후 다시 확인해주세요.', INVALID_PERIOD:'조회 기간은 최대 366일입니다.',
 INVALID_ENTRY:'입력값을 확인해주세요.', INVALID_ACTION:'지원하지 않는 요청입니다.',
};
export class AppError extends Error { constructor(public code: string, public status=400, public retryAfter=0) { super(errors[code] || code); } }
export const sha = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
export function validatePassword(p: unknown) {
 if(typeof p!=='string' || [...p].length<8 || new TextEncoder().encode(p).length>72) throw new AppError('비밀번호는 8자 이상, 72바이트 이내로 입력해주세요.');
 if(/^(.)\1+$/.test(p) || /^\d+$/.test(p) && ('01234567890123456789'.includes(p)||'98765432109876543210'.includes(p)) || ['password','password1','password123','qwerty123','qwer1234','abcd1234','slowsix1','slowsix123'].includes(p.toLowerCase())) throw new AppError('흔하거나 단순한 비밀번호는 사용할 수 없습니다.');
}
export function username(value: unknown) {
 const s=typeof value==='string'?value.trim().toLowerCase():'';
 if(!/^[a-z][a-z0-9]{2,23}$/.test(s)) throw new AppError('아이디는 영문으로 시작하는 영문·숫자 3~24자리로 입력해주세요.');
 return s;
}
const uuid = (value: unknown) => typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validDate = (value: unknown) => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function safePayload(action: string,b: Record<string,unknown>) {
 if(action==='list') {
  if(!validDate(b.from)||!validDate(b.to)||!Number.isInteger(b.offset)||Number(b.offset)<0) throw new AppError('INVALID_PERIOD');
  return {from:b.from,to:b.to,offset:b.offset};
 }
 if(action==='save_entry') {
  if(!validDate(b.date)||!['spacecloud','invoice','cash','fixed','expense'].includes(String(b.category))||typeof b.description!=='string'||!b.description.trim()||b.description.trim().length>200||!Number.isSafeInteger(b.amount)||Number(b.amount)<1||Number(b.amount)>1e10||!uuid(b.request_id)) throw new AppError('INVALID_ENTRY');
  if(b.id&&(!uuid(b.id)||!Number.isInteger(b.version))) throw new AppError('INVALID_ENTRY');
  return {id:b.id||null,version:b.version,date:b.date,description:b.description.trim(),category:b.category,amount:b.amount,request_id:b.request_id};
 }
 if(['delete_entry','set_status','revoke_invite'].includes(action)) {
  if(!uuid(b.id)) throw new AppError('INVALID_ENTRY');
  if(action==='delete_entry'&&!Number.isInteger(b.version)) throw new AppError('INVALID_ENTRY');
  if(action==='set_status'&&!['active','rejected','suspended'].includes(String(b.status))) throw new AppError('INVALID_ENTRY');
  return {id:b.id,version:b.version,status:b.status};
 }
 return {};
}
export function makeHandler(env: (name:string)=>string|undefined, fetcher: typeof fetch=fetch) {
 const base=env('SUPABASE_URL')||project;
 const service=env('SUPABASE_SERVICE_ROLE_KEY');
 const anon=env('SUPABASE_ANON_KEY');
 async function call(path:string,body:unknown,method='POST',key=service) {
  const response=await fetcher(base+path,{method,headers:{apikey:key||'',Authorization:`Bearer ${key||''}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) {
   const message=String(data.message||data.msg||data.error_description||'');
   const code=Object.keys(errors).find(k=>message.includes(k));
   if(code) throw new AppError(code,code==='SESSION_EXPIRED'?401:code==='FORBIDDEN'?403:400);
   if(path.startsWith('/auth/')) throw new AppError('인증을 처리할 수 없습니다. 입력값을 확인하거나 잠시 후 다시 시도해주세요.',400);
   throw new AppError('관리자 모드 연결이 준비되지 않았거나 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',503);
  }
  return data;
 }
 const rpc=(action:string,p:unknown)=>call('/rest/v1/rpc/ss_admin_gateway',{p_action:action,p});
 async function rate(key:string,cap:number) {
  const r=await rpc('rate',{key,cap});
  if(!r.allowed) throw new AppError('로그인 또는 요청 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.',429,Number(r.retryAfter)||900);
 }
 return async function handler(req: Request):Promise<Response> {
  const origin=req.headers.get('origin')||'';
  const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(allowedOrigins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
  headers['Access-Control-Allow-Headers']='content-type, apikey';
  headers['Access-Control-Allow-Methods']='POST, OPTIONS';
  if(req.method==='OPTIONS') return new Response(null,{status:allowedOrigins.has(origin)?204:403,headers});
  try {
   if(origin&&!allowedOrigins.has(origin)) throw new AppError('허용되지 않은 요청입니다.',403);
   if(req.method!=='POST') throw new AppError('POST 요청이 필요합니다.',405);
   if(!service||!anon) throw new AppError('서버 인증 설정이 필요합니다.',503);
   const raw=await req.text(); if(raw.length>16000) throw new AppError('요청이 너무 큽니다.',413);
   let b:Record<string,any>; try{b=JSON.parse(raw)}catch{throw new AppError('올바르지 않은 요청입니다.')}
   if(!b||typeof b!=='object'||Array.isArray(b)) throw new AppError('올바르지 않은 요청입니다.');
   const action=String(b.action||''); let result:any;
   // IP is supplementary only. Per-account/token limits remain enforced even if an IP header changes.
   if(publicActions.has(action)) {
    const ip=(req.headers.get('x-forwarded-for')||req.headers.get('cf-connecting-ip')||'unknown').split(',')[0].trim().slice(0,100);
    await rate('ip:'+await sha(ip),60);
   }
   if(action==='link_info'||action==='register') {
    if(typeof b.linkToken!=='string'||!/^[a-f0-9]{64}$/.test(b.linkToken)) throw new AppError('LINK_INVALID');
    const link_hash=await sha(b.linkToken);
    await rate('link:'+link_hash,action==='register'?10:60);
    const info=await rpc('link_info',{link_hash});
    if(action==='link_info') result=info;
    else {
     const user=username(b.username); validatePassword(b.password);
     const name=typeof b.name==='string'?b.name.trim():'';
     if(!name||name.length>40) throw new AppError('이름은 1~40자로 입력해주세요.');
     if(info.kind==='bootstrap'&&user!=='slowsix'||!['bootstrap','invite'].includes(info.kind)) throw new AppError('LINK_INVALID');
     const email=crypto.randomUUID()+'@accounts.slowsixon.invalid';
     const created=await call('/auth/v1/admin/users',{email,password:b.password,email_confirm:true});
     const id=created.id||created.user?.id;
     if(!uuid(id)) throw new AppError('계정을 생성하지 못했습니다.',503);
     try { result=await rpc('register',{id,email,username:user,name,link_hash}); }
     catch(err) {
      // Compensation removes a just-created Auth user if the invitation/username transaction fails.
      // Never delete pre-existing users; id comes solely from this create call.
      try{await call('/auth/v1/admin/users/'+id,undefined,'DELETE')}catch{console.error('Incomplete account registration cleanup; inspect unused Auth users.');}
      throw err;
     }
    }
   } else if(action==='login') {
    const user=username(b.username);
    if(typeof b.password!=='string'||b.password.length>256) throw new AppError('아이디 또는 비밀번호를 확인해주세요.');
    const key='login:'+await sha(user); await rate(key,10);
    const cred=await rpc('credentials',{username:user});
    let logged:any;
    try { logged=await call('/auth/v1/token?grant_type=password',{email:cred?.email||'unknown@accounts.slowsixon.invalid',password:b.password},'POST',anon); }
    catch { throw new AppError('아이디 또는 비밀번호를 확인해주세요.',401); }
    if(!cred||logged.user?.id!==cred.id) throw new AppError('아이디 또는 비밀번호를 확인해주세요.',401);
    const sessionToken=token(); const session_hash=await sha(sessionToken);
    await rpc('session_create',{id:cred.id,new_session_hash:session_hash});
    await rpc('rate_clear',{key});
    result={sessionToken,user:await rpc('me',{session_hash})};
   } else if(actions.has(action)) {
    if(typeof b.sessionToken!=='string'||!/^[a-f0-9]{64}$/.test(b.sessionToken)) throw new AppError('SESSION_EXPIRED',401);
    const session_hash=await sha(b.sessionToken);
    await rate('session:'+session_hash,600);
    const payload=safePayload(action,b);
    if(action==='create_invite') {
     const secret=token();
     result=await rpc(action,{session_hash,link_hash:await sha(secret)});
     result.url=site+'/admin.html#invite='+secret;
    } else result=await rpc(action,{...payload,session_hash});
   } else throw new AppError('INVALID_ACTION');
   return new Response(JSON.stringify(result),{headers});
  }catch(error) {
   const e=error instanceof AppError?error:new AppError('서버와 연결하지 못했습니다. 잠시 후 다시 시도해주세요.',503);
   if(e.retryAfter) headers['Retry-After']=String(e.retryAfter);
   return new Response(JSON.stringify({error:e.message,code:e.code,retryAfter:e.retryAfter}),{status:e.status,headers});
  }
 };
}
if(typeof Deno!=='undefined') Deno.serve(makeHandler(name=>Deno.env.get(name)));
