// Stores the verify / appeal link from an upstream 403 body on the account row (accounts.action_*),
// and drops it again once the account works, so a stale link never lingers on a healthy account.
import { run, now } from './db.ts';
import { extractAction, safeGoogleURL, type Action } from './accerr.ts';

/** Remember the link in this body, if any. Returns what was stored. */
export function noteAction(authId: string, body: string | null | undefined): Action | null {
  const a = extractAction(body);
  if (a) run('UPDATE accounts SET action_url = ?, action_kind = ?, action_at = ? WHERE auth_id = ?', a.url, a.kind, now(), authId);
  return a;
}

export function clearAction(authId: string): void {
  run('UPDATE accounts SET action_url = NULL, action_kind = NULL, action_at = NULL WHERE auth_id = ? AND action_url IS NOT NULL', authId);
}

export function actionOf(row: { action_url?: unknown; action_kind?: unknown } | null | undefined): Action | null {
  const url = row?.action_url ? safeGoogleURL(String(row.action_url)) : null;
  return url ? { kind: row!.action_kind === 'appeal' ? 'appeal' : 'verify', url } : null;
}
