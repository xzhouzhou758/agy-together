// Readable (Chinese) reasons for "no account / quota / rate limit" gateway errors, shaped like the
// endpoint's own error body, plus the short reason text stored in the traffic log.
import type { ServerResponse } from 'node:http';
import { all, getRules } from './db.ts';
import { modelGroup } from './util.ts';
import * as cpa from './cpa.ts';
import { storedQuota, belowReserve } from './quota.ts';

export type Why = { status: number; result: 'no_account' | 'quota' | 'rate_limited' | 'no_model' | 'daily_limit'; message: string; retryAfter?: number };

/** 「约 2 小时 15 分」 */
export function humanWait(sec: number): string {
  const m = Math.max(1, Math.ceil(sec / 60));
  if (m < 60) return `${m} 分钟`;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d} 天${h ? ` ${h} 小时` : ''}`;
  return `${h} 小时${mm ? ` ${mm} 分` : ''}`;
}
const after = (sec: number | undefined) => (sec && sec > 0 ? `，约 ${humanWait(sec)}后恢复` : '');

export function groupLabel(model: string): string {
  const g = modelGroup(model);
  return g === 'cl' ? 'Claude' : g === 'gp' ? 'Gemini Pro' : g === 'gf' ? 'Gemini Flash' : '';
}

// ---------- per-account model lists (cached) ----------
const modelCache = new Map<string, { at: number; ids: Set<string> }>();
async function modelsOf(id: string): Promise<Set<string> | null> {
  const c = modelCache.get(id);
  if (c && Date.now() - c.at < 10 * 60000) return c.ids;
  try {
    const list = await cpa.credentialModels(id);
    const ids = new Set(list.map((m: any) => String(m?.id || m?.name || '').toLowerCase()).filter(Boolean));
    modelCache.set(id, { at: Date.now(), ids });
    return ids;
  } catch {
    return null;
  }
}

/** Seconds until this account's quota for the model's group recovers, if it is used up; else 0. */
export function exhaustedFor(row: any, model: string): number {
  const q = storedQuota(row);
  if (!q) return 0;
  const g = modelGroup(model);
  const winKey = g === 'cl' ? 'claude' : g ? 'gemini' : null;
  let until = 0;
  const consider = (frac: number, reset: string | null) => {
    if (frac > 0.0001) return;
    const t = reset ? Date.parse(reset) : NaN;
    const s = Number.isFinite(t) ? Math.ceil((t - Date.now()) / 1000) : 0;
    until = Math.max(until, s > 0 ? s : 1);
  };
  for (const w of q.windows || []) if (winKey && w.key === winKey) for (const b of w.buckets) consider(b.frac, b.reset);
  for (const [gg, frac, reset] of q.groups || []) if (g && gg === g) consider(frac, reset);
  return until;
}

/**
 * Why no account can serve this request. `upstream` is CPA's own error, when CPA (not the portal) refused.
 * Every branch only looks at accounts the caller could use anyway (own accounts / the shared pool).
 */
export async function explainUnavailable(userId: number, pool: 'private' | 'shared', model: string, upstream?: { status: number; text: string }): Promise<Why> {
  const who = pool === 'private' ? '你的账号' : '大锅饭的账号';
  const rows = pool === 'private'
    ? all('SELECT * FROM accounts WHERE owner_id = ? ORDER BY auth_id', userId)
    : all('SELECT a.* FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.shared = 1 AND u.active = 1 ORDER BY a.auth_id');
  const c = await cpa.creds(10000).catch(() => null);
  const known = rows.filter((r) => !c || c.byId.has(r.auth_id));
  if (!known.length) {
    return pool === 'private'
      ? { status: 503, result: 'no_account', message: '你还没有自己的账号：小锅饭 Key 只用你自己的凭证，请先在「我的凭证」添加' }
      : { status: 503, result: 'no_account', message: '大锅饭里还没有共享账号' };
  }
  const enabled = known.filter((r) => !c?.byId.get(r.auth_id)?.disabled);
  if (!enabled.length) return { status: 503, result: 'no_account', message: `${who}都已停用` };

  // model support
  let supporting = enabled;
  if (model) {
    const lists = await Promise.all(enabled.map((r) => modelsOf(r.auth_id)));
    if (lists.every((l) => l !== null)) {
      supporting = enabled.filter((_, i) => lists[i]!.has(model.toLowerCase()));
      if (!supporting.length) return { status: 404, result: 'no_model', message: `没有支持该模型的账号：${model}` };
    }
  }
  if (upstream && /unknown provider for model|model_not_found/i.test(upstream.text)) {
    return { status: 404, result: 'no_model', message: `没有支持该模型的账号：${model || '（未指定模型）'}` };
  }

  // quota used up (cached 5h / weekly data)
  const label = groupLabel(model);
  const ex = supporting.map((r) => exhaustedFor(r, model));
  if (ex.every((s) => s > 0)) {
    const s = Math.min(...ex);
    return { status: 429, result: 'quota', message: `${who}${label ? ' ' + label + ' ' : ''}额度已用完${after(s)}`, retryAfter: s };
  }

  // CPA cooldown (rate limited upstream)
  const now = Date.now();
  const cool = supporting.map((r) => {
    const cr = c?.byId.get(r.auth_id);
    const t = cr?.nextRetryAfter ? Date.parse(cr.nextRetryAfter) : NaN;
    if (Number.isFinite(t) && t > now) return Math.ceil((t - now) / 1000);
    return cr?.unavailable ? 60 : 0;
  });
  const usable = supporting.filter((_, i) => !(ex[i] > 0) && !(cool[i] > 0));
  if (!usable.length) {
    const waits = cool.filter((s) => s > 0).concat(ex.filter((s) => s > 0));
    const s = waits.length ? Math.min(...waits) : undefined;
    return { status: 429, result: 'quota', message: `${who}${label ? ' ' + label + ' ' : ''}暂时被上游限流，正在冷却${after(s)}`, retryAfter: s };
  }

  if (pool === 'shared') {
    const rules = getRules();
    if (usable.every((r) => belowReserve(r, model))) {
      return { status: 503, result: 'no_account', message: `大锅饭的账号${label ? ' ' + label + ' ' : ''}剩余额度都低于号主设的自用保留线，暂不对外` };
    }
    const { accountInflight } = await import('./gateway.ts');
    if (usable.every((r) => belowReserve(r, model) || accountInflight(r.auth_id) >= rules.accConc)) {
      return { status: 503, result: 'no_account', message: `大锅饭的账号都在忙（每个号最多同时 ${rules.accConc} 个请求），请稍后重试`, retryAfter: 5 };
    }
  }
  if (upstream?.status === 429) return { status: 429, result: 'quota', message: `${who}被上游限流（429），请稍后重试`, retryAfter: 30 };
  return { status: 503, result: 'no_account', message: `${who}暂时都不可用，请稍后重试`, retryAfter: 30 };
}

// ---------- error bodies in the endpoint's own shape ----------
export type Dialect = 'openai' | 'anthropic' | 'gemini';
export function dialectOf(path: string): Dialect {
  if (/^\/v1\/messages(\/|$)/.test(path)) return 'anthropic';
  if (/^\/(v1beta|v1alpha|v1internal)\//.test(path) || /:(stream)?generateContent|:countTokens/i.test(path)) return 'gemini';
  return 'openai';
}
const ANTH: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 502: 'api_error', 503: 'overloaded_error' };
const GSTAT: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 413: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE' };

export function errorBody(path: string, status: number, code: string, message: string): string {
  switch (dialectOf(path)) {
    case 'anthropic':
      return JSON.stringify({ type: 'error', error: { type: ANTH[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'), message } });
    case 'gemini':
      return JSON.stringify({ error: { code: status, message, status: GSTAT[status] || (status >= 500 ? 'INTERNAL' : 'FAILED_PRECONDITION') } });
    default:
      return JSON.stringify({ error: { message, type: code, code } });
  }
}

export function sendGatewayError(res: ServerResponse, path: string, status: number, code: string, message: string, retryAfter?: number) {
  if (res.headersSent) return res.destroy();
  const body = errorBody(path, status, code, message);
  const h: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  if (retryAfter && retryAfter > 0) h['Retry-After'] = String(Math.ceil(retryAfter));
  res.writeHead(status, h);
  res.end(body);
}

// ---------- reason text for the traffic log ----------
export function reasonText(r: { result: string; status: number; reason?: string | null; upstream_status?: number | null }): string {
  if (r.reason) return r.reason;
  const up = r.upstream_status && r.upstream_status !== r.status ? `，上游 ${r.upstream_status}` : '';
  switch (r.result) {
    case 'ok': return r.upstream_status ? `成功（重试前上游 ${r.upstream_status}）` : '成功';
    case 'quota': return `额度不足或被限流（${r.status}${up}）`;
    case 'no_account': return '没有可用账号';
    case 'no_model': return '没有支持该模型的账号';
    case 'rate_limited': return '大锅饭限速';
    case 'blocked': return '安全检查拦截';
    case 'client': return r.status === 499 ? '客户端断开' : `请求被拒（${r.status}${up}）`;
    case 'upstream': return `上游错误（${r.status}${up}）`;
    default: return String(r.result || r.status);
  }
}
