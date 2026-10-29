// End-to-end tests of the portal against a mock CPA. Run: npm test
import { test, before, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';

const API_KEY = 'cpa-test-key', MGMT = 'cpa-test-mgmt';
const mock = startMockCPA({ apiKey: API_KEY, mgmtKey: MGMT });
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
    const r = await fetch(base + path, { method, headers, body: b, redirect: 'manual' });
    const sc = r.headers.getSetCookie();
    for (const c of sc) if (c.startsWith('agy_sid=')) this.cookie = c.split(';')[0];
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  }
  async login(id: string, name: string, admin = false) {
    const r = await this.req('POST', '/api/dev-login', { discordId: id, name, admin });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return this;
  }
  async upload(email: string) {
    const j = { type: 'antigravity', email, refresh_token: 'rt', access_token: 'at', project_id: 'p' };
    return this.req('POST', '/api/accounts/upload?name=x.json', undefined, Buffer.from(JSON.stringify(j)));
  }
}

async function gen(key: string, opts: { model?: string; stream?: boolean; headers?: Record<string, string>; path?: string; body?: any } = {}) {
  const r = await fetch(base + (opts.path || '/v1/chat/completions'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(opts.body || { model: opts.model || 'gemini-3-flash', stream: !!opts.stream, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await r.text();
  const m = /from (\S+?\.json)/.exec(text) || /"served_by":"([^"]+)"/.exec(text);
  return { status: r.status, text, served: m ? m[1] : null, trace: r.headers.get('x-cpa-trace-id'), retryAfter: r.headers.get('retry-after') };
}

const alice = new Client(), bob = new Client(), carol = new Client();
const K: Record<string, string> = {};

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (mock.server.address() as AddressInfo).port;
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-test-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  portal = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_API_KEY: API_KEY, CPA_MANAGEMENT_KEY: MGMT, DEV_LOGIN: '1', COOKIE_SECURE: '0', USAGE_POLL_MS: '200',
      QUOTA_REFRESH_MINUTES: '0', ROLE_RECHECK_MINUTES: '0', PLUGIN_CHECK_CACHE_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  portal.stdout!.on('data', (d) => (logs += d));
  portal.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(100);
  }
});

after(() => {
  portal?.kill();
  mock.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('refuses DEV_LOGIN on a non-loopback host', async () => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0', DEV_LOGIN: '1', CPA_API_KEY: 'x', CPA_MANAGEMENT_KEY: 'y', DATA_DIR: dataDir + '/x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr!.on('data', (d) => (err += d));
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /DEV_LOGIN/);
});

