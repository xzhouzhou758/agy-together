// Antigravity quota via CPA /requests/api-call (CPA core has no built-in antigravity quota endpoint).
//   fetchAvailableModels -> models[name].quotaInfo { remainingFraction, resetTime }
//   loadCodeAssist       -> paidTier.id, paidTier.availableCredits[GOOGLE_ONE_AI]
//   retrieveUserQuotaSummary -> groups[{displayName, buckets[{window: 5h|weekly, remainingFraction, resetTime}]}]
//     (same call the CPA management panel uses for its 5 小时限额 / 周限额 bars)
import { config } from './config.ts';
import { one, all, run, now, getRules } from './db.ts';
import { modelGroup, type Group, sleep } from './util.ts';
import * as cpa from './cpa.ts';
import { noteAction, clearAction } from './accaction.ts';
import { classify } from './accerr.ts';

export type Bucket = { window: string; frac: number; reset: string | null };
export type Win = { key: 'gemini' | 'claude' | string; label: string; buckets: Bucket[] };
/** Gemini 4 Argon on this account: 'on' = listed with a quota, 'off' = only gemini-4-argon-disabled (not enabled for the account), null = not listed. */
export type Argon = 'on' | 'off' | null;
export type Quota = {
  tier: string | null; credits: number | null; groups: [Group, number, string | null][]; windows?: Win[] | null; argon?: Argon;
  /** Gemini 4 Carbon: same on / off / not-listed reading as Argon. It has no group of its own upstream and shares the Gemini group's windows. */
  carbon?: Argon;
  /** lowest per-model quota among the Carbon models, used only when the summary has no Gemini group */
  carbonQ?: { frac: number; reset: string | null } | null;
  /** a claude-*-5-5 model is listed (the panel names the slot "Claude 5.5 / GPT", else "Claude 4.6 / GPT") */
  claude55?: boolean;
};

/** Normalise a tier id: enterprise / standard style tiers count as FREE (same abilities; no separate tier in the UI). */
export function normalizeTier(t: string | null | undefined): string | null {
  if (!t) return null;
  const lo = String(t).toLowerCase();
  if (lo.includes('ultra') || lo.includes('helium')) return 'ULTRA';
  if (lo.includes('free') || lo.includes('starter')) return 'FREE';
  if (lo.includes('pro') || lo.includes('premium') || lo.includes('advanced')) return 'PRO';
  if (lo.includes('enterprise') || lo.includes('standard') || lo.includes('business') || lo.startsWith('gcp_') || lo.includes('vertex')) return 'FREE';
  return String(t);
}

export type FamWin = { frac: number; reset: string | null };
export type FamQ = { h5: FamWin | null; week: FamWin | null };
export type FamKey = 'gemini' | 'claude' | 'argon' | 'carbon';
/** One window from a single per-model fraction: a reset within 6 hours reads as the 5H window, otherwise the weekly one. */
function single(frac: number, reset: string | null, now: number): FamQ {
  const w = { frac, reset };
  return reset && Date.parse(reset) - now < 6 * 3600e3 ? { h5: w, week: null } : { h5: null, week: w };
}
function famOfWin(w: Win): FamQ {
  const f: FamQ = { h5: null, week: null };
  for (const b of w.buckets) {
    if (b.window === '5h') f.h5 = { frac: b.frac, reset: b.reset };
    else if (b.window === 'weekly') f.week = { frac: b.frac, reset: b.reset };
  }
  return f;
}
/**
 * The four model slots the account page shows, each as 5H / 7D windows (null = no data for that slot):
 * Gemini, Claude / GPT, Gemini 4 Argon (null unless enabled), Gemini 4 Carbon (null unless enabled; Gemini's windows).
 * Older snapshots without summary windows fall back to the per-model groups.
 */
export function famView(q: Quota | null, now = Date.now()): Record<FamKey, FamQ | null> {
  const out: Record<FamKey, FamQ | null> = { gemini: null, claude: null, argon: null, carbon: null };
  if (!q) return out;
  const W = q.windows || [];
  const isArg = (w: Win) => w.key === 'argon' || /argon/i.test(w.label || '');
  const g = (k: string) => q.groups?.find((x) => x[0] === k);
  const gw = W.find((w) => w.key === 'gemini' && !isArg(w));
  if (gw) out.gemini = famOfWin(gw);
  else {
    const x = [g('gp'), g('gf')].filter(Boolean) as [Group, number, string | null][];
    if (x.length) { const m = x.reduce((a, b) => (b[1] < a[1] ? b : a)); out.gemini = single(m[1], m[2], now); }
  }
  const cw = W.find((w) => w.key === 'claude');
  if (cw) out.claude = famOfWin(cw);
  else { const c = g('cl'); if (c) out.claude = single(c[1], c[2], now); }
  if (q.argon !== 'off') {
    const aw = W.find(isArg), ar = g('ar');
    if (aw) out.argon = famOfWin(aw);
    else if (ar) out.argon = single(ar[1], ar[2], now);
    else if (q.argon === 'on') out.argon = { h5: null, week: null };
  }
  if (q.carbon === 'on') out.carbon = gw ? famOfWin(gw) : q.carbonQ ? single(q.carbonQ.frac, q.carbonQ.reset, now) : { h5: null, week: null };
  return out;
}
/** Argon / Carbon availability for the panel: 'on' when there is quota data, 'off' when upstream marks it disabled. */
export function famState(q: Quota | null, k: 'argon' | 'carbon'): Argon {
  if (!q) return null;
  if (k === 'argon') return q.argon === 'off' ? 'off' : q.argon === 'on' || q.groups?.some((x) => x[0] === 'ar') || (q.windows || []).some((w) => w.key === 'argon' || /argon/i.test(w.label || '')) ? 'on' : null;
  return q.carbon ?? null;
}

