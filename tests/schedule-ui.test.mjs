import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout');};
test('public calendar selects branches, moves months and discards stale responses',async()=>{
 const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'),{url:'https://slowsixon.com/#schedule',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 const requests=[];w.AbortController=AbortController;
 w.fetch=(url,options)=>new Promise(resolve=>requests.push({body:JSON.parse(options.body),resolve:data=>resolve(Response.json(data))}));
 try{
  $('page-schedule').classList.remove('hidden');
  const bundle=(await build({entryPoints:[new URL('../assets/schedule.js',import.meta.url).pathname],bundle:true,write:false,format:'iife'})).outputFiles[0].text;
  w.eval(bundle);
  assert.deepEqual(Array.from($('schedule-space').options,x=>x.value),['on','p','d']);
  assert.equal(requests[0].body.action,'public_calendar');assert.equal(requests[0].body.space,'on');assert.equal(requests[0].body.sessionToken,undefined);
  requests[0].resolve({items:[]});await until(()=>$('schedule-calendar').children.length>7);
  const originalMonth=$('schedule-month-label').textContent;
  $('schedule-next').click();assert.notEqual($('schedule-month-label').textContent,originalMonth);
  $('schedule-prev').click();assert.equal($('schedule-month-label').textContent,originalMonth);
  $('schedule-space').value='p';$('schedule-space').dispatchEvent(new w.Event('change'));
  requests.at(-1).resolve({items:[]});await until(()=>$('schedule-calendar').getAttribute('aria-busy')==='false');
  requests[1].resolve({items:[{starts_at:requests[1].body.from,ends_at:requests[1].body.to}]});await new Promise(r=>setTimeout(r,10));
  assert.equal($('schedule-space-title').textContent,'슬로우식스P');assert.equal($('schedule-calendar').querySelectorAll('.calendar-event').length,0);
  $('schedule-space').value='d';$('schedule-space').dispatchEvent(new w.Event('change'));requests.at(-1).resolve({items:[]});await until(()=>$('schedule-calendar').getAttribute('aria-busy')==='false');
  assert.equal($('schedule-space-title').textContent,'슬로우식스D');
  assert.equal(($('schedule-calendar').children.length-7)%7,0);
  $('schedule-refresh').click();requests.at(-1).resolve({error:'unavailable'});await until(()=>$('schedule-status').classList.contains('schedule-error'));
  assert.equal($('schedule-calendar').children.length,0);assert.match($('schedule-status').textContent,/불러오지 못했습니다/);
  $('schedule-today').click();assert.equal($('schedule-month-label').textContent,originalMonth);requests.at(-1).resolve({items:[]});await until(()=>$('schedule-calendar').children.length>7);
 }finally{w.close();}
});
