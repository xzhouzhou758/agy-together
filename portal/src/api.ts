// JSON API for the web UI. Every handler does its own server-side authorization.
import { chatStatus, chatModel, chatSource, chatPrompt, DEFAULT_PROMPT } from './botchat.ts';
import { kbList, kbAdd, kbDelete, kbFetch } from './kb.ts';
import { existsSync } from 'node:fs';
import { poolResources } from './poolres.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { one, all, run, now, getRules, setRules, getSetting, setSetting, type Row } from './db.ts';
import { HttpError, sendJSON, readJSON, readBody, sha256, token, seal, unseal, str, clampInt, hashPassword, maskSecrets } from './util.ts';
import { requireUser, requireAdmin, currentUser, devLogin, passwordLogin, logout, setUserActive, type User } from './auth.ts';
import * as cpa from './cpa.ts';
import { refreshQuota, storedQuota, lastQuotaAt } from './quota.ts';
import { breakerState, resetBreaker, accountInflight, userRotation } from './gateway.ts';
import { MODES, newSalt } from './routing.ts';
import { reasonText } from './reason.ts';
import { readZip, writeZip } from './zip.ts';
import { testModel } from './modeltest.ts';
import { dailyFor, sharedModels, setSharedModels, isPaid } from './limits.ts';
import { isUp, upName, upstreamRows, upstreamById, saveUpstream, normBase, modelsOf, modelInfo, openModels, enabledUpstreams } from './upstream.ts';
import * as site from './site.ts';
import { accountProblem, registerCommands, botStatus, connectInteractions, testMessage, postAnnouncement } from './bot.ts';
import { wakeFor } from './autosleep.ts';


type Handler = (req: IncomingMessage, res: ServerResponse, p: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
function route(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, h });
}

export async function handleAPI(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method || 'GET';
  // CSRF: state-changing calls must carry a custom header (forces a CORS preflight cross-site).
  if (method !== 'GET' && method !== 'HEAD' && req.headers['x-portal-csrf'] !== '1') throw new HttpError(403, 'csrf');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const p: Record<string, string> = {};
    r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
    const out = await r.h(req, res, p, url);
    if (!res.headersSent) sendJSON(res, 200, out ?? { ok: true });
    return;
  }
  throw new HttpError(404, 'not_found');
}

