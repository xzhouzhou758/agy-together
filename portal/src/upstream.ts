// External upstreams for the 大锅饭 (e.g. an Antigravity Manager / "Tools" instance): the portal
// forwards a shared-pool request to one directly, swapping in that upstream's own API key.
// They take turns with the Google accounts and catch requests CPA has no account / quota for.
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { one, all, run, now, type Row } from './db.ts';
import { seal, unseal } from './util.ts';

export type Upstream = { id: number; name: string; base: string; key: string; ownerId: number | null; allow: Set<string> | null };
export const isUp = (authId: string | null | undefined) => !!authId && authId.startsWith('up:');
export const upAuthId = (id: number) => 'up:' + id;
export function upName(authId: string): string {
  const r = isUp(authId) ? one('SELECT name FROM upstreams WHERE id = ?', Number(authId.slice(3))) : null;
  return r ? String(r.name) : isUp(authId) ? 'Tools' : '';
}

/** "http://127.0.0.1:8045/v1/" -> "http://127.0.0.1:8045" (client paths already start with /v1 or /v1beta). */
export function normBase(u: string): string {
  const x = new URL(u);
  if (x.protocol !== 'http:' && x.protocol !== 'https:') throw new Error('bad protocol');
  return (x.origin + x.pathname).replace(/\/+$/, '').replace(/\/v1(beta)?$/, '');
}

function toUp(r: Row): Upstream {
  let allow: Set<string> | null = null;
  try { const v = JSON.parse(r.models_allow || 'null'); if (Array.isArray(v)) allow = new Set(v.map(String)); } catch {}
  return { id: r.id, name: r.name, base: r.base_url, key: unseal(r.key_enc) || '', ownerId: r.owner_id ?? null, allow };
}
export function enabledUpstreams(): Upstream[] {
  return all('SELECT * FROM upstreams WHERE enabled = 1 ORDER BY id').map(toUp).filter((u) => u.key);
}
export function upstreamById(id: number): Upstream | null {
  const r = one('SELECT * FROM upstreams WHERE id = ?', id);
  return r ? toUp(r) : null;
}
export function upstreamRows(): Row[] {
  return all('SELECT * FROM upstreams ORDER BY id');
}
export function saveUpstream(id: number | null, f: { name: string; base: string; key?: string; enabled: boolean; models?: string[] | null }, ownerId: number): number {
  if (id == null) {
    const r = run('INSERT INTO upstreams(name, base_url, key_enc, enabled, owner_id, created_at) VALUES(?,?,?,?,?,?)', f.name, f.base, seal(f.key || ''), f.enabled ? 1 : 0, ownerId, now());
    return Number(r.lastInsertRowid);
  }
  run('UPDATE upstreams SET name = ?, base_url = ?, enabled = ? WHERE id = ?', f.name, f.base, f.enabled ? 1 : 0, id);
  if (f.key) run('UPDATE upstreams SET key_enc = ? WHERE id = ?', seal(f.key), id);
  if (f.models !== undefined) run('UPDATE upstreams SET models_allow = ? WHERE id = ?', f.models == null ? null : JSON.stringify(f.models), id);
  models.delete(id);
  return id;
}