test('setup token: written to file, wrong token rejected', async () => {
  const tok = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
  assert.ok(tok.length > 20);
  assert.match(logs, new RegExp(tok));
  const r = await new Client().req('POST', '/api/setup', { token: 'nope', adminDiscordId: '123456' });
  assert.equal(r.status, 403);
  assert.equal((await fetch(base + '/setup')).status, 200);
  const ok = await new Client().req('POST', '/api/setup', { token: tok, publicURL: 'https://pot.example.com', clientId: '1234567', clientSecret: 's', guildId: '7654321', roleIds: '', adminDiscordId: '100001' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.redirectURI, 'https://pot.example.com/auth/discord/callback');
  assert.equal((await fetch(base + '/setup')).status, 404);
  assert.equal((await new Client().req('POST', '/api/setup', { token: tok, adminDiscordId: '100001' })).status, 403);
});

test('login, accounts upload, ownership isolation, duplicate rejection', async () => {
  await alice.login('100001', 'alice', true);
  await bob.login('100002', 'bob');
  await carol.login('100003', 'carol');
  assert.equal((await new Client().req('GET', '/api/me')).status, 401);

  for (const e of ['a1@example.invalid', 'a2@example.invalid']) {
    const r = await alice.upload(e);
    assert.equal(r.status, 200);
    assert.equal(r.data.results[0].ok, true, JSON.stringify(r.data));
  }
  const rb = await bob.upload('b1@example.invalid');
  assert.equal(rb.data.results[0].ok, true);
  const dup = await bob.upload('a1@example.invalid');
  assert.equal(dup.data.results[0].ok, false);
  assert.equal(dup.data.results[0].error, 'duplicate');
  const bad = await bob.req('POST', '/api/accounts/upload?name=x.json', undefined, Buffer.from('{"type":"claude"}'));
  assert.equal(bad.data.results[0].error, 'invalid');

  const la = await alice.req('GET', '/api/accounts');
  assert.deepEqual(la.data.map((a: any) => a.email).sort(), ['a1@example.invalid', 'a2@example.invalid']);
  const lb = await bob.req('GET', '/api/accounts');
  assert.deepEqual(lb.data.map((a: any) => a.email), ['b1@example.invalid']);
  // bob cannot touch alice's account
  const aid = la.data[0].id;
  assert.equal((await bob.req('PATCH', '/api/accounts/' + encodeURIComponent(aid), { shared: true })).status, 404);
  assert.equal((await bob.req('DELETE', '/api/accounts/' + encodeURIComponent(aid))).status, 404);
  assert.equal((await bob.req('POST', '/api/accounts/' + encodeURIComponent(aid) + '/quota')).status, 404);
  // non-admin cannot use admin endpoints
  assert.equal((await bob.req('GET', '/api/admin/accounts')).status, 403);
  assert.equal((await bob.req('PUT', '/api/admin/rules', { reserve: 0 })).status, 403);
  // CSRF header required
  const r = await fetch(base + '/api/keys', { method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' }, body: '{"pool":"private"}' });
  assert.equal(r.status, 403);
});

test('OAuth flow assigns the new credential to the user who started it', async () => {
  const s = await alice.req('POST', '/api/accounts/oauth');
  assert.equal(s.status, 200);
  // bob cannot submit alice's state
  const cbBob = await bob.req('POST', '/api/accounts/oauth/callback', { state: s.data.state, url: `http://localhost:51121/oauth-callback?state=${s.data.state}&code=a3` });
  assert.equal(cbBob.status, 404);
  const cb = await alice.req('POST', '/api/accounts/oauth/callback', { state: s.data.state, url: `http://localhost:51121/oauth-callback?state=${s.data.state}&code=a3` });
  assert.equal(cb.status, 200);
  let st: any;
  for (let i = 0; i < 30; i++) {
    st = (await alice.req('GET', '/api/accounts/oauth/' + s.data.state)).data;
    if (st.status !== 'wait') break;
    await sleep(200);
  }
  assert.equal(st.status, 'ok', JSON.stringify(st));
  assert.equal(st.account, 'antigravity-a3@example.invalid.json');
  // bob re-authorizing alice's Google account -> duplicate, ownership unchanged
  const s2 = await bob.req('POST', '/api/accounts/oauth');
  await bob.req('POST', '/api/accounts/oauth/callback', { state: s2.data.state, url: `http://localhost:51121/oauth-callback?state=${s2.data.state}&code=a3` });
  for (let i = 0; i < 30; i++) {
    st = (await bob.req('GET', '/api/accounts/oauth/' + s2.data.state)).data;
    if (st.status !== 'wait') break;
    await sleep(200);
  }
  assert.equal(st.status, 'duplicate');
  assert.equal((await alice.req('GET', '/api/accounts')).data.length, 3);
});

test('keys: owner can read back, encrypted at rest, rename, pool change, revoke', async () => {
  const k = await alice.req('POST', '/api/keys', { name: 'mine', pool: 'private' });
  assert.match(k.data.key, /^sk-agy-/);
  K.alice = k.data.key;
  const list = await alice.req('GET', '/api/keys');
  assert.ok(JSON.stringify(list.data).includes(K.alice));
  assert.ok(!JSON.stringify((await bob.req('GET', '/api/keys')).data).includes(K.alice));
  K.bob = (await bob.req('POST', '/api/keys', { name: 'b', pool: 'private' })).data.key;
  K.carol = (await carol.req('POST', '/api/keys', { name: 'c', pool: 'shared' })).data.key;
  const tmp = (await alice.req('POST', '/api/keys', { name: 't', pool: 'private' })).data;
  assert.equal((await alice.req('PATCH', '/api/keys/' + tmp.id, { name: 'renamed', pool: 'shared' })).data.pool, 'shared');
  assert.equal((await bob.req('DELETE', '/api/keys/' + tmp.id)).status, 404);
  assert.equal((await alice.req('DELETE', '/api/keys/' + tmp.id)).status, 200);
  assert.equal((await gen(tmp.key)).status, 401);
  // DB stores hash + ciphertext, never plaintext
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(dataDir, 'portal.db'), { readOnly: true });
  const dump = JSON.stringify(d.prepare('SELECT * FROM api_keys').all());
  d.close();
  assert.ok(!dump.includes(K.alice) && !dump.includes(tmp.key));
});

test('小锅饭 keys only hit own accounts; 大锅饭 only hits shared accounts', async () => {
  const mineA = new Set<string>((await alice.req('GET', '/api/accounts')).data.map((a: any) => a.id));
  const a2 = [...mineA].find((x) => x.includes('a2'))!;
  await alice.req('PATCH', '/api/accounts/' + encodeURIComponent(a2), { shared: true });
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  await bob.req('PATCH', '/api/accounts/' + encodeURIComponent(b1), { shared: true });

  const servedA = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const r = await gen(K.alice, { stream: i % 2 === 1 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.trace, null, 'trace header must not leak to clients');
    servedA.add(r.served!);
  }
  assert.deepEqual([...servedA].sort(), [...mineA].sort());
  for (let i = 0; i < 4; i++) assert.equal((await gen(K.bob)).served, b1);
  const servedC = new Set<string>();
  for (let i = 0; i < 6; i++) servedC.add((await gen(K.carol, { stream: i % 2 === 0 })).served!);
  assert.deepEqual([...servedC].sort(), [a2, b1].sort());
  // native gemini + claude paths
  assert.equal((await gen(K.bob, { path: '/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse' })).served, b1);
  assert.equal((await gen(K.bob, { path: '/v1/messages', model: 'claude-sonnet-4-6' })).served, b1);
  // a user with no accounts gets "no account" on 小锅饭
  const ck = (await carol.req('POST', '/api/keys', { name: 'p', pool: 'private' })).data.key;
  assert.equal((await gen(ck)).status, 503);
});

test('client copies of X-Agy-Allow are stripped (any case)', async () => {
  mock.st.seenAllow.length = 0;
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  const r = await gen(K.alice, { headers: { 'X-Agy-Allow': b1, 'x-agy-allow-extra': 'z' } });
  assert.equal(r.status, 200);
  // fetch() merges duplicate header names, so also send two raw copies over a socket
  const net = await import('node:net');
  const u = new URL(base);
  const payload = JSON.stringify({ model: 'gemini-3-flash', messages: [] });
  const resp = await new Promise<string>((resolve) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${K.alice}\r\nContent-Type: application/json\r\n` +
        `x-agy-allow: ${b1}\r\nX-AGY-ALLOW: ${b1}\r\nConnection: close\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`);
    });
    let t = '';
    sock.on('data', (d) => (t += d));
    sock.on('end', () => resolve(t));
  });
  assert.match(resp, /^HTTP\/1\.1 200/);
  assert.equal(mock.st.seenAllow.length, 2);
  for (const v of mock.st.seenAllow) {
    assert.equal(v.length, 1, 'exactly one allow header reaches CPA');
    assert.ok(!v[0].split(',').includes(b1), 'client-injected id must not be allowed');
  }
});

test('self-use reserve removes a shared account below the threshold', async () => {
  const a2 = (await alice.req('GET', '/api/accounts')).data.find((a: any) => a.id.includes('a2')).id;
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  await alice.req('PUT', '/api/admin/rules', { reserve: 50, accConc: 5, keyConc: 8, keyRpm: 1000 });
  mock.st.quota = { gp: 0.9, gf: 0.3, cl: 0.1 };
  const q = await alice.req('POST', '/api/accounts/' + encodeURIComponent(a2) + '/quota');
  assert.equal(q.status, 200);
  assert.deepEqual(q.data.quota.groups.map((g: any) => g[0]), ['gp', 'gf', 'ar', 'cl']);
  assert.equal(q.data.tier, 'g1-pro-tier');
  // 5h / weekly windows from retrieveUserQuotaSummary, Gemini first, 5h before weekly
  assert.deepEqual(q.data.quota.windows.map((w: any) => w.key), ['gemini', 'claude']);
  assert.deepEqual(q.data.quota.windows[1].buckets.map((b: any) => [b.window, b.frac]), [['5h', 0.1], ['weekly', 0.8]]);
  for (let i = 0; i < 4; i++) assert.equal((await gen(K.carol, { model: 'gemini-3-flash' })).served, b1);
  // gemini pro group is at 90% -> a2 still eligible
  const pro = new Set<string>();
  for (let i = 0; i < 4; i++) pro.add((await gen(K.carol, { model: 'gemini-3-pro-high' })).served!);
  assert.ok(pro.has(a2));
  // the owner's own 小锅饭 key still uses a2
  const own = new Set<string>();
  for (let i = 0; i < 6; i++) own.add((await gen(K.alice)).served!);
  assert.ok(own.has(a2));
  await alice.req('PUT', '/api/admin/rules', { reserve: 0 });
});

test('大锅饭 resources: totals for everyone, per-account rows only for admins', async () => {
  const a2 = (await alice.req('GET', '/api/accounts')).data.find((a: any) => a.id.includes('a2')).id;
  const u = await bob.req('GET', '/api/pool/resources');
  assert.equal(u.status, 200);
  assert.equal(u.data.accounts, undefined); // no emails / owners for regular users
  assert.ok(u.data.counts.total >= 1);
  assert.equal(u.data.fam.claude.open, true);
  const r = (await alice.req('GET', '/api/pool/resources')).data;
  const row = r.accounts.find((x: any) => x.id === a2);
  assert.ok(row, JSON.stringify(r.accounts));
  assert.equal(row.wins.claude.h5.frac, 0.1);
  assert.equal(row.wins.claude.weekly.frac, 0.8);
  assert.ok(r.fam.claude.h5.n >= 1 && r.fam.claude.weekly.sum >= 0.8 - 1e-9);
  // the owner's reserve is taken off what the pool can use
  await alice.req('PATCH', '/api/accounts/' + encodeURIComponent(a2), { reserve: 50 });
  const r2 = (await alice.req('GET', '/api/pool/resources')).data;
  assert.ok(Math.abs(r2.fam.claude.weekly.sum - (r.fam.claude.weekly.sum - 0.5)) < 1e-9, JSON.stringify([r.fam.claude, r2.fam.claude]));
  await alice.req('PATCH', '/api/accounts/' + encodeURIComponent(a2), { reserve: null });
  // an account that only lists gemini-4-argon-disabled has no Argon: counted as not enabled, no Argon quota
  const qp = '/api/accounts/' + encodeURIComponent(a2) + '/quota';
  const { DatabaseSync } = await import('node:sqlite');
  const refresh = async () => { // manual refresh is throttled to one per 20s; age the last read instead of waiting
    const d = new DatabaseSync(join(dataDir, 'portal.db'));
    d.prepare('UPDATE accounts SET quota_at = 0 WHERE auth_id = ?').run(a2); d.close();
    return (await alice.req('POST', qp)).data.quota;
  };
  assert.equal((await refresh()).argon, 'on');
  mock.st.argonOff = true;
  try {
    const q = await refresh();
    assert.equal(q.argon, 'off');
    assert.ok(!q.groups.some((g: any) => g[0] === 'ar'));
    const r3 = (await alice.req('GET', '/api/pool/resources')).data;
    assert.ok(r3.fam.argon.off >= 1);
    const row3 = r3.accounts.find((x: any) => x.id === a2);
    assert.equal(row3.argon, 'off');
    assert.equal(row3.wins.argon, undefined);
  } finally { mock.st.argonOff = false; await refresh(); }
  // closed families are flagged
  await alice.req('PUT', '/api/admin/shared-models', { allow: ['gemini-3-flash'] });
  try { const c = (await bob.req('GET', '/api/pool/resources')).data.fam; assert.deepEqual([c.gemini.open, c.claude.open, c.argon.open], [true, false, false]); }
  finally { await alice.req('PUT', '/api/admin/shared-models', { allow: null }); }
});

test('per-account concurrency cap and shared-key concurrency / rate', async () => {
  const a2 = (await alice.req('GET', '/api/accounts')).data.find((a: any) => a.id.includes('a2')).id;
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  await alice.req('PUT', '/api/admin/rules', { accConc: 1, keyConc: 8, keyRpm: 1000, reserve: 0 });
  mock.st.holdMs = 800;
  const first = gen(K.carol, { stream: true });
  await sleep(250);
  const second = gen(K.carol, { stream: true });
  await sleep(250);
  const third = await gen(K.carol);
  const [r1, r2] = await Promise.all([first, second]);
  mock.st.holdMs = 0;
  assert.notEqual(r1.served, r2.served, 'two concurrent shared requests land on different accounts');
  assert.deepEqual([r1.served, r2.served].sort(), [a2, b1].sort());
  assert.equal(third.status, 503, 'both accounts at cap -> no account');
  // key concurrency
  await alice.req('PUT', '/api/admin/rules', { accConc: 5, keyConc: 1, keyRpm: 1000 });
  mock.st.holdMs = 600;
  const h = gen(K.carol, { stream: true });
  await sleep(150);
  const blocked = await gen(K.carol);
  await h;
  mock.st.holdMs = 0;
  assert.equal(blocked.status, 429);
  // key rate
  await alice.req('PUT', '/api/admin/rules', { keyConc: 8, keyRpm: 2 });
  await sleep(50);
  const k2 = (await carol.req('POST', '/api/keys', { name: 'rate', pool: 'shared' })).data.key;
  assert.equal((await gen(k2)).status, 200);
  assert.equal((await gen(k2)).status, 200);
  const limited = await gen(k2);
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.text).error.message, '大锅饭限速：每分钟 2 次');
  assert.ok(Number(limited.retryAfter) >= 1 && Number(limited.retryAfter) <= 60);
  await alice.req('PUT', '/api/admin/rules', { keyConc: 8, keyRpm: 60, accConc: 2, reserve: 30 });
});

test('usage rows recorded with tokens; shared callers never see emails', async () => {
  await sleep(800);
  const mine = await alice.req('GET', '/api/usage/requests');
  assert.ok(mine.data.length > 5);
  assert.ok(mine.data.some((r: any) => r.tokens === 7), JSON.stringify(mine.data.slice(0, 3)));
  const c = await carol.req('GET', '/api/usage/requests?pool=shared');
  assert.ok(c.data.length > 0);
  assert.ok(!JSON.stringify(c.data).includes('@'), 'no emails in shared-pool records');
  assert.ok(c.data.filter((r: any) => r.result === 'ok').every((r: any) => /^#\d+$/.test(r.account)));
  const contrib = await bob.req('GET', '/api/usage/contributions');
  assert.ok(contrib.data[0].count > 0);
  assert.ok(contrib.data[0].tokens > 0);
  assert.ok(!JSON.stringify(contrib.data).includes('carol'), 'contributions do not show callers');
  const adm = await alice.req('GET', '/api/admin/usage');
  assert.ok(adm.data.total > 0 && adm.data.shared > 0 && adm.data.private > 0 && adm.data.rejected > 0);
});

test('traffic log: scoped per user, anonymized, filters, pagination, cache + ttfb', async () => {
  const users = (await alice.req('GET', '/api/admin/users')).data;
  const bobId = users.find((u: any) => u.name === 'bob').id;
  const carolId = users.find((u: any) => u.name === 'carol').id;
  // unauthenticated
  assert.equal((await new Client().req('GET', '/api/traffic')).status, 401);
  assert.equal((await new Client().req('GET', '/api/admin/traffic')).status, 401);
  assert.equal((await bob.req('GET', '/api/admin/traffic')).status, 403);
  // admin sees everyone and can filter by user
  const all = (await alice.req('GET', '/api/traffic?size=100')).data;
  assert.ok(all.total > 20 && all.ok > 0 && all.error > 0 && all.ok + all.error === all.total);
  assert.equal(all.rows.length, Math.min(100, all.total));
  assert.ok(all.rows.every((r: any, i: number) => i === 0 || r.ts <= all.rows[i - 1].ts), 'newest first');
  assert.ok(all.users.length >= 3 && all.rows.some((r: any) => r.user === 'carol'));
  assert.ok(all.rows.some((r: any) => r.account && r.account.includes('@')), 'admin sees emails');
  const okRow = all.rows.find((r: any) => r.result === 'ok');
  assert.equal(okRow.cache, 2, 'cached_tokens fallback');
  assert.equal(typeof okRow.ttfb, 'number');
  assert.ok(okRow.ttfb <= okRow.latency);
  const onlyBob = (await alice.req('GET', '/api/traffic?user=' + bobId)).data;
  assert.ok(onlyBob.total > 0 && onlyBob.rows.every((r: any) => r.user === 'bob'));
  // a user only ever sees their own rows, even when asking for someone else's
  const asCarol = (await carol.req('GET', '/api/traffic?size=100&user=' + bobId)).data;
  const carolTotal = (await alice.req('GET', '/api/traffic?user=' + carolId)).data.total;
  assert.equal(asCarol.total, carolTotal);
  assert.equal(asCarol.users, undefined);
  assert.ok(asCarol.rows.every((r: any) => r.user === undefined));
  // shared-pool rows never reveal the contributor's email or auth id
  const s = JSON.stringify(asCarol);
  assert.ok(!s.includes('@') && !s.includes('antigravity-'), s.slice(0, 300));
  assert.ok(asCarol.rows.filter((r: any) => r.result === 'ok').every((r: any) => /^共享账号 #\d+$/.test(r.account) && r.accountId === null));
  assert.deepEqual(asCarol.accounts, []);
  // filtering by someone else's account yields nothing
  const a1 = (await alice.req('GET', '/api/accounts')).data[0].id;
  assert.equal((await carol.req('GET', '/api/traffic?account=' + encodeURIComponent(a1))).data.total, 0);
  // bob's own accounts show his email; filters
  const bt = (await bob.req('GET', '/api/traffic?pool=private&family=claude')).data;
  assert.ok(bt.total >= 1 && bt.rows.every((r: any) => r.pool === 'private' && /claude/.test(r.model)));
  assert.ok(bt.rows.some((r: any) => r.account === 'b1@example.invalid'));
  const errs = (await alice.req('GET', '/api/traffic?errorsOnly=1')).data;
  assert.ok(errs.total === all.error && errs.rows.every((r: any) => r.result !== 'ok'));
  const q = (await alice.req('GET', '/api/traffic?q=503')).data;
  assert.ok(q.total > 0 && q.rows.every((r: any) => r.status === 503));
  const p2 = (await alice.req('GET', '/api/traffic?size=5&page=2')).data;
  assert.equal(p2.rows[0].id, all.rows[5].id);
  assert.equal((await alice.req('GET', '/api/traffic?size=500')).data.size, 100);
  assert.ok(!JSON.stringify(all).includes('hello'), 'no bodies');
});

test('discord bot: signed interactions, /我的号 is private and owner-scoped, /今日榜', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const kp = generateKeyPairSync('ed25519');
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  assert.equal((await alice.req('PUT', '/api/admin/site', { publicKey: 'zz' })).status, 400);
  assert.equal((await bob.req('PUT', '/api/admin/site', { publicKey: pub })).status, 403);
  const site = (await alice.req('PUT', '/api/admin/site', { publicKey: pub, botChannelId: '', dailyHour: -1 })).data;
  assert.equal(site.publicKey, pub);
  assert.equal(site.dailyHour, -1);
  const send = async (body: any, bad = false) => {
    const raw = Buffer.from(JSON.stringify(body)), ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.concat([Buffer.from(ts), raw]), kp.privateKey).toString('hex');
    const r = await fetch(base + '/discord/interactions', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': bad ? sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a') : sig, 'X-Signature-Timestamp': ts } });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  assert.equal((await send({ type: 1 }, true)).status, 401);
  assert.deepEqual((await send({ type: 1 })).data, { type: 1 });
  const guild = site.guildId || undefined;
  const cmd = (name: string, uid: string) => send({ type: 2, guild_id: guild, member: { user: { id: uid } }, data: { name } });
  const mine = (await cmd('我的号', '100002')).data;
  assert.equal(mine.data.flags, 64, 'answered privately');
  assert.ok(mine.data.content.includes('b1@example.invalid'), mine.data.content);
  assert.ok(!mine.data.content.includes('a1@'), 'only own accounts');
  assert.match((await cmd('我的号', '999999999')).data.data.content, /还没登录过/);
  const board = (await cmd('今日榜', '100003')).data.data;
  assert.equal(board.flags, 0);
  assert.match(board.content, /用量王/);
  assert.deepEqual(board.allowed_mentions, { parse: [] }, 'leaderboard never pings');
  assert.match(board.content, /全站累计/);
  // /免打扰: toggles, private, and the board writes the name instead of <@id>
  const q = (on?: boolean) => send({ type: 2, guild_id: guild, member: { user: { id: '100002' } }, data: { name: '免打扰', options: on === undefined ? [] : [{ name: '开启', type: 5, value: on }] } });
  const r1 = (await q(true)).data.data;
  assert.equal(r1.flags, 64);
  assert.match(r1.content, /不再 @ 你/);
  const b2 = (await cmd('今日榜', '100003')).data.data.content;
  assert.ok(!b2.includes('<@100002>'), b2);
  assert.match((await q()).data.data.content, /已恢复/);
  assert.match((await cmd('免打扰', '999999999')).data.data.content, /还没登录过/);
});

test('token stats: totals, buckets, scope and anonymity', async () => {
  assert.equal((await new Client().req('GET', '/api/stats')).status, 401);
  const tz = -new Date().getTimezoneOffset();
  const site = (await alice.req('GET', `/api/stats?scope=all&range=24h&tz=${tz}`)).data;
  assert.equal(site.scope, 'all');
  assert.equal(site.trend.length, 24);
  assert.ok(site.totals.req > 20 && site.totals.tok > 0 && site.totals.users >= 2);
  assert.ok(!site.byUser.some((u: any) => u.name === 'alice'), 'the admin\'s own requests stay out of site statistics');
  assert.equal(site.trend.reduce((n: number, b: any) => n + b.req, 0), site.totals.req, 'every request lands in a bucket');
  assert.equal(site.models.reduce((n: number, m: any) => n + m.req, 0), site.totals.req);
  assert.ok(site.heat.length === 91 && site.heat[90] > 0, 'today is the last heat cell');
  assert.equal(site.hours.reduce((a: number, v: number) => a + v, 0), site.totals.tok);
  assert.ok(site.byUser.some((u: any) => u.name === 'carol'));
  assert.ok(site.byAccount.some((a: any) => a.name.includes('@')));
  assert.equal((await alice.req('GET', '/api/stats?range=7d')).data.trend.length, 7);
  assert.ok(site.perf.n > 0 && site.perf.ttft > 0 && site.perf.latency >= site.perf.ttft, JSON.stringify(site.perf));
  // a regular user only sees their own numbers, even when asking for the whole site
  const c = (await carol.req('GET', '/api/stats?scope=all&range=24h')).data;
  const carolId = (await alice.req('GET', '/api/admin/users')).data.find((u: any) => u.name === 'carol').id;
  assert.equal(c.scope, 'mine');
  assert.equal(c.byUser, undefined);
  assert.equal(c.totals.req, (await alice.req('GET', '/api/traffic?user=' + carolId)).data.total);
  const s = JSON.stringify(c);
  assert.ok(!s.includes('@') && !s.includes('antigravity-'), s.slice(0, 300));
  assert.ok(c.byAccount.every((a: any) => /^共享账号 #\d+$/.test(a.name)));
});

test('rotation mode is per user: X-Agy-Mode / X-Agy-Session sent, client copies stripped, reset changes keys', async () => {
  // defaults to balance; invalid values refused; anonymous refused
  assert.equal((await bob.req('GET', '/api/me')).data.rotation, 'balance');
  assert.equal((await bob.req('PATCH', '/api/me', { rotation: 'nope' })).status, 400);
  assert.equal((await new Client().req('PATCH', '/api/me', { rotation: 'cache' })).status, 401);
  assert.equal((await new Client().req('POST', '/api/me/sessions/reset')).status, 401);
  assert.equal((await bob.req('PATCH', '/api/me', { rotation: 'cache' })).status, 200);
  assert.equal((await bob.req('GET', '/api/me')).data.rotation, 'cache');
  assert.equal((await alice.req('GET', '/api/me')).data.rotation, 'balance', "one user's mode does not change another's");

  const conv = (turns: number, first = 'SECRET-PROMPT-1') => {
    const messages: any[] = [{ role: 'system', content: 'be brief' }, { role: 'user', content: first }];
    for (let i = 1; i < turns; i++) messages.push({ role: 'assistant', content: 'a' + i }, { role: 'user', content: 'q' + i });
    return { model: 'gemini-3-flash', messages };
  };
  const seen = async (key: string, body: any, headers: Record<string, string> = {}) => {
    mock.st.seenAgy.length = 0;
    const r = await gen(key, { body, headers });
    assert.equal(r.status, 200, r.text);
    assert.equal(mock.st.seenAgy.length, 1);
    return mock.st.seenAgy[0];
  };
  const t1 = await seen(K.bob, conv(1), { 'X-Agy-Mode': 'performance', 'X-Agy-Session': 'forged', 'x-agy-session-ttl': '1' });
  assert.deepEqual(t1.mode, ['cache']);
  assert.equal(t1.session.length, 1);
  assert.match(t1.session[0], /^[0-9a-f]{32}$/);
  assert.deepEqual(t1.ttl, [], 'client ttl copy stripped');
  const t3 = await seen(K.bob, conv(3));
  assert.deepEqual(t3.session, t1.session, 'stable across turns');
  const other = await seen(K.bob, conv(1, 'another conversation'));
  assert.notDeepEqual(other.session, t1.session, 'different conversation');
  const k2 = (await bob.req('POST', '/api/keys', { name: 'second', pool: 'private' })).data.key;
  assert.notDeepEqual((await seen(k2, conv(1))).session, t1.session, 'different per key');
  // 大锅饭 key uses the caller's own setting too
  await carol.req('PATCH', '/api/me', { rotation: 'performance' });
  assert.deepEqual((await seen(K.carol, conv(1))).mode, ['performance']);
  await carol.req('PATCH', '/api/me', { rotation: 'balance' });
  assert.deepEqual((await seen(K.carol, conv(1))).mode, ['balance']);
  // an explicit Claude Code session header wins over the body
  const h1 = await seen(K.bob, conv(1), { 'X-Claude-Code-Session-Id': 'sess-1' });
  const h2 = await seen(K.bob, conv(4, 'whatever'), { 'X-Claude-Code-Session-Id': 'sess-1' });
  assert.deepEqual(h1.session, h2.session);
  assert.notDeepEqual(h1.session, t1.session);
  // 清除会话绑定 -> new salt -> new keys for this user only
  assert.equal((await bob.req('POST', '/api/me/sessions/reset')).status, 200);
  assert.notDeepEqual((await seen(K.bob, conv(1))).session, t1.session);
  // nothing to derive a session from -> no stickiness
  const none = await seen(K.bob, { model: 'gemini-3-flash' });
  assert.deepEqual(none.mode, ['performance']);
  assert.deepEqual(none.session, []);
  assert.ok(!logs.includes('SECRET-PROMPT-1'), 'raw content never logged');
});

test('clear error reasons in the endpoint dialect, with Retry-After', async () => {
  // unknown model name (no mapping: names pass through unchanged)
  const cc = 'claude-haiku-4-5-20251001';
  const a = await gen(K.bob, { path: '/v1/messages', body: { model: cc, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(a.status, 404);
  const aj = JSON.parse(a.text);
  assert.equal(aj.type, 'error');
  assert.equal(aj.error.type, 'not_found_error');
  assert.equal(aj.error.message, '没有支持该模型的账号：' + cc);
  const o = JSON.parse((await gen(K.bob, { model: cc })).text);
  assert.equal(o.error.message, '没有支持该模型的账号：' + cc);
  assert.equal(o.error.code, 'model_not_found');
  const g = JSON.parse((await gen(K.bob, { path: '/v1beta/models/gemini-9-nope:generateContent', body: { contents: [] } })).text);
  assert.equal(g.error.status, 'NOT_FOUND');
  assert.match(g.error.message, /gemini-9-nope/);
  // 小锅饭 with no own account
  const ck = (await carol.req('POST', '/api/keys', { name: 'p2', pool: 'private' })).data.key;
  assert.match(JSON.parse((await gen(ck)).text).error.message, /你还没有自己的账号/);
  // own Claude quota used up (cached 5h / weekly data) + upstream 429
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  mock.st.quota = { gp: 0.9, gf: 0.5, cl: 0 };
  assert.equal((await bob.req('POST', '/api/accounts/' + encodeURIComponent(b1) + '/quota')).status, 200);
  mock.st.claude429 = true;
  const q = await gen(K.bob, { path: '/v1/messages', body: { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
  mock.st.claude429 = false;
  assert.equal(q.status, 429);
  const qj = JSON.parse(q.text);
  assert.equal(qj.error.type, 'rate_limit_error');
  assert.match(qj.error.message, /^你的账号 Claude 额度已用完，约 .+后恢复$/);
  assert.ok(Number(q.retryAfter) > 3600, 'Retry-After from the reset time');
  mock.st.quota = { gp: 0.9, gf: 0.5, cl: 0.1 };
  await bob.req('POST', '/api/accounts/' + encodeURIComponent(b1) + '/quota');
  // the same reasons show in the traffic log
  await sleep(500);
  const rows = (await bob.req('GET', '/api/traffic?size=20')).data.rows;
  assert.ok(rows.some((r: any) => r.reason === '没有支持该模型的账号：' + cc && r.result === 'no_model'));
  const qr = rows.find((r: any) => r.result === 'quota');
  assert.match(qr.reason, /Claude 额度已用完/);
  assert.equal(qr.upstreamStatus, 429);
  assert.ok(!JSON.stringify(rows).includes('UPSTREAM-SECRET-BODY'));
});

test('traffic log uses CPA fields: requested vs upstream model, reasoning, cache, attempts, ttft', async () => {
  mock.st.retryFirst = true;
  mock.st.recExtra = {
    alias: 'claude-sonnet-4-6', model: 'claude-sonnet-4-6-thinking', response_model: 'claude-sonnet-4-6-thinking', ttft_ms: 1, latency_ms: 2, reasoning_effort: 'high',
    tokens: { input_tokens: 10, output_tokens: 20, reasoning_tokens: 30, cached_tokens: 0, cache_read_tokens: 5, cache_creation_tokens: 6, total_tokens: 60 },
  };
  const r = await gen(K.bob, { model: 'claude-sonnet-4-6' });
  mock.st.retryFirst = false;
  mock.st.recExtra = null;
  assert.equal(r.status, 200);
  await sleep(600);
  const row = (await bob.req('GET', '/api/traffic?size=5')).data.rows[0];
  assert.equal(row.model, 'claude-sonnet-4-6');
  assert.equal(row.upstream, 'claude-sonnet-4-6-thinking');
  assert.deepEqual([row.in, row.out, row.think, row.cache, row.cacheWrite], [10, 20, 30, 5, 6]);
  assert.equal(row.attempts, 2);
  assert.equal(row.upstreamStatus, 429);
  assert.equal(row.ttfb, 1, 'CPA ttft_ms preferred');
  assert.equal(row.effort, 'high');
  assert.equal(row.result, 'ok');
  // the family filter / search also match the upstream name
  assert.ok((await bob.req('GET', '/api/traffic?q=thinking')).data.total >= 1);
  // fail.body is never stored
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(dataDir, 'portal.db'), { readOnly: true });
  const dump = JSON.stringify(d.prepare('SELECT * FROM usage').all());
  d.close();
  assert.ok(!dump.includes('UPSTREAM-SECRET-BODY') && !dump.includes('SECRET-PROMPT'));
});

test('admin: 最大等待时长 is read from / written to CPA; admin only', async () => {
  assert.equal((await bob.req('GET', '/api/admin/retry')).status, 403);
  assert.equal((await bob.req('PUT', '/api/admin/retry', { maxWait: 5 })).status, 403);
  assert.equal((await alice.req('GET', '/api/admin/retry')).data.maxRetryInterval, 45);
  const r = await alice.req('PUT', '/api/admin/retry', { maxWait: 60 });
  assert.equal(r.data.maxRetryInterval, 60);
  assert.equal(mock.st.retry['max-retry-interval'], 60);
  assert.equal((await alice.req('PUT', '/api/admin/retry', { maxWait: 9999 })).data.maxRetryInterval, 300);
});

test('credential cards: request strip and supported models are owner-scoped', async () => {
  const mine = (await bob.req('GET', '/api/accounts')).data[0];
  assert.ok(mine.requests.recent.length > 0 && mine.requests.recent.length <= 20);
  assert.ok(mine.requests.ok > 0);
  assert.ok(mine.tokens.total > 0 && mine.tokens.today === mine.tokens.total && mine.tokens.h5 === mine.tokens.total, JSON.stringify(mine.tokens));
  const m = await bob.req('GET', '/api/accounts/' + encodeURIComponent(mine.id) + '/models');
  assert.equal(m.status, 200);
  assert.deepEqual(m.data[0], { id: 'gemini-3-flash', name: 'Gemini 3 Flash', type: 'antigravity' });
  // another user cannot read bob's models; admin can
  assert.equal((await carol.req('GET', '/api/accounts/' + encodeURIComponent(mine.id) + '/models')).status, 404);
  assert.equal((await alice.req('GET', '/api/accounts/' + encodeURIComponent(mine.id) + '/models')).status, 200);
  assert.equal((await alice.req('GET', '/api/accounts/nope.json/models')).status, 404);
  assert.equal((await new Client().req('GET', '/api/accounts/' + encodeURIComponent(mine.id) + '/models')).status, 401);
  // carol's account list (none) carries nobody else's strip
  assert.deepEqual((await carol.req('GET', '/api/accounts')).data, []);
});

test('model test runs through exactly that credential and is logged; owner or admin only', async () => {
  const mine = (await bob.req('GET', '/api/accounts')).data[0];
  const path = '/api/accounts/' + encodeURIComponent(mine.id) + '/models/test';
  const before = mock.st.seenAllow.length;
  const r = await bob.req('POST', path, { model: 'gemini-3-flash' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.match(r.data.reply, new RegExp('hello from ' + mine.id.replace(/[.]/g, '\\.')));
  assert.deepEqual(mock.st.seenAllow.slice(before), [[mine.id]]);
  assert.equal((await bob.req('POST', path, { model: 'gpt-nobody-has' })).status, 400);
  assert.equal((await carol.req('POST', path, { model: 'gemini-3-flash' })).status, 404);
  assert.equal((await alice.req('POST', path, { model: 'gemini-3-flash' })).status, 200);
  const tr = await bob.req('GET', '/api/traffic?account=' + encodeURIComponent(mine.id));
  assert.equal(tr.status, 200);
  assert.ok(JSON.stringify(tr.data).includes('/portal/model-test'));
});

test('model list (/v1/models) only shows what the key\'s accounts support', async () => {
  const mine = (await bob.req('GET', '/api/accounts')).data[0];
  mock.st.credModels.set(mine.id, ['gemini-3-flash']);
  try {
    await sleep(1100); // gateway caches each account's list briefly; first fetch for this key below
    const r = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.bob } });
    const ids = (await r.json()).data.map((m: any) => m.id);
    assert.ok(ids.includes('gemini-3-flash'), ids.join());
    assert.ok(!ids.includes('gpt-nobody-has') && !ids.includes('claude-sonnet-4-6'), ids.join());
  } finally {
    mock.st.credModels.delete(mine.id);
  }
  // a key whose owner has no accounts gets an empty list
  const dave = await new Client().login('100009', 'dave');
  const kd = (await dave.req('POST', '/api/keys', { name: 'd', pool: 'private' })).data.key;
  const rd = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + kd } });
  assert.deepEqual((await rd.json()).data, []);
});

test('add by refresh token: CPA refreshes it, userinfo names it, temp file removed', async () => {
  const dave = await new Client().login('100009', 'dave');
  const good = '1//0g' + 'A'.repeat(40), other = '1//0g' + 'B'.repeat(40);
  mock.st.rt.set(good, 'rt1@example.invalid');
  mock.st.rt.set(other, 'a1@example.invalid'); // already alice's
  const r = await dave.req('POST', '/api/accounts/refresh-token', { tokens: `${good}\n${other}\n1//0gNOTKNOWN${'C'.repeat(30)}\nnot-a-token` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const res = r.data.results;
  assert.deepEqual(res.map((x: any) => [x.ok, x.error || x.email]), [[true, 'rt1@example.invalid'], [false, 'duplicate'], [false, 'invalid_token'], [false, 'invalid_token']]);
  assert.ok(!JSON.stringify(res).includes('A'.repeat(20)), 'tokens are not echoed');
  const id = 'antigravity-rt1@example.invalid.json';
  const f = mock.st.files.get(id);
  assert.equal(f.email, 'rt1@example.invalid');
  assert.equal(f.refresh_token, good);
  assert.equal(f.project_id, 'proj-rt');
  assert.ok(!('disabled' in f));
  assert.equal(mock.st.creds.get(id)!.disabled, false);
  assert.deepEqual([...mock.st.creds.keys()].filter((k) => k.startsWith('antigravity-rt-')), []);
  assert.deepEqual((await dave.req('GET', '/api/accounts')).data.map((a: any) => a.email), ['rt1@example.invalid']);
  assert.equal((await dave.req('POST', '/api/accounts/refresh-token', { tokens: '' })).status, 400);
  await dave.req('DELETE', '/api/accounts/' + encodeURIComponent(id));
});

test('export own credentials (JSON / ZIP), import a JSON array back', async () => {
  const erin = await new Client().login('100011', 'erin');
  for (const e of ['e1@example.invalid', 'e2@example.invalid']) assert.equal((await erin.upload(e)).data.results[0].ok, true);
  const ids = (await erin.req('GET', '/api/accounts')).data.map((a: any) => a.id);
  const ex = (body: any, who = erin) => fetch(base + '/api/accounts/export', { method: 'POST', headers: { cookie: who.cookie, 'X-Portal-CSRF': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const one_ = await ex({ ids: [ids[0]] });
  assert.equal(one_.status, 200);
  assert.match(one_.headers.get('content-disposition') || '', /attachment; filename="antigravity-e1@example.invalid.json"/);
  const j = await one_.json();
  assert.equal(j.email, 'e1@example.invalid');
  assert.ok(!('proxy_url' in j) && !('disabled' in j));
  const z = Buffer.from(await (await ex({ ids })).arrayBuffer());
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const { readZip } = await import('../src/zip.ts');
  assert.deepEqual(readZip(z).map((e) => JSON.parse(e.data.toString()).email).sort(), ['e1@example.invalid', 'e2@example.invalid']);
  const arr = await (await ex({ ids, format: 'json' })).json();
  assert.equal(arr.length, 2);
  // someone else's account: refused
  assert.equal((await ex({ ids: [ids[0]] }, bob)).status, 404);
  // delete both, import the array file back in one go
  for (const id of ids) await erin.req('DELETE', '/api/accounts/' + encodeURIComponent(id));
  const up = await erin.req('POST', '/api/accounts/upload?name=all.json', undefined, Buffer.from(JSON.stringify(arr)));
  assert.deepEqual(up.data.results.map((r: any) => [r.name, r.ok]), [['all.json #1', true], ['all.json #2', true]]);
  for (const a of (await erin.req('GET', '/api/accounts')).data) await erin.req('DELETE', '/api/accounts/' + encodeURIComponent(a.id));
});

test('announcements: admin publishes / edits / deletes, users see unread then seen', async () => {
  assert.equal((await bob.req('POST', '/api/admin/announcements', { title: 'x' })).status, 403);
  const a = await alice.req('POST', '/api/admin/announcements', { title: '更新', body: '**新功能**\n- 一\n- 二', level: 'important', pinned: true });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.discord, null);
  assert.equal((await alice.req('POST', '/api/admin/announcements', { title: '' })).status, 400);
  let l = await bob.req('GET', '/api/announcements');
  assert.equal(l.data.unread, 1);
  assert.deepEqual([l.data.list[0].title, l.data.list[0].level, l.data.list[0].pinned], ['更新', 'important', true]);
  await bob.req('POST', '/api/announcements/seen');
  assert.equal((await bob.req('GET', '/api/announcements')).data.unread, 0);
  assert.equal((await alice.req('PATCH', '/api/admin/announcements/' + a.data.id, { title: '更新 2', body: '', pinned: false })).data.title, '更新 2');
  assert.equal((await bob.req('PATCH', '/api/admin/announcements/' + a.data.id, { title: 'h' })).status, 403);
  await alice.req('DELETE', '/api/admin/announcements/' + a.data.id);
  assert.deepEqual((await bob.req('GET', '/api/announcements')).data.list, []);
  const ic = await fetch(base + '/icons/gemini.svg');
  assert.equal(ic.status, 200);
  assert.equal(ic.headers.get('content-type'), 'image/svg+xml');
});

test('大锅饭 daily limit: every request counts, refused ones do not; admin override', async () => {
  const fr = await new Client().login('100021', 'frank');
  const kf = (await fr.req('POST', '/api/keys', { name: 'f', pool: 'shared' })).data.key;
  await alice.req('PUT', '/api/admin/rules', { dailyBase: 2, dailyPer: 500 });
  try {
    assert.equal((await gen(kf)).status, 200);
    await gen(kf, { model: 'no-such-model' }); // a failed request still counts
    const r = await gen(kf);
    assert.equal(r.status, 429);
    assert.match(r.text, /今日大锅饭次数已用完（2\/2）/);
    assert.ok(Number(r.retryAfter) > 0);
    const ov = (await fr.req('GET', '/api/overview')).data.daily;
    assert.deepEqual([ov.used, ov.limit, ov.valid], [2, 2, 0]);
    const fid = (await alice.req('GET', '/api/admin/users')).data.find((u: any) => u.name === 'frank');
    assert.deepEqual([fid.dailyUsed, fid.dailyLimit], [2, 2]);
    assert.equal((await bob.req('PATCH', '/api/admin/users/' + fid.id, { dailyLimit: -1 })).status, 403);
    await alice.req('PATCH', '/api/admin/users/' + fid.id, { dailyLimit: -1 });
    assert.equal((await gen(kf)).status, 200);
    assert.equal((await fr.req('GET', '/api/overview')).data.daily.limit, null);
    // a fixed 0 blocks the shared pool
    await alice.req('PATCH', '/api/admin/users/' + fid.id, { dailyLimit: 0 });
    assert.equal((await gen(kf)).status, 429);
  } finally {
    await alice.req('PUT', '/api/admin/rules', { dailyBase: 200, dailyPer: 500 });
  }
});

test('external upstream (Tools): takes turns with shared accounts, catches CPA 429, own key, tokens recorded', async () => {
  const seen: { auth: string; path: string }[] = [];
  let toolsDown = false;
  const tools = http.createServer((req, res) => {
    const ch: Buffer[] = [];
    req.on('data', (c) => ch.push(c));
    req.on('end', () => {
      seen.push({ auth: String(req.headers.authorization), path: String(req.url) });
      if (toolsDown && req.url !== '/v1/models') { res.writeHead(503); return res.end('{"error":"no accounts"}'); }
      if (req.headers.authorization !== 'Bearer tools-key') { res.writeHead(401); return res.end('{}'); }
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: ['gemini-3-flash', 'claude-sonnet-4-6', 'tools-only-model'].map((id) => ({ id })) })); }
      const j = JSON.parse(Buffer.concat(ch).toString() || '{}');
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"from tools"}}]}\n\n');
        res.end('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"prompt_tokens_details":{"cached_tokens":5}}}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ served_by: 'tools', usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    });
  });
  await new Promise<void>((r) => tools.listen(0, '127.0.0.1', () => r()));
  const port = (tools.address() as AddressInfo).port;
  const up = await alice.req('POST', '/api/admin/upstreams', { name: 'Tools', url: `http://127.0.0.1:${port}/v1`, key: 'tools-key' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await bob.req('GET', '/api/admin/upstreams')).status, 403);
  try {
    const t = await alice.req('POST', `/api/admin/upstreams/${up.data.id}/test`);
    assert.deepEqual([t.data.ok, t.data.count], [true, 3]);
    assert.ok(!JSON.stringify((await alice.req('GET', '/api/admin/upstreams')).data).includes('tools-key'));
    // rotation: within a few requests one goes to Tools
    const served: (string | null)[] = [];
    for (let i = 0; i < 8; i++) served.push((await gen(K.carol)).served);
    assert.ok(served.includes('tools'), served.join());
    assert.ok(served.some((x) => x && x !== 'tools'), served.join());
    assert.ok(seen.every((x) => x.auth === 'Bearer tools-key'));
    assert.ok(seen.some((x) => x.path === '/v1/chat/completions'));
    // stream: tokens read from the passing SSE
    let st = '';
    for (let i = 0; i < 12 && !st.includes('from tools'); i++) st = (await gen(K.carol, { stream: true })).text;
    assert.match(st, /from tools/);
    await sleep(100);
    const tr = (await alice.req('GET', '/api/admin/traffic?size=50')).data.rows.find((r: any) => r.stream && r.account === 'Tools');
    assert.ok(tr, 'tools row in traffic');
    assert.deepEqual([tr.in, tr.out, tr.cache], [11, 22, 5]);
    // CPA has no account (claude 429) -> same request goes to Tools
    mock.st.claude429 = true;
    try {
      for (let i = 0; i < 3; i++) assert.equal((await gen(K.carol, { model: 'claude-sonnet-4-6' })).served, 'tools');
    } finally { mock.st.claude429 = false; }
    // only the models the admin opened go to Tools
    await alice.req('PATCH', `/api/admin/upstreams/${up.data.id}`, { models: ['tools-only-model'] });
    const nA = seen.length;
    for (let i = 0; i < 6; i++) await gen(K.carol);
    assert.equal(seen.filter((x, i) => i >= nA && x.path !== '/v1/models').length, 0);
    assert.deepEqual((await alice.req('GET', '/api/admin/upstreams')).data[0].allow, ['tools-only-model']);
    // a model only Tools serves goes straight to Tools, never through CPA
    const cpaSeen = mock.st.seenAllow.length;
    for (let i = 0; i < 4; i++) assert.equal((await gen(K.carol, { model: 'tools-only-model' })).served, 'tools');
    assert.equal(mock.st.seenAllow.length, cpaSeen);
    // shared keys list Tools-only models; private keys do not
    const ids = (await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.carol } })).json()).data.map((m: any) => m.id);
    assert.ok(ids.includes('tools-only-model'), ids.join());
    const idsP = (await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.bob } })).json()).data.map((m: any) => m.id);
    assert.ok(!idsP.includes('tools-only-model'));
    // Tools answering 503: those requests fall back to the Google accounts
    toolsDown = true;
    for (let i = 0; i < 6; i++) { const g = await gen(K.carol); assert.equal(g.status, 200); assert.notEqual(g.served, 'tools'); }
    toolsDown = false;
    // private pool never goes to Tools
    const n0 = seen.length;
    for (let i = 0; i < 4; i++) await gen(K.bob);
    assert.equal(seen.length, n0);
  } finally {
    await alice.req('DELETE', '/api/admin/upstreams/' + up.data.id);
    tools.close();
  }
  // prefill (last message from the assistant): a clear Chinese message, and the reason is logged
  const pf = await gen(K.bob, { body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '好的，' }] } });
  assert.equal(pf.status, 400);
  assert.match(pf.text, /预填充/);
  await sleep(50);
  const pr = (await bob.req('GET', '/api/traffic?size=5')).data.rows[0];
  assert.match(JSON.stringify(pr), /预填充/);
  // 站长兜底公益池 stats on the 大锅饭 page: everyone sees the totals
  const bk = (await bob.req('GET', '/api/pool/resources')).data.backup;
  assert.ok(bk.today.n >= 1 && bk.total.n >= bk.today.n && bk.today.t > 0 && bk.since, JSON.stringify(bk));
  assert.ok(bk.share > 0 && bk.share <= 100);
  const sh = (await bob.req('GET', '/api/pool/resources')).data.shared; // shared Google accounts, upstreams excluded
  assert.ok(sh.total.n >= 1 && sh.total.t > 0 && sh.since, JSON.stringify(sh));
});

