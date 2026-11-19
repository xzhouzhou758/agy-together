import { basename, join } from 'node:path';
// JSON API for the web UI (AI Studio slimmed edition). Every handler does its own server-side authorization.
import { seal as sealBotKey } from './util.ts';
import { botAPISettings, normalizeBotURL } from './botapi.ts';
import { chatStatus, chatModel, chatSource, chatPrompt, DEFAULT_PROMPT } from './botchat.ts';
import { kbList, kbAdd, kbDelete, kbFetch } from './kb.ts';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { one, all, run, now, getSetting, setSetting, type Row } from './db.ts';
import { HttpError, sendJSON, readJSON, sha256, token, seal, unseal, str, clampInt, hashPassword } from './util.ts';
import { requireUser, requireAdmin, currentUser, devLogin, passwordLogin, logout, setUserActive, type User } from './auth.ts';
import { userRotation, fetchAIS2ModelIds } from './gateway.ts';
import { MODES, newSalt } from './routing.ts';
import { reasonText } from './reason.ts';
import * as site from './site.ts';
import { registerCommands, botStatus, connectInteractions, testMessage, postAnnouncement } from './bot.ts';
import { stockAdmin, setWatched } from './stock.ts';
import * as aistudio2 from './aistudio2.ts';
import * as browser from './browser.ts';
import * as cpa from './cpa.ts';
import { writeZip } from './zip.ts';
import * as exit from './exit.ts';
import * as fun from './fun.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, p: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
function route(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, h });
}

export async function handleAPI(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers['x-portal-csrf'] !== '1') throw new HttpError(403, 'csrf');
    if (req.headers.origin && req.headers.host) {
      try { if (new URL(String(req.headers.origin)).host !== req.headers.host) throw new HttpError(403, 'csrf_origin'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(403, 'csrf_origin'); }
    }
  }
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

function dayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function anonLabel(authId: string): string {
  if (aistudio2.isAIS2(authId)) return aistudio2.ais2Anon(authId);
  return '#00';
}

// ---------- public ----------
const HAS_LOGO = existsSync(new URL('../public/logo.jpg', import.meta.url));
route('GET', '/api/config', (req) => ({
  devLogin: config.devLogin,
  discord: site.discordReady(),
  setup: !site.setupDone(),
  logo: HAS_LOGO,
  signedIn: !!currentUser(req),
  aistudio2: aistudio2.aistudio2On(),
  browserEnabled: browser.browserOn(),
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
  const u = requireUser(req) as User & { username?: string | null };
  return {
    id: u.id, name: u.name, handle: u.handle, discordId: u.discord_id, username: u.username || null, role: u.role, realRole: currentUser(req)?.role || u.role, defaultPool: 'aistudio2',
    rotation: userRotation(u.id).mode,
    inputLimit: u.input_limit ?? null,
    ais2Slim: (u.ais2_slim ?? 1) !== 0,
    oldAccounts: Number(one('SELECT COUNT(*) AS n FROM accounts WHERE owner_id = ?', u.id)?.n || 0),
    ais2Models: (() => { try { const a = u.ais2_models ? JSON.parse(String(u.ais2_models)) : null; return Array.isArray(a) && a.length ? a : null; } catch { return null; } })(),
    baseURL: (site.publicURL() || '') + '/v1',
  };
});

route('PATCH', '/api/me', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  if (b.rotation === undefined && b.inputLimit === undefined && b.ais2Slim === undefined && b.ais2Models === undefined) throw new HttpError(400, 'invalid_body');
  if (b.inputLimit !== undefined) {
    if (b.inputLimit !== null && !(Number.isInteger(b.inputLimit) && b.inputLimit >= 1000 && b.inputLimit <= 10_000_000)) throw new HttpError(400, 'invalid_input_limit');
    run('UPDATE users SET input_limit = ? WHERE id = ?', b.inputLimit, u.id);
  }
  if (b.ais2Slim !== undefined) {
    if (typeof b.ais2Slim !== 'boolean') throw new HttpError(400, 'invalid');
    run('UPDATE users SET ais2_slim = ? WHERE id = ?', b.ais2Slim ? 1 : 0, u.id);
  }
  if (b.ais2Models !== undefined) {
    if (b.ais2Models === null) {
      run('UPDATE users SET ais2_models = NULL WHERE id = ?', u.id);
    } else if (Array.isArray(b.ais2Models)) {
      const clean = [...new Set(b.ais2Models.map((x: unknown) => String(x || '').trim()).filter((x: string) => x.length > 0 && x.length <= 120))].slice(0, 200);
      run('UPDATE users SET ais2_models = ? WHERE id = ?', clean.length ? JSON.stringify(clean) : null, u.id);
    } else {
      throw new HttpError(400, 'invalid_models');
    }
  }
  if (b.rotation !== undefined) {
    if (!MODES.includes(b.rotation)) throw new HttpError(400, 'invalid_rotation');
    run('UPDATE users SET rotation_mode = ? WHERE id = ?', b.rotation, u.id);
  }
  return { ok: true };
});

