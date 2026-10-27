import {koreaDate,monthPeriod,shiftMonth,monthLabel,renderCalendar,spaceNames,stamp} from './membership-shared.js?v=spaces1';

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
  $('schedule-status').textContent=(data.items.length?'스페이스클라우드·네이버에서 가져온 예약 일정입니다.':'이 달에 외부 캘린더에 등록된 예약이 없습니다.')+(data.external_checked_at?' 외부 일정 확인: '+stamp(data.external_checked_at):'');
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
