// AI Studio pool: cookie upload / re-check against a mock relay, eligibility, and the gateway passthrough.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';
import { startMockRelay } from './mock-relay.ts';

const API_KEY = 'cpa-test-key', MGMT = 'cpa-test-mgmt', RELAY_KEY = 'relay-test-key';
const cpaMock = startMockCPA({ apiKey: API_KEY, mgmtKey: MGMT });
const relay = startMockRelay({ apiKey: RELAY_KEY });
let portal: ChildProcess;
let base = '';
let dataDir = '';
let logs = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  cookie = '';
  async req(method: string, path: string, body?: any, raw?: Buffer) {
    const headers: Record<string, string> = { 'X-Portal-CSRF': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    let b: any;
    if (raw) { b = raw; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
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
const cookieOf = (sapisid: string, json = false) => {
  const c = `SID=sid-${sapisid}; HSID=h; SSID=s; APISID=a; SAPISID=${sapisid}; __Secure-1PSID=p1; __Secure-3PSID=p3`;
  return json ? JSON.stringify({ cookies: c, authUser: 0, g1Tier: 'TIER1' }) : c;
};
async function chat(key: string, opts: { stream?: boolean; path?: string; headers?: Record<string, string>; model?: string; extra?: Record<string, unknown> } = {}) {
  const r = await fetch(base + (opts.path || '/v1/chat/completions'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify({ model: opts.model || 'gemini-3.8-flash', stream: !!opts.stream, messages: [{ role: 'user', content: 'hi' }], ...(opts.extra || {}) }),
  });
  return { status: r.status, text: await r.text(), ct: r.headers.get('content-type') || '' };
}
function lastUsage(userId?: number) {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const d = new DatabaseSync(join(dataDir, 'portal.db'), { readOnly: true });
    const r = d.prepare(`SELECT * FROM usage ${userId ? 'WHERE user_id = ?' : ''} ORDER BY id DESC LIMIT 1`).get(...(userId ? [userId] : [])) as any;
    d.close();
    return r;
  });
}

const admin = new Client(), dave = new Client(), erin = new Client();
const K: Record<string, string> = {};

before(async () => {
  await new Promise<void>((r) => cpaMock.server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (cpaMock.server.address() as AddressInfo).port, relayPort = (relay.server.address() as AddressInfo).port;
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-ais-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  portal = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_API_KEY: API_KEY, CPA_MANAGEMENT_KEY: MGMT, DEV_LOGIN: '1', COOKIE_SECURE: '0', USAGE_POLL_MS: '200',
      QUOTA_REFRESH_MINUTES: '0', ROLE_RECHECK_MINUTES: '0', PLUGIN_CHECK_CACHE_MS: '100',
      AISTUDIO_RELAY_URL: `http://127.0.0.1:${relayPort}`, AISTUDIO_RELAY_KEY: RELAY_KEY, AISTUDIO_RECHECK_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  portal.stdout!.on('data', (d) => (logs += d));
  portal.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(100);
  }
  await admin.login('300001', 'admin', true);
  await dave.login('300002', 'dave');
  await erin.login('300003', 'erin');
});

after(() => {
  portal?.kill();
  cpaMock.server.close();
  relay.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('aistudio: config flag, key pool, not eligible without a valid account', async () => {
  assert.equal((await new Client().req('GET', '/api/config')).data.aistudio, true);
  const k = await dave.req('POST', '/api/keys', { name: 'ais', pool: 'aistudio' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  assert.equal(k.data.pool, 'aistudio');
  K.dave = k.data.key;
  K.erin = (await erin.req('POST', '/api/keys', { name: 'ais', pool: 'aistudio' })).data.key;
  assert.equal((await dave.req('PATCH', '/api/keys/' + k.data.id, { pool: 'aistudio' })).data.pool, 'aistudio');
  const r = await chat(K.dave);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error.message, '你在 AI Studio 池里没有有效的号，上传一个有效 Cookie 后即可使用');
  assert.equal(relay.st.seen.length, 0, 'relay must not be called');
  const u = await lastUsage();
  assert.equal(u.pool, 'aistudio');
  assert.equal(u.status, 403);
  assert.equal(u.result, 'no_account');
});

test('aistudio upload: incomplete cookie shows the relay message; dead cookie is rejected and removed', async () => {
  const bad = await dave.req('POST', '/api/aistudio', { cookies: 'SID=x; NID=y' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'aistudio_cookie');
  assert.match(bad.data.message, /核心鉴权 Cookie/);

  relay.st.health.set('dead1', 'dead');
  const dead = await dave.req('POST', '/api/aistudio', { cookies: cookieOf('dead1') });
  assert.equal(dead.status, 400);
  assert.equal(dead.data.error, 'aistudio_dead');
  assert.match(dead.data.message, /无效/);
  assert.equal(relay.st.accounts.size, 0, 'dead account taken back out of the relay');
  assert.deepEqual((await dave.req('GET', '/api/aistudio')).data, []);
  assert.equal((await chat(K.dave)).status, 403);

  // can't verify (proof server down): not kept either, the user is told to retry
  relay.st.health.set('flaky1', 'proof');
  const flaky = await dave.req('POST', '/api/aistudio', { cookies: cookieOf('flaky1') });
  assert.equal(flaky.status, 503);
  assert.equal(flaky.data.error, 'aistudio_check_failed');
  assert.equal(relay.st.accounts.size, 0);
});

test('aistudio upload: valid -> owned + eligible; another user is refused; owner re-upload refreshes', async () => {
  const ok = await dave.req('POST', '/api/aistudio', { cookies: cookieOf('good1', true) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'valid');
  assert.equal(ok.data.tier, 'TIER1');
  assert.match(ok.data.id, /^acc_/);
  K.acc1 = ok.data.id;
  assert.ok(relay.st.accounts.has(K.acc1));
  const list = (await dave.req('GET', '/api/aistudio')).data;
  assert.equal(list.length, 1);
  assert.ok(list[0].checkedAt > 0);
  assert.ok(!JSON.stringify(list).includes('good1'), 'no cookie material in the view');
  // cookies are never stored in the portal database
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(dataDir, 'portal.db'), { readOnly: true });
  const dump = JSON.stringify(d.prepare('SELECT * FROM aistudio_accounts').all()) + JSON.stringify(d.prepare('SELECT * FROM settings').all());
  d.close();
  assert.ok(!dump.includes('good1') && !dump.includes('SAPISID'));

  // eligible right away
  const r = await chat(K.dave);
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /hello from aistudio/);

  // same Google account from erin -> refused, dave keeps it, it stays in the relay
  const taken = await erin.req('POST', '/api/aistudio', { cookies: cookieOf('good1') });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.message, '这个号已经被别人上传过');
  assert.ok(relay.st.accounts.has(K.acc1));
  assert.deepEqual((await erin.req('GET', '/api/aistudio')).data, []);
  assert.equal((await chat(K.erin)).status, 403);
  // erin can't re-check or delete dave's account
  assert.equal((await erin.req('POST', `/api/aistudio/${K.acc1}/check`)).status, 404);
  assert.equal((await erin.req('DELETE', `/api/aistudio/${K.acc1}`)).status, 404);

  // dave uploads the same account again: refreshed, re-tested, still one row
  const n = relay.st.tests.length;
  const again = await dave.req('POST', '/api/aistudio', { cookies: cookieOf('good1') });
  assert.equal(again.status, 200);
  assert.equal(relay.st.tests.length, n + 1);
  assert.equal((await dave.req('GET', '/api/aistudio')).data.length, 1);
});

test('aistudio gateway: relay key swapped in, client auth / forwarding / X-Agy headers stripped, usage recorded', async () => {
  const before = relay.st.seen.length;
  const r = await chat(K.dave, { headers: { 'X-Forwarded-For': '1.2.3.4', 'X-Agy-Allow': 'evil', Cookie: 'a=b', 'X-Api-Key': 'leak' } });
  assert.equal(r.status, 200);
  const seen = relay.st.seen[before];
  assert.equal(seen.headers.authorization, 'Bearer ' + RELAY_KEY);
  assert.equal(seen.headers['x-forwarded-for'], undefined);
  assert.equal(seen.headers['x-agy-allow'], undefined);
  assert.equal(seen.headers['x-api-key'], undefined);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.body.model, 'gemini-3.8-flash');
  const u = await lastUsage();
  assert.equal(u.pool, 'aistudio');
  assert.equal(u.result, 'ok');
  assert.equal(u.status, 200);
  assert.equal(u.auth_id, K.acc1, 'served account recorded');
  assert.equal(u.owner_id, u.user_id);
  assert.equal(u.model, 'gemini-3.8-flash');
  assert.equal(u.stream, 0);
  assert.equal(u.in_tok, 5);
  assert.equal(u.out_tok, 3);

  // model list comes from the relay
  const m = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.dave } });
  assert.equal(m.status, 200);
  assert.equal((await m.json()).data[0].id, 'gemini-3.8-flash');

  // anything else: 404 in OpenAI format, never forwarded
  const cnt = relay.st.seen.length;
  for (const path of ['/v1/messages', '/v1/responses', '/v1beta/models/gemini-3.8-flash:generateContent']) {
    const x = await chat(K.dave, { path });
    assert.equal(x.status, 404, path);
    assert.match(JSON.parse(x.text).error.message, /只支持 \/v1\/chat\/completions/);
  }
  assert.equal(relay.st.seen.length, cnt);
});