route('POST', '/api/me/sessions/reset', (req) => {
  const u = requireUser(req);
  run('UPDATE users SET session_salt = ? WHERE id = ?', newSalt(), u.id);
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
  return { seen: top };
});
function annBody(b: any) {
  const title = str(b.title, 100), body = str(b.body, 5000);
  if (!title) throw new HttpError(400, 'invalid_title', '请填写公告标题');
  if (b.level !== undefined && b.level !== 'info' && b.level !== 'important') throw new HttpError(400, 'invalid');
  return { title, body, level: b.level === 'important' ? 'important' : 'info', pinned: b.pinned ? 1 : 0 };
}
route('POST', '/api/admin/announcements', async (req) => {
  const u = requireAdmin(req);
  const b = await readJSON(req);
  const a = annBody(b);
  const r = run('INSERT INTO announcements(title, body, level, pinned, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
    a.title, a.body, a.level, a.pinned, u.id, now(), now());
  let discord: boolean | null = null;
  if (b.discord === true) discord = await postAnnouncement(a.title, a.body, site.publicURL() ? site.publicURL() + '/' : '');
  return { ...annView(one('SELECT * FROM announcements WHERE id = ?', r.lastInsertRowid)!), discord };
});
route('PATCH', '/api/admin/announcements/:id', async (req, _res, p) => {
  requireAdmin(req);
  const id = Number(p.id);
  const cur = one('SELECT * FROM announcements WHERE id = ?', id);
  if (!cur) throw new HttpError(404, 'not_found');
  const b = await readJSON(req);
  const a = annBody({ title: cur.title, body: cur.body, level: cur.level, pinned: !!cur.pinned, ...b });
  run('UPDATE announcements SET title = ?, body = ?, level = ?, pinned = ?, updated_at = ? WHERE id = ?', a.title, a.body, a.level, a.pinned, now(), id);
  return annView(one('SELECT * FROM announcements WHERE id = ?', id)!);
});
route('DELETE', '/api/admin/announcements/:id', (req, _res, p) => {
  requireAdmin(req);
  run('DELETE FROM announcements WHERE id = ?', Number(p.id));
  return { ok: true };
});

// ---------- overview (AI Studio only) ----------

const AIS2_MODELS_ORDER = [
  'gemini-4-argon',
  'gemini-4-carbon',
  'gemini-4-hydrogen',
  'gemini-3.1-pro-preview',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
] as const;

type TierRule = { req: number | null; tok: number | null; unknown?: boolean } | null;
const AIS2_TIER_QUOTA: Record<'FREE' | 'PRO' | 'ULTRA', Record<string, TierRule>> = {
  FREE: {
    'gemini-4-argon': null,
    'gemini-4-carbon': null,
    'gemini-4-hydrogen': { req: 50, tok: 10_000_000 },
    'gemini-3.1-pro-preview': null,
    'gemini-3.8-flash': { req: 50, tok: 5_000_000 },
    'gemini-3.6-flash': { req: 50, tok: 5_000_000 },
    'gemini-3-flash-preview': { req: 50, tok: 5_000_000 },
    'gemini-3.5-flash-lite': { req: 50, tok: 5_000_000 },
    'gemini-3.1-flash-lite': { req: 50, tok: 5_000_000 },
  },
  PRO: {
    'gemini-4-argon': { req: 50, tok: 15_000_000 },
    'gemini-4-carbon': null,
    'gemini-4-hydrogen': { req: 100, tok: 25_000_000 },
    'gemini-3.1-pro-preview': { req: 50, tok: 13_000_000 },
    'gemini-3.8-flash': { req: 150, tok: 25_000_000 },
    'gemini-3.6-flash': { req: 150, tok: 25_000_000 },
    'gemini-3-flash-preview': { req: 150, tok: 25_000_000 },
    'gemini-3.5-flash-lite': { req: 150, tok: 25_000_000 },
    'gemini-3.1-flash-lite': { req: 150, tok: 25_000_000 },
  },
  ULTRA: {
    'gemini-4-argon': { req: 200, tok: null },
    'gemini-4-carbon': { req: 200, tok: null },
    'gemini-4-hydrogen': { req: null, tok: null, unknown: true },
    'gemini-3.1-pro-preview': { req: 100, tok: null },
    'gemini-3.8-flash': { req: 200, tok: null },
    'gemini-3.6-flash': { req: 200, tok: null },
    'gemini-3-flash-preview': { req: 200, tok: null },
    'gemini-3.5-flash-lite': { req: 200, tok: null },
    'gemini-3.1-flash-lite': { req: 200, tok: null },
  },
};

function quotaPeriodStart(t = now()): number {
  const bj = t + 8 * 3600e3;
  const dayStartBj = bj - (bj % 86400e3);
  let resetBj = dayStartBj + 16 * 3600e3;
  if (bj < resetBj) resetBj -= 86400e3;
  return resetBj - 8 * 3600e3;
}

function normQuotaModel(raw: string): string {
  let m = String(raw || '').trim().toLowerCase().replace(/^models\//, '');
  m = m.replace(/\([^)]*\)$/, '').replace(/-(?:minimal|low|medium|high|xhigh|extra[_-]high|max)(?:-search)?$/, '').replace(/-search$/, '').trim();
  return m;
}

