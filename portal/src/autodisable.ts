// Auto-disable accounts that upstream answers with 403 (Google "Verify your account", account
// disabled/suspended), so CPA and the scheduler plugin stop retrying them. Only accounts this
// module disabled (accounts.auto_disabled_at) are ever re-enabled, after a probe succeeds.
// Probing works on a disabled credential: CPA's /requests/api-call looks auths up by index and
// never checks Disabled. Quota calls keep working on 403 accounts, so the probe is a tiny generation.
import { config } from './config.ts';
import { all, one, run, now, type Row } from './db.ts';
import { sleep } from './util.ts';
import * as cpa from './cpa.ts';

const PROBE_EVERY_MS = 30 * 60000;
const QUOTA_ERR_FRESH_MS = 20 * 60000; // an older quota_err may predate a manual re-enable
const PROBE_MODEL = 'gemini-3.1-flash-lite';

// structured "not a 403" markers win over everything; loose ones only lose to strong 403 markers
const NOT_403 = /"code"\s*:\s*(429|401)\b|RESOURCE_EXHAUSTED|UNAUTHENTICATED|invalid_grant/i;
const STRONG_403 = /"code"\s*:\s*403\b|PERMISSION_DENIED|verify your account|VALIDATION_REQUIRED/i;
const LOOSE_NOT = /\b(429|401)\b|quota|rate.?limit|cool.?down|too many requests|unauthori[sz]ed|expired/i;
const LOOSE_403 = /\b403\b|forbidden|\b(account|user|project)\b.{0,40}\b(disabled|suspended)\b|has been (disabled|suspended)|\bsuspended\b/i;

function match403(s: string): string | null {
  if (!s || NOT_403.test(s)) return null;
  if (!STRONG_403.test(s) && (LOOSE_NOT.test(s) || !LOOSE_403.test(s))) return null;
  const m = /"message"\s*:\s*"([^"]{1,160})"/.exec(s);
  return ('403 ' + (m ? m[1] : s.replace(/\s+/g, ' ').trim())).slice(0, 160);
}

/** Short reason when the account is in a 403 state, else null. 429 / 401 / invalid_grant never count. */
export function forbiddenReason(row: Row, cred: cpa.Cred): string | null {
  if (cred.status === 'error' || cred.unavailable) {
    const r = match403(cred.statusMessage);
    if (r) return r;
  }
  if (row.quota_err && (!row.quota_at || Number(row.quota_at) > now() - QUOTA_ERR_FRESH_MS)) return match403(String(row.quota_err));
  return null;
}

/** One tiny generation through the credential. true = works again, false = still 403, null = can't tell. */
async function probe(cred: cpa.Cred): Promise<{ ok: boolean | null; reason?: string }> {
  const headers = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': config.quotaUserAgent };
  const body = {
    model: PROBE_MODEL, userAgent: 'antigravity', requestType: 'agent', project: cred.projectId, requestId: 'agent-' + crypto.randomUUID(),
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 }, sessionId: crypto.randomUUID() },
  };
  let r: { status: number; body: string };
  try {
    r = await cpa.apiCall(cred.authIndex, 'POST', config.quotaBaseURL + '/v1internal:generateContent', headers, JSON.stringify(body));
  } catch {
    return { ok: null }; // CPA down or token refresh failed
  }
  const reason = match403(r.status + ' ' + r.body);
  if (r.status === 403 || reason) return { ok: false, reason: reason || '403' };
  // 2xx works; 429 is plain quota (CPA cools it down); 400/404 got past the permission check
  if ((r.status >= 200 && r.status < 300) || r.status === 400 || r.status === 404 || r.status === 429) return { ok: true };
  return { ok: null };
}

/** Turn a 403 account off now (the bot saw it between sweeps); the regular probe turns it back on once it works. */
export async function disableForbidden(cred: cpa.Cred, reason: string): Promise<void> {
  const row = one('SELECT auto_disabled_at FROM accounts WHERE auth_id = ?', cred.id);
  if (!row || row.auto_disabled_at != null || cred.disabled) return;
  await cpa.setDisabled(cred.id, true);
  run('UPDATE accounts SET auto_disabled_at = ?, auto_disabled_reason = ? WHERE auth_id = ?', now(), reason, cred.id);
  console.log('[autodisable] disabled', cred.id, reason);
}

const lastProbe = new Map<string, number>();
let running = false;

export async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await cpa.refreshCreds(); // creds(0) may still serve a list from the same millisecond
    const c = await cpa.creds();
    const rows = all('SELECT * FROM accounts WHERE owner_id IS NOT NULL AND suspended = 0');
    for (const row of rows) {
      const cred = c.byId.get(row.auth_id);
      if (!cred) continue;
      if (row.auto_disabled_at == null) {
        if (cred.disabled) continue; // off by hand: not ours
        const reason = forbiddenReason(row, cred);
        if (!reason) continue;
        await cpa.setDisabled(cred.id, true);
        run('UPDATE accounts SET auto_disabled_at = ?, auto_disabled_reason = ? WHERE auth_id = ?', now(), reason, cred.id);
        console.log('[autodisable] disabled', cred.id, reason);
        continue;
      }
      if (!cred.disabled) {
        // someone turned it back on (admin / CPA panel): their call
        run('UPDATE accounts SET auto_disabled_at = NULL, auto_disabled_reason = NULL WHERE auth_id = ?', cred.id);
        lastProbe.delete(cred.id);
        continue;
      }
      if (now() - Math.max(Number(row.auto_disabled_at), lastProbe.get(cred.id) || 0) < PROBE_EVERY_MS) continue;
      lastProbe.set(cred.id, now());
      const p = await probe(cred);
      // owner may have toggled while the probe ran
      if (one('SELECT auto_disabled_at FROM accounts WHERE auth_id = ?', cred.id)?.auto_disabled_at == null) continue;
      if (p.ok === true) {
        await cpa.setDisabled(cred.id, false);
        run(`UPDATE accounts SET auto_disabled_at = NULL, auto_disabled_reason = NULL,
          quota_err = CASE WHEN quota_err LIKE '%403%' THEN NULL ELSE quota_err END WHERE auth_id = ?`, cred.id);
        lastProbe.delete(cred.id);
        console.log('[autodisable] re-enabled', cred.id);
      } else if (p.ok === false && p.reason) {
        run('UPDATE accounts SET auto_disabled_reason = ? WHERE auth_id = ?', p.reason, cred.id);
      }
      await sleep(1000);
    }
  } finally {
    running = false;
  }
}

export function startAutoDisable(): void {
  const tick = () => sweep().catch((e) => console.error('[autodisable] sweep failed', (e as Error).message));
  setInterval(tick, 5 * 60000).unref();
  setTimeout(tick, 60000).unref();
}