test('aistudio gateway: thinking level MINIMAL is lifted to low on non-Flash models; a -high suffix wins', async () => {
  const sent = async (model: string, extra: Record<string, unknown>) => {
    const before = relay.st.seen.length;
    assert.equal((await chat(K.dave, { model, extra })).status, 200);
    return relay.st.seen[before].body;
  };
  assert.equal((await sent('gemini-4-argon', { reasoning_effort: 'minimal' })).reasoning_effort, 'low');
  assert.equal((await sent('gemini-4-argon', { extra_body: { reasoning_effort: 'MINIMAL' } })).extra_body.reasoning_effort, 'low');
  assert.equal((await sent('gemini-4-argon-high', { reasoning_effort: 'minimal' })).reasoning_effort, 'high');
  assert.equal((await sent('gemini-3.8-flash', { reasoning_effort: 'minimal' })).reasoning_effort, 'minimal');
  assert.equal((await sent('gemini-4-argon', { reasoning_effort: 'medium' })).reasoning_effort, 'medium');
  assert.equal((await sent('gemini-4-argon', {})).reasoning_effort, undefined);
});

test('aistudio gateway: streaming passes through unbuffered, usage from the final chunk', async () => {
  relay.st.holdMs = 250;
  try {
    const t0 = Date.now();
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + K.dave, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /event-stream/);
    const reader = r.body!.getReader();
    const first = await reader.read();
    const tFirst = Date.now() - t0;
    let text = Buffer.from(first.value!).toString('utf8');
    for (;;) { const c = await reader.read(); if (c.done) break; text += Buffer.from(c.value).toString('utf8'); }
    const tAll = Date.now() - t0;
    assert.ok(tFirst < 200, `first chunk after ${tFirst} ms`);
    assert.ok(tAll >= 700, `whole stream took ${tAll} ms`);
    assert.match(text, /aistudio/);
    assert.match(text, /\[DONE\]/);
  } finally {
    relay.st.holdMs = 0;
  }
  await sleep(50);
  const u = await lastUsage();
  assert.equal(u.stream, 1);
  assert.equal(u.result, 'ok');
  assert.equal(u.in_tok, 11);
  assert.equal(u.out_tok, 7);
  // traffic log filter by pool
  const t = await dave.req('GET', '/api/traffic?pool=aistudio');
  assert.ok(t.data.rows.length >= 2);
  assert.ok(t.data.rows.every((x: any) => x.pool === 'aistudio'));
});