test('model allowlists (大锅饭 / upstream) and per-account reserve', async () => {
  // 大锅饭 opens only gemini-3-flash
  assert.equal((await bob.req('PUT', '/api/admin/shared-models', { allow: ['gemini-3-flash'] })).status, 403);
  const sm = await alice.req('GET', '/api/admin/shared-models');
  assert.ok(sm.data.all.some((m: any) => m.id === 'claude-sonnet-4-6' && m.from.includes('google')), JSON.stringify(sm.data));
  await alice.req('PUT', '/api/admin/shared-models', { allow: ['gemini-3-flash'] });
  try {
    const g = await gen(K.carol, { model: 'claude-sonnet-4-6' });
    assert.equal(g.status, 404);
    assert.match(g.text, /大锅饭没有开放 claude-sonnet-4-6/);
    assert.equal((await gen(K.carol)).status, 200);
    assert.equal((await gen(K.bob, { model: 'claude-sonnet-4-6' })).status, 200); // 小锅饭 unaffected
    const ids = (await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + K.carol } })).json()).data.map((m: any) => m.id);
    assert.deepEqual(ids, ['gemini-3-flash']);
  } finally {
    await alice.req('PUT', '/api/admin/shared-models', { allow: null });
  }
  // per-account reserve: owner picks, validated, overrides the rule
  const acc = (await bob.req('GET', '/api/accounts')).data[0];
  const path = '/api/accounts/' + encodeURIComponent(acc.id);
  assert.equal((await bob.req('PATCH', path, { reserve: 95 })).status, 400);
  assert.equal((await bob.req('PATCH', path, { reserve: 50 })).data.reserve, 50);
  assert.equal((await bob.req('PATCH', path, { reserve: null })).data.reserve, null);
});

