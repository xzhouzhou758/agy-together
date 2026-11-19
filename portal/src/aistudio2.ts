// AI Studio 2 pool ("AI Studio（新后端）"): backed by Mag1cFall/AIStudio2API (Go + SpiderMonkey WAA).
// Cookies live only inside AIStudio2API; the portal stores ownership (ais2_<16hex> -> email -> owner_id),
// enforces the same none / own / full sharing rules, pins each gateway request via X-AIStudio-Account,
// Global sharing policy restricts all protocols to the owner when disabled.
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { one, all, run, now, getSetting, type Row } from './db.ts';
import { HttpError } from './util.ts';

export const aistudio2On = () => !!config.aistudio2Key;
export const NOT_ELIGIBLE_2 = '你在 AI Studio（新后端）池里没有有效的号，上传一个有效 Cookie 后即可使用';
const MAX_PER_USER = 20;

export const ais2Id = (email: string) =>
  'ais2_' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);

export const isAIS2 = (id: string | null | undefined) => !!id && /^ais2_[0-9a-f]{16}$/.test(id);

export const sharingEnabled = () => false;

export type Access = 'none' | 'own' | 'full';
export function access(userId: number): Access {
  const r = one(`SELECT COUNT(*) AS n, MAX(shared) AS s FROM aistudio2_accounts WHERE owner_id = ? AND status = 'valid'`, userId);
  if (!r || !Number(r.n)) return 'none';
  return 'own';
}

export type AllowedAcc = { id: string; email: string; ownerId: number };
export function allowFor(userId: number): { access: Access; owners: Map<string, AllowedAcc> } {
  const a = access(userId);
  const owners = new Map<string, AllowedAcc>();
  if (a === 'none') return { access: a, owners };
  const rows = all(`SELECT a.account_id, a.email, a.owner_id FROM aistudio2_accounts a JOIN users u ON u.id = a.owner_id
    WHERE a.status = 'valid' AND (a.owner_id = ? OR (? = 1 AND a.shared = 1 AND u.active = 1)) ORDER BY a.account_id`,
    userId, a === 'full' ? 1 : 0);
  for (const r of rows) {
    const id = String(r.account_id);
    owners.set(id, { id, email: String(r.email), ownerId: Number(r.owner_id) });
  }
  return { access: a, owners };
}

export function ais2Anon(accountId: string): string {
  const r = one('SELECT rowid AS n FROM aistudio2_accounts WHERE account_id = ?', accountId);
  return '#' + String(r?.n || 0).padStart(2, '0');
}

export function ais2Email(accountId: string): string {
  const r = one('SELECT email FROM aistudio2_accounts WHERE account_id = ?', accountId);
  return r?.email ? String(r.email) : accountId;
}

// ---------- AIStudio2API admin client ----------
type ApiReply = { status: number; j: any; text: string };
let adminCookie = '';

async function loginAdmin(): Promise<string> {
  if (!config.aistudio2AdminPass) return '';
  const r = await fetch(config.aistudio2URL + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.aistudio2AdminUser || 'admin',
      password: config.aistudio2AdminPass,
      remember: true,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('aistudio2 login ' + r.status);
  for (const c of r.headers.getSetCookie()) {
    if (c.startsWith('aistudio_admin=')) {
      adminCookie = c.split(';')[0];
      return adminCookie;
    }
  }
  return adminCookie;
}

async function adminReq(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<ApiReply> {
  if (config.aistudio2AdminPass && !adminCookie) await loginAdmin();
  const once = async (): Promise<ApiReply> => {
    const headers: Record<string, string> = {};
    if (adminCookie) headers.Cookie = adminCookie;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(config.aistudio2URL + path, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, j, text };
  };
  let rep = await once();
  if (rep.status === 401 && config.aistudio2AdminPass) {
    adminCookie = '';
    await loginAdmin();
    rep = await once();
  }
  return rep;
}

const apiMsg = (j: any) =>
  String(j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || '').replace(/\s+/g, ' ').trim();

async function backendRemove(email: string) {
  const r = await adminReq('DELETE', '/api/accounts/' + encodeURIComponent(email), undefined, 15000);
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
    throw new Error('aistudio2 remove ' + r.status);
  }
}

async function ensureStarted() {
  try {
    const st = await adminReq('GET', '/api/status', undefined, 10000);
    if (st.status === 200 && st.j && st.j.running === false) {
      await adminReq('POST', '/api/control/start', {}, 15000);
    }
  } catch {}
}

/** Support Cookie-Editor JSON, raw header, Netscape, AND the old Tampermonkey {cookies, authUser} wrapper. */
export function unwrapCookieInput(raw: string): { cookieText: string; preferredAuthUser: number | null } {
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.cookies === 'string' && j.cookies.trim()) {
        const au = Number(j.authUser);
        return { cookieText: j.cookies.trim(), preferredAuthUser: Number.isInteger(au) && au >= 0 ? au : null };
      }
    } catch {}
  }
  return { cookieText: t, preferredAuthUser: null };
}

