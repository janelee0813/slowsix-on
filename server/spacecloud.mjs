// Uses only the host center's visible controls. No private API or authentication bypass.
export const calendarURL='https://partner.spacecloud.kr/reservation-calendar?product=133597&space=79746';
const HOUR=3600000,DAY=24*HOUR;
export class SyncError extends Error {constructor(code){super(code);this.code=code;}}
export function segments(job){
 if(!/^[0-9a-f-]{36}$/i.test(job.id)||!['blocked','released'].includes(job.desired))throw new SyncError('CONFIGURATION');
 let start=Date.parse(job.starts_at),end=Date.parse(job.ends_at);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>DAY||start%HOUR||end%HOUR)throw new SyncError('CONFIGURATION');
 const result=[];
 while(start<end){const local=start+9*HOUR,midnight=Math.floor(local/DAY)*DAY+DAY-9*HOUR,stop=Math.min(end,midnight);
  result.push({date:new Date(local).toISOString().slice(0,10),start:new Date(local).getUTCHours(),end:stop===midnight?24:new Date(stop+9*HOUR).getUTCHours(),marker:'SSO-'+job.id.replaceAll('-','')+'-'+result.length});start=stop;
 }
 return result;
}
export function classifyRows(rows,part){
 const own=rows.filter(r=>r.name===part.marker);
 if(own.length>1||own.some(r=>r.start!==part.start||r.end!==part.end||!r.external))throw new SyncError('UNVERIFIED');
 return {own:own[0],conflicts:rows.filter(r=>r.name!==part.marker&&r.start<part.end&&r.end>part.start)};
}
export async function reconcile(adapter,job){
 const parts=segments(job);
 // Inspect every day before writing either half of an overnight booking.
 for(const part of parts){const found=classifyRows(await adapter.rows(part.date),part);if(job.desired==='blocked'&&found.conflicts.length)throw new SyncError('TIME_CONFLICT');}
 for(const part of parts){
  const found=classifyRows(await adapter.rows(part.date),part);
  if(job.desired==='blocked'){
   if(found.conflicts.length)throw new SyncError('TIME_CONFLICT');
   if(!found.own)await adapter.add(part);
  }else if(found.own)await adapter.remove(part);
  const after=classifyRows(await adapter.rows(part.date,true),part);
  if(job.desired==='blocked'?!after.own||after.conflicts.length:!!after.own)throw new SyncError('UNVERIFIED');
 }
}

