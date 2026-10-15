let membershipAdmin=null;
// Keep browser authentication requests on the site's own origin.
const API='/api/admin';
const KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFodnd3ZHJ3Znp3cGVoZmpudGJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDk3MzksImV4cCI6MjEwNDc4NTczOX0.0fhW_bYEb9QedKLMb8DDnP8BYnP8aJtfywXLdyUA9ww';
const $=id=>document.getElementById(id);
const names={"spacecloud": "매출 - 스클", "invoice": "매출 - 계산서", "cash": "매출 - 현금", "fixed": "지출 - 고정비", "expense": "지출 - 일반", "labor": "지출 - 인건비", "operating_deposit": "입금 - 운영비", "operating_withdrawal": "출금 - 운영비", "profit_withdrawal": "출금 - 수익", "fee_withdrawal": "출금 - 운영수수료"};
const incomes=['spacecloud','invoice','cash'],expenses=['fixed','expense','labor'];
const statuses={pending:'승인 대기',active:'이용 중',rejected:'가입 거절',suspended:'접근 중지'};
const money=v=>new Intl.NumberFormat('ko-KR').format(v)+'원';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
const time=v=>new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
function storedSession(){let value='';try{value=localStorage.getItem('ss-admin-session')||sessionStorage.getItem('ss-admin-session')||'';}catch{}if(value)storeSession(value);return value;}
function storeSession(value){try{if(value)localStorage.setItem('ss-admin-session',value);else localStorage.removeItem('ss-admin-session');sessionStorage.removeItem('ss-admin-session');}catch{try{if(value)sessionStorage.setItem('ss-admin-session',value);else sessionStorage.removeItem('ss-admin-session');}catch{}}}
let session=storedSession(), user=null, records=[], offset=0, count=0, editing=null;
let requestId=crypto.randomUUID(), linkToken='', linkKind='', loadSequence=0;
let lastSavedForm='', lastRequestedForm='';
let feePeriod=null, feeVersion=0, feeReady=false, feeSaving=false, feeReloadRequired=false;
let recurringEdit=null, recurringRequestId=crypto.randomUUID();
let noticeTimer, suggestionSequence=0, bankVersion=0, bankReady=false, lastCategory='', settlementDraft=null, financeData=null;
function notice(message,error=false){clearTimeout(noticeTimer);$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;noticeTimer=setTimeout(()=>$('notice').hidden=true,error?12000:6000);}
function elem(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,fn,cls='quiet'){const b=elem('button',text,cls);b.type='button';b.addEventListener('click',()=>busy(b,fn));return b;}
async function busy(b,fn){if(b.disabled)return;b.disabled=true;try{await fn()}catch(e){notice(e.message,true)}finally{b.disabled=b.id==='prev'?offset===0:b.id==='next'?offset+100>=count:false}}
async function api(action,p={}){
 // AbortSignal.timeout is unavailable in older iOS browser engines.
 const controller=new AbortController(),timeoutId=setTimeout(()=>controller.abort(),25000);
 let response,data;
 try{
  response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',apikey:KEY},body:JSON.stringify({action,...p,sessionToken:session}),signal:controller.signal});
  data=await response.json().catch(error=>{if(controller.signal.aborted)throw error;return {};});
 }catch{throw Error(controller.signal.aborted?'서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.':'관리자 서버와 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');}
 finally{clearTimeout(timeoutId);}
 if(!response.ok){
  if(['SESSION_EXPIRED','ACCESS_DENIED'].includes(data.code)){session='';storeSession('');showAuth();}
  const extra=data.retryAfter?` 약 ${Math.ceil(data.retryAfter/60)}분 후 다시 시도해주세요.`:'';
  throw Error((data.error||'관리자 모드 서버 설정이 아직 완료되지 않았습니다.')+extra);
 }
 return data;
}
function clearPrivateViews(){suggestionSequence++;bankReady=false;financeData=null;settlementDraft=null;if($('settlement-dialog').open)$('settlement-dialog').close();for(const id of ['description-chips','settlement-parties','settlement-history','operating-fund-people','entry-party'])$(id).replaceChildren();for(const id of ['sum-bank-balance','sum-pending-revenue','sum-pending-expense','sum-operating-outstanding'])$(id).textContent='—';$('bank-opening').value='';delete $('bank-opening').dataset.saved;$('bank-as-of').textContent='';membershipAdmin?.clear();membershipAdmin=null;$('tab-membership').textContent='멤버십 관리';recurringEdit=null;$('recurring-list').replaceChildren();$('recurring-form').reset();feePeriod=null;feeReady=false;$('manual-fee').value='';$('fee-status').textContent='';$('fee-form').hidden=true;records=[];user=null;editing=null;loadSequence++;$('entries').replaceChildren();$('people').replaceChildren();$('links').replaceChildren();$('audit-list').replaceChildren();$('invite-url').value='';$('invite-result').hidden=true;for(const k of ['revenue','spending','profit','fee','expense','settlement'])$('sum-'+k).textContent='—';}
function showAuth(){if($('nickname-dialog').open)$('nickname-dialog').close();clearPrivateViews();$('dashboard').hidden=true;$('pending-screen').hidden=true;$('auth-screen').hidden=false;$('account-bar').hidden=true;$('back-site').hidden=false;}
function showAccount(){ $('auth-screen').hidden=true;$('account-bar').hidden=false;$('back-site').hidden=true;$('account-name').textContent=user.name+' · '+(user.role==='admin'?'관리자':'운영자');$('pending-screen').hidden=user.status!=='pending';$('dashboard').hidden=user.status!=='active'; }
async function enter(){
 user=await api('me');if(user.role==='member'){session='';storeSession('');showAuth();throw Error('멤버십 계정은 멤버십 페이지에서 로그인해주세요.');}showAccount();if(user.status!=='active')return;
 const admin=user.role==='admin';$('entry-transfer').hidden=!admin;$('bank-opening-editor').hidden=!admin;$('role-badge').textContent=admin?'관리자':'운영자';$('tab-team').hidden=!admin;$('tab-membership').hidden=!admin;$('tab-audit').hidden=!admin;$('edit-heading').hidden=!admin;$('recurring-editor').hidden=!admin;$('recurring-permission').textContent=admin?'관리자는 고정 지출을 등록·수정할 수 있습니다.':'고정 지출 설정은 관리자만 변경할 수 있습니다.';resetRecurring();
 for(const option of $('entry-category').options)option.disabled=!admin&&!['spacecloud','fixed'].includes(option.value);
 $('entry-permission').textContent=admin?'전체 항목 입력·수정 가능':'스클 매출·고정비 등록 가능';resetEntry();switchTab('ledger');await loadLedger();
}
// Every settlement month runs from its first through its last calendar day.
function monthKey(year,month){return new Date(Date.UTC(year,month-1,1)).toISOString().slice(0,7);}
function settlementMonth(date){return date.slice(0,7);}
function setMonth(){const [y,m]=$('month').value.split('-').map(Number);if(!y||!m)return;$('month-label').textContent=y+'년 '+m+'월';$('from').value=monthKey(y,m)+'-01';$('to').value=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);}
function period(){const from=$('from').value,to=$('to').value;if(!from||!to||from>to||(Date.parse(to)-Date.parse(from))/86400000>366)throw Error('시작일과 종료일을 확인해주세요. 최대 366일까지 조회할 수 있습니다.');return {from,to}}
function markLoading(){bankReady=false;$('save-bank').disabled=true;$('settlement-parties').replaceChildren();$('settlement-history').replaceChildren();for(const id of ['sum-bank-balance','sum-pending-revenue','sum-pending-expense','sum-operating-outstanding'])$(id).textContent='—';$('operating-fund-people').replaceChildren();feeReady=false;$('save-fee').disabled=true;for(const k of ['revenue','spending','profit','fee','expense','settlement'])$('sum-'+k).textContent='—';$('summary-period').textContent='내역을 불러오는 중입니다.';}
// The existing API sorts the entire period newest-first, with 100-row pages.
// Read the corresponding page from its tail and reverse it for oldest-first.
// This reverses global order, not just the currently displayed 100 rows.
async function fetchLedgerPage(p,pageOffset,order){
 const [sort_by,sort_dir]=['asc','desc'].includes(order)?['date',order]:order.split(':');
 let head=await api('list',{...p,offset:pageOffset,sort_by,sort_dir});
 if(head.sort_supported)return head;
 if(sort_by!=='date')throw Error('전체 항목 정렬을 사용하려면 서버 업데이트가 필요합니다.');
 if(order!=='asc')return head;
 if(pageOffset)head=await api('list',{...p,offset:0});
 for(let attempt=0;attempt<3;attempt++){
  const size=Math.min(100,Math.max(0,head.count-pageOffset));
  if(!size)return {...head,entries:[]};
  const sourceOffset=head.count-pageOffset-size;
  const data=sourceOffset===0?head:await api('list',{...p,offset:sourceOffset});
  if(data.count===head.count)return {...data,entries:data.entries.slice(0,size).reverse()};
  // Retry from the first page if a concurrent insert/delete shifted page boundaries.
  head=await api('list',{...p,offset:0});
 }
 throw Error('조회 중 내역이 변경되었습니다. 조회 버튼을 다시 눌러주세요.');
}
async function loadLedger(){const p=period(),seq=++loadSequence;markLoading();let data;
 try{data=await fetchLedgerPage(p,offset,$('entry-sort').value);}catch(e){
  if(seq!==loadSequence)return;
  records=[];count=0;$('entry-count').textContent='—';$('entries').replaceChildren();
  const tr=elem('tr'),td=elem('td','내역을 불러오지 못했습니다. 위의 조회 버튼으로 다시 확인해주세요.','empty');td.colSpan=user?.role==='admin'?8:7;tr.append(td);$('entries').append(tr);
  $('summary-period').textContent='조회 실패 · 다시 조회해주세요.';$('page-label').textContent='조회 실패';$('prev').disabled=true;$('next').disabled=true;
  throw e;
 }
 if(seq!==loadSequence)return;
 records=data.entries;count=data.count;
 $('summary-period').textContent=p.from+' ~ '+p.to;
 renderFinance(data,p);
 data.summary.profit=data.summary.revenue-data.summary.spending;
 if(data.summary.fee_mode!=='manual'){data.summary.fee=null;data.summary.settlement=null;}
 for(const k of ['revenue','spending','profit','fee','expense','settlement'])$('sum-'+k).textContent=data.summary[k]==null?'미입력':money(data.summary[k]);
 const samePeriod=feePeriod?.from===p.from&&feePeriod?.to===p.to;
 const dirty=!feeReloadRequired&&samePeriod&&($('manual-fee').value!==$('manual-fee').dataset.saved||$('fee-method').value!==$('fee-method').dataset.saved);
 feeReady=data.summary.fee_mode==='manual';feePeriod=p;feeReloadRequired=false;
 if(!dirty){feeVersion=data.summary.fee_version||0;$('manual-fee').value=data.summary.fee??'';$('manual-fee').dataset.saved=$('manual-fee').value;$('fee-method').value=data.summary.fee_method||'withhold';$('fee-method').dataset.saved=$('fee-method').value;}
 $('fee-form').hidden=user.role!=='admin';$('manual-fee').disabled=!feeReady||!!data.summary.fee_settled;$('fee-method').disabled=$('manual-fee').disabled;
 $('save-fee').disabled=!feeReady||feeSaving||!!data.summary.fee_settled;
 $('fee-status').textContent=data.summary.fee_settled?'정산에서 이미 공제한 수수료입니다. 변경하려면 정산 처리를 먼저 취소해주세요.':!feeReady?'운영 수수료 수동 입력 기능의 서버 업데이트가 필요합니다.':dirty?'아직 저장하지 않은 입력값입니다.':data.summary.fee==null?'관리자가 운영 수수료를 입력하면 정산금액이 표시됩니다.':'';
 updateSortHeaders();$('entry-count').textContent=count;$('entries').replaceChildren();
 if(!records.length){const tr=elem('tr'),td=elem('td','이 기간에 기록된 내역이 없습니다.\n위에서 첫 매출 또는 지출을 등록해보세요.','empty');td.colSpan=user.role==='admin'?8:7;tr.append(td);$('entries').append(tr);}
 for(const r of records){
  const tr=elem('tr'),date=elem('td',r.entry_date);date.append(elem('small',r.author));const description=elem('td',r.description);if(r.recurring_id)description.append(elem('span','자동','automatic'));
  const kind=incomes.includes(r.category)?'income':expenses.includes(r.category)?'expense':'transfer',category=elem('td');category.append(elem('span',names[r.category]||r.category,'category-pill '+kind));
  const external=r.payment_source==='external',status=elem('td');status.append(elem('span',external?(r.settlement_id?'정산 완료':'미정산'):(r.entry_date>data.summary.bank_as_of?'반영 예정':'통장 반영'),'ledger-state '+(external&&!r.settlement_id?'unsettled':'')));if(r.transfer_date)status.append(elem('small',r.transfer_date));
  tr.append(date,description,category,elem('td',external?'다른 통장':'운영 통장'),elem('td',r.party_name||'—'),status,elem('td',new Intl.NumberFormat('ko-KR').format(r.amount),kind==='income'?'positive':kind==='expense'?'negative':'transfer-amount'));
  if(user.role==='admin'){const td=elem('td');if(r.recurring_id)td.append(elem('span','고정 지출','small muted'));else if(r.settlement_id)td.append(elem('span','정산 완료','small muted'));else td.append(button('수정',()=>editEntry(r)),button('삭제',async()=>{if(await confirmAction('내역 삭제',`${r.entry_date} · ${r.description} · ${money(r.amount)} 내역을 삭제하시겠습니까? 변경 이력에는 보관됩니다.`)){await api('delete_entry',{id:r.id,version:r.version});if(records.length===1&&offset>0)offset-=100;await loadLedger();await loadSuggestions();notice('내역을 삭제했습니다.');}}));tr.append(td);}$('entries').append(tr);
 }
 $('prev').disabled=offset===0;$('next').disabled=offset+100>=count;$('page-label').textContent=count?`${offset+1}–${Math.min(offset+100,count)} / ${count}건`:'0건';
}
function resetEntry({keepValues=false}={}){
 $('save-status').hidden=true;editing=null;
 if(!keepValues){requestId=crypto.randomUUID();lastSavedForm='';lastRequestedForm='';$('entry-form').reset();lastCategory='';$('entry-party').value=user?.id||'';$('entry-date').value=today();}
 $('entry-title').textContent='새 내역 기록';$('save-entry').textContent='내역 등록';$('cancel-edit').hidden=true;categoryHelp();
}
function categoryHelp(){
 const c=$('entry-category').value,kind=incomes.includes(c)?'income':expenses.includes(c)?'expense':'transfer';
 document.querySelector('.entry-panel').dataset.kind=kind;for(const k of ['income','expense','transfer'])$('entry-'+k).setAttribute('aria-pressed',String(k===kind));
 const flexible=['invoice','cash','expense','labor'].includes(c),funds=['operating_deposit','operating_withdrawal'].includes(c);
 if(lastCategory!==c){$('entry-source').value=flexible?'external':'main';lastCategory=c;}
 if(!flexible)$('entry-source').value='main';
 $('payment-source-label').hidden=!flexible;
 $('entry-party-label').hidden=!funds&&$('entry-source').value!=='external';
 $('entry-party-title').textContent=funds?(c==='operating_deposit'?'운영비를 입금한 사람':'운영비를 돌려받는 사람'):incomes.includes(c)?'매출을 받은 사람':'비용을 결제한 사람';
 $('entry-party').required=!$('entry-party-label').hidden;
 const text={spacecloud:'스페이스클라우드에서 운영 통장에 실제 입금된 금액을 기록하세요.',invoice:'매출을 받은 통장과 받은 사람을 선택하세요.',cash:'현금 매출을 받은 통장과 받은 사람을 선택하세요.',fixed:'운영 통장에서 결제한 월세·관리비·수리비 등을 기록하세요.',expense:'운영 통장 또는 다른 통장 중 실제 결제한 곳을 선택하세요.',labor:'청소·수리 등의 인건비입니다. 실제 결제한 곳을 선택하세요.',operating_deposit:'매출에 포함하지 않습니다. 입금한 사람의 반환할 운영비와 통장잔액이 증가합니다.',operating_withdrawal:'운영비를 입금했던 사람에게 돌려준 금액입니다. 반환할 운영비와 통장잔액이 줄어듭니다.',profit_withdrawal:'통장에서 가져간 수익입니다. 통장잔액에만 반영됩니다.',fee_withdrawal:'수수료를 통장에서 별도 지급한 경우에만 기록하세요. 정산금에서 공제했다면 다시 기록하지 마세요.'};
 $('category-help').textContent=text[c]||'';
 loadSuggestions();
}
async function loadSuggestions(){
 const seq=++suggestionSequence,expected=session,c=$('entry-category').value;$('description-chips').replaceChildren();$('entry-suggestions').replaceChildren();
 if(!user||user.status!=='active')return;
 try{const data=await api('description_suggestions',{category:c});if(seq!==suggestionSequence||session!==expected||!user)return;
  if(data.items?.length)$('description-chips').append(elem('span','자주 기록한 내용','small muted'));
  for(const item of data.items||[]){const o=elem('option');o.value=item.description;$('entry-suggestions').append(o);$('description-chips').append(button(item.description,()=>{$('entry-description').value=item.description;$('entry-description').focus();},'description-chip'));}
 }catch{} // Suggestions never block saving an entry.
}
function editEntry(r){editing=r;$('entry-date').value=r.entry_date;$('entry-category').value=r.category;lastCategory=r.category;$('entry-source').value=r.payment_source||(['invoice','cash','expense','labor'].includes(r.category)?'external':'main');$('entry-party').value=r.party_id||user.id;$('entry-description').value=r.description;$('entry-amount').value=r.amount;$('entry-title').textContent='내역 수정';$('save-entry').textContent='변경 저장';$('cancel-edit').hidden=false;categoryHelp();$('entry-form').scrollIntoView({behavior:'smooth',block:'center'});}
function renderFinance(data,p){
 financeData=data;const summary=data.summary,selected=$('entry-party').value||user.id;
 $('entry-party').replaceChildren();for(const person of data.parties||[{id:user.id,name:user.name}]){const o=elem('option',person.name);o.value=person.id;$('entry-party').append(o);}
 $('entry-party').value=Array.from($('entry-party').options).some(o=>o.value===selected)?selected:user.id;
 $('sum-pending-revenue').textContent=money(summary.pending_revenue||0);$('sum-pending-expense').textContent=money(summary.pending_expense||0);
 $('sum-operating-outstanding').textContent=money(summary.operating_outstanding||0);$('operating-funds').classList.toggle('has-outstanding',(summary.operating_outstanding||0)>0);
 $('operating-fund-people').replaceChildren();for(const person of data.operating_funds||[])$('operating-fund-people').append(elem('p',person.name+' · '+money(Math.abs(person.amount))+(person.amount<0?' 반환 초과':''),'small'));
 $('sum-bank-balance').textContent=summary.bank_balance==null?(summary.bank_configured?'기준일 이전':'기초잔액 미설정'):money(summary.bank_balance);
 $('bank-as-of').textContent=(summary.bank_as_of||p.to)+'까지 누적 · '+(summary.bank_opening_date||'2026-10-01')+'부터 계산';
 const bankDirty=$('bank-opening').dataset.saved!==undefined&&$('bank-opening').value!==$('bank-opening').dataset.saved;
 if(!bankDirty){$('bank-opening').value=summary.bank_configured?summary.bank_opening:'';$('bank-opening').dataset.saved=$('bank-opening').value;bankVersion=summary.bank_version||0;}
 bankReady=summary.bank_version!=null;$('save-bank').disabled=!bankReady;
 $('settlement-parties').replaceChildren();for(const q of data.settlement_parties||[]){
  if(!q.count&&!q.fee_id)continue;
  const card=elem('article',undefined,'settlement-person');card.append(elem('h3',q.name),elem('p',q.count+'건 · 매출 '+money(q.revenue)+' / 결제 비용 '+money(q.expense),'small muted'));
  if(q.fee_id)card.append(elem('p','수수료 공제 '+money(q.fee),'small muted'));
  card.append(elem('strong',money(Math.abs(q.amount))),elem('p',q.amount>0?q.name+' → 운영 통장':q.amount<0?'운영 통장 → '+q.name:'송금 없이 상계','settlement-direction'));
  const detail=elem('details'),label=elem('summary','포함 내역 보기');detail.append(label);for(const row of q.items||[])detail.append(elem('p',row.date+' · '+row.description+' · '+money(row.amount),'small muted'));card.append(detail);
  if(!q.fee_ready)card.append(elem('p','운영 수수료를 먼저 저장해주세요. 없으면 0원을 입력하세요.','small muted'));
  if(user.role==='admin'){const b=button('정산 처리',()=>openSettlement(q,p),'primary');b.disabled=!q.fee_ready;card.append(b);}else card.append(elem('p','관리자가 송금 완료 후 처리합니다.','small muted'));
  $('settlement-parties').append(card);
 }
 if(!$('settlement-parties').children.length)$('settlement-parties').append(elem('p','이 기간에 정산할 다른 통장 내역이 없습니다.','small muted'));
 $('settlement-history').replaceChildren();for(const item of data.settlements||[]){const row=elem('article',undefined,'settlement-history-row');row.append(elem('p',item.transfer_date+' · '+item.name+' · '+money(Math.abs(item.amount))+(item.amount>0?' 운영 통장 입금':item.amount<0?' 운영 통장 출금':' 상계'),'small'),elem('p',item.period_start+' ~ '+item.period_end+' 내역 정산','small muted'));
  if(user.role==='admin')row.append(button('기록 취소',async()=>{if(!await confirmAction('정산 기록 취소','실제 송금이 실행되지 않았거나 잘못 기록했을 때만 취소하세요. 연결된 내역이 미정산으로 돌아가고 이 송금 기록이 통장잔액에서 빠집니다. 실제 이체를 되돌리지는 않습니다.'))return;await api('cancel_settlement',{id:item.id});await loadLedger();notice('정산 기록을 취소했습니다.');}));$('settlement-history').append(row);
 }
 if(!$('settlement-history').children.length)$('settlement-history').append(elem('p','이 기간과 관련된 정산 기록이 없습니다.','small muted'));
}
function openSettlement(q,p){
 const current=period();if(current.from!==p.from||current.to!==p.to)throw Error('변경한 기간을 먼저 조회해주세요.');
 settlementDraft={q,p,id:crypto.randomUUID()};$('settlement-preview').replaceChildren(elem('p',p.from+' ~ '+p.to,'small muted'),elem('p',q.name+' · 미정산 '+q.count+'건'),elem('strong',money(Math.abs(q.amount))),elem('p',q.amount>0?q.name+' → 운영 통장':q.amount<0?'운영 통장 → '+q.name:'송금 없이 상계'));
 $('settlement-date').value=today();$('settlement-date').max=today();$('settlement-error').textContent='';$('settlement-dialog').showModal();
}
$('settlement-cancel').addEventListener('click',()=>$('settlement-dialog').close());
$('settlement-form').addEventListener('submit',e=>{e.preventDefault();busy($('settlement-save'),async()=>{
 const draft=settlementDraft,expected=session;if(!draft||user?.role!=='admin')return;$('settlement-error').textContent='';
 try{await api('settle',{...draft.p,id:draft.id,party_id:draft.q.party_id,date:$('settlement-date').value,fingerprint:draft.q.fingerprint});}
 catch(error){if(session===expected)$('settlement-error').textContent=error.message;return;}
 if(session!==expected)return;$('settlement-dialog').close();settlementDraft=null;
 try{await loadLedger();notice('정산 송금 기록을 저장하고 통장잔액에 반영했습니다.');}catch{notice('정산 기록은 저장되었습니다. 조회 버튼으로 목록을 다시 확인해주세요.',true);}
});});
$('bank-form').addEventListener('submit',e=>{e.preventDefault();busy($('save-bank'),async()=>{
 if(!bankReady||user?.role!=='admin')return;const raw=$('bank-opening').value,amount=Number(raw),expected=session;
 if(!raw.trim()||!Number.isSafeInteger(amount)||Math.abs(amount)>1e12)throw Error('기초잔액을 원 단위 정수로 입력해주세요.');
 const result=await api('save_bank_opening',{amount,version:bankVersion});if(session!==expected)return;bankVersion=result.version;$('bank-opening').dataset.saved=String(amount);
 try{await loadLedger();notice('기초잔액을 저장했습니다.');}catch{notice('기초잔액은 저장되었습니다. 조회 버튼으로 다시 확인해주세요.',true);}
});});
$('fee-method').addEventListener('change',()=>{$('fee-status').textContent='저장·반영을 누르면 지급 방식이 반영됩니다.';});
async function confirmAction(title,message){$('dialog-title').textContent=title;$('dialog-message').textContent=message;$('confirm-dialog').showModal();return new Promise(resolve=>{const d=$('confirm-dialog');$('dialog-confirm').onclick=()=>{d.returnValue='yes';d.close()};$('dialog-cancel').onclick=()=>{d.returnValue='no';d.close()};d.oncancel=()=>{d.returnValue='no'};d.onclose=()=>resolve(d.returnValue==='yes');});}
function switchTab(name){for(const v of ['ledger','recurring','membership','team','audit']){$(v+'-view').hidden=v!==name;$('tab-'+v).classList.toggle('active',v===name);}}
async function loadTeam(){const expected=session;const data=await api('people');if(session!==expected||user?.role!=='admin')return;$('people').replaceChildren();for(const p of data.people){const card=elem('article',undefined,'panel person');card.append(elem('h3',p.name),elem('p',p.username+' · '+(p.role==='admin'?'관리자':'운영자'),'muted small'),elem('span',statuses[p.status],'badge'));if(p.role==='operator'){const actions=elem('div',undefined,'actions');const change=(status,label)=>button(label,async()=>{if(await confirmAction(label,`${p.name} (${p.username}) 계정을 ${label}하시겠습니까?`)){await api('set_status',{id:p.id,status});await loadTeam();notice('계정 상태를 변경했습니다.');}},status==='active'?'primary':'secondary');if(p.status==='pending'){actions.append(change('active','승인'),change('rejected','거절'));}else if(p.status==='active'){actions.append(change('suspended','접근 중지'));}else{actions.append(change('active','다시 승인'));}card.append(actions);}$('people').append(card);}
 $('links').replaceChildren();for(const l of data.links){const row=elem('div',undefined,'link-row'),status=l.used_at?'사용 완료':l.revoked_at?'취소됨':new Date(l.expires_at)<new Date()?'만료됨':'사용 가능';row.append(elem('p',`${status} · 만료 ${time(l.expires_at)}`,'small muted'));if(status==='사용 가능')row.append(button('링크 취소',async()=>{if(await confirmAction('초대 취소','전달한 링크로 더 이상 가입할 수 없게 됩니다.')){await api('revoke_invite',{id:l.id});await loadTeam();}}));$('links').append(row);}if(!data.links.length)$('links').append(elem('p','발급한 초대 링크가 없습니다.','muted small'));
}
async function loadAudit(){const expected=session;const data=await api('audit');if(session!==expected||user?.role!=='admin')return;$('audit-list').replaceChildren();const titles={ledger_reset:'정산 내역 초기화',ledger_restored:'정산 내역 복구',entry_created:'내역 등록',entry_updated:'내역 수정',entry_deleted:'내역 삭제',bank_opening_saved:'통장 기초잔액 설정',settlement_saved:'정산 송금 기록',settlement_cancelled:'정산 기록 취소',account_created:'계정 생성',status_changed:'계정 상태 변경',invite_created:'운영자 초대 발급',name_updated:'닉네임 변경',recurring_saved:'고정 지출 저장',recurring_deleted:'고정 지출 삭제',member_joined:'멤버십 가입',member_changed:'멤버십 정보 변경',member_deleted:'멤버십 삭제',spacecloud_sync_enabled:'스클 자동 연동 설정',spacecloud_sync_retry:'스클 연동 재요청',coupon_issued:'특별쿠폰 발급',booking_status:'멤버십 예약 상태 변경',profit_saved:'이전 순수익 입력',fee_saved:'운영 수수료 저장'};for(const a of data.audit){const row=elem('article',undefined,'audit-row'),main=elem('div');main.append(elem('p',`${a.actor||'관리자'} · ${titles[a.action]||a.action}`));if(a.before_data||a.after_data){const detail=elem('details'),summary=elem('summary','변경 내용 보기','small muted');detail.append(summary);for(const [label,d] of [['변경 전',a.before_data],['변경 후',a.after_data]])if(d){const parts=[];if(d.starts_on)parts.push(d.starts_on+'부터 새 정산 시작');if(d.entries!==undefined)parts.push('매출·지출 '+d.entries+'건', '수수료 '+d.fees+'건', '고정 지출 '+d.recurring+'건');if(d.entry_date)parts.push(d.entry_date,names[d.category],d.description,money(d.amount));if(d.starts_at)parts.push(time(d.starts_at)+' ~ '+time(d.ends_at));if(d.tier)parts.push(d.tier==='crew'?'크루':'프렌즈');if(d.start_month)parts.push(d.description,names[d.category],money(d.amount),d.start_month.slice(0,7)+' ~ '+(d.end_month?.slice(0,7)||'계속'));if(d.period_start)parts.push(d.period_start+' ~ '+d.period_end,money(d.amount));if(d.status)parts.push(statuses[d.status]||({requested:'예약 요청',awaiting_payment:'입금 대기',confirmed:'예약 확정',rejected:'거절',cancelled:'취소'}[d.status])||d.status);if(d.username)parts.push(d.username);if(d.name)parts.push(d.name);if(typeof d.enabled==='boolean')parts.push(d.enabled?'자동 연동 켜짐':'자동 연동 꺼짐');detail.append(elem('pre',label+' : '+parts.join(' · ')));}main.append(detail);}row.append(main,elem('time',time(a.created_at)));$('audit-list').append(row);}if(!data.audit.length)$('audit-list').append(elem('p','변경 이력이 없습니다.','muted'));
}
$('auth-form').addEventListener('submit',e=>{e.preventDefault();busy($('auth-submit'),async()=>{
 const username=$('auth-username').value.trim().toLowerCase(),password=$('auth-password').value;
 if(linkToken){if(password!==$('auth-confirm').value)throw Error('비밀번호 확인이 일치하지 않습니다.');const r=await api('register',{username,password,name:$('auth-name').value,linkToken});sessionStorage.removeItem('ss-admin-link');linkToken='';linkKind='';$('auth-password').value='';$('auth-confirm').value='';configureLogin();notice(r.status==='active'?'관리자 계정이 준비되었습니다. 로그인해주세요.':'가입 신청이 완료되었습니다. 로그인하면 승인 상태를 확인할 수 있습니다.');return;}
 const data=await api('login',{username,password});session=data.sessionToken;storeSession(session);if($('remember').checked)localStorage.setItem('ss-admin-username',username);else localStorage.removeItem('ss-admin-username');$('auth-password').value='';await enter();
 });});