route('GET', '/api/overview', async (req) => {
  const u = requireUser(req);
  const admin = u.role === 'admin';
  const since = dayStart();
  const mineAccs = aistudio2.listFor(u.id);
  const validMine = mineAccs.filter((a: any) => a.status === 'valid').length;
  const keysCount = Number(one('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', u.id)?.n || 0);
  const exitData = await exit.getUserExits(u.id).catch(() => null);
  const exitMap = new Map<string, string>((exitData?.accounts || []).map((x: any) => [x.id, x.nodeId || '']));
  const nodeName = new Map<string, string>();
  for (const n of exitData?.publicNodes || []) nodeName.set(n.id, n.name);
  for (const n of exitData?.userNodes || []) nodeName.set(n.nodeId, n.name);
  const boundCount = mineAccs.filter((a: any) => !!exitMap.get(a.id)).length;

  const myToday = one(
    `SELECT COUNT(*) AS n, SUM(result = 'ok') AS ok, SUM(COALESCE(in_tok,0)) AS in_t, SUM(COALESCE(out_tok,0) + COALESCE(reasoning_tok,0)) AS out_t,
     SUM(COALESCE(total_tok,0)) AS tok, AVG(CASE WHEN result='ok' THEN latency_ms END) AS avg_lat, AVG(CASE WHEN result='ok' THEN COALESCE(cpa_ttft_ms, ttfb_ms) END) AS avg_ttft
     FROM usage WHERE user_id = ? AND pool = 'aistudio2' AND ts >= ?`,
    u.id, since,
  );

  const tzMs = 8 * 3600e3;
  const hours = Array.from({ length: 24 }, () => ({ ok: 0, err: 0, tok: 0 }));
  for (const r of all(
    `SELECT CAST((ts + ?) / 3600000 AS INTEGER) % 24 AS h, SUM(result='ok') AS ok, SUM(result!='ok') AS err, SUM(COALESCE(total_tok,0)) AS tok
     FROM usage WHERE user_id = ? AND pool = 'aistudio2' AND ts >= ? GROUP BY h`,
    tzMs, u.id, since,
  )) {
    const h = Number(r.h);
    if (h >= 0 && h < 24) hours[h] = { ok: Number(r.ok || 0), err: Number(r.err || 0), tok: Number(r.tok || 0) };
  }

  const models = all(
    `SELECT COALESCE(NULLIF(requested_model,''), NULLIF(model,''), '—') AS m, COUNT(*) AS req, SUM(result='ok') AS ok, SUM(COALESCE(total_tok,0)) AS tok
     FROM usage WHERE user_id = ? AND pool = 'aistudio2' AND ts >= ? GROUP BY m ORDER BY req DESC, tok DESC LIMIT 6`,
    u.id, since,
  ).map((r) => ({ name: String(r.m), req: Number(r.req), ok: Number(r.ok || 0), tok: Number(r.tok || 0) }));

  const recent = all(
    `SELECT ts, auth_id, owner_id, COALESCE(requested_model, model) AS model, status, result, reason, latency_ms, COALESCE(cpa_ttft_ms, ttfb_ms) AS ttft
     FROM usage WHERE pool = 'aistudio2' ${admin ? '' : 'AND user_id = ' + Number(u.id)} ORDER BY ts DESC, id DESC LIMIT 30`,
  ).reverse().map((r) => ({
    ts: Number(r.ts),
    account: r.auth_id ? (admin || r.owner_id === u.id ? aistudio2.ais2Email(r.auth_id) || r.auth_id : anonLabel(r.auth_id)) : '',
    model: String(r.model || ''),
    status: Number(r.status),
    failed: r.result !== 'ok',
    error: r.result !== 'ok' ? String(r.reason || r.result || '') : '',
    ttft: r.ttft == null ? null : Number(r.ttft),
    latency: Number(r.latency_ms) || null,
  }));

  return {
    accounts: mineAccs.length,
    valid: validMine,
    keys: keysCount,
    bound: boundCount,
    today: {
      req: Number(myToday?.n || 0),
      ok: Number(myToday?.ok || 0),
      inTok: Number(myToday?.in_t || 0),
      outTok: Number(myToday?.out_t || 0),
      tok: Number(myToday?.tok || 0),
      avgLat: Math.round(Number(myToday?.avg_lat || 0)),
      avgTtft: Math.round(Number(myToday?.avg_ttft || 0)),
    },
    hours,
    models,
    accountList: mineAccs.map((a: any) => ({
      id: a.id,
      label: a.label || a.id,
      tier: a.tier || null,
      status: a.status,
      exitName: nodeName.get(exitMap.get(a.id) || '') || '本机直连',
    })),
    recent,
    quota: (() => {
      const qSince = quotaPeriodStart();
      const activeAccs = mineAccs.filter((a: any) => a.status === 'valid');
      const poolAccs = activeAccs;
      const tiers = poolAccs.map((a: any) => {
        const t = String(a.tier || 'FREE').toUpperCase();
        return (t.includes('ULTRA') ? 'ULTRA' : t.includes('PRO') ? 'PRO' : 'FREE') as 'FREE' | 'PRO' | 'ULTRA';
      });
      const usedMap = new Map<string, { req: number; tok: number }>();
      const activeIds = activeAccs.map((a: any) => String(a.id || '')).filter(Boolean);
      const usageRows = activeIds.length ? all(
        `SELECT COALESCE(NULLIF(upstream_model,''), NULLIF(model,''), NULLIF(requested_model,''), '') AS m, COUNT(*) AS n, SUM(COALESCE(total_tok,0)) AS tok
         FROM usage WHERE user_id = ? AND pool = 'aistudio2' AND result = 'ok' AND ts >= ? AND auth_id IN (${activeIds.map(() => '?').join(',')}) GROUP BY m`,
        u.id, qSince, ...activeIds,
      ) : [];
      for (const r of usageRows) {
        const nm = normQuotaModel(String(r.m || ''));
        if (!nm) continue;
        const cur = usedMap.get(nm) || { req: 0, tok: 0 };
        cur.req += Number(r.n || 0);
        cur.tok += Number(r.tok || 0);
        usedMap.set(nm, cur);
      }
      const models = AIS2_MODELS_ORDER.map((m) => {
        let reqLimit = 0, tokLimit = 0, hasTokLimit = false, supported = false, hasUnknown = false;
        for (const tier of tiers) {
          const rule = AIS2_TIER_QUOTA[tier][m];
          if (!rule) continue;
          supported = true;
          if (rule.unknown) hasUnknown = true;
          if (rule.req != null) reqLimit += rule.req;
          if (rule.tok != null) { tokLimit += rule.tok; hasTokLimit = true; }
        }
        const used = usedMap.get(m) || { req: 0, tok: 0 };
        return {
          model: m,
          supported,
          unknown: hasUnknown && reqLimit === 0,
          partialUnknown: hasUnknown && reqLimit > 0,
          usedReq: used.req,
          reqLimit: supported && reqLimit > 0 ? reqLimit : null,
          usedTok: used.tok,
          tokLimit: supported && hasTokLimit && !tiers.some((t) => AIS2_TIER_QUOTA[t][m] && AIS2_TIER_QUOTA[t][m]!.tok == null) ? tokLimit : null,
        };
      });
      return { resetAt: qSince + 86400e3, tiers, models };
    })(),
  };
});

