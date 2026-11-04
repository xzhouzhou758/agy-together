// 共享浏览器: queue, sessions and proxy, in-process against a mock browserd and a mock Selkies. Run: npm test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const TOKEN = 'browserd-test-token';
const calls: string[] = [];
let failStarts = 0;
const helperSrv = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + TOKEN) return res.writeHead(401).end();
  calls.push(req.method + ' ' + req.url);
  if (req.url === '/start' && failStarts > 0) {
    failStarts--;
    return res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"boom"}');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
});
// Stand-in for the container: echoes what it got; answers upgrades with 101 and echoes bytes.
const seen: { path: string; cookie?: string }[] = [];
const upSrv = http.createServer((req, res) => {
  seen.push({ path: req.url || '', cookie: req.headers.cookie });
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'x=1', 'X-Frame-Options': 'DENY' }).end('selkies ' + req.url);
});
upSrv.on('upgrade', (req, socket) => {
  seen.push({ path: req.url || '', cookie: req.headers.cookie });
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (d) => socket.write(d));
});

let dataDir = '';
let portal: http.Server;
let base = '';
let br: typeof import('../src/browser.ts');
let db: typeof import('../src/db.ts');
let util: typeof import('../src/util.ts');
let T = 1_000_000;
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(who: string, method: string, path: string) {
  const r = await fetch(base + path, { method, headers: { cookie: cookies[who] || '', 'X-Portal-CSRF': '1' } });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, headers: r.headers };
}
const state = async (who: string) => (await call(who, 'GET', '/xgf/api/browser')).data;