// ---------- model lists (cached) ----------
const models = new Map<number, { at: number; ids: Set<string> | null; err?: string }>();
function request(u: Upstream, method: string, path: string, headers: Record<string, string | string[]>, timeoutMs: number) {
  const t = new URL(u.base + path);
  const mod = t.protocol === 'https:' ? https : http;
  return mod.request({ host: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80), method, path: t.pathname + t.search, headers, timeout: timeoutMs });
}
export function fetchModels(u: Upstream): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const r = request(u, 'GET', '/v1/models', { authorization: 'Bearer ' + u.key, 'x-api-key': u.key }, 8000);
    r.on('response', (res) => {
      const ch: Buffer[] = [];
      res.on('data', (c: Buffer) => ch.push(c));
      res.on('end', () => {
        if ((res.statusCode || 0) !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try {
          const j = JSON.parse(Buffer.concat(ch).toString('utf8'));
          const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
          resolve(new Set(list.map((m: any) => String(m?.id || m?.name || '').replace(/^models\//, '')).filter(Boolean)));
        } catch { reject(new Error('bad body')); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}
export async function modelsOf(u: Upstream, fresh = false): Promise<Set<string> | null> {
  const c = models.get(u.id);
  if (!fresh && c && now() - c.at < 5 * 60000) return c.ids;
  try {
    const ids = await fetchModels(u);
    models.set(u.id, { at: now(), ids });
    return ids;
  } catch (e) {
    models.set(u.id, { at: now(), ids: c?.ids ?? null, err: (e as Error).message });
    return c?.ids ?? null;
  }
}
export function modelInfo(id: number) {
  const c = models.get(id);
  return c ? { count: c.ids?.size ?? null, error: c.err || null, at: c.at } : null;
}
/** Models this upstream lists and the admin left open. */
export async function openModels(u: Upstream): Promise<Set<string>> {
  const ids = await modelsOf(u);
  return new Set([...(ids || [])].filter((m) => !u.allow || u.allow.has(m)));
}
/** Enabled upstreams that serve this model (an upstream whose list can't be read is skipped). */
export async function upstreamsFor(model: string): Promise<Upstream[]> {
  const out: Upstream[] = [];
  for (const u of enabledUpstreams()) if (model && (await openModels(u)).has(model)) out.push(u);
  return out;
}

// ---------- forwarding ----------
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding',
  'cookie', 'authorization', 'x-api-key', 'x-goog-api-key', 'x-real-ip', 'forwarded']);
export function upstreamRequest(u: Upstream, method: string, pathWithQuery: string, client: IncomingHttpHeaders, bodyLen: number) {
  const h: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(client)) {
    const lk = k.toLowerCase();
    if (v === undefined || HOP.has(lk) || lk.startsWith('x-agy') || lk.startsWith('x-forwarded-')) continue;
    h[lk] = v;
  }
  h.authorization = 'Bearer ' + u.key;
  h['x-api-key'] = u.key;
  if (bodyLen) h['content-length'] = String(bodyLen);
  return request(u, method, pathWithQuery, h, 10 * 60000);
}

// ---------- token usage from a passing response (OpenAI / Anthropic / Gemini, stream or not) ----------
export type Tok = { in: number; out: number; think: number; cache: number; cacheWrite: number };
export function usageSniffer() {
  const t: Tok = { in: 0, out: 0, think: 0, cache: 0, cacheWrite: 0 };
  let rest = '', whole = '', wholeOK = true;
  const max = (k: keyof Tok, v: unknown) => { const n = Number(v); if (Number.isFinite(n) && n > t[k]) t[k] = n; };
  const take = (j: any) => {
    if (!j || typeof j !== 'object') return;
    if (Array.isArray(j)) return j.forEach(take);
    const a = j.message?.usage || (j.type === 'message_delta' || j.type === 'message' ? j.usage : null);
    if (a) { // Anthropic: input_tokens excludes cache reads / writes
      const cr = Number(a.cache_read_input_tokens || 0), cw = Number(a.cache_creation_input_tokens || 0);
      if (a.input_tokens != null) max('in', Number(a.input_tokens) + cr + cw);
      max('cache', cr); max('cacheWrite', cw); max('out', a.output_tokens);
    } else if (j.usage) { // OpenAI chat / responses
      const u = j.usage;
      max('in', u.prompt_tokens ?? u.input_tokens); max('out', u.completion_tokens ?? u.output_tokens);
      max('cache', u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
      max('think', u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens);
    }
    const g = j.usageMetadata || j.response?.usageMetadata;
    if (g) { max('in', g.promptTokenCount); max('out', g.candidatesTokenCount); max('think', g.thoughtsTokenCount); max('cache', g.cachedContentTokenCount); }
  };
  const line = (l: string) => {
    const m = /^data:\s?(.*)$/.exec(l.trim());
    if (!m || m[1] === '[DONE]' || !m[1].includes('sage')) return;
    try { take(JSON.parse(m[1])); } catch {}
  };
  return {
    feed(c: Buffer) {
      const s = c.toString('utf8');
      if (wholeOK) { whole += s; if (whole.length > 4 << 20) { wholeOK = false; whole = ''; } }
      const parts = (rest + s).split('\n');
      rest = parts.pop() || '';
      if (rest.length > 1 << 20) rest = '';
      for (const p of parts) line(p);
    },
    done(): Tok {
      if (rest) line(rest);
      if (wholeOK && whole && !/^\s*(data:|event:)/m.test(whole)) { try { take(JSON.parse(whole)); } catch {} }
      return t;
    },
  };
}
export type { IncomingMessage };