export class HostCalendar {
 constructor(page,{email,password,onStage=()=>{}}){this.page=page;this.email=email;this.password=password;this.onStage=onStage;this.loggedIn=false;}
 async connect(){
  this.onStage('login_page');
  const p=this.page;await p.goto('https://partner.spacecloud.kr/auth/login',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>!/^\/auth\/login\/?$/.test(location.pathname)||document.querySelector('input[type="password"]'));
  if(/^\/auth\/login\/?$/.test(new URL(p.url()).pathname)){
   if(new URL(p.url()).origin!=='https://partner.spacecloud.kr')throw new SyncError('LOGIN_REQUIRED');
   this.onStage('login_form');
   const pass=p.locator('input[type="password"]:visible'),email=p.locator('input:not([type="password"]):not([type="checkbox"]):not([type="hidden"]):visible');
   await pass.waitFor({state:'visible'});
   if(await pass.count()!==1||await email.count()!==1)throw new SyncError('UI_CHANGED');
   // Send keyboard and blur events so the host can run its field validators.
   // Use normal key events, without bypassing the disabled control or its validation.
   await email.fill('');await email.pressSequentially(this.email.trim());await email.press('Tab');
   await pass.fill('');await pass.pressSequentially(this.password);await pass.press('Tab');
   this.onStage('login_submit_text');await p.getByText('호스트 이메일로 로그인',{exact:true}).click({noWaitAfter:true});
   this.onStage('login_result');
   // The host sends successful logins to /auth/mypage; only /auth/login is the login form.
   try{await p.waitForURL(url=>url.origin==='https://partner.spacecloud.kr'&&!/^\/auth\/login\/?$/.test(url.pathname),{timeout:15000});}catch{throw new SyncError('LOGIN_REQUIRED');}
  }
  this.onStage('calendar_open');await p.goto(calendarURL,{waitUntil:'domcontentloaded'});
  try{await p.locator('.calendar_tit.short').waitFor({state:'visible'});}catch{throw new SyncError('LOGIN_REQUIRED');}
  const url=new URL(p.url());if(url.origin!=='https://partner.spacecloud.kr'||url.searchParams.get('product')!=='133597'||url.searchParams.get('space')!=='79746')throw new SyncError('CONFIGURATION');
  this.loggedIn=true;
 }
 async month(date){
  const [y,m]=date.split('-').map(Number),target=y*12+m;
  for(let n=0;n<15;n++){
   const current=await this.page.locator('.calendar_tit.short .tit em').innerText(),[cy,cm]=current.match(/\d+/g).map(Number),value=cy*12+cm;
   if(value===target)return;
   await this.page.locator('.calendar_tit.short '+(value<target?'.btn_next':'.btn_prev')).click();
   await this.page.waitForFunction(old=>document.querySelector('.calendar_tit.short .tit em')?.textContent!==old,current);
  }
  throw new SyncError('UI_CHANGED');
 }
 async rows(date,reload=false){
  this.onStage('calendar_read');
  if(reload){await this.page.reload({waitUntil:'domcontentloaded'});await this.page.locator('.calendar_tit.short').waitFor({state:'visible'});}
  await this.month(date);
  // Allow the host's month request to settle; no ongoing background requests are used as truth.
  await this.page.waitForLoadState('networkidle',{timeout:8000});
  const rows=await this.page.locator('#contents table tbody').evaluate((body,date)=>{
   const [y,m,d]=date.split('-').map(Number),firstWeekday=new Date(Date.UTC(y,m-1,1)).getUTCDay(),cell=[...body.querySelectorAll('td')][firstWeekday+d-1];
   if(!cell||Number(cell.querySelector('.date')?.textContent)!==d)return null;
   return [...cell.querySelectorAll('.booking_list li a')].map(a=>({external:a.classList.contains('type5'),name:a.textContent.slice(a.textContent.indexOf(',')+1).trim(),start:Number(a.querySelectorAll('em')[0]?.textContent),end:Number(a.querySelectorAll('em')[1]?.textContent)}));
  },date);
  if(!rows||rows.some(r=>!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end>24||r.start>=r.end))throw new SyncError('UI_CHANGED');
  return rows;
 }
 async add(part){
  this.onStage('calendar_add');
  const p=this.page;await p.getByText('예약추가',{exact:true}).click();
  const dialog=p.locator('.popup_wrap').filter({hasText:'외부예약/휴무일 추가'});
  await dialog.waitFor({state:'visible'});await dialog.locator('._miniCalOpen').click();
  const [y,m,d]=part.date.split('-').map(Number),target=y*12+m;
  let selected=false;
  for(let n=0;n<15;n++){
   const title=await dialog.locator('.calendar_tit strong').innerText(),[cy,cm]=title.match(/\d+/g).map(Number),value=cy*12+cm;
   if(value===target){selected=true;break;}
   await dialog.locator(value<target?'.btn_month_next':'.btn_month_prev').click();
  }
  if(!selected)throw new SyncError('UI_CHANGED');
  await dialog.locator('.calendar tbody a:not(.disable)').filter({hasText:new RegExp('^'+String(d).padStart(2,'0')+'$')}).click();
  const value=await dialog.locator('#start_day').inputValue();if(value.match(/\d+/g)?.slice(0,3).map(Number).join('-')!==[y,m,d].join('-'))throw new SyncError('UI_CHANGED');
  await dialog.locator('#shour').selectOption(String(part.start-1));await dialog.locator('#ehour').selectOption(String(part.end-1));
  await dialog.locator('#reserve_name').fill(part.marker);
  await dialog.locator('#reserve_memo').fill('슬로우식스 멤버십 연동 · '+part.marker);
  const final=await dialog.locator('select').evaluateAll(nodes=>nodes.map(n=>({id:n.id,value:n.value})));
  if(final.find(n=>n.id==='shour')?.value!==String(part.start-1)||final.find(n=>n.id==='ehour')?.value!==String(part.end-1)||final.find(n=>n.id==='slct-repeatType')?.value!=='-1')throw new SyncError('UI_CHANGED');
  // Once submitted, an uncertain response is never retried automatically.
  try{await dialog.locator('#_addExternalSchedule').click();await dialog.waitFor({state:'hidden'});}catch{throw new SyncError('UNVERIFIED');}
 }
 async remove(part){
  this.onStage('calendar_remove');
  await this.month(part.date);
  const link=this.page.locator('#contents .booking_list a.type5').filter({hasText:part.marker});
  if(await link.count()!==1)throw new SyncError('UNVERIFIED');await link.click();
  const dialog=this.page.locator('.popup_wrap').filter({hasText:'직접 추가한 예약 건입니다.'});await dialog.waitFor({state:'visible'});
  const details=await dialog.locator('.list_detail li').allTextContents();
  const actualName=details.find(t=>t.trim().startsWith('예약자명'))?.split(':').slice(1).join(':').trim();
  const time=details.find(t=>t.trim().startsWith('예약내용'))||'';
  const hours=/([0-9]{1,2}):00~([0-9]{1,2}):00/.exec(time.replace(/\s/g,''));
  if(actualName!==part.marker||!time.includes(part.date.replaceAll('-','.'))||!hours||Number(hours[1])!==part.start||Number(hours[2])!==part.end||!details.some(t=>t.includes('슬로우식스 멤버십 연동 · '+part.marker)))throw new SyncError('UNVERIFIED');
  let unexpected=false;
  const confirmation=async popup=>{
   if(popup.type()==='confirm'&&/예약.*삭제|삭제하시겠/.test(popup.message()))await popup.accept();
   else{unexpected=true;await popup.dismiss();}
  };
  this.page.on('dialog',confirmation);
  try{
   await dialog.getByText('예약 삭제',{exact:true}).click();
   await dialog.waitFor({state:'hidden'});
   if(unexpected)throw new SyncError('UNVERIFIED');
  }catch{throw new SyncError('UNVERIFIED');}
  finally{this.page.off('dialog',confirmation);}
 }
}