export type Verdict = { state: 'alive' | 'dead' | 'unknown'; tier?: string | null; error?: string };
const TRANSIENT = /network error|fetch failed|timed? ?out|timeout|aborted|socket|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|\bHTTP 5\d\d\b|temporarily unavailable/i;

function normTier(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().toUpperCase().slice(0, 20);
}

async function refreshAccount(email: string): Promise<Verdict> {
  let r: ApiReply;
  try {
    r = await adminReq('POST', `/api/accounts/${encodeURIComponent(email)}/refresh`, {}, 90000);
  } catch (e) {
    return { state: 'unknown', error: (e as Error).message };
  }
  if (r.status === 404) return { state: 'dead', error: '新后端里找不到这个号' };
  if (r.status >= 500) {
    const msg = apiMsg(r.j) || `新后端返回 ${r.status}`;
    return TRANSIENT.test(msg) || r.status === 502 || r.status === 503 || r.status === 504
      ? { state: 'unknown', error: msg }
      : { state: 'unknown', error: msg };
  }
  const acc = r.j?.account;
  if (r.status === 200 && acc) {
    if (acc.state === 'ready' && acc.enabled !== false) {
      return { state: 'alive', tier: normTier(acc.benefit_tier || r.j?.tier) };
    }
    if (acc.state === 'auth_required' || acc.state === 'restricted' || acc.enabled === false) {
      return { state: 'dead', error: String(acc.message || acc.state || '账号已失效').slice(0, 200) };
    }
  }
  const msg = apiMsg(r.j) || `新后端返回 ${r.status}`;
  if (r.status === 400 || r.status === 401 || r.status === 403) return { state: 'dead', error: msg };
  return { state: 'unknown', error: msg };
}

// Serialize mutations & checks so imports, refreshes and deletes do not interleave.
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = lock.then(fn);
  lock = job.catch(() => {});
  return job;
}

// ---------- views ----------
export function view(r: Row) {
  return {
    id: r.account_id,
    email: r.email || null,
    tier: r.tier || null,
    label: r.label || r.email || null,
    status: r.status,
    shared: !!r.shared,
    checkedAt: r.last_checked_at || null,
    error: r.last_error || null,
    created: r.created_at,
  };
}
export function listFor(userId: number) {
  return all('SELECT * FROM aistudio2_accounts WHERE owner_id = ? ORDER BY created_at', userId).map(view);
}
export function listAll() {
  return all(`SELECT a.*, u.name AS owner_name FROM aistudio2_accounts a LEFT JOIN users u ON u.id = a.owner_id ORDER BY a.status DESC, a.created_at`)
    .map((r) => ({ ...view(r), ownerId: r.owner_id, owner: r.owner_name || '' }));
}

