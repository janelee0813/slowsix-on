// ExcelJS 4.4.0 is served locally; financial data never leaves this browser.
let library;
export function loadExcel(){
 if(globalThis.ExcelJS)return Promise.resolve(globalThis.ExcelJS);
 if(!library)library=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='assets/vendor/exceljs-4.4.0.min.js';
  script.onload=()=>resolve(globalThis.ExcelJS);script.onerror=()=>{library=null;script.remove();reject(Error('엑셀 기능을 불러오지 못했습니다. 다시 시도해주세요.'));};document.head.append(script);
 });
 return library;
}
export async function collectLedger(fetchPage,p,order){
 const first=await fetchPage(p,0,order),entries=[...first.entries];
 const signature=JSON.stringify(first.summary),ids=new Set(entries.map(r=>r.id));
 for(let offset=100;offset<first.count;offset+=100){
  const page=await fetchPage(p,offset,order);
  if(page.count!==first.count||JSON.stringify(page.summary)!==signature)throw Error('다운로드 중 내역이 변경되었습니다. 다시 시도해주세요.');
  for(const row of page.entries){if(ids.has(row.id))throw Error('다운로드 중 내역이 변경되었습니다. 다시 시도해주세요.');ids.add(row.id);entries.push(row);}
 }
 if(entries.length!==first.count)throw Error('일부 내역을 가져오지 못했습니다. 다시 시도해주세요.');
 return {...first,entries};
}
export function buildWorkbook(ExcelJS,data,p,names){
 const workbook=new ExcelJS.Workbook();workbook.creator='SLOWSIX';workbook.created=new Date();
 const currency='#,##0;[Red]-#,##0';
 function sheet(name,headers,widths,rows,numbers=[]){
  const ws=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
  ws.columns=headers.map((header,i)=>({header,width:widths[i]||20}));
  rows.forEach(row=>ws.addRow(row.map(v=>v??'')));
  ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF286779'}};ws.getRow(1).height=26;
  ws.eachRow((row,index)=>{row.alignment={vertical:'middle',wrapText:true};if(index>1&&index%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F6F7'}};});
  for(const col of numbers)ws.getColumn(col).numFmt=currency;
  ws.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,ws.rowCount),column:headers.length}};
  return ws;
 }
 const s=data.summary,manual=s.fee_mode==='manual';
 const metrics=[['조회 시작일',p.from],['조회 종료일',p.to],['총 매출',s.revenue],['총 지출',s.spending],['순수익',s.revenue-s.spending],['운영 수수료',manual?s.fee??'미입력':'미입력'],['수수료 지급 방식',s.fee_method==='bank'?'운영 통장에서 별도 출금':'정산금에서 공제'],['일반지출 합계',s.expense],['미정산 순액',manual?s.settlement??'미입력':'미입력'],['다른 통장 보관 매출',s.pending_revenue],['개인 결제 미정산 비용',s.pending_expense],['반환할 운영비 (누적)',s.operating_outstanding],['통장잔액',s.bank_balance??(s.bank_configured?'기준일 이전':'기초잔액 미설정')],['통장잔액 기준일',s.bank_as_of],['기초잔액 기준일',s.bank_opening_date],['기초잔액',s.bank_configured?s.bank_opening:'미설정'],['내역 건수',data.entries.length],['금액 단위','원'],['통장잔액 기준','기초잔액부터 기준일까지의 누적 실제 입출금입니다.'],['미정산 순액 기준','양수: 운영 통장으로 입금 / 음수: 운영 통장에서 지급'],['반환할 운영비 기준','입금 - 운영비에서 출금 - 운영비를 뺀 사람별 누적 금액입니다.']];
 for(const [key,label] of Object.entries(names))metrics.push([label+' 합계',data.entries.filter(r=>r.category===key).reduce((sum,r)=>sum+Number(r.amount),0)]);
 for(const fund of data.operating_funds||[])metrics.push(['운영비 잔액 · '+fund.name,Number(fund.amount)]);
 sheet('정산 요약',['항목','값'],[34,66],metrics,[2]);
 sheet('매출·지출 내역',['날짜','내용','항목','입금·결제한 곳','담당자','정산 상태','금액 (원)','작성자','정산 송금일','자동 고정 지출'],[15,46,24,20,18,18,20,18,16,18],data.entries.map(r=>[
  r.entry_date,r.description,names[r.category]||r.category,r.payment_source==='external'?'다른 통장':'운영 통장',r.party_name||'',r.payment_source==='external'?(r.settlement_id?'정산 완료':'미정산'):(r.entry_date>s.bank_as_of?'반영 예정':'통장 반영'),Number(r.amount),r.author,r.transfer_date||'',r.recurring_id?'자동':''] ),[7]);
 sheet('사람별 미정산',['담당자','내역 건수','매출 (원)','결제 비용 (원)','수수료 공제 (원)','미정산 순액 (원)','송금 방향','수수료 입력 상태'],[20,14,20,20,22,24,34,22],(data.settlement_parties||[]).filter(q=>q.count||q.fee_id).map(q=>[q.name,q.count,Number(q.revenue),Number(q.expense),Number(q.fee||0),Number(q.amount),q.amount>0?q.name+' → 운영 통장':q.amount<0?'운영 통장 → '+q.name:'송금 없이 상계',q.fee_ready?'입력 완료':'입력 필요']),[3,4,5,6]);
 return workbook;
}
export function downloadWorkbook(buffer,p){
 const url=URL.createObjectURL(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
 const a=document.createElement('a');a.href=url;a.download=`슬로우식스_정산_${p.from}_${p.to}.xlsx`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
