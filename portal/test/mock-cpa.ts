// A small stand-in for CLIProxyAPI v8 used by the local tests.
// It mimics the management endpoints the portal uses and an agy-scheduler-style picker.
import http from 'node:http';

export type MockCred = { id: string; email: string; disabled: boolean; note?: string; proxy_url?: string; index: string; project_id?: string; updated_at: string; status?: string; status_message?: string; unavailable?: boolean };

export function startMockCPA(opts: { apiKey: string; mgmtKey: string }) {
  const st = {
    creds: new Map<string, MockCred>(),
    plugin: { registered: true, effective_enabled: true },
    queue: [] as any[],
    rogue: null as string | null,     // pick this auth regardless of the allow header
    dropTrace: false,
    seenAllow: [] as string[][],       // raw allow header values per generation request
    lastPick: new Map<string, number>(),
    oauth: new Map<string, { status: string; email?: string }>(),
    nextIndex: 1,
    quota: { gp: 0.9, gf: 0.5, ar: 0.3, cl: 0.1 } as Record<string, number>,
    holdMs: 0,
    seenAgy: [] as { mode: string[]; session: string[]; ttl: string[] }[], // raw X-Agy-Mode / X-Agy-Session per generation request
    claude429: false,                  // answer claude models with 429
    retryFirst: false,                 // queue a failed attempt (429) before the successful one
    recExtra: null as any,             // extra fields merged into the next usage record
    gen: new Map<string, { status: number; body: string }>(), // auth id -> upstream generateContent answer (api-call)
    rt: new Map<string, string>(),    // refresh token -> email Google's userinfo answers with
    files: new Map<string, any>(),     // uploaded credential JSON by id
    credModels: new Map<string, string[]>(), // per-credential model list override
    retry: { 'request-retry': 2, 'max-retry-credentials': 3, 'max-retry-interval': 45 } as Record<string, number>,
  };
  const MODELS = ['gemini-3-flash', 'gemini-3-pro-high', 'claude-sonnet-4-6'];
  const addCred = (id: string, email: string) => {
    const c: MockCred = { id, email, disabled: false, index: (st.nextIndex++).toString(16).padStart(16, 'a'), project_id: 'p-' + id, updated_at: new Date().toISOString() };
    st.creds.set(id, c);
    return c;
  };

  const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
    const b = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers });
    res.end(b);
  };
  const read = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const body = await read(req);
    if (p.startsWith('/v8/management')) {
      if (req.headers.authorization !== 'Bearer ' + opts.mgmtKey) return json(res, 401, { error: 'bad key' });
      const sub = p.slice('/v8/management'.length);
      const b = body.length ? JSON.parse(body.toString()) : {};
      if (sub === '/credentials' && req.method === 'GET') {
        return json(res, 200, { files: [...st.creds.values()].map((c) => ({ id: c.id, name: c.id, auth_index: c.index, type: 'antigravity', provider: 'antigravity', email: c.email, disabled: c.disabled, status: c.disabled ? 'disabled' : c.status || 'active', status_message: c.disabled ? '' : c.status_message || '', unavailable: !c.disabled && !!c.unavailable, note: c.note, project_id: c.project_id, updated_at: c.updated_at })) });
      }
      if (sub === '/credentials' && req.method === 'POST') {
        const name = url.searchParams.get('name')!;
        const j = JSON.parse(body.toString());
        addCred(name, j.email).disabled = !!j.disabled;
        st.files.set(name, j);
        return json(res, 200, { status: 'ok' });
      }
      if (sub === '/credentials' && req.method === 'DELETE') {
        st.creds.delete(url.searchParams.get('name')!);
        return json(res, 200, { status: 'ok' });
      }
      if (sub === '/credentials/status') {
        const c = st.creds.get(b.name);
        if (!c) return json(res, 404, { error: 'auth file not found' });
        c.disabled = !!b.disabled;
        c.status = undefined; c.status_message = ''; c.unavailable = false; // like CPA: a toggle resets the status
        return json(res, 200, { status: 'ok' });
      }
      if (sub === '/credentials/fields') {
        const c = st.creds.get(b.name);
        if (!c) return json(res, 404, { error: 'auth file not found' });
        if ('note' in b) c.note = b.note;
        if ('proxy_url' in b) c.proxy_url = b.proxy_url;
        return json(res, 200, { status: 'ok' });
      }
      if (sub === '/credentials/refresh' && req.method === 'POST') {
        const f = st.files.get(url.searchParams.get('name') || '');
        if (!f) return json(res, 404, { error: 'auth file not found' });
        if (!st.rt.has(f.refresh_token)) return json(res, 400, { error: 'invalid_grant' });
        Object.assign(f, { access_token: 'ya29.mock', expired: new Date(Date.now() + 3600e3).toISOString(), project_id: 'proj-rt' });
        return json(res, 200, { ok: true });
      }
      if (sub === '/credentials/download') {
        const f = st.files.get(url.searchParams.get('name') || '');
        return f ? json(res, 200, f) : json(res, 404, { error: 'auth file not found' });
      }
      if (sub === '/credentials/models') {
        if (!st.creds.has(url.searchParams.get('name') || '')) return json(res, 200, { models: [] });
        const only = st.credModels.get(url.searchParams.get('name') || '');
        const names: Record<string, string> = { 'gemini-3-flash': 'Gemini 3 Flash', 'gemini-3-pro-high': 'Gemini 3 Pro (High)', 'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)' };
        return json(res, 200, { models: (only || MODELS).map((id) => ({ id, display_name: names[id], type: 'antigravity', owned_by: 'antigravity' })) });
      }
      if (sub === '/config/routing/retry' && req.method === 'GET') return json(res, 200, st.retry);
      if (sub.startsWith('/config/routing/retry/') && req.method === 'PUT') {
        st.retry[sub.split('/').pop()!] = Number(body.toString());
        return json(res, 200, { status: 'ok', 'config-version': 8 });
      }
      if (sub === '/plugins') {
        return json(res, 200, { plugins_enabled: true, plugins: [{ id: 'agy-scheduler', registered: st.plugin.registered, enabled: true, effective_enabled: st.plugin.effective_enabled }] });
      }
      if (sub === '/observability/usage/queue') {
        const n = Number(url.searchParams.get('count') || 1);
        return json(res, 200, st.queue.splice(0, n));
      }
      if (sub === '/oauth/auth-url') {
        const state = 'st' + Math.random().toString(36).slice(2, 10);
        st.oauth.set(state, { status: 'wait' });
        return json(res, 200, { status: 'ok', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state, state });
      }
      if (sub === '/oauth/callback') {
        const u = new URL(b.redirect_url);
        const state = u.searchParams.get('state')!;
        const s = st.oauth.get(state);
        if (!s) return json(res, 404, { status: 'error', error: 'unknown or expired state' });
        const email = u.searchParams.get('code') + '@example.invalid'; // test hook: code = mailbox
        setTimeout(() => {
          const id = `antigravity-${email}.json`;
          const ex = st.creds.get(id);
          if (ex) ex.updated_at = new Date(Date.now() + 1000).toISOString();
          else addCred(id, email);
          s.status = 'ok';
        }, 300);
        return json(res, 200, { status: 'ok' });
      }
      if (sub === '/oauth/status') {
        const s = st.oauth.get(url.searchParams.get('state')!);
        if (!s) return json(res, 200, { status: 'error', error: 'unknown or expired state' });
        return json(res, 200, { status: s.status });
      }
      if (sub === '/requests/api-call') {
        if (String(b.url).includes('/userinfo')) {
          const c = [...st.creds.values()].find((x) => x.index === b.auth_index);
          const email = c ? st.rt.get(st.files.get(c.id)?.refresh_token) : undefined;
          return json(res, 200, email ? { status_code: 200, body: JSON.stringify({ email, verified_email: true }) } : { status_code: 401, body: '{}' });
        }
        if (String(b.url).includes(':generateContent')) {
          const c = [...st.creds.values()].find((x) => x.index === b.auth_index);
          if (!c) return json(res, 400, { error: 'auth credential not found for auth_index' });
          const g = st.gen.get(c.id) || { status: 200, body: '{"response":{}}' };
          return json(res, 200, { status_code: g.status, body: g.body });
        }
        if (String(b.url).includes('fetchAvailableModels')) {
          return json(res, 200, { status_code: 200, body: JSON.stringify({ models: {
            'gemini-3-pro-high': { quotaInfo: { remainingFraction: st.quota.gp, resetTime: new Date(Date.now() + 3600e3).toISOString() } },
            'gemini-4-argon-high': { quotaInfo: { remainingFraction: st.quota.ar, resetTime: new Date(Date.now() + 5 * 86400e3).toISOString() } },
            'gemini-3-flash': { quotaInfo: { remainingFraction: st.quota.gf, resetTime: new Date(Date.now() + 7200e3).toISOString() } },
            'claude-sonnet-4-6': { quotaInfo: { remainingFraction: st.quota.cl, resetTime: new Date(Date.now() + 86400e3).toISOString() } },
          } }) });
        }
        if (String(b.url).includes('retrieveUserQuotaSummary')) {
          const bk = (id: string, w: string, f: number, h: number) => ({ bucketId: id, displayName: w === '5h' ? 'Five Hour Limit Remaining' : 'Weekly Limit Remaining', window: w, remainingFraction: f, resetTime: new Date(Date.now() + h * 3600e3).toISOString() });
          return json(res, 200, { status_code: 200, body: JSON.stringify({ groups: [
            { displayName: 'Claude and GPT models', buckets: [bk('3p-weekly', 'weekly', 0.8, 100), bk('3p-5h', '5h', st.quota.cl, 3)] },
            { displayName: 'Gemini Models', buckets: [bk('gemini-weekly', 'weekly', 1, 150), bk('gemini-5h', '5h', 1, 4)] },
          ] }) });
        }
        if (String(b.url).includes('loadCodeAssist')) {
          return json(res, 200, { status_code: 200, body: JSON.stringify({ paidTier: { id: 'g1-pro-tier', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1000' }] } }) });
        }
        return json(res, 200, { status_code: 404, body: '' });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---- data plane ----
    if (req.headers.authorization !== 'Bearer ' + opts.apiKey) return json(res, 401, { error: 'invalid api key' });
    if (req.method === 'GET') return json(res, 200, { object: 'list', data: [...MODELS, 'gpt-nobody-has'].map((id) => ({ id, object: 'model' })) });
    const raw: string[] = [];
    const agy = { mode: [] as string[], session: [] as string[], ttl: [] as string[] };
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase(), v = req.rawHeaders[i + 1];
      if (k === 'x-agy-allow') raw.push(v);
      else if (k === 'x-agy-mode') agy.mode.push(v);
      else if (k === 'x-agy-session') agy.session.push(v);
      else if (k === 'x-agy-session-ttl') agy.ttl.push(v);
    }
    st.seenAllow.push(raw);
    st.seenAgy.push(agy);
    if (raw.length !== 1) return json(res, 500, { error: { message: 'agy_allow_invalid' } });
    const allowed = raw[0].split(',').map((x) => x.trim()).filter(Boolean);
    let pick: MockCred | undefined;
    if (st.rogue) pick = st.creds.get(st.rogue);
    else {
      const cands = [...st.creds.values()].filter((c) => !c.disabled && allowed.includes(c.id));
      cands.sort((a, b) => (st.lastPick.get(a.id) || 0) - (st.lastPick.get(b.id) || 0));
      pick = cands[0];
    }
    if (!pick) return json(res, 503, { error: { message: 'auth_unavailable: no allowed account is available for this request' } });
    st.lastPick.set(pick.id, Date.now() + Math.random());
    const rid = Math.random().toString(16).slice(2, 10);
    const trace = `20261024120000-${pick.index}-${rid}`;
    let j: any = {};
    try { j = JSON.parse(body.toString()); } catch {}
    const model = j.model || (/models\/([^:]+)/.exec(p)?.[1] ?? '');
    const h: Record<string, string> = st.dropTrace ? {} : { 'X-CPA-TRACE-ID': trace };
    // like CPA: an unknown model never reaches the scheduler
    if (model && !MODELS.includes(model)) return json(res, 502, { error: { message: 'unknown provider for model ' + model, type: 'invalid_request_error', code: 'model_not_found' } });
    const base = { request_id: rid, auth_index: pick.index, alias: model, model, endpoint: p, ttft_ms: 0, latency_ms: 0, reasoning_effort: '' };
    if (st.claude429 && model.includes('claude')) {
      st.queue.push({ ...base, failed: true, fail: { status_code: 429, body: 'UPSTREAM-SECRET-BODY quota exhausted' }, tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
      return json(res, 429, { error: { message: 'RESOURCE_EXHAUSTED: quota exhausted', type: 'rate_limit' } }, h);
    }
    if (st.retryFirst) st.queue.push({ ...base, failed: true, fail: { status_code: 429, body: 'UPSTREAM-SECRET-BODY rate limited' }, tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    st.queue.push({ ...base, failed: false, fail: { status_code: 200, body: '' }, tokens: { input_tokens: 3, output_tokens: 4, reasoning_tokens: 0, cached_tokens: 2, cache_read_tokens: 0, total_tokens: 7 }, ...(st.recExtra || {}) });
    if (j.stream || p.includes('stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...h });
      res.write(`data: {"text":"hello "}\n\n`);
      await new Promise((r) => setTimeout(r, 30 + st.holdMs));
      res.write(`data: {"text":"from ${pick.id}"}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    return json(res, 200, { served_by: pick.id, choices: [{ message: { content: 'hello from ' + pick.id } }] }, h);
  });
  return { server, st, addCred };
}