const short = (s: string | undefined) => (s ? s.slice(0, 200) : null);
function markDead(accountId: string, error: string | undefined, inRelay: boolean) {
  run(`UPDATE aistudio2_accounts SET status = 'dead', in_relay = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE account_id = ?`,
    inRelay ? 1 : 0, now(), short(error), now(), accountId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function upload(userId: number, cookies: string, shared = false) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const text = cookies.trim();
  if (!text) throw new HttpError(400, 'aistudio_cookie', '请粘贴 Cookie');
  if (text.length > 131072) throw new HttpError(400, 'aistudio_cookie', 'Cookie 太长');
  const { cookieText, preferredAuthUser } = unwrapCookieInput(text);

  return serial(async () => {
    // Step 1: Discover Google account(s) without mutating backend state yet.
    let disc: ApiReply;
    try {
      disc = await adminReq('POST', '/api/accounts/import/cookies/discover', { cookies: cookieText }, 45000);
    } catch {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio（新后端）暂时连不上，请稍后再试');
    }
    if (disc.status === 401 || disc.status === 403) {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio（新后端）鉴权异常，请联系管理员');
    }
    if (disc.status !== 200 || !Array.isArray(disc.j?.accounts)) {
      throw new HttpError(400, 'aistudio_cookie', apiMsg(disc.j) || 'Cookie 格式无效');
    }

    const found: any[] = disc.j.accounts;
    let cand: any = null;
    if (preferredAuthUser !== null) {
      cand = found.find((a) => Number(a?.auth_user) === preferredAuthUser) || null;
      if (cand) {
        if (cand.restricted) throw new HttpError(400, 'aistudio_dead', '这个号在 Google AI Studio 受限，无法使用');
        if (cand.signed_out) throw new HttpError(400, 'aistudio_cookie', 'Cookie 已退出登录，请重新登录 AI Studio 后导出');
        if (cand.error || !cand.email) throw new HttpError(400, 'aistudio_cookie', 'Cookie 无效：' + String(cand.error || '无法识别邮箱').slice(0, 160));
      }
    }
    if (!cand) {
      const usable = found.filter((a) => a && typeof a.email === 'string' && a.email.trim() && !a.signed_out && !a.restricted && !a.error);
      if (!usable.length) {
        if (found.some((a) => a?.restricted)) throw new HttpError(400, 'aistudio_dead', '这个号在 Google AI Studio 受限，无法使用');
        if (found.some((a) => a?.signed_out)) throw new HttpError(400, 'aistudio_cookie', 'Cookie 已退出登录，请重新登录 AI Studio 后导出');
        const firstErr = found.find((a) => a?.error)?.error;
        throw new HttpError(400, 'aistudio_cookie', firstErr ? 'Cookie 校验失败：' + String(firstErr).slice(0, 160) : '未识别到有效的 Google 账号，请导出完整 Cookie 后重试');
      }
      cand = usable.find((a) => Number(a.auth_user) === 0) || usable[0];
    }

    const email = String(cand.email).trim().toLowerCase();
    const authUser = Number.isInteger(Number(cand.auth_user)) ? Number(cand.auth_user) : 0;
    const id = ais2Id(email);

    // Step 2: Check ownership in new pool AND cross-check old AI Studio pool BEFORE writing cookies!
    const existing = one('SELECT * FROM aistudio2_accounts WHERE account_id = ? OR email = ?', id, email);
    if (existing && existing.owner_id !== userId) {
      throw new HttpError(409, 'aistudio_taken', '这个号已经被别人上传过');
    }
    if (!existing && Number(one('SELECT COUNT(*) AS n FROM aistudio2_accounts WHERE owner_id = ?', userId)?.n || 0) >= MAX_PER_USER) {
      throw new HttpError(400, 'aistudio_too_many', `每人最多 ${MAX_PER_USER} 个号`);
    }

    // Step 3: Import into AIStudio2API and wait for async validation task.
    let imp: ApiReply;
    try {
      imp = await adminReq('POST', '/api/accounts/import/cookies', {
        items: [{ email, cookies: cookieText, auth_user: authUser }],
      }, 30000);
    } catch {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio（新后端）暂时连不上，请稍后再试');
    }
    if ((imp.status !== 202 && imp.status !== 200) || !imp.j?.task?.id) {
      throw new HttpError(400, 'aistudio_cookie', apiMsg(imp.j) || '导入任务创建失败');
    }

    const taskId = String(imp.j.task.id);
    let doneTask: any = imp.j.task;
    const deadline = Date.now() + 120000;
    try {
      while (doneTask?.state === 'running' && Date.now() < deadline) {
        await sleep(600);
        const tr = await adminReq('GET', '/api/accounts/tasks', undefined, 15000);
        if (tr.status === 200 && Array.isArray(tr.j?.tasks)) {
          const foundTask = tr.j.tasks.find((t: any) => String(t?.id) === taskId);
          if (foundTask) doneTask = foundTask;
          else break;
        }
      }
    } finally {
      await adminReq('DELETE', '/api/accounts/tasks/' + encodeURIComponent(taskId), undefined, 10000).catch(() => {});
    }

    if (doneTask?.state === 'running') {
      if (!existing || existing.status !== 'valid') await backendRemove(email).catch(() => {});
      throw new HttpError(503, 'aistudio_check_failed', '账号校验超时，请稍后再试');
    }

    const item = Array.isArray(doneTask?.items) ? doneTask.items[0] : null;
    if (doneTask?.state === 'failed' || item?.state === 'failed') {
      const err = String(item?.error || doneTask?.error || '校验未通过').replace(/\s+/g, ' ').trim();
      if (TRANSIENT.test(err) && existing?.status === 'valid') {
        throw new HttpError(503, 'aistudio_check_failed', '暂时无法检测这个号，请稍后再试');
      }
      let removed = true;
      try { await backendRemove(email); } catch { removed = false; }
      if (existing) markDead(existing.account_id, err, !removed);
      if (TRANSIENT.test(err)) throw new HttpError(503, 'aistudio_check_failed', '暂时无法检测这个号，请稍后再试');
      throw new HttpError(400, 'aistudio_dead', '这个号无效：' + err.slice(0, 160));
    }

    // Step 4: Read account state & tier from AIStudio2API and ensure generation plane is running.
    const listRep = await adminReq('GET', '/api/accounts', undefined, 15000).catch(() => ({ status: 0, j: null, text: '' }));
    const backendAcc = Array.isArray(listRep.j?.accounts)
      ? listRep.j.accounts.find((a: any) => String(a?.id || '').toLowerCase() === email)
      : null;
    if (!backendAcc || backendAcc.state !== 'ready') {
      const err = String(backendAcc?.message || backendAcc?.state || '导入后账号未就绪').slice(0, 160);
      let removed = true;
      try { await backendRemove(email); } catch { removed = false; }
      if (existing) markDead(existing.account_id, err, !removed);
      throw new HttpError(400, 'aistudio_dead', '这个号无效：' + err);
    }

    await ensureStarted();

    const tier = normTier(backendAcc.benefit_tier);
    run(`INSERT INTO aistudio2_accounts(account_id, email, owner_id, tier, label, status, in_relay, last_checked_at, last_error, created_at, updated_at, shared)
         VALUES(?,?,?,?,?,'valid',1,?,NULL,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET email = excluded.email, tier = COALESCE(excluded.tier, aistudio2_accounts.tier), label = excluded.label,
           status = 'valid', in_relay = 1, last_checked_at = excluded.last_checked_at, last_error = NULL, updated_at = excluded.updated_at`,
      id, email, userId, tier, email, now(), now(), now(), shared ? 1 : 0);

    return {
      ...view(one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', id)!),
      deviceBound: !!cand.device_bound,
    };
  });
}

// ---------- share ----------
export function setShared(userId: number, accountId: string, shared: boolean) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row || row.owner_id !== userId) throw new HttpError(404, 'not_found');
  run('UPDATE aistudio2_accounts SET shared = ?, updated_at = ? WHERE account_id = ?', shared ? 1 : 0, now(), accountId);
  return view(one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId)!);
}