// ---------- API keys (AI Studio only) ----------
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
  if (!aistudio2.aistudio2On()) throw new HttpError(400, 'aistudio_disabled');
  if ((one('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', u.id)?.n || 0) >= 20) throw new HttpError(400, 'too_many_keys');
  const plain = 'sk-agy-' + token(30);
  const r = run('INSERT INTO api_keys(user_id, name, pool, key_hash, key_enc, tail, created_at) VALUES(?,?,?,?,?,?,?)',
    u.id, str(b.name, 40) || 'AI Studio Key', 'aistudio2', sha256(plain), seal(plain), plain.slice(-4), now());
  return keyView(one('SELECT * FROM api_keys WHERE id = ?', r.lastInsertRowid)!);
});
route('PATCH', '/api/keys/:id', async (req, _res, p) => {
  const u = requireUser(req);
  const k = one('SELECT * FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL', Number(p.id), u.id);
  if (!k) throw new HttpError(404, 'not_found');
  const b = await readJSON(req);
  if (b.name !== undefined) run('UPDATE api_keys SET name = ? WHERE id = ?', str(b.name, 40) || k.name, k.id);
  return keyView(one('SELECT * FROM api_keys WHERE id = ?', k.id)!);
});
route('DELETE', '/api/keys/:id', (req, _res, p) => {
  const u = requireUser(req);
  const r = run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), Number(p.id), u.id);
  if (!Number(r.changes)) throw new HttpError(404, 'not_found');
  return { ok: true };
});

// ---------- AI Studio 2 pool ----------
const ai2On = () => { if (!aistudio2.aistudio2On()) throw new HttpError(404, 'not_found'); };
route('GET', '/api/aistudio2/models', async (req) => { requireUser(req); ai2On(); return { models: await fetchAIS2ModelIds() }; });
route('GET', '/api/aistudio2', (req) => { const u = requireUser(req); ai2On(); return aistudio2.listFor(u.id); });
route('POST', '/api/aistudio2', async (req) => {
  const u = requireUser(req); ai2On();
  const b = await readJSON(req);
  if (typeof b.cookies !== 'string') throw new HttpError(400, 'aistudio_cookie', '请粘贴 Cookie 或账号 JSON');
  const res = await aistudio2.upload(u.id, b.cookies, false);
  if (res && typeof (res as any).email === 'string') await exit.reapplyAccountProxy((res as any).email);
  else if (Array.isArray((res as any)?.accounts)) for (const a of (res as any).accounts) if (a?.email) await exit.reapplyAccountProxy(a.email);
  return res;
});
route('POST', '/api/aistudio2/:id/check', async (req, _res, p) => aistudio2.recheck(requireUser(req).id, p.id));
route('DELETE', '/api/aistudio2/:id', async (req, _res, p) => aistudio2.remove(requireUser(req).id, p.id));

