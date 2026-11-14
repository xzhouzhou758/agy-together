// The gateway: portal key -> allowed CPA auth IDs -> X-Agy-Allow -> CPA, streaming-safe,
// with a post-pick check of X-CPA-TRACE-ID and a circuit breaker.
import { estimateInput, wan } from './inputsize.ts';
import https from 'node:https';
import http, { type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { config } from './config.ts';
import { one, all, run, now, getRules, getSetting, setSetting } from './db.ts';
import { sha256, readBody, HttpError } from './util.ts';
import * as cpa from './cpa.ts';
import { belowReserve } from './quota.ts';
import { sessionKey, userMode, newSalt } from './routing.ts';
import { explainUnavailable, sendGatewayError, type Why, type UpBusy } from './reason.ts';
import { dailyFor, secondsToMidnight, sharedModels, sharedAllows } from './limits.ts';
import { upstreamsFor, upstreamRequest, usageSniffer, upAuthId, enabledUpstreams, openModels, upUsableCreds, upPluginHealthy, upAuthIdForIndex, type Upstream, type Tok } from './upstream.ts';
import { wakeFor } from './autosleep.ts';
import { sfKind, sfRelay, sfModelIds } from './sf.ts';
import { aistudioOn, allowFor as aistudioAllowFor, NOT_ELIGIBLE } from './aistudio.ts';


// ---------- 大锅饭: presets that are refused outright ----------
// 「昆仑 IDE」预设 dresses content up as IDE files to slip past moderation; Google then hangs on it for minutes,
// tying up shared accounts. The Discord bot's own prompts quote the ban (with this marker), so they pass.
const BOT_MARKER = '===== 数据（用户名都是站内昵称，可以直接说）=====';
const KUNLUN = [/huatu[\\/]+Project_Workspace[\\/]+Novel_Engine/, /LOCAL_WINDOWS_HOST_DAEMON/, /【ToolCall引导】/];
export function bannedPreset(body: Buffer): boolean {
  if (!body.length) return false;
  const t = body.toString('utf8');
  return !t.includes(BOT_MARKER) && KUNLUN.some((re) => re.test(t));
}
const KUNLUN_MSG = '大锅饭已禁用「昆仑 IDE」预设：它把内容伪装成 IDE 文件绕过审核，谷歌会长时间不响应，拖垮号池并导致大家 502。请换用其他预设后再试。';

// ---------- live counters ----------
const keyInflight = new Map<number, number>();
const accInflight = new Map<string, number>();
const keyWindow = new Map<number, number[]>();
const accWindow = new Map<string, number[]>();
const lastPrePicked = new Map<string, number>();
const sessionLastAuth = new Map<string, string>();
let pickSeq = 0;
const nextPickTick = () => now() + ((++pickSeq) % 1000) / 1000;

const inc = <K>(m: Map<K, number>, k: K, d: number) => {
  const v = (m.get(k) || 0) + d;
  if (v <= 0) m.delete(k);
  else m.set(k, v);
};
export function accountInflight(id: string): number {
  return accInflight.get(id) || 0;
}
export function accountRpmUsed(id: string, t = now()): number {
  const w = accWindow.get(id);
  if (!w || !w.length) return 0;
  const cut = t - 60000;
  let n = 0;
  for (const ts of w) if (ts > cut) n++;
  return n;
}
export function accountBusy(id: string, rules = getRules(), t = now()): boolean {
  return (rules.accConc > 0 && accountInflight(id) >= rules.accConc) || (rules.accRpm > 0 && accountRpmUsed(id, t) >= rules.accRpm);
}
export function accountWaitSeconds(ids: string[], rules = getRules(), t = now()): number {
  if (!ids.length) return 5;
  const cut = t - 60000;
  let minWait = Infinity;
  for (const id of ids) {
    const live = (accWindow.get(id) || []).filter((ts) => ts > cut).sort((a, b) => a - b);
    const concFull = rules.accConc > 0 && accountInflight(id) >= rules.accConc;
    const rpmFull = rules.accRpm > 0 && live.length >= rules.accRpm;
    if (concFull && !rpmFull) return 3;
    if (rpmFull) {
      const idx = live.length - rules.accRpm;
      const w = Math.max(1, Math.ceil((live[idx] + 60000 - t) / 1000));
      if (w < minWait) minWait = w;
    }
  }
  return Number.isFinite(minWait) ? minWait : 5;
}

type AccountHold = { settle: (actualKey: string) => void; abort: () => void; release: () => void };
const NOOP_HOLD: AccountHold = { settle() {}, abort() {}, release() {} };

function removeStampOnce(id: string, stamp: number) {
  const w = accWindow.get(id);
  if (!w) return;
  const i = w.indexOf(stamp);
  if (i >= 0) w.splice(i, 1);
  if (!w.length) accWindow.delete(id);
}
function pushStamp(id: string, stamp: number) {
  const cut = now() - 60000;
  const w = (accWindow.get(id) || []).filter((t) => t > cut);
  w.push(stamp);
  accWindow.set(id, w);
}

function holdAccount(candidates: string[], sessionKeyStr?: string): AccountHold {
  if (!candidates.length) return NOOP_HOLD;
  let reserved = '';
  if (sessionKeyStr) {
    const prev = sessionLastAuth.get(sessionKeyStr);
    if (prev && candidates.includes(prev)) reserved = prev;
  }
  if (!reserved) {
    reserved = candidates[0];
    let best = lastPrePicked.get(reserved) || 0;
    for (let i = 1; i < candidates.length; i++) {
      const t = lastPrePicked.get(candidates[i]) || 0;
      if (t < best) { best = t; reserved = candidates[i]; }
    }
  }
  lastPrePicked.set(reserved, nextPickTick());
  const stamp = now();
  let current = reserved;
  let state: 'held' | 'released' | 'aborted' = 'held';
  let settled = false;
  inc(accInflight, current, 1);
  pushStamp(current, stamp);

  return {
    settle(actualKey: string) {
      if (settled || state === 'aborted' || !actualKey) return;
      settled = true;
      if (actualKey !== current) {
        if (state === 'held') {
          inc(accInflight, current, -1);
          inc(accInflight, actualKey, 1);
        }
        removeStampOnce(current, stamp);
        pushStamp(actualKey, stamp);
        current = actualKey;
      }
      lastPrePicked.set(actualKey, nextPickTick());
      if (sessionKeyStr) {
        sessionLastAuth.delete(sessionKeyStr);
        if (sessionLastAuth.size >= 5000) sessionLastAuth.delete(sessionLastAuth.keys().next().value!);
        sessionLastAuth.set(sessionKeyStr, actualKey);
      }
    },
    abort() {
      if (state === 'aborted') return;
      if (state === 'held') inc(accInflight, current, -1);
      removeStampOnce(current, stamp);
      state = 'aborted';
    },
    release() {
      if (state !== 'held') return;
      inc(accInflight, current, -1);
      state = 'released';
    },
  };
}

// request_id -> allowed set, for the usage-queue cross-check
export const recentAllowed = new Map<string, { allowed: Set<string>; ts: number }>();

// ---------- circuit breaker ----------
type Breaker = { tripped: boolean; at?: number; reason?: string };
let breaker: Breaker = (() => {
  try { return JSON.parse(getSetting('breaker') || '{"tripped":false}'); } catch { return { tripped: false }; }
})();
export function breakerState(): Breaker {
  return breaker;
}
export function alarm(kind: string, detail: Record<string, unknown>, trip: boolean) {
  const d = JSON.stringify(detail);
  console.error(`[ALARM] ${kind} ${d}`);
  run('INSERT INTO alarms(ts, kind, detail) VALUES(?,?,?)', now(), kind, d);
  if (trip && !breaker.tripped) {
    breaker = { tripped: true, at: now(), reason: kind };
    setSetting('breaker', JSON.stringify(breaker));
  }
}
export function resetBreaker() {
  breaker = { tripped: false };
  setSetting('breaker', JSON.stringify(breaker));
}

// ---------- helpers ----------
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'cookie', 'authorization', 'x-api-key', 'x-goog-api-key', 'x-real-ip', 'forwarded']);