before(async () => {
  for (const s of [helperSrv, upSrv]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-br-'));
  Object.assign(process.env, {
    DATA_DIR: dataDir, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm', BASE_PATH: '/xgf', COOKIE_SECURE: '0',
    BROWSERD_URL: `http://127.0.0.1:${(helperSrv.address() as AddressInfo).port}`, BROWSERD_TOKEN: TOKEN,
    BROWSER_UPSTREAM: `http://127.0.0.1:${(upSrv.address() as AddressInfo).port}`, BROWSER_SESSION_MINUTES: '15',
  });
  db = await import('../src/db.ts');
  util = await import('../src/util.ts');
  br = await import('../src/browser.ts');
  const { handleAPI } = await import('../src/api.ts');
  br.setClock(() => T);
  for (const n of ['alice', 'bob', 'carol']) {
    db.run('INSERT INTO users (discord_id, name, created_at) VALUES (?, ?, ?)', 'd-' + n, n, Date.now());
    ids[n] = Number(db.one('SELECT id FROM users WHERE name = ?', n)!.id);
    const sid = util.token(16);
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', util.sha256(sid), ids[n], Date.now(), Date.now() + 86400e3);
    cookies[n] = 'agy_sid=' + sid;
  }
  portal = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    url.pathname = url.pathname.slice('/xgf'.length);
    try {
      if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);
      if (url.pathname === '/browser' || url.pathname.startsWith('/browser/')) return await br.handleBrowser(req, res, url);
      res.writeHead(404).end();
    } catch (e) {
      util.sendError(res, e);
    }
  });
  portal.on('upgrade', br.handleBrowserUpgrade);
  await new Promise<void>((r) => portal.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
});
after(() => {
  br.resetBrowser();
  portal.close(); helperSrv.close(); upSrv.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => { br.resetBrowser(); calls.length = 0; failStarts = 0; T += 3600e3; });

test('join starts a session; second user queues; leave hands the slot over', async () => {
  assert.equal((await state('alice')).state, 'idle');
  assert.equal((await call('alice', 'POST', '/xgf/api/browser/join')).status, 200);
  await br.tick();
  let a = await state('alice');
  assert.equal(a.state, 'active');
  assert.equal(a.remainingSec, 15 * 60);
  assert.deepEqual(calls, ['POST /start']);
  assert.equal((await state('bob')).state, 'busy');
  await call('bob', 'POST', '/xgf/api/browser/join');
  await call('bob', 'POST', '/xgf/api/browser/join'); // one entry per user
  await br.tick();
  const b = await state('bob');
  assert.equal(b.state, 'queued');
  assert.equal(b.position, 1);
  assert.equal(b.queueLength, 1);
  await call('alice', 'POST', '/xgf/api/browser/join'); // the holder can't queue again
  assert.equal((await state('alice')).queueLength, 1);
  const adm = (await call('alice', 'GET', '/xgf/api/admin/browser')).status;
  assert.equal(adm, 403);
  await call('alice', 'POST', '/xgf/api/browser/leave');
  await br.tick();
  assert.equal((await state('alice')).state, 'busy');
  assert.equal((await state('bob')).state, 'active');
  assert.deepEqual(calls, ['POST /start', 'POST /stop', 'POST /start']);
});

test('session ends at expiry and the next in line starts', async () => {
  await call('alice', 'POST', '/xgf/api/browser/join');
  await br.tick();
  await call('bob', 'POST', '/xgf/api/browser/join');
  for (let i = 0; i < 15 * 12; i++) { // both keep polling every 5s
    T += 5000;
    await state('alice'); await state('bob');
    await br.tick();
  }
  assert.equal((await state('alice')).state, 'busy');
  assert.equal((await state('bob')).state, 'active');
  assert.ok(calls.includes('POST /stop'));
});

test('missed heartbeats: queued user dropped after 60s, holder after 90s', async () => {
  await call('alice', 'POST', '/xgf/api/browser/join');
  await br.tick();
  await call('bob', 'POST', '/xgf/api/browser/join');
  await call('carol', 'POST', '/xgf/api/browser/join');
  T += 61000;
  await state('alice'); await state('carol'); // bob went quiet
  await br.tick();
  assert.equal((await state('bob')).state, 'busy');
  assert.equal((await state('carol')).position, 1);
  T += 50000; await state('carol'); await br.tick();
  T += 45000; await state('carol'); await br.tick(); // alice unseen for 95s
  assert.equal((await state('carol')).state, 'active');
});

test('helper start failure: user stays at the head and is retried with backoff', async () => {
  failStarts = 2;
  await call('alice', 'POST', '/xgf/api/browser/join');
  await br.tick();
  assert.equal((await state('alice')).state, 'queued');
  await br.tick(); // still backing off: no new attempt
  assert.equal(calls.filter((c) => c === 'POST /start').length, 1);
  T += 5000; await state('alice'); await br.tick();
  assert.equal(calls.filter((c) => c === 'POST /start').length, 2);
  T += 5000; await state('alice'); await br.tick(); // 10s backoff after the second failure
  assert.equal(calls.filter((c) => c === 'POST /start').length, 2);
  T += 5000; await state('alice'); await br.tick();
  assert.equal((await state('alice')).state, 'active');
});

test('proxy: only the holder gets through, cookies stripped, upgrades too', async () => {
  assert.equal((await call('alice', 'GET', '/xgf/browser/')).status, 403);
  await call('alice', 'POST', '/xgf/api/browser/join');
  await br.tick();
  assert.equal((await call('bob', 'GET', '/xgf/browser/')).status, 403);
  assert.equal((await call('anon', 'GET', '/xgf/browser/')).status, 403);
  const r = await call('alice', 'GET', '/xgf/browser/index.html?x=1');
  assert.equal(r.status, 200);
  assert.equal(r.data, 'selkies /xgf/browser/index.html?x=1');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(seen.at(-1)!.cookie, undefined);

  const port = (portal.address() as AddressInfo).port;
  const ws = (who: string, path: string) => new Promise<{ head: string; sock: net.Socket }>((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookies[who] || ''}\r\n\r\n`);
    });
    sock.once('data', (d) => resolve({ head: d.toString(), sock }));
  });
  const bad = await ws('bob', '/xgf/browser/api/websockets');
  assert.match(bad.head, /^HTTP\/1.1 403/);
  bad.sock.destroy();
  const other = await ws('alice', '/xgf/api/whatever');
  assert.match(other.head, /^HTTP\/1.1 404/);
  other.sock.destroy();
  const ok = await ws('alice', '/xgf/browser/api/websockets');
  assert.match(ok.head, /^HTTP\/1.1 101/);
  assert.equal(seen.at(-1)!.path, '/xgf/browser/api/websockets');
  assert.equal(seen.at(-1)!.cookie, undefined);
  const echo = new Promise<string>((r) => ok.sock.once('data', (d) => r(d.toString())));
  ok.sock.write('ping');
  assert.equal(await echo, 'ping');
  const closed = new Promise((r) => ok.sock.on('close', r));
  await call('alice', 'POST', '/xgf/api/browser/leave'); // ending the session cuts the stream
  await closed;
});