// ---------- helpers ----------
function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function maskProxy(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.username || x.password ? '••••@' : ''}${x.hostname}${x.port ? ':' + x.port : ''}`;
  } catch {
    return '••••';
  }
}

type AccState = { state: 'active' | 'cooldown' | 'error' | 'off'; reason?: string; retryAt?: string | null };
function accState(c: cpa.Cred | undefined): AccState {
  if (!c) return { state: 'error', reason: 'missing' };
  if (c.disabled) return { state: 'off' };
  const retry = c.nextRetryAfter && Date.parse(c.nextRetryAfter) > Date.now() ? c.nextRetryAfter : null;
  if (c.status === 'error' && !retry) return { state: 'error', reason: c.statusMessage || 'error' };
  if (retry || c.unavailable) return { state: 'cooldown', reason: c.statusMessage || '', retryAt: retry };
  return { state: 'active' };
}

function ensureRow(authId: string, email: string): Row {
  run('INSERT INTO accounts(auth_id, email, created_at) VALUES(?,?,?) ON CONFLICT(auth_id) DO NOTHING', authId, email, now());
  return one('SELECT * FROM accounts WHERE auth_id = ?', authId)!;
}

async function ownAccount(user: User, id: string): Promise<{ row: Row; cred: cpa.Cred }> {
  const row = one('SELECT * FROM accounts WHERE auth_id = ? AND owner_id = ?', id, user.id);
  if (!row) throw new HttpError(404, 'not_found');
  const cred = (await cpa.creds(5000)).byId.get(id);
  if (!cred) throw new HttpError(404, 'not_found');
  return { row, cred };
}

function accountView(row: Row, cred: cpa.Cred | undefined) {
  const q = storedQuota(row);
  const proxy = row.proxy_id ? one('SELECT url FROM proxies WHERE id = ?', row.proxy_id)?.url : null;
  return {
    id: row.auth_id,
    name: cred?.note || '',
    email: cred?.email || row.email || '',
    tier: q?.tier || null,
    active: !!cred && !cred.disabled,
    asleep: !!row.sleep_at,
    shared: !!row.shared,
    reserve: row.reserve ?? null, // NULL = the admin's default (/api/rules reserve)
    proxy: proxy ? maskProxy(proxy) : null,
    ...accState(cred),
    quota: q ? { credits: q.credits, groups: q.groups, windows: q.windows || null, argon: q.argon ?? null } : null,
    quotaAt: row.quota_at || null,
    quotaErr: row.quota_err || null,
    problem: accountProblem(row, cred),
  };
}

/** Anonymous label for an account in another user's shared-pool records. */
function anonLabel(authId: string): string {
  if (isUp(authId)) return upName(authId);
  const r = one('SELECT rowid AS n FROM accounts WHERE auth_id = ?', authId);
  return '#' + String(r?.n || 0).padStart(2, '0');
}

// ---------- public ----------
// a site logo is optional: drop public/logo.jpg (plus favicon.png / apple-touch-icon.png) in to replace the letter mark
const HAS_LOGO = existsSync(new URL('../public/logo.jpg', import.meta.url));
route('GET', '/api/config', (req) => ({
  devLogin: config.devLogin,
  discord: site.discordReady(),
  setup: !site.setupDone(),
  logo: HAS_LOGO,
  signedIn: !!currentUser(req),
}));

route('POST', '/api/login', async (req, res) => {
  passwordLogin(req, res, await readJSON(req));
  return { ok: true };
});

route('POST', '/api/dev-login', async (req, res) => {
  await devLogin(res, await readJSON(req));
  return { ok: true };
});

route('POST', '/api/logout', (req, res) => {
  logout(req, res);
  return { ok: true };
});

// ---------- first-run setup ----------
route('POST', '/api/setup', async (req) => {
  const b = await readJSON(req);
  if (!site.checkSetupToken(String(b.token || ''))) throw new HttpError(403, 'invalid_setup_token');
  const admin = String(b.adminDiscordId || '').trim();
  if (!/^\d{5,25}$/.test(admin)) throw new HttpError(400, 'invalid_admin_id');
  try {
    site.updateSite({ ...b, adminIds: [...new Set([...String(site.siteView().adminIds).split(',').filter(Boolean), admin])].join(',') });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!site.discordReady()) throw new HttpError(400, 'discord_incomplete');
  site.finishSetup();
  return { ok: true, redirectURI: site.discord().redirectURI };
});

// ---------- me ----------
route('GET', '/api/me', (req) => {
  const u = requireUser(req);
  return {
    id: u.id, name: u.name, handle: u.handle, discordId: u.discord_id, role: u.role, defaultPool: u.default_pool,
    rotation: userRotation(u.id).mode,
    inputLimit: u.input_limit ?? null,
    autoSleep: !!u.auto_sleep,
    baseURL: (site.publicURL() || '') + '/v1',
  };
});

route('PATCH', '/api/me', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  if (b.defaultPool === undefined && b.rotation === undefined && b.inputLimit === undefined && b.autoSleep === undefined) throw new HttpError(400, 'invalid_body');
  if (b.inputLimit !== undefined) {
    if (b.inputLimit !== null && !(Number.isInteger(b.inputLimit) && b.inputLimit >= 1000 && b.inputLimit <= 10_000_000)) throw new HttpError(400, 'invalid_input_limit');
    run('UPDATE users SET input_limit = ? WHERE id = ?', b.inputLimit, u.id);
  }
  if (b.autoSleep !== undefined) {
    if (typeof b.autoSleep !== 'boolean') throw new HttpError(400, 'invalid');
    run('UPDATE users SET auto_sleep = ? WHERE id = ?', b.autoSleep ? 1 : 0, u.id);
    if (!b.autoSleep) await wakeFor(u.id);
  }
  if (b.defaultPool !== undefined) {
    if (b.defaultPool !== 'private' && b.defaultPool !== 'shared') throw new HttpError(400, 'invalid_pool');
    run('UPDATE users SET default_pool = ? WHERE id = ?', b.defaultPool, u.id);
  }
  if (b.rotation !== undefined) {
    if (!MODES.includes(b.rotation)) throw new HttpError(400, 'invalid_rotation');
    run('UPDATE users SET rotation_mode = ? WHERE id = ?', b.rotation, u.id);
  }
  return { ok: true };
});
// ---------- announcements ----------
function annView(r: Row) {
  return { id: r.id, title: r.title, body: r.body, level: r.level, pinned: !!r.pinned, created: r.created_at, updated: r.updated_at };
}
route('GET', '/api/announcements', (req) => {
  const u = requireUser(req);
  const list = all('SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 50').map(annView);
  const seen = Number(one('SELECT ann_seen FROM users WHERE id = ?', u.id)?.ann_seen || 0);
  return { list, seen, unread: list.filter((a) => a.id > seen).length };
});
route('POST', '/api/announcements/seen', (req) => {
  const u = requireUser(req);
  const top = Number(one('SELECT MAX(id) AS m FROM announcements')?.m || 0);
  run('UPDATE users SET ann_seen = ? WHERE id = ?', top, u.id);
  return { ok: true };
});
function annBody(b: any) {
  const title = str(b.title, 80), body = str(b.body, 4000);
  if (!title) throw new HttpError(400, 'invalid_title');
  if (b.level !== undefined && b.level !== 'info' && b.level !== 'important') throw new HttpError(400, 'invalid');
  return { title, body, level: b.level === 'important' ? 'important' : 'info', pinned: b.pinned ? 1 : 0 };
}
route('POST', '/api/admin/announcements', async (req) => {
  const u = requireAdmin(req);
  const b = await readJSON(req);
  const a = annBody(b);
  const r = run('INSERT INTO announcements(title, body, level, pinned, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', a.title, a.body, a.level, a.pinned, u.id, now(), now());
  let discord: boolean | null = null;
  if (b.discord === true) discord = await postAnnouncement(a.title, a.body, site.publicURL() ? site.publicURL() + '/' : '');
  return { ...annView(one('SELECT * FROM announcements WHERE id = ?', r.lastInsertRowid)!), discord };
});
route('PATCH', '/api/admin/announcements/:id', async (req, _res, p) => {
  requireAdmin(req);
  if (!one('SELECT 1 FROM announcements WHERE id = ?', Number(p.id))) throw new HttpError(404, 'not_found');
  const a = annBody(await readJSON(req));
  run('UPDATE announcements SET title = ?, body = ?, level = ?, pinned = ?, updated_at = ? WHERE id = ?', a.title, a.body, a.level, a.pinned, now(), Number(p.id));
  return annView(one('SELECT * FROM announcements WHERE id = ?', Number(p.id))!);
});
route('DELETE', '/api/admin/announcements/:id', (req, _res, p) => {
  requireAdmin(req);
  run('DELETE FROM announcements WHERE id = ?', Number(p.id));
  return { ok: true };
});

// 「清除会话绑定」: a new per-user salt, so every session of this user binds afresh.
route('POST', '/api/me/sessions/reset', (req) => {
  const u = requireUser(req);
  run('UPDATE users SET session_salt = ? WHERE id = ?', newSalt(), u.id);
  return { ok: true };
});

route('GET', '/api/overview', async (req) => {
  const u = requireUser(req);
  const c = await cpa.creds(10000);
  const rows = all('SELECT * FROM accounts WHERE owner_id = ?', u.id).filter((r) => c.byId.has(r.auth_id));
  const since = dayStart();
  const mine = one(`SELECT SUM(pool='private') AS p, SUM(pool='shared') AS s FROM usage WHERE user_id = ? AND ts >= ?`, u.id, since);
  const served = all(`SELECT auth_id, COUNT(*) AS n FROM usage WHERE owner_id = ? AND pool = 'shared' AND (user_id IS NULL OR user_id != ?) AND ts >= ? GROUP BY auth_id`, u.id, u.id, since);
  const servedMap = Object.fromEntries(served.map((r) => [r.auth_id, r.n]));
  return {
    accounts: rows.length,
    enabled: rows.filter((r) => !c.byId.get(r.auth_id)!.disabled).length,
    shared: rows.filter((r) => r.shared).map((r) => ({ id: r.auth_id, name: c.byId.get(r.auth_id)!.note || '', email: c.byId.get(r.auth_id)!.email, today: servedMap[r.auth_id] || 0 })),
    today: { private: Number(mine?.p || 0), shared: Number(mine?.s || 0) },
    servedToday: served.reduce((n, r) => n + Number(r.n), 0),
    pool: await poolSummary(u),
    shops: getSetting('shops_on') === '0' ? [] : shopLinks(),
    daily: await dailyFor(u.id),
  };
});

// ---------- 买号渠道 (admin-curated links shown on every user's home) ----------
type Shop = { name: string; url: string; note: string };
function shopLinks(): Shop[] {
  try { return JSON.parse(getSetting('shop_links') || '[]'); } catch { return []; }
}
// 总开关: Discord @ 人, 机器人主动发消息 (off by default), 买号渠道 shown to users
const switches = () => ({ mentions: getSetting('bot_mentions') !== '0', proactive: getSetting('bot_proactive') === '1', stockOnly: getSetting('bot_stock_only') === '1', shops: getSetting('shops_on') !== '0' });
route('GET', '/api/admin/switches', (req) => { requireAdmin(req); return switches(); });
route('PUT', '/api/admin/switches', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  for (const [k, key] of [['mentions', 'bot_mentions'], ['proactive', 'bot_proactive'], ['stockOnly', 'bot_stock_only'], ['shops', 'shops_on']] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw new HttpError(400, 'invalid');
    setSetting(key, b[k] ? '1' : '0');
  }
  return switches();
});
route('GET', '/api/admin/shops', (req) => {
  requireAdmin(req);
  return shopLinks();
});
route('PUT', '/api/admin/shops', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  if (!Array.isArray(b.shops) || b.shops.length > 50) throw new HttpError(400, 'invalid_shops');
  const out: Shop[] = b.shops.map((x: any) => {
    const url = String(x?.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 500) throw new HttpError(400, 'invalid_url');
    return { name: str(x?.name, 40) || new URL(url).hostname, url, note: str(x?.note, 80) };
  });
  setSetting('shop_links', JSON.stringify(out));
  return { shops: out };
});

async function poolSummary(u: User) {
  const c = await cpa.creds(10000);
  const rows = all(`SELECT a.auth_id, a.owner_id FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.shared = 1 AND u.active = 1`)
    .filter((r) => c.byId.get(r.auth_id) && !c.byId.get(r.auth_id)!.disabled);
  const privateUsable = all('SELECT auth_id FROM accounts WHERE owner_id = ?', u.id).filter((r) => c.byId.get(r.auth_id) && !c.byId.get(r.auth_id)!.disabled).length;
  return { contributors: new Set(rows.map((r) => r.owner_id)).size, accounts: rows.length, privateAccounts: privateUsable };
}
route('GET', '/api/pool/summary', async (req) => poolSummary(requireUser(req)));
// 大锅饭 remaining resources: totals for everyone, per-account rows for admins
route('GET', '/api/pool/resources', async (req) => poolResources(requireUser(req).role === 'admin'));
route('GET', '/api/rules', (req) => { requireUser(req); return getRules(); });

// ---------- accounts ----------
/** Last 20 request outcomes on an account (newest last) plus success / failure totals. Status only, no callers. */
function requestStrip(authId: string) {
  const recent = all('SELECT result FROM usage WHERE auth_id = ? ORDER BY ts DESC, id DESC LIMIT 20', authId).map((r) => (r.result === 'ok' ? 1 : 0)).reverse();
  const t = one(`SELECT SUM(result = 'ok') AS ok, SUM(result != 'ok') AS bad FROM usage WHERE auth_id = ?`, authId);
  return { recent, ok: Number(t?.ok || 0), fail: Number(t?.bad || 0) };
}
/** Tokens this account has served: last 5 hours, since local midnight, last 7 days, all time (kept usage only). */
function tokenUse(authId: string) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const tok = 'COALESCE(total_tok, COALESCE(in_tok,0) + COALESCE(out_tok,0) + COALESCE(reasoning_tok,0))';
  const r = one(`SELECT SUM(CASE WHEN ts >= ? THEN ${tok} END) AS h5, SUM(CASE WHEN ts >= ? THEN ${tok} END) AS today,
    SUM(CASE WHEN ts >= ? THEN ${tok} END) AS week, SUM(${tok}) AS total FROM usage WHERE auth_id = ?`,
    now() - 5 * 3600e3, midnight.getTime(), now() - 7 * 86400e3, authId);
  // per quota window family (matches retrieveUserQuotaSummary groups: Gemini vs Claude/GPT)
  const fam = { gemini: { h5: 0, week: 0 }, claude: { h5: 0, week: 0 }, argon: { h5: 0, week: 0 } };
  for (const x of all(`SELECT CASE WHEN lower(COALESCE(requested_model, model)) LIKE 'claude%' OR lower(COALESCE(requested_model, model)) LIKE 'gpt%' THEN 'claude'
    WHEN lower(COALESCE(requested_model, model)) LIKE '%argon%' THEN 'argon' ELSE 'gemini' END AS f,
    SUM(CASE WHEN ts >= ? THEN ${tok} END) AS h5, SUM(${tok}) AS week FROM usage WHERE auth_id = ? AND ts >= ? GROUP BY f`, now() - 5 * 3600e3, authId, now() - 7 * 86400e3)) {
    fam[x.f as 'gemini' | 'claude' | 'argon'] = { h5: Number(x.h5 || 0), week: Number(x.week || 0) };
  }
  return { h5: Number(r?.h5 || 0), today: Number(r?.today || 0), week: Number(r?.week || 0), total: Number(r?.total || 0), fam };
}

route('GET', '/api/accounts', async (req) => {
  const u = requireUser(req);
  const c = await cpa.creds(5000);
  return all('SELECT * FROM accounts WHERE owner_id = ? ORDER BY created_at', u.id)
    .filter((r) => c.byId.has(r.auth_id))
    .map((r) => ({ ...accountView(r, c.byId.get(r.auth_id)), requests: requestStrip(r.auth_id), tokens: tokenUse(r.auth_id) }));
});

// Models a credential supports (CPA registry). Owner only; admins may look at any credential.
route('GET', '/api/accounts/:id/models', async (req, _res, p) => {
  const u = requireUser(req);
  if (u.role === 'admin') {
    if (!(await cpa.creds(5000)).byId.has(p.id)) throw new HttpError(404, 'not_found');
  } else await ownAccount(u, p.id);
  return (await cpa.credentialModels(p.id)).map((m: any) => ({ id: String(m?.id || ''), name: String(m?.display_name || ''), type: String(m?.type || m?.owned_by || '') })).filter((m) => m.id);
});

route('POST', '/api/accounts/:id/models/test', async (req, _res, p) => {
  const u = requireUser(req);
  if (u.role === 'admin') {
    if (!(await cpa.creds(5000)).byId.has(p.id)) throw new HttpError(404, 'not_found');
  } else await ownAccount(u, p.id);
  const b = await readJSON(req);
  const model = str(b.model, 120);
  if (!(await cpa.credentialModels(p.id)).some((m: any) => String(m?.id || '') === model)) throw new HttpError(400, 'unknown_model');
  return testModel(u.id, p.id, model);
});

route('PATCH', '/api/accounts/:id', async (req, _res, p) => {
  const u = requireUser(req);
  const { row, cred } = await ownAccount(u, p.id);
  const b = await readJSON(req);
  if (b.name !== undefined) await cpa.patchFields(row.auth_id, { note: str(b.name, 40) });
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') throw new HttpError(400, 'invalid');
    if (b.active === cred.disabled) await cpa.setDisabled(row.auth_id, !b.active);
    run('UPDATE accounts SET auto_disabled_at = NULL, auto_disabled_reason = NULL, sleep_at = NULL WHERE auth_id = ?', row.auth_id); // owner decides now; autodisable.ts / autosleep.ts let go
  }
  if (b.reserve !== undefined) {
    if (b.reserve !== null && !(Number.isInteger(b.reserve) && b.reserve >= 0 && b.reserve <= 90)) throw new HttpError(400, 'invalid');
    run('UPDATE accounts SET reserve = ? WHERE auth_id = ?', b.reserve, row.auth_id);
  }
  if (b.shared !== undefined) {
    if (typeof b.shared !== 'boolean') throw new HttpError(400, 'invalid');
    run('UPDATE accounts SET shared = ? WHERE auth_id = ?', b.shared ? 1 : 0, row.auth_id);
  }
  const c = await cpa.creds(5000);
  return accountView(one('SELECT * FROM accounts WHERE auth_id = ?', row.auth_id)!, c.byId.get(row.auth_id));
});

route('DELETE', '/api/accounts/:id', async (req, _res, p) => {
  const u = requireUser(req);
  const { row } = await ownAccount(u, p.id);
  run('UPDATE accounts SET shared = 0 WHERE auth_id = ?', row.auth_id); // leave the shared pool first
  await cpa.deleteCredential(row.auth_id);
  run('DELETE FROM accounts WHERE auth_id = ?', row.auth_id);
  return { ok: true };
});

route('POST', '/api/accounts/:id/quota', async (req, _res, p) => {
  const u = requireUser(req);
  const { row } = await ownAccount(u, p.id);
  if (Date.now() - lastQuotaAt(row.auth_id) < 20000) throw new HttpError(429, 'too_soon');
  try {
    await refreshQuota(row.auth_id);
  } catch {
    // error is stored on the row and shown as stale data
  }
  const c = await cpa.creds(5000);
  return accountView(one('SELECT * FROM accounts WHERE auth_id = ?', row.auth_id)!, c.byId.get(row.auth_id));
});

// --- add via Google OAuth (CPA management OAuth flow) ---
route('POST', '/api/accounts/oauth', async (req) => {
  const u = requireUser(req);
  const pendingN = one(`SELECT COUNT(*) AS n FROM oauth_flows WHERE user_id = ? AND status = 'pending' AND created_at > ?`, u.id, now() - 600000)?.n || 0;
  if (pendingN >= 3) throw new HttpError(429, 'too_many_pending');
  const c = await cpa.creds(0);
  const snapshot = Object.fromEntries(c.list.map((x) => [x.id, x.updatedAt]));
  const { url, state } = await cpa.oauthStart();
  run('INSERT INTO oauth_flows(state, user_id, created_at, snapshot) VALUES(?,?,?,?)', state, u.id, now(), JSON.stringify(snapshot));
  return { url, state };
});

function ownFlow(u: User, state: string): Row {
  const f = one('SELECT * FROM oauth_flows WHERE state = ? AND user_id = ?', state, u.id);
  if (!f) throw new HttpError(404, 'not_found');
  return f;
}

route('POST', '/api/accounts/oauth/callback', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  const cb = str(b.url, 4000);
  let st = '';
  try { st = new URL(cb).searchParams.get('state') || ''; } catch { throw new HttpError(400, 'invalid_callback'); }
  if (!st || st !== String(b.state || '')) throw new HttpError(400, 'state_mismatch');
  ownFlow(u, st);
  const r = await cpa.oauthCallback(cb);
  if (!r.ok) throw new HttpError(400, 'callback_rejected', r.error);
  return { ok: true };
});

route('GET', '/api/accounts/oauth/:state', async (req, _res, p) => {
  const u = requireUser(req);
  const f = ownFlow(u, p.state);
  if (f.status !== 'pending') return { status: f.status, account: f.auth_id, message: f.message };
  const s = await cpa.oauthStatus(p.state);
  if (s.status === 'wait') return { status: 'wait' };
  if (s.status === 'error') {
    run(`UPDATE oauth_flows SET status = 'error', message = ? WHERE state = ?`, s.error || '', p.state);
    return { status: 'error', message: s.error };
  }
  // ok: find the credential the flow wrote (new file, or an existing file rewritten for the same email).
  // Serialize finalization so two flows finishing together cannot claim each other's file.
  const run1 = finalizeLock.then(() => finalizeOAuth(u, p.state));
  finalizeLock = run1.catch(() => {});
  return run1;
});

let finalizeLock: Promise<unknown> = Promise.resolve();
async function finalizeOAuth(u: User, state: string) {
  const f = one('SELECT * FROM oauth_flows WHERE state = ?', state)!;
  if (f.status !== 'pending') return { status: f.status, account: f.auth_id, message: f.message };
  await cpa.refreshCreds();
  const c = await cpa.creds(0);
  const snap: Record<string, string> = JSON.parse(f.snapshot);
  const changed = c.list.filter((x) => x.type === 'antigravity' && !x.id.startsWith('antigravity-rt-') && (!(x.id in snap) || snap[x.id] !== x.updatedAt));
  let result: { status: string; account?: string; message?: string };
  const fresh = changed.filter((x) => !one('SELECT owner_id FROM accounts WHERE auth_id = ? AND owner_id IS NOT NULL', x.id));
  const mineChanged = changed.filter((x) => one('SELECT 1 FROM accounts WHERE auth_id = ? AND owner_id = ?', x.id, u.id));
  if (fresh.length === 1) {
    const x = fresh[0];
    const dupe = c.list.find((y) => y.id !== x.id && y.email && y.email.toLowerCase() === x.email.toLowerCase());
    if (dupe) result = { status: 'duplicate' };
    else {
      ensureRow(x.id, x.email);
      run('UPDATE accounts SET owner_id = ?, email = ? WHERE auth_id = ?', u.id, x.email, x.id);
      result = { status: 'ok', account: x.id };
    }
  } else if (fresh.length === 0 && mineChanged.length === 1) {
    result = { status: 'ok', account: mineChanged[0].id, message: 'reauthorized' };
  } else if (fresh.length === 0 && changed.length) {
    result = { status: 'duplicate' };
  } else {
    result = { status: 'error', message: fresh.length ? 'ambiguous' : 'not_found' };
  }
  run('UPDATE oauth_flows SET status = ?, auth_id = ?, message = ? WHERE state = ?', result.status, result.account || null, result.message || null, f.state);
  return result;
}

// --- add via upload (JSON or ZIP) ---
type UploadResult = { name: string; ok: boolean; error?: string; account?: string; email?: string };
function sanitizeEmail(e: string) {
  return e.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 120);
}
async function uploadOne(u: User, name: string, data: Buffer): Promise<UploadResult> {
  let j: any;
  try { j = JSON.parse(data.toString('utf8')); } catch { return { name, ok: false, error: 'invalid' }; }
  if (!j || typeof j !== 'object' || j.type !== 'antigravity' || typeof j.email !== 'string' || !j.email.includes('@') || !(j.refresh_token || j.access_token)) {
    return { name, ok: false, error: 'invalid' };
  }
  const email = j.email.trim().toLowerCase();
  const c = await cpa.creds(0);
  if (c.list.some((x) => x.email && x.email.toLowerCase() === email) || one('SELECT 1 FROM accounts WHERE lower(email) = ?', email)) {
    return { name, ok: false, error: 'duplicate', email };
  }
  // never let a client set portal-controlled fields
  delete j.proxy_url; delete j.disabled; delete j.priority; delete j.prefix; delete j.base_url; delete j.headers;
  const id = `antigravity-${sanitizeEmail(email)}.json`;
  if (c.byId.has(id)) return { name, ok: false, error: 'duplicate', email };
  await cpa.uploadCredential(id, Buffer.from(JSON.stringify(j)));
  ensureRow(id, email);
  run('UPDATE accounts SET owner_id = ?, email = ? WHERE auth_id = ?', u.id, email, id);
  return { name, ok: true, account: id, email };
}

route('POST', '/api/accounts/upload', async (req, _res, _p, url) => {
  const u = requireUser(req);
  const name = (url.searchParams.get('name') || 'upload').slice(0, 120);
  const buf = await readBody(req, 5 * 1024 * 1024);
  const results: UploadResult[] = [];
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    let entries;
    try { entries = readZip(buf); } catch { throw new HttpError(400, 'invalid_zip'); }
    for (const e of entries.filter((x) => x.name.toLowerCase().endsWith('.json'))) results.push(...(await uploadMany(u, e.name, e.data)));
    if (!results.length) throw new HttpError(400, 'empty_zip');
  } else {
    results.push(...(await uploadMany(u, name, buf)));
  }
  return { results };
});
// A file may hold one credential or a JSON array of them (what the export writes for a single file).
async function uploadMany(u: User, name: string, data: Buffer): Promise<UploadResult[]> {
  let j: any;
  try { j = JSON.parse(data.toString('utf8')); } catch { return [{ name, ok: false, error: 'invalid' }]; }
  if (!Array.isArray(j)) return [await uploadOne(u, name, data)];
  const out: UploadResult[] = [];
  for (const [i, x] of j.slice(0, 200).entries()) out.push(await uploadOne(u, `${name} #${i + 1}`, Buffer.from(JSON.stringify(x))));
  return out;
}