test('输入上限: oversized input is refused with 输入过限 before reaching an account; images do not count', async () => {
  assert.equal((await bob.req('PATCH', '/api/me', { inputLimit: 5 })).status, 400);
  assert.equal((await bob.req('PATCH', '/api/me', { inputLimit: 2000 })).status, 200);
  assert.equal((await bob.req('GET', '/api/me')).data.inputLimit, 2000);
  try {
    const big = (s: string) => ({ model: 'gemini-3-flash', messages: [{ role: 'user', content: s }] });
    const r = await gen(K.bob, { body: big('a'.repeat(12000)) }); // ~3000 tokens
    assert.equal(r.status, 400);
    assert.match(r.text, /输入过限/);
    assert.match(r.text, /input_limit_exceeded/);
    assert.equal((await gen(K.bob, { body: big('中'.repeat(2500)) })).status, 400); // CJK ~1 token per character
    assert.equal((await gen(K.bob, { body: big('a'.repeat(4000)) })).status, 200);
    // a large inline image is not prompt text
    const img = { model: 'gemini-3-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200000) } }] }] };
    assert.equal((await gen(K.bob, { body: img })).status, 200);
    const t = (await bob.req('GET', '/api/traffic?limit=10')).data;
    assert.ok(JSON.stringify(t).includes('input_limit'), JSON.stringify(t).slice(0, 400));
  } finally {
    assert.equal((await bob.req('PATCH', '/api/me', { inputLimit: null })).status, 200);
  }
  assert.equal((await gen(K.bob, { body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'a'.repeat(12000) }] } })).status, 200);
});