test('aistudio re-check: transient errors keep the account, a dead one is marked 失效 and removed from the relay', async () => {
  const id = K.acc1;
  for (const h of ['proof', 'net', 'google500'] as const) {
    relay.st.health.set('good1', h);
    const r = await dave.req('POST', `/api/aistudio/${id}/check`);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'unknown', h);
    assert.equal(r.data.account.status, 'valid');
    assert.ok(relay.st.accounts.has(id));
  }
  relay.st.health.set('good1', 'quota'); // 429 = working account
  assert.equal((await dave.req('POST', `/api/aistudio/${id}/check`)).data.state, 'alive');
  // the background sweep (admin "全部检测") goes through the same check
  relay.st.health.set('good1', 'proof');
  assert.deepEqual((await admin.req('POST', '/api/admin/aistudio/recheck')).data, { checked: 1, dead: 0 });
  assert.equal((await dave.req('GET', '/api/aistudio')).data[0].status, 'valid');

  relay.st.health.set('good1', 'dead');
  assert.equal((await dave.req('POST', '/api/admin/aistudio/recheck')).status, 403);
  assert.deepEqual((await admin.req('POST', '/api/admin/aistudio/recheck')).data, { checked: 1, dead: 1 });
  assert.ok(!relay.st.accounts.has(id), 'dead account removed from the relay');
  const l = (await dave.req('GET', '/api/aistudio')).data;
  assert.equal(l.length, 1, 'stays listed for the owner');
  assert.equal(l[0].status, 'dead');
  assert.match(l[0].error, /401/);
  // no valid account any more -> 403; a dead account can't be re-checked
  assert.equal((await chat(K.dave)).status, 403);
  assert.equal((await dave.req('POST', `/api/aistudio/${id}/check`)).status, 400);

  // re-upload a working cookie of the same account -> valid again, access restored immediately
  relay.st.health.set('good1', 'alive');
  const up = await dave.req('POST', '/api/aistudio', { cookies: cookieOf('good1') });
  assert.equal(up.status, 200);
  assert.equal(up.data.status, 'valid');
  assert.equal((await chat(K.dave)).status, 200);
});