// --- export: the owner's own credential files, one JSON (array) or a ZIP of files ---
route('POST', '/api/accounts/export', async (req, res) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  const ids: string[] = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))].slice(0, 200) as string[] : [];
  if (!ids.length) throw new HttpError(400, 'invalid');
  const files: { name: string; data: Buffer }[] = [];
  for (const id of ids) {
    const { row } = await ownAccount(u, id);
    const j = await cpa.downloadCredential(row.auth_id);
    if (!j || typeof j !== 'object') continue;
    // portal-controlled fields stay here: the admin's proxy, enable state, routing extras
    delete j.proxy_url; delete j.disabled; delete j.priority; delete j.prefix; delete j.base_url; delete j.headers;
    files.push({ name: row.auth_id, data: Buffer.from(JSON.stringify(j, null, 2)) });
  }
  if (!files.length) throw new HttpError(404, 'not_found');
  const day = new Date().toISOString().slice(0, 10);
  const zip = b.format === 'zip' || (b.format !== 'json' && files.length > 1);
  const out = zip ? writeZip(files) : files.length === 1 ? files[0].data : Buffer.from(JSON.stringify(files.map((f) => JSON.parse(f.data.toString())), null, 2));
  const fname = zip ? `xgf-credentials-${day}.zip` : files.length === 1 ? files[0].name : `xgf-credentials-${day}.json`;
  res.writeHead(200, {
    'Content-Type': zip ? 'application/zip' : 'application/json',
    'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.@+-]/g, '_')}"`,
    'Content-Length': out.length, 'Cache-Control': 'no-store',
  });
  res.end(out);
});