test('大锅饭输入上限 (admin rule): refused for shared keys only', async () => {
  assert.equal((await alice.req('GET', '/api/rules')).data.sharedInput, 500000);
  await alice.req('PUT', '/api/admin/rules', { sharedInput: 2000 });
  try {
    const big = { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'a'.repeat(12000) }] };
    const r = await gen(K.carol, { body: big });
    assert.equal(r.status, 400);
    assert.match(r.text, /大锅饭的输入上限/);
    assert.equal((await gen(K.bob, { body: big })).status, 200); // 小锅饭 unaffected
  } finally { await alice.req('PUT', '/api/admin/rules', { sharedInput: 500000 }); }
});

test('bot chat settings: admin picks the model and a custom prompt', async () => {
  assert.equal((await bob.req('GET', '/api/admin/botchat')).status, 403);
  const g = (await alice.req('GET', '/api/admin/botchat')).data;
  assert.equal(g.custom, false);
  assert.ok(g.models.includes('gemini-3-flash'), JSON.stringify(g.models));
  assert.equal((await alice.req('PUT', '/api/admin/botchat', { model: 'bad model!' })).status, 400);
  assert.equal((await alice.req('PUT', '/api/admin/botchat', { source: 'up:999' })).status, 400);
  assert.equal(g.source, 'cpa');
  assert.equal(g.sources[0].id, 'cpa');
  const p = (await alice.req('PUT', '/api/admin/botchat', { model: 'gemini-3-pro-high', prompt: '你是测试机器人' })).data;
  assert.deepEqual([p.model, p.custom], ['gemini-3-pro-high', true]);
  assert.equal((await alice.req('GET', '/api/admin/botchat')).data.prompt, '你是测试机器人');
  await alice.req('PUT', '/api/admin/botchat', { model: 'gemini-3-flash', prompt: null });
  assert.equal((await alice.req('GET', '/api/admin/botchat')).data.custom, false);
});

