import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('admin.html',root),'utf8');
const code=await readFile(new URL('assets/admin.js',root),'utf8');
const until=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI did not reach expected state');};
async function screen(currentDate,role="admin",legacy=false,timeoutUnsupported=false,blockExternal=false,options={}){
 const dom=new JSDOM(html,{url:'https://slowsixon.com/admin.html',runScripts:'outside-only'}),w=dom.window;
 const calls=[],stored=[],recurring=[],fees=new Map();let failSave=false,failList=false,displayName='테스트 관리자';
 if(currentDate){const RealFormat=w.Intl.DateTimeFormat;w.Intl.DateTimeFormat=function(locale,options){return locale==='sv-SE'?{format:()=>currentDate}:new RealFormat(locale,options);};}
 w.crypto.randomUUID=randomUUID;w.AbortSignal=timeoutUnsupported?{}:AbortSignal;if(!options.noTabSession)w.sessionStorage.setItem('ss-admin-session','test-session');if(options.persisted)w.localStorage.setItem('ss-admin-session',options.persisted);
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 w.fetch=async(url,opts)=>{
  if(blockExternal&&new URL(url,w.location.href).origin!==w.location.origin)throw new TypeError("External auth host unavailable");
  const b=JSON.parse(opts.body);calls.push(b);let data;
  if(b.action==='me')data={id:randomUUID(),name:displayName,username:'slowsix',role,status:'active'};
  else if(b.action==='recurring_list')data={items:recurring};
  else if(b.action==='recurring_save'){recurring.push({...b,version:1});data={id:b.id};}
  else if(b.action==='logout')data={};
  else if(b.action==='update_name'){displayName=b.name.trim();data={name:displayName};}
  else if(b.action==='save_entry'){
   if(failSave)return new Response(JSON.stringify({error:'입력값을 확인해주세요.',code:'INVALID_ENTRY'}),{status:400});
   if(!stored.some(r=>r.request_id===b.request_id))stored.push({id:randomUUID(),entry_date:b.date,description:b.description,amount:b.amount,category:b.category,author:'테스트 관리자',request_id:b.request_id});
   data={id:stored.find(r=>r.request_id===b.request_id).id};
  }else if(b.action==='save_fee'){
   if(failSave)return new Response(JSON.stringify({error:'저장 오류',code:'INVALID_ENTRY'}),{status:400});
   const version=(fees.get(b.from+'|'+b.to)?.version||0)+1;fees.set(b.from+'|'+b.to,{amount:b.amount,version});data={version};
  }else if(b.action==='list'){
   if(failList)throw Error('network interrupted');
   const all=stored.filter(r=>r.entry_date>=b.from&&r.entry_date<=b.to).sort((a,b)=>b.entry_date.localeCompare(a.entry_date)||String(b.created_at||'').localeCompare(String(a.created_at||''))||a.id.localeCompare(b.id));const entries=all.slice(b.offset,b.offset+100);data={entries,count:all.length,summary:legacy?{revenue:0,spending:0,profit:0,fee:0,settlement:0}:{revenue:0,spending:0,fee_mode:'manual',fee_version:fees.get(b.from+'|'+b.to)?.version||0,profit:0,fee:fees.get(b.from+'|'+b.to)?.amount??null,settlement:fees.has(b.from+'|'+b.to)?-fees.get(b.from+'|'+b.to).amount:null}};
  }else throw Error('unexpected action '+b.action);
  if(b.action==='list'){data.summary.expense=stored.filter(r=>r.category==='expense'&&r.entry_date>=b.from&&r.entry_date<=b.to).reduce((n,r)=>n+r.amount,0);if(options.modernSort)data.sort_supported=true;}
  return new Response(JSON.stringify(data),{status:200});
 };
 w.eval(code);const $=id=>w.document.getElementById(id);
 await until(()=>$('page-label').textContent==='0건');
 const submit=async()=>{$('entry-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!$('save-entry').disabled);};
 const fill=()=>{$('month').value='2026-08';$('from').value='2026-08-12';$('to').value='2026-09-11';$('entry-date').value='2026-09-14';$('entry-description').value='9월 입금';$('entry-amount').value='100000';};
 return{dom,w,$,calls,stored,submit,fill,setFailSave:x=>failSave=x,setFailList:x=>failList=x};
}
test('saving outside the viewed period switches to saved month and displays the entry',async()=>{
 const h=await screen();try{h.fill();await h.submit();assert.equal(h.$('month').value,'2026-09');assert.equal(h.$('from').value,'2026-09-12');assert.equal(h.$('to').value,'2026-10-11');assert.equal(h.$('entry-count').textContent,'1');assert.match(h.$('entries').textContent,/9월 입금/);assert.match(h.$('save-status').textContent,/저장했습니다/);}finally{h.dom.window.close();}
});
test('successful save with failed refresh states saved and does not submit again',async()=>{
 const h=await screen();try{h.fill();h.setFailList(true);await h.submit();assert.equal(h.stored.length,1);assert.equal(h.$('entry-description').value,'9월 입금');assert.match(h.$('save-status').textContent,/내역은 저장되었지만/);assert.match(h.$('entries').textContent,/불러오지 못했습니다/);assert.equal(h.$('entry-count').textContent,'—');h.setFailList(false);h.$('load-period').click();await until(()=>h.$('entry-count').textContent==='1');assert.equal(h.calls.filter(c=>c.action==='save_entry').length,1);}finally{h.dom.window.close();}
});
test('failed save retains form and same idempotency key for retry',async()=>{
 const h=await screen();try{h.fill();h.setFailSave(true);await h.submit();assert.equal(h.stored.length,0);assert.equal(h.$('entry-amount').value,'100000');assert.equal(h.$('entry-description').value,'9월 입금');assert.match(h.$('save-status').textContent,/입력값을 확인/);const id=h.calls.find(c=>c.action==='save_entry').request_id;h.setFailSave(false);await h.submit();assert.equal(h.stored.length,1);assert.equal(h.calls.filter(c=>c.action==='save_entry').at(-1).request_id,id);}finally{h.dom.window.close();}
});

for(const [day,month,from,to] of [
 ['2026-09-11','2026-08','2026-08-12','2026-09-11'],
 ['2026-09-12','2026-09','2026-09-12','2026-10-11'],
 ['2027-01-01','2026-12','2026-12-12','2027-01-11'],
 ['2024-02-29','2024-02','2024-02-12','2024-03-11'],
])test(`initial settlement period contains ${day}`,async()=>{
 const h=await screen(day);try{assert.equal(h.$('month').value,month);assert.equal(h.$('from').value,from);assert.equal(h.$('to').value,to);}finally{h.dom.window.close();}
});
test('saving an 11th-day entry moves to previous month settlement',async()=>{
 const h=await screen('2026-09-14');try{h.fill();h.$('month').value='2026-09';h.$('from').value='2026-09-12';h.$('to').value='2026-10-11';h.$('entry-date').value='2026-09-11';await h.submit();assert.equal(h.$('month').value,'2026-08');assert.equal(h.$('from').value,'2026-08-12');assert.equal(h.$('to').value,'2026-09-11');assert.equal(h.$('entry-count').textContent,'1');}finally{h.dom.window.close();}
});
test('changing the settlement month handles December to January',async()=>{
 const h=await screen('2026-09-14');try{h.$('month').value='2026-12';h.$('month').dispatchEvent(new h.w.Event('change'));await until(()=>!h.$('load-period').disabled);assert.equal(h.$('from').value,'2026-12-12');assert.equal(h.$('to').value,'2027-01-11');assert.equal(h.calls.at(-1).to,'2027-01-11');}finally{h.dom.window.close();}
});

test('date sorting orders the whole period across pages and resets to page one',async()=>{
 const h=await screen('2026-09-14');
 try{
  for(let i=0;i<205;i++){const date=new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);h.stored.push({id:randomUUID(),entry_date:date,created_at:date+'T12:00:00Z',description:'정렬 검증 '+i,category:'cash',amount:i+1,author:'관리자'});}
  h.$('from').value='2026-01-01';h.$('to').value='2026-12-31';h.$('load-period').click();await until(()=>h.$('entry-count').textContent==='205');
  const dates=()=>Array.from(h.$('entries').querySelectorAll('tr'),r=>r.cells[0].firstChild.textContent);
  assert.equal(dates()[0],h.stored[204].entry_date);
  h.$('next').click();await until(()=>h.$('page-label').textContent.startsWith('101–'));
  assert.equal(dates()[0],h.stored[104].entry_date);
  const summary=h.$('sum-revenue').textContent;
  h.$('entry-sort').value='asc';h.$('entry-sort').dispatchEvent(new h.w.Event('change'));
  await until(()=>h.$('page-label').textContent.startsWith('1–')&&dates()[0]==='2026-01-01');
  assert.equal(dates()[99],h.stored[99].entry_date);assert.equal(h.$('sum-revenue').textContent,summary);
  assert.equal(h.w.sessionStorage.getItem('ss-admin-sort'),'asc');
  h.$('next').click();await until(()=>h.$('page-label').textContent.startsWith('101–'));
  assert.equal(dates()[0],h.stored[100].entry_date);assert.equal(dates()[99],h.stored[199].entry_date);
  h.$('next').click();await until(()=>h.$('page-label').textContent.startsWith('201–'));
  assert.deepEqual(dates(),h.stored.slice(200).map(r=>r.entry_date));assert.equal(h.$('next').disabled,true);
  h.$('entry-sort').value='desc';h.$('entry-sort').dispatchEvent(new h.w.Event('change'));
  await until(()=>h.$('page-label').textContent.startsWith('1–')&&dates()[0]===h.stored[204].entry_date);
  assert.equal(h.$('sum-revenue').textContent,summary);
 }finally{h.dom.window.close();}
});
test('oldest sort is stable for same-day entries and handles exactly 100 rows',async()=>{
 const h=await screen('2026-09-14');try{
  for(let i=0;i<100;i++)h.stored.push({id:String(i).padStart(4,'0'),entry_date:'2026-09-14',created_at:'2026-09-14T12:00:00Z',description:'동일 날짜 '+i,category:'cash',amount:1,author:'관리자'});
  h.$('entry-sort').value='asc';h.$('entry-sort').dispatchEvent(new h.w.Event('change'));await until(()=>h.$('entry-count').textContent==='100');
  const descriptions=()=>Array.from(h.$('entries').querySelectorAll('tr'),r=>r.cells[1].textContent);
  assert.equal(descriptions()[0],'동일 날짜 99');assert.equal(descriptions()[99],'동일 날짜 0');assert.equal(h.$('next').disabled,true);
  h.$('load-period').click();await until(()=>!h.$('load-period').disabled);assert.equal(descriptions()[0],'동일 날짜 99');
 }finally{h.dom.window.close();}
});

test('save retains every input and only changed entries create another record',async()=>{
 const h=await screen('2026-09-14');try{
  h.fill();h.$('entry-category').value='fixed';
  await h.submit();
  assert.equal(h.$('entry-date').value,'2026-09-14');assert.equal(h.$('entry-category').value,'fixed');assert.equal(h.$('entry-amount').value,'100000');assert.equal(h.$('entry-description').value,'9월 입금');
  const firstKey=h.calls.filter(c=>c.action==='save_entry').at(-1).request_id;
  await h.submit();assert.equal(h.stored.length,1);assert.equal(h.calls.filter(c=>c.action==='save_entry').length,1);assert.match(h.$('save-status').textContent,/이미 저장한/);
  h.$('entry-description').value='9월 추가 관리비';h.$('entry-amount').value='30000';await h.submit();
  assert.equal(h.stored.length,2);assert.notEqual(h.calls.filter(c=>c.action==='save_entry').at(-1).request_id,firstKey);
  assert.equal(h.$('entry-category').value,'fixed');assert.equal(h.$('entry-date').value,'2026-09-14');assert.equal(h.$('entry-amount').value,'30000');assert.equal(h.$('entry-description').value,'9월 추가 관리비');
 }finally{h.dom.window.close();}
});

test('manual fee saves and recalculates, survives refresh, and separates periods',async()=>{
 const h=await screen('2026-09-14');try{
  assert.equal(h.$('sum-profit').textContent,'0원');assert.equal(h.$('fee-form').hidden,false);
  h.$('manual-fee').value='200000';h.$('fee-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await until(()=>h.$('sum-fee').textContent==='200,000원');assert.equal(h.$('sum-settlement').textContent,'-200,000원');
  h.$('load-period').click();await until(()=>!h.$('load-period').disabled);assert.equal(h.$('manual-fee').value,'200000');
  h.$('month').value='2026-08';h.$('month').dispatchEvent(new h.w.Event('change'));await until(()=>!h.$('load-period').disabled);
  assert.equal(h.$('manual-fee').value,'');assert.equal(h.$('sum-fee').textContent,'미입력');
  h.$('manual-fee').value='0';h.$('fee-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.$('sum-fee').textContent==='0원');
 }finally{h.dom.window.close();}
});
test('manual fee blocks unqueried date changes, preserves failed input, and requires backend support',async()=>{
 const h=await screen('2026-09-14');try{
  h.$('manual-fee').value='100';h.$('from').value='2026-09-13';h.$('fee-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.$('notice').textContent.includes('먼저 조회'));
  assert.equal(h.calls.filter(c=>c.action==='save_fee').length,0);
  h.$('from').value='2026-09-12';h.setFailSave(true);h.$('fee-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.$('fee-status').textContent.includes('저장 완료를 확인하지'));
  assert.equal(h.$('manual-fee').value,'100');assert.equal(h.$('sum-fee').textContent,'미입력');
 }finally{h.dom.window.close();}
 const old=await screen('2026-09-14','admin',true);try{assert.equal(old.$('save-fee').disabled,true);assert.match(old.$('fee-status').textContent,/서버 업데이트/);}finally{old.dom.window.close();}
 const op=await screen('2026-09-14','operator');try{assert.equal(op.$('fee-form').hidden,true);}finally{op.dom.window.close();}
});

test('browsers without AbortSignal.timeout can load and save ledger entries',async()=>{
 const h=await screen('2026-09-14','admin',false,true);try{
  assert.equal(h.$('dashboard').hidden,false);h.fill();await h.submit();
  assert.equal(h.stored.length,1);assert.match(h.$('save-status').textContent,/저장했습니다/);
 }finally{h.dom.window.close();}
});

test('login session and saves work when direct external auth connections are unavailable',async()=>{
 const h=await screen('2026-09-14','admin',false,false,true);try{
  assert.equal(h.$('dashboard').hidden,false);h.fill();await h.submit();
  assert.equal(h.stored.length,1);assert.match(h.$('save-status').textContent,/저장했습니다/);
 }finally{h.dom.window.close();}
});

test('session migrates to persistent storage and survives a new browser context until logout',async()=>{
 const first=await screen('2026-09-15');let token;try{token=first.w.localStorage.getItem('ss-admin-session');assert.equal(token,'test-session');assert.equal(first.w.sessionStorage.getItem('ss-admin-session'),null);}finally{first.dom.window.close();}
 const restored=await screen('2026-09-15','admin',false,false,false,{noTabSession:true,persisted:token});try{
  assert.equal(restored.$('dashboard').hidden,false);assert.equal(restored.calls[0].action,'me');assert.equal(restored.calls[0].sessionToken,token);
  restored.$('logout').click();await until(()=>restored.$('dashboard').hidden);assert.equal(restored.w.localStorage.getItem('ss-admin-session'),null);
 }finally{restored.dom.window.close();}
});
test('all column headers select sorting and general expenses show a period total',async()=>{
 const h=await screen('2026-09-15','admin',false,false,false,{modernSort:true});try{
  h.stored.push({id:'expense1',entry_date:'2026-09-15',category:'expense',amount:12345,description:'청소',author:'운영자'});
  h.stored.push({id:'expense2',entry_date:'2026-08-15',category:'expense',amount:99999,description:'이전',author:'운영자'});
  for(const key of ['date','author','description','spacecloud','invoice','cash','fixed','expense']){
   const b=h.w.document.querySelector('[data-sort-key="'+key+'"]');const before=h.calls.length;b.click();await until(()=>h.calls.length>before&&h.$('summary-period').textContent.includes('2026-09-12'));
   assert.equal(h.calls.at(-1).sort_by,key);assert.equal(b.getAttribute('aria-pressed'),'true');
  }
  assert.equal(h.$('sum-expense').textContent,'12,345원');
  assert.ok(h.$('sum-fee').parentElement.nextElementSibling.contains(h.$('sum-expense')));
 }finally{h.dom.window.close();}
});
for(const role of ['admin','operator'])test(role+' can change own nickname from the account bar',async()=>{
 const h=await screen('2026-09-15',role);try{
  h.$('edit-nickname').click();assert.equal(h.$('nickname-dialog').open,true);
  h.$('nickname-input').value='새 닉네임';h.$('nickname-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await until(()=>h.$('account-name').textContent.includes('새 닉네임'));
  assert.equal(h.$('nickname-dialog').open,false);assert.equal(h.calls.find(c=>c.action==='update_name').name,'새 닉네임');
 }finally{h.dom.window.close();}
});

test('recurring tab sits between ledger and team; admin can register and operators only view',async()=>{
 for(const role of ['admin','operator']){const h=await screen('2026-09-15',role);try{
  const tabs=Array.from(h.w.document.querySelectorAll('.tabs button'),b=>b.id);assert.deepEqual(tabs.filter(t=>t!=='tab-membership').slice(0,3),['tab-ledger','tab-recurring','tab-team']);
  h.$('tab-recurring').click();await until(()=>h.$('recurring-list').textContent.includes('등록한 고정 지출이 없습니다'));
  assert.equal(h.$('ledger-view').hidden,true);assert.equal(h.$('recurring-editor').hidden,role!=='admin');
  if(role==='admin'){
   h.$('recurring-description').value='매월 월세';h.$('recurring-amount').value='700000';assert.equal(h.$('recurring-start').value,'2026-09');
   h.$('recurring-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>!h.$('recurring-save').disabled);
   assert.match(h.$('recurring-list').textContent,/매월 월세/);const payload=h.calls.find(c=>c.action==='recurring_save');assert.equal(payload.start_month,'2026-09-01');assert.equal(payload.end_month,null);assert.equal(payload.category,'fixed');
  }else assert.equal(h.$('recurring-list').querySelectorAll('button').length,0);
  h.$('tab-ledger').click();await until(()=>!h.$('load-period').disabled);assert.equal(h.$('recurring-view').hidden,true);
 }finally{h.dom.window.close();}}
});
test('automatically applied expenses are labelled and cannot be edited as individual ledger rows',async()=>{
 const h=await screen('2026-09-15');try{h.stored.push({id:randomUUID(),recurring_id:randomUUID(),entry_date:'2026-09-12',description:'월세',category:'fixed',amount:700000,author:'관리자'});h.$('load-period').click();await until(()=>h.$('entry-count').textContent==='1');assert.match(h.$('entries').textContent,/자동/);assert.equal(h.$('entries').querySelectorAll('button').length,0);}finally{h.dom.window.close();}
});
