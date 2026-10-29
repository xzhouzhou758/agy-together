// 大锅饭 resources: what the shared accounts have left, summed per quota family, from the stored
// quota snapshots (no upstream calls). Admins get one row per account; everyone else the totals.
import { all, one, now, counted } from './db.ts';
import * as cpa from './cpa.ts';
import { accountProblem } from './bot.ts';
import { storedQuota, reserveOf } from './quota.ts';
import { dayStart, sharedModels } from './limits.ts';
import { enabledUpstreams } from './upstream.ts';

type Fam = 'gemini' | 'claude' | 'argon';
const FAMS: Fam[] = ['gemini', 'claude', 'argon'];
type Win = { frac: number; reset: string | null };
type AccWins = Partial<Record<Fam, { h5?: Win; weekly?: Win }>>;

/** Remaining fraction per family and window, from the summary windows (Gemini, Claude) and the per-model groups (Argon). */
function windowsOf(q: ReturnType<typeof storedQuota>): AccWins {
  const out: AccWins = {};
  if (!q) return out;
  for (const w of q.windows || []) {
    const f: Fam | null = w.key === 'gemini' ? 'gemini' : w.key === 'claude' ? 'claude' : null;
    if (!f) continue;
    for (const b of w.buckets) if (b.window === '5h' || b.window === 'weekly') (out[f] ||= {})[b.window === '5h' ? 'h5' : 'weekly'] = { frac: b.frac, reset: b.reset };
  }
  const g = (k: string) => q.groups?.find((x) => x[0] === k);
  const ar = g('ar');
  if (ar) out.argon = { weekly: { frac: ar[1], reset: ar[2] } };
  // older snapshots without summary windows: fall back to the per-model groups
  if (!out.gemini) { const x = [g('gp'), g('gf')].filter(Boolean) as [string, number, string | null][]; if (x.length) { const m = x.reduce((a, b) => (b[1] < a[1] ? b : a)); out.gemini = { weekly: { frac: m[1], reset: m[2] } }; } }
  if (!out.claude) { const c = g('cl'); if (c) out.claude = { weekly: { frac: c[1], reset: c[2] } }; }
  return out;
}
/** What the pool can still use of a window: the part above the owner's self-use reserve. */
const usable = (w: Win | undefined, reserve: number) => (w ? Math.max(0, w.frac - reserve / 100) : 0);

function famOpen(f: Fam): boolean {
  const s = sharedModels();
  if (!s) return true;
  return [...s].some((m) => { const l = m.toLowerCase(); return f === 'argon' ? l.includes('argon') : f === 'claude' ? /^(claude|gpt)/.test(l) : !l.includes('argon') && !/^(claude|gpt)/.test(l); });
}

