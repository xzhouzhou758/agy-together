import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';

const API_KEY = 'cpa-test-key', MGMT = 'cpa-test-mgmt', RELAY_KEY = 'relay-test-key';
const AIS2_KEY = 'ais2-proxy-key', AIS2_PASS = 'ais2-admin-pass';

function startMockAIS2() {
  const st = {
    running: false,
    logins: 0,
    token: 'tok-1',
    accounts: new Map<string, { id: string; state: string; benefit_tier: string; enabled: boolean; message?: string }>(),
    tasks: new Map<string, any>(),
    seenGen: [] as Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>,
    failNextFor: new Map<string, number>(), // email -> HTTP status to fail once
    importFail: new Map<string, string>(), // email -> error
    refreshState: new Map<string, string>(), // email -> next state on /refresh
  };

  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const P = url.pathname;
    const M = (req.method || 'GET').toUpperCase();
    const send = (code: number, obj: unknown, extraHeaders: Record<string, string> = {}) => {
      const b = obj === null ? '' : JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
      res.end(b);
    };

    if (P.startsWith('/api/')) {
      if (P === '/api/auth/login' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        if (j.username !== 'admin' || j.password !== AIS2_PASS) return send(401, { error: { message: 'bad credentials' } });
        st.logins++;
        st.token = 'tok-' + st.logins;
        return send(200, { authenticated: true, username: 'admin' }, { 'Set-Cookie': `aistudio_admin=${st.token}; Path=/api; HttpOnly` });
      }
      const ck = String(req.headers.cookie || '');
      if (!ck.includes(`aistudio_admin=${st.token}`)) {
        return send(401, { error: { code: 'admin_auth_required', message: '需要管理员登录' } });
      }
      if (P === '/api/status' && M === 'GET') {
        return send(200, { state: st.running ? 'running' : 'stopped', running: st.running, ready: st.running, accounts: { total: st.accounts.size } });
      }
      if (P === '/api/control/start' && M === 'POST') {
        st.running = true;
        return send(200, { running: true });
      }
      if (P === '/api/accounts' && M === 'GET') {
        return send(200, { accounts: [...st.accounts.values()] });
      }
      if (P === '/api/accounts/import/cookies/discover' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        const c = String(j.cookies || '');
        const m = /SAPISID=([a-zA-Z0-9._@-]+)/.exec(c);
        if (!m) return send(400, { error: { message: '缺少 SAPISID Cookie' } });
        const tag = m[1];
        if (tag === 'signedout') return send(200, { accounts: [{ email: 'out@gmail.com', auth_user: 0, signed_out: true, restricted: false, device_bound: false }] });
        if (tag === 'restricted') return send(200, { accounts: [{ email: 'ban@gmail.com', auth_user: 0, signed_out: false, restricted: true, device_bound: false }] });
        const email = tag.includes('@') ? tag.toLowerCase() : `${tag.toLowerCase()}@example.invalid`;
        return send(200, { accounts: [{ email, auth_user: 0, imported: st.accounts.has(email), signed_out: false, restricted: false, device_bound: tag.startsWith('db_') }] });
      }
      if (P === '/api/accounts/import/cookies' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        const item = j.items?.[0];
        const email = String(item?.email || '').toLowerCase();
        const tid = 'task-' + (++seq);
        const failErr = st.importFail.get(email);
        const task: any = { id: tid, kind: 'cookie', state: 'running', items: [{ label: email, state: 'running' }] };
        st.tasks.set(tid, task);
        setTimeout(() => {
          if (failErr) {
            task.state = 'failed';
            task.items = [{ label: email, state: 'failed', error: failErr }];
          } else {
            st.accounts.set(email, { id: email, state: 'ready', benefit_tier: 'pro', enabled: true });
            task.state = 'done';
            task.items = [{ label: email, state: 'done' }];
          }
        }, 40);
        return send(202, { task });
      }
      if (P === '/api/accounts/tasks' && M === 'GET') {
        return send(200, { tasks: [...st.tasks.values()] });
      }
      if (P.startsWith('/api/accounts/tasks/') && M === 'DELETE') {
        const tid = decodeURIComponent(P.slice('/api/accounts/tasks/'.length));
        st.tasks.delete(tid);
        res.writeHead(204).end();
        return;
      }
      if (P.startsWith('/api/accounts/') && P.endsWith('/refresh') && M === 'POST') {
        const email = decodeURIComponent(P.slice('/api/accounts/'.length, -'/refresh'.length)).toLowerCase();
        const acc = st.accounts.get(email);
        if (!acc) return send(404, { error: { message: 'not found' } });
        const next = st.refreshState.get(email);
        if (next) acc.state = next;
        return send(200, { account: acc, tier: acc.benefit_tier });
      }
      if (P.startsWith('/api/accounts/') && M === 'DELETE') {
        const email = decodeURIComponent(P.slice('/api/accounts/'.length)).toLowerCase();
        st.accounts.delete(email);
        res.writeHead(204).end();
        return;
      }
    }

    // Generation plane
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer ' + AIS2_KEY) return send(401, { error: { message: 'bad api key' } });
    st.seenGen.push({ method: M, url: url.pathname + url.search, headers: req.headers, body: raw });

    if (M === 'GET' && P === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'gemini-4-hydrogen', object: 'model', name: 'Gemini 4 Hydrogen', default_thinking_level: 'high', thinking_levels: ['low', 'medium', 'high', 'extra_high'] },
          { id: 'gemini-4-argon', object: 'model', name: 'Gemini 4 Argon', default_thinking_level: 'medium', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'gemini-3.8-flash', object: 'model', name: 'Gemini 3.8 Flash', default_thinking_level: 'medium', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'gemini-2.5-pro', object: 'model', name: 'Gemini 2.5 Pro' },
          { id: 'gemini-4-argon-search', object: 'model', name: 'Gemini 4 Argon (Search)' },
          { id: 'gemini-4-hydrogen-build', object: 'model', name: 'Gemini 4 Hydrogen (Build)' },
          { id: 'gemini-3.8-flash-tts', object: 'model', name: 'Gemini 3.8 Flash TTS' },
          { id: 'lyria-3.5', object: 'model', name: 'Lyria 3.5' },
        ],
      });
    }
    if (M === 'GET' && P === '/v1beta/models') {
      return send(200, {
        models: [
          { name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', defaultThinkingLevel: 'HIGH', thinkingLevels: ['LOW', 'MEDIUM', 'HIGH', 'EXTRA_HIGH'] },
          { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', defaultThinkingLevel: 'MEDIUM', thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'] },
          { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', defaultThinkingLevel: 'MEDIUM', thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'] },
        ],
      });
    }
    if (M === 'GET' && P.startsWith('/v1/models/')) {
      const mid = decodeURIComponent(P.slice('/v1/models/'.length));
      if (!['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-2.5-pro'].includes(mid)) {
        return send(404, { error: { message: 'model not found: ' + mid } });
      }
      return send(200, { id: mid, object: 'model' });
    }

    const pinned = String(req.headers['x-aistudio-account'] || '').toLowerCase();
    if (!pinned || !st.accounts.has(pinned)) return send(503, { error: { message: 'account unavailable: ' + pinned } });
    const failStatus = st.failNextFor.get(pinned);
    if (failStatus) {
      st.failNextFor.delete(pinned);
      return send(failStatus, { error: { message: 'simulated failure ' + failStatus } });
    }

    if (P === '/v1/messages') {
      return send(200, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'claude-via-' + pinned }], usage: { input_tokens: 11, output_tokens: 7 } }, { 'X-AIStudio-Internal': 'secret' });
    }
    if (P === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 13, output_tokens: 9 } } })}\n\n`);
      return;
    }
    if (P === '/v1/images/generations') {
      return send(200, { created: 1, data: [{ b64_json: 'AAAA' }], usage: { input_tokens: 4, output_tokens: 20 } });
    }
    if (P.startsWith('/v1beta/models/')) {
      return send(200, { candidates: [{ content: { parts: [{ text: 'gemini-native-' + pinned }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 } });
    }
    return send(200, {
      id: 'chat_1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ais2-from-' + pinned } }],
      usage: { prompt_tokens: 8, completion_tokens: 5 },
    });
  });

  return { server, st };
}

const cpaMock = startMockCPA({ apiKey: API_KEY, mgmtKey: MGMT });
const ais2 = startMockAIS2();
let portal: ChildProcess;
let base = '';
let dataDir = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  cookie = '';
  async req(method: string, path: string, body?: any) {
    const headers: Record<string, string> = { 'X-Portal-CSRF': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    let b: any;
    if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const r = await fetch(base + path, { method, headers, body: b });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('agy_sid=')) this.cookie = c.split(';')[0];
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, data };
  }
  async login(id: string, name: string, admin = false) {
    assert.equal((await this.req('POST', '/api/dev-login', { discordId: id, name, admin })).status, 200);
    return this;
  }
}

const cookieFor = (sapisid: string, wrap = false) => {
  const c = `SID=sid-${sapisid}; HSID=h; SSID=s; APISID=a; SAPISID=${sapisid}; __Secure-1PSID=p1; __Secure-3PSID=p3`;
  return wrap ? JSON.stringify({ cookies: c, authUser: 0, g1Tier: 'TIER1' }) : c;
};

function lastUsage() {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const d = new DatabaseSync(join(dataDir, 'portal.db'), { readOnly: true });
    const r = d.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT 1').get() as any;
    d.close();
    return r;
  });
}

const admin = new Client(), dave = new Client(), erin = new Client();
const K: Record<string, string> = {};

before(async () => {
  await new Promise<void>((r) => cpaMock.server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => ais2.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (cpaMock.server.address() as AddressInfo).port;
  const ais2Port = (ais2.server.address() as AddressInfo).port;
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-ais2-'));
  const port = 20000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  portal = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
      CPA_URL: `http://127.0.0.1:${cpaPort}`, CPA_API_KEY: API_KEY, CPA_MANAGEMENT_KEY: MGMT,
      DEV_LOGIN: '1', COOKIE_SECURE: '0', USAGE_POLL_MS: '200',
      QUOTA_REFRESH_MINUTES: '0', ROLE_RECHECK_MINUTES: '0', PLUGIN_CHECK_CACHE_MS: '100',
      AISTUDIO2_URL: `http://127.0.0.1:${ais2Port}`, AISTUDIO2_API_KEY: AIS2_KEY,
      AISTUDIO2_ADMIN_USER: 'admin', AISTUDIO2_ADMIN_PASSWORD: AIS2_PASS, AISTUDIO2_RECHECK_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(100);
  }
  await admin.login('400001', 'admin', true);
  await dave.login('400002', 'dave');
  await erin.login('400003', 'erin');
});

