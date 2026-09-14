import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('admin.html',root),'utf8');
const code=await readFile(new URL('assets/admin.js',root),'utf8');
const until=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI did not reach expected state');};
async function screen(currentDate){
 const dom=new JSDOM(html,{url:'https://slowsixon.com/admin.html',runScripts:'outside-only'}),w=dom.window;
 const calls=[],stored=[];let failSave=false,failList=false;
 if(currentDate){const RealFormat=w.Intl.DateTimeFormat;w.Intl.DateTimeFormat=function(locale,options){return locale==='sv-SE'?{format:()=>currentDate}:new RealFormat(locale,options);};}
 w.crypto.randomUUID=randomUUID;w.AbortSignal=AbortSignal;w.sessionStorage.setItem('ss-admin-session','test-session');
 w.fetch=async(url,opts)=>{
  const b=JSON.parse(opts.body);calls.push(b);let data;
  if(b.action==='me')data={id:randomUUID(),name:'테스트 관리자',username:'slowsix',role:'admin',status:'active'};
  else if(b.action==='save_entry'){
   if(failSave)return new Response(JSON.stringify({error:'입력값을 확인해주세요.',code:'INVALID_ENTRY'}),{status:400});
   if(!stored.some(r=>r.request_id===b.request_id))stored.push({id:randomUUID(),entry_date:b.date,description:b.description,amount:b.amount,category:b.category,author:'테스트 관리자',request_id:b.request_id});
   data={id:stored.find(r=>r.request_id===b.request_id).id};
  }else if(b.action==='list'){
   if(failList)throw Error('network interrupted');
   const entries=stored.filter(r=>r.entry_date>=b.from&&r.entry_date<=b.to);data={entries,count:entries.length,summary:{revenue:0,spending:0,profit:0,fee:0,settlement:0}};
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
 const h=await screen();try{h.fill();h.setFailList(true);await h.submit();assert.equal(h.stored.length,1);assert.equal(h.$('entry-description').value,'');assert.match(h.$('save-status').textContent,/내역은 저장되었지만/);assert.match(h.$('entries').textContent,/불러오지 못했습니다/);assert.equal(h.$('entry-count').textContent,'—');h.setFailList(false);h.$('load-period').click();await until(()=>h.$('entry-count').textContent==='1');assert.equal(h.calls.filter(c=>c.action==='save_entry').length,1);}finally{h.dom.window.close();}
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
