// Antigravity quota via CPA /requests/api-call (CPA core has no built-in antigravity quota endpoint).
//   fetchAvailableModels -> models[name].quotaInfo { remainingFraction, resetTime }
//   loadCodeAssist       -> paidTier.id, paidTier.availableCredits[GOOGLE_ONE_AI]
//   retrieveUserQuotaSummary -> groups[{displayName, buckets[{window: 5h|weekly, remainingFraction, resetTime}]}]
//     (same call the CPA management panel uses for its 5 小时限额 / 周限额 bars)
import { config } from './config.ts';
import { one, all, run, now, getRules } from './db.ts';
import { modelGroup, type Group, sleep } from './util.ts';
import * as cpa from './cpa.ts';

export type Bucket = { window: string; frac: number; reset: string | null };
export type Win = { key: 'gemini' | 'claude' | string; label: string; buckets: Bucket[] };
/** Gemini 4 Argon on this account: 'on' = listed with a quota, 'off' = only gemini-4-argon-disabled (not enabled for the account), null = not listed. */
export type Argon = 'on' | 'off' | null;
export type Quota = { tier: string | null; credits: number | null; groups: [Group, number, string | null][]; windows?: Win[] | null; argon?: Argon };

const WIN_ORDER: Record<string, number> = { '5h': 0, 'five-hour': 0, five_hour: 0, weekly: 1, week: 1 };
export function parseSummary(body: any): Win[] {
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  const out: Win[] = [];
  for (const g of groups) {
    const label = String(g?.displayName ?? g?.display_name ?? '').trim();
    const l = label.toLowerCase();
    const key = l.includes('gemini') ? 'gemini' : l.includes('claude') || l.includes('gpt') ? 'claude' : l.replace(/[^a-z0-9]+/g, '-') || 'group';
    const buckets: Bucket[] = [];
    for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
      const f = Number(b?.remainingFraction ?? b?.remaining_fraction);
      if (!Number.isFinite(f)) continue;
      const w = String(b?.window || '').trim().toLowerCase();
      buckets.push({ window: w === 'five-hour' || w === 'five_hour' ? '5h' : w === 'week' ? 'weekly' : w, frac: Math.max(0, Math.min(1, f)), reset: b?.resetTime || b?.reset_time ? String(b.resetTime ?? b.reset_time) : null });
    }
    buckets.sort((a, b) => (WIN_ORDER[a.window] ?? 9) - (WIN_ORDER[b.window] ?? 9));
    if (buckets.length) out.push({ key, label, buckets });
  }
  const ord = (k: string) => (k === 'gemini' ? 0 : k === 'claude' ? 1 : 2);
  return out.sort((a, b) => ord(a.key) - ord(b.key));
}

const inflight = new Map<string, Promise<Quota>>();

export function parseModels(body: any): [Group, number, string | null][] {
  const models = body?.models && typeof body.models === 'object' ? body.models : {};
  const best = new Map<Group, [number, string | null]>();
  for (const [name, info] of Object.entries<any>(models)) {
    const g = modelGroup(name);
    const qi = info?.quotaInfo;
    if (!g || !qi) continue;
    const frac = typeof qi.remainingFraction === 'number' ? qi.remainingFraction : qi.remainingFraction === undefined ? 0 : Number(qi.remainingFraction);
    if (!Number.isFinite(frac)) continue;
    const cur = best.get(g);
    if (!cur || frac < cur[0]) best.set(g, [Math.max(0, Math.min(1, frac)), qi.resetTime ? String(qi.resetTime) : null]);
  }
  const order: Group[] = ['gp', 'gf', 'ar', 'cl'];
  return order.filter((g) => best.has(g)).map((g) => [g, best.get(g)![0], best.get(g)![1]]);
}

export function parseArgon(body: any): Argon {
  const models = body?.models && typeof body.models === 'object' ? body.models : {};
  let seen = false;
  for (const [name, info] of Object.entries<any>(models)) {
    if (!/argon/i.test(name)) continue;
    seen = true;
    if (!/disabled/i.test(name) && info?.quotaInfo) return 'on';
  }
  return seen ? 'off' : null;
}

export function parseTier(body: any): { tier: string | null; credits: number | null } {
  const pt = body?.paidTier || body?.currentTier || null;
  const tier = pt?.id ? String(pt.id) : null;
  let credits: number | null = null;
  const list = body?.paidTier?.availableCredits;
  if (Array.isArray(list)) {
    for (const c of list) {
      if (String(c?.creditType || '').toUpperCase() === 'GOOGLE_ONE_AI') credits = Number(c?.creditAmount ?? c?.amount ?? 0) || 0;
    }
  }
  return { tier, credits };
}

