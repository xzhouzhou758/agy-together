// Embedding / Rerank relay to SiliconFlow (硅基流动): the config file (written by the admin page) and the relay
// for 大锅饭 keys (sfRelay, called from the gateway). The file lives in a dedicated directory that may also be
// mounted read-only into an OpenResty gateway (sf.lua), so it stays readable by its workers (user nobody):
// the host directory is setgid group nogroup, files are written 0640 and inherit that group.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { config } from './config.ts';
import { HttpError } from './util.ts';

export type SfModel = { name: string; type: 'embedding' | 'rerank'; free: boolean; enabled: boolean };
export type SfConf = { enabled: boolean; key: string; base: string; rpm: number; models: SfModel[]; updated: number };

export const SF_BASE = 'https://api.siliconflow.cn';
const DEFAULT: SfConf = {
  enabled: true, key: '', base: SF_BASE, rpm: 60, updated: 0,
  models: [
    { name: 'BAAI/bge-m3', type: 'embedding', free: true, enabled: true },
    { name: 'BAAI/bge-reranker-v2-m3', type: 'rerank', free: true, enabled: true },
    { name: 'Qwen/Qwen3-Embedding-8B', type: 'embedding', free: false, enabled: true },
    { name: 'Qwen/Qwen3-Reranker-8B', type: 'rerank', free: false, enabled: true },
  ],
};

const file = () => join(config.sfDir, 'sf.json');

export function sfLoad(): SfConf {
  try {
    const c = JSON.parse(readFileSync(file(), 'utf8'));
    return { ...structuredClone(DEFAULT), ...c, models: Array.isArray(c.models) ? c.models : [] };
  } catch {
    return structuredClone(DEFAULT);
  }
}