// --- add via a Google refresh token: CPA exchanges it, Google's userinfo names the account ---
const RT_RE = /^1\/\/[A-Za-z0-9_\-]{20,400}$/;
async function importRefreshToken(u: User, rt: string): Promise<UploadResult> {
  const name = rt.slice(0, 6) + '…' + rt.slice(-4);
  if (!RT_RE.test(rt)) return { name, ok: false, error: 'invalid_token' };
  const tmp = `antigravity-rt-${token(6)}.json`;
  try {
    await cpa.uploadCredential(tmp, Buffer.from(JSON.stringify({ type: 'antigravity', refresh_token: rt, disabled: true })));
    if (!(await cpa.refreshCredential(tmp)).ok) return { name, ok: false, error: 'invalid_token' };
    await cpa.refreshCreds();
    const t = (await cpa.creds(0)).byId.get(tmp);
    if (!t) return { name, ok: false, error: 'failed' };
    const ui = await cpa.apiCall(t.authIndex, 'GET', 'https://www.googleapis.com/oauth2/v2/userinfo', { Authorization: 'Bearer $TOKEN$' });
    let email = '';
    try { email = String(JSON.parse(ui.body)?.email || '').trim().toLowerCase(); } catch {}
    if (ui.status !== 200 || !email.includes('@')) return { name, ok: false, error: 'invalid_token' };
    const c = await cpa.creds(0);
    if (c.list.some((x) => x.id !== tmp && x.email && x.email.toLowerCase() === email) || one('SELECT 1 FROM accounts WHERE lower(email) = ?', email)) {
      return { name, ok: false, error: 'duplicate', email };
    }
    const id = `antigravity-${sanitizeEmail(email)}.json`;
    if (c.byId.has(id)) return { name, ok: false, error: 'duplicate', email };
    const j = await cpa.downloadCredential(tmp); // refreshed access token, project_id, capability hints
    if (!j || typeof j !== 'object' || !j.refresh_token) return { name, ok: false, error: 'failed' };
    delete j.proxy_url; delete j.disabled; delete j.priority; delete j.prefix; delete j.base_url; delete j.headers; delete j.note;
    j.type = 'antigravity';
    j.email = email;
    await cpa.uploadCredential(id, Buffer.from(JSON.stringify(j)));
    ensureRow(id, email);
    run('UPDATE accounts SET owner_id = ?, email = ? WHERE auth_id = ?', u.id, email, id);
    return { name, ok: true, account: id, email };
  } catch (e) {
    console.error('[rt-import]', (e as Error).message);
    return { name, ok: false, error: 'failed' };
  } finally {
    await cpa.deleteCredential(tmp).catch(() => {});
  }
}

let rtLock: Promise<unknown> = Promise.resolve();
route('POST', '/api/accounts/refresh-token', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  const list = [...new Set(String(b.tokens ?? '').split(/[\s,;]+/).map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean))];
  if (!list.length) throw new HttpError(400, 'invalid_token');
  if (list.length > 20) throw new HttpError(400, 'too_many');
  // one import at a time: each one briefly holds a temporary credential in CPA
  const job = rtLock.then(async () => {
    const results: UploadResult[] = [];
    for (const rt of list) results.push(await importRefreshToken(u, rt));
    return { results };
  });
  rtLock = job.catch(() => {});
  return job;
});