function saveStatus(message,state=''){$('save-status').textContent=message;$('save-status').className='small muted save-status '+state;$('save-status').hidden=false;}
async function submitEntry(){
 const amount=Number($('entry-amount').value),date=$('entry-date').value;
 if(!Number.isSafeInteger(amount)||amount<=0)throw Error('금액은 1원 이상의 정수로 입력해주세요.');
 const payment_source=$('entry-source').value,party_id=$('entry-party-label').hidden?null:$('entry-party').value;
 if(!$('entry-party-label').hidden&&!party_id)throw Error('담당자를 선택해주세요.');
 const formKey=JSON.stringify([date,$('entry-category').value,$('entry-description').value.trim(),amount,payment_source,party_id]);
 if(!editing&&formKey===lastSavedForm){saveStatus('이미 저장한 내역입니다. 다음 내역에 맞게 입력값을 변경해주세요.','success');return;}
 // Reuse the key for an uncertain retry, but give each changed new entry a fresh key.
 if(!editing&&formKey!==lastRequestedForm)requestId=crypto.randomUUID();
 lastRequestedForm=formKey;
 const expectedSession=session;
 saveStatus('저장 중입니다…');
 try{
  const result=await api('save_entry',{payment_source,party_id,id:editing?.id,version:editing?.version,date,category:$('entry-category').value,description:$('entry-description').value,amount,request_id:requestId});
  if(!result?.id)throw Error('서버의 저장 결과를 확인하지 못했습니다.');
 }catch(e){
  if(session===expectedSession)saveStatus('저장 완료를 확인하지 못했습니다. 입력 내용은 유지됩니다.\n'+e.message,'error');
  throw e;
 }
 if(session!==expectedSession)return;
 // A successful write is independent of the following read. Do not suggest resubmitting it.
 lastSavedForm=formKey;resetEntry({keepValues:true});offset=0;
 if(!$('from').value||!$('to').value||date<$('from').value||date>$('to').value||$('from').value>$('to').value){$('month').value=settlementMonth(date);setMonth();}
 saveStatus(`${date} 내역을 저장했습니다. 목록을 갱신하고 있습니다.`,'success');
 try{await loadLedger();if(session===expectedSession){saveStatus(`${date} 내역을 저장했습니다.`,'success');notice('내역을 저장했습니다.');}}
 catch(e){if(session===expectedSession){saveStatus('내역은 저장되었지만 목록을 불러오지 못했습니다. 다시 등록하지 말고 조회 버튼을 눌러주세요.\n'+e.message,'error');notice('저장은 완료되었습니다. 목록 조회를 다시 시도해주세요.',true);}}
}
async function submitFee(){
 if(feeSaving||!feeReady||user?.role!=='admin')return;
 const p=period(),expectedSession=session;
 if(p.from!==feePeriod?.from||p.to!==feePeriod?.to)throw Error('변경한 기간을 먼저 조회해주세요.');
 const raw=$('manual-fee').value,amount=Number(raw);
 if(!raw.trim()||!Number.isSafeInteger(amount)||Math.abs(amount)>1e12)throw Error('운영 수수료를 원 단위 정수로 입력해주세요.');
 feeSaving=true;$('save-fee').disabled=true;$('fee-status').textContent='저장 중입니다…';
 try{
  const result=await api('save_fee',{...p,amount,version:feeVersion,payment_method:$('fee-method').value});
  if(session!==expectedSession)return;
  if(feePeriod?.from===p.from&&feePeriod?.to===p.to){feeVersion=result.version;$('manual-fee').dataset.saved=String(amount);}
  try{await loadLedger();if(session===expectedSession)notice('운영 수수료를 저장하고 정산금액을 반영했습니다.');}
  catch(e){if(session===expectedSession)$('fee-status').textContent='운영 수수료는 저장되었습니다. 조회 버튼을 눌러 계산 결과를 확인해주세요.';}
 }catch(e){if(session===expectedSession){feeReloadRequired=true;$('fee-status').textContent='저장 완료를 확인하지 못했습니다. 입력값을 메모한 뒤 다시 조회해주세요.\n'+e.message;notice(e.message,true);}}
 finally{feeSaving=false;$('save-fee').disabled=!feeReady||!!financeData?.summary.fee_settled;}
}
$('fee-form').addEventListener('submit',e=>{e.preventDefault();submitFee().catch(e=>notice(e.message,true));});
$('manual-fee').addEventListener('input',()=>{$('fee-status').textContent='저장·반영을 누르면 정산금액이 다시 계산됩니다.';});
$('entry-form').addEventListener('submit',e=>{e.preventDefault();busy($('save-entry'),submitEntry);});
function updateSortHeaders(){
 const value=$('entry-sort').value,[key,dir]=['asc','desc'].includes(value)?['date',value]:value.split(':');
 document.querySelectorAll('th[aria-sort]').forEach(th=>th.setAttribute('aria-sort','none'));
 document.querySelectorAll('[data-sort-key]').forEach(b=>{const active=b.dataset.sortKey===key;b.setAttribute('aria-pressed',String(active));if(active)b.closest('th').setAttribute('aria-sort',dir==='asc'?'ascending':'descending');});
}
document.querySelectorAll('[data-sort-key]').forEach(b=>b.addEventListener('click',()=>{
 const key=b.dataset.sortKey,value=$('entry-sort').value,[oldKey,oldDir]=['asc','desc'].includes(value)?['date',value]:value.split(':');
 const dir=key===oldKey?(oldDir==='asc'?'desc':'asc'):['author','description'].includes(key)?'asc':'desc';
 $('entry-sort').value=key==='date'?dir:key+':'+dir;$('entry-sort').dispatchEvent(new Event('change'));
}));
window.addEventListener('storage',e=>{if(e.key!=='ss-admin-session'||e.newValue===session)return;session=e.newValue||'';if(!session)showAuth();else enter().catch(e=>notice(e.message,true));});
$('entry-sort').addEventListener('change',()=>{offset=0;sessionStorage.setItem('ss-admin-sort',$('entry-sort').value);loadLedger().catch(e=>notice(e.message,true));});
$('entry-category').addEventListener('change',categoryHelp);$('entry-source').addEventListener('change',categoryHelp);$('cancel-edit').addEventListener('click',resetEntry);
for(const [suffix,delta] of [['prev',-1],['next',1]])$('month-'+suffix).addEventListener('click',()=>{const [y,m]=$('month').value.split('-').map(Number);$('month').value=monthKey(y,m+delta);$('month').dispatchEvent(new Event('change'));});
$('month').addEventListener('change',()=>{setMonth();offset=0;busy($('load-period'),loadLedger)});
for(const kind of ['income','expense','transfer'])$('entry-'+kind).addEventListener('click',()=>{const c=$('entry-category').value,current=incomes.includes(c)?'income':expenses.includes(c)?'expense':'transfer';if(kind==='transfer'&&user?.role!=='admin')return;if(current!==kind)$('entry-category').value=kind==='income'?'spacecloud':kind==='expense'?(user?.role==='admin'?'expense':'fixed'):'operating_deposit';categoryHelp();$('entry-amount').focus();});
$('load-period').addEventListener('click',()=>{offset=0;busy($('load-period'),loadLedger)});
$('prev').addEventListener('click',()=>{offset=Math.max(0,offset-100);busy($('prev'),loadLedger)});
$('next').addEventListener('click',()=>{offset+=100;busy($('next'),loadLedger)});
$('edit-nickname').addEventListener('click',()=>{$('nickname-input').value=user.name;$('nickname-error').textContent='';$('nickname-dialog').showModal();});
$('nickname-cancel').addEventListener('click',()=>$('nickname-dialog').close());
$('nickname-form').addEventListener('submit',e=>{e.preventDefault();busy($('nickname-save'),async()=>{
 const expected=session;$('nickname-error').textContent='';
 try{const result=await api('update_name',{name:$('nickname-input').value});if(session!==expected)return;user.name=result.name;showAccount();$('nickname-dialog').close();notice('닉네임을 변경했습니다.');}
 catch(e){$('nickname-error').textContent=e.message;return;}
 if(user.status==='active'&&!$('ledger-view').hidden)await loadLedger().catch(()=>notice('닉네임은 저장되었습니다. 목록은 다시 조회해주세요.'));
});});
$('logout').addEventListener('click',()=>busy($('logout'),async()=>{try{await api('logout')}finally{session='';storeSession('');$('auth-password').value='';showAuth();}}));
$('check-status').addEventListener('click',()=>busy($('check-status'),async()=>{await enter();if(user.status==='pending')notice('아직 승인 대기 중입니다.');}));
$('tab-ledger').addEventListener('click',()=>{switchTab('ledger');busy($('load-period'),loadLedger)});
$('tab-membership').addEventListener('click',()=>busy($('tab-membership'),async()=>{const expected=session;const {mountMembershipAdmin}=await import('./membership-admin.js?v=spaces1');if(session!==expected||user?.role!=='admin')return;if(!membershipAdmin)membershipAdmin=mountMembershipAdmin($('membership-view'),api,notice);switchTab('membership');await membershipAdmin.load();}));
setInterval(()=>{if(user?.role==='admin'&&!document.hidden)api('member_home').then(d=>{if(user?.role==='admin')$('tab-membership').textContent='멤버십 관리'+((d.pending||d.pending_members)?' (예약 '+(d.pending||0)+' · 가입 '+(d.pending_members||0)+')':'');}).catch(()=>{});},60000);
$('tab-team').addEventListener('click',()=>busy($('tab-team'),async()=>{await loadTeam();switchTab('team')}));
$('tab-audit').addEventListener('click',()=>busy($('tab-audit'),async()=>{await loadAudit();switchTab('audit')}));
$('create-invite').addEventListener('click',()=>busy($('create-invite'),async()=>{const result=await api('create_invite');$('invite-url').value=result.url;$('invite-result').hidden=false;await loadTeam();}));
$('copy-invite').addEventListener('click',()=>busy($('copy-invite'),async()=>{try{await navigator.clipboard.writeText($('invite-url').value);notice('가입 링크를 복사했습니다. 카카오톡으로 직접 전달해주세요.');}catch{$('invite-url').select();notice('링크를 선택했습니다. 복사해서 전달해주세요.');}}));
function configureLogin(){for(const id of ['name-label','confirm-label','password-guide'])$(id).hidden=true;$('auth-name').required=false;$('auth-confirm').required=false;$('remember-label').hidden=false;$('auth-username').readOnly=false;$('auth-password').autocomplete='current-password';$('auth-password').removeAttribute('minlength');$('auth-title').textContent='관리자 모드 로그인';$('auth-description').textContent='등록한 아이디와 비밀번호를 입력해주세요.';$('auth-submit').textContent='로그인';$('auth-foot').hidden=false;}

