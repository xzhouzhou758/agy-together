// The gateway: portal key -> AI Studio 2 relay, streaming-safe.
import { estimateInput, wan } from './inputsize.ts';
import https from 'node:https';
import http, { type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { config } from './config.ts';
import { isVipAccount } from './exit.ts';
import { one, run, now } from './db.ts';
import { sha256, readBody, HttpError } from './util.ts';
import { sessionKey, userMode, newSalt } from './routing.ts';
import { sendGatewayError, type Why } from './reason.ts';
import { usageSniffer, type Tok } from './upstream.ts';
import { aistudio2On, allowFor as aistudio2AllowFor, notifyAuthSuspect, NOT_ELIGIBLE_2, type AllowedAcc } from './aistudio2.ts';

const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'cookie', 'authorization', 'x-api-key', 'x-goog-api-key', 'x-real-ip', 'forwarded']);

export function forwardHeaders(h: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (v === undefined || HOP.has(lk) || lk.startsWith('x-agy') || lk.startsWith('x-forwarded-') || lk === config.allowHeader.toLowerCase()) continue;
    out[lk] = v;
  }
  return out;
}

function clientKey(req: IncomingMessage, url: URL): string {
  const a = req.headers.authorization;
  if (a && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'] || req.headers['x-goog-api-key'];
  if (typeof x === 'string' && x) return x.trim();
  return (url.searchParams.get('key') || '').trim();
}

function modelFrom(path: string, body: Buffer, ct: string | undefined): { model: string; stream: boolean; json: any } {
  let model = '', stream = false, json: any = null;
  const m = /\/models\/([^/:]+)(?::(\w+))?/.exec(path);
  if (m) {
    model = decodeURIComponent(m[1]);
    if (m[2] && /stream/i.test(m[2])) stream = true;
  }
  if (body.length && (!ct || ct.includes('json'))) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      json = j;
      if (typeof j?.model === 'string') model = j.model;
      if (j?.stream === true) stream = true;
    } catch {}
  }
  return { model: model.slice(0, 120), stream, json };
}

type Ctx = { userId: number; keyId: number; pool: 'private' | 'shared' | 'aistudio2'; model: string; upstreamModel?: string | null; effort?: string | null; path: string; stream: boolean; start: number; ttfb?: number | null; inEst?: number | null };