async function fetchQuota(authId: string): Promise<Quota> {
  const c = await cpa.creds(5000);
  const cred = c.byId.get(authId);
  if (!cred) throw new Error('credential not found');
  const headers = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': config.quotaUserAgent };
  const m = await cpa.apiCall(cred.authIndex, 'POST', config.quotaBaseURL + '/v1internal:fetchAvailableModels', headers, JSON.stringify({ project: cred.projectId }));
  if (m.status < 200 || m.status >= 300) throw new Error('fetchAvailableModels ' + m.status + ': ' + m.body.slice(0, 300));
  let groups: Quota['groups'] = [], argon: Argon = null;
  try { const j = JSON.parse(m.body); groups = parseModels(j); argon = parseArgon(j); } catch { throw new Error('fetchAvailableModels: bad body'); }
  let tier: Quota['tier'] = null, credits: Quota['credits'] = null;
  try {
    const l = await cpa.apiCall(cred.authIndex, 'POST', config.quotaBaseURL + '/v1internal:loadCodeAssist', headers, JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }));
    if (l.status >= 200 && l.status < 300) ({ tier, credits } = parseTier(JSON.parse(l.body)));
  } catch {}
  let windows: Win[] | null = null;
  try {
    const q = await cpa.apiCall(cred.authIndex, 'POST', config.quotaBaseURL + '/v1internal:retrieveUserQuotaSummary', headers, JSON.stringify({ project: cred.projectId }));
    if (q.status >= 200 && q.status < 300) windows = parseSummary(JSON.parse(q.body));
  } catch {}
  return { tier, credits, groups, windows, argon };
}

/** Refresh one account's quota and store it. Concurrent calls share one fetch. */
export function refreshQuota(authId: string): Promise<Quota> {
  const existing = inflight.get(authId);
  if (existing) return existing;
  const p = fetchQuota(authId)
    .then((q) => {
      run('UPDATE accounts SET quota_json = ?, quota_at = ?, quota_err = NULL WHERE auth_id = ?', JSON.stringify(q), now(), authId);
      return q;
    })
    .catch((e) => {
      run('UPDATE accounts SET quota_at = ?, quota_err = ? WHERE auth_id = ?', now(), String(e?.message || e).slice(0, 200), authId);
      throw e;
    })
    .finally(() => inflight.delete(authId));
  inflight.set(authId, p);
  return p;
}

export function storedQuota(row: any): Quota | null {
  if (!row?.quota_json) return null;
  try { return JSON.parse(row.quota_json); } catch { return null; }
}

/**
 * Self-use reserve: a shared account leaves the shared pool once the remaining fraction of the
 * requested model's group drops below the reserve. Unknown model group -> lowest of all groups.
 * No quota data yet -> stays in the pool.
 */
export function reserveOf(row: any): number {
  return row?.reserve == null ? getRules().reserve : Number(row.reserve);
}
export function belowReserve(row: any, model: string): boolean {
  const reserve = reserveOf(row);
  if (!reserve) return false;
  const q = storedQuota(row);
  if (!q || !q.groups?.length) return false;
  const g = modelGroup(model);
  const fr = g ? q.groups.filter((x) => x[0] === g).map((x) => x[1]) : q.groups.map((x) => x[1]);
  if (!fr.length) return false;
  return Math.min(...fr) * 100 < reserve;
}

export function startQuotaRefresher() {
  if (config.quotaRefreshMinutes <= 0) return;
  const tick = async () => {
    // every owned account (shared or private), the ones used since their last read first
    const rows = all(`SELECT a.auth_id FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.active = 1 AND (a.quota_at IS NULL OR a.quota_at < ?)
      ORDER BY EXISTS(SELECT 1 FROM usage x WHERE x.auth_id = a.auth_id AND x.ts > COALESCE(a.quota_at, 0)) DESC, a.quota_at`,
      now() - config.quotaRefreshMinutes * 60000 + 5000);
    const c = await cpa.creds(30000).catch(() => null);
    for (const r of rows) {
      const cred = c?.byId.get(r.auth_id);
      if (!cred || cred.disabled) continue;
      await refreshQuota(r.auth_id).catch(() => {});
      await sleep(2000);
    }
  };
  setInterval(() => tick().catch(() => {}), config.quotaRefreshMinutes * 60000).unref();
  setTimeout(() => tick().catch(() => {}), 60000).unref();
}

export function lastQuotaAt(authId: string): number {
  return Number(one('SELECT quota_at FROM accounts WHERE auth_id = ?', authId)?.quota_at || 0);
}