test('plugin not effective -> portal refuses (fail closed)', async () => {
  mock.st.plugin.effective_enabled = false;
  await sleep(150);
  const r = await gen(K.alice);
  assert.equal(r.status, 503);
  assert.match(r.text, /scheduler_unavailable/);
  mock.st.plugin.effective_enabled = true;
  mock.st.plugin.registered = false;
  await sleep(150);
  assert.equal((await gen(K.alice)).status, 503);
  mock.st.plugin.registered = true;
  await sleep(150);
  assert.equal((await gen(K.alice)).status, 200);
});

test('served account outside the allow list -> alarm, abort, circuit breaker', async () => {
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  mock.st.rogue = b1;
  const r = await gen(K.alice, { stream: true });
  mock.st.rogue = null;
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes('hello'), 'no upstream bytes reach the client');
  const after = await gen(K.alice);
  assert.equal(after.status, 503);
  assert.match(after.text, /gateway_locked/);
  const u = await alice.req('GET', '/api/admin/usage');
  assert.equal(u.data.breaker.tripped, true);
  assert.equal(u.data.alarms[0].kind, 'allow_violation');
  assert.equal((await bob.req('POST', '/api/admin/breaker/reset')).status, 403);
  await alice.req('POST', '/api/admin/breaker/reset');
  assert.equal((await gen(K.alice)).status, 200);
  // missing trace on a successful generation is treated the same way
  mock.st.dropTrace = true;
  assert.equal((await gen(K.alice)).status, 502);
  mock.st.dropTrace = false;
  assert.equal((await gen(K.alice)).status, 503);
  await alice.req('POST', '/api/admin/breaker/reset');
});

