// 共享浏览器: one Chromium container (linuxserver/chromium, Selkies web UI) on this host, so members can
// sign in to Google from the server's IP. The host only has RAM for one, so: a single slot, a FIFO queue,
// fixed-length sessions, and a fresh container per session (ops/browserd.py starts and destroys it; the
// portal never touches docker). State is in memory only; a restart clears the slot and the queue.
// The UI is proxied under <base>/browser/ (the container is told that subfolder) and only the current
// holder's session cookie gets through, for plain requests and WebSocket upgrades alike.
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from './config.ts';
import { one } from './db.ts';
import { currentUser } from './auth.ts';
import { HttpError } from './util.ts';

export const browserOn = () => !!config.browserdToken;

const QUEUE_GONE_MS = 60000;   // a queued user not polling for this long loses their place
const ACTIVE_GONE_MS = 90000;  // the holder not polling (and no live stream) for this long ends the session
const TICK_MS = 5000;

type Active = { userId: number; startedAt: number; expiresAt: number; lastSeen: number };
type Waiting = { userId: number; joinedAt: number; lastSeen: number; cancelled?: boolean };

let clock = () => Date.now();
/** Tests drive time by hand. */
export function setClock(fn: () => number) { clock = fn; }

let active: Active | null = null;
let starting: Waiting | null = null;
let queue: Waiting[] = [];
let failures = 0, retryAt = 0;
const sockets = new Set<Duplex>(); // upgraded connections of the current session, both ends

/** Test helper: forget everything. */
export function resetBrowser() {
  active = null; starting = null; queue = []; failures = 0; retryAt = 0;
  for (const s of sockets) s.destroy();
  sockets.clear();
}

async function helper(path: '/start' | '/stop', timeoutMs: number): Promise<void> {
  const r = await fetch(config.browserdURL + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.browserdToken },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    let msg = '';
    try { msg = String((await r.json())?.error || ''); } catch {}
    throw new Error(`browserd ${path} ${r.status}${msg ? ': ' + msg : ''}`);
  }
}

async function endSession(why: string) {
  const s = active;
  if (!s) return;
  active = null;
  console.log(`[browser] session of user ${s.userId} ended (${why})`);
  for (const x of sockets) x.destroy();
  sockets.clear();
  try { await helper('/stop', 30000); } catch (e) { console.error('[browser] stop failed:', (e as Error).message); }
}

async function startNext() {
  const w = queue.shift()!;
  starting = w;
  try {
    await helper('/start', 90000);
  } catch (e) {
    starting = null;
    failures++;
    retryAt = clock() + Math.min(60000, 5000 * 2 ** (failures - 1));
    console.error(`[browser] start for user ${w.userId} failed (attempt ${failures}):`, (e as Error).message);
    if (!w.cancelled) queue.unshift(w);
    return;
  }
  starting = null;
  failures = 0;
  if (w.cancelled) {
    console.log(`[browser] user ${w.userId} left while starting`);
    try { await helper('/stop', 30000); } catch (e) { console.error('[browser] stop failed:', (e as Error).message); }
    return;
  }
  const t = clock();
  active = { userId: w.userId, startedAt: t, expiresAt: t + config.browserSessionMinutes * 60000, lastSeen: Math.max(w.lastSeen, t) };
  console.log(`[browser] session started for user ${w.userId}`);
}

async function doTick() {
  const t = clock();
  queue = queue.filter((q) => t - q.lastSeen <= QUEUE_GONE_MS);
  if (active && sockets.size) active.lastSeen = t; // a live stream counts as presence (e.g. opened in its own window)
  if (active && t >= active.expiresAt) await endSession('expired');
  else if (active && t - active.lastSeen > ACTIVE_GONE_MS) await endSession('gone');
  if (!active && !starting && queue.length && clock() >= retryAt) await startNext();
}

// Everything that starts or stops the container runs one at a time, so a stop can't overtake a start.
let chain: Promise<void> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const p = chain.then(fn).catch((e) => console.error('[browser]', e));
  chain = p;
  return p;
}
let pending: Promise<void> | null = null;
/** Expire, drop the absent, and start the next in line. Calls made while one is waiting share it. */
export function tick(): Promise<void> {
  if (!pending) pending = serial(async () => { pending = null; await doTick(); });
  return pending;
}

// ---------- views ----------
const nameOf = (id: number) => String(one('SELECT name FROM users WHERE id = ?', id)?.name || '#' + id);
const remaining = (a: Active) => Math.max(0, Math.ceil((a.expiresAt - clock()) / 1000));