route('GET', '/api/admin/aistudio2', (req) => { requireAdmin(req); return aistudio2.aistudio2On() ? aistudio2.listAll() : []; });
route('POST', '/api/admin/aistudio2/recheck', async (req) => { requireAdmin(req); ai2On(); return aistudio2.sweep(); });
route('DELETE', '/api/admin/aistudio2/:id', async (req, _res, p) => aistudio2.remove(requireAdmin(req).id, p.id, true));

// ---------- Shared Browser ----------
route('GET', '/api/browser', (req) => browser.viewFor(requireUser(req).id));
route('POST', '/api/browser/join', async (req) => {
  const user = requireUser(req);
  const b = req.headers['content-type']?.includes('json') ? await readJSON(req) : {};
  return b?.reset === true ? browser.open(user.id, [], { reset: true }) : browser.join(user.id);
});
route('POST', '/api/browser/leave', async (req) => browser.leave(requireUser(req).id));
route('GET', '/api/admin/browser', (req) => { requireAdmin(req); return browser.adminView(); });
route('POST', '/api/admin/browser/kick', async (req) => { requireAdmin(req); return browser.kick(); });

// ---------- usage & traffic ----------
route('GET', '/api/usage/requests', async (req, _res, _p, url) => {
  const u = requireUser(req);
  const limit = clampInt(url.searchParams.get('limit') || 100, 1, 500);
  const rows = all("SELECT * FROM usage WHERE user_id = ? AND pool = 'aistudio2' ORDER BY ts DESC LIMIT ?", u.id, limit);
  return rows.map((r) => {
    let account: string | null = null;
    if (r.auth_id) {
      account = r.owner_id === u.id ? (aistudio2.isAIS2(r.auth_id) ? aistudio2.ais2Email(r.auth_id) : r.auth_id) : anonLabel(r.auth_id);
    }
    return { ts: r.ts, model: r.model, pool: r.pool, account, own: r.owner_id === u.id, result: r.result, status: r.status, latency: r.latency_ms, tokens: r.total_tok };
  });
});

const FAMILY: Record<string, string> = { claude: '%claude%', gemini: '%gemini%', flash: '%flash%', pro: '%pro%', image: '%image%' };
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
async function traffic(u: User, url: URL) {
  const admin = u.role === 'admin';
  const sp = url.searchParams;
  const size = clampInt(sp.get('size') || 50, 1, 100);
  const page = clampInt(sp.get('page') || 1, 1, 1e6);
  const where: string[] = ["u.pool = 'aistudio2'"], args: any[] = [];
  if (!admin) { where.push('u.user_id = ?'); args.push(u.id); }
  else if (sp.get('user')) { where.push('u.user_id = ?'); args.push(clampInt(sp.get('user'), 0, 1e12)); }
  const acc = (sp.get('account') || '').trim();
  if (acc) {
    if (!admin && !one('SELECT 1 FROM aistudio2_accounts WHERE account_id = ? AND owner_id = ?', acc, u.id)) where.push('0');
    else { where.push('u.auth_id = ?'); args.push(acc); }
  }
  const pool = sp.get('pool');
  if (pool === 'aistudio2') { where.push('u.pool = ?'); args.push(pool); }
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
  const email = (id: string) => (aistudio2.isAIS2(id) ? aistudio2.ais2Email(id) : id);
  const list = rows.map((r) => {
    let account: string | null = null, accountId: string | null = null;
    if (r.auth_id) {
      if (admin || r.owner_id === u.id) { account = email(r.auth_id) || r.auth_id; accountId = r.auth_id; }
      else account = '共享账号 ' + anonLabel(r.auth_id);
    }
    return {
      id: r.id, ts: r.ts, method: 'POST', path: r.path, stream: !!r.stream, status: r.status, result: r.result, pool: r.pool,
      model: r.requested_model || r.model, upstream: r.upstream_model || null, effort: r.reasoning_effort || null,
      user: admin ? r.user_name || null : undefined, key: r.key_name || null,
      account, accountId, own: r.owner_id === u.id,
      in: r.in_tok, out: r.out_tok, think: r.reasoning_tok, cache: r.cache_tok, cacheWrite: r.cache_write_tok, total: r.total_tok,
      attempts: r.attempts ?? null, upstreamStatus: r.upstream_status ?? null, reason: reasonText(r as any),
      latency: r.latency_ms, ttfb: r.cpa_ttft_ms ?? r.ttfb_ms, upLatency: r.cpa_latency_ms ?? null,
    };
  });
  const accounts = (admin ? all('SELECT account_id AS id, email FROM aistudio2_accounts ORDER BY email') : all('SELECT account_id AS id, email FROM aistudio2_accounts WHERE owner_id = ? ORDER BY email', u.id))
    .map((r) => ({ id: r.id, email: r.email || r.id }));
  const users = admin ? all('SELECT id, name FROM users ORDER BY name').map((x) => ({ id: x.id, name: x.name })) : undefined;
  return { rows: list, total, ok, error: total - ok, page, size, admin, accounts, users };
}
route('GET', '/api/traffic', async (req, _res, _p, url) => traffic(requireUser(req), url));
route('GET', '/api/admin/traffic', async (req, _res, _p, url) => traffic(requireAdmin(req), url));
route('GET', '/api/admin/traffic/:id/log', (req) => { requireAdmin(req); return { found: false }; });

