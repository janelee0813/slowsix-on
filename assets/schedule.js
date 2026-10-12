import {koreaDate,monthPeriod,shiftMonth,monthLabel,renderCalendar,spaceNames} from './membership-shared.js?v=spaces1';

const $=id=>document.getElementById(id);
let month=koreaDate().slice(0,7),sequence=0,controller;

async function load(){
 const current=++sequence,space=$('schedule-space').value;
 controller?.abort();
 controller=new AbortController();
 const request=controller,timer=setTimeout(()=>request.abort(),25000);
 $('schedule-month-label').textContent=monthLabel(month);
 $('schedule-space-title').textContent=spaceNames[space];
 $('schedule-status').textContent='예약 현황을 불러오는 중입니다.';
 $('schedule-status').classList.remove('schedule-error');
 $('schedule-calendar').replaceChildren();
 $('schedule-calendar').setAttribute('aria-busy','true');
 try{
  const response=await fetch('/api/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'public_calendar',space,...monthPeriod(month)}),signal:request.signal});
  const data=await response.json();
  if(!response.ok||!Array.isArray(data.items))throw Error('CALENDAR_UNAVAILABLE');
  if(current!==sequence)return;
  renderCalendar($('schedule-calendar'),month,data.items);
  $('schedule-status').textContent=data.items.length?'시간이 표시된 구간에는 예약 또는 이용 불가 일정이 있습니다.':'이 달에 등록된 예약이 없습니다.';
 }catch{
  if(current!==sequence)return;
  $('schedule-status').textContent='예약 현황을 불러오지 못했습니다. 잠시 후 새로고침해주세요.';
  $('schedule-status').classList.add('schedule-error');
 }finally{
  clearTimeout(timer);
  if(current===sequence)$('schedule-calendar').setAttribute('aria-busy','false');
 }
}

$('schedule-space').addEventListener('change',load);
$('schedule-prev').addEventListener('click',()=>{month=shiftMonth(month,-1);load();});
$('schedule-next').addEventListener('click',()=>{month=shiftMonth(month,1);load();});
$('schedule-today').addEventListener('click',()=>{month=koreaDate().slice(0,7);load();});
$('schedule-refresh').addEventListener('click',load);
document.addEventListener('slowsix:pagechange',event=>{if(event.detail==='schedule')load();});
$('schedule-month-label').textContent=monthLabel(month);
if(!$('page-schedule').classList.contains('hidden'))load();