export async function poolResources(full: boolean) {
  const c = await cpa.creds(10000);
  const rows = all(`SELECT a.*, u.name AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.shared = 1 AND a.suspended = 0 AND u.active = 1`)
    .filter((r) => c.byId.has(r.auth_id));
  const tok = 'COALESCE(total_tok, COALESCE(in_tok,0) + COALESCE(out_tok,0))';
  const today = new Map(all(`SELECT auth_id, COUNT(*) AS n, SUM(${tok}) AS t FROM usage WHERE pool = 'shared' AND ts >= ? AND auth_id IS NOT NULL AND ${counted()} GROUP BY auth_id`, dayStart())
    .map((r) => [r.auth_id, { n: Number(r.n), t: Number(r.t || 0) }]));

  const fam = Object.fromEntries(FAMS.map((f) => [f, { open: famOpen(f), accounts: 0, off: 0, full: 0, h5: { sum: 0, ok: 0, n: 0, next: null as string | null }, weekly: { sum: 0, ok: 0, n: 0, next: null as string | null } }]));
  const counts = { total: rows.length, ok: 0, cooldown: 0, problem: 0, off: 0, noData: 0, pro: 0, ultra: 0, free: 0 };
  let oldest: number | null = null;
  const list: any[] = [];

  for (const r of rows) {
    const cred = c.byId.get(r.auth_id)!;
    const q = storedQuota(r);
    const tier = String(q?.tier || '').toLowerCase();
    if (tier.includes('ultra')) counts.ultra++; else if (tier.includes('pro')) counts.pro++; else counts.free++;
    const prob = accountProblem(r, cred);
    const retry = cred.nextRetryAfter && Date.parse(cred.nextRetryAfter) > Date.now();
    const state = cred.disabled ? 'off' : prob ? 'problem' : retry || cred.unavailable ? 'cooldown' : 'ok';
    counts[state]++;
    if (!q) counts.noData++;
    if (r.quota_at && (oldest == null || r.quota_at < oldest)) oldest = r.quota_at;
    const reserve = reserveOf(r), W = windowsOf(q);
    if (q?.argon === 'off') { delete W.argon; if (state !== 'off') fam.argon.off++; } // Argon not enabled on this account
    if (state !== 'off' && state !== 'problem') {
      for (const f of FAMS) {
        const w = W[f];
        if (!w) continue;
        const F = fam[f];
        F.accounts++;
        // a window family is only as available as its tightest window
        F.full += Math.min(usable(w.h5 ?? w.weekly, reserve), usable(w.weekly ?? w.h5, reserve));
        for (const k of ['h5', 'weekly'] as const) {
          const x = w[k];
          if (!x) continue;
          const u = usable(x, reserve);
          F[k].n++; F[k].sum += u;
          if (u > 0.005) F[k].ok++;
          if (x.reset && x.frac < 0.999 && (!F[k].next || Date.parse(x.reset) < Date.parse(F[k].next!))) F[k].next = x.reset;
        }
      }
    }
    if (full) {
      list.push({
        id: r.auth_id, email: cred.email || r.email || '', owner: r.owner || '', tier: q?.tier || null, state,
        problem: prob?.label || null, reserve, quotaAt: r.quota_at || null, argon: q?.argon ?? null,
        wins: Object.fromEntries(FAMS.filter((f) => W[f]).map((f) => [f, { h5: W[f]!.h5 || null, weekly: W[f]!.weekly || null }])),
        today: today.get(r.auth_id) || { n: 0, t: 0 },
      });
    }
  }
  for (const f of FAMS) fam[f].full = Math.round(fam[f].full * 10) / 10;
  const ups = enabledUpstreams().length;
  return { at: now(), oldest, counts, fam, upstreams: ups, backup: backupUse(tok), shared: sharedUse(tok), ...(full ? { accounts: list } : {}) };
}

function used(tok: string, where: string, since: number) {
  const r = one(`SELECT COUNT(*) AS n, SUM(result = 'ok') AS ok, SUM(${tok}) AS t FROM usage WHERE ${where} AND ts >= ?`, since);
  return { n: Number(r?.n || 0), ok: Number(r?.ok || 0), t: Number(r?.t || 0) };
}
/** 大锅饭号池: what the shared Google accounts served for 大锅饭 keys (the backup upstreams excluded). */
function sharedUse(tok: string) {
  const w = `pool = 'shared' AND auth_id IS NOT NULL AND auth_id NOT LIKE 'up:%' AND ${counted()}`;
  return { today: used(tok, w, dayStart()), week: used(tok, w, now() - 7 * 86400e3), total: used(tok, w, 0),
    since: Number(one(`SELECT MIN(ts) AS t FROM usage WHERE ${w}`)?.t || 0) || null };
}
/** 站长兜底公益池: what the admin's external upstreams (auth_id up:N) served for the 大锅饭. */
function backupUse(tok: string) {
  const q = (since: number) => used(tok, "auth_id LIKE 'up:%'", since);
  const day = dayStart();
  const pool = Number(one(`SELECT COUNT(*) AS n FROM usage WHERE pool = 'shared' AND auth_id IS NOT NULL AND ${counted()} AND ts >= ?`, day)?.n || 0);
  const today = q(day);
  return { today, week: q(now() - 7 * 86400e3), total: q(0), share: pool ? Math.round((today.n / pool) * 1000) / 10 : 0,
    since: Number(one(`SELECT MIN(ts) AS t FROM usage WHERE auth_id LIKE 'up:%'`)?.t || 0) || null };
}
