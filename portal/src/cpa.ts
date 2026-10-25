// Client for the CLIProxyAPI v8 management API. Only the portal holds the management key.
import { config } from './config.ts';
import { HttpError } from './util.ts';

export type Cred = {
  id: string;
  authIndex: string;
  type: string;
  email: string;
  disabled: boolean;
  status: string; // active | error | disabled | ...
  statusMessage: string;
  unavailable: boolean;
  nextRetryAfter: string | null;
  projectId: string;
  note: string;
  updatedAt: string;
  createdAt: string;
};

async function mgmt(method: string, path: string, opts: { body?: unknown; raw?: Buffer | string; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; data: any }> {
  const url = new URL(config.cpaURL + '/v8/management' + path);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: 'Bearer ' + config.cpaMgmtKey };
  let body: any;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers['Content-Type'] = 'application/json';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
  } catch (e) {
    throw new HttpError(502, 'cpa_unreachable', String((e as Error)?.message || e));
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data };
}

function expectOK(r: { status: number; data: any }, what: string) {
  if (r.status < 200 || r.status >= 300) {
    const msg = typeof r.data === 'object' && r.data ? r.data.error || r.data.message : String(r.data || '');
    throw new HttpError(r.status === 404 ? 404 : 502, 'cpa_' + what + '_failed', String(msg || r.status));
  }
  return r.data;
}

// ---------- credentials (cached) ----------
let credCache: { at: number; list: Cred[]; byId: Map<string, Cred>; byIndex: Map<string, string> } | null = null;
let credInflight: Promise<void> | null = null;

function mapCred(f: any): Cred {
  return {
    id: String(f.id || f.name || ''),
    authIndex: String(f.auth_index || ''),
    type: String(f.type || f.provider || ''),
    email: String(f.email || f.account || ''),
    disabled: !!f.disabled,
    status: String(f.status || ''),
    statusMessage: String(f.status_message || ''),
    unavailable: !!f.unavailable,
    nextRetryAfter: f.next_retry_after ? String(f.next_retry_after) : null,
    projectId: String(f.project_id || ''),
    note: String(f.note || ''),
    updatedAt: String(f.updated_at || f.modtime || ''),
    createdAt: String(f.created_at || ''),
  };
}

export async function refreshCreds(): Promise<void> {
  if (credInflight) return credInflight;
  credInflight = (async () => {
    const r = await mgmt('GET', '/credentials');
    const files: any[] = expectOK(r, 'list')?.files || [];
    const list = files.map(mapCred).filter((c) => c.id);
    const byId = new Map<string, Cred>();
    const byIndex = new Map<string, string>();
    for (const c of list) {
      byId.set(c.id, c);
      if (c.authIndex) byIndex.set(c.authIndex, c.id);
    }
    credCache = { at: Date.now(), list, byId, byIndex };
  })().finally(() => {
    credInflight = null;
  });
  return credInflight;
}

export type Creds = { list: Cred[]; byId: Map<string, Cred>; byIndex: Map<string, string> };
export async function creds(maxAgeMs = 10000): Promise<Creds> {
  if (!credCache || Date.now() - credCache.at > maxAgeMs) await refreshCreds();
  return credCache!;
}

/** auth_index -> auth ID. Refreshes once on a miss. */
export async function authIdForIndex(index: string): Promise<string | null> {
  let c = await creds(30000);
  let id = c.byIndex.get(index);
  if (!id) {
    await refreshCreds();
    c = credCache!;
    id = c.byIndex.get(index);
  }
  return id || null;
}

export async function uploadCredential(name: string, json: Buffer) {
  expectOK(await mgmt('POST', '/credentials', { raw: json, query: { name } }), 'upload');
  await refreshCreds();
}

export async function setDisabled(id: string, disabled: boolean) {
  expectOK(await mgmt('PATCH', '/credentials/status', { body: { name: id, disabled } }), 'status');
  await refreshCreds();
}

export async function patchFields(id: string, fields: Record<string, unknown>) {
  expectOK(await mgmt('PATCH', '/credentials/fields', { body: { name: id, ...fields } }), 'fields');
  await refreshCreds();
}

export async function deleteCredential(id: string) {
  expectOK(await mgmt('DELETE', '/credentials', { query: { name: id } }), 'delete');
  await refreshCreds();
}

/** Force CPA to refresh a credential's access token now (CPA also fills project_id on refresh). */
export async function refreshCredential(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await mgmt('POST', '/credentials/refresh', { query: { name: id }, timeoutMs: 30000 });
  if (r.status >= 200 && r.status < 300 && r.data?.ok !== false) return { ok: true };
  return { ok: false, error: String(r.data?.error || r.data?.message || r.status) };
}

