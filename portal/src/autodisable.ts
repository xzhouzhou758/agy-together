// Auto-disable accounts that upstream answers with 403 (Google "Verify your account", account
// disabled/suspended) or 401 (sign-in dead after CPA's own refresh), so CPA and the scheduler plugin stop retrying them. Only accounts this
// module disabled (accounts.auto_disabled_at) are ever re-enabled, after a probe succeeds.
// Probing works on a disabled credential: CPA's /requests/api-call looks auths up by index and
// never checks Disabled. Quota calls keep working on 403 accounts, so the probe is a tiny generation.
import { config } from './config.ts';
import { all, one, run, now, type Row } from './db.ts';
import { sleep } from './util.ts';
import * as cpa from './cpa.ts';
import { noteAction, clearAction } from './accaction.ts';

const PROBE_EVERY_MS = 30 * 60000;
const QUOTA_ERR_FRESH_MS = 20 * 60000; // an older quota_err may predate a manual re-enable
const PROBE_MODEL = 'gemini-3.1-flash-lite';
// CPA only flags a credential after real traffic fails, and quota calls still work on a banned one:
// an idle account gets the probe now and then, so a ban nobody routes into still turns it off
const IDLE_MS = 60 * 60000; // no usage / added for this long -> idle; also the per-account check spacing

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

// 401 = the account's sign-in is dead (CPA already tried its refresh): turned off like a 403
const NOT_401 = /"code"\s*:\s*(429|403)\b|RESOURCE_EXHAUSTED|PERMISSION_DENIED/i;
const IS_401 = /"code"\s*:\s*401\b|UNAUTHENTICATED|invalid_grant|invalid_token|\b401\b|unauthori[sz]ed|token.{0,20}revoked|refresh.{0,20}fail/i;
function match401(s: string): string | null {
  if (!s || NOT_401.test(s) || !IS_401.test(s)) return null;
  return /invalid_grant|refresh.{0,20}fail|revoked/i.test(s) ? '401 授权已失效，需要重新登录' : '401 登录失效';
}
/** A quota read that failed because Google answered 401 (CPA management errors never count). */
function quota401(err: string): string | null {
  const m = /^fetchAvailableModels 401:\s*([\s\S]*)/.exec(err);
  return m ? match401('401 ' + m[1]) || '401 登录失效' : null;
}

/** Short reason when the account is in a 403 / 401 state, else null. 429 / quota answers never count. */
export function forbiddenReason(row: Row, cred: cpa.Cred): string | null {
  if (cred.status === 'error' || cred.unavailable) {
    const r = match403(cred.statusMessage) || match401(cred.statusMessage);
    if (r) return r;
  }
  if (row.quota_err && (!row.quota_at || Number(row.quota_at) > now() - QUOTA_ERR_FRESH_MS)) return match403(String(row.quota_err)) || quota401(String(row.quota_err));
  return null;
}

/** One tiny generation through the credential. true = works again, false = still 403 / 401, null = can't tell. */
async function probe(cred: cpa.Cred): Promise<{ ok: boolean | null; reason?: string }> {
  if (!cred.projectId) return { ok: null }; // no project: Google answers 403 "no valid license", which says nothing about the account
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
  if (r.status === 403 || reason) {
    noteAction(cred.id, r.body); // Google's verify / appeal link, shown on 我的凭证
    return { ok: false, reason: reason || '403' };
  }
  if (r.status === 401) return { ok: false, reason: match401('401 ' + r.body) || '401 登录失效' };
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
  void probe(cred).catch(() => {}); // the 403 body carries Google's verify / appeal link (noteAction)
}

const lastProbe = new Map<string, number>();
const lastIdle = new Map<string, number>(); // auth id -> last idle check
const linkTried = new Set<string>();
let running = false;

/** Enabled account with no traffic and no idle check for IDLE_MS, and not just added. */
function idleDue(row: Row): boolean {
  const t = now() - IDLE_MS;
  if ((lastIdle.get(row.auth_id) || 0) > t || Number(row.created_at || 0) > t) return false;
  return !one('SELECT 1 FROM usage WHERE auth_id = ? AND ts > ? LIMIT 1', row.auth_id, t);
}

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
        if (!reason) {
          if (!idleDue(row)) continue;
          lastIdle.set(cred.id, now());
          const p = await probe(cred).catch(() => ({ ok: null as null, reason: undefined }));
          await sleep(1000);
          if (p.ok !== false || !p.reason) continue;
          // owner may have toggled while the probe ran
          if (one('SELECT auto_disabled_at FROM accounts WHERE auth_id = ?', cred.id)?.auto_disabled_at != null) continue;
          if ((await cpa.creds(0)).byId.get(cred.id)?.disabled !== false) continue;
          linkTried.add(cred.id); // the probe just stored the link
          await cpa.setDisabled(cred.id, true);
          run('UPDATE accounts SET auto_disabled_at = ?, auto_disabled_reason = ? WHERE auth_id = ?', now(), p.reason, cred.id);
          console.log('[autodisable] disabled', cred.id, p.reason);
          continue;
        }
        await cpa.setDisabled(cred.id, true);
        run('UPDATE accounts SET auto_disabled_at = ?, auto_disabled_reason = ? WHERE auth_id = ?', now(), reason, cred.id);
        console.log('[autodisable] disabled', cred.id, reason);
        linkTried.add(cred.id);
        await probe(cred).catch(() => {}); // grab Google's verify / appeal link right away
        continue;
      }
      if (!cred.disabled) {
        // someone turned it back on (admin / CPA panel): their call
        run('UPDATE accounts SET auto_disabled_at = NULL, auto_disabled_reason = NULL WHERE auth_id = ?', cred.id);
        clearAction(cred.id);
        lastProbe.delete(cred.id);
        continue;
      }
      if (now() - Math.max(Number(row.auto_disabled_at), lastProbe.get(cred.id) || 0) < PROBE_EVERY_MS) {
        // not due yet; once per start, look for Google's verify / appeal link (result ignored: the 30 min wait stands)
        if (!row.action_url && !linkTried.has(cred.id)) {
          linkTried.add(cred.id);
          await probe(cred).catch(() => {});
        }
        continue;
      }
      lastProbe.set(cred.id, now());
      const p = await probe(cred);
      // owner may have toggled while the probe ran
      if (one('SELECT auto_disabled_at FROM accounts WHERE auth_id = ?', cred.id)?.auto_disabled_at == null) continue;
      if (p.ok === true) {
        await cpa.setDisabled(cred.id, false);
        run(`UPDATE accounts SET auto_disabled_at = NULL, auto_disabled_reason = NULL,
          quota_err = CASE WHEN quota_err LIKE '%403%' OR quota_err LIKE '%401%' THEN NULL ELSE quota_err END WHERE auth_id = ?`, cred.id);
        clearAction(cred.id);
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
