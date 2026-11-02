// A small stand-in for the AI Studio relay (aistudio-pg-bridge 2-relay-client-gateway) used by the local tests.
// Same endpoints and reply shapes as relay-server.js / dashboard.js; accounts are keyed by a hash of SAPISID.
import http from 'node:http';
import { createHash } from 'node:crypto';

export type Health = 'alive' | 'dead' | 'quota' | 'proof' | 'net' | 'google500';

export function startMockRelay(opts: { apiKey: string }) {
  const st = {
    accounts: new Map<string, { cookies: string; g1Tier: string }>(),
    health: new Map<string, Health>(), // by SAPISID value; default alive
    tests: [] as string[],              // account ids tested, in order
    removed: [] as string[],
    seen: [] as { path: string; headers: http.IncomingHttpHeaders; body: any }[], // generation-endpoint calls
    holdMs: 0,                          // delay between stream chunks
    served: [] as (string | null)[],    // account picked per chat call
    misbehave: null as null | 'omit' | 'foreign', // omit X-Relay-Account / report an account outside X-Relay-Allow
  };
  let rr = 0;
  // X-Relay-Allow: round-robin among the listed accounts the relay holds; without the header, among all
  const pick = (req: http.IncomingMessage): { id: string | null; allow: Set<string> | null } => {
    const raw = req.headers['x-relay-allow'];
    const allow = raw === undefined ? null : new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean));
    const ready = [...st.accounts.keys()].filter((id) => !allow || allow.has(id));
    return { id: ready.length ? ready[rr++ % ready.length] : null, allow };
  };
  const accountHeader = (id: string | null, allow: Set<string> | null): Record<string, string> => {
    if (st.misbehave === 'omit') return {};
    if (st.misbehave === 'foreign') return { 'X-Relay-Account': [...st.accounts.keys()].find((x) => !allow?.has(x)) || 'acc_ffffffffffffffff' };
    return id ? { 'X-Relay-Account': id } : {};
  };
  const sapisidOf = new Map<string, string>(); // account id -> SAPISID
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    const b = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };
  const read = (req: http.IncomingMessage) => new Promise<string>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const raw = await read(req);
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 500, { error: { message: 'Invalid JSON body', type: 'relay_error', code: 500 } }); }
    if (p === '/health') return json(res, 200, { ok: true, accountCount: st.accounts.size });
    if (req.headers.authorization !== 'Bearer ' + opts.apiKey) return json(res, 401, { ok: false, error: 'Unauthorized: 请先使用 API Key 登录面板' });

    if (req.method === 'POST' && p === '/api/accounts/add') {
      let text = typeof body.cookies === 'string' ? body.cookies.trim() : '';
      let tier = body.g1Tier || null;
      if (text.startsWith('{')) {
        try { const j = JSON.parse(text); if (typeof j.cookies === 'string') { text = j.cookies; tier = j.g1Tier || tier; } } catch {}
      }
      const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(text);
      if (!m) return json(res, 500, { error: { message: '未检测到有效的 Google 核心鉴权 Cookie (需包含 SID / SAPISID / __Secure-1PSID)', type: 'relay_error', code: 500 } });
      const id = 'acc_' + createHash('sha256').update(m[1] + '|u=0').digest('hex').slice(0, 16);
      sapisidOf.set(id, m[1]);
      st.accounts.set(id, { cookies: text, g1Tier: String(tier || 'TIER0').toUpperCase() });
      return json(res, 200, { ok: true, account: { accountId: id, authUser: 0, g1Tier: st.accounts.get(id)!.g1Tier, status: 'ready' } });
    }
    if (req.method === 'POST' && p === '/api/accounts/remove') {
      st.accounts.delete(body.accountId);
      st.removed.push(body.accountId);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const id = body.accountId;
      if (!st.accounts.has(id)) return json(res, 404, { ok: false, alive: false, error: '未找到该账号' });
      st.tests.push(id);
      const h = st.health.get(sapisidOf.get(id) || '') || 'alive';
      if (h === 'alive') return json(res, 200, { ok: true, alive: true, model: 'gemini-3.5-flash-lite', reply: '42' });
      if (h === 'quota') return json(res, 200, { ok: true, alive: true, quota429: true });
      const error = h === 'dead' ? 'Google GenerateContent HTTP 401: Request had invalid authentication credentials.'
        : h === 'proof' ? 'Proof Server error (503): pool exhausted'
        : h === 'net' ? 'Google GenerateContent network error: fetch failed'
        : 'Google GenerateContent HTTP 500: Internal error encountered.';
      return json(res, 200, { ok: true, alive: false, error });
    }
    if (req.method === 'GET' && p === '/api/status') {
      return json(res, 200, { ok: true, accountCount: st.accounts.size, accounts: [...st.accounts.entries()].map(([id, a]) => ({ accountId: id, g1Tier: a.g1Tier, status: 'ready' })) });
    }
    if (req.method === 'GET' && p === '/v1/models') {
      st.seen.push({ path: p, headers: req.headers, body: null });
      return json(res, 200, { object: 'list', data: [{ id: 'gemini-3.8-flash', object: 'model', owned_by: 'google-aistudio' }] });
    }
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      st.seen.push({ path: p, headers: req.headers, body });
      const model = String(body.model || 'gemini-3.8-flash');
      const { id, allow } = pick(req);
      st.served.push(id);
      if (allow && !id) return json(res, 503, { error: { message: 'no allowed account available', type: 'relay_error', code: 503 } });
      const acc = accountHeader(id, allow);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', ...acc });
        const chunk = (delta: any, extra: any = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: extra.finish || null }], ...(extra.usage ? { usage: extra.usage } : {}) })}\n\n`);
        chunk({ role: 'assistant', content: '' });
        for (const w of ['hello', ' from', ' aistudio']) { await sleep(st.holdMs); chunk({ content: w }); }
        chunk({}, { finish: 'stop', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      for (const [k, v] of Object.entries(acc)) res.setHeader(k, v);
      return json(res, 200, { id: 'chatcmpl-1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'hello from aistudio' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    }
    return json(res, 404, { error: { message: `Route not found: ${req.method} ${p}` } });
  });
  return { server, st };
}