// ---------- keys ----------
function keyView(k: Row) {
  return { id: k.id, name: k.name, pool: k.pool, tail: k.tail, key: unseal(k.key_enc), created: k.created_at, lastUsed: k.last_used_at };
}
route('GET', '/api/keys', (req) => {
  const u = requireUser(req);
  return all('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY id', u.id).map(keyView);
});
route('POST', '/api/keys', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  const pool = b.pool === 'shared' ? 'shared' : b.pool === 'private' ? 'private' : null;
  if (!pool) throw new HttpError(400, 'invalid_pool');
  if ((one('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', u.id)?.n || 0) >= 20) throw new HttpError(400, 'too_many_keys');
  const plain = 'sk-agy-' + token(30);
  const r = run('INSERT INTO api_keys(user_id, name, pool, key_hash, key_enc, tail, created_at) VALUES(?,?,?,?,?,?,?)',
    u.id, str(b.name, 40) || 'API Key', pool, sha256(plain), seal(plain), plain.slice(-4), now());
  return keyView(one('SELECT * FROM api_keys WHERE id = ?', r.lastInsertRowid)!);
});
route('PATCH', '/api/keys/:id', async (req, _res, p) => {
  const u = requireUser(req);
  const k = one('SELECT * FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL', Number(p.id), u.id);
  if (!k) throw new HttpError(404, 'not_found');
  const b = await readJSON(req);
  if (b.name !== undefined) run('UPDATE api_keys SET name = ? WHERE id = ?', str(b.name, 40) || k.name, k.id);
  if (b.pool !== undefined) {
    if (b.pool !== 'private' && b.pool !== 'shared') throw new HttpError(400, 'invalid_pool');
    run('UPDATE api_keys SET pool = ? WHERE id = ?', b.pool, k.id);
  }
  return keyView(one('SELECT * FROM api_keys WHERE id = ?', k.id)!);
});
route('DELETE', '/api/keys/:id', (req, _res, p) => {
  const u = requireUser(req);
  const r = run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), Number(p.id), u.id);
  if (!Number(r.changes)) throw new HttpError(404, 'not_found');
  return { ok: true };
});

// ---------- usage ----------
route('GET', '/api/usage/requests', async (req, _res, _p, url) => {
  const u = requireUser(req);
  const pool = url.searchParams.get('pool');
  const limit = clampInt(url.searchParams.get('limit') || 100, 1, 500);
  const rows = pool === 'private' || pool === 'shared'
    ? all('SELECT * FROM usage WHERE user_id = ? AND pool = ? ORDER BY ts DESC LIMIT ?', u.id, pool, limit)
    : all('SELECT * FROM usage WHERE user_id = ? ORDER BY ts DESC LIMIT ?', u.id, limit);
  const c = await cpa.creds(30000);
  return rows.map((r) => {
    let account: string | null = null;
    if (r.auth_id) {
      // Own accounts by note; anyone else's account only as an anonymous number. Never an email.
      account = r.owner_id === u.id ? c.byId.get(r.auth_id)?.note || '' : anonLabel(r.auth_id);
    }
    return { ts: r.ts, model: r.model, pool: r.pool, account, own: r.owner_id === u.id, result: r.result, status: r.status, latency: r.latency_ms, tokens: r.total_tok };
  });
});

route('GET', '/api/usage/contributions', async (req, _res, _p, url) => {
  const u = requireUser(req);
  const days = clampInt(url.searchParams.get('days') || 1, 1, 90);
  const since = days === 1 ? dayStart() : now() - days * 86400000;
  const c = await cpa.creds(30000);
  const rows = all(`SELECT auth_id, model, COUNT(*) AS n, SUM(COALESCE(total_tok,0)) AS t FROM usage
    WHERE owner_id = ? AND pool = 'shared' AND (user_id IS NULL OR user_id != ?) AND ts >= ? GROUP BY auth_id, model`, u.id, u.id, since);
  const accs = all('SELECT auth_id FROM accounts WHERE owner_id = ? AND (shared = 1 OR auth_id IN (SELECT DISTINCT auth_id FROM usage WHERE owner_id = ? AND pool = \'shared\' AND ts >= ?))', u.id, u.id, since);
  return accs.map((a) => {
    const mine = rows.filter((r) => r.auth_id === a.auth_id);
    return {
      id: a.auth_id,
      name: c.byId.get(a.auth_id)?.note || '',
      email: c.byId.get(a.auth_id)?.email || '',
      count: mine.reduce((n, r) => n + Number(r.n), 0),
      tokens: mine.reduce((n, r) => n + Number(r.t), 0),
      models: Object.fromEntries(mine.map((r) => [r.model || '—', Number(r.n)])),
    };
  });
});

