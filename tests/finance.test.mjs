import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {harness} from './harness.mjs';
const root=new URL('../',import.meta.url),password='FinanceTest!2026';
const period={from:'2026-10-01',to:'2026-10-31',offset:0};
const categories=['spacecloud','invoice','cash','fixed','expense','labor','operating_deposit','operating_withdrawal','profit_withdrawal','fee_withdrawal'];
const until=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout');};
test('account cash, person settlements, refundable operating funds and UI use actual SQL',async t=>{
 const h=await harness();let dom;
 const ok=async(action,p={},session)=>{const r=await h.call(action,p,session);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 try{
  await ok('register',{linkToken:await h.bootstrap(),username:'slowsix',name:'대행 관리자',password});
  const login=await ok('login',{username:'slowsix',password}),admin=login.sessionToken,adminId=login.user.id;
  async function operator(username,name){const invite=await ok('create_invite',{},admin);await ok('register',{linkToken:invite.url.split('=')[1],username,name,password});const result=await ok('login',{username,password});await ok('set_status',{id:result.user.id,status:'active'},admin);return result;}
  const one=await operator('operatora','운영자 A'),two=await operator('operatorb','운영자 B');
  const list=(p=period)=>ok('list',p,admin);
  const entry=(category,amount,extra={})=>({date:'2026-10-03',description:'일상 기록',category,amount,request_id:crypto.randomUUID(),...extra});
  const save=(c,a,extra={})=>ok('save_entry',entry(c,a,extra),admin);
  let cash,externalExpense;
  await t.test('source records affect business results immediately but bank only for main account',async()=>{
   assert.equal((await list()).summary.bank_balance,null);
   await ok('save_bank_opening',{amount:10000,version:0},admin);
   assert.equal((await h.call('save_bank_opening',{amount:0,version:1},one.sessionToken)).data.code,'FORBIDDEN');
   assert.equal((await h.call('save_bank_opening',{amount:1,version:0},admin)).data.code,'CONFLICT');
   await save('spacecloud',100000);await save('fixed',20000);await save('invoice',50000);
   cash=await save('cash',20000);externalExpense=await save('expense',5000);
   await save('expense',3000,{payment_source:'main'});await save('labor',2000,{payment_source:'external',party_id:one.user.id});await save('cash',10000,{payment_source:'main'});
   await save('operating_deposit',30000,{party_id:one.user.id});await save('operating_deposit',20000,{party_id:two.user.id});
   await save('operating_withdrawal',10000,{party_id:one.user.id});await save('operating_withdrawal',5000,{party_id:two.user.id});
   let a=await list();assert.equal(a.summary.revenue,180000);assert.equal(a.summary.spending,30000);assert.equal(a.summary.profit,150000);assert.equal(a.summary.bank_balance,132000);
   assert.equal(a.summary.operating_outstanding,35000);assert.equal(a.operating_funds.find(p=>p.party_id===one.user.id).amount,20000);assert.equal(a.operating_funds.find(p=>p.party_id===two.user.id).amount,15000);
   assert.equal(a.summary.pending_revenue,70000);assert.equal(a.summary.pending_expense,7000);
   const q=a.settlement_parties.find(p=>p.party_id===adminId);assert.equal(q.fee_ready,false);
   assert.equal((await h.call('settle',{...period,date:'2026-10-15',id:crypto.randomUUID(),party_id:adminId,fingerprint:q.fingerprint},admin)).data.code,'FEE_REQUIRED');
   await ok('save_fee',{...period,amount:3000,version:0,payment_method:'withhold'},admin);
   a=await list();assert.equal(a.summary.settlement,60000);assert.equal(a.settlement_parties.find(p=>p.party_id===adminId).amount,62000);assert.equal(a.settlement_parties.find(p=>p.party_id===one.user.id).amount,-2000);
  });
  await t.test('settlement records cash on actual date, is idempotent, freezes settled inputs and never doubles revenue',async()=>{
   let a=await list(),q=a.settlement_parties.find(p=>p.party_id===adminId);
   const payload={...period,date:'2026-10-15',id:crypto.randomUUID(),party_id:adminId,fingerprint:q.fingerprint};
   assert.equal((await h.call('settle',payload,one.sessionToken)).data.code,'FORBIDDEN');
   const settled=await ok('settle',payload,admin);assert.equal(settled.amount,62000);assert.equal((await ok('settle',payload,admin)).id,settled.id);
   assert.equal((await h.call('settle',{...payload,id:crypto.randomUUID()},admin)).data.code,'CONFLICT');
   a=await list();assert.equal(a.summary.bank_balance,194000);assert.equal(a.summary.revenue,180000);assert.equal(a.summary.spending,30000);assert.equal(a.summary.profit,150000);assert.equal(a.summary.pending_revenue,0);assert.equal(a.summary.pending_expense,2000);assert.equal(a.summary.fee_settled,true);
   assert.equal((await list({...period,to:'2026-10-14'})).summary.bank_balance,132000);
   const row=a.entries.find(e=>e.id===cash.id);assert.equal(row.transfer_date,'2026-10-15');assert.equal(row.settlement_id,settled.id);
   assert.equal((await h.call('delete_entry',{id:row.id,version:row.version},admin)).data.code,'ENTRY_SETTLED');
   assert.equal((await h.call('save_entry',entry('cash',1,{id:row.id,version:row.version}),admin)).data.code,'ENTRY_SETTLED');
   assert.equal((await h.call('save_fee',{...period,amount:4000,version:1},admin)).data.code,'ENTRY_SETTLED');
   assert.equal((await h.call('save_entry',entry('fee_withdrawal',3000),admin)).data.code,'FEE_METHOD_CONFLICT');
   const b=a.settlement_parties.find(p=>p.party_id===one.user.id);await ok('settle',{...period,date:'2026-10-15',id:crypto.randomUUID(),party_id:one.user.id,fingerprint:b.fingerprint},admin);
   a=await list();assert.equal(a.summary.bank_balance,192000);assert.equal(a.summary.pending_expense,0);assert.equal(a.summary.operating_outstanding,35000);
   await ok('cancel_settlement',{id:settled.id},admin);a=await list();assert.equal(a.summary.bank_balance,130000);assert.equal(a.summary.pending_revenue,70000);assert.equal(a.summary.pending_expense,5000);assert.equal(a.summary.fee_settled,false);
  });
  await t.test('stale quotes, forged sources, new category permissions and direct fee mode are enforced server-side',async()=>{
   const old=(await list()).settlement_parties.find(p=>p.party_id===adminId);
   const extra=await save('cash',1);
   assert.equal((await h.call('settle',{...period,date:'2026-10-15',id:crypto.randomUUID(),party_id:adminId,fingerprint:old.fingerprint},admin)).data.code,'CONFLICT');
   assert.equal((await h.call('save_entry',entry('spacecloud',1,{payment_source:'external'}),admin)).data.code,'INVALID_ENTRY');
   for(const category of categories.filter(c=>!['spacecloud','fixed'].includes(c)))assert.equal((await h.call('save_entry',entry(category,1),one.sessionToken)).data.code,'FORBIDDEN');
   await ok('save_fee',{...period,amount:3000,version:1,payment_method:'bank'},admin);
   await save('fee_withdrawal',3000);let a=await list();assert.equal(a.summary.bank_balance,127000);assert.equal(a.settlement_parties.find(p=>p.party_id===adminId).fee,0);
   assert.equal((await h.call('save_fee',{...period,amount:3000,version:2,payment_method:'withhold'},admin)).data.code,'FEE_METHOD_CONFLICT');
   // Repeat migration preserves source choices and completed settlements.
   await h.db.exec(await readFile(new URL('supabase/migrations/202610150002_finance_categories.sql',root),'utf8'));
   a=await list();assert.equal(a.summary.bank_balance,127000);assert.equal(a.entries.filter(e=>e.payment_source==='main'&&e.category==='expense').length,1);
   await save('profit_withdrawal',10000);a=await list();assert.equal(a.summary.bank_balance,117000);assert.equal(a.summary.profit,150001);
  });
  await t.test('all categories and payment metadata sort, suggestions are based on saved descriptions, private helpers stay private',async()=>{
   for(const key of ['category','amount','payment_source','party','settlement_status',...categories])for(const dir of ['asc','desc']){const a=await list({...period,sort_by:key,sort_dir:dir});assert.equal(a.sort_supported,true);assert.ok(a.entries.length>0);}
   await save('spacecloud',5,{description:'반복 문구'});await save('spacecloud',6,{description:'반복 문구'});
   const suggestions=await ok('description_suggestions',{category:'spacecloud'},admin);assert.equal(suggestions.items[0].description,'반복 문구');assert.equal(suggestions.items[0].uses,2);
   for(const role of ['anon','authenticated','service_role']){
    await h.db.exec('set role '+role);
    for(const table of ['bank_settings','settlements'])await assert.rejects(h.db.query('select * from ss_admin.'+table),/permission denied/);
    await assert.rejects(h.db.query("select ss_admin.settlement_quote('2026-10-01','2026-10-31',$1)",[adminId]),/permission denied/);
    await h.db.exec('reset role');
   }
  });
  await t.test('actual UI selects payment source/person, displays refundable funds, uses suggestions and processes settlements',async()=>{
   const html=await readFile(new URL('admin.html',root),'utf8'),code=await readFile(new URL('assets/admin.js',root),'utf8');
   dom=new JSDOM(html,{url:'https://slowsixon.com/admin.html',runScripts:'outside-only'});const w=dom.window,$=id=>w.document.getElementById(id);
   w.crypto.randomUUID=()=>crypto.randomUUID();w.localStorage.setItem('ss-admin-session',admin);
   const F=w.Intl.DateTimeFormat;w.Intl.DateTimeFormat=function(locale,opts){return locale==='sv-SE'?{format:()=> '2026-10-15'}:new F(locale,opts);};
   w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};w.HTMLElement.prototype.scrollIntoView=function(){};
   w.fetch=async(url,opts)=>{const {action,sessionToken,...p}=JSON.parse(opts.body);const r=await h.call(action,p,sessionToken);return new Response(JSON.stringify(r.data),{status:r.status});};w.eval(code);
   await until(()=>$('sum-operating-outstanding').textContent==='35,000원');assert.equal($('operating-funds').classList.contains('has-outstanding'),true);assert.match($('operating-fund-people').textContent,/운영자 A.*20,000원/);assert.match($('operating-fund-people').textContent,/운영자 B.*15,000원/);
   const choices=[];for(const kind of ['income','expense','deposit','withdrawal']){$('entry-'+kind).click();choices.push(...Array.from($('entry-category').options,o=>o.value));}assert.deepEqual(choices,categories);$('entry-expense').click();
   $('entry-category').value='expense';$('entry-category').dispatchEvent(new w.Event('change'));assert.equal($('entry-source').value,'external');assert.equal($('entry-party-label').hidden,false);$('entry-party').value=two.user.id;
   $('entry-date').value='2026-10-10';$('entry-description').value='테스트 결제';$('entry-amount').value=1234;$('entry-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>$('save-status').textContent==='2026-10-10 내역을 저장했습니다.');
   assert.equal($('entry-party').value,two.user.id);assert.equal($('entry-source').value,'external');assert.equal($('entry-date').value,'2026-10-10');
   await until(()=>$('description-chips').textContent.includes('테스트 결제'));$('entry-description').value='바꾸기';Array.from($('description-chips').querySelectorAll('button')).find(b=>b.textContent==='테스트 결제').click();assert.equal($('entry-description').value,'테스트 결제');
   $('entry-income').click();const editRow=Array.from($('entries').querySelectorAll('tr')).find(row=>row.textContent.includes('테스트 결제'));editRow.querySelector('button').click();await until(()=>$('entry-title').textContent==='내역 수정');assert.equal($('entry-expense').getAttribute('aria-pressed'),'true');assert.equal($('entry-category').value,'expense');assert.equal($('entry-party').value,two.user.id);assert.equal($('entry-source').value,'external');$('cancel-edit').click();
   const cards=Array.from($('settlement-parties').children),target=cards.find(c=>c.textContent.includes('운영자 B'));assert.match(target.textContent,/운영 통장 → 운영자 B/);target.querySelector('button').click();await until(()=>$('settlement-dialog').open);
   assert.match($('settlement-preview').textContent,/1,234원/);$('settlement-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>!$('settlement-dialog').open&&$('settlement-history').textContent.includes('1,234원'));
   assert.match($('entries').textContent,/정산 완료/);
   // Opening balance is explicitly entered by the owner and persists after reload.
   $('bank-opening').value=20000;$('bank-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>!$('save-bank').disabled&&$('notice').textContent.includes('기초잔액을 저장'));
   assert.equal((await list()).summary.bank_opening,20000);
   $('logout').click();await until(()=>$('dashboard').hidden);assert.equal($('settlement-parties').textContent,'');assert.equal($('sum-bank-balance').textContent,'—');
  });
 }finally{dom?.window.close();await h.db.close();}
});