function resetRecurring(){recurringEdit=null;recurringRequestId=crypto.randomUUID();$('recurring-form').reset();$('recurring-start').value=settlementMonth(today());$('recurring-title').textContent='고정 지출 등록';$('recurring-save').textContent='등록·자동 반영';$('recurring-cancel').hidden=true;}
function editRecurring(r){recurringEdit=r;$('recurring-description').value=r.description;$('recurring-category').value=r.category;$('recurring-amount').value=r.amount;$('recurring-start').value=r.start_month.slice(0,7);$('recurring-end').value=r.end_month?.slice(0,7)||'';$('recurring-title').textContent='고정 지출 수정';$('recurring-save').textContent='수정·반영';$('recurring-cancel').hidden=false;$('recurring-description').focus();}
async function loadRecurring(){
 const expected=session;let data;
 try{data=await api('recurring_list');}catch(e){if(session===expected)$('recurring-list').textContent='고정 지출을 불러오지 못했습니다. 서버 업데이트 후 다시 확인해주세요.';throw e;}
 if(session!==expected||!user)return;
 $('recurring-list').replaceChildren();
 for(const r of data.items){const card=elem('article',undefined,'recurring-item'),body=elem('div');body.append(elem('h3',r.description),elem('p',names[r.category]+' · 매월 '+money(r.amount)),elem('p',r.start_month.slice(0,7)+' ~ '+(r.end_month?.slice(0,7)||'계속 적용'),'small muted'));card.append(body);
  if(user.role==='admin'){const actions=elem('div',undefined,'actions');actions.append(button('수정',()=>editRecurring(r)),button('삭제',async()=>{if(!await confirmAction('고정 지출 삭제',r.description+'의 모든 자동 반영 내역이 과거 정산에서도 제외됩니다. 앞으로만 중단하려면 수정에서 종료월을 지정해주세요. 삭제하시겠습니까?'))return;await api('recurring_delete',{id:r.id,version:r.version});if(recurringEdit?.id===r.id)resetRecurring();notice('고정 지출을 삭제했습니다.');await loadRecurring();}));card.append(actions);}
  $('recurring-list').append(card);
 }
 if(!data.items.length)$('recurring-list').append(elem('p','등록한 고정 지출이 없습니다.','muted'));
}
$('tab-recurring').addEventListener('click',()=>{switchTab('recurring');busy($('tab-recurring'),loadRecurring);});
$('recurring-cancel').addEventListener('click',resetRecurring);
$('recurring-form').addEventListener('submit',e=>{e.preventDefault();busy($('recurring-save'),async()=>{
 const start=$('recurring-start').value,end=$('recurring-end').value;
 if(!start||end&&end<start)throw Error('종료월은 시작월 이후로 지정해주세요.');
 if(recurringEdit&&!await confirmAction('고정 지출 수정','설정한 적용 기간의 과거·현재 정산이 다시 계산됩니다. 수정 내용을 반영하시겠습니까?'))return;
 const expected=session;
 await api('recurring_save',{id:recurringEdit?.id||recurringRequestId,version:recurringEdit?.version||0,description:$('recurring-description').value.trim(),category:$('recurring-category').value,amount:Number($('recurring-amount').value),start_month:start+'-01',end_month:end?end+'-01':null});
 if(session!==expected)return;
 resetRecurring();notice('저장했습니다. 적용 기간의 정산에 자동 반영됩니다.');await loadRecurring();
});});

