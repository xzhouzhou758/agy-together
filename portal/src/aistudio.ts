// AI Studio pool: users upload Google AI Studio web cookies, the relay (aistudio-pg-bridge
// relay-client-gateway) turns them into an OpenAI-compatible API. The relay round-robins over every
// account it holds and never drops a dead one, so the portal decides: only accounts it has seen work
// stay in the relay. Cookies are never stored here (the relay keeps them on its own disk).
import { config } from './config.ts';
import { one, all, run, now, type Row } from './db.ts';
import { HttpError } from './util.ts';

export const aistudioOn = () => !!config.aistudioRelayKey;
export const NOT_ELIGIBLE = '你在 AI Studio 池里没有有效的号，上传一个有效 Cookie 后即可使用';
const MAX_PER_USER = 20;

/** Relay account ids look like acc_ + 16 hex (computeAccountId in the relay's dashboard.js). */
export const isAIS = (id: string | null | undefined) => !!id && /^acc_[0-9a-f]{16}$/.test(id);

/** What this user may use in the AI Studio pool right now:
 *  none = no valid account of their own (refused); own = every valid account they own is private, so only
 *  those; full = they share at least one valid account, so their own plus everyone's valid shared accounts. */
export type Access = 'none' | 'own' | 'full';
export function access(userId: number): Access {
  const r = one(`SELECT COUNT(*) AS n, MAX(shared) AS s FROM aistudio_accounts WHERE owner_id = ? AND status = 'valid'`, userId);
  if (!r || !Number(r.n)) return 'none';
  return Number(r.s) ? 'full' : 'own';
}

/** Accounts one request may be served by (sent to the relay as X-Relay-Allow), with their owners.
 *  Own valid accounts (shared or not) plus, for a sharer, every valid shared account of an active user. */
export function allowFor(userId: number): { access: Access; owners: Map<string, number> } {
  const a = access(userId);
  const owners = new Map<string, number>();
  if (a === 'none') return { access: a, owners };
  const rows = all(`SELECT a.account_id, a.owner_id FROM aistudio_accounts a JOIN users u ON u.id = a.owner_id
    WHERE a.status = 'valid' AND (a.owner_id = ? OR (? = 1 AND a.shared = 1 AND u.active = 1)) ORDER BY a.account_id`, userId, a === 'full' ? 1 : 0);
  for (const r of rows) owners.set(String(r.account_id), Number(r.owner_id));
  return { access: a, owners };
}

/** Anonymous number for another user's account in someone's records. */
export function aisAnon(accountId: string): string {
  const r = one('SELECT rowid AS n FROM aistudio_accounts WHERE account_id = ?', accountId);
  return '#' + String(r?.n || 0).padStart(2, '0');
}

// ---------- relay calls ----------
type RelayReply = { status: number; j: any };
async function relay(path: string, body: unknown, timeoutMs: number): Promise<RelayReply> {
  const r = await fetch(config.aistudioRelayURL + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.aistudioRelayKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, j };
}
const relayMsg = (j: any) => String(j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || '').replace(/\s+/g, ' ').trim();

/** Remove an account from the relay. Idempotent on the relay side; throws when the relay can't be reached. */
async function relayRemove(accountId: string) {
  const r = await relay('/api/accounts/remove', { accountId }, 15000);
  if (r.status !== 200) throw new Error('relay remove ' + r.status);
}

export type Verdict = { state: 'alive' | 'dead' | 'unknown'; error?: string };
// Errors that say nothing about the account: the relay's proof server, the network, Google's 5xx.
const TRANSIENT = /proof server|network error|fetch failed|timed? ?out|timeout|aborted|socket|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|\bHTTP 5\d\d\b/i;
/** Read a relay /api/accounts/test reply (or the error thrown while asking). */
export function classify(r: RelayReply | Error): Verdict {
  if (r instanceof Error) return { state: 'unknown', error: r.message };
  if (r.status === 404) return { state: 'dead', error: '中转里找不到这个号' };
  if (r.status !== 200 || !r.j) return { state: 'unknown', error: `中转返回 ${r.status}` };
  if (r.j.alive === true) return { state: 'alive' };
  const err = String(r.j.error || '').replace(/\s+/g, ' ').trim();
  if (!err || TRANSIENT.test(err)) return { state: 'unknown', error: err || 'unknown' };
  return { state: 'dead', error: err };
}
async function testAccount(accountId: string): Promise<Verdict> {
  try {
    return classify(await relay('/api/accounts/test', { accountId }, 120000));
  } catch (e) {
    return classify(e as Error);
  }
}

