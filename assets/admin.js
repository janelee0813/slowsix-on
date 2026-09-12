const API='https://qhvwwdrwfzwpehfjntbv.supabase.co/functions/v1/admin-api';
const KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFodnd3ZHJ3Znp3cGVoZmpudGJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDk3MzksImV4cCI6MjEwNDc4NTczOX0.0fhW_bYEb9QedKLMb8DDnP8BYnP8aJtfywXLdyUA9ww';
const $=id=>document.getElementById(id);
const names={spacecloud:'스클 매출',invoice:'계산서 매출',cash:'현금 매출',fixed:'고정비',expense:'일반지출'};
const statuses={pending:'승인 대기',active:'이용 중',rejected:'가입 거절',suspended:'접근 중지'};
const money=v=>new Intl.NumberFormat('ko-KR').format(v)+'원';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
const time=v=>new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
let session=sessionStorage.getItem('ss-admin-session')||'', user=null, records=[], offset=0, count=0, editing=null;
let requestId=crypto.randomUUID(), linkToken='', linkKind='', loadSequence=0;
let noticeTimer;
function notice(message,error=false){clearTimeout(noticeTimer);$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;noticeTimer=setTimeout(()=>$('notice').hidden=true,error?12000:6000);}
function elem(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,fn,cls='quiet'){const b=elem('button',text,cls);b.type='button';b.addEventListener('click',()=>busy(b,fn));return b;}
async function busy(b,fn){if(b.disabled)return;b.disabled=true;try{await fn()}catch(e){notice(e.message,true)}finally{b.disabled=b.id==='prev'?offset===0:b.id==='next'?offset+100>=count:false}}
async function api(action,p={}){
 let response;try{response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',apikey:KEY},body:JSON.stringify({action,...p,sessionToken:session}),signal:AbortSignal.timeout(25000)})}catch{throw Error('서버에 연결하지 못했습니다. 연결 상태 또는 초기 설정 완료 여부를 확인해주세요.');}
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  if(['SESSION_EXPIRED','ACCESS_DENIED'].includes(data.code)){session='';sessionStorage.removeItem('ss-admin-session');showAuth();}
  const extra=data.retryAfter?` 약 ${Math.ceil(data.retryAfter/60)}분 후 다시 시도해주세요.`:'';
  throw Error((data.error||'관리자 모드 서버 설정이 아직 완료되지 않았습니다.')+extra);
 }
 return data;
}
function clearPrivateViews(){records=[];user=null;editing=null;loadSequence++;$('entries').replaceChildren();$('people').replaceChildren();$('links').replaceChildren();$('audit-list').replaceChildren();$('invite-url').value='';$('invite-result').hidden=true;for(const k of ['revenue','spending','profit','fee','settlement'])$('sum-'+k).textContent='—';}
function showAuth(){clearPrivateViews();$('dashboard').hidden=true;$('pending-screen').hidden=true;$('auth-screen').hidden=false;$('account-bar').hidden=true;$('back-site').hidden=false;}
function showAccount(){ $('auth-screen').hidden=true;$('account-bar').hidden=false;$('back-site').hidden=true;$('account-name').textContent=user.name+' · '+(user.role==='admin'?'관리자':'운영자');$('pending-screen').hidden=user.status!=='pending';$('dashboard').hidden=user.status!=='active'; }
async function enter(){
 user=await api('me');showAccount();if(user.status!=='active')return;
 const admin=user.role==='admin';$('role-badge').textContent=admin?'관리자':'운영자';$('tab-team').hidden=!admin;$('tab-audit').hidden=!admin;$('edit-heading').hidden=!admin;
 for(const option of $('entry-category').options)option.disabled=!admin&&!['spacecloud','fixed'].includes(option.value);
 $('entry-permission').textContent=admin?'전체 항목 입력·수정 가능':'스클 매출·고정비 등록 가능';resetEntry();switchTab('ledger');await loadLedger();
}
function setMonth(){const [y,m]=$('month').value.split('-').map(Number);if(!y||!m)return;$('from').value=`${y}-${String(m).padStart(2,'0')}-01`;$('to').value=`${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`;}
function period(){const from=$('from').value,to=$('to').value;if(!from||!to||from>to||(Date.parse(to)-Date.parse(from))/86400000>366)throw Error('시작일과 종료일을 확인해주세요. 최대 366일까지 조회할 수 있습니다.');return {from,to}}
function markLoading(){for(const k of ['revenue','spending','profit','fee','settlement'])$('sum-'+k).textContent='—';$('summary-period').textContent='내역을 불러오는 중입니다.';}
async function loadLedger(){const p=period(),seq=++loadSequence;markLoading();const data=await api('list',{...p,offset});if(seq!==loadSequence)return;
 records=data.entries;count=data.count;
 $('summary-period').textContent=p.from+' ~ '+p.to;for(const k of ['revenue','spending','profit','fee','settlement'])$('sum-'+k).textContent=money(data.summary[k]);
 const warnings=[];if(data.summary.profit<0)warnings.push('적자 기간입니다. 운영 수수료도 음수로 계산됩니다.');if(data.summary.settlement<0)warnings.push('정산금액이 음수입니다. 반대 방향 송금 또는 이월 여부는 별도 확인해주세요.');$('settlement-warning').hidden=!warnings.length;$('settlement-warning').textContent=warnings.join(' ');
 $('entry-count').textContent=count;$('entries').replaceChildren();
 if(!records.length){const tr=elem('tr'),td=elem('td','이 기간에 기록된 내역이 없습니다.\n위에서 첫 매출 또는 지출을 등록해보세요.','empty');td.colSpan=user.role==='admin'?8:7;tr.append(td);$('entries').append(tr);}
 for(const r of records){const tr=elem('tr'),date=elem('td',r.entry_date);date.append(elem('small',r.author));tr.append(date,elem('td',r.description));for(const k of Object.keys(names))tr.append(elem('td',r.category===k?new Intl.NumberFormat('ko-KR').format(r.amount):'—',r.category===k?(['fixed','expense'].includes(k)?'negative':'positive'):''));if(user.role==='admin'){const td=elem('td');td.append(button('수정',()=>editEntry(r)),button('삭제',async()=>{if(await confirmAction('내역 삭제',`${r.entry_date} · ${r.description} · ${money(r.amount)} 내역을 삭제하시겠습니까? 변경 이력에는 보관됩니다.`)){await api('delete_entry',{id:r.id,version:r.version});if(records.length===1&&offset>0)offset-=100;await loadLedger();notice('내역을 삭제했습니다.');}}));tr.append(td);}$('entries').append(tr);}
 $('prev').disabled=offset===0;$('next').disabled=offset+100>=count;$('page-label').textContent=count?`${offset+1}–${Math.min(offset+100,count)} / ${count}건`:'0건';
}
function resetEntry(){editing=null;requestId=crypto.randomUUID();$('entry-form').reset();$('entry-date').value=today();$('entry-title').textContent='새 내역 기록';$('save-entry').textContent='내역 등록';$('cancel-edit').hidden=true;categoryHelp();}
function categoryHelp(){const c=$('entry-category').value;const text={spacecloud:'통장 잔액 전체가 아닌, 이번에 실제 입금된 금액을 기록하세요.',invoice:'관리자가 받은 계산서 매출을 기록하세요.',cash:'관리자가 받은 현금 매출을 기록하세요.',fixed:'운영자가 지출한 월세·관리비·수리보수비 등을 기록하세요.',expense:'관리자가 지출한 구매비·청소비 등을 기록하세요.'};$('category-help').textContent=text[c];$('entry-suggestions').replaceChildren();for(const title of c==='fixed'?['월세','관리비','수리보수']:c==='expense'?['청소 알바비','물품 구매']:c==='spacecloud'?['스페이스클라우드 정산 입금']:[]){const o=elem('option');o.value=title;$('entry-suggestions').append(o);}}
function editEntry(r){editing=r;$('entry-date').value=r.entry_date;$('entry-category').value=r.category;$('entry-description').value=r.description;$('entry-amount').value=r.amount;$('entry-title').textContent='내역 수정';$('save-entry').textContent='변경 저장';$('cancel-edit').hidden=false;categoryHelp();$('entry-form').scrollIntoView({behavior:'smooth',block:'center'});}
async function confirmAction(title,message){$('dialog-title').textContent=title;$('dialog-message').textContent=message;$('confirm-dialog').showModal();return new Promise(resolve=>{const d=$('confirm-dialog');$('dialog-confirm').onclick=()=>{d.returnValue='yes';d.close()};$('dialog-cancel').onclick=()=>{d.returnValue='no';d.close()};d.oncancel=()=>{d.returnValue='no'};d.onclose=()=>resolve(d.returnValue==='yes');});}
function switchTab(name){for(const v of ['ledger','team','audit']){$(v+'-view').hidden=v!==name;$('tab-'+v).classList.toggle('active',v===name);}}
async function loadTeam(){const expected=session;const data=await api('people');if(session!==expected||user?.role!=='admin')return;$('people').replaceChildren();for(const p of data.people){const card=elem('article',undefined,'panel person');card.append(elem('h3',p.name),elem('p',p.username+' · '+(p.role==='admin'?'관리자':'운영자'),'muted small'),elem('span',statuses[p.status],'badge'));if(p.role==='operator'){const actions=elem('div',undefined,'actions');const change=(status,label)=>button(label,async()=>{if(await confirmAction(label,`${p.name} (${p.username}) 계정을 ${label}하시겠습니까?`)){await api('set_status',{id:p.id,status});await loadTeam();notice('계정 상태를 변경했습니다.');}},status==='active'?'primary':'secondary');if(p.status==='pending'){actions.append(change('active','승인'),change('rejected','거절'));}else if(p.status==='active'){actions.append(change('suspended','접근 중지'));}else{actions.append(change('active','다시 승인'));}card.append(actions);}$('people').append(card);}
 $('links').replaceChildren();for(const l of data.links){const row=elem('div',undefined,'link-row'),status=l.used_at?'사용 완료':l.revoked_at?'취소됨':new Date(l.expires_at)<new Date()?'만료됨':'사용 가능';row.append(elem('p',`${status} · 만료 ${time(l.expires_at)}`,'small muted'));if(status==='사용 가능')row.append(button('링크 취소',async()=>{if(await confirmAction('초대 취소','전달한 링크로 더 이상 가입할 수 없게 됩니다.')){await api('revoke_invite',{id:l.id});await loadTeam();}}));$('links').append(row);}if(!data.links.length)$('links').append(elem('p','발급한 초대 링크가 없습니다.','muted small'));
}
async function loadAudit(){const expected=session;const data=await api('audit');if(session!==expected||user?.role!=='admin')return;$('audit-list').replaceChildren();const titles={entry_created:'내역 등록',entry_updated:'내역 수정',entry_deleted:'내역 삭제',account_created:'계정 생성',status_changed:'계정 상태 변경',invite_created:'운영자 초대 발급'};for(const a of data.audit){const row=elem('article',undefined,'audit-row'),main=elem('div');main.append(elem('p',`${a.actor||'관리자'} · ${titles[a.action]||a.action}`));if(a.before_data||a.after_data){const detail=elem('details'),summary=elem('summary','변경 내용 보기','small muted');detail.append(summary);for(const [label,d] of [['변경 전',a.before_data],['변경 후',a.after_data]])if(d){const parts=[];if(d.entry_date)parts.push(d.entry_date,names[d.category],d.description,money(d.amount));if(d.status)parts.push(statuses[d.status]||d.status);if(d.username)parts.push(d.username);detail.append(elem('pre',label+' : '+parts.join(' · ')));}main.append(detail);}row.append(main,elem('time',time(a.created_at)));$('audit-list').append(row);}if(!data.audit.length)$('audit-list').append(elem('p','변경 이력이 없습니다.','muted'));
}
$('auth-form').addEventListener('submit',e=>{e.preventDefault();busy($('auth-submit'),async()=>{
 const username=$('auth-username').value.trim().toLowerCase(),password=$('auth-password').value;
 if(linkToken){if(password!==$('auth-confirm').value)throw Error('비밀번호 확인이 일치하지 않습니다.');const r=await api('register',{username,password,name:$('auth-name').value,linkToken});sessionStorage.removeItem('ss-admin-link');linkToken='';linkKind='';$('auth-password').value='';$('auth-confirm').value='';configureLogin();notice(r.status==='active'?'관리자 계정이 준비되었습니다. 로그인해주세요.':'가입 신청이 완료되었습니다. 로그인하면 승인 상태를 확인할 수 있습니다.');return;}
 const data=await api('login',{username,password});session=data.sessionToken;sessionStorage.setItem('ss-admin-session',session);if($('remember').checked)localStorage.setItem('ss-admin-username',username);else localStorage.removeItem('ss-admin-username');$('auth-password').value='';await enter();
 });});