// ---------- token stats ----------
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
  const scope = "AND pool = 'aistudio2'" + (all_ ? '' : ' AND user_id = ' + Number(u.id));
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
  const hours = Array(24).fill(0), hoursReq = Array(24).fill(0);
  for (const r of all(`SELECT CAST((ts + ?) / 3600000 AS INTEGER) % 24 AS h, SUM(${TOK}) AS tok, COUNT(*) AS n FROM usage WHERE ts >= ? ${scope} GROUP BY h`, tz, t - 30 * 86400e3)) { hours[Number(r.h)] = Number(r.tok || 0); hoursReq[Number(r.h)] = Number(r.n || 0); }
  const day0 = Math.floor((t + tz) / 86400e3) - 90;
  const heat = Array(91).fill(0), heatReq = Array(91).fill(0);
  for (const r of all(`SELECT CAST((ts + ?) / 86400000 AS INTEGER) AS d, SUM(${TOK}) AS tok, COUNT(*) AS n FROM usage WHERE ts >= ? ${scope} GROUP BY d`, tz, day0 * 86400e3 - tz)) {
    const k = Number(r.d) - day0;
    if (k >= 0 && k < 91) { heat[k] = Number(r.tok || 0); heatReq[k] = Number(r.n || 0); }
  }
  const accRows = all(`SELECT auth_id, MAX(owner_id) AS owner, COUNT(*) AS req, SUM(${TOK}) AS tok FROM usage ${w} AND auth_id IS NOT NULL GROUP BY auth_id ORDER BY tok DESC LIMIT 30`, since);
  const byAccount = accRows.map((r) => {
    const mine = admin || r.owner === u.id;
    const name = mine ? (aistudio2.isAIS2(r.auth_id) ? aistudio2.ais2Email(r.auth_id) : r.auth_id) : '共享账号 ' + anonLabel(r.auth_id);
    return { name, own: r.owner === u.id, req: Number(r.req), tok: Number(r.tok || 0) };
  });
  const byUser = all_ ? all(`SELECT us.name AS name, COUNT(*) AS req, SUM(${TOK.replace(/(total_tok|in_tok|out_tok|reasoning_tok)/g, 'u.$1')}) AS tok
    FROM usage u LEFT JOIN users us ON us.id = u.user_id WHERE u.ts >= ? AND u.pool = 'aistudio2' GROUP BY u.user_id ORDER BY tok DESC LIMIT 30`, since)
    .map((r) => ({ name: r.name || '—', req: Number(r.req), tok: Number(r.tok || 0) })) : undefined;
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
    trend, hours, hoursReq, heat, heatReq, heatStart: day0 * 86400e3 - tz, byAccount, byUser, perf,
  };
});

