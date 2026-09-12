// Local-only preview with synthetic data and mocked Supabase Auth. Never used by production.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
const root=new URL('../',import.meta.url),h=await harness();
const pass='LocalPreview!2026';
const secret=await h.bootstrap();
await h.call('register',{linkToken:secret,username:'slowsix',name:'슬로우식스 관리자',password:pass});
const a=(await h.call('login',{username:'slowsix',password:pass})).data;
const invitation=(await h.call('create_invite',{},a.sessionToken)).data.url.split('=')[1];
await h.call('register',{linkToken:invitation,username:'operatorone',name:'운영자 하나',password:pass});
const op=(await h.call('login',{username:'operatorone',password:pass})).data;
await h.call('set_status',{id:op.user.id,status:'active'},a.sessionToken);
for(const [category,amount,description,date] of [['spacecloud',1540000,'스페이스클라우드 정산 입금','2026-09-12'],['invoice',400000,'기업 워크숍 대관','2026-09-11'],['cash',220000,'주말 모임 대관','2026-09-10'],['fixed',700000,'9월 월세','2026-09-05'],['fixed',112000,'9월 관리비','2026-09-06'],['expense',140000,'청소 알바비','2026-09-09']])await h.call('save_entry',{category,amount,description,date,request_id:crypto.randomUUID()},a.sessionToken);
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript'};
createServer(async(req,res)=>{try{
 if(req.url==='/__admin-api'){
  let body='';for await(const chunk of req)body+=chunk;
  const response=await h.handler(new Request('https://mock.supabase.co/functions/v1/admin-api',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://slowsixon.com','x-forwarded-for':'127.0.0.1'},body}));res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());return;
 }
 const path=new URL(req.url,'http://localhost').pathname;
 const allowed=['/admin.html','/assets/admin.css','/assets/admin.js','/index.html','/'];if(!allowed.includes(path)){res.writeHead(404);res.end();return;}
 let text=await readFile(new URL((path==='/'?'index.html':path.slice(1)),root),'utf8');
 if(path==='/admin.html')text=text.replace('connect-src https://qhvwwdrwfzwpehfjntbv.supabase.co',"connect-src 'self'");
 if(path==='/assets/admin.js')text=text.replace("const API='https://qhvwwdrwfzwpehfjntbv.supabase.co/functions/v1/admin-api'","const API='/__admin-api'");
 res.writeHead(200,{'Content-Type':mime[path.slice(path.lastIndexOf('.'))]||'text/html','Cache-Control':'no-store'});res.end(text);
 }catch(e){res.writeHead(500);res.end('Preview error');console.error(e.message)}
}).listen(8877,'127.0.0.1',()=>console.log('Synthetic preview: http://127.0.0.1:8877/admin.html — slowsix / LocalPreview!2026'));