$('entry-form').addEventListener('submit',e=>{e.preventDefault();busy($('save-entry'),async()=>{const amount=Number($('entry-amount').value);if(!Number.isSafeInteger(amount)||amount<=0)throw Error('금액은 1원 이상의 정수로 입력해주세요.');await api('save_entry',{id:editing?.id,version:editing?.version,date:$('entry-date').value,category:$('entry-category').value,description:$('entry-description').value,amount,request_id:requestId});resetEntry();offset=0;await loadLedger();notice('내역을 저장했습니다.');});});
$('entry-category').addEventListener('change',categoryHelp);$('cancel-edit').addEventListener('click',resetEntry);
$('month').addEventListener('change',()=>{setMonth();offset=0;busy($('load-period'),loadLedger)});
$('load-period').addEventListener('click',()=>{offset=0;busy($('load-period'),loadLedger)});
$('prev').addEventListener('click',()=>{offset=Math.max(0,offset-100);busy($('prev'),loadLedger)});
$('next').addEventListener('click',()=>{offset+=100;busy($('next'),loadLedger)});
$('logout').addEventListener('click',()=>busy($('logout'),async()=>{try{await api('logout')}finally{session='';sessionStorage.removeItem('ss-admin-session');$('auth-password').value='';showAuth();}}));
$('check-status').addEventListener('click',()=>busy($('check-status'),async()=>{await enter();if(user.status==='pending')notice('아직 승인 대기 중입니다.');}));
$('tab-ledger').addEventListener('click',()=>{switchTab('ledger');busy($('load-period'),loadLedger)});
$('tab-team').addEventListener('click',()=>busy($('tab-team'),async()=>{await loadTeam();switchTab('team')}));
$('tab-audit').addEventListener('click',()=>busy($('tab-audit'),async()=>{await loadAudit();switchTab('audit')}));
$('create-invite').addEventListener('click',()=>busy($('create-invite'),async()=>{const result=await api('create_invite');$('invite-url').value=result.url;$('invite-result').hidden=false;await loadTeam();}));
$('copy-invite').addEventListener('click',()=>busy($('copy-invite'),async()=>{try{await navigator.clipboard.writeText($('invite-url').value);notice('가입 링크를 복사했습니다. 카카오톡으로 직접 전달해주세요.');}catch{$('invite-url').select();notice('링크를 선택했습니다. 복사해서 전달해주세요.');}}));
function configureLogin(){for(const id of ['name-label','confirm-label','password-guide'])$(id).hidden=true;$('auth-name').required=false;$('auth-confirm').required=false;$('remember-label').hidden=false;$('auth-username').readOnly=false;$('auth-password').autocomplete='current-password';$('auth-password').removeAttribute('minlength');$('auth-title').textContent='관리자 모드 로그인';$('auth-description').textContent='등록한 아이디와 비밀번호를 입력해주세요.';$('auth-submit').textContent='로그인';$('auth-foot').hidden=false;}
async function init(){
 $('month').value=today().slice(0,7);setMonth();$('entry-date').value=today();categoryHelp();$('auth-username').value=localStorage.getItem('ss-admin-username')||'';$('remember').checked=!!$('auth-username').value;
 const hash=new URLSearchParams(location.hash.slice(1)),incoming=hash.get('setup')||hash.get('invite');if(incoming){sessionStorage.setItem('ss-admin-link',incoming);history.replaceState(null,'',location.pathname);}
 linkToken=sessionStorage.getItem('ss-admin-link')||'';
 if(linkToken){showAuth();$('auth-submit').disabled=true;try{const info=await api('link_info',{linkToken});linkKind=info.kind;for(const id of ['name-label','confirm-label','password-guide'])$(id).hidden=false;$('auth-name').required=true;$('auth-confirm').required=true;$('remember-label').hidden=true;$('auth-password').minLength=8;$('auth-password').autocomplete='new-password';$('auth-foot').hidden=true;$('auth-eyebrow').textContent=linkKind==='bootstrap'?'FIRST SETUP':'YOU ARE INVITED';$('auth-title').textContent=linkKind==='bootstrap'?'관리자 계정 설정':'운영자 가입 신청';$('auth-description').textContent=linkKind==='bootstrap'?'slowsix 계정의 비밀번호를 직접 설정해주세요.':'가입 후 관리자의 승인을 기다려주세요.';$('auth-submit').textContent=linkKind==='bootstrap'?'관리자 계정 만들기':'가입 신청';if(linkKind==='bootstrap'){$('auth-username').value='slowsix';$('auth-username').readOnly=true;}}catch(e){sessionStorage.removeItem('ss-admin-link');linkToken='';configureLogin();notice(e.message,true);}finally{$('auth-submit').disabled=false;}}
 else if(session){try{await enter()}catch(e){notice(e.message,true)}}
}
init();