export type BrowserState = 'idle' | 'queued' | 'starting' | 'active' | 'busy';
/** Status from one user's point of view. Doubles as their heartbeat. */
export function viewFor(userId: number) {
  const t = clock();
  const base = { enabled: browserOn(), queueLength: queue.length, minutes: config.browserSessionMinutes };
  if (active?.userId === userId) {
    active.lastSeen = t;
    return { ...base, state: 'active' as BrowserState, remainingSec: remaining(active) };
  }
  if (starting?.userId === userId && !starting.cancelled) {
    starting.lastSeen = t;
    return { ...base, state: 'starting' as BrowserState };
  }
  const i = queue.findIndex((q) => q.userId === userId);
  if (i >= 0) {
    queue[i].lastSeen = t;
    if (i === 0 && !active && !starting && t >= retryAt) return { ...base, state: 'starting' as BrowserState }; // about to be picked up
    return { ...base, state: 'queued' as BrowserState, position: i + (active || starting ? 1 : 0) };
  }
  return { ...base, state: (active || starting || queue.length ? 'busy' : 'idle') as BrowserState };
}

export function adminView() {
  return {
    enabled: browserOn(),
    active: active ? { name: nameOf(active.userId), remainingSec: remaining(active) } : null,
    starting: starting && !starting.cancelled ? nameOf(starting.userId) : null,
    queue: queue.map((q) => nameOf(q.userId)),
  };
}

function need() {
  if (!browserOn()) throw new HttpError(404, 'not_found');
}

export async function join(userId: number) {
  need();
  const busy = active?.userId === userId || (starting?.userId === userId && !starting.cancelled) || queue.some((q) => q.userId === userId);
  if (!busy) {
    const t = clock();
    queue.push({ userId, joinedAt: t, lastSeen: t });
    tick();
  }
  return viewFor(userId);
}

export async function leave(userId: number) {
  need();
  if (active?.userId === userId) await serial(async () => { if (active?.userId === userId) await endSession('left'); });
  else if (starting?.userId === userId) starting.cancelled = true;
  else queue = queue.filter((q) => q.userId !== userId);
  tick();
  return viewFor(userId);
}

export async function kick() {
  need();
  await serial(() => endSession('kicked'));
  tick();
  return adminView();
}

export function startBrowser() {
  if (!browserOn()) return;
  // Whatever ran before a restart belonged to a session we no longer know about.
  helper('/stop', 30000).catch((e) => console.error('[browser] initial stop failed:', e.message));
  setInterval(tick, TICK_MS).unref();
}

// ---------- proxy ----------
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'cookie', 'authorization', 'content-length']);

function isHolder(req: IncomingMessage): boolean {
  if (!browserOn() || !active) return false;
  const u = currentUser(req);
  return !!u && u.id === active.userId;
}

/** <base>/browser/... -> the container, which serves under the same full path. */
export async function handleBrowser(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!browserOn()) throw new HttpError(404, 'not_found');
  if (url.pathname === '/browser') {
    res.writeHead(301, { Location: config.basePath + '/browser/' + url.search }).end();
    return;
  }
  if (!isHolder(req)) throw new HttpError(403, 'forbidden');
  const target = new URL(config.browserUpstream);
  const headers: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-forwarded') && k !== 'x-real-ip') headers[k] = v;
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  return new Promise<void>((resolve) => {
    const up = http.request({ hostname: target.hostname, port: target.port, path: config.basePath + url.pathname + url.search, method: req.method, headers }, (ur) => {
      const h: Record<string, any> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && k !== 'set-cookie' && k !== 'x-frame-options') h[k] = v;
      h['x-frame-options'] = 'SAMEORIGIN';
      h['cache-control'] = 'no-store';
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
      ur.on('end', () => resolve());
      ur.on('error', () => { res.destroy(); resolve(); });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"browser_unavailable"}');
      else res.destroy();
      resolve();
    });
    req.pipe(up);
  });
}

function refuse(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** server.on('upgrade'): only <base>/browser/... for the current holder; everything else is refused. */
export function handleBrowserUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  socket.on('error', () => socket.destroy());
  let path: string;
  try {
    const u = new URL(req.url || '/', 'http://local');
    path = u.pathname + u.search;
  } catch {
    return refuse(socket, '400 Bad Request');
  }
  const prefix = config.basePath + '/browser/';
  if (!browserOn() || !path.startsWith(prefix)) return refuse(socket, '404 Not Found');
  if (!isHolder(req)) return refuse(socket, '403 Forbidden');
  const target = new URL(config.browserUpstream);
  const up = net.connect(Number(target.port) || 80, target.hostname);
  sockets.add(socket);
  sockets.add(up);
  const drop = () => { socket.destroy(); up.destroy(); sockets.delete(socket); sockets.delete(up); };
  socket.on('close', drop);
  up.on('close', drop);
  up.on('error', drop);
  up.on('connect', () => {
    let raw = `${req.method} ${path} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      if (k === 'cookie' || k === 'authorization' || k.startsWith('x-forwarded') || k === 'x-real-ip') continue;
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
}