function sfWrite(c: SfConf) {
  mkdirSync(config.sfDir, { recursive: true });
  const tmp = join(config.sfDir, `.sf.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(c, null, 1) + '\n', { mode: 0o640 });
    renameSync(tmp, file()); // same directory: atomic for the Lua reader
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// First start: write the defaults so pool-gw has a file to read (switch on, no key = 503 until set).
export function sfInit() {
  try { if (existsSync(config.sfDir) && !existsSync(file())) sfWrite({ ...structuredClone(DEFAULT), updated: Date.now() }); }
  catch (e) { console.error('[sf] init:', (e as Error).message); }
}

export function sfView(c = sfLoad()) {
  return { enabled: c.enabled, keySet: !!c.key, keyTail: c.key ? c.key.slice(-4) : '', base: c.base, rpm: c.rpm, models: c.models };
}

const NAME = /^[\w.:\/+@-]{1,120}$/;
export function sfUpdate(b: any) {
  const c = sfLoad();
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'invalid');
    c.enabled = b.enabled;
  }
  if (b.key !== undefined && b.key !== null && b.key !== '') {
    const k = String(b.key).trim();
    if (!/^[\x21-\x7e]{8,300}$/.test(k)) throw new HttpError(400, 'invalid_sf_key');
    c.key = k;
  }
  if (b.base !== undefined) {
    const v = String(b.base || '').trim().replace(/\/+$/, '') || SF_BASE;
    if (!/^https?:\/\/[A-Za-z0-9.-]+$/.test(v)) throw new HttpError(400, 'invalid_sf_base');
    c.base = v;
  }
  if (b.rpm !== undefined) {
    const n = Number(b.rpm);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(400, 'invalid_sf_rpm');
    c.rpm = n;
  }
  if (b.models !== undefined) {
    if (!Array.isArray(b.models) || b.models.length > 100) throw new HttpError(400, 'invalid_sf_models');
    const seen = new Set<string>(), out: SfModel[] = [];
    for (const m of b.models) {
      const name = String(m?.name || '').trim().replace(/\s*[（(]免费[)）]$/, '');
      if (!name) continue;
      if (!NAME.test(name) || (m.type !== 'embedding' && m.type !== 'rerank')) throw new HttpError(400, 'invalid_sf_models');
      const k = m.type + '|' + name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name, type: m.type, free: !!m.free, enabled: !!m.enabled });
    }
    c.models = out;
  }
  c.updated = Date.now();
  sfWrite(c);
  return sfView(c);
}

// Admin "测试" button: one tiny call straight to SiliconFlow with the saved key (never returned).
export async function sfTest(b: any): Promise<{ ok: boolean; ms: number; detail: string }> {
  const name = String(b?.name || '').trim().replace(/\s*[（(]免费[)）]$/, '');
  if (!NAME.test(name) || (b?.type !== 'embedding' && b?.type !== 'rerank')) throw new HttpError(400, 'invalid_sf_models');
  const c = sfLoad();
  if (!c.key) return { ok: false, ms: 0, detail: '还没填 Key' };
  const rerank = b.type === 'rerank';
  const body = rerank ? { model: name, query: '苹果', documents: ['苹果是水果', '汽车是交通工具'] } : { model: name, input: '测试' };
  const t0 = Date.now();
  let r: Response, text: string;
  try {
    r = await fetch(`${c.base || SF_BASE}/v1/${rerank ? 'rerank' : 'embeddings'}`, {
      method: 'POST', headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    text = await r.text();
  } catch (e) {
    const to = (e as Error).name === 'TimeoutError';
    return { ok: false, ms: Date.now() - t0, detail: to ? '20 秒没响应' : '连不上硅基流动' };
  }
  const ms = Date.now() - t0;
  let d: any = null;
  try { d = JSON.parse(text); } catch {}
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return { ok: false, ms, detail: 'Key 无效或余额不足' };
    const msg = String(d?.message || d?.error?.message || d?.error || text || '').split(c.key).join('***').slice(0, 200);
    return { ok: false, ms, detail: `HTTP ${r.status}${msg ? ' · ' + msg : ''}` };
  }
  if (rerank) {
    const top = Array.isArray(d?.results) ? Math.max(...d.results.map((x: any) => Number(x?.relevance_score) || 0)) : NaN;
    return Number.isFinite(top) ? { ok: true, ms, detail: `最高分 ${top.toFixed(3)}` } : { ok: false, ms, detail: '返回格式不对' };
  }
  const dim = d?.data?.[0]?.embedding?.length;
  return dim ? { ok: true, ms, detail: `${dim} 维` } : { ok: false, ms, detail: '返回格式不对' };
}

// ---------- relay for 大锅饭 keys: POST /v1/embeddings, /v1/rerank ----------
const FREE = '（免费）';
const strip = (n: string) => n.trim().replace(/\s*[（(]免费[)）]$/, '');
const shownId = (m: SfModel) => (m.free ? m.name + FREE : m.name);
const ready = (c: SfConf) => c.enabled && !!c.key;
let cache: { at: number; c: SfConf } | null = null;
function conf(): SfConf { // re-read at most every 5 s
  if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), c: sfLoad() };
  return cache.c;
}

/** Model ids to append to the 大锅饭 model list (empty while the relay is off or has no key). */
export function sfModelIds(): string[] {
  const c = conf();
  return ready(c) ? c.models.filter((m) => m?.enabled && m.name).map(shownId) : [];
}

export const sfKind = (path: string): 'embeddings' | 'rerank' | null => {
  const m = /^\/v1\/(embeddings|rerank)\/?$/.exec(path);
  return m ? (m[1] as 'embeddings' | 'rerank') : null;
};

const win = new Map<number, number[]>(); // key id -> call times in the last minute
setInterval(() => { const t = Date.now() - 60000; for (const [k, v] of win) if (!v.some((x) => x > t)) win.delete(k); }, 60000).unref();

type Fail = (status: number, code: string, message: string, retryAfter?: number) => void;
export async function sfRelay(res: ServerResponse, method: string, kind: 'embeddings' | 'rerank', keyId: number, body: Buffer, fail: Fail) {
  if (method !== 'POST') return fail(405, 'method_not_allowed', '只支持 POST 请求');
  const c = conf();
  if (!ready(c)) return fail(503, 'sf_disabled', '大锅饭的 Embedding / Rerank 暂未开放');
  if (c.rpm > 0) {
    const t = Date.now(), w = (win.get(keyId) || []).filter((x) => x > t - 60000);
    if (w.length >= c.rpm) return fail(429, 'rate_limited', `请求太频繁：Embedding / Rerank 每个 Key 每分钟最多 ${c.rpm} 次，请稍后再试`, Math.max(1, Math.ceil((w[0] + 60000 - t) / 1000)));
    w.push(t); win.set(keyId, w);
  }
  let d: any;
  try { d = JSON.parse(body.toString('utf8')); } catch {}
  if (!d || typeof d !== 'object' || Array.isArray(d)) return fail(400, 'invalid_json', '请求体不是有效的 JSON');
  const typ = kind === 'rerank' ? 'rerank' : 'embedding';
  const open = c.models.filter((m) => m?.enabled && m.type === typ && m.name);
  const want = typeof d.model === 'string' ? strip(d.model).toLowerCase() : '';
  const pick = want ? open.find((m) => m.name.toLowerCase() === want) : undefined;
  if (!pick) {
    const what = kind === 'rerank' ? 'Rerank' : 'Embedding';
    return fail(400, 'model_not_allowed', open.length
      ? `模型「${typeof d.model === 'string' ? d.model : ''}」不可用于 ${what}，可用的模型：${open.map(shownId).join('、')}`
      : `大锅饭暂时没有开放 ${what} 模型`);
  }
  d.model = pick.name;
  let r: Response, buf: Buffer;
  try {
    r = await fetch(`${c.base || SF_BASE}/v1/${kind}`, {
      method: 'POST', headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' },
      body: JSON.stringify(d), signal: AbortSignal.timeout(120000),
    });
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return fail(502, 'upstream_error', (e as Error).name === 'TimeoutError' ? '硅基流动 120 秒没响应，请稍后再试' : '连不上硅基流动，请稍后再试');
  }
  // our SiliconFlow key was refused: don't pass a 401 through (the user would think their own key is wrong)
  if (r.status === 401 || r.status === 403) return fail(502, 'sf_key_rejected', '大锅饭的硅基流动 Key 无效或余额不足，请联系管理员');
  if (res.headersSent) return res.destroy();
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}