// ---------- admin ----------
route('GET', '/api/admin/users', async (req) => {
  requireAdmin(req);
  const since = dayStart();
  const acc = new Map(all('SELECT owner_id, COUNT(*) AS n, SUM(shared) AS s FROM aistudio2_accounts GROUP BY owner_id').map((r) => [r.owner_id, r]));
  const keys = new Map(all('SELECT user_id, COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL GROUP BY user_id').map((r) => [r.user_id, r.n]));
  const reqs = new Map(all(`SELECT user_id, COUNT(*) AS n, SUM(ts >= ?) AS today, SUM(COALESCE(total_tok,0)) AS tok, MAX(ts) AS last FROM usage WHERE user_id IS NOT NULL AND pool = 'aistudio2' GROUP BY user_id`, since).map((r) => [r.user_id, r]));
  return all('SELECT * FROM users ORDER BY id').map((u) => {
    const a = acc.get(u.id), r = reqs.get(u.id);
    const shared = Number(a?.s || 0), accounts = Number(a?.n || 0);
    return {
      id: u.id, name: u.name, handle: u.handle, discordId: u.username ? '' : u.discord_id, username: u.username || null,
      role: u.role, active: !!u.active, reason: u.disabled_reason,
      accounts, shared, private: accounts - shared, keys: Number(keys.get(u.id) || 0),
      reqToday: Number(r?.today || 0), reqTotal: Number(r?.n || 0), tokens: Number(r?.tok || 0), served: 0,
      lastActive: Math.max(Number(r?.last || 0), Number(u.last_login || 0)) || null, created: u.created_at,
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
  if (b.password !== undefined) {
    if (!one('SELECT 1 FROM users WHERE id = ? AND username IS NOT NULL', id)) throw new HttpError(400, 'not_password_user');
    run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(checkNewPassword(b.password)), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  return { ok: true };
});

route('GET', '/api/admin/usage', (req) => {
  requireAdmin(req);
  const t = one(`SELECT COUNT(*) AS total, SUM(result='no_account') AS na, SUM(COALESCE(total_tok,0)) AS tok FROM usage WHERE pool = 'aistudio2' AND ts >= ?`, dayStart());
  return { total: Number(t?.total || 0), rejected: Number(t?.na || 0), tokens: Number(t?.tok || 0) };
});

route('GET', '/api/admin/site', (req) => {
  requireAdmin(req);
  return site.siteView();
});
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
route('GET', '/api/admin/stock', async (req, _res, _p, url) => {
  requireAdmin(req);
  try { return await stockAdmin(url.searchParams.get('refresh') === '1'); } catch (e) { throw new HttpError(502, 'shop_unreachable: ' + (e as Error).message); }
});
route('PUT', '/api/admin/stock', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  if (!Array.isArray(b.watched)) throw new HttpError(400, 'invalid');
  return { watched: setWatched(b.watched) };
});

route('GET', '/api/admin/bot', async (req) => {
  requireAdmin(req);
  return { ...(await botStatus()), chat: { ...chatStatus, model: chatModel(), source: chatSource() } };
});
route('GET', '/api/admin/botchat', async (req) => {
  requireAdmin(req);
  return { model: chatModel(), source: 'external', external: botAPISettings(), sources: [], prompt: chatPrompt(), custom: !!getSetting('bot_llm_prompt'), defaultPrompt: DEFAULT_PROMPT, models: [] };
});
route('PUT', '/api/admin/botchat', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  const changes: [string, string][] = [];
  const source = b.source === undefined ? chatSource() : b.source;
  if (b.source !== undefined) changes.push(['bot_llm_source', String(source)]);
  if (b.model !== undefined) {
    if (typeof b.model !== 'string' || !/^[\w.:\/+-]{1,160}$/.test(b.model)) throw new HttpError(400, '模型名无效');
    changes.push([source === 'external' ? 'bot_api_model' : 'bot_llm_model', b.model]);
  }
  let url = botAPISettings().url, keySet = botAPISettings().keySet;
  if (b.external !== undefined) {
    if (!b.external || typeof b.external !== 'object' || Array.isArray(b.external)) throw new HttpError(400, 'API 配置无效');
    if (b.external.url !== undefined) {
      try { url = normalizeBotURL(b.external.url); } catch { throw new HttpError(400, '请填写有效的 API 地址，例如 https://example.com/v1'); }
      changes.push(['bot_api_url', url]);
    }
    if (b.external.key !== undefined && b.external.key !== '') {
      if (typeof b.external.key !== 'string' || !b.external.key.trim() || b.external.key.length > 8192 || /[\r\n]/.test(b.external.key)) throw new HttpError(400, 'API 密钥无效');
      changes.push(['bot_api_key', sealBotKey(b.external.key.trim())]); keySet = true;
    }
  }
  if ((b.source !== undefined || b.model !== undefined || b.external !== undefined) && source === 'external' && (!url || !keySet || !(b.model || botAPISettings().model))) throw new HttpError(400, '请填写 API 地址、密钥和模型名');
  if (b.prompt !== undefined) {
    if (b.prompt !== null && (typeof b.prompt !== 'string' || b.prompt.length > 20000)) throw new HttpError(400, 'invalid_prompt');
    changes.push(['bot_llm_prompt', b.prompt && b.prompt.trim() && b.prompt.trim() !== DEFAULT_PROMPT ? b.prompt.trim() : '']);
  }
  for (const [key, value] of changes) setSetting(key, value);
  return { ok: true, model: chatModel(), source: chatSource(), external: botAPISettings(), custom: !!getSetting('bot_llm_prompt') };
});
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

// ---------- Exit routing ----------
route('GET', '/api/admin/exits', (req) => { requireAdmin(req); return exit.getOverview(); });
route('POST', '/api/admin/exits/toggle', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  return exit.setEnabled(b.enabled !== false);
});
route('POST', '/api/admin/exits/test', async (req) => { requireAdmin(req); return { results: await exit.testNodes() }; });
route('POST', '/api/admin/exits/bind', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  return exit.bindAccount(b.kind, String(b.id || ''), String(b.nodeId || ''));
});
route('POST', '/api/admin/exits/distribute', async (req) => {
  requireAdmin(req);
  const b = await readJSON(req);
  return exit.autoDistribute(b.scope === 'unbound' ? 'unbound' : 'all');
});

// ---------- User self-service exit routing & subscription import ----------
route('POST', '/api/exits/test', (req) => { requireUser(req); return exit.triggerPublicDelayTest(); });
route('GET', '/api/exits', (req) => exit.getUserExits(requireUser(req).id));
route('POST', '/api/exits/bind', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  return exit.bindUserAccount(u.id, String(b.id || ''), String(b.nodeId || ''));
});
route('POST', '/api/exits/sub/preview', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  return exit.previewSubscription(u.id, String(b.url || ''));
});
route('POST', '/api/exits/sub/save', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  return exit.saveSubscriptionNodes(u.id, String(b.parseId || ''), Array.isArray(b.indices) ? b.indices : []);
});
route('POST', '/api/exits/node/:id/check', async (req, _res, p) => {
  const u = requireUser(req);
  return exit.checkUserNodePurity(u.id, Number(p.id));
});
route('POST', '/api/exits/proxy', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  return exit.addDirectProxy(u.id, String(b.name || ''), String(b.url || ''));
});
route('DELETE', '/api/exits/nodes/:id', (req, _res, p) => exit.deleteUserNode(requireUser(req).id, Number(p.id)));