const WIN_ORDER: Record<string, number> = { '5h': 0, 'five-hour': 0, five_hour: 0, weekly: 1, week: 1 };
export function parseSummary(body: any): Win[] {
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  const out: Win[] = [];
  for (const g of groups) {
    const label = String(g?.displayName ?? g?.display_name ?? '').trim();
    const l = label.toLowerCase();
    const key = l.includes('argon') ? 'argon' : l.includes('gemini') ? 'gemini' : l.includes('claude') || l.includes('gpt') ? 'claude' : l.replace(/[^a-z0-9]+/g, '-') || 'group';
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
export const REFRESH_TIMEOUT_MS = 90000; // one hung read must never hold its account (and the refresher) forever

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

/** Gemini 4 Carbon: on / off (only disabled entries) / not listed, plus its lowest per-model quota. */
export function parseCarbon(body: any): { state: Argon; q: { frac: number; reset: string | null } | null } {
  const models = body?.models && typeof body.models === 'object' ? body.models : {};
  let state: Argon = null, q: { frac: number; reset: string | null } | null = null;
  for (const [name, info] of Object.entries<any>(models)) {
    const n = name.toLowerCase();
    if (!n.includes('carbon') || n.includes('argon')) continue;
    if (info?.disabled === true || n.includes('disabled')) { if (!state) state = 'off'; continue; }
    state = 'on';
    const qi = info?.quotaInfo;
    if (qi) {
      const f = qi.remainingFraction == null ? 0 : Number(qi.remainingFraction);
      if (Number.isFinite(f) && (!q || f < q.frac)) q = { frac: Math.max(0, Math.min(1, f)), reset: qi.resetTime ? String(qi.resetTime) : null };
    }
  }
  return { state, q };
}
export function hasClaude55(body: any): boolean {
  const models = body?.models && typeof body.models === 'object' ? body.models : {};
  return Object.entries<any>(models).some(([name, info]) => /^claude-.*5-5/i.test(name) && info?.disabled !== true && !/disabled/i.test(name));
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
  if (m.status < 200 || m.status >= 300) {
    noteAction(authId, m.body); // the link sits deep in the body; quota_err keeps only 200 chars
    throw new Error('fetchAvailableModels ' + m.status + ': ' + m.body.slice(0, 300));
  }
  let groups: Quota['groups'] = [], argon: Argon = null, carbon: Argon = null, carbonQ: Quota['carbonQ'] = null, claude55 = false;
  try {
    const j = JSON.parse(m.body);
    groups = parseModels(j); argon = parseArgon(j); claude55 = hasClaude55(j);
    ({ state: carbon, q: carbonQ } = parseCarbon(j));
  } catch { throw new Error('fetchAvailableModels: bad body'); }
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
  // quota calls keep working on a 403 account: only a healthy-looking one drops its verify / appeal link
  const row = one('SELECT auto_disabled_at FROM accounts WHERE auth_id = ?', authId);
  const bad = (cred.status === 'error' || cred.unavailable) && (!!classify(cred.statusMessage) || /payment_required|forbidden/i.test(cred.statusMessage));
  if (row && row.auto_disabled_at == null && !bad) clearAction(authId);
  return { tier, credits, groups, windows, argon, carbon, carbonQ, claude55 };
}

/** Refresh one account's quota and store it. Concurrent calls share one fetch; gives up after timeoutMs. */
export function refreshQuota(authId: string, timeoutMs = REFRESH_TIMEOUT_MS): Promise<Quota> {
  const existing = inflight.get(authId);
  if (existing) return existing;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('quota refresh timed out after ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs); });
  const p: Promise<Quota> = Promise.race([fetchQuota(authId), limit])
    .then((q) => {
      run('UPDATE accounts SET quota_json = ?, quota_at = ?, quota_err = NULL WHERE auth_id = ?', JSON.stringify(q), now(), authId);
      return q;
    })
    .catch((e) => {
      run('UPDATE accounts SET quota_at = ?, quota_err = ? WHERE auth_id = ?', now(), String(e?.message || e).slice(0, 200), authId);
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      if (inflight.get(authId) === p) inflight.delete(authId);
    });
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

let ticking = false;
/** One background pass over stale owned accounts, one at a time. A pass already running -> no-op. */
export async function refreshStale(timeoutMs = REFRESH_TIMEOUT_MS, gapMs = 2000): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // every owned account (shared or private), the ones used since their last read first
    const rows = all(`SELECT a.auth_id FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.active = 1 AND (a.quota_at IS NULL OR a.quota_at < ?)
      ORDER BY EXISTS(SELECT 1 FROM usage x WHERE x.auth_id = a.auth_id AND x.ts > COALESCE(a.quota_at, 0)) DESC, a.quota_at`,
      now() - config.quotaRefreshMinutes * 60000 + 5000);
    const c = await cpa.creds(30000).catch(() => null);
    for (const r of rows) {
      const cred = c?.byId.get(r.auth_id);
      if (!cred || cred.disabled) continue;
      await refreshQuota(r.auth_id, timeoutMs).catch((e) => {
        if (/timed out/.test(String(e?.message))) console.error('[quota] refresh timed out', r.auth_id);
      });
      await sleep(gapMs);
    }
  } finally {
    ticking = false;
  }
}

export function startQuotaRefresher() {
  if (config.quotaRefreshMinutes <= 0) return;
  const tick = () => refreshStale().catch(() => {});
  setInterval(tick, config.quotaRefreshMinutes * 60000).unref();
  setTimeout(tick, 60000).unref();
}

export function lastQuotaAt(authId: string): number {
  return Number(one('SELECT quota_at FROM accounts WHERE auth_id = ?', authId)?.quota_at || 0);
}