async function init(){
 const savedSort=sessionStorage.getItem('ss-admin-sort');$('entry-sort').value=Array.from($('entry-sort').options).some(o=>o.value===savedSort)?savedSort:'desc';updateSortHeaders();
 $('month').value=settlementMonth(today());setMonth();$('entry-date').value=today();categoryHelp();$('auth-username').value=localStorage.getItem('ss-admin-username')||'';$('remember').checked=!!$('auth-username').value;
 const hash=new URLSearchParams(location.hash.slice(1)),incoming=hash.get('setup')||hash.get('invite');if(incoming){sessionStorage.setItem('ss-admin-link',incoming);history.replaceState(null,'',location.pathname);}
 linkToken=sessionStorage.getItem('ss-admin-link')||'';
 if(linkToken){showAuth();$('auth-submit').disabled=true;try{const info=await api('link_info',{linkToken});linkKind=info.kind;for(const id of ['name-label','confirm-label','password-guide'])$(id).hidden=false;$('auth-name').required=true;$('auth-confirm').required=true;$('remember-label').hidden=true;$('auth-password').minLength=8;$('auth-password').autocomplete='new-password';$('auth-foot').hidden=true;$('auth-eyebrow').textContent=linkKind==='bootstrap'?'FIRST SETUP':'YOU ARE INVITED';$('auth-title').textContent=linkKind==='bootstrap'?'관리자 계정 설정':'운영자 가입 신청';$('auth-description').textContent=linkKind==='bootstrap'?'slowsix 계정의 비밀번호를 직접 설정해주세요.':'가입 후 관리자의 승인을 기다려주세요.';$('auth-submit').textContent=linkKind==='bootstrap'?'관리자 계정 만들기':'가입 신청';if(linkKind==='bootstrap'){$('auth-username').value='slowsix';$('auth-username').readOnly=true;}}catch(e){sessionStorage.removeItem('ss-admin-link');linkToken='';configureLogin();notice(e.message,true);}finally{$('auth-submit').disabled=false;}}
 else if(session){try{await enter()}catch(e){notice(e.message,true)}}
}
init();