// One relay operation at a time: uploads, re-checks and deletes never interleave.
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = lock.then(fn);
  lock = job.catch(() => {});
  return job;
}

// ---------- views ----------
export function view(r: Row) {
  return { id: r.account_id, tier: r.tier || null, label: r.label || null, status: r.status, shared: !!r.shared, checkedAt: r.last_checked_at || null, error: r.last_error || null, created: r.created_at };
}
export function listFor(userId: number) {
  return all('SELECT * FROM aistudio_accounts WHERE owner_id = ? ORDER BY created_at', userId).map(view);
}
export function listAll() {
  return all(`SELECT a.*, u.name AS owner_name FROM aistudio_accounts a LEFT JOIN users u ON u.id = a.owner_id ORDER BY a.status DESC, a.created_at`)
    .map((r) => ({ ...view(r), ownerId: r.owner_id, owner: r.owner_name || '' }));
}

const short = (s: string | undefined) => (s ? s.slice(0, 200) : null);
function markDead(accountId: string, error: string | undefined, inRelay: boolean) {
  run(`UPDATE aistudio_accounts SET status = 'dead', in_relay = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE account_id = ?`,
    inRelay ? 1 : 0, now(), short(error), now(), accountId);
}

// ---------- upload ----------
export async function upload(userId: number, cookies: string, shared = true) {
  if (!aistudioOn()) throw new HttpError(404, 'not_found');
  const text = cookies.trim();
  if (!text) throw new HttpError(400, 'aistudio_cookie', '请粘贴 Cookie');
  if (text.length > 65536) throw new HttpError(400, 'aistudio_cookie', 'Cookie 太长');
  return serial(async () => {
    let add: RelayReply;
    try {
      add = await relay('/api/accounts/add', { cookies: text }, 30000);
    } catch {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 中转暂时连不上，请稍后再试');
    }
    const acc = add.j?.account;
    if (add.status !== 200 || !acc?.accountId) {
      if (add.status === 401 || add.status === 403) throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 中转暂时连不上，请稍后再试');
      throw new HttpError(400, 'aistudio_cookie', relayMsg(add.j) || 'Cookie 无效');
    }
    const id = String(acc.accountId);
    const tier = acc.g1Tier ? String(acc.g1Tier).slice(0, 20) : null;
    const existing = one('SELECT * FROM aistudio_accounts WHERE account_id = ?', id);
    if (existing && existing.owner_id !== userId) {
      // the add just refreshed that owner's cookies; take the account back out only if it wasn't serving
      if (existing.status !== 'valid') await relayRemove(id).catch(() => {});
      throw new HttpError(409, 'aistudio_taken', '这个号已经被别人上传过');
    }
    if (!existing && Number(one(`SELECT COUNT(*) AS n FROM aistudio_accounts WHERE owner_id = ?`, userId)?.n || 0) >= MAX_PER_USER) {
      await relayRemove(id).catch(() => {});
      throw new HttpError(400, 'aistudio_too_many', `每人最多 ${MAX_PER_USER} 个号`);
    }
    const v = await testAccount(id);
    if (v.state === 'alive') {
      // a re-upload keeps the owner's share choice
      run(`INSERT INTO aistudio_accounts(account_id, owner_id, tier, status, in_relay, last_checked_at, last_error, created_at, updated_at, shared)
           VALUES(?,?,?,'valid',1,?,NULL,?,?,?)
           ON CONFLICT(account_id) DO UPDATE SET tier = excluded.tier, status = 'valid', in_relay = 1, last_checked_at = excluded.last_checked_at, last_error = NULL, updated_at = excluded.updated_at`,
        id, userId, tier, now(), now(), now(), shared ? 1 : 0);
      return view(one('SELECT * FROM aistudio_accounts WHERE account_id = ?', id)!);
    }
    if (v.state === 'unknown' && existing?.status === 'valid') {
      // couldn't verify the new cookies, but the account was working: keep it (the relay now has the new cookies)
      throw new HttpError(503, 'aistudio_check_failed', '暂时无法检测这个号，请稍后再试');
    }
    let removed = true;
    try { await relayRemove(id); } catch { removed = false; }
    if (existing) markDead(id, v.error, !removed);
    if (v.state === 'unknown') throw new HttpError(503, 'aistudio_check_failed', '暂时无法检测这个号，请稍后再试');
    throw new HttpError(400, 'aistudio_dead', '这个号无效' + (v.error ? '：' + v.error.slice(0, 160) : ''));
  });
}