// ---------- traffic log ----------
// Any signed-in user. Non-admins are forced to their own rows (in SQL), see their own key names,
// their own accounts by email and everyone else's shared accounts only as "#NN". Bodies are never stored.
const FAMILY: Record<string, string> = { claude: '%claude%', gemini: '%gemini%', flash: '%flash%', pro: '%pro%', image: '%image%' };
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
async function traffic(u: User, url: URL) {
  const admin = u.role === 'admin';
  const sp = url.searchParams;
  const size = clampInt(sp.get('size') || 50, 1, 100);
  const page = clampInt(sp.get('page') || 1, 1, 1e6);
  const where: string[] = [], args: any[] = [];
  if (!admin) { where.push('u.user_id = ?'); args.push(u.id); }
  else if (sp.get('user')) { where.push('u.user_id = ?'); args.push(clampInt(sp.get('user'), 0, 1e12)); }
  const acc = (sp.get('account') || '').trim();
  if (acc) {
    // a non-admin may only filter by an account they own
    if (!admin && !one('SELECT 1 FROM accounts WHERE auth_id = ? AND owner_id = ?', acc, u.id)) where.push('0');
    else { where.push('u.auth_id = ?'); args.push(acc); }
  }
  const pool = sp.get('pool');
  if (pool === 'private' || pool === 'shared') { where.push('u.pool = ?'); args.push(pool); }
  if (sp.get('errorsOnly') === '1' || sp.get('errorsOnly') === 'true') where.push(`u.result != 'ok'`);
  const fam = FAMILY[sp.get('family') || ''];
  if (fam) { where.push(`(lower(u.model) LIKE ? OR lower(COALESCE(u.upstream_model, '')) LIKE ?)`); args.push(fam, fam); }
  const q = (sp.get('q') || '').trim().slice(0, 100).toLowerCase();
  if (q) {
    const l = '%' + likeEsc(q) + '%';
    const cols = ['lower(u.model)', `lower(COALESCE(u.upstream_model, ''))`, 'lower(u.path)', 'CAST(u.status AS TEXT)', `COALESCE(u.reason, '')`];
    where.push('(' + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    args.push(...cols.map(() => l));
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const t = one(`SELECT COUNT(*) AS n, SUM(u.result = 'ok') AS ok FROM usage u ${w}`, ...args);
  const total = Number(t?.n || 0), ok = Number(t?.ok || 0);
  const rows = all(`SELECT u.*, k.name AS key_name, us.name AS user_name FROM usage u
    LEFT JOIN api_keys k ON k.id = u.key_id LEFT JOIN users us ON us.id = u.user_id
    ${w} ORDER BY u.ts DESC, u.id DESC LIMIT ? OFFSET ?`, ...args, size, (page - 1) * size);
  const c = await cpa.creds(30000);
  const email = (id: string) => (isUp(id) ? upName(id) : c.byId.get(id)?.email || one('SELECT email FROM accounts WHERE auth_id = ?', id)?.email || '');
  const list = rows.map((r) => {
    let account: string | null = null, accountId: string | null = null;
    if (r.auth_id) {
      if (admin) { account = email(r.auth_id) || r.auth_id; accountId = r.auth_id; }
      else if (r.owner_id === u.id) { account = email(r.auth_id); accountId = r.auth_id; }
      else account = '共享账号 ' + anonLabel(r.auth_id);
    }
    return {
      id: r.id, ts: r.ts, method: 'POST', path: r.path, stream: !!r.stream, status: r.status, result: r.result, pool: r.pool,
      model: r.requested_model || r.model, upstream: r.upstream_model || null, effort: r.reasoning_effort || null,
      user: admin ? r.user_name || null : undefined, key: r.key_name || null,
      account, accountId, own: r.owner_id === u.id,
      in: r.in_tok, out: r.out_tok, think: r.reasoning_tok, cache: r.cache_tok, cacheWrite: r.cache_write_tok, total: r.total_tok,
      attempts: r.attempts ?? null, upstreamStatus: r.upstream_status ?? null, reason: reasonText(r),
      latency: r.latency_ms, ttfb: r.cpa_ttft_ms ?? r.ttfb_ms, upLatency: r.cpa_latency_ms ?? null,
    };
  });
  const accounts = (admin ? all('SELECT auth_id, email FROM accounts ORDER BY email') : all('SELECT auth_id, email FROM accounts WHERE owner_id = ? ORDER BY email', u.id))
    .filter((r) => c.byId.has(r.auth_id)).map((r) => ({ id: r.auth_id, email: c.byId.get(r.auth_id)!.email || r.email }));
  const users = admin ? all('SELECT id, name FROM users ORDER BY name').map((x) => ({ id: x.id, name: x.name })) : undefined;
  return { rows: list, total, ok, error: total - ok, page, size, admin, accounts, users };
}
route('GET', '/api/traffic', async (req, _res, _p, url) => traffic(requireUser(req), url));

// Full message for one request: admin only, read from CPA's request log, credentials masked.
const LOG_MAX = 2 * 1024 * 1024;
route('GET', '/api/admin/traffic/:id/log', async (req, _res, p) => {
  requireAdmin(req);
  const row = one('SELECT request_id FROM usage WHERE id = ?', Number(p.id));
  if (!row) throw new HttpError(404, 'not_found');
  if (!row.request_id) return { found: false };
  const text = await cpa.requestLog(String(row.request_id));
  if (text === null) return { found: false };
  const masked = maskSecrets(text);
  return { found: true, truncated: masked.length > LOG_MAX, text: masked.slice(0, LOG_MAX) };
});
route('GET', '/api/admin/traffic', async (req, _res, _p, url) => traffic(requireAdmin(req), url));

// ---------- token stats ----------
// Aggregates only. Non-admins (and admins with scope=mine) see their own requests; accounts they
// don't own show up as "#NN". tz = client's UTC offset in minutes, so hour/day buckets match its clock.
const RANGES: Record<string, [number, number]> = { '24h': [86400e3, 3600e3], '7d': [7 * 86400e3, 86400e3], '30d': [30 * 86400e3, 86400e3], '90d': [90 * 86400e3, 86400e3] };
const TOK = 'COALESCE(total_tok, COALESCE(in_tok,0) + COALESCE(out_tok,0) + COALESCE(reasoning_tok,0))';
route('GET', '/api/stats', async (req, _res, _p, url) => {
  const u = requireUser(req);
  const sp = url.searchParams;
  const admin = u.role === 'admin', all_ = admin && sp.get('scope') === 'all';
  const range = RANGES[sp.get('range') || ''] ? sp.get('range')! : '7d';
  const [span, step] = RANGES[range];
  const tz = clampInt(sp.get('tz') || 0, -840, 840) * 60e3;
  const t = now(), since = Math.floor((t + tz) / step) * step - tz - span + step;
  const scope = all_ ? '' : 'AND user_id = ' + Number(u.id);
  const w = `WHERE ts >= ? ${scope}`;
  const tot = one(`SELECT COUNT(*) AS req, SUM(result = 'ok') AS ok, SUM(COALESCE(in_tok,0)) AS i, SUM(COALESCE(out_tok,0)) AS o,
    SUM(COALESCE(reasoning_tok,0)) AS r, SUM(COALESCE(cache_tok,0)) AS c, SUM(${TOK}) AS tok,
    COUNT(DISTINCT auth_id) AS accounts, COUNT(DISTINCT COALESCE(requested_model, model)) AS models, COUNT(DISTINCT user_id) AS users FROM usage ${w}`, since);
  const model = `COALESCE(NULLIF(requested_model, ''), NULLIF(model, ''), '—')`;
  const byModel = all(`SELECT ${model} AS m, COUNT(*) AS req, SUM(COALESCE(in_tok,0)) AS i, SUM(COALESCE(out_tok,0)) AS o,
    SUM(COALESCE(reasoning_tok,0)) AS r, SUM(COALESCE(cache_tok,0)) AS c, SUM(${TOK}) AS tok FROM usage ${w} GROUP BY m ORDER BY tok DESC, req DESC`, since);
  const top = byModel.slice(0, 5).map((r) => r.m);
  const trendRows = all(`SELECT CAST((ts + ?) / ? AS INTEGER) AS b, ${model} AS m, SUM(${TOK}) AS tok, COUNT(*) AS req FROM usage ${w} GROUP BY b, m`, tz, step, since);
  const n = span / step, first = Math.floor((since + tz) / step);
  const trend = Array.from({ length: n }, (_, k) => ({ t: (first + k) * step - tz, by: {} as Record<string, number>, req: 0 }));
  for (const r of trendRows) {
    const b = trend[Number(r.b) - first];
    if (!b) continue;
    const key = top.includes(r.m) ? r.m : '其他';
    b.by[key] = (b.by[key] || 0) + Number(r.tok || 0);
    b.req += Number(r.req);
  }
  // Rhythm (hour of day) and heat map (last 91 days) ignore the range picker.
  const hours = Array(24).fill(0);
  for (const r of all(`SELECT CAST((ts + ?) / 3600000 AS INTEGER) % 24 AS h, SUM(${TOK}) AS tok FROM usage WHERE ts >= ? ${scope} GROUP BY h`, tz, t - 30 * 86400e3)) hours[Number(r.h)] = Number(r.tok || 0);
  const day0 = Math.floor((t + tz) / 86400e3) - 90;
  const heat = Array(91).fill(0);
  for (const r of all(`SELECT CAST((ts + ?) / 86400000 AS INTEGER) AS d, SUM(${TOK}) AS tok FROM usage WHERE ts >= ? ${scope} GROUP BY d`, tz, day0 * 86400e3 - tz)) {
    const k = Number(r.d) - day0;
    if (k >= 0 && k < 91) heat[k] = Number(r.tok || 0);
  }
  const c = await cpa.creds(30000);
  const accRows = all(`SELECT auth_id, MAX(owner_id) AS owner, COUNT(*) AS req, SUM(${TOK}) AS tok FROM usage ${w} AND auth_id IS NOT NULL GROUP BY auth_id ORDER BY tok DESC LIMIT 30`, since);
  const byAccount = accRows.map((r) => {
    const mine = admin || r.owner === u.id;
    const email = mine ? (isUp(r.auth_id) ? upName(r.auth_id) : c.byId.get(r.auth_id)?.email || one('SELECT email FROM accounts WHERE auth_id = ?', r.auth_id)?.email || r.auth_id) : '';
    return { name: mine ? email : '共享账号 ' + anonLabel(r.auth_id), own: r.owner === u.id, req: Number(r.req), tok: Number(r.tok || 0) };
  });
  const byUser = all_ ? all(`SELECT us.name AS name, COUNT(*) AS req, SUM(${TOK.replace(/(total_tok|in_tok|out_tok|reasoning_tok)/g, 'u.$1')}) AS tok
    FROM usage u LEFT JOIN users us ON us.id = u.user_id WHERE u.ts >= ? GROUP BY u.user_id ORDER BY tok DESC LIMIT 30`, since)
    .map((r) => ({ name: r.name || '—', req: Number(r.req), tok: Number(r.tok || 0) })) : undefined;
  // Efficiency: successful requests only. Output speed counts generation time after the first token.
  const pf = one(`SELECT COUNT(*) AS n, AVG(COALESCE(cpa_ttft_ms, ttfb_ms)) AS ttft, AVG(latency_ms) AS lat,
    SUM(CASE WHEN COALESCE(cpa_ttft_ms, ttfb_ms) > 0 AND latency_ms > COALESCE(cpa_ttft_ms, ttfb_ms) THEN COALESCE(out_tok,0) + COALESCE(reasoning_tok,0) END) AS gtok,
    SUM(CASE WHEN COALESCE(cpa_ttft_ms, ttfb_ms) > 0 AND latency_ms > COALESCE(cpa_ttft_ms, ttfb_ms) THEN latency_ms - COALESCE(cpa_ttft_ms, ttfb_ms) END) AS gms
    FROM usage ${w} AND result = 'ok'`, since);
  const num = (v: unknown) => Number(v || 0);
  const perf = { n: num(pf?.n), ttft: Math.round(num(pf?.ttft)), latency: Math.round(num(pf?.lat)), speed: num(pf?.gms) ? Math.round(num(pf?.gtok) / num(pf?.gms) * 10000) / 10 : 0 };
  return {
    range, step, admin, scope: all_ ? 'all' : 'mine',
    totals: { req: num(tot?.req), ok: num(tot?.ok), in: num(tot?.i), out: num(tot?.o), think: num(tot?.r), cache: num(tot?.c), tok: num(tot?.tok), accounts: num(tot?.accounts), models: num(tot?.models), users: num(tot?.users) },
    models: byModel.map((r) => ({ name: r.m, req: num(r.req), in: num(r.i), out: num(r.o), think: num(r.r), cache: num(r.c), tok: num(r.tok) })),
    series: [...top, ...(byModel.length > 5 ? ['其他'] : [])],
    trend, hours, heat, heatStart: day0 * 86400e3 - tz, byAccount, byUser, perf,
  };
});

// ---------- admin ----------
route('GET', '/api/admin/users', async (req) => {
  requireAdmin(req);
  const since = dayStart();
  const rules = getRules(), cr = await cpa.creds(10000);
  const valid = new Map<number, number>();
  for (const r of all('SELECT * FROM accounts WHERE owner_id IS NOT NULL AND shared = 1 AND suspended = 0')) {
    const c = cr.byId.get(r.auth_id);
    if (c && !c.disabled && !accountProblem(r, c) && isPaid(r)) valid.set(r.owner_id, (valid.get(r.owner_id) || 0) + 1);
  }
  const sharedToday = new Map(all(`SELECT user_id, COUNT(*) AS n FROM usage WHERE pool = 'shared' AND ts >= ? AND result NOT IN ('daily_limit', 'input_limit') GROUP BY user_id`, since).map((r) => [r.user_id, Number(r.n)]));
  const acc = new Map(all('SELECT owner_id, COUNT(*) AS n, SUM(shared) AS s FROM accounts GROUP BY owner_id').map((r) => [r.owner_id, r]));
  const keys = new Map(all('SELECT user_id, COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL GROUP BY user_id').map((r) => [r.user_id, r.n]));
  const reqs = new Map(all(`SELECT user_id, COUNT(*) AS n, SUM(ts >= ?) AS today, SUM(COALESCE(total_tok,0)) AS tok, MAX(ts) AS last FROM usage WHERE user_id IS NOT NULL GROUP BY user_id`, since).map((r) => [r.user_id, r]));
  const served = new Map(all(`SELECT owner_id, COUNT(*) AS n FROM usage WHERE pool = 'shared' AND owner_id IS NOT NULL AND (user_id IS NULL OR user_id != owner_id) GROUP BY owner_id`).map((r) => [r.owner_id, r.n]));
  return all('SELECT * FROM users ORDER BY id').map((u) => {
    const a = acc.get(u.id), r = reqs.get(u.id);
    const shared = Number(a?.s || 0), accounts = Number(a?.n || 0);
    return {
      id: u.id, name: u.name, handle: u.handle, discordId: u.username ? '' : u.discord_id, username: u.username || null,
      role: u.role, active: !!u.active, reason: u.disabled_reason,
      accounts, shared, private: accounts - shared, keys: Number(keys.get(u.id) || 0),
      reqToday: Number(r?.today || 0), reqTotal: Number(r?.n || 0), tokens: Number(r?.tok || 0), served: Number(served.get(u.id) || 0),
      lastActive: Math.max(Number(r?.last || 0), Number(u.last_login || 0)) || null, created: u.created_at,
      dailyUsed: sharedToday.get(u.id) || 0, dailyOverride: u.daily_limit ?? null,
      dailyLimit: u.daily_limit != null ? (u.daily_limit < 0 ? null : u.daily_limit) : u.role === 'admin' ? null : rules.dailyBase + rules.dailyPer * (valid.get(u.id) || 0),
    };
  });
});
function checkNewPassword(pw: unknown): string {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < 8 || s.length > 128) throw new HttpError(400, 'weak_password');
  return s;
}
route('POST', '/api/admin/users', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, 'invalid_username');
  const pw = checkNewPassword(b.password);
  if (one('SELECT 1 FROM users WHERE username = ? OR discord_id = ?', username, 'local:' + username)) throw new HttpError(409, 'username_taken');
  const r = run('INSERT INTO users(discord_id, name, handle, role, username, pass_hash, created_at) VALUES(?,?,?,?,?,?,?)',
    'local:' + username, str(b.name, 40) || username, username, b.role === 'admin' ? 'admin' : 'user', username, hashPassword(pw), now());
  return { id: Number(r.lastInsertRowid) };
});
route('PATCH', '/api/admin/users/:id', async (req, _res, p) => {
  const me = requireAdmin(req);
  const id = Number(p.id);
  if (id === me.id) throw new HttpError(400, 'cannot_change_self');
  if (!one('SELECT 1 FROM users WHERE id = ?', id)) throw new HttpError(404, 'not_found');
  const b = await readJSON(req);
  if (typeof b.active === 'boolean') await setUserActive(id, b.active, 'admin');
  if (b.role === 'admin' || b.role === 'user') run('UPDATE users SET role = ? WHERE id = ?', b.role, id);
  if (b.dailyLimit !== undefined) {
    if (b.dailyLimit !== null && !(Number.isInteger(b.dailyLimit) && b.dailyLimit >= -1 && b.dailyLimit <= 1e6)) throw new HttpError(400, 'invalid');
    run('UPDATE users SET daily_limit = ? WHERE id = ?', b.dailyLimit, id);
  }
  if (b.password !== undefined) {
    if (!one('SELECT 1 FROM users WHERE id = ? AND username IS NOT NULL', id)) throw new HttpError(400, 'not_password_user');
    run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(checkNewPassword(b.password)), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  return { ok: true };
});

route('GET', '/api/admin/accounts', async (req) => {
  requireAdmin(req);
  const c = await cpa.creds(3000);
  const rows = new Map(all('SELECT * FROM accounts').map((r) => [r.auth_id, r]));
  const users = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
  return c.list.map((cred) => {
    const r = rows.get(cred.id) || { auth_id: cred.id, shared: 0, proxy_id: null, owner_id: null };
    return {
      id: cred.id, email: cred.email, type: cred.type, name: cred.note,
      ownerId: r.owner_id, owner: r.owner_id ? users.get(r.owner_id) || '' : null,
      shared: !!r.shared, proxyId: r.proxy_id, active: !cred.disabled, asleep: !!r.sleep_at, inflight: accountInflight(cred.id),
      ...accState(cred),
    };
  });
});
route('PATCH', '/api/admin/accounts/:id', async (req, _res, p) => {
  requireAdmin(req);
  const c = await cpa.creds(0);
  const cred = c.byId.get(p.id);
  if (!cred) throw new HttpError(404, 'not_found');
  ensureRow(cred.id, cred.email);
  const b = await readJSON(req);
  if (typeof b.active === 'boolean' && b.active === cred.disabled) await cpa.setDisabled(cred.id, !b.active);
  if (b.ownerId !== undefined) throw new HttpError(400, 'owner_fixed'); // an account always belongs to whoever added it
  if (b.proxyId !== undefined) {
    let url = '';
    if (b.proxyId !== null) {
      const px = one('SELECT * FROM proxies WHERE id = ?', Number(b.proxyId));
      if (!px) throw new HttpError(400, 'invalid_proxy');
      const used = one('SELECT auth_id FROM accounts WHERE proxy_id = ? AND auth_id != ?', px.id, cred.id);
      if (used) throw new HttpError(409, 'proxy_in_use');
      url = px.url;
    }
    await cpa.patchFields(cred.id, { proxy_url: url });
    run('UPDATE accounts SET proxy_id = ? WHERE auth_id = ?', b.proxyId === null ? null : Number(b.proxyId), cred.id);
  }
  return { ok: true };
});

route('GET', '/api/admin/proxies', (req) => {
  requireAdmin(req);
  return all('SELECT p.id, p.url, a.auth_id FROM proxies p LEFT JOIN accounts a ON a.proxy_id = p.id ORDER BY p.id')
    .map((p) => ({ id: p.id, url: maskProxy(p.url), account: p.auth_id || null }));
});
route('POST', '/api/admin/proxies', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  const url = str(b.url, 500);
  let u: URL;
  try { u = new URL(url); } catch { throw new HttpError(400, 'invalid_proxy'); }
  if (!/^(socks5h?|https?):$/.test(u.protocol) || !u.hostname) throw new HttpError(400, 'invalid_proxy');
  try { run('INSERT INTO proxies(url, created_at) VALUES(?,?)', url, now()); } catch { throw new HttpError(409, 'duplicate'); }
  return { ok: true };
});
route('DELETE', '/api/admin/proxies/:id', async (req, _res, p) => {
  requireAdmin(req);
  const used = one('SELECT auth_id FROM accounts WHERE proxy_id = ?', Number(p.id));
  if (used) throw new HttpError(409, 'proxy_in_use');
  run('DELETE FROM proxies WHERE id = ?', Number(p.id));
  return { ok: true };
});