// ---------- re-check & sweep ----------
async function checkLocked(accountId: string): Promise<Verdict['state'] | 'skip'> {
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row || row.status !== 'valid') return 'skip';
  const v = await refreshAccount(String(row.email));
  if (v.state === 'alive') {
    run('UPDATE aistudio2_accounts SET tier = COALESCE(?, tier), last_checked_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ?',
      v.tier ?? null, now(), now(), accountId);
  } else if (v.state === 'dead') {
    let removed = true;
    try { await backendRemove(String(row.email)); } catch { removed = false; }
    markDead(accountId, v.error, !removed);
  } else {
    console.warn('[aistudio2] check inconclusive', accountId, v.error);
  }
  return v.state;
}

export async function recheck(userId: number, accountId: string, admin = false) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row || (!admin && row.owner_id !== userId)) throw new HttpError(404, 'not_found');
  if (row.status !== 'valid') throw new HttpError(400, 'aistudio_dead', '这个号已失效，请重新上传');
  const state = await serial(() => checkLocked(accountId));
  return { state, account: view(one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId)!) };
}

const recentReactive = new Map<string, number>();
/** Non-blocking reactive check when gateway sees 401/403 from a pinned account. */
export function notifyAuthSuspect(accountId: string) {
  if (!aistudio2On()) return;
  const last = recentReactive.get(accountId) || 0;
  if (now() - last < 180000) return;
  recentReactive.set(accountId, now());
  void serial(() => checkLocked(accountId)).catch(() => {});
}