test('aistudio sweep drops relay accounts the portal does not consider valid', async () => {
  relay.st.accounts.set('acc_orphan', { cookies: 'SAPISID=o', g1Tier: 'TIER0' });
  await admin.req('POST', '/api/admin/aistudio/recheck');
  assert.ok(!relay.st.accounts.has('acc_orphan'));
  assert.ok(relay.st.accounts.has(K.acc1));
});

test('aistudio delete: owner and admin, removed from relay and portal', async () => {
  const two = await erin.req('POST', '/api/aistudio', { cookies: cookieOf('erin1') });
  assert.equal(two.status, 200);
  const all = (await admin.req('GET', '/api/admin/aistudio')).data;
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x: any) => x.owner).sort(), ['dave', 'erin']);
  assert.equal((await dave.req('GET', '/api/admin/aistudio')).status, 403);
  assert.equal((await dave.req('DELETE', `/api/admin/aistudio/${two.data.id}`)).status, 403);
  assert.equal((await admin.req('DELETE', `/api/admin/aistudio/${two.data.id}`)).status, 200);
  assert.ok(!relay.st.accounts.has(two.data.id));
  assert.equal((await chat(K.erin)).status, 403);

  assert.equal((await dave.req('DELETE', `/api/aistudio/${K.acc1}`)).status, 200);
  assert.ok(!relay.st.accounts.has(K.acc1));
  assert.deepEqual((await dave.req('GET', '/api/aistudio')).data, []);
  assert.equal((await chat(K.dave)).status, 403);
});

// ---------- per-account share switch ----------
const frank = new Client(), gina = new Client(), hank = new Client();
const S: Record<string, string> = {};
const allowSeen = (i: number) => String(relay.st.seen[i].headers['x-relay-allow'] || '').split(',').filter(Boolean).sort();
async function allowOf(key: string) {
  const i = relay.st.seen.length;
  const r = await chat(key);
  assert.equal(r.status, 200, r.text);
  return allowSeen(i);
}