// ---------- Argon 乐园 (游乐场) ----------
route('GET', '/api/fun', (req) => fun.overview(requireUser(req)));
route('POST', '/api/fun/claim', (req) => fun.claim(requireUser(req)));
route('POST', '/api/fun/borrow', async (req) => { const u = requireUser(req); return fun.borrow(u, Number((await readJSON(req))?.n)); });
route('POST', '/api/fun/repay', (req) => fun.repay(requireUser(req)));
route('POST', '/api/fun/inf', (req) => fun.toggleInf(requireUser(req)));
route('POST', '/api/fun/slots/boost', async (req) => fun.boostSlots(requireUser(req)));
route('POST', '/api/fun/slots', async (req) => { const u = requireUser(req); return fun.slots(u, Number((await readJSON(req))?.bet)); });
route('POST', '/api/fun/vip-redeem', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  return fun.redeemVip(u, Number(b?.count ?? 1));
});
route('POST', '/api/fun/g4a', async (req) => { const u = requireUser(req); return fun.g4a(u, (await readJSON(req))?.n); });
route('GET', '/api/fun/stream', (req, res) => { requireUser(req); fun.stream(req, res); });
route('POST', '/api/fun/lotto/buy', async (req) => { const u = requireUser(req); const b = await readJSON(req); return fun.lottoBuy(u, b?.nums, b?.sp, b?.mult ?? 1); });
route('POST', '/api/fun/lotto/draw', (req) => { requireAdmin(req); return fun.lottoDrawNow(); });
route('POST', '/api/fun/race', async (req) => { const u = requireUser(req); return fun.raceCreate(u, await readJSON(req)); });
route('GET', '/api/fun/race/:id', (req, _res, p) => fun.raceGet(requireUser(req).id, Number(p.id)));
route('POST', '/api/fun/race/:id/join', (req, _res, p) => fun.raceJoin(requireUser(req), Number(p.id)));
route('POST', '/api/fun/race/:id/dog', async (req, _res, p) => { const u = requireUser(req); return fun.raceDog(u, Number(p.id), (await readJSON(req))?.dog); });
route('POST', '/api/fun/race/:id/leave', (req, _res, p) => fun.raceLeave(requireUser(req), Number(p.id)));
route('POST', '/api/fun/race/:id/ready', (req, _res, p) => fun.raceReady(requireUser(req), Number(p.id)));

// ---------- Legacy credential export (read-only from CPA) ----------
route('POST', '/api/me/export-accounts', async (req, res) => {
  const u = requireUser(req);
  const b = req.headers['content-type']?.includes('json') ? await readJSON(req) : {};
  const rows = all('SELECT auth_id FROM accounts WHERE owner_id = ? ORDER BY created_at', u.id);
  if (!rows.length) throw new HttpError(404, 'no_old_accounts', '你名下没有可导出的旧凭证');
  const files: { name: string; data: Buffer }[] = [];
  let cpaErr = false;
  for (const row of rows) {
    try {
      const safeName = basename(String(row.auth_id || ''));
      if (!safeName || safeName === '.' || safeName === '..' || !safeName.endsWith('.json')) continue;
      const fp = join('/cpa-auths', safeName);
      const j = existsSync(fp) && lstatSync(fp).isFile() ? JSON.parse(readFileSync(fp, 'utf8')) : await cpa.downloadCredential(safeName);
      if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
      delete j.proxy_url; delete j.disabled; delete j.priority; delete j.prefix; delete j.base_url; delete j.headers;
      files.push({ name: safeName, data: Buffer.from(JSON.stringify(j, null, 2)) });
    } catch { cpaErr = true; }
  }
  if (!files.length) {
    if (cpaErr) throw new HttpError(503, 'cpa_unreachable', '当前环境未连接旧凭证库，搬回正式站后即可一键导出');
    throw new HttpError(404, 'no_old_accounts', '未找到可导出的凭证文件');
  }
  const day = new Date().toISOString().slice(0, 10);
  const zip = b?.format === 'zip' || (b?.format !== 'json' && files.length > 1);
  const out = zip ? writeZip(files) : files.length === 1 ? files[0].data : Buffer.from(JSON.stringify(files.map((f) => JSON.parse(f.data.toString())), null, 2));
  const fname = zip ? `xgf-credentials-${day}.zip` : files.length === 1 ? files[0].name : `xgf-credentials-${day}.json`;
  res.writeHead(200, {
    'Content-Type': zip ? 'application/zip' : 'application/json',
    'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.@+-]/g, '_')}"`,
    'Content-Length': out.length,
    'Cache-Control': 'no-store',
  });
  res.end(out);
});