type Extra = { authId: string | null; ownerId: number | null; tok: Tok };
function record(c: Ctx, f: { status: number; result: string; authId?: string | null; requestId?: string | null; reason?: string | null; x?: Extra }) {
  const authId = f.x ? f.x.authId : f.authId || null;
  const owner = f.x ? f.x.ownerId : null;
  const t = f.x?.tok, has = !!t && (t.in || t.out);
  run(`INSERT INTO usage(ts, user_id, key_id, pool, auth_id, owner_id, model, requested_model, upstream_model, reasoning_effort, path, status, result, reason, latency_ms, stream, request_id, ttfb_ms,
       in_tok, out_tok, reasoning_tok, cache_tok, cache_write_tok, total_tok, in_est)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.start, c.userId, c.keyId, c.pool, authId, owner, c.upstreamModel || c.model, c.model || null, c.upstreamModel || null, c.effort || null, c.path.slice(0, 120), f.status, f.result, f.reason ? f.reason.slice(0, 200) : null,
    now() - c.start, c.stream ? 1 : 0, f.requestId || null, c.ttfb ?? null,
    has ? t!.in : null, has ? t!.out : null, has ? t!.think : null, has ? t!.cache : null, has ? t!.cacheWrite : null, has ? (t!.total || t!.in + t!.out) : null, c.inEst ?? null);
}

function userInputCap(ctx: Ctx): Why | null {
  const cap = Number(one('SELECT input_limit FROM users WHERE id = ?', ctx.userId)?.input_limit || 0);
  const est = ctx.inEst || 0;
  if (cap > 0 && est > cap) {
    return { status: 400, result: 'input_limit',
      message: `输入过限：这次输入约 ${wan(est)} Token，超过了你设置的上限 ${wan(cap)}。请检查上下文是不是爆了；确实需要的话到「个人中心」调高或关闭上限` };
  }
  return null;
}

export function userRotation(userId: number): { mode: string; salt: string } {
  const u = one('SELECT rotation_mode, session_salt FROM users WHERE id = ?', userId);
  let salt = u?.session_salt as string | null;
  if (!salt) {
    salt = newSalt();
    run('UPDATE users SET session_salt = ? WHERE id = ?', salt, userId);
  }
  return { mode: userMode(u?.rotation_mode), salt };
}

export function errMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = (Array.isArray(j) ? j[0] : j)?.error;
    const m = typeof e === 'string' ? e : e?.message;
    if (m) return String(m).replace(/\s+/g, ' ').slice(0, 200);
  } catch {}
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

const RESP_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'x-cpa-trace-id']);

export async function handleGateway(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return res.end();
  }
  const P = url.pathname;
  const fail = (status: number, code: string, message: string, retryAfter?: number) => sendGatewayError(res, P, status, code, message, retryAfter);
  const raw = clientKey(req, url);
  if (!raw) return fail(401, 'invalid_api_key', '缺少 API Key');
  const key = one(`SELECT k.*, u.active AS user_active FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.revoked_at IS NULL`, sha256(raw));
  if (!key || !key.user_active) return fail(401, 'invalid_api_key', 'API Key 无效或已撤销');
  const pool = key.pool as 'private' | 'shared' | 'aistudio2';
  if (pool !== 'aistudio2') return fail(403, 'pool_retired', '大小锅饭已下线，请在门户新建 AI Studio Key');

  let body: Buffer;
  try {
    body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, config.maxBodyBytes);
  } catch (e) {
    return fail(e instanceof HttpError ? e.status : 400, 'invalid_request', e instanceof HttpError && e.status === 413 ? '请求体太大' : '无法读取请求体');
  }
  const { model, stream, json } = modelFrom(P, body, req.headers['content-type']);
  const ctx: Ctx = { userId: key.user_id, keyId: key.id, pool, model, path: P, stream, start: now(), inEst: method === 'POST' && json ? estimateInput(json) : null };
  const isGen = method === 'POST';
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), key.id);
  const refuse = (w: Why, code: string) => {
    if (isGen) record(ctx, { status: w.status, result: w.result, reason: w.message });
    fail(w.status, code, w.message, w.retryAfter);
  };

  if (pool === 'aistudio2') return goAIStudio2(req, res, method, url, body, json, ctx, refuse);
  return fail(403, 'pool_retired', '大小锅饭已下线，请在门户新建 AI Studio Key');
}

setInterval(() => {
  if (ais2SessionLast.size > 5000) ais2SessionLast.clear();
}, 60000).unref();

/** Mutates j; true when something changed. */
function thinkingFix(j: any): boolean {
  const m = String(j.model || '').replace(/^models\//, '');
  const suffix = m.match(/-(high|medium|low|minimal)$/i)?.[1].toLowerCase();
  const noMinimal = !/flash/i.test(m);
  let changed = false;
  const fix = (o: any, k: string) => {
    if (!o || typeof o !== 'object' || typeof o[k] !== 'string') return;
    let v = suffix || o[k];
    if (noMinimal && v.trim().toLowerCase() === 'minimal') v = 'low';
    if (v !== o[k]) { o[k] = v; changed = true; }
  };
  for (const o of [j, j.extra_body]) {
    if (!o || typeof o !== 'object') continue;
    fix(o, 'reasoning_effort'); fix(o, 'reasoningEffort'); fix(o.reasoning, 'effort');
    for (const c of [o.thinking_config, o.thinkingConfig, o.google?.thinking_config]) { fix(c, 'thinking_level'); fix(c, 'thinkingLevel'); }
  }
  return changed;
}
const AIS_DROP = (k: string) => k.startsWith('x-relay-') || k === 'x-google-cookies' || k === 'x-goog-authuser' || k === 'x-aistudio-g1-tier';

// ---------- AI Studio 2 (Mag1cFall/AIStudio2API) ----------
const AIS2_TIER_EXPAND = new Set(['gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']);
const AIS2_TIER_ORDER: Array<[string, string]> = [
  ['extra_high', 'xhigh'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
  ['minimal', 'minimal'],
];

export function parseAIS2ModelTier(rawModel: string): { baseModel: string; suffix: string; apiEffort: string } | null {
  const trimmed = rawModel.trim();
  const hasPrefix = /^models\//i.test(trimmed);
  const clean = trimmed.replace(/^models\//i, '');
  // Match either <base>-<tier> or <base>-<tier>-search
  const m = /^((?:gemini|gemma)-[a-z0-9._-]+?)-(minimal|low|medium|high|xhigh|extra_high|extra-high|max)(-search)?$/i.exec(clean);
  if (!m) return null;
  const rawTier = m[2].toLowerCase();
  const suffix = rawTier === 'extra_high' || rawTier === 'extra-high' || rawTier === 'max' ? 'xhigh' : rawTier;
  const apiEffort = suffix; // AIStudio2API natively accepts minimal | low | medium | high | xhigh
  const baseClean = m[1] + (m[3] ? '-search' : '');
  return {
    baseModel: hasPrefix ? 'models/' + baseClean : baseClean,
    suffix,
    apiEffort,
  };
}

export function isAIS2SlimModel(rawId: string): boolean {
  const id = rawId.replace(/^models\//i, '').toLowerCase();
  if (!id.startsWith('gemini-')) return false;
  if (/-(search|build|tts|live|latest)(-|$)/.test(id)) return false;
  if (/(transcribe|translate|robotics|decision|omni|extended-thinking)/.test(id)) return false;
  return true;
}

export function expandAIS2ModelList(bodyText: string, slim = false): string {
  let j: any;
  try { j = JSON.parse(bodyText); } catch { return bodyText; }
  if (!j || typeof j !== 'object') return bodyText;

  if (Array.isArray(j.data)) {
    const src = slim ? j.data.filter((m: any) => isAIS2SlimModel(String(m?.id || ''))) : j.data;
    const have = new Set(src.map((m: any) => String(m?.id || '')));
    const out: any[] = [];
    for (const item of src) {
      out.push(item);
      const id = String(item?.id || '');
      if (!AIS2_TIER_EXPAND.has(id)) continue;
      const rawLevels: string[] = Array.isArray(item.thinking_levels) && item.thinking_levels.length
        ? item.thinking_levels.map((x: unknown) => String(x).toLowerCase())
        : id === 'gemini-4-hydrogen' ? ['low', 'medium', 'high', 'extra_high'] : ['low', 'medium', 'high'];
      const lvlSet = new Set(rawLevels);
      for (const [rawLvl, suf] of AIS2_TIER_ORDER) {
        if (!lvlSet.has(rawLvl)) continue;
        const vid = `${id}-${suf}`;
        if (have.has(vid)) continue;
        have.add(vid);
        const clone = { ...item, id: vid, default_thinking_level: rawLvl };
        if (typeof clone.name === 'string' && clone.name) clone.name = `${clone.name} (${suf.toUpperCase()})`;
        out.push(clone);
      }
    }
    j.data = out;
    if ('first_id' in j) j.first_id = j.data?.[0]?.id ?? null;
    if ('last_id' in j) j.last_id = j.data?.length ? j.data[j.data.length - 1].id : null;
    return JSON.stringify(j);
  }

  if (Array.isArray(j.models)) {
    const src = slim ? j.models.filter((m: any) => isAIS2SlimModel(String(m?.name || ''))) : j.models;
    const have = new Set(src.map((m: any) => String(m?.name || '')));
    const out: any[] = [];
    for (const item of src) {
      out.push(item);
      const id = String(item?.name || '').replace(/^models\//, '');
      if (!AIS2_TIER_EXPAND.has(id)) continue;
      const rawLevels: string[] = Array.isArray(item.thinkingLevels) && item.thinkingLevels.length
        ? item.thinkingLevels.map((x: unknown) => String(x).toLowerCase())
        : id === 'gemini-4-hydrogen' ? ['low', 'medium', 'high', 'extra_high'] : ['low', 'medium', 'high'];
      const lvlSet = new Set(rawLevels);
      for (const [rawLvl, suf] of AIS2_TIER_ORDER) {
        if (!lvlSet.has(rawLvl)) continue;
        const vname = `models/${id}-${suf}`;
        if (have.has(vname)) continue;
        have.add(vname);
        const clone = { ...item, name: vname, defaultThinkingLevel: rawLvl.toUpperCase() };
        if (typeof clone.displayName === 'string' && clone.displayName) clone.displayName = `${clone.displayName} (${suf.toUpperCase()})`;
        out.push(clone);
      }
    }
    j.models = out;
    return JSON.stringify(j);
  }

  return bodyText;
}

export function rewriteAIS2TierRequest(P: string, body: Buffer, ct: string, parsedJson?: any): { upstreamPath: string; body: Buffer; baseModel?: string; effort?: string; requestedSingleId?: string } {
  // 1. Single model GET: /v1/models/<id> or /v1beta/models/<id> (no :action)
  const gm = /^(\/v1(?:beta)?\/models\/)([^/:]+)$/.exec(P);
  if (gm) {
    const rawId = decodeURIComponent(gm[2]);
    const parsed = parseAIS2ModelTier(rawId);
    if (parsed) {
      return { upstreamPath: gm[1] + encodeURIComponent(parsed.baseModel.replace(/^models\//i, '')), body, baseModel: parsed.baseModel, effort: parsed.apiEffort, requestedSingleId: rawId };
    }
    return { upstreamPath: P, body };
  }

  // 2. Gemini native POST: /v1beta/models/<id>:<action>
  const bm = /^(\/v1beta\/models\/)([^/:]+)(:\w+)$/.exec(P);
  if (bm) {
    const rawId = decodeURIComponent(bm[2]);
    const parsed = parseAIS2ModelTier(rawId);
    let nextPath = P;
    let nextBody = body;
    if (parsed) {
      nextPath = bm[1] + encodeURIComponent(parsed.baseModel.replace(/^models\//i, '')) + bm[3];
      if (body.length && (!ct || ct.includes('json')) && !/:countTokens$/i.test(bm[3])) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            j.generationConfig = j.generationConfig && typeof j.generationConfig === 'object' ? j.generationConfig : {};
            j.generationConfig.thinkingConfig = j.generationConfig.thinkingConfig && typeof j.generationConfig.thinkingConfig === 'object'
              ? j.generationConfig.thinkingConfig : {};
            j.generationConfig.thinkingConfig.thinkingLevel = parsed.apiEffort;
            nextBody = Buffer.from(JSON.stringify(j));
          }
        } catch {}
      }
      return { upstreamPath: nextPath, body: nextBody, baseModel: parsed.baseModel, effort: parsed.apiEffort };
    }
    return { upstreamPath: P, body };
  }

  // 3. JSON body endpoints (/v1/chat/completions, /v1/messages, /v1/responses, etc.)
  if (!body.length || (ct && !ct.includes('json'))) return { upstreamPath: P, body };
  let j: any = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson) ? structuredClone(parsedJson) : null;
  if (!j) { try { j = JSON.parse(body.toString('utf8')); } catch { return { upstreamPath: P, body }; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { upstreamPath: P, body };

  let changed = false;
  if ('cookies' in j) { delete j.cookies; changed = true; }

  const rawModel = typeof j.model === 'string' ? j.model : '';
  const parsed = rawModel ? parseAIS2ModelTier(rawModel) : null;
  if (parsed) {
    j.model = parsed.baseModel;
    changed = true;
    const eff = parsed.apiEffort;
    if (P === '/v1/chat/completions') {
      j.reasoning_effort = eff;
      if (j.stream === true && (!j.stream_options || typeof j.stream_options !== 'object' || Array.isArray(j.stream_options) || j.stream_options.include_usage !== true)) {
        j.stream_options = { ...(j.stream_options && typeof j.stream_options === 'object' && !Array.isArray(j.stream_options) ? j.stream_options : {}), include_usage: true };
      }
      if (j.reasoning && typeof j.reasoning === 'object') j.reasoning.effort = eff;
      if (j.extra_body && typeof j.extra_body === 'object') {
        if ('reasoning_effort' in j.extra_body) j.extra_body.reasoning_effort = eff;
        if (j.extra_body.reasoning && typeof j.extra_body.reasoning === 'object') j.extra_body.reasoning.effort = eff;
        for (const c of [j.extra_body.thinking_config, j.extra_body.thinkingConfig, j.extra_body.google?.thinking_config]) {
          if (c && typeof c === 'object') {
            if ('thinking_level' in c || !('thinkingLevel' in c)) c.thinking_level = eff;
            if ('thinkingLevel' in c) c.thinkingLevel = eff;
          }
        }
      }
    } else if (P === '/v1/messages') {
      j.output_config = { ...(j.output_config && typeof j.output_config === 'object' ? j.output_config : {}), effort: eff };
      if (j.thinking?.type === 'disabled') delete j.thinking;
    } else if (P === '/v1/messages/count_tokens') {
      // count_tokens only rewrites model name
    } else if (P === '/v1/responses') {
      j.reasoning = { ...(j.reasoning && typeof j.reasoning === 'object' ? j.reasoning : {}), effort: eff };
      if (Array.isArray(j.input)) {
        for (const it of j.input) {
          if (it && typeof it === 'object' && it.type === 'configuration_update' && it.reasoning && typeof it.reasoning === 'object') {
            it.reasoning.effort = eff;
          }
        }
      }
    }
    return {
      upstreamPath: P,
      body: Buffer.from(JSON.stringify(j)),
      baseModel: parsed.baseModel.replace(/^models\//i, ''),
      effort: eff,
    };
  }

  if (P === '/v1/chat/completions') {
    if (thinkingFix(j)) changed = true;
    if (j.stream === true && (!j.stream_options || typeof j.stream_options !== 'object' || Array.isArray(j.stream_options) || j.stream_options.include_usage !== true)) {
      j.stream_options = { ...(j.stream_options && typeof j.stream_options === 'object' && !Array.isArray(j.stream_options) ? j.stream_options : {}), include_usage: true };
      changed = true;
    }
  }
  const explicitEff = typeof j.reasoning_effort === 'string' ? j.reasoning_effort
    : typeof j.reasoning?.effort === 'string' ? j.reasoning.effort
    : typeof j.output_config?.effort === 'string' ? j.output_config.effort
    : typeof j.extra_body?.google?.thinking_config?.thinking_level === 'string' ? j.extra_body.google.thinking_config.thinking_level
    : undefined;
  return {
    upstreamPath: P,
    body: changed ? Buffer.from(JSON.stringify(j)) : body,
    effort: explicitEff ? explicitEff.toLowerCase().slice(0, 20) : undefined,
  };
}

let ais2Rr = 0;
const ais2DownUntil = new Map<string, number>();
const ais2SessionLast = new Map<string, string>();
const markAIS2Down = (id: string, ms: number) => ais2DownUntil.set(id, now() + ms);
const isAIS2Down = (id: string) => (ais2DownUntil.get(id) || 0) > now();

function orderAIS2Accounts(owners: Map<string, AllowedAcc>, ctx: Ctx, headers: IncomingHttpHeaders, json: any): { ordered: AllowedAcc[]; mode: string; sk?: string } {
  const allAccs = [...owners.values()];
  if (!allAccs.length) return { ordered: [], mode: 'balance' };
  const idx = (ais2Rr = (ais2Rr + 1) >>> 0) % allAccs.length;
  const rotated = [...allAccs.slice(idx), ...allAccs.slice(0, idx)];
  const healthy = rotated.filter((a) => !isAIS2Down(a.id));
  const cooling = rotated.filter((a) => isAIS2Down(a.id));
  const ordered = [...healthy, ...cooling];
  const rot = userRotation(ctx.userId);
  const sk = rot.mode !== 'performance'
    ? sessionKey({ keyId: ctx.keyId, model: ctx.upstreamModel || ctx.model, headers, body: json, salt: rot.salt })?.key
    : undefined;
  if (sk) {
    const prev = ais2SessionLast.get(sk);
    if (prev) {
      const hi = healthy.findIndex((a) => a.id === prev);
      if (hi > 0) {
        const [picked] = ordered.splice(ordered.findIndex((a) => a.id === prev), 1);
        ordered.unshift(picked);
      }
    }
  }
  return { ordered, mode: rot.mode, sk };
}

function goAIStudio2(req: IncomingMessage, res: ServerResponse, method: string, url: URL, body: Buffer, json: any, ctx: Ctx, refuse: (w: Why, code: string) => void) {
  const P = url.pathname;
  const list = method === 'GET' && (P === '/v1/models' || P.startsWith('/v1/models/') || P === '/v1beta/models' || P.startsWith('/v1beta/models/'));
  const count = method === 'POST' && (P === '/v1/messages/count_tokens' || /^\/v1beta\/models\/[^/]+:countTokens$/i.test(P));
  const gen = method === 'POST' && !count && (
    P === '/v1/chat/completions' ||
    P === '/v1/messages' ||
    P === '/v1/responses' ||
    P === '/v1/images/generations' ||
    P === '/v1/images/edits' ||
    /^\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/i.test(P)
  );
  if (!list && !count && !gen) {
    return sendGatewayError(res, P, 404, 'unsupported_endpoint', 'AI Studio（新后端）不支持该接口路径');
  }
  if (!aistudio2On()) {
    if (gen) record(ctx, { status: 503, result: 'blocked', reason: 'AI Studio（新后端）池未开启' });
    return sendGatewayError(res, P, 503, 'aistudio_disabled', 'AI Studio（新后端）池未开启');
  }
  const { access, owners } = aistudio2AllowFor(ctx.userId);
  if (access === 'none' || !owners.size) {
    if (gen) record(ctx, { status: 403, result: 'no_account', reason: NOT_ELIGIBLE_2 });
    return sendGatewayError(res, P, 403, 'no_available_account', NOT_ELIGIBLE_2);
  }
  if (gen) {
    if (!ctx.model && P.startsWith('/v1/images/')) ctx.model = 'gemini-image';
    const w = userInputCap(ctx);
    if (w) return refuse(w, 'input_limit_exceeded');
  }

  const ct = String(req.headers['content-type'] || '');
  const rw = rewriteAIS2TierRequest(P, body, ct, json);
  body = rw.body;
  json = null;
  if (rw.baseModel) ctx.upstreamModel = rw.baseModel;
  if (rw.effort) ctx.effort = rw.effort;

  const sp = new URLSearchParams(url.search);
  sp.delete('key');
  const qs = sp.toString() ? '?' + sp.toString() : '';

  const baseHeaders = forwardHeaders(req.headers);
  for (const k of Object.keys(baseHeaders)) {
    if (AIS_DROP(k) || k === 'x-aistudio-account' || k.startsWith('x-aistudio-')) delete baseHeaders[k];
  }
  baseHeaders['authorization'] = 'Bearer ' + config.aistudio2Key;
  baseHeaders['x-api-key'] = config.aistudio2Key;
  baseHeaders['x-goog-api-key'] = config.aistudio2Key;
  if (body.length) baseHeaders['content-length'] = String(body.length);

  const t = new URL(config.aistudio2URL);
  const tls = t.protocol === 'https:';
  const reqBase = t.pathname.replace(/\/+$/, '') + rw.upstreamPath + qs;

  // Model listing / single-model lookup: expand Argon / Hydrogen / 3.8 tier variants.
  if (list) {
    const up = (tls ? https : http).request({ host: t.hostname, port: t.port || (tls ? 443 : 80), method, path: reqBase, headers: baseHeaders });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.setTimeout(config.upstreamTimeoutMs || 300000, () => up.destroy(new Error('upstream_timeout')));
    up.on('error', () => { if (!res.headersSent) sendGatewayError(res, P, 502, 'upstream_error', 'AI Studio（新后端）不可达'); else res.destroy(); });
    up.on('response', (ur) => {
      const status = ur.statusCode || 502;
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        const lk = k.toLowerCase();
        if (v !== undefined && !RESP_DROP.has(lk) && lk !== 'content-length' && !lk.startsWith('x-aistudio-')) out[k] = v;
      }
      const chunks: Buffer[] = [];
      ur.on('data', (c: Buffer) => chunks.push(c));
      ur.on('end', () => {
        let rawBuf = Buffer.concat(chunks);
        if (status === 200) {
          const text = rawBuf.toString('utf8');
          if (rw.requestedSingleId) {
            try {
              const mj = JSON.parse(text);
              if (mj && typeof mj === 'object') {
                if ('id' in mj) mj.id = rw.requestedSingleId;
                else if ('name' in mj) mj.name = 'models/' + rw.requestedSingleId.replace(/^models\//i, '');
                rawBuf = Buffer.from(JSON.stringify(mj));
              }
            } catch {}
          } else {
            const urow = one('SELECT ais2_slim, ais2_models FROM users WHERE id = ?', ctx.userId);
            const slim = (urow?.ais2_slim ?? 1) !== 0;
            let picks: string[] | null = null;
            if (urow?.ais2_models) { try { const arr = JSON.parse(String(urow.ais2_models)); if (Array.isArray(arr) && arr.length) picks = arr; } catch {} }
            const expanded = expandAIS2ModelList(text, picks ? false : slim);
            rawBuf = Buffer.from(filterAIS2ModelsByPick(expanded, picks));
          }
        }
        out['content-length'] = String(rawBuf.length);
        if (ctx.stream && !out['x-accel-buffering']) out['x-accel-buffering'] = 'no';
      res.writeHead(status, out);
        res.end(rawBuf);
      });
      ur.on('error', () => res.destroy());
    });
    up.end();
    return;
  }

  const { ordered, mode, sk } = orderAIS2Accounts(owners, ctx, req.headers, json);
  const maxAttempts = Math.min(ordered.length, 3);
  let finished = false;
  let clientClosed = false;
  let activeUp: http.ClientRequest | null = null;

  const finish = (status: number, result: string, cand: AllowedAcc | null, tok: Tok, reason?: string | null) => {
    if (finished) return;
    finished = true;
    if (gen) {
      record(ctx, {
        status,
        result,
        reason,
        x: { authId: cand ? cand.id : null, ownerId: cand ? cand.ownerId : null, tok },
      });
    }
  };

  let activeRefundVip: (() => void) | null = null;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      if (!res.headersSent) activeRefundVip?.();
      activeUp?.destroy();
      finish(499, 'client', null, { in: 0, out: 0, think: 0, cache: 0, cacheWrite: 0 }, '客户端断开');
    }
  });

  const tryAttempt = (attempt: number) => {
    if (finished || clientClosed) return;
    const cand = ordered[attempt];
    const usesVip = gen && isVipAccount(cand.email);
    let vipCharged = false;
    const refundVip = () => {
      if (vipCharged) {
        vipCharged = false;
        run('UPDATE users SET vip_quota = COALESCE(vip_quota, 0) + 1 WHERE id = ?', ctx.userId);
      }
    };
    activeRefundVip = refundVip;
    if (usesVip) {
      const r = run('UPDATE users SET vip_quota = vip_quota - 1 WHERE id = ? AND COALESCE(vip_quota, 0) > 0', ctx.userId);
      if (!r.changes) {
        if (attempt + 1 < maxAttempts) { tryAttempt(attempt + 1); return; }
        refuse({ status: 402, result: 'quota', message: 'VIP 节点次数已用完，请前往游乐场用 20 🦴 兑换，或在 AI Studio 切换普通节点' }, 'vip_quota_empty');
        return;
      }
      vipCharged = true;
    }
    const headers = { ...baseHeaders, 'x-aistudio-account': cand.email };
    const up = (tls ? https : http).request({
      host: t.hostname,
      port: t.port || (tls ? 443 : 80),
      method,
      path: reqBase,
      headers,
    });
    activeUp = up;
    up.setTimeout(config.upstreamTimeoutMs, () => {
      up.destroy(new Error('upstream_timeout'));
    });

    up.on('error', () => {
      refundVip();
      if (finished || activeUp !== up) return;
      if (!res.headersSent) sendGatewayError(res, P, 502, 'upstream_error', 'AI Studio（新后端）不可达');
      else res.destroy();
      finish(502, 'upstream', cand, { in: 0, out: 0, think: 0, cache: 0, cacheWrite: 0 }, 'AI Studio（新后端）不可达');
    });

    up.on('response', (ur) => {
      let sn: ReturnType<typeof usageSniffer> | null = null;
      const status = ur.statusCode || 502;
      ur.on('error', () => {
        if (!(status < 300 && res.headersSent)) refundVip();
        if (activeUp !== up || finished) return;
        res.destroy();
        finish(502, 'upstream', cand, sn ? sn.done() : { in: 0, out: 0, think: 0, cache: 0, cacheWrite: 0 }, 'AI Studio（新后端）连接中断');
      });
      if (finished || clientClosed || activeUp !== up) {
        refundVip();
        ur.destroy();
        return;
      }
      const tHead = now() - ctx.start;
      const retryable = status === 429 || status === 401 || status === 403 || status === 500 || status === 502 || status === 503 || status === 504;

      if (gen && (status === 401 || status === 403)) {
        markAIS2Down(cand.id, 60000);
        notifyAuthSuspect(cand.id);
      } else if (gen && (status === 429 || status >= 500)) {
        markAIS2Down(cand.id, 20000);
      }

      if (retryable && attempt + 1 < maxAttempts && !clientClosed && !res.headersSent) {
        refundVip();
        ur.resume();
        tryAttempt(attempt + 1);
        return;
      }

      if (gen && status < 300 && sk) {
        if (mode === 'balance' || !ais2SessionLast.has(sk)) ais2SessionLast.set(sk, cand.id);
      }

      sn = usageSniffer();
      const errBuf: Buffer[] = [];
      let errSize = 0;
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        const lk = k.toLowerCase();
        if (v !== undefined && !RESP_DROP.has(lk) && !lk.startsWith('x-relay-') && !lk.startsWith('x-aistudio-')) out[k] = v;
      }
      res.writeHead(status, out);
      ur.once('data', () => { ctx.ttfb ??= now() - ctx.start; if (status < 300) vipCharged = false; });
      body = Buffer.alloc(0);
      ur.on('data', (c: Buffer) => {
        if (status < 300) sn!.feed(c);
        else if (errSize < 65536) { errBuf.push(c); errSize += c.length; }
      });
      ur.pipe(res);
      ur.on('end', () => {
        ctx.ttfb ??= tHead;
        if (status < 300) { vipCharged = false; return finish(status, 'ok', cand, sn!.done()); }
        refundVip();
        finish(
          status,
          status === 429 ? 'quota' : status < 500 ? 'client' : 'upstream',
          cand,
          sn!.done(),
          `AI Studio（新后端）返回 ${status}：${errMessage(Buffer.concat(errBuf).toString('utf8'))}`
        );
      });
    });

    up.end(body);
  };

  tryAttempt(0);
}

export const recentAllowed = new Map<string, { allowed: Set<string>; ts: number }>();
export function parseTrace(_v: string | string[] | undefined): { index: string; requestId: string } | null { return null; }
export function alarm(_kind: string, _detail: Record<string, unknown>, _trip: boolean) {}
export function accountInflight(_id: string): number { return 0; }
export function accountRpmUsed(_id: string, _t = now()): number { return 0; }
export function accountBusy(_id: string, _rules?: unknown, _t = now()): boolean { return false; }
export function accountWaitSeconds(_ids: string[], _rules?: unknown, _t = now()): number { return 1; }
export function bannedPreset(_body: Buffer): boolean { return false; }

export function filterAIS2ModelsByPick(bodyText: string, picks: string[] | null | undefined): string {
  if (!picks || !picks.length) return bodyText;
  const allow = new Set(picks.map((x) => x.replace(/^models\//i, '')));
  try {
    const j = JSON.parse(bodyText);
    if (Array.isArray(j?.data)) {
      j.data = j.data.filter((m: any) => allow.has(String(m?.id || '').replace(/^models\//i, '')));
      if ('first_id' in j) j.first_id = j.data?.[0]?.id ?? null;
      if ('last_id' in j) j.last_id = j.data?.length ? j.data[j.data.length - 1].id : null;
      return JSON.stringify(j);
    }
    if (Array.isArray(j?.models)) {
      j.models = j.models.filter((m: any) => allow.has(String(m?.name || '').replace(/^models\//i, '')));
      return JSON.stringify(j);
    }
  } catch {}
  return bodyText;
}

export async function fetchAIS2ModelIds(): Promise<string[]> {
  if (!aistudio2On()) return [];
  const r = await fetch(config.aistudio2URL.replace(/\/+$/, '') + '/v1/models', {
    headers: { Authorization: 'Bearer ' + config.aistudio2Key, 'x-api-key': config.aistudio2Key },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('上游模型列表不可达');
  const expanded = expandAIS2ModelList(await r.text(), false);
  const j = JSON.parse(expanded);
  const arr = Array.isArray(j?.data) ? j.data : [];
  return arr.map((m: any) => String(m?.id || '')).filter(Boolean);
}