test('aistudio share: default on, owner-only toggle, three eligibility states', async () => {
  await frank.login('300011', 'frank');
  await gina.login('300012', 'gina');
  await hank.login('300013', 'hank');
  for (const [c, n] of [[frank, 'frank'], [gina, 'gina'], [hank, 'hank']] as const) S['k' + n] = (await c.req('POST', '/api/keys', { name: 'ais', pool: 'aistudio' })).data.key;
  // none: no valid account
  assert.equal((await chat(S.kfrank)).status, 403);

  const f = await frank.req('POST', '/api/aistudio', { cookies: cookieOf('frank1') });
  assert.equal(f.status, 200);
  assert.equal(f.data.shared, true, 'upload defaults to shared');
  S.f1 = f.data.id;
  S.g1 = (await gina.req('POST', '/api/aistudio', { cookies: cookieOf('gina1') })).data.id;
  S.h1 = (await hank.req('POST', '/api/aistudio', { cookies: cookieOf('hank1') })).data.id;
  assert.deepEqual((await gina.req('GET', '/api/aistudio')).data.map((x: any) => x.shared), [true]);

  // only the owner may toggle; bad body refused
  assert.equal((await frank.req('POST', `/api/aistudio/${S.g1}/share`, { shared: false })).status, 404);
  assert.equal((await admin.req('POST', `/api/aistudio/${S.g1}/share`, { shared: false })).status, 404);
  assert.equal((await gina.req('POST', `/api/aistudio/${S.g1}/share`, { shared: 'no' })).status, 400);
  assert.equal((await gina.req('GET', '/api/aistudio')).data[0].shared, true);
  const off = await gina.req('POST', `/api/aistudio/${S.g1}/share`, { shared: false });
  assert.equal(off.status, 200);
  assert.equal(off.data.shared, false);
  assert.equal((await gina.req('GET', '/api/aistudio')).data[0].shared, false);
  const adm = (await admin.req('GET', '/api/admin/aistudio')).data;
  assert.equal(adm.find((x: any) => x.id === S.g1).shared, false);
  assert.equal(adm.find((x: any) => x.id === S.f1).shared, true);

  // own: gina only shares nothing -> still served, but only by her own account
  assert.deepEqual(await allowOf(S.kgina), [S.g1]);
  // full: frank / hank share -> own + every shared account, never gina's private one
  assert.deepEqual(await allowOf(S.kfrank), [S.f1, S.h1].sort());
  assert.deepEqual(await allowOf(S.khank), [S.f1, S.h1].sort());

  // gina adds a shared account -> full: her private one stays in her own list only
  S.g2 = (await gina.req('POST', '/api/aistudio', { cookies: cookieOf('gina2') })).data.id;
  assert.deepEqual(await allowOf(S.kgina), [S.f1, S.g1, S.g2, S.h1].sort());
  assert.deepEqual(await allowOf(S.kfrank), [S.f1, S.g2, S.h1].sort());
  // frank stops sharing -> own only, and his account leaves everyone else's list
  assert.equal((await frank.req('POST', `/api/aistudio/${S.f1}/share`, { shared: false })).data.shared, false);
  assert.deepEqual(await allowOf(S.kfrank), [S.f1]);
  assert.deepEqual(await allowOf(S.khank), [S.g2, S.h1].sort());
  // a dead shared account is not offered
  relay.st.health.set('gina2', 'dead');
  await gina.req('POST', `/api/aistudio/${S.g2}/check`);
  assert.deepEqual(await allowOf(S.khank), [S.h1]);
  assert.deepEqual(await allowOf(S.kgina), [S.g1]);
  // re-upload keeps the share choice
  assert.equal((await frank.req('POST', '/api/aistudio', { cookies: cookieOf('frank1') })).data.shared, false);
  assert.equal((await frank.req('POST', `/api/aistudio/${S.f1}/share`, { shared: true })).data.shared, true);
});

test('aistudio share: served account recorded, others hidden from the requester', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    assert.equal((await chat(S.kfrank)).status, 200);
    const u = await lastUsage();
    assert.ok([S.f1, S.h1].includes(u.auth_id), u.auth_id);
    seen.add(u.auth_id);
    if (u.auth_id === S.h1) assert.notEqual(u.owner_id, u.user_id);
    else assert.equal(u.owner_id, u.user_id);
  }
  assert.equal(seen.size, 2, 'round-robin over both');
  const t = (await frank.req('GET', '/api/traffic?pool=aistudio')).data;
  const txt = JSON.stringify(t);
  assert.ok(txt.includes(S.f1), 'own account shown');
  assert.ok(!txt.includes(S.h1), 'other user account id hidden');
  assert.ok(t.rows.some((x: any) => /^共享账号 #\d+/.test(x.account || '')));
  assert.ok(!JSON.stringify((await frank.req('GET', '/api/usage/requests?pool=aistudio')).data).includes(S.h1));
});