after(() => {
  portal?.kill();
  cpaMock.server.close();
  ais2.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('aistudio2: config flag, key creation, refused without valid account', async () => {
  const cfg = (await new Client().req('GET', '/api/config')).data;
  assert.equal(cfg.aistudio, undefined);
  assert.equal(cfg.aistudio2, true);
  const k = await dave.req('POST', '/api/keys', { name: 'ais2-d', pool: 'aistudio2' });
  assert.equal(k.status, 200);
  assert.equal(k.data.pool, 'aistudio2');
  K.dave = k.data.key;
  K.erin = (await erin.req('POST', '/api/keys', { name: 'ais2-e', pool: 'aistudio2' })).data.key;

  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 403);
  assert.equal((await lastUsage()).pool, 'aistudio2');
  assert.equal((await lastUsage()).result, 'no_account');
});

test('aistudio2 upload: rejects signed-out / restricted / failed cookies, accepts valid & starts service', async () => {
  assert.equal((await dave.req('POST', '/api/aistudio2', { cookies: cookieFor('signedout') })).status, 400);
  assert.equal((await dave.req('POST', '/api/aistudio2', { cookies: cookieFor('restricted') })).status, 400);

  ais2.st.importFail.set('bad1@example.invalid', 'invalid cookie');
  const dead = await dave.req('POST', '/api/aistudio2', { cookies: cookieFor('bad1') });
  assert.equal(dead.status, 400);
  assert.equal(ais2.st.accounts.size, 0);

  // Valid upload via Tampermonkey JSON wrapper + admin session re-login check
  ais2.st.token = 'expired-token';
  const ok = await dave.req('POST', '/api/aistudio2', { cookies: cookieFor('dave1', true) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.id, /^ais2_[0-9a-f]{16}$/);
  assert.equal(ok.data.label, 'dave1@example.invalid');
  assert.equal(ok.data.tier, 'PRO');
  assert.equal(ais2.st.running, true, 'auto-started generation plane');
  K.daveAcc = ok.data.id;

  // Another user trying to upload dave's email -> 409 before touching import
  const taken = await erin.req('POST', '/api/aistudio2', { cookies: cookieFor('dave1') });
  assert.equal(taken.status, 409);
});

test('retired pool endpoints and key creation are unavailable; new uploads work alone', async () => {
  assert.equal((await erin.req('POST', '/api/aistudio', { cookies: cookieFor('erin1') })).status, 404);
  assert.equal((await erin.req('POST', '/api/keys', { name: 'retired', pool: 'aistudio' })).status, 400);
  const uploaded = await erin.req('POST', '/api/aistudio2', { cookies: cookieFor('erin1') });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  K.erinAcc = uploaded.data.id;
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(dataDir, 'portal.db'), { readOnly: true });
  assert.equal(d.prepare("SELECT name FROM sqlite_master WHERE name='aistudio_accounts'").get(), undefined);
  d.close();
});

test('global sharing is admin-only and closed requests never use another owner', async () => {
  assert.equal((await dave.req('PUT', '/api/admin/aistudio2/sharing', { enabled: false })).status, 403);
  assert.equal((await admin.req('PUT', '/api/admin/aistudio2/sharing', { enabled: 'false' })).status, 400);
  assert.equal((await admin.req('PUT', '/api/admin/aistudio2/sharing', { enabled: false })).data.enabled, false);
  assert.equal((await admin.req('GET', '/api/config')).data.aistudio2Sharing, false);
  const call = () => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' }, body: JSON.stringify({model:'gemini-2.5-pro',messages:[{role:'user',content:'hi'}]}) });
  const own = await call();
  assert.equal((await own.json()).choices[0].message.content, 'ais2-from-dave1@example.invalid');
  ais2.st.failNextFor.set('dave1@example.invalid', 429);
  assert.equal((await call()).status, 429, 'must not fail over to Erin when sharing is closed');
  assert.equal((await dave.req('GET', '/api/aistudio2')).data[0].shared, true, 'individual preference preserved');
  assert.equal((await admin.req('PUT', '/api/admin/aistudio2/sharing', { enabled: true })).data.enabled, true);
});

test('aistudio2 gateway: multi-protocol support, header sanitization, failover, and account privacy', async () => {
  // 1. Failover: make dave1 fail once with 429 -> gateway automatically fails over to erin1!
  ais2.st.failNextFor.set('dave1@example.invalid', 429);
  ais2.st.failNextFor.set('erin1@example.invalid', 0);

  // Force deterministic test: make dave1 fail with 429; whether dave1 or erin1 is tried first, request succeeds on erin1!
  const r1 = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + K.dave,
      'Content-Type': 'application/json',
      'X-AIStudio-Account': 'evil@example.invalid',
    },
    body: JSON.stringify({ model: 'gemini-2.5-pro', reasoning_effort: 'minimal', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.choices[0].message.content, 'ais2-from-erin1@example.invalid');
  assert.equal(r1.headers.get('x-aistudio-internal'), null);

  // Verify privacy in dave's traffic log: erin's email must NOT appear!
  const tr = (await dave.req('GET', '/api/traffic?pool=aistudio2')).data;
  const trStr = JSON.stringify(tr);
  assert.ok(!trStr.includes('erin1@example.invalid'), 'other user email hidden in traffic');
  assert.ok(tr.rows.some((x: any) => /^共享账号 #\d+/.test(x.account || '')));

  // 2. Claude /v1/messages
  const r2 = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-pro', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r2.status, 200);
  assert.match((await r2.json()).content[0].text, /^claude-via-/);
  await sleep(30);
  assert.equal((await lastUsage()).in_tok, 11);
  assert.equal((await lastUsage()).out_tok, 7);

  // 3. OpenAI Responses /v1/responses SSE token sniffing
  const r3 = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-pro', stream: true, input: 'hi' }),
  });
  assert.equal(r3.status, 200);
  await r3.text();
  await sleep(30);
  assert.equal((await lastUsage()).in_tok, 13);
  assert.equal((await lastUsage()).out_tok, 9);

  // 4. Images /v1/images/generations
  const r4 = await fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'imagen-3', prompt: 'a cat' }),
  });
  assert.equal(r4.status, 200);

  // 5. Gemini native /v1beta/models/... with ?key= stripped from upstream URL
  const r5 = await fetch(base + `/v1beta/models/gemini-2.5-pro:generateContent?alt=json&key=${K.dave}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(r5.status, 200);
  assert.equal(ais2.st.seenGen.at(-1)!.url, '/v1beta/models/gemini-2.5-pro:generateContent?alt=json');
});

test('aistudio2 thinking-level tier expansion and multi-protocol mapping', async () => {
  // 1. OpenAI /v1/models expands Argon, Hydrogen (including xhigh), and 3.8 Flash
  const ml = await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.dave } })).json();
  const ids = ml.data.map((m: any) => m.id);
  for (const exp of [
    'gemini-4-hydrogen', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
    'gemini-4-argon', 'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
    'gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  ]) {
    assert.ok(ids.includes(exp), 'missing expanded model: ' + exp);
  }
  assert.ok(!ids.includes('gemini-4-argon-xhigh'), 'argon should not list xhigh');
  // By default ais2Slim = true: noisy -search / -build / -tts / lyria are hidden!
  assert.equal((await dave.req('GET', '/api/me')).data.ais2Slim, true);
  assert.ok(!ids.includes('gemini-4-argon-search'), 'slim hides -search');
  assert.ok(!ids.includes('gemini-4-hydrogen-build'), 'slim hides -build');
  assert.ok(!ids.includes('gemini-3.8-flash-tts'), 'slim hides -tts');
  assert.ok(!ids.includes('lyria-3.5'), 'slim hides lyria');

  // Toggling ais2Slim = false reveals the full catalog for this user only
  assert.equal((await dave.req('PATCH', '/api/me', { ais2Slim: false })).status, 200);
  const mlFull = await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.dave } })).json();
  const fullIds = mlFull.data.map((m: any) => m.id);
  for (const noisy of ['gemini-4-argon-search', 'gemini-4-hydrogen-build', 'gemini-3.8-flash-tts', 'lyria-3.5']) {
    assert.ok(fullIds.includes(noisy), 'full list includes: ' + noisy);
  }
  assert.equal((await dave.req('PATCH', '/api/me', { ais2Slim: true })).status, 200);

  // 2. Gemini /v1beta/models expansion & single-model lookup
  const gml = await (await fetch(base + `/v1beta/models?key=${K.dave}`)).json();
  const gnames = gml.models.map((m: any) => m.name);
  assert.ok(gnames.includes('models/gemini-4-hydrogen-xhigh'));
  assert.ok(gnames.includes('models/gemini-4-argon-high'));
  assert.ok(gnames.includes('models/gemini-3.8-flash-low'));

  const single = await fetch(base + '/v1/models/gemini-4-hydrogen-xhigh', { headers: { Authorization: 'Bearer ' + K.dave } });
  assert.equal(single.status, 200);
  assert.equal((await single.json()).id, 'gemini-4-hydrogen-xhigh');
  assert.equal(ais2.st.seenGen.at(-1)!.url, '/v1/models/gemini-4-hydrogen');

  // 3. OpenAI Chat: model suffix wins over conflicting client reasoning_effort / extra_body
  const rc = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-4-hydrogen-xhigh',
      reasoning_effort: 'minimal',
      extra_body: { google: { thinking_config: { thinking_level: 'low', include_thoughts: true } } },
      messages: [{ role: 'user', content: 'solve' }],
    }),
  });
  assert.equal(rc.status, 200);
  const chatUp = JSON.parse(ais2.st.seenGen.at(-1)!.body);
  assert.equal(chatUp.model, 'gemini-4-hydrogen');
  assert.equal(chatUp.reasoning_effort, 'xhigh');
  assert.equal(chatUp.extra_body.google.thinking_config.thinking_level, 'xhigh');
  assert.equal(chatUp.extra_body.google.thinking_config.include_thoughts, true);
  await sleep(30);
  const uChat = await lastUsage();
  assert.equal(uChat.requested_model, 'gemini-4-hydrogen-xhigh');
  assert.equal(uChat.upstream_model, 'gemini-4-hydrogen');
  assert.equal(uChat.reasoning_effort, 'xhigh');

  // 4. Claude /v1/messages: sets output_config.effort and clears disabled thinking
  const rm = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-4-argon-high',
      max_tokens: 256,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(rm.status, 200);
  const msgUp = JSON.parse(ais2.st.seenGen.at(-1)!.body);
  assert.equal(msgUp.model, 'gemini-4-argon');
  assert.equal(msgUp.output_config.effort, 'high');
  assert.equal(msgUp.thinking, undefined);

  // 5. Responses /v1/responses: sets reasoning.effort and updates configuration_update
  const rr = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3.8-flash-low',
      stream: true,
      input: [
        { type: 'configuration_update', reasoning: { effort: 'high' } },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    }),
  });
  assert.equal(rr.status, 200);
  await rr.text();
  const respUp = JSON.parse(ais2.st.seenGen.at(-1)!.body);
  assert.equal(respUp.model, 'gemini-3.8-flash');
  assert.equal(respUp.reasoning.effort, 'low');
  assert.equal(respUp.input[0].reasoning.effort, 'low');

  // 6. Gemini native /v1beta/models/<id>:generateContent: rewrites URL & injects thinkingConfig.thinkingLevel
  const rg = await fetch(base + `/v1beta/models/gemini-4-argon-medium-search:generateContent?alt=json&key=${K.dave}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(rg.status, 200);
  assert.equal(ais2.st.seenGen.at(-1)!.url, '/v1beta/models/gemini-4-argon-search:generateContent?alt=json');
  const gemUp = JSON.parse(ais2.st.seenGen.at(-1)!.body);
  assert.equal(gemUp.generationConfig.thinkingConfig.thinkingLevel, 'medium');
});

test('aistudio2 recheck, sweep, and delete', async () => {
  ais2.st.refreshState.set('dave1@example.invalid', 'auth_required');
  const chk = await dave.req('POST', `/api/aistudio2/${K.daveAcc}/check`);
  assert.equal(chk.status, 200);
  assert.equal(chk.data.state, 'dead');
  assert.equal(ais2.st.accounts.has('dave1@example.invalid'), false, 'dead account removed from backend');

  // Delete erin's account
  const del = await erin.req('DELETE', `/api/aistudio2/${K.erinAcc}`);
  assert.equal(del.status, 200);
  assert.equal(ais2.st.accounts.has('erin1@example.invalid'), false);
});
