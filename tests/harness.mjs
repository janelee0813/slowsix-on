import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
export async function harness(){
 const db=new PGlite({extensions:{pgcrypto}});
 await db.exec('create role anon; create role authenticated; create role service_role;');
 await db.exec(await readFile(new URL('supabase/migrations/202609120001_admin.sql',root),'utf8'));
 const {code}=await transform(await readFile(new URL('supabase/functions/admin-api/index.ts',root),'utf8'),{loader:'ts',format:'esm',target:'es2022'});
 const edge=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const auth=new Map();
 const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 const fetcher=async(url,options)=>{
  const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
  if(path==='/rest/v1/rpc/ss_admin_gateway'){
   if(options.headers.apikey!=='test-service-key')return json({message:'denied'},403);
   try{return json((await db.query('select public.ss_admin_gateway($1,$2::jsonb) as result',[body.p_action,JSON.stringify(body.p)])).rows[0].result)}catch(e){return json({message:e.message},400)}
  }
  if(path==='/auth/v1/admin/users'){
   const id=crypto.randomUUID();auth.set(id,{...body,id});return json({id});
  }
  if(path.startsWith('/auth/v1/admin/users/')&&options.method==='DELETE'){auth.delete(path.split('/').at(-1));return json({})}
  if(path==='/auth/v1/token'){
   const u=[...auth.values()].find(x=>x.email===body.email&&x.password===body.password);
   return u?json({user:{id:u.id},access_token:'never-expose-me',refresh_token:'never-expose-me'}):json({message:'Invalid credentials'},400);
  }
  throw Error('Unexpected path '+path);
 };
 const handler=edge.makeHandler(k=>({SUPABASE_URL:'https://mock.supabase.co',SUPABASE_ANON_KEY:'test-anon-key',SUPABASE_SERVICE_ROLE_KEY:'test-service-key'}[k]),fetcher);
 let ip=0;
 const call=async(action,p={},sessionToken)=>{
  const req=new Request('https://mock.supabase.co/functions/v1/admin-api',{method:'POST',headers:{origin:'https://slowsixon.com','Content-Type':'application/json','x-forwarded-for':'192.0.2.'+(++ip)},body:JSON.stringify({action,...p,sessionToken})});
  const response=await handler(req);return {status:response.status,data:await response.json()};
 };
 const bootstrap=async()=>{const result=await db.query(await readFile(new URL('supabase/bootstrap.sql',root),'utf8'));return result.rows[0]?.['관리자_비밀번호_설정_링크'].split('=')[1];};
 return {db,edge,handler,auth,call,bootstrap};
}