export async function downloadCredential(id: string): Promise<any> {
  return expectOK(await mgmt('GET', '/credentials/download', { query: { name: id } }), 'download');
}

export async function credentialModels(id: string): Promise<any[]> {
  const d = expectOK(await mgmt('GET', '/credentials/models', { query: { name: id }, timeoutMs: 8000 }), 'models');
  return Array.isArray(d?.models) ? d.models : [];
}

// ---------- OAuth ----------
export async function oauthStart(): Promise<{ url: string; state: string }> {
  const d = expectOK(await mgmt('GET', '/oauth/auth-url', { query: { provider: 'antigravity' } }), 'oauth');
  if (!d?.url || !d?.state) throw new HttpError(502, 'cpa_oauth_failed');
  return { url: String(d.url), state: String(d.state) };
}

export async function oauthCallback(redirectURL: string): Promise<{ ok: boolean; error?: string }> {
  const r = await mgmt('POST', '/oauth/callback', { body: { provider: 'antigravity', redirect_url: redirectURL } });
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { ok: false, error: String(r.data?.error || r.status) };
}

export async function oauthStatus(state: string): Promise<{ status: 'ok' | 'wait' | 'error'; error?: string }> {
  const r = await mgmt('GET', '/oauth/status', { query: { state } });
  const d = r.data || {};
  if (d.status === 'ok') return { status: 'ok' };
  if (d.status === 'error') return { status: 'error', error: String(d.error || '') };
  return { status: 'wait' };
}

// ---------- plugin health (fail closed) ----------
let pluginCache: { at: number; ok: boolean } | null = null;
export async function pluginHealthy(): Promise<boolean> {
  if (pluginCache && Date.now() - pluginCache.at < config.pluginCacheMs) return pluginCache.ok;
  let ok = false;
  try {
    const r = await mgmt('GET', '/plugins', { timeoutMs: 4000 });
    if (r.status === 200 && r.data && r.data.plugins_enabled !== false) {
      const p = (r.data.plugins || []).find((x: any) => x?.id === config.pluginID);
      ok = !!(p && p.registered === true && p.effective_enabled === true);
    }
  } catch {
    ok = false;
  }
  pluginCache = { at: Date.now(), ok };
  return ok;
}
export function invalidatePluginCache() {
  pluginCache = null;
}

// ---------- usage queue ----------
export async function popUsage(count: number): Promise<any[]> {
  const r = await mgmt('GET', '/observability/usage/queue', { query: { count: String(count) }, timeoutMs: 8000 });
  const d = expectOK(r, 'usage');
  return Array.isArray(d) ? d : [];
}

// ---------- upstream call through a credential ----------
/** Full request/response log CPA wrote for one request (request-log must be on). Raw text, unredacted. */
export async function requestLog(requestId: string): Promise<string | null> {
  // Only registered under the v0 management group in CPA v8.0.40.
  let r: { status: number; data: any };
  try {
    const res = await fetch(config.cpaURL + '/v0/management/request-log-by-id/' + encodeURIComponent(requestId), {
      headers: { Authorization: 'Bearer ' + config.cpaMgmtKey }, signal: AbortSignal.timeout(15000),
    });
    r = { status: res.status, data: await res.text() };
  } catch (e) {
    throw new HttpError(502, 'cpa_unreachable', String((e as Error)?.message || e));
  }
  if (r.status === 404) return null;
  if (r.status !== 200) throw new HttpError(502, 'cpa_error', 'request_log ' + r.status);
  return typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
}

export async function apiCall(authIndex: string, method: string, url: string, headers: Record<string, string>, data?: string): Promise<{ status: number; body: string }> {
  const r = await mgmt('POST', '/requests/api-call', {
    body: { auth_index: authIndex, method, url, header: headers, data: data ?? '' },
    timeoutMs: 70000,
  });
  const d = expectOK(r, 'api_call');
  return { status: Number(d?.status_code || 0), body: String(d?.body || '') };
}

// ---------- retry settings (routing.retry, hot-reloaded by CPA's config watcher) ----------
export type RetryConfig = { requestRetry: number; maxRetryCredentials: number; maxRetryInterval: number };
export async function retryConfig(): Promise<RetryConfig> {
  const r = await mgmt('GET', '/config/routing/retry', { timeoutMs: 5000 });
  const d = r.status === 404 ? {} : expectOK(r, 'config') || {};
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { requestRetry: n(d['request-retry']), maxRetryCredentials: n(d['max-retry-credentials']), maxRetryInterval: n(d['max-retry-interval']) };
}
/** 最大等待时长 (seconds) between retry rounds while every allowed account cools down. */
export async function setMaxRetryInterval(sec: number) {
  expectOK(await mgmt('PUT', '/config/routing/retry/max-retry-interval', { raw: String(Math.round(sec)), timeoutMs: 8000 }), 'config');
}