route('PUT', '/api/admin/rules', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  const cur = getRules();
  const r = {
    keyConc: b.keyConc === undefined ? cur.keyConc : clampInt(b.keyConc, 1, 200),
    keyRpm: b.keyRpm === undefined ? cur.keyRpm : clampInt(b.keyRpm, 1, 10000),
    accConc: b.accConc === undefined ? cur.accConc : clampInt(b.accConc, 1, 20),
    reserve: b.reserve === undefined ? cur.reserve : clampInt(b.reserve, 0, 90),
    dailyBase: b.dailyBase === undefined ? cur.dailyBase : clampInt(b.dailyBase, 0, 1e6),
    dailyPer: b.dailyPer === undefined ? cur.dailyPer : clampInt(b.dailyPer, 0, 1e6),
    sharedInput: b.sharedInput === undefined ? cur.sharedInput : clampInt(b.sharedInput, 0, 1e7),
  };
  setRules(r);
  return r;
});

// ---------- external upstreams (Tools) ----------
function upView(r: Row) {
  let allow: string[] | null = null;
  try { const v = JSON.parse(r.models_allow || 'null'); if (Array.isArray(v)) allow = v; } catch {}
  return { id: r.id, name: r.name, url: r.base_url, enabled: !!r.enabled, keySet: !!r.key_enc, models: modelInfo(r.id), allow,
    today: Number(one(`SELECT COUNT(*) AS n FROM usage WHERE auth_id = ? AND ts >= ?`, 'up:' + r.id, dayStart())?.n || 0) };
}
function upBody(b: any, needKey: boolean) {
  const name = str(b.name, 40) || 'Tools';
  let base = '';
  try { base = normBase(str(b.url, 300)); } catch { throw new HttpError(400, 'invalid_url'); }
  const key = str(b.key, 300);
  if (needKey && !key) throw new HttpError(400, 'invalid_key');
  let models: string[] | null | undefined;
  if (b.models !== undefined) {
    if (b.models !== null && !(Array.isArray(b.models) && b.models.length <= 500 && b.models.every((m: unknown) => typeof m === 'string' && m.length <= 120))) throw new HttpError(400, 'invalid');
    models = b.models;
  }
  return { name, base, key, enabled: b.enabled !== false, models };
}
route('GET', '/api/admin/upstreams', (req) => { requireAdmin(req); return upstreamRows().map(upView); });
route('POST', '/api/admin/upstreams', async (req) => {
  const u = requireAdmin(req);
  const id = saveUpstream(null, upBody(await readJSON(req), true), u.id);
  return upView(one('SELECT * FROM upstreams WHERE id = ?', id)!);
});
route('PATCH', '/api/admin/upstreams/:id', async (req, _res, p) => {
  const u = requireAdmin(req);
  const r = one('SELECT * FROM upstreams WHERE id = ?', Number(p.id));
  if (!r) throw new HttpError(404, 'not_found');
  const b = await readJSON(req);
  saveUpstream(r.id, upBody({ name: r.name, url: r.base_url, enabled: !!r.enabled, ...b }, false), u.id);
  return upView(one('SELECT * FROM upstreams WHERE id = ?', r.id)!);
});
route('DELETE', '/api/admin/upstreams/:id', (req, _res, p) => {
  requireAdmin(req);
  run('DELETE FROM upstreams WHERE id = ?', Number(p.id));
  return { ok: true };
});
route('POST', '/api/admin/upstreams/:id/test', async (req, _res, p) => {
  requireAdmin(req);
  const r = one('SELECT * FROM upstreams WHERE id = ?', Number(p.id));
  if (!r) throw new HttpError(404, 'not_found');
  const u = upstreamById(r.id)!;
  const ids = await modelsOf(u, true);
  const info = modelInfo(r.id);
  return { ok: !!ids && !info?.error, count: ids?.size ?? 0, error: info?.error || null, models: ids ? [...ids].slice(0, 200) : [] };
});

