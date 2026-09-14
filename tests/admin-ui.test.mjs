import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('admin.html',root),'utf8');
const code=await readFile(new URL('assets/admin.js',root),'utf8');
const until=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI did not reach expected state');};
async function screen(currentDate,role="admin",legacy=false,timeoutUnsupported=false){
 const dom=new JSDOM(html,{url:'https://slowsixon.com/admin.html',runScripts:'outside-only'}),w=dom.window;
 const calls=[],stored=[],profits=new Map();let failSave=false,failList=false;
 if(currentDate){const RealFormat=w.Intl.DateTimeFormat;w.Intl.DateTimeFormat=function(locale,options){return locale==='sv-SE'?{format:()=>currentDate}:new RealFormat(locale,options);};}
 w.crypto.randomUUID=randomUUID;w.AbortSignal=timeoutUnsupported?{}:AbortSignal;w.sessionStorage.setItem('ss-admin-session','test-session');
 w.fetch=async(url,opts)=>{
  const b=JSON.parse(opts.body);calls.push(b);let data;
  if(b.action==='me')data={id:randomUUID(),name:'테스트 관리자',username:'slowsix',role,status:'active'};
  else if(b.action==='save_entry'){
   if(failSave)return new Response(JSON.stringify({error:'입력값을 확인해주세요.',code:'INVALID_ENTRY'}),{status:400});
   if(!stored.some(r=>r.request_id===b.request_id))stored.push({id:randomUUID(),entry_date:b.date,description:b.description,amount:b.amount,category:b.category,author:'테스트 관리자',request_id:b.request_id});
   data={id:stored.find(r=>r.request_id===b.request_id).id};
  }else if(b.action==='save_profit'){
   if(failSave)return new Response(JSON.stringify({error:'저장 오류',code:'INVALID_ENTRY'}),{status:400});
   const version=(profits.get(b.from+'|'+b.to)?.version||0)+1;profits.set(b.from+'|'+b.to,{amount:b.amount,version});data={version};
  }else if(b.action==='list'){
   if(failList)throw Error('network interrupted');
   const all=stored.filter(r=>r.entry_date>=b.from&&r.entry_date<=b.to).sort((a,b)=>b.entry_date.localeCompare(a.entry_date)||String(b.created_at||'').localeCompare(String(a.created_at||''))||a.id.localeCompare(b.id));const entries=all.slice(b.offset,b.offset+100);data={entries,count:all.length,summary:legacy?{revenue:0,spending:0,profit:0,fee:0,settlement:0}:{revenue:0,spending:0,profit_mode:'manual',profit_version:profits.get(b.from+'|'+b.to)?.version||0,profit:profits.get(b.from+'|'+b.to)?.amount??null,fee:profits.has(b.from+'|'+b.to)?Math.round(profits.get(b.from+'|'+b.to).amount*.05):null,settlement:profits.has(b.from+'|'+b.to)?-Math.round(profits.get(b.from+'|'+b.to).amount*.05):null}};
  }else throw Error('unexpected action '+b.action);
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

test('manual profit saves and recalculates, survives refresh, and separates periods',async()=>{
 const h=await screen('2026-09-14');try{
  assert.equal(h.$('sum-profit').textContent,'미입력');assert.equal(h.$('profit-form').hidden,false);
  h.$('manual-profit').value='200000';h.$('profit-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await until(()=>h.$('sum-fee').textContent==='10,000원');assert.equal(h.$('sum-settlement').textContent,'-10,000원');
  h.$('load-period').click();await until(()=>!h.$('load-period').disabled);assert.equal(h.$('manual-profit').value,'200000');
  h.$('month').value='2026-08';h.$('month').dispatchEvent(new h.w.Event('change'));await until(()=>!h.$('load-period').disabled);
  assert.equal(h.$('manual-profit').value,'');assert.equal(h.$('sum-fee').textContent,'미입력');
  h.$('manual-profit').value='0';h.$('profit-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.$('sum-fee').textContent==='0원');
 }finally{h.dom.window.close();}
});
test('manual profit blocks unqueried date changes, preserves failed input, and requires backend support',async()=>{
 const h=await screen('2026-09-14');try{
  h.$('manual-profit').value='100';h.$('from').value='2026-09-13';h.$('profit-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.$('notice').textContent.includes('먼저 조회'));
  assert.equal(h.calls.filter(c=>c.action==='save_profit').length,0);
  h.$('from').value='2026-09-12';h.setFailSave(true);h.$('profit-form').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.$('profit-status').textContent.includes('저장 완료를 확인하지'));
  assert.equal(h.$('manual-profit').value,'100');assert.equal(h.$('sum-fee').textContent,'미입력');
 }finally{h.dom.window.close();}
 const old=await screen('2026-09-14','admin',true);try{assert.equal(old.$('save-profit').disabled,true);assert.match(old.$('profit-status').textContent,/서버 업데이트/);}finally{old.dom.window.close();}
 const op=await screen('2026-09-14','operator');try{assert.equal(op.$('profit-form').hidden,true);}finally{op.dom.window.close();}
});

test('browsers without AbortSignal.timeout can load and save ledger entries',async()=>{
 const h=await screen('2026-09-14','admin',false,true);try{
  assert.equal(h.$('dashboard').hidden,false);h.fill();await h.submit();
  assert.equal(h.stored.length,1);assert.match(h.$('save-status').textContent,/저장했습니다/);
 }finally{h.dom.window.close();}
});
