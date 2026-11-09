import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {collectLedger,buildWorkbook} from '../assets/settlement-export.js';
const require=createRequire(import.meta.url);
// Load the exact browser bundle, then read the generated XLSX back with it.
const vendorModule={exports:{}};
new Function('module','exports','require',await readFile(new URL('../assets/vendor/exceljs-4.4.0.min.js',import.meta.url),'utf8'))(vendorModule,vendorModule.exports,require);
const ExcelJS=vendorModule.exports;
const p={from:'2026-11-01',to:'2026-11-30'};
test('export includes all pages and retains requested order',async()=>{
 const rows=Array.from({length:205},(_,id)=>({id:String(id),amount:id})),offsets=[];
 const data=await collectLedger(async(period,offset,order)=>{assert.deepEqual(period,p);assert.equal(order,'amount:asc');offsets.push(offset);return {count:205,entries:rows.slice(offset,offset+100),summary:{revenue:99}};},p,'amount:asc');
 assert.deepEqual(offsets,[0,100,200]);assert.deepEqual(data.entries,rows);
});
test('export fails for changing totals, duplicates or incomplete pages',async()=>{
 for(const mode of ['total','duplicate','missing'])await assert.rejects(collectLedger(async(_,offset)=>({count:101,summary:{revenue:mode==='total'?offset:0},entries:offset?(mode==='missing'?[]:[{id:mode==='duplicate'?'0':'100'}]):Array.from({length:100},(_,id)=>({id:String(id)}))}),p,'desc'));
});
test('real XLSX round trip preserves Korean text, numeric values, status and literal formula-like descriptions',async()=>{
 const data={entries:[{entry_date:'2026-11-03',description:'=HYPERLINK("https://example.com")',category:'invoice',payment_source:'external',party_name:'테스트',amount:123456,author:'작성자'},{entry_date:'2026-11-04',description:'청소비 & 소모품',category:'expense',payment_source:'main',amount:30000,recurring_id:'auto'}],summary:{revenue:123456,spending:30000,fee_mode:'manual',fee:0,expense:30000,settlement:-5000,bank_balance:0,bank_as_of:'2026-11-09',bank_configured:true,bank_opening:10000},settlement_parties:[{name:'담당자',count:1,revenue:0,expense:5000,amount:-5000,fee_ready:true}]};
 const wb=buildWorkbook(ExcelJS,data,p,{invoice:'매출 - 계산서',expense:'지출 - 일반'});
 const buffer=await wb.xlsx.writeBuffer();const read=new ExcelJS.Workbook();await read.xlsx.load(buffer);
 assert.equal(read.worksheets.length,3);const ledger=read.getWorksheet('매출·지출 내역');
 assert.equal(ledger.getCell('B2').value,data.entries[0].description);assert.equal(ledger.getCell('B2').type,ExcelJS.ValueType.String);
 assert.equal(ledger.getCell('G2').value,123456);assert.equal(ledger.getCell('F2').value,'미정산');assert.equal(ledger.getCell('J3').value,'자동');
 assert.equal(read.getWorksheet('정산 요약').getCell('B6').value,93456);
 assert.equal(read.getWorksheet('사람별 미정산').getCell('F2').value,-5000);
});
