import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('admin.html',root),'utf8');
const code=await readFile(new URL('assets/admin.js',root),'utf8');
const until=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI did not reach expected state');};
async function screen(){
 const dom=new JSDOM(html,{url:'https://slowsixon.com/admin.html',runScripts:'outside-only'}),w=dom.window;
 const calls=[],stored=[];let failSave=false,failList=false;
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
 const fill=()=>{$('month').value='2026-08';$('from').value='2026-08-01';$('to').value='2026-08-31';$('entry-date').value='2026-09-14';$('entry-description').value='9월 입금';$('entry-amount').value='100000';};
 return{dom,w,$,calls,stored,submit,fill,setFailSave:x=>failSave=x,setFailList:x=>failList=x};
}
test('saving outside the viewed period switches to saved month and displays the entry',async()=>{
 const h=await screen();try{h.fill();await h.submit();assert.equal(h.$('month').value,'2026-09');assert.equal(h.$('from').value,'2026-09-01');assert.equal(h.$('to').value,'2026-09-30');assert.equal(h.$('entry-count').textContent,'1');assert.match(h.$('entries').textContent,/9월 입금/);assert.match(h.$('save-status').textContent,/저장했습니다/);}finally{h.dom.window.close();}
});
test('successful save with failed refresh states saved and does not submit again',async()=>{
 const h=await screen();try{h.fill();h.setFailList(true);await h.submit();assert.equal(h.stored.length,1);assert.equal(h.$('entry-description').value,'');assert.match(h.$('save-status').textContent,/내역은 저장되었지만/);assert.match(h.$('entries').textContent,/불러오지 못했습니다/);assert.equal(h.$('entry-count').textContent,'—');h.setFailList(false);h.$('load-period').click();await until(()=>h.$('entry-count').textContent==='1');assert.equal(h.calls.filter(c=>c.action==='save_entry').length,1);}finally{h.dom.window.close();}
});
test('failed save retains form and same idempotency key for retry',async()=>{
 const h=await screen();try{h.fill();h.setFailSave(true);await h.submit();assert.equal(h.stored.length,0);assert.equal(h.$('entry-amount').value,'100000');assert.equal(h.$('entry-description').value,'9월 입금');assert.match(h.$('save-status').textContent,/입력값을 확인/);const id=h.calls.find(c=>c.action==='save_entry').request_id;h.setFailSave(false);await h.submit();assert.equal(h.stored.length,1);assert.equal(h.calls.filter(c=>c.action==='save_entry').at(-1).request_id,id);}finally{h.dom.window.close();}
});