test('aistudio gateway: client cookies and x-relay headers are stripped, the portal sets the allow list', async () => {
  const i = relay.st.seen.length;
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + S.kgina, 'Content-Type': 'application/json', 'X-Relay-Allow': S.h1, 'X-Relay-Account': S.h1, 'X-Relay-Whatever': '1',
      'X-Google-Cookies': 'SAPISID=evil', 'X-Goog-AuthUser': '3', 'X-AIStudio-G1-Tier': 'TIER9' },
    body: JSON.stringify({ model: 'gemini-4-argon', reasoning_effort: 'minimal', cookies: 'SAPISID=evil', authUser: 3, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-relay-account'), null, 'served account never forwarded');
  await r.text();
  const seen = relay.st.seen[i];
  assert.equal(seen.headers['x-relay-allow'], S.g1);
  for (const h of ['x-relay-account', 'x-relay-whatever', 'x-google-cookies', 'x-goog-authuser', 'x-aistudio-g1-tier']) assert.equal(seen.headers[h], undefined, h);
  assert.equal(seen.body.cookies, undefined);
  assert.equal(seen.body.reasoning_effort, 'low', 'thinking fix still applied');
  assert.equal(seen.body.model, 'gemini-4-argon');
  assert.equal(relay.st.served.at(-1), S.g1);
});

test('aistudio gateway: a response without / with a foreign X-Relay-Account is refused, nothing forwarded', async () => {
  const before = (await admin.req('GET', '/api/admin/usage')).data.breaker.tripped;
  try {
    for (const mode of ['omit', 'foreign'] as const) {
      relay.st.misbehave = mode;
      for (const stream of [false, true]) {
        const r = await chat(S.kgina, { stream });
        assert.equal(r.status, 502, mode + stream);
        assert.ok(!/aistudio|hello/.test(r.text), 'no relay body forwarded');
        assert.match(JSON.parse(r.text).error.message, /AI Studio 中转/);
        await sleep(30);
        const u = await lastUsage();
        assert.equal(u.status, 502);
        assert.equal(u.result, 'blocked');
        assert.equal(u.auth_id, null);
        assert.equal(u.reason, mode === 'omit' ? '中转响应没有标明所用的号，已拦截' : '中转用了名单外的号，已拦截');
      }
    }
  } finally {
    relay.st.misbehave = null;
  }
  assert.match(logs, /\[aistudio\] relay response refused/);
  assert.equal((await admin.req('GET', '/api/admin/usage')).data.breaker.tripped, before, 'breaker untouched');
  assert.equal((await chat(S.kgina)).status, 200);
  // /v1/models needs no account header
  relay.st.misbehave = 'omit';
  try {
    assert.equal((await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + S.kgina } })).status, 200);
  } finally {
    relay.st.misbehave = null;
  }
});

test('aistudio gateway: relay 503 (no allowed account) is forwarded as is', async () => {
  const keep = relay.st.accounts.get(S.g1)!;
  relay.st.accounts.delete(S.g1);
  try {
    const r = await chat(S.kgina);
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.text).error.message, /no allowed account available/);
    const u = await lastUsage();
    assert.equal(u.status, 503);
    assert.equal(u.result, 'upstream');
  } finally {
    relay.st.accounts.set(S.g1, keep);
  }
});

test('小锅饭 / 大锅饭 keys are unaffected: still go to CPA, never to the relay', async () => {
  const j = { type: 'antigravity', email: 'd1@example.invalid', refresh_token: 'rt', access_token: 'at', project_id: 'p' };
  const up = await dave.req('POST', '/api/accounts/upload?name=x.json', undefined, Buffer.from(JSON.stringify(j)));
  assert.equal(up.data.results[0].ok, true, JSON.stringify(up.data));
  const pk = (await dave.req('POST', '/api/keys', { name: 'p', pool: 'private' })).data.key;
  const sk = (await erin.req('POST', '/api/keys', { name: 's', pool: 'shared' })).data.key;
  const id = (await dave.req('GET', '/api/accounts')).data[0].id;
  assert.equal((await dave.req('PATCH', '/api/accounts/' + encodeURIComponent(id), { shared: true })).status, 200);
  const before = relay.st.seen.length;
  const p = await chat(pk, { model: 'gemini-3-flash' });
  assert.equal(p.status, 200, p.text);
  assert.match(p.text, /served_by|from /);
  const s = await chat(sk, { stream: true, model: 'gemini-3-flash' });
  assert.equal(s.status, 200, s.text);
  assert.equal(relay.st.seen.length, before);
  assert.equal((await lastUsage()).pool, 'shared');
  // CPA still gets exactly one allow header for them
  assert.ok(cpaMock.st.seenAllow.length >= 2);
});