// ---------- models opened for the 大锅饭 ----------
route('GET', '/api/admin/shared-models', async (req) => {
  requireAdmin(req);
  const c = await cpa.creds(10000);
  const src = new Map<string, Set<string>>();
  const addM = (m: string, from: string) => { if (!src.has(m)) src.set(m, new Set()); src.get(m)!.add(from); };
  const ids = all('SELECT auth_id FROM accounts WHERE shared = 1').map((r) => r.auth_id).filter((id) => c.byId.has(id));
  await Promise.all(ids.map(async (id) => {
    for (const m of await cpa.credentialModels(id).catch(() => [])) if (m?.id) addM(String(m.id), 'google');
  }));
  for (const u of enabledUpstreams()) for (const m of await openModels(u)) addM(m, u.name);
  const allow = sharedModels();
  for (const m of allow || []) if (!src.has(m)) src.set(m, new Set());
  return { all: [...src.keys()].sort().map((id) => ({ id, from: [...src.get(id)!] })), allow: allow ? [...allow] : null };
});
route('PUT', '/api/admin/shared-models', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  if (b.allow !== null && !(Array.isArray(b.allow) && b.allow.length <= 500 && b.allow.every((m: unknown) => typeof m === 'string' && m.length <= 120))) throw new HttpError(400, 'invalid');
  setSharedModels(b.allow);
  return { allow: b.allow };
});

// 最大等待时长: CPA routing.retry.max-retry-interval (CPA hot-reloads it, no restart).
route('GET', '/api/admin/retry', async (req) => {
  requireAdmin(req);
  return cpa.retryConfig();
});
route('PUT', '/api/admin/retry', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  await cpa.setMaxRetryInterval(clampInt(b.maxWait, 0, 300));
  return cpa.retryConfig();
});

route('GET', '/api/admin/usage', (req) => {
  requireAdmin(req);
  const t = one(`SELECT COUNT(*) AS total, SUM(pool='private') AS p, SUM(pool='shared') AS s, SUM(result='no_account') AS na,
    SUM(COALESCE(total_tok,0)) AS tok FROM usage WHERE ts >= ?`, dayStart());
  return {
    total: Number(t?.total || 0), private: Number(t?.p || 0), shared: Number(t?.s || 0), rejected: Number(t?.na || 0), tokens: Number(t?.tok || 0),
    breaker: breakerState(),
    alarms: all('SELECT ts, kind, detail FROM alarms ORDER BY id DESC LIMIT 20'),
  };
});
route('POST', '/api/admin/breaker/reset', (req) => {
  requireAdmin(req);
  resetBreaker();
  return { ok: true };
});

route('GET', '/api/admin/site', (req) => {
  requireAdmin(req);
  return site.siteView();
});
route('GET', '/api/admin/bot', async (req) => {
  requireAdmin(req);
  return { ...(await botStatus()), chat: { ...chatStatus, model: chatModel() } };
});
// @ 机器人问答: model and prompt
route('GET', '/api/admin/botchat', async (req) => {
  requireAdmin(req);
  const ids = all(`SELECT a.auth_id FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.role = 'admin'`).map((r) => r.auth_id);
  const models = new Set<string>();
  for (const id of ids) for (const m of await cpa.credentialModels(id).catch(() => [])) if (m?.id) models.add(String(m.id));
  const sources = [{ id: 'cpa', name: '自己的号（CPA）', models: [...models].sort() }];
  for (const u of enabledUpstreams()) sources.push({ id: 'up:' + u.id, name: u.name + '（外部上游）', models: [...((await modelsOf(u).catch(() => null)) || [])].sort() });
  return { model: chatModel(), source: chatSource(), sources, prompt: chatPrompt(), custom: !!getSetting('bot_llm_prompt'), defaultPrompt: DEFAULT_PROMPT, models: [...models].sort() };
});
route('PUT', '/api/admin/botchat', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  if (b.model !== undefined) {
    if (typeof b.model !== 'string' || !/^[\w.:\/-]{1,80}$/.test(b.model)) throw new HttpError(400, 'invalid_model');
    setSetting('bot_llm_model', b.model);
  }
  if (b.source !== undefined) {
    if (b.source !== 'cpa' && !(typeof b.source === 'string' && /^up:\d+$/.test(b.source) && upstreamById(Number(b.source.slice(3))))) throw new HttpError(400, 'invalid_source');
    setSetting('bot_llm_source', b.source);
  }
  if (b.prompt !== undefined) {
    if (b.prompt !== null && (typeof b.prompt !== 'string' || b.prompt.length > 20000)) throw new HttpError(400, 'invalid_prompt');
    setSetting('bot_llm_prompt', b.prompt && b.prompt.trim() && b.prompt.trim() !== DEFAULT_PROMPT ? b.prompt.trim() : '');
  }
  return { ok: true, model: chatModel(), source: chatSource(), custom: !!getSetting('bot_llm_prompt') };
});
// 机器人知识库
route('GET', '/api/admin/kb', (req) => { requireAdmin(req); return kbList(); });
route('POST', '/api/admin/kb', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  let title = typeof b.title === 'string' ? b.title : '', body = typeof b.body === 'string' ? b.body : '', source: string | null = null;
  if (typeof b.url === 'string' && b.url) {
    try { const f = await kbFetch(b.url); title ||= f.title; body = f.text; source = b.url; } catch (e) { throw new HttpError(502, 'fetch_failed: ' + (e as Error).message); }
  }
  if (!body.trim()) throw new HttpError(400, 'empty');
  return { id: kbAdd(title, body, source), list: kbList() };
});
route('DELETE', '/api/admin/kb/:id', (req, _res, p) => {
  requireAdmin(req);
  if (!kbDelete(Number(p.id))) throw new HttpError(404, 'not_found');
  return kbList();
});
route('POST', '/api/admin/bot/connect', async (req) => {
  requireAdmin(req);
  try { await connectInteractions(); } catch (e) { throw new HttpError(502, (e as Error).message); }
  return botStatus();
});
route('POST', '/api/admin/bot/test', async (req) => {
  requireAdmin(req);
  if (!(await testMessage())) throw new HttpError(502, 'bot_post_failed');
  return { ok: true };
});
route('PUT', '/api/admin/site', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  try { site.updateSite(b); } catch (e) { throw new HttpError(400, (e as Error).message); }
  registerCommands().catch(() => {});
  return site.siteView();
});
