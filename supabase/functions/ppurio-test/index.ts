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