test('disabling a user disables keys and CPA credentials; enabling restores', async () => {
  const users = (await alice.req('GET', '/api/admin/users')).data;
  const bobId = users.find((u: any) => u.name === 'bob').id;
  const b1 = (await bob.req('GET', '/api/accounts')).data[0].id;
  await alice.req('PATCH', '/api/admin/users/' + bobId, { active: false });
  assert.equal((await gen(K.bob)).status, 401);
  assert.equal(mock.st.creds.get(b1)!.disabled, true);
  assert.equal((await bob.req('GET', '/api/me')).status, 401, 'sessions dropped');
  for (let i = 0; i < 3; i++) assert.notEqual((await gen(K.carol)).served, b1);
  await alice.req('PATCH', '/api/admin/users/' + bobId, { active: true });
  assert.equal(mock.st.creds.get(b1)!.disabled, false);
  assert.equal((await gen(K.bob)).status, 200);
});

test('admin: proxies are exclusive and masked; users see only masked', async () => {
  await alice.req('POST', '/api/admin/proxies', { url: 'socks5://u:secretpw@203.0.113.7:1080' });
  const px = (await alice.req('GET', '/api/admin/proxies')).data;
  assert.equal(px[0].url, 'socks5://••••@203.0.113.7:1080');
  const acc = (await alice.req('GET', '/api/admin/accounts')).data;
  const [x, y] = acc;
  assert.equal((await alice.req('PATCH', '/api/admin/accounts/' + encodeURIComponent(x.id), { proxyId: px[0].id })).status, 200);
  assert.equal(mock.st.creds.get(x.id)!.proxy_url, 'socks5://u:secretpw@203.0.113.7:1080');
  assert.equal((await alice.req('PATCH', '/api/admin/accounts/' + encodeURIComponent(y.id), { proxyId: px[0].id })).status, 409);
  const all = JSON.stringify((await alice.req('GET', '/api/accounts')).data) + JSON.stringify((await bob.req('GET', '/api/accounts')).data);
  assert.ok(!all.includes('secretpw'));
});