/** Copy client headers, dropping hop-by-hop, credentials, forwarding info and EVERY x-agy-* header (any case). */
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

type Ctx = { userId: number; keyId: number; pool: 'private' | 'shared' | 'aistudio'; model: string; path: string; stream: boolean; start: number; ttfb?: number | null; inEst?: number | null };

type Extra = { authId: string | null; ownerId: number | null; tok: Tok };
function record(c: Ctx, f: { status: number; result: string; authId?: string | null; requestId?: string | null; reason?: string | null; x?: Extra }) {
  const authId = f.x ? f.x.authId : f.authId || null;
  const owner = f.x ? f.x.ownerId : authId ? one('SELECT owner_id FROM accounts WHERE auth_id = ?', authId)?.owner_id ?? null : null;
  const t = f.x?.tok, has = !!t && (t.in || t.out);
  run(`INSERT INTO usage(ts, user_id, key_id, pool, auth_id, owner_id, model, requested_model, path, status, result, reason, latency_ms, stream, request_id, ttfb_ms,
       in_tok, out_tok, reasoning_tok, cache_tok, cache_write_tok, total_tok, in_est)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.start, c.userId, c.keyId, c.pool, authId, owner, c.model, c.model || null, c.path.slice(0, 120), f.status, f.result, f.reason ? f.reason.slice(0, 200) : null,
    now() - c.start, c.stream ? 1 : 0, f.requestId || null, c.ttfb ?? null,
    has ? t!.in : null, has ? t!.out : null, has ? t!.think : null, has ? t!.cache : null, has ? t!.cacheWrite : null, has ? t!.in + t!.out : null, c.inEst ?? null);
}

/** 输入上限 (the user's own setting, every key). */
function userInputCap(ctx: Ctx): Why | null {
  const cap = Number(one('SELECT input_limit FROM users WHERE id = ?', ctx.userId)?.input_limit || 0);
  const est = ctx.inEst || 0;
  if (cap > 0 && est > cap) {
    return { status: 400, result: 'input_limit',
      message: `输入过限：这次输入约 ${wan(est)} Token，超过了你设置的上限 ${wan(cap)}。请检查上下文是不是爆了；确实需要的话到「个人中心」调高或关闭上限` };
  }
  return null;
}

/** Per-user rotation mode and session salt (the salt is created on first use). */
export function userRotation(userId: number): { mode: string; salt: string } {
  const u = one('SELECT rotation_mode, session_salt FROM users WHERE id = ?', userId);
  let salt = u?.session_salt as string | null;
  if (!salt) {
    salt = newSalt();
    run('UPDATE users SET session_salt = ? WHERE id = ?', salt, userId);
  }
  return { mode: userMode(u?.rotation_mode), salt };
}

/** Allowed CPA auth IDs for a request. */
export async function allowedFor(userId: number, pool: 'private' | 'shared', model: string, listing = false): Promise<string[]> {
  const c = await cpa.creds(10000);
  const usable = (id: string) => {
    const cr = c.byId.get(id);
    return !!cr && !cr.disabled;
  };
  if (pool === 'private') {
    return all('SELECT auth_id FROM accounts WHERE owner_id = ? ORDER BY auth_id', userId).map((r) => r.auth_id).filter(usable);
  }
  const rules = getRules();
  const rows = all(`SELECT a.* FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.shared = 1 AND u.active = 1 ORDER BY a.auth_id`);
  return rows
    .filter((r) => usable(r.auth_id))
    .filter((r) => listing || !belowReserve(r, model))
    .filter((r) => listing || !accountBusy(r.auth_id, rules))
    .map((r) => r.auth_id);
}

export function parseTrace(v: string | string[] | undefined): { index: string; requestId: string } | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return null;
  const parts = s.trim().split('-');
  if (parts.length < 3 || !parts[1] || !parts.slice(2).join('-')) return null;
  return { index: parts[1], requestId: parts.slice(2).join('-') };
}

// ---------- client errors from upstream: say what went wrong, in Chinese, and keep it in the log ----------
const PREFILL = /ending with a model turn/i;
const PREFILL_MSG = '请求的最后一条是 AI 消息（预填充 / prefill），Gemini 不支持。请在客户端关掉「助手预填充」，或让最后一条是用户消息';
/** Upstream error body -> its message (OpenAI / Anthropic / Gemini error JSON, possibly wrapped in an array). */
export function errMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = (Array.isArray(j) ? j[0] : j)?.error;
    const m = typeof e === 'string' ? e : e?.message;
    if (m) return String(m).replace(/\s+/g, ' ').slice(0, 200);
  } catch {}
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

// ---------- model list: only what the key's accounts support ----------
const modelCache = new Map<string, { at: number; ids: Set<string> }>();
async function supportedModels(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(ids.map(async (id) => {
    let e = modelCache.get(id);
    if (!e || now() - e.at > 60000) {
      try {
        e = { at: now(), ids: new Set((await cpa.credentialModels(id)).map((m: any) => String(m?.id || '')).filter(Boolean)) };
        modelCache.set(id, e);
      } catch {
        if (!e) return;
      }
    }
    for (const m of e.ids) out.add(m);
  }));
  return out;
}
/** Drops models no allowed account supports from an OpenAI / Anthropic ({data:[{id}]}) or Gemini ({models:[{name}]}) list. */
export function filterModelList(body: string, ok: Set<string>, add: Set<string> = new Set()): string | null {
  let j: any;
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j.data)) {
    j.data = j.data.filter((m: any) => ok.has(String(m?.id || '')) || add.has(String(m?.id || '')));
    const have = new Set(j.data.map((m: any) => String(m?.id || '')));
    for (const id of add) if (!have.has(id)) j.data.push({ id, object: 'model', created: 0, owned_by: 'tools' });
  }
  else if (Array.isArray(j.models)) j.models = j.models.filter((m: any) => ok.has(String(m?.name || m?.id || '').replace(/^models\//, '')));
  else return null;
  if ('first_id' in j) j.first_id = j.data?.[0]?.id ?? null;
  if ('last_id' in j) j.last_id = j.data?.length ? j.data[j.data.length - 1].id : null;
  return JSON.stringify(j);
}

let rr = 0;
// an upstream that just failed sits out of the rotation for a minute
const downUntil = new Map<number, number>();
const markDown = (id: number) => downUntil.set(id, now() + 60000);
const isDown = (id: number) => (downUntil.get(id) || 0) > now();
const RESP_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'x-cpa-trace-id']);

// ---------- main handler ----------
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
  const pool = key.pool as 'private' | 'shared' | 'aistudio';

  let body: Buffer;
  try {
    body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, config.maxBodyBytes);
  } catch (e) {
    return fail(e instanceof HttpError ? e.status : 400, 'invalid_request', e instanceof HttpError && e.status === 413 ? '请求体太大' : '无法读取请求体');
  }
  const { model, stream, json } = modelFrom(P, body, req.headers['content-type']);
  const ctx: Ctx = { userId: key.user_id, keyId: key.id, pool, model, path: P, stream, start: now(), inEst: method === 'POST' && json ? estimateInput(json) : null };
  const isGen = method === 'POST';
  const listing = method === 'GET' && /\/models\/?$/.test(P);
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), key.id);
  const refuse = (w: Why, code: string) => {
    if (isGen) record(ctx, { status: w.status, result: w.result, reason: w.message });
    fail(w.status, code, w.message, w.retryAfter);
  };

  // AI Studio keys go straight to the relay: no CPA, no allow list, no breaker
  if (pool === 'aistudio') return goAIStudio(req, res, method, P, body, ctx, refuse);

  if (pool === 'shared') {
    // Embedding / Rerank: relayed to SiliconFlow with the admin's key (own per-key rate limit, no daily count)
    const sk = sfKind(P);
    if (sk) return sfRelay(res, method, sk, key.id, body, fail);
    if (isGen && bannedPreset(body)) {
      console.warn('[gateway] blocked kunlun preset, key', key.id, 'len', body.length);
      record(ctx, { status: 403, result: 'blocked', reason: '昆仑 IDE 预设已禁用' });
      return fail(403, 'preset_blocked', KUNLUN_MSG);
    }
  }

  if (breaker.tripped) {
    if (isGen) record(ctx, { status: 503, result: 'blocked', reason: '网关已熔断' });
    return fail(503, 'gateway_locked', '网关因安全检查暂停服务，请联系管理员');
  }
  if (!(await cpa.pluginHealthy())) {
    if (isGen) record(ctx, { status: 503, result: 'blocked', reason: '选号插件不可用' });
    return fail(503, 'scheduler_unavailable', '选号插件不可用，暂停服务');
  }

  // 输入上限 (the user's own setting, every key): stop a runaway context before it reaches an account
  if (isGen && json) {
    const w = userInputCap(ctx);
    if (w) return refuse(w, 'input_limit_exceeded');
  }

  // 大锅饭 input cap (admin rule): same refusal, its own reason so the bot can @ the caller
  if (isGen && pool === 'shared' && ctx.inEst) {
    const cap = getRules().sharedInput;
    if (cap > 0 && ctx.inEst > cap) {
      return refuse({ status: 400, result: 'input_limit',
        message: `输入过限：这次输入约 ${wan(ctx.inEst)} Token，超过了大锅饭的输入上限 ${wan(cap)}。请检查上下文是不是爆了，或改用小锅饭` }, 'input_limit_exceeded');
    }
  }

  // shared-pool key limits
  let countedKey = false;
  if (pool === 'shared' && isGen) {
    if (model && !sharedAllows(model)) {
      return refuse({ status: 404, result: 'no_model', message: `大锅饭没有开放 ${model}，换一个模型或用小锅饭` }, 'model_not_found');
    }
    const d = await dailyFor(key.user_id).catch(() => null);
    if (d && d.limit != null && d.used >= d.limit) {
      return refuse({ status: 429, result: 'daily_limit', retryAfter: secondsToMidnight(),
        message: `今日大锅饭次数已用完（${d.used}/${d.limit}），明天 0 点重置；把一个 Pro 号放进大锅饭，每天多 ${d.per} 次` }, 'daily_limit_exceeded');
    }
    const rules = getRules();
    const w = (keyWindow.get(key.id) || []).filter((t) => t > now() - 60000);
    keyWindow.set(key.id, w);
    if ((keyInflight.get(key.id) || 0) >= rules.keyConc) {
      return refuse({ status: 429, result: 'rate_limited', message: `大锅饭限速：同时最多 ${rules.keyConc} 个请求`, retryAfter: 2 }, 'rate_limited');
    }
    if (w.length >= rules.keyRpm) {
      const wait = Math.max(1, Math.ceil((w[0] + 60000 - now()) / 1000));
      return refuse({ status: 429, result: 'rate_limited', message: `大锅饭限速：每分钟 ${rules.keyRpm} 次`, retryAfter: wait }, 'rate_limited');
    }
    w.push(now());
  }

  let allowed: string[];
  try {
    allowed = await allowedFor(key.user_id, pool, model, listing);
  } catch {
    if (isGen) record(ctx, { status: 503, result: 'blocked', reason: '账号列表不可用' });
    return fail(503, 'scheduler_unavailable', '账号列表暂时不可用');
  }
  // 闲置自动休眠: the owner is back, wake their sleeping 小锅饭 accounts. A model list just goes on;
  // a generation is told to retry, since the woken accounts need a moment in CPA.
  if (pool === 'private' && !allowed.length && await wakeFor(key.user_id).catch(() => 0)) {
    if (isGen) {
      record(ctx, { status: 503, result: 'blocked', reason: '凭证正在启动' });
      return fail(503, 'credential_waking', '凭证正在启动，请重试', 3);
    }
    allowed = await allowedFor(key.user_id, pool, model, listing).catch(() => []);
  }
  type UpPlan = { u: Upstream; cpaPlugin: boolean; usableIds: string[]; allowIds: string[]; holdKeys: string[]; weight: number };
  const rawUps: Upstream[] = pool === 'shared' && isGen ? await upstreamsFor(model).catch(() => []) : [];
  const availUps: UpPlan[] = [];
  const busyUpKeys: string[] = [];
  if (rawUps.length) {
    const rules = getRules();
    await Promise.all(rawUps.map(async (u) => {
      if (u.mgmtKey) {
        const [usableCreds, pluginOk] = await Promise.all([
          upUsableCreds(u, model).catch(() => null),
          upPluginHealthy(u).catch(() => false),
        ]);
        if (!usableCreds || !usableCreds.length) return;
        const usableIds = usableCreds.map((c) => c.id);
        if (pluginOk) {
          const freeIds = usableIds.filter((id) => !accountBusy(`up:${u.id}:${id}`, rules));
          if (!freeIds.length) {
            busyUpKeys.push(...usableIds.map((id) => `up:${u.id}:${id}`));
            return;
          }
          availUps.push({ u, cpaPlugin: true, usableIds, allowIds: freeIds, holdKeys: freeIds.map((id) => `up:${u.id}:${id}`), weight: freeIds.length });
        } else {
          const k = `up:${u.id}`;
          if (accountBusy(k, rules)) { busyUpKeys.push(k); return; }
          availUps.push({ u, cpaPlugin: false, usableIds, allowIds: [], holdKeys: [k], weight: 1 });
        }
      } else {
        const k = `up:${u.id}`;
        if (accountBusy(k, rules)) { busyUpKeys.push(k); return; }
        availUps.push({ u, cpaPlugin: false, usableIds: [], allowIds: [], holdKeys: [k], weight: 1 });
      }
    }));
    availUps.sort((a, b) => a.u.id - b.u.id);
  }
  const buildUpBusy = (): UpBusy | undefined => {
    if (!busyUpKeys.length) return undefined;
    const rules = getRules(), t = now();
    let conc = false, rpm = false;
    for (const id of busyUpKeys) {
      const cFull = rules.accConc > 0 && accountInflight(id) >= rules.accConc;
      const rFull = rules.accRpm > 0 && accountRpmUsed(id, t) >= rules.accRpm;
      if (cFull && !rFull) conc = true;
      if (rFull) rpm = true;
    }
    return { conc, rpm, wait: accountWaitSeconds(busyUpKeys, rules, t) };
  };

  if (!allowed.length && isGen && !availUps.length) {
    const w = await explainUnavailable(key.user_id, pool, model, undefined, buildUpBusy()).catch((): Why => ({ status: 503, result: 'no_account', message: '没有可用账号' }));
    return refuse(w, w.result === 'quota' ? 'insufficient_quota' : w.result === 'no_model' ? 'model_not_found' : 'no_available_account');
  }
  let allowSet = new Set(allowed);
  if (isGen) {
    inc(keyInflight, key.id, 1);
    countedKey = true;
  }

  // Build the upstream request. Strip every client copy of the allow header (and any X-Agy-*), then set exactly one.
  const headers = forwardHeaders(req.headers);
  headers[config.allowHeader] = allowed.length ? allowed.join(',') : '__none__';
  const rot = isGen ? userRotation(key.user_id) : null;
  const sk = isGen && rot ? sessionKey({ keyId: key.id, model, headers: req.headers, body: json, salt: rot.salt }) : null;
  if (isGen && rot) {
    headers['X-Agy-Mode'] = sk ? rot.mode : 'performance';
    if (sk) headers['X-Agy-Session'] = sk.key;
  }
  headers['authorization'] = 'Bearer ' + config.cpaAPIKey;
  if (body.length) headers['content-length'] = String(body.length);
  const fwdURL = new URL(url.toString());
  fwdURL.searchParams.delete('key');
  const target = new URL(config.cpaURL);

  let servedAuth: string | null = null;
  let requestId: string | null = null;
  let activeHold: AccountHold = NOOP_HOLD;
  let finished = false;
  const finish = (status: number, result: string, reason?: string | null, x?: Extra) => {
    if (finished) return;
    finished = true;
    if (countedKey) inc(keyInflight, key.id, -1);
    activeHold.release();
    if (isGen) record(ctx, { status, result, authId: servedAuth, requestId, reason, x });
  };

  // ---- external upstream (Tools / external CPA backup pool): reverse proxy with per-account protection ----
  let cur: http.ClientRequest | null = null;
  let cpaOK = allowed.length > 0; // may the Google accounts (via CPA) take this request
  let triedCPA = false;
  const canFallbackCPA = () => {
    if (triedCPA || !cpaOK) return false;
    if (pool === 'shared' && isGen) {
      const rules = getRules();
      allowed = allowed.filter((id) => !accountBusy(id, rules));
      if (!allowed.length) return false;
      allowSet = new Set(allowed);
      headers[config.allowHeader] = allowed.join(',');
    }
    return true;
  };
  const refreshPlan = (p: UpPlan, ignoreDown = false): UpPlan | null => {
    if (!ignoreDown && isDown(p.u.id)) return null;
    const rules = getRules();
    if (p.cpaPlugin) {
      const freeIds = p.usableIds.filter((id) => !accountBusy(`up:${p.u.id}:${id}`, rules));
      if (!freeIds.length) {
        for (const id of p.usableIds) { const k = `up:${p.u.id}:${id}`; if (!busyUpKeys.includes(k)) busyUpKeys.push(k); }
        return null;
      }
      return { ...p, allowIds: freeIds, holdKeys: freeIds.map((id) => `up:${p.u.id}:${id}`), weight: freeIds.length };
    }
    const k = `up:${p.u.id}`;
    if (accountBusy(k, rules)) {
      if (!busyUpKeys.includes(k)) busyUpKeys.push(k);
      return null;
    }
    return p;
  };

  const goUp = (plan: UpPlan) => {
    const u = plan.u;
    const sn = usageSniffer();
    const x = (): Extra => ({ authId: upAuthId(u.id), ownerId: u.ownerId, tok: sn.done() });
    let extra: Record<string, string> | undefined;
    if (plan.cpaPlugin) {
      extra = {
        [config.allowHeader]: plan.allowIds.join(','),
        'X-Agy-Mode': sk ? rot!.mode : 'performance',
      };
      if (sk) extra['X-Agy-Session'] = sk.key;
    }
    const hold = isGen ? holdAccount(plan.holdKeys, plan.cpaPlugin && sk ? `up:${u.id}:${sk.key}` : undefined) : NOOP_HOLD;
    activeHold = hold;
    const r = upstreamRequest(u, method, fwdURL.pathname + fwdURL.search, req.headers, body.length, extra);
    cur = r;
    r.on('error', () => {
      if (finished) return;
      hold.abort();
      if (!res.headersSent && canFallbackCPA()) { markDown(u.id); return goCPA(); }
      if (!res.headersSent) fail(502, 'upstream_error', `上游 ${u.name} 不可达`);
      else res.destroy();
      finish(502, 'upstream', `${u.name} 不可达`, x());
    });
    r.on('response', async (ur) => {
      const status = ur.statusCode || 502;
      if ((status === 429 || status >= 500) && canFallbackCPA()) {
        // Upstream is full or broken: let the Google accounts take this one
        ur.resume();
        if (status >= 500) markDown(u.id);
        hold.abort();
        return goCPA();
      }
      if (plan.cpaPlugin) {
        const trace = parseTrace(ur.headers['x-cpa-trace-id']);
        if (trace) {
          const credId = await upAuthIdForIndex(u, trace.index).catch(() => null);
          if (finished) { ur.destroy(); return; }
          if (credId) hold.settle(`up:${u.id}:${credId}`);
        } else if (status >= 400) {
          hold.abort();
        }
      } else if (isGen) {
        hold.settle(`up:${u.id}`);
      }
      const tHead = now() - ctx.start;
      if (status >= 400 && status < 500 && status !== 429) {
        // small error body: explain the common ones, keep the message in the traffic log
        const ch: Buffer[] = [];
        let size = 0;
        ur.on('data', (c: Buffer) => { if (size < 65536) { ch.push(c); size += c.length; } });
        ur.on('error', () => finish(502, 'upstream', `${u.name} 连接中断`, x()));
        ur.on('end', () => {
          ctx.ttfb ??= tHead;
          const b = Buffer.concat(ch), text = b.toString('utf8');
          if (PREFILL.test(text)) { fail(400, 'invalid_request', PREFILL_MSG); return finish(400, 'client', '预填充（最后一条是 AI 消息）不支持', x()); }
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !RESP_DROP.has(k.toLowerCase()) && k.toLowerCase() !== 'content-length') out[k] = v;
          out['content-length'] = String(b.length);
          if (!res.headersSent) { res.writeHead(status, out); res.end(b); }
          finish(status, 'client', `${u.name} 返回 ${status}：${errMessage(text)}`, x());
        });
        return;
      }
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !RESP_DROP.has(k.toLowerCase())) out[k] = v;
      res.writeHead(status, out);
      ur.once('data', () => { ctx.ttfb ??= now() - ctx.start; });
      ur.on('data', (c: Buffer) => sn.feed(c));
      ur.pipe(res);
      ur.on('end', () => {
        ctx.ttfb ??= tHead;
        const result = status < 300 ? 'ok' : status === 429 ? 'quota' : status < 500 ? 'client' : 'upstream';
        finish(status, result, status < 300 ? null : `${u.name} 返回 ${status}`, x());
      });
      ur.on('error', () => finish(502, 'upstream', `${u.name} 连接中断`, x()));
    });
    r.end(body);
  };
  let rrPick: UpPlan | null = null;
  if (availUps.length) {
    // a model only the upstreams serve (e.g. Tools' *-tiered names) never goes to CPA, which would just refuse it
    const sup = allowed.length && model ? await supportedModels(allowed) : null;
    if (sup && sup.size && !sup.has(model)) cpaOK = false;
    // take turns weighted by each upstream's free account count next to the allowed Google ones
    const live = availUps.map((p) => refreshPlan(p)).filter((p): p is UpPlan => p !== null);
    const g = cpaOK ? allowed.length : 0;
    const upWeight = live.reduce((s, p) => s + p.weight, 0);
    const n = g + upWeight, i = n ? rr++ % n : 0;
    if (i >= g && live.length) {
      let rem = i - g;
      for (const p of live) {
        if (rem < p.weight) { rrPick = p; break; }
        rem -= p.weight;
      }
    } else if (!g) {
      const lastResort = availUps.map((p) => refreshPlan(p, true)).find((p): p is UpPlan => p !== null) || null;
      if (!lastResort) {
        const w = await explainUnavailable(key.user_id, pool, model, undefined, buildUpBusy()).catch((): Why => ({ status: 503, result: 'no_account', message: '没有可用账号' }));
        fail(w.status, w.result === 'quota' ? 'insufficient_quota' : w.result === 'no_model' ? 'model_not_found' : 'no_available_account', w.message, w.retryAfter);
        finish(w.status, w.result, w.message);
        return;
      }
      rrPick = lastResort;
    }
  }
  res.on('close', () => {
    if (!res.writableFinished) {
      cur?.destroy();
      finish(499, 'client', '客户端断开');
    }
  });
  const goCPA = () => {
  triedCPA = true;
  const hold = isGen ? holdAccount(allowed, sk?.key) : NOOP_HOLD;
  activeHold = hold;
  const up = http.request({
    host: target.hostname, port: target.port || 80, method, path: fwdURL.pathname + fwdURL.search, headers,
  });
  cur = up;
  up.on('error', () => {
    if (!finished) {
      hold.abort();
      fail(502, 'upstream_error', '上游 CLIProxyAPI 不可达');
      finish(502, 'upstream', '上游不可达');
    }
  });
  up.on('response', async (ur) => {
    const status = ur.statusCode || 502;
    const trace = parseTrace(ur.headers['x-cpa-trace-id']);
    // ---- post-pick verification (before a single byte reaches the client) ----
    if (trace) {
      requestId = trace.requestId;
      const authId = await cpa.authIdForIndex(trace.index).catch(() => null);
      if (finished) { ur.destroy(); return; }
      if (!authId || !allowSet.has(authId)) {
        hold.abort();
        ur.destroy();
        up.destroy();
        alarm('allow_violation', { authIndex: trace.index, authId, allowed, keyId: key.id, pool, requestId, path: P }, true);
        fail(502, 'gateway_locked', '安全检查未通过，网关已暂停');
        finish(502, 'blocked', '选中了名单外的账号');
        return;
      }
      servedAuth = authId;
      if (isGen) hold.settle(authId);
      recentAllowed.set(trace.requestId, { allowed: allowSet, ts: now() });
    } else if (isGen && status >= 200 && status < 300) {
      // A successful generation without a trace cannot be verified: refuse it.
      hold.abort();
      ur.destroy();
      up.destroy();
      alarm('missing_trace', { keyId: key.id, pool, path: P, status }, true);
      fail(502, 'gateway_locked', '安全检查未通过，网关已暂停');
      finish(502, 'blocked', '响应缺少追踪信息');
      return;
    } else if (isGen && status >= 400) {
      hold.abort();
    }
    const tHead = now() - ctx.start;
    // ---- model list: buffer and filter to the models the allowed accounts support ----
    if (listing && status === 200) {
      const chunks: Buffer[] = [];
      ur.on('data', (c: Buffer) => chunks.push(c));
      ur.on('error', () => finish(502, 'upstream', '上游连接中断'));
      ur.on('end', async () => {
        const raw = Buffer.concat(chunks);
        let add = new Set<string>();
        let ok = await supportedModels(allowed);
        if (pool === 'shared') {
          for (const u of enabledUpstreams()) for (const m of await openModels(u)) add.add(m);
          const open = sharedModels();
          if (open) { ok = new Set([...ok].filter((m) => open.has(m))); add = new Set([...add].filter((m) => open.has(m))); }
          for (const m of sfModelIds()) add.add(m); // Embedding / Rerank (governed by the SiliconFlow settings, not the shared-model list)
        }
        const filtered = filterModelList(raw.toString('utf8'), ok, add);
        const b = filtered === null ? raw : Buffer.from(filtered);
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !RESP_DROP.has(k.toLowerCase()) && k.toLowerCase() !== 'content-length') out[k] = v;
        out['content-length'] = String(b.length);
        if (!res.headersSent) { res.writeHead(status, out); res.end(b); }
        finish(status, 'ok');
      });
      return;
    }
    // ---- errors: read the (small) body; explain no-account / quota / unknown-model in the client's dialect ----
    if (status >= 400) {
      const chunks: Buffer[] = [];
      let size = 0;
      ur.on('data', (c: Buffer) => { if (size < 65536) { chunks.push(c); size += c.length; } });
      ur.on('error', () => finish(502, 'upstream', '上游连接中断'));
      ur.on('end', async () => {
        ctx.ttfb ??= tHead;
        hold.release();
        const text = Buffer.concat(chunks).toString('utf8');
        const noAcc = /auth_unavailable|agy_allow|auth_not_found|no auth available|unknown provider for model|model_not_found/i.test(text);
        if (isGen && (status === 429 || noAcc)) {
          const live = availUps.map((p) => refreshPlan(p)).filter((p): p is UpPlan => p !== null);
          if (live.length) {
            // CPA has nothing for it: hand the same request to an available external upstream instead
            servedAuth = null;
            return goUp(live[rr++ % live.length]);
          }
          const w = await explainUnavailable(key.user_id, pool, model, { status, text }, buildUpBusy()).catch((): Why => ({ status: status === 429 ? 429 : 503, result: status === 429 ? 'quota' : 'no_account', message: status === 429 ? '上游限流，请稍后重试' : '没有可用账号' }));
          const ra = Number(ur.headers['retry-after']);
          fail(w.status, w.result === 'quota' ? 'insufficient_quota' : w.result === 'no_model' ? 'model_not_found' : 'no_available_account', w.message, w.retryAfter ?? (Number.isFinite(ra) && ra > 0 ? ra : undefined));
          finish(w.status, w.result, w.message);
          return;
        }
        if (isGen && PREFILL.test(text)) { fail(400, 'invalid_request', PREFILL_MSG); return finish(400, 'client', '预填充（最后一条是 AI 消息）不支持'); }
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !RESP_DROP.has(k.toLowerCase()) && k.toLowerCase() !== 'content-length') out[k] = v;
        const b = Buffer.concat(chunks);
        out['content-length'] = String(b.length);
        if (!res.headersSent) { res.writeHead(status, out); res.end(b); }
        finish(status, status < 500 ? 'client' : 'upstream', isGen ? errMessage(text) : null);
      });
      return;
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !RESP_DROP.has(k.toLowerCase())) out[k] = v;
    // time to first response byte: first body chunk, or the headers when the body is empty
    ur.once('data', () => { ctx.ttfb ??= now() - ctx.start; });
    ur.once('end', () => { ctx.ttfb ??= tHead; });
    res.writeHead(status, out);
    ur.pipe(res);
    ur.on('end', () => finish(status, 'ok'));
    ur.on('error', () => finish(502, 'upstream', '上游连接中断'));
  });
  up.end(body);
  };
  if (rrPick) goUp(rrPick);
  else goCPA();
}

// periodic cleanup of request_id map and rate-limit sliding windows
setInterval(() => {
  const t = now();
  const cut = t - 300000;
  for (const [k, v] of recentAllowed) if (v.ts < cut) recentAllowed.delete(k);
  const wCut = t - 60000;
  for (const [k, w] of accWindow) {
    const live = w.filter((ts) => ts > wCut);
    if (live.length) accWindow.set(k, live);
    else accWindow.delete(k);
  }
  for (const [k, w] of keyWindow) {
    const live = w.filter((ts) => ts > wCut);
    if (live.length) keyWindow.set(k, live);
    else keyWindow.delete(k);
  }
  const pCut = t - 3600000;
  for (const [k, ts] of lastPrePicked) if (ts < pCut) lastPrePicked.delete(k);
}, 60000).unref();

// ---------- AI Studio pool: plain reverse proxy to the relay ----------
function openAIError(res: ServerResponse, status: number, code: string, message: string) {
  if (res.headersSent) return res.destroy();
  const b = JSON.stringify({ error: { message, type: code, code } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
// AI Studio rejects thinking level MINIMAL on non-Flash models (SillyTavern sends reasoning_effort "minimal" for 最低),
// and the relay lets reasoning_effort override a "-high"/"-low" model suffix. Fix both before forwarding.
export function aistudioThinkingFix(body: Buffer): Buffer {
  let j: any;
  try { j = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return body;
  return thinkingFix(j) ? Buffer.from(JSON.stringify(j)) : body;
}
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
/** Chat body for the relay: the thinking fixes above, and no client-supplied cookies (the portal picks the accounts). */
export function aistudioBody(body: Buffer): Buffer {
  let j: any;
  try { j = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return body;
  let changed = thinkingFix(j);
  if ('cookies' in j) { delete j.cookies; changed = true; }
  return changed ? Buffer.from(JSON.stringify(j)) : body;
}
// client headers that would pick or impersonate relay accounts
const AIS_DROP = (k: string) => k.startsWith('x-relay-') || k === 'x-google-cookies' || k === 'x-goog-authuser' || k === 'x-aistudio-g1-tier';

function goAIStudio(req: IncomingMessage, res: ServerResponse, method: string, P: string, body: Buffer, ctx: Ctx, refuse: (w: Why, code: string) => void) {
  const chat = method === 'POST' && P === '/v1/chat/completions';
  if (chat) body = aistudioBody(body);
  const list = method === 'GET' && (P === '/v1/models' || P === '/v1/models/');
  if (!chat && !list) return openAIError(res, 404, 'unsupported_endpoint', 'AI Studio 池只支持 /v1/chat/completions');
  if (!aistudioOn()) {
    if (chat) record(ctx, { status: 503, result: 'blocked', reason: 'AI Studio 池未开启' });
    return openAIError(res, 503, 'aistudio_disabled', 'AI Studio 池未开启');
  }
  // the accounts this request may be served by: own valid ones, plus every valid shared one for a sharer
  const { access, owners } = aistudioAllowFor(ctx.userId);
  if (access === 'none' || !owners.size) {
    if (chat) record(ctx, { status: 403, result: 'no_account', reason: NOT_ELIGIBLE });
    return openAIError(res, 403, 'no_available_account', NOT_ELIGIBLE);
  }
  if (chat) {
    const w = userInputCap(ctx);
    if (w) return refuse(w, 'input_limit_exceeded');
  }
  const headers = forwardHeaders(req.headers);
  for (const k of Object.keys(headers)) if (AIS_DROP(k)) delete headers[k];
  headers['x-relay-allow'] = [...owners.keys()].join(',');
  headers['authorization'] = 'Bearer ' + config.aistudioRelayKey;
  if (body.length) headers['content-length'] = String(body.length);
  const t = new URL(config.aistudioRelayURL);
  const tls = t.protocol === 'https:';
  const up = (tls ? https : http).request({ host: t.hostname, port: t.port || (tls ? 443 : 80), method, path: t.pathname.replace(/\/+$/, '') + P, headers });
  let finished = false;
  const sn = usageSniffer();
  const errBuf: Buffer[] = [];
  let errSize = 0;
  let served: string | null = null; // relay account that served it (verified against the allow list)
  const finish = (status: number, result: string, reason?: string | null) => {
    if (finished) return;
    finished = true;
    if (chat) record(ctx, { status, result, reason, x: { authId: served, ownerId: served ? owners.get(served) ?? null : null, tok: sn.done() } });
  };
  res.on('close', () => {
    if (!res.writableFinished) {
      up.destroy();
      finish(499, 'client', '客户端断开');
    }
  });
  up.on('error', () => {
    if (finished) return;
    if (!res.headersSent) openAIError(res, 502, 'upstream_error', 'AI Studio 中转不可达');
    else res.destroy();
    finish(502, 'upstream', 'AI Studio 中转不可达');
  });
  up.on('response', (ur) => {
    const status = ur.statusCode || 502;
    const tHead = now() - ctx.start;
    // ---- a successful generation must name an allowed account before a single byte reaches the client ----
    if (chat && status >= 200 && status < 300) {
      const h = ur.headers['x-relay-account'];
      const id = (Array.isArray(h) ? h.join(',') : h || '').trim();
      if (!id || !owners.has(id)) {
        console.warn('[aistudio] relay response refused', JSON.stringify({ account: id || null, keyId: ctx.keyId, userId: ctx.userId, status }));
        openAIError(res, 502, 'upstream_error', 'AI Studio 中转返回异常，请重试');
        finish(502, 'blocked', id ? '中转用了名单外的号，已拦截' : '中转响应没有标明所用的号，已拦截');
        ur.destroy();
        up.destroy();
        return;
      }
      served = id;
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !RESP_DROP.has(k.toLowerCase()) && !k.toLowerCase().startsWith('x-relay-')) out[k] = v;
    res.writeHead(status, out);
    ur.once('data', () => { ctx.ttfb ??= now() - ctx.start; });
    ur.on('data', (c: Buffer) => {
      if (status < 300) sn.feed(c);
      else if (errSize < 65536) { errBuf.push(c); errSize += c.length; }
    });
    ur.pipe(res);
    ur.on('end', () => {
      ctx.ttfb ??= tHead;
      if (status < 300) return finish(status, 'ok');
      finish(status, status === 429 ? 'quota' : status < 500 ? 'client' : 'upstream', `AI Studio 返回 ${status}：${errMessage(Buffer.concat(errBuf).toString('utf8'))}`);
    });
    ur.on('error', () => { res.destroy(); finish(502, 'upstream', 'AI Studio 连接中断'); });
  });
  up.end(body);
}