export async function sweep() {
  if (!aistudio2On()) return { checked: 0, dead: 0 };
  return serial(async () => {
    let checked = 0, dead = 0;
    for (const r of all(`SELECT account_id FROM aistudio2_accounts WHERE status = 'valid' ORDER BY last_checked_at`)) {
      const s = await checkLocked(String(r.account_id));
      if (s !== 'skip') checked++;
      if (s === 'dead') dead++;
    }
    for (const r of all(`SELECT account_id, email FROM aistudio2_accounts WHERE status != 'valid' AND in_relay = 1`)) {
      try {
        await backendRemove(String(r.email));
        run('UPDATE aistudio2_accounts SET in_relay = 0 WHERE account_id = ?', r.account_id);
      } catch {}
    }
    const validCount = Number(one(`SELECT COUNT(*) AS n FROM aistudio2_accounts WHERE status = 'valid'`)?.n || 0);
    if (validCount > 0) await ensureStarted().catch(() => {});
    return { checked, dead };
  });
}

// ---------- delete ----------
export async function remove(userId: number, accountId: string, admin = false) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row || (!admin && row.owner_id !== userId)) throw new HttpError(404, 'not_found');
  await serial(async () => {
    try {
      await backendRemove(String(row.email));
    } catch {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio（新后端）暂时连不上，请稍后再试');
    }
    run('DELETE FROM exit_bindings WHERE kind = ? AND (acc_id = ? OR lower(acc_id) = ?)', 'ais2', accountId, String(row.email).toLowerCase());
    run('DELETE FROM aistudio2_accounts WHERE account_id = ?', accountId);
  });
  return { ok: true };
}

export function startAIStudio2Recheck(): void {
  if (!aistudio2On() || config.aistudio2RecheckMinutes <= 0) return;
  const tick = () => sweep().catch((e) => console.error('[aistudio2] recheck failed', (e as Error).message));
  setInterval(tick, config.aistudio2RecheckMinutes * 60000).unref();
}

export type RawAccount = { id: string; label: string; enabled: boolean; state: string; proxy: string; locale: string; timezone: string };
export async function listRawAccounts(): Promise<RawAccount[]> {
  if (!aistudio2On()) return [];
  let rep: ApiReply;
  try {
    rep = await adminReq('GET', '/api/accounts', undefined, 15000);
  } catch {
    throw new HttpError(502, 'aistudio_unreachable', 'AI Studio（新后端）暂时连不上，请稍后再试');
  }
  if (rep.status !== 200) throw new HttpError(502, 'aistudio_unreachable', 'AI Studio（新后端）暂时连不上，请稍后再试');
  const arr = Array.isArray(rep.j) ? rep.j : (rep.j?.accounts || rep.j?.items || []);
  return arr.map((a: any) => ({
    id: String(a.id || a.email || ''),
    label: String(a.label || a.id || ''),
    enabled: a.enabled !== false,
    state: String(a.state || ''),
    proxy: String(a.proxy || ''),
    locale: String(a.locale || ''),
    timezone: String(a.timezone || ''),
  }));
}

export async function setAccountProxy(idOrEmail: string, proxyUrl: string): Promise<void> {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const resolved = isAIS2(idOrEmail)
    ? String(one('SELECT email FROM aistudio2_accounts WHERE account_id = ?', idOrEmail)?.email || '')
    : idOrEmail.trim();
  if (!resolved) throw new HttpError(404, 'not_found');
  const list = await listRawAccounts();
  const cur = list.find((a) => a.id.toLowerCase() === resolved.toLowerCase());
  if (!cur) throw new HttpError(404, 'not_found');
  if (cur.proxy === proxyUrl) return;
  let rep: ApiReply;
  try {
    rep = await adminReq('PUT', '/api/accounts/' + encodeURIComponent(cur.id), {
      label: cur.label || cur.id,
      enabled: cur.enabled,
      proxy: proxyUrl,
      locale: cur.locale,
      timezone: cur.timezone,
    }, 35000);
  } catch (e) {
    const verify = await listRawAccounts().catch(() => [] as RawAccount[]);
    const after = verify.find((a) => a.id.toLowerCase() === cur.id.toLowerCase());
    if (after && after.proxy === proxyUrl) return;
    const isTimeout = (e as Error)?.name === 'TimeoutError' || /timeout|aborted/i.test(String((e as Error)?.message || ''));
    throw new HttpError(
      isTimeout ? 504 : 502,
      isTimeout ? 'aistudio_proxy_timeout' : 'aistudio_proxy_failed',
      isTimeout ? '切换出口节点超时（该账号可能正在处理请求），请稍后再试' : 'AI Studio（新后端）暂时连不上，请稍后再试',
    );
  }
  if (rep.status !== 200) throw new HttpError(502, 'aistudio_proxy_failed', apiMsg(rep.j) || '更新 AI Studio 代理失败');
}