test('admin site settings: secrets are write-only', async () => {
  const r = await alice.req('PUT', '/api/admin/site', { publicURL: 'https://pot.example.com', clientId: '123456789', clientSecret: 'TOPSECRET', guildId: '987654321', roleIds: '111111,222222', botToken: 'BOTSECRET' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const g = await alice.req('GET', '/api/admin/site');
  const s = JSON.stringify(g.data);
  assert.ok(!s.includes('TOPSECRET') && !s.includes('BOTSECRET'));
  assert.equal(g.data.clientSecretSet, true);
  assert.equal(g.data.redirectURI, 'https://pot.example.com/auth/discord/callback');
  const cfg = await new Client().req('GET', '/api/config');
  assert.equal(cfg.data.discord, true);
  // login redirect uses the new settings without a restart
  const lr = await fetch(base + '/auth/discord/login', { redirect: 'manual' });
  assert.equal(lr.status, 302);
  assert.match(lr.headers.get('location')!, /client_id=123456789/);
  assert.match(lr.headers.get('location')!, /guilds\.members\.read/);
});

test('static UI has CSP and no inline script', async () => {
  const r = await fetch(base + '/');
  const csp = r.headers.get('content-security-policy')!;
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  const html = await r.text();
  assert.ok(!/<script>/.test(html));
});
