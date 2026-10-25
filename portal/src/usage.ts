// Single reader of the CPA usage queue (records expire after ~60 s, popping deletes them).
// Joins records to gateway rows by request_id to fill in token counts, and cross-checks auth_index.
import { config } from './config.ts';
import { one, run, now } from './db.ts';
import * as cpa from './cpa.ts';
import { recentAllowed, alarm } from './gateway.ts';

type Pending = { rec: any; ts: number };
const pending = new Map<string, Pending[]>();
let running = false;

function tok(r: any, k: string): number {
  const v = Number(r?.tokens?.[k] ?? 0);
  return Number.isFinite(v) ? v : 0;
}

async function apply(rec: any): Promise<boolean> {
  const rid = String(rec?.request_id || '');
  if (!rid) return true;
  // Cross-check: every attempt (including failed retries) must have used an allowed account.
  const ra = recentAllowed.get(rid);
  if (ra && rec.auth_index) {
    const id = await cpa.authIdForIndex(String(rec.auth_index)).catch(() => null);
    if (!id || !ra.allowed.has(id)) alarm('usage_allow_violation', { requestId: rid, authIndex: rec.auth_index, authId: id }, true);
  }
  const row = one('SELECT id, upstream_model, requested_model FROM usage WHERE request_id = ? ORDER BY id DESC LIMIT 1', rid);
  if (!row) return false;
  const failed = !!rec.failed;
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
  const s = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  // model: upstream base model after CPA alias mapping; response_model wins when the upstream reports another name
  const upModel = s(rec.response_model, 120) && s(rec.response_model, 120) !== s(rec.model, 120) ? s(rec.response_model, 120) : s(rec.model, 120);
  const sets = [
    'in_tok = COALESCE(in_tok,0) + ?', 'out_tok = COALESCE(out_tok,0) + ?', 'reasoning_tok = COALESCE(reasoning_tok,0) + ?',
    'total_tok = COALESCE(total_tok,0) + ?', 'cache_tok = COALESCE(cache_tok,0) + ?', 'cache_write_tok = COALESCE(cache_write_tok,0) + ?',
    'attempts = COALESCE(attempts,0) + 1',
  ];
  const args: any[] = [
    tok(rec, 'input_tokens'), tok(rec, 'output_tokens'), tok(rec, 'reasoning_tokens'), tok(rec, 'total_tokens'),
    tok(rec, 'cache_read_tokens') || tok(rec, 'cached_tokens'), tok(rec, 'cache_creation_tokens'),
  ];
  if (failed) {
    // Only the status code: fail.body is the raw upstream body and is never stored.
    const sc = num(rec?.fail?.status_code);
    if (sc) { sets.push('upstream_status = ?'); args.push(sc); }
    if (upModel && !row.upstream_model) { sets.push('upstream_model = ?'); args.push(upModel); }
  } else {
    if (upModel) { sets.push('upstream_model = ?'); args.push(upModel); }
    const ttft = num(rec.ttft_ms), lat = num(rec.latency_ms);
    if (ttft) { sets.push('cpa_ttft_ms = ?'); args.push(ttft); }
    if (lat) { sets.push('cpa_latency_ms = ?'); args.push(lat); }
  }
  const alias = s(rec.alias, 120);
  if (alias) { sets.push('requested_model = ?'); args.push(alias); }
  const eff = s(rec.reasoning_effort, 20);
  if (eff) { sets.push('reasoning_effort = ?'); args.push(eff); }
  const r = run(`UPDATE usage SET ${sets.join(', ')} WHERE id = ?`, ...args, row.id);
  return Number(r.changes) > 0;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (let round = 0; round < 10; round++) {
      const recs = await cpa.popUsage(500);
      for (const rec of recs) {
        if (!(await apply(rec))) {
          const rid = String(rec?.request_id || '');
          const l = pending.get(rid) || [];
          l.push({ rec, ts: now() });
          pending.set(rid, l);
        }
      }
      if (recs.length < 500) break;
    }
    // retry records whose gateway row was not written yet (stream still running)
    for (const [rid, list] of pending) {
      const keep: Pending[] = [];
      for (const p of list) {
        if (await apply(p.rec)) continue;
        if (now() - p.ts < 30 * 60000) keep.push(p);
        else alarm('unattributed_usage', { requestId: rid, authIndex: p.rec?.auth_index, model: p.rec?.model }, false);
      }
      if (keep.length) pending.set(rid, keep);
      else pending.delete(rid);
    }
  } catch (e) {
    console.error('[usage] drain failed', (e as Error).message);
  } finally {
    running = false;
  }
}

export function startUsageDrainer() {
  setInterval(() => void tick(), config.usagePollMs).unref();
}

export function pruneUsage() {
  run('DELETE FROM usage WHERE ts < ?', now() - config.usageRetentionDays * 86400000);
  run('DELETE FROM alarms WHERE ts < ?', now() - 90 * 86400000);
}
