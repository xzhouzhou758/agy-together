// "Test" button on the model list: one tiny chat completion through CPA, pinned to a single
// credential with the allow header (the scheduler plugin may only pick that account).
// Logged in the traffic table like any request, so the usage drainer can attribute its tokens.
import http from 'node:http';
import { config } from './config.ts';
import { one, run, now } from './db.ts';
import { maskSecrets } from './util.ts';
import * as cpa from './cpa.ts';
import { parseTrace, recentAllowed } from './gateway.ts';

export type TestResult = { ok: boolean; status: number; ms: number; reply: string; error: string };

function post(path: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const t = new URL(config.cpaURL);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: t.hostname, port: t.port || 80, method: 'POST', path, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { if (size < 65536) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode || 502, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(body);
  });
}

function errorText(status: number, body: string): string {
  let m = '';
  try {
    const j = JSON.parse(body);
    m = String(j?.error?.message || j?.message || j?.error || '');
  } catch { m = body; }
  m = maskSecrets(m.replace(/\s+/g, ' ').trim()).slice(0, 200);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(m)) return '额度用完或被限流' + (m ? '：' + m : '');
  if (/auth_unavailable|no auth available/i.test(m)) return '这个号现在不可用（停用、冷却或不支持这个模型）';
  return m || 'HTTP ' + status;
}

const busy = new Set<number>();
export async function testModel(userId: number, authId: string, model: string): Promise<TestResult> {
  if (busy.has(userId)) return { ok: false, status: 429, ms: 0, reply: '', error: '上一个测试还没结束' };
  busy.add(userId);
  const start = now();
  let res: TestResult;
  let requestId: string | null = null;
  try {
    const r = await post('/v1/chat/completions', {
      authorization: 'Bearer ' + config.cpaAPIKey, 'content-type': 'application/json',
      [config.allowHeader]: authId, 'X-Agy-Mode': 'performance',
    }, JSON.stringify({ model, stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with one short word: ok' }] }), 90000);
    const trace = parseTrace(r.headers['x-cpa-trace-id']);
    if (trace) {
      requestId = trace.requestId;
      recentAllowed.set(trace.requestId, { allowed: new Set([authId]), ts: now() });
      const served = await cpa.authIdForIndex(trace.index).catch(() => null);
      if (served && served !== authId) throw new Error('served by another account');
    }
    const ms = now() - start;
    if (r.status >= 200 && r.status < 300) {
      let reply = '';
      try {
        const j = JSON.parse(r.body);
        const c = j?.choices?.[0]?.message?.content;
        reply = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.text || '').join('') : '';
      } catch {}
      res = { ok: true, status: r.status, ms, reply: reply.trim().slice(0, 200), error: '' };
    } else res = { ok: false, status: r.status, ms, reply: '', error: errorText(r.status, r.body) };
  } catch (e) {
    const m = (e as Error).message;
    res = { ok: false, status: 0, ms: now() - start, reply: '', error: m === 'timeout' ? '超时（90 秒没有回应）' : m === 'served by another account' ? '安全检查未通过' : '连不上 CLIProxyAPI' };
  } finally {
    busy.delete(userId);
  }
  const owner = one('SELECT owner_id FROM accounts WHERE auth_id = ?', authId)?.owner_id ?? null;
  const result = res.ok ? 'ok' : res.status === 429 ? 'quota' : res.status && res.status < 500 ? 'client' : 'upstream';
  run(`INSERT INTO usage(ts, user_id, key_id, pool, auth_id, owner_id, model, requested_model, path, status, result, reason, latency_ms, stream, request_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    start, userId, null, 'private', authId, owner, model, model, '/portal/model-test', res.status || 502, result, res.ok ? '模型测试' : ('模型测试：' + res.error).slice(0, 200), res.ms, requestId);
  return res;
}
