// The gateway: portal key -> allowed CPA auth IDs -> X-Agy-Allow -> CPA, streaming-safe,
// with a post-pick check of X-CPA-TRACE-ID and a circuit breaker.
import { estimateInput, wan } from './inputsize.ts';
import http, { type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { config } from './config.ts';
import { one, all, run, now, getRules, getSetting, setSetting } from './db.ts';
import { sha256, readBody, HttpError } from './util.ts';
import * as cpa from './cpa.ts';
import { belowReserve } from './quota.ts';
import { sessionKey, userMode, newSalt } from './routing.ts';
import { explainUnavailable, sendGatewayError, type Why } from './reason.ts';
import { dailyFor, secondsToMidnight, sharedModels, sharedAllows } from './limits.ts';
import { upstreamsFor, upstreamRequest, usageSniffer, upAuthId, enabledUpstreams, openModels, type Upstream, type Tok } from './upstream.ts';
import { wakeFor } from './autosleep.ts';


// ---------- live counters ----------
const keyInflight = new Map<number, number>();
const accInflight = new Map<string, number>();
const keyWindow = new Map<number, number[]>();
const inc = <K>(m: Map<K, number>, k: K, d: number) => {
  const v = (m.get(k) || 0) + d;
  if (v <= 0) m.delete(k);
  else m.set(k, v);
};
export function accountInflight(id: string) {
  return accInflight.get(id) || 0;
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

type Ctx = { userId: number; keyId: number; pool: 'private' | 'shared'; model: string; path: string; stream: boolean; start: number; ttfb?: number | null; inEst?: number | null };

type Extra = { authId: string; ownerId: number | null; tok: Tok };
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
    .filter((r) => listing || accountInflight(r.auth_id) < rules.accConc)
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
  const pool = key.pool as 'private' | 'shared';

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
    const cap = Number(one('SELECT input_limit FROM users WHERE id = ?', key.user_id)?.input_limit || 0);
    const est = ctx.inEst || 0;
    if (cap > 0 && est > cap) {
      return refuse({ status: 400, result: 'input_limit',
        message: `输入过限：这次输入约 ${wan(est)} Token，超过了你设置的上限 ${wan(cap)}。请检查上下文是不是爆了；确实需要的话到「个人中心」调高或关闭上限` }, 'input_limit_exceeded');
    }
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
  const ups: Upstream[] = pool === 'shared' && isGen ? await upstreamsFor(model).catch(() => []) : [];
  if (!allowed.length && isGen && !ups.length) {
    const w = await explainUnavailable(key.user_id, pool, model).catch((): Why => ({ status: 503, result: 'no_account', message: '没有可用账号' }));
    return refuse(w, w.result === 'quota' ? 'insufficient_quota' : w.result === 'no_model' ? 'model_not_found' : 'no_available_account');
  }
  const allowSet = new Set(allowed);
  if (isGen) {
    inc(keyInflight, key.id, 1);
    countedKey = true;
  }

  // Build the upstream request. Strip every client copy of the allow header (and any X-Agy-*), then set exactly one.
  const headers = forwardHeaders(req.headers);
  headers[config.allowHeader] = allowed.length ? allowed.join(',') : '__none__';
  if (isGen) {
    const rot = userRotation(key.user_id);
    const sk = sessionKey({ keyId: key.id, model, headers: req.headers, body: json, salt: rot.salt });
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
  let finished = false;
  const finish = (status: number, result: string, reason?: string | null, x?: Extra) => {
    if (finished) return;
    finished = true;
    if (countedKey) inc(keyInflight, key.id, -1);
    if (servedAuth) inc(accInflight, servedAuth, -1);
    if (isGen) record(ctx, { status, result, authId: servedAuth, requestId, reason, x });
  };

  // ---- external upstream (Tools): plain reverse proxy with that upstream's key ----
  let cur: http.ClientRequest | null = null;
  let cpaOK = allowed.length > 0; // may the Google accounts (via CPA) take this request
  const goUp = (u: Upstream) => {
    const sn = usageSniffer();
    const x = (): Extra => ({ authId: upAuthId(u.id), ownerId: u.ownerId, tok: sn.done() });
    const r = upstreamRequest(u, method, fwdURL.pathname + fwdURL.search, req.headers, body.length);
    cur = r;
    r.on('error', () => {
      if (finished) return;
      if (!res.headersSent && !triedCPA && cpaOK) { markDown(u.id); return goCPA(); }
      if (!res.headersSent) fail(502, 'upstream_error', `上游 ${u.name} 不可达`);
      else res.destroy();
      finish(502, 'upstream', `${u.name} 不可达`, x());
    });
    r.on('response', (ur) => {
      const status = ur.statusCode || 502;
      if ((status === 429 || status >= 500) && !triedCPA && cpaOK) {
        // Tools is full or broken: let the Google accounts take this one
        ur.resume();
        if (status >= 500) markDown(u.id);
        return goCPA();
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
  let rrPick: Upstream | null = null;
  if (ups.length) {
    // a model only the upstreams serve (e.g. Tools' *-tiered names) never goes to CPA, which would just refuse it
    const sup = allowed.length && model ? await supportedModels(allowed) : null;
    if (sup && sup.size && !sup.has(model)) cpaOK = false;
    // take turns: the upstreams count as accounts next to the allowed Google ones
    const live = ups.filter((u) => !isDown(u.id));
    const g = cpaOK ? allowed.length : 0;
    const n = g + live.length, i = n ? rr++ % n : 0;
    if (i >= g && live.length) rrPick = live[i - g];
    else if (!g) rrPick = ups[0]; // nothing else to try
  }
  res.on('close', () => {
    if (!res.writableFinished) {
      cur?.destroy();
      finish(499, 'client', '客户端断开');
    }
  });
  let triedCPA = false;
  const goCPA = () => {
  triedCPA = true;
  const up = http.request({
    host: target.hostname, port: target.port || 80, method, path: fwdURL.pathname + fwdURL.search, headers,
  });
  cur = up;
  up.on('error', () => {
    if (!finished) {
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
      if (!authId || !allowSet.has(authId)) {
        ur.destroy();
        up.destroy();
        alarm('allow_violation', { authIndex: trace.index, authId, allowed, keyId: key.id, pool, requestId, path: P }, true);
        fail(502, 'gateway_locked', '安全检查未通过，网关已暂停');
        finish(502, 'blocked', '选中了名单外的账号');
        return;
      }
      servedAuth = authId;
      inc(accInflight, authId, 1);
      recentAllowed.set(trace.requestId, { allowed: allowSet, ts: now() });
    } else if (isGen && status >= 200 && status < 300) {
      // A successful generation without a trace cannot be verified: refuse it.
      ur.destroy();
      up.destroy();
      alarm('missing_trace', { keyId: key.id, pool, path: P, status }, true);
      fail(502, 'gateway_locked', '安全检查未通过，网关已暂停');
      finish(502, 'blocked', '响应缺少追踪信息');
      return;
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
        const text = Buffer.concat(chunks).toString('utf8');
        const noAcc = /auth_unavailable|agy_allow|auth_not_found|no auth available|unknown provider for model|model_not_found/i.test(text);
        if (isGen && (status === 429 || noAcc) && ups.some((u) => !isDown(u.id))) {
          // CPA has nothing for it: hand the same request to an external upstream instead
          if (servedAuth) { inc(accInflight, servedAuth, -1); servedAuth = null; }
          const live = ups.filter((u) => !isDown(u.id));
          return goUp(live[rr++ % live.length]);
        }
        if (isGen && (status === 429 || noAcc)) {
          const w = await explainUnavailable(key.user_id, pool, model, { status, text }).catch((): Why => ({ status: status === 429 ? 429 : 503, result: status === 429 ? 'quota' : 'no_account', message: status === 429 ? '上游限流，请稍后重试' : '没有可用账号' }));
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

// periodic cleanup of request_id map
setInterval(() => {
  const cut = now() - 300000;
  for (const [k, v] of recentAllowed) if (v.ts < cut) recentAllowed.delete(k);
}, 60000).unref();
