import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {build} from 'esbuild';import {JSDOM} from 'jsdom';import {harness} from './harness.mjs';
const until=async fn=>{for(let i=0;i<250;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timed out');};
const bundle=async file=>(await build({entryPoints:[new URL('../assets/'+file,import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'MembershipUI'})).outputFiles[0].text;
test('member booking form and admin approval work with actual SQL and API',async()=>{
 const h=await harness(),ok=async(a,p={},s)=>{const r=await h.call(a,p,s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;},password='Preview!Safe2026';
 await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',password,name:'관리자'});const admin=(await ok('login',{username:'slowsix',password})).sessionToken;
 const link=await ok('member_invite',{tier:'friends'},admin);await ok('register',{linkToken:link.url.split('=')[1],username:'friend',password,name:'친구'});const member=(await ok('login',{username:'friend',password})).sessionToken;
 const dom=new JSDOM(await readFile(new URL('../membership.html',import.meta.url),'utf8'),{url:'https://slowsixon.com/membership.html',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);w.crypto.randomUUID=()=>crypto.randomUUID();w.AbortController=AbortController;w.localStorage.setItem('ss-member-session',member);w.confirm=()=>true;
 w.fetch=async(url,opts)=>{const b=JSON.parse(opts.body),r=await h.call(b.action,b,b.sessionToken);return new Response(JSON.stringify(r.data),{status:r.status});};
 let ad;
 try{
  w.eval(await bundle('membership.js'));await until(()=>$('booking-calendar').children.length>7);assert.equal($('member-tier').textContent,'슬로우식스 프렌즈');assert.match($('coupon-balance').textContent,/1\/1/);
  const date=new Date(Date.now()+3*86400000+9*3600000).toISOString().slice(0,10);$('booking-date').value=date;$('booking-coupon').checked=true;$('booking-form').dispatchEvent(new w.Event('input'));assert.match($('booking-breakdown').textContent,/12%/);assert.match($('booking-breakdown').textContent,/쿠폰 3,000원/);
  $('booking-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>$('my-bookings').textContent.includes('예약 요청'));assert.match($('coupon-balance').textContent,/0\/1/);assert.equal($('booking-coupon').disabled,true);
  ad=new JSDOM('<div id="root"></div>',{url:'https://slowsixon.com/admin.html',runScripts:'outside-only'});ad.window.confirm=()=>true;ad.window.eval(await bundle('membership-admin.js'));let notice='';const panel=ad.window.MembershipUI.mountMembershipAdmin(ad.window.document.getElementById('root'),(a,p)=>ok(a,p,admin),m=>notice=m);await panel.load();
  const inbox=ad.window.document.getElementById('ma-inbox');assert.match(inbox.textContent,/친구/);inbox.querySelector('textarea').value='테스트은행 12345 · 예금주 슬로우식스';Array.from(inbox.querySelectorAll('button')).find(b=>b.textContent==='승인·입금 안내').click();await until(()=>notice==='예약 상태를 변경했습니다.'&&inbox.textContent.includes('입금 확인·예약 확정'));
  $('booking-refresh').click();await until(()=>$('my-bookings').textContent.includes('테스트은행 12345'));assert.match($('my-bookings').textContent,/입금 대기/);
  Array.from(inbox.querySelectorAll('button')).find(b=>b.textContent==='입금 확인·예약 확정').click();await until(()=>inbox.textContent.includes('처리할 예약이 없습니다'));
  $('booking-refresh').click();await until(()=>$('my-bookings').textContent.includes('예약 확정'));assert.equal($('my-bookings').querySelectorAll('button').length,0);
  assert.match($('member-notifications').textContent,/예약이 확정/);
 }finally{dom.window.close();ad?.window.close();await h.db.close();}
});
