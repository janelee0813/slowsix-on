// Dashboard-only connectivity diagnostic. Never returns credentials or sends messages.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };
export function makeHandler(env: (name: string) => string | undefined, fetcher = fetch) {
 return async (req: Request) => {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  let secretKeys: unknown[] = [];
  try { secretKeys = Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}')); } catch { /* deny malformed configuration */ }
  const apiKey = req.headers.get('apikey');
  const secretAuthorized = Boolean(apiKey && secretKeys.some(key => typeof key === 'string' && key.length > 20 && key === apiKey));
  if (!(service && req.headers.get('Authorization') === `Bearer ${service}`) && !secretAuthorized) return json({ error: 'FORBIDDEN' }, 403);
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const account = env('PPURIO_ACCOUNT')?.trim();
  const key = env('PPURIO_ACCESS_KEY')?.trim();
  if (account !== 'slowsix' || !key) return json({ error: 'SETTINGS_REQUIRED', accountMatches: account === 'slowsix', accessKeyPresent: Boolean(key) }, 400);
  try {
   const input=await req.json().catch(()=>({}));
   if(input.route==='fixie'){
    if(!service)return json({error:'SETTINGS_REQUIRED'},503);
    const body=JSON.stringify({action:'token',authorization:`Basic ${btoa(`${account}:${key}`)}`});
    const timestamp=String(Date.now());
    const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(service),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode(`ppurio-relay\n${timestamp}\n${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
    const response=await fetcher('https://slowsixon.com/api/ppurio-relay',{method:'POST',headers:{'Content-Type':'application/json','x-ss-timestamp':timestamp,'x-ss-signature':signature},body,redirect:'error',signal:AbortSignal.timeout(25000)});
    const result=await response.json();
    if(!response.ok)return json({stage:'relay',authenticated:false,relayHttpStatus:response.status,error:['FIXIE_CONFIGURATION','PROXY_CONNECTION_FAILED','FORBIDDEN'].includes(result.error)?result.error:'RELAY_FAILED',messageSent:false},502);
    return json({stage:'token',route:'fixie',authenticated:result.status===200&&typeof result.data?.token==='string'&&result.data.token.length>0,providerHttpStatus:result.status,providerCode:result.data?.code??null,messageSent:false});
   }
   const response = await fetcher('https://message.ppurio.com/v1/token', {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${account}:${key}`)}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
   });
   const data = await response.json();
   return json({ stage: 'token', authenticated: response.ok && typeof data.token === 'string' && data.token.length > 0, providerHttpStatus: response.status, providerCode: typeof data.code === 'number' || typeof data.code === 'string' ? data.code : null, messageSent: false });
  } catch {
   return json({ stage: 'token', authenticated: false, error: 'PROVIDER_CONNECTION_FAILED', messageSent: false }, 502);
  }
 };
}
if (typeof Deno !== 'undefined') Deno.serve(makeHandler(name => Deno.env.get(name)));
