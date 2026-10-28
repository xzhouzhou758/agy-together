// 闲置自动休眠 (per-user switch, 小锅饭 accounts only): an account not in 大锅饭 that hasn't served a
// request for IDLE_MS is disabled in CPA and marked accounts.sleep_at. The owner's next request wakes
// every sleeping account of theirs (gateway.ts); a generation request gets 「凭证正在启动，请重试」.
// Only accounts this module put to sleep are ever woken; a manual on/off clears the mark.
import { all, run, now } from './db.ts';
import * as cpa from './cpa.ts';

export const IDLE_MS = 60 * 60000;
const EVERY_MS = 5 * 60000;

export async function sweep() {
  const c = await cpa.creds(30000);
  const rows = all(`SELECT a.auth_id, a.created_at,
      (SELECT MAX(ts) FROM usage x WHERE x.auth_id = a.auth_id) AS last_used
    FROM accounts a JOIN users u ON u.id = a.owner_id
    WHERE u.active = 1 AND u.auto_sleep = 1 AND a.shared = 0 AND a.sleep_at IS NULL AND a.auto_disabled_at IS NULL AND a.suspended = 0`);
  const cut = now() - IDLE_MS;
  for (const r of rows) {
    const cred = c.byId.get(r.auth_id);
    if (!cred || cred.disabled) continue;
    if (Math.max(Number(r.last_used) || 0, Number(r.created_at) || 0) > cut) continue;
    try {
      await cpa.setDisabled(r.auth_id, true);
      run('UPDATE accounts SET sleep_at = ? WHERE auth_id = ?', now(), r.auth_id);
    } catch (e) {
      console.error('[autosleep] sleep failed', r.auth_id, (e as Error).message);
    }
  }
}

/** Wake the user's sleeping 小锅饭 accounts. Returns how many were woken. */
export async function wakeFor(userId: number): Promise<number> {
  const rows = all('SELECT auth_id FROM accounts WHERE owner_id = ? AND sleep_at IS NOT NULL', userId);
  let n = 0;
  for (const r of rows) {
    try {
      await cpa.setDisabled(r.auth_id, false);
      run('UPDATE accounts SET sleep_at = NULL WHERE auth_id = ?', r.auth_id);
      n++;
    } catch (e) {
      console.error('[autosleep] wake failed', r.auth_id, (e as Error).message);
    }
  }
  return n;
}

export function startAutoSleep(): void {
  const tick = () => sweep().catch((e) => console.error('[autosleep] sweep failed', (e as Error).message));
  setInterval(tick, EVERY_MS).unref();
  setTimeout(tick, 90000).unref();
}
