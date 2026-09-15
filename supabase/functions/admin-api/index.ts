// Deploy as `admin-api`. Only this function has service-role access.
// Auth passwords are managed by Supabase Auth; browser clients never receive Auth JWTs.
// Financial RPCs require a separate random, revocable session on every call.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };
const project = 'https://qhvwwdrwfzwpehfjntbv.supabase.co';
const site = 'https://slowsixon.com';
const allowedOrigins = new Set([site, 'https://www.slowsixon.com']);
const publicActions = new Set(['login','link_info','register']);
const actions = new Set(['member_coupon_wallet','member_coupon_issue','member_delete','member_inbox','member_home','member_read','member_calendar','member_bookings','member_quote','member_request','member_cancel','member_invite','member_invites','member_revoke','member_people','member_person_save','member_settings','member_settings_save','member_blocks','member_block_save','member_block_delete','member_status','recurring_list','recurring_save','recurring_delete','me','update_name','logout','list','save_fee','save_entry','delete_entry','people','set_status','create_invite','revoke_invite','audit']);
const errors: Record<string,string> = {
 EXTERNAL_CALENDAR_UNAVAILABLE:'스페이스클라우드 일정을 불러오지 못했습니다. 잠시 후 다시 조회해주세요. 예약 요청은 일정 확인 후 가능합니다.',
 COUPON_NOT_APPLICABLE:'선택한 쿠폰을 사용할 수 없는 이용시간입니다.',
 MEMBER_HAS_BOOKINGS:'진행 중인 예약을 먼저 취소하거나 이용을 완료한 후 멤버십을 삭제해주세요.',
 INVALID_BOOKING:'예약은 정각 기준 1~24시간, 6~13명, 향후 1년 이내로 신청해주세요.', TIME_UNAVAILABLE:'선택한 시간에 예약 또는 이용 불가 일정이 있습니다.', COUPON_UNAVAILABLE:'이번 달 사용 가능한 쿠폰이 없습니다.', CANCEL_REQUIRES_ADMIN:'확정되었거나 이용 시간이 지난 예약은 관리자에게 취소를 요청해주세요.', INVALID_TRANSITION:'현재 예약 상태에서는 처리할 수 없습니다. 새로 조회해주세요.', PAYMENT_NOTE_REQUIRED:'입금 안내를 입력해주세요.',
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
 if(action.startsWith('member_')) {
  const out:Record<string,unknown>={};
  const limited=(key:string,max:number)=>{if(b[key]!=null&&(typeof b[key]!=='string'||String(b[key]).length>max))throw new AppError('INVALID_ENTRY');return b[key]??'';};
  if(action==='member_coupon_issue'){if(!uuid(b.id)||!uuid(b.member_id)||!['discount5000','night','hours3'].includes(String(b.kind))||typeof b.expires_at!=='string'||!Number.isFinite(Date.parse(b.expires_at)))throw new AppError('INVALID_ENTRY');return {id:b.id,member_id:b.member_id,kind:b.kind,expires_at:b.expires_at};}
  if(['member_quote','member_request'].includes(action)){if(b.coupon_id!=null&&!uuid(b.coupon_id))throw new AppError('INVALID_ENTRY');if(b.coupon_id&&b.use_coupon)throw new AppError('INVALID_ENTRY');out.coupon_id=b.coupon_id??null;}
  if(['member_delete','member_request','member_cancel','member_status','member_revoke','member_person_save','member_block_save','member_block_delete'].includes(action)){if(!uuid(b.id))throw new AppError('INVALID_ENTRY');out.id=b.id;}
  if(['member_delete','member_cancel','member_status','member_person_save'].includes(action)){if(!Number.isInteger(b.version)||Number(b.version)<1)throw new AppError('INVALID_ENTRY');out.version=b.version;}
  if(['member_quote','member_request','member_block_save'].includes(action)){
   for(const key of ['starts_at','ends_at']){if(typeof b[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(b[key]))||!Number.isFinite(Date.parse(String(b[key]))))throw new AppError('INVALID_BOOKING');out[key]=b[key];}
   if(action!=='member_block_save'){if(!Number.isInteger(b.guests)||Number(b.guests)<6||Number(b.guests)>13||typeof b.use_coupon!=='boolean')throw new AppError('INVALID_BOOKING');out.guests=b.guests;out.use_coupon=b.use_coupon;}
   out.note=limited('note',500);
  }
  if(['member_calendar','member_bookings'].includes(action)){for(const key of ['from','to']){if(typeof b[key]!=='string'||!Number.isFinite(Date.parse(String(b[key]))))throw new AppError('INVALID_PERIOD');out[key]=b[key];}}
  if(['member_invite','member_person_save'].includes(action)){if(!['friends','crew'].includes(String(b.tier)))throw new AppError('INVALID_ENTRY');out.tier=b.tier;}
  if(action==='member_person_save'){if(!['active','suspended'].includes(String(b.status)))throw new AppError('INVALID_ENTRY');out.status=b.status;}
  if(action==='member_status'){if(!['awaiting_payment','confirmed','rejected','cancelled'].includes(String(b.status)))throw new AppError('INVALID_ENTRY');out.status=b.status;out.admin_note=limited('admin_note',500);out.payment_note=limited('payment_note',1000);}
  if(action==='member_settings_save')out.payment_note=limited('payment_note',1000);
  if(action==='member_read'){if(!Number.isSafeInteger(b.through)||Number(b.through)<0)throw new AppError('INVALID_ENTRY');out.through=b.through;}
  return out;
 }
 if(action==='recurring_save') {
  if(!uuid(b.id)||!Number.isInteger(b.version)||Number(b.version)<0||!['fixed','expense'].includes(String(b.category))||typeof b.description!=='string'||!b.description.trim()||b.description.trim().length>200||!Number.isSafeInteger(b.amount)||Number(b.amount)<1||Number(b.amount)>1e10||!validDate(b.start_month)||!String(b.start_month).endsWith('-01')||(b.end_month!=null&&(!validDate(b.end_month)||!String(b.end_month).endsWith('-01')||String(b.end_month)<String(b.start_month)))) throw new AppError('INVALID_ENTRY');
  return {id:b.id,version:b.version,category:b.category,description:b.description.trim(),amount:b.amount,start_month:b.start_month,end_month:b.end_month??null};
 }
 if(action==='update_name') {
  if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>40) throw new AppError('닉네임은 1~40자로 입력해주세요.');
  return {name:b.name.trim()};
 }
 if(action==='list') {
  if(!validDate(b.from)||!validDate(b.to)||!Number.isInteger(b.offset)||Number(b.offset)<0) throw new AppError('INVALID_PERIOD');
  const sort_by=b.sort_by??'date',sort_dir=b.sort_dir??'desc';
  if(!['date','author','description','spacecloud','invoice','cash','fixed','expense'].includes(String(sort_by))||!['asc','desc'].includes(String(sort_dir))) throw new AppError('INVALID_ENTRY');
  return {from:b.from,to:b.to,offset:b.offset,sort_by,sort_dir};
 }
 if(action==='save_fee') {
  if(!validDate(b.from)||!validDate(b.to)) throw new AppError('INVALID_PERIOD');
  if(!Number.isSafeInteger(b.amount)||Math.abs(Number(b.amount))>1e12||!Number.isInteger(b.version)||Number(b.version)<0) throw new AppError('INVALID_ENTRY');
  return {from:b.from,to:b.to,amount:b.amount,version:b.version};
 }
 if(action==='save_entry') {
  if(!validDate(b.date)||!['spacecloud','invoice','cash','fixed','expense'].includes(String(b.category))||typeof b.description!=='string'||!b.description.trim()||b.description.trim().length>200||!Number.isSafeInteger(b.amount)||Number(b.amount)<1||Number(b.amount)>1e10||!uuid(b.request_id)) throw new AppError('INVALID_ENTRY');
  if(b.id&&(!uuid(b.id)||!Number.isInteger(b.version))) throw new AppError('INVALID_ENTRY');
  return {id:b.id||null,version:b.version,date:b.date,description:b.description.trim(),category:b.category,amount:b.amount,request_id:b.request_id};
 }
 if(['recurring_delete','delete_entry','set_status','revoke_invite'].includes(action)) {
  if(!uuid(b.id)) throw new AppError('INVALID_ENTRY');
  if(['delete_entry','recurring_delete'].includes(action)&&(!Number.isInteger(b.version)||Number(b.version)<1)) throw new AppError('INVALID_ENTRY');
  if(action==='set_status'&&!['active','rejected','suspended'].includes(String(b.status))) throw new AppError('INVALID_ENTRY');
  return {id:b.id,version:b.version,status:b.status};
 }
 return {};
}
// Calendar access token is kept in the Edge Function environment, not browser or repository code.
export function parseReservationFeed(raw:string) {
 if(raw.length>2000000||!raw.includes('BEGIN:VCALENDAR')||!raw.includes('END:VCALENDAR'))throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
 const lines=raw.replace(/^\uFEFF/,'').replace(/\r?\n[ \t]/g,'').split(/\r?\n/);
 const items:Array<{starts_at:string,ends_at:string,masked_name:string,source:string}>=[];
 let event:Record<string,{value:string,params:string}>|null=null;
 const date=(field:{value:string,params:string}|undefined)=>{
  if(!field)throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
  const v=field.value,match=/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/.exec(v);
  if(!match||(/TZID=/.test(field.params)&&!/TZID="?(Asia\/Seoul|UTC)"?(?:;|$)/.test(field.params)))throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
  const [,y,m,d,hh='00',mm='00',ss='00',z]=match,offset=z||/TZID="?UTC/.test(field.params)?'Z':'+09:00';
  const iso=`${y}-${m}-${d}T${hh}:${mm}:${ss}${offset}`,ms=Date.parse(iso);
  if(!Number.isFinite(ms)||Number(hh)>23||Number(mm)>59||Number(ss)>59||new Date(ms+(offset==='Z'?0:9*3600000)).toISOString().slice(0,19)!==`${y}-${m}-${d}T${hh}:${mm}:${ss}`)throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
  return new Date(ms).toISOString();
 };
 for(const line of lines){
  if(line==='BEGIN:VEVENT'){if(event)throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);event={};continue;}
  if(line==='END:VEVENT'){
   if(!event)throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
   if(event.STATUS?.value!=='CANCELLED'&&event.TRANSP?.value!=='TRANSPARENT'){
    if(event.RRULE||event.RDATE||event['RECURRENCE-ID'])throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
    const starts_at=date(event.DTSTART),ends_at=date(event.DTEND);
    if(ends_at<=starts_at)throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
    const name=(event.SUMMARY?.value||'').replace(/\\[nN]/g,' ').replace(/\\([,;\\])/g,'$1').trim();
    const chars=Array.from(name);const masked_name=chars.length?chars[0]+'*'.repeat(Math.min(30,Math.max(1,chars.length-1))):'예약자';
    items.push({starts_at,ends_at,masked_name,source:'spacecloud'});
   }
   event=null;continue;
  }
  if(event){const colon=line.indexOf(':');if(colon<0)continue;const left=line.slice(0,colon),key=left.split(';')[0];event[key]={value:line.slice(colon+1),params:left};}
 }
 if(event)throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);
 return items;
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
 let feedCache:{until:number,items:ReturnType<typeof parseReservationFeed>}|null=null;
 async function externalCalendar(fresh=false){
  if(!fresh&&feedCache&&feedCache.until>Date.now())return feedCache.items;
  try{
   const feedUID=env('SPACECLOUD_ICAL_UID');if(!feedUID)throw Error('feed configuration');
   const reservationFeed='https://api.spacecloud.kr/partner/reservations/ical?product_id=133597&ical_uid='+encodeURIComponent(feedUID);
   const response=await fetcher(reservationFeed,{headers:{Accept:'text/calendar'},signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('feed');
   const items=parseReservationFeed(await response.text());feedCache={until:Date.now()+30000,items};return items;
  }catch{throw new AppError('EXTERNAL_CALENDAR_UNAVAILABLE',503);}
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
     if(info.kind==='bootstrap'&&user!=='slowsix'||!['bootstrap','invite','member'].includes(info.kind)) throw new AppError('LINK_INVALID');
     let profile:Record<string,unknown>={};
     if(info.kind==='member'){
      const gender=b.gender??'',age_group=b.age_group??'',purposes=b.purposes??[];
      if(!['남성','여성'].includes(gender)||!['10대','20대','30대','40대','50대','60대 이상'].includes(age_group)||!Array.isArray(purposes)||purposes.length<1||purposes.length>6||purposes.some(x=>!['보드게임','홀덤','친목모임','스터디/강의','독서모임','기타'].includes(x)))throw new AppError('INVALID_ENTRY');
      profile={gender,age_group,purposes:[...new Set(purposes)]};
     }
     const email=crypto.randomUUID()+'@accounts.slowsixon.invalid';
     const created=await call('/auth/v1/admin/users',{email,password:b.password,email_confirm:true});
     const id=created.id||created.user?.id;
     if(!uuid(id)) throw new AppError('계정을 생성하지 못했습니다.',503);
     try { result=await rpc('register',{id,email,username:user,name,link_hash,...profile}); }
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
    if(action==='member_request'){
     const member=await rpc('me',{session_hash});
     if(member.role!=='member')throw new AppError('FORBIDDEN',403);
     if(member.status!=='active')throw new AppError('APPROVAL_REQUIRED');
     const items=await externalCalendar(true),start=Date.parse(String(payload.starts_at)),end=Date.parse(String(payload.ends_at));
     if(items.some(r=>Date.parse(r.starts_at)<end&&Date.parse(r.ends_at)>start))throw new AppError('TIME_UNAVAILABLE');
    }
    if(action==='create_invite'||action==='member_invite') {
     const secret=token();
     result=await rpc(action,{...payload,session_hash,link_hash:await sha(secret)});
     result.url=site+(action==='member_invite'?'/membership.html#invite=':'/admin.html#invite=')+secret;
    } else result=await rpc(action,{...payload,session_hash});
    if(action==='member_calendar'){
     const items=await externalCalendar(),start=Date.parse(String(payload.from)),end=Date.parse(String(payload.to));
     result.items.push(...items.filter(r=>Date.parse(r.starts_at)<end&&Date.parse(r.ends_at)>start));
     result.external_checked_at=new Date().toISOString();
    }
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