// ---------- share ----------
/** Owner only: may other users' requests be served by this account? */
export function setShared(userId: number, accountId: string, shared: boolean) {
  if (!aistudioOn()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio_accounts WHERE account_id = ?', accountId);
  if (!row || row.owner_id !== userId) throw new HttpError(404, 'not_found');
  run('UPDATE aistudio_accounts SET shared = ?, updated_at = ? WHERE account_id = ?', shared ? 1 : 0, now(), accountId);
  return view(one('SELECT * FROM aistudio_accounts WHERE account_id = ?', accountId)!);
}

// ---------- re-check ----------
/** Test one valid account; mark it dead (and take it out of the relay) only on a definite failure. */
async function checkLocked(accountId: string): Promise<Verdict['state'] | 'skip'> {
  const row = one('SELECT * FROM aistudio_accounts WHERE account_id = ?', accountId);
  if (!row || row.status !== 'valid') return 'skip';
  const v = await testAccount(accountId);
  if (v.state === 'alive') {
    run('UPDATE aistudio_accounts SET last_checked_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ?', now(), now(), accountId);
  } else if (v.state === 'dead') {
    let removed = true;
    try { await relayRemove(accountId); } catch { removed = false; }
    markDead(accountId, v.error, !removed);
  } else {
    console.warn('[aistudio] check inconclusive', accountId, v.error);
  }
  return v.state;
}
export async function recheck(userId: number, accountId: string, admin = false) {
  if (!aistudioOn()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio_accounts WHERE account_id = ?', accountId);
  if (!row || (!admin && row.owner_id !== userId)) throw new HttpError(404, 'not_found');
  if (row.status !== 'valid') throw new HttpError(400, 'aistudio_dead', '这个号已失效，请重新上传');
  const state = await serial(() => checkLocked(accountId));
  return { state, account: view(one('SELECT * FROM aistudio_accounts WHERE account_id = ?', accountId)!) };
}

/** Every valid account, one after another; also finishes removals that failed earlier and drops relay
 *  accounts the portal doesn't consider valid. */
export async function sweep() {
  if (!aistudioOn()) return { checked: 0, dead: 0 };
  return serial(async () => {
    let checked = 0, dead = 0;
    for (const r of all(`SELECT account_id FROM aistudio_accounts WHERE status = 'valid' ORDER BY last_checked_at`)) {
      const s = await checkLocked(r.account_id);
      if (s !== 'skip') checked++;
      if (s === 'dead') dead++;
    }
    for (const r of all(`SELECT account_id FROM aistudio_accounts WHERE status != 'valid' AND in_relay = 1`)) {
      try { await relayRemove(r.account_id); run('UPDATE aistudio_accounts SET in_relay = 0 WHERE account_id = ?', r.account_id); } catch {}
    }
    // the relay should hold exactly the valid accounts
    try {
      const r = await fetch(config.aistudioRelayURL + '/api/status', { headers: { Authorization: 'Bearer ' + config.aistudioRelayKey }, signal: AbortSignal.timeout(30000) });
      const j: any = r.ok ? await r.json() : null;
      if (Array.isArray(j?.accounts)) {
        const valid = new Set(all(`SELECT account_id FROM aistudio_accounts WHERE status = 'valid'`).map((x) => x.account_id));
        for (const a of j.accounts) {
          const id = String(a?.accountId || '');
          if (id && !valid.has(id)) await relayRemove(id).catch(() => {});
        }
      }
    } catch {}
    return { checked, dead };
  });
}

// ---------- delete ----------
export async function remove(userId: number, accountId: string, admin = false) {
  if (!aistudioOn()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio_accounts WHERE account_id = ?', accountId);
  if (!row || (!admin && row.owner_id !== userId)) throw new HttpError(404, 'not_found');
  await serial(async () => {
    try {
      await relayRemove(accountId);
    } catch {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 中转暂时连不上，请稍后再试');
    }
    run('DELETE FROM aistudio_accounts WHERE account_id = ?', accountId);
  });
  return { ok: true };
}

export function startAIStudioRecheck(): void {
  if (!aistudioOn() || config.aistudioRecheckMinutes <= 0) return;
  const tick = () => sweep().catch((e) => console.error('[aistudio] recheck failed', (e as Error).message));
  setInterval(tick, config.aistudioRecheckMinutes * 60000).unref();
}
