// 大锅饭 daily request limit: every shared-pool request counts (success or not), except the ones
// refused by this limit itself or by the user's 输入上限. limit = dailyBase + dailyPer × valid credentials, where a valid
// credential is the user's own, shared, enabled, Pro or Ultra, and without a problem (verify / login / banned / 403).
// users.daily_limit overrides it (-1 = unlimited); admins are unlimited unless overridden.
import { one, all, getRules, getSetting, setSetting } from './db.ts';
import * as cpa from './cpa.ts';
import { accountProblem } from './bot.ts';
import { storedQuota } from './quota.ts';

/** Pro / Ultra plan (from the stored quota); free accounts and accounts not read yet don't add requests. */
export const isPaid = (row: any) => /pro|ultra/i.test(String(storedQuota(row)?.tier || ''));

export function dayStart(t = Date.now()): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function secondsToMidnight(): number {
  return Math.max(1, Math.ceil((dayStart() + 86400e3 - Date.now()) / 1000));
}

export type Daily = { used: number; limit: number | null; valid: number; base: number; per: number; override: number | null };
export function validShared(userId: number, c: cpa.Creds): number {
  return all('SELECT * FROM accounts WHERE owner_id = ? AND shared = 1 AND suspended = 0', userId)
    .filter((r) => { const cr = c.byId.get(r.auth_id); return !!cr && !cr.disabled && !accountProblem(r, cr) && isPaid(r); }).length;
}
export function usedToday(userId: number): number {
  return Number(one(`SELECT COUNT(*) AS n FROM usage WHERE user_id = ? AND pool = 'shared' AND ts >= ? AND result NOT IN ('daily_limit', 'input_limit')`, userId, dayStart())?.n || 0);
}
export async function dailyFor(userId: number): Promise<Daily> {
  return dailyWith(userId, await cpa.creds(10000));
}
export function dailyWith(userId: number, c: cpa.Creds): Daily {
  const u = one('SELECT role, daily_limit FROM users WHERE id = ?', userId);
  const r = getRules();
  const valid = validShared(userId, c);
  const override = u?.daily_limit == null ? null : Number(u.daily_limit);
  const limit = override != null ? (override < 0 ? null : override) : u?.role === 'admin' ? null : r.dailyBase + r.dailyPer * valid;
  return { used: usedToday(userId), limit, valid, base: r.dailyBase, per: r.dailyPer, override };
}

// ---------- models the admin opened for the 大锅饭 (NULL = all) ----------
let sharedCache: Set<string> | null | undefined;
export function sharedModels(): Set<string> | null {
  if (sharedCache !== undefined) return sharedCache;
  try { const v = JSON.parse(getSetting('shared_models') || 'null'); sharedCache = Array.isArray(v) ? new Set(v.map(String)) : null; } catch { sharedCache = null; }
  return sharedCache;
}
export function setSharedModels(list: string[] | null) {
  setSetting('shared_models', JSON.stringify(list));
  sharedCache = undefined;
}
export const sharedAllows = (model: string) => { const s = sharedModels(); return !s || s.has(model); };
