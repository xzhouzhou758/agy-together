// Sessions, Discord OAuth2 login (guild + role check), dev login, periodic role recheck.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { one, all, run, now, type Row } from './db.ts';
import { HttpError, sha256, token, parseCookies, cookie, sleep, checkPassword, hashPassword } from './util.ts';
import { discord, discordReady, adminIds } from './site.ts';
import * as cpa from './cpa.ts';

const SID = 'agy_sid';
const OSTATE = 'agy_oauth_state';
const DAPI = 'https://discord.com/api/v10';

export type User = { id: number; discord_id: string; name: string; handle: string; role: 'admin' | 'user'; active: number; default_pool: string; rotation_mode?: string | null; session_salt?: string | null; input_limit?: number | null };

export function currentUser(req: IncomingMessage): User | null {
  const sid = parseCookies(req.headers.cookie)[SID];
  if (!sid) return null;
  const row = one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    sha256(sid), now(),
  );
  return (row as User) || null;
}

export function requireUser(req: IncomingMessage): User {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'unauthorized');
  return u;
}
export function requireAdmin(req: IncomingMessage): User {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'forbidden');
  return u;
}

function startSession(res: ServerResponse, userId: number, extraCookies: string[] = []) {
  const sid = token(32);
  const maxAge = config.sessionDays * 86400;
  run('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)', sha256(sid), userId, now(), now() + maxAge * 1000);
  res.setHeader('Set-Cookie', [cookie(SID, sid, { maxAge, secure: config.cookieSecure }), ...extraCookies]);
}

export function logout(req: IncomingMessage, res: ServerResponse) {
  const sid = parseCookies(req.headers.cookie)[SID];
  if (sid) run('DELETE FROM sessions WHERE token_hash = ?', sha256(sid));
  res.setHeader('Set-Cookie', cookie(SID, '', { maxAge: 0, secure: config.cookieSecure }));
}

function redirect(res: ServerResponse, to: string, cookies?: string[]) {
  const h: Record<string, any> = { Location: to.startsWith('/') ? config.basePath + to : to, 'Cache-Control': 'no-store' };
  if (cookies) h['Set-Cookie'] = cookies;
  res.writeHead(302, h);
  res.end();
}

/** Create or update a user after a successful identity check. Returns null if the user is disabled by an admin. */
async function upsertUser(discordId: string, name: string, handle: string): Promise<Row | null> {
  const role = adminIds().has(discordId) ? 'admin' : null;
  let u = one('SELECT * FROM users WHERE discord_id = ?', discordId);
  if (!u) {
    run('INSERT INTO users(discord_id, name, handle, role, active, created_at, last_login, role_checked_at) VALUES(?,?,?,?,1,?,?,?)',
      discordId, name, handle, role || 'user', now(), now(), now());
    return one('SELECT * FROM users WHERE discord_id = ?', discordId)!;
  }
  if (!u.active && u.disabled_reason !== 'discord') return null; // disabled by admin
  run('UPDATE users SET name = ?, handle = ?, last_login = ?, role_checked_at = ?' + (role ? ", role = 'admin'" : '') + ' WHERE id = ?',
    name, handle, now(), now(), u.id);
  if (!u.active) await setUserActive(u.id, true, 'discord');
  return one('SELECT * FROM users WHERE id = ?', u.id)!;
}

// ---------- Discord ----------
export function discordLogin(res: ServerResponse) {
  if (!discordReady()) return redirect(res, '/?err=discord_not_configured');
  const d = discord();
  const state = token(18);
  const u = new URL('https://discord.com/oauth2/authorize');
  u.searchParams.set('client_id', d.clientId);
  u.searchParams.set('redirect_uri', d.redirectURI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'identify guilds guilds.members.read');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'none');
  redirect(res, u.toString(), [cookie(OSTATE, state, { maxAge: 600, secure: config.cookieSecure, path: config.basePath + '/auth/discord' })]);
}

async function dfetch(url: string, init: RequestInit): Promise<{ status: number; data: any }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  let data: any = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

/** Port of new-api-custom oauth/discord.go verifyDiscordGuildMembership: guild member + at least one role (if roles configured). */
async function verifyMembership(accessToken: string): Promise<string | null> {
  const d = discord();
  const auth = { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' };
  const g = await dfetch(`${DAPI}/users/@me/guilds`, { headers: auth });
  if (g.status !== 200 || !Array.isArray(g.data)) return 'discord_api';
  if (!g.data.some((x: any) => x?.id === d.guildId)) return 'not_in_guild';
  const m = await dfetch(`${DAPI}/users/@me/guilds/${d.guildId}/member`, { headers: auth });
  if (m.status !== 200) return 'discord_api';
  if (!d.roleIds.length) return null;
  const roles = new Set<string>(m.data?.roles || []);
  return d.roleIds.some((r) => roles.has(r)) ? null : 'missing_role';
}

export async function discordCallback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const clear = cookie(OSTATE, '', { maxAge: 0, secure: config.cookieSecure, path: config.basePath + '/auth/discord' });
  const fail = (code: string) => redirect(res, '/?err=' + code, [clear]);
  const state = url.searchParams.get('state') || '';
  const want = parseCookies(req.headers.cookie)[OSTATE];
  if (!state || !want || state !== want) return fail('state');
  const code = url.searchParams.get('code');
  if (!code) return fail(url.searchParams.get('error') === 'access_denied' ? 'denied' : 'code');
  if (!discordReady()) return fail('discord_not_configured');
  const d = discord();
  try {
    const body = new URLSearchParams({
      client_id: d.clientId, client_secret: d.clientSecret, code, grant_type: 'authorization_code', redirect_uri: d.redirectURI,
    });
    const t = await dfetch(`${DAPI}/oauth2/token`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    const at = t.data?.access_token;
    if (!at) return fail('token');
    const me = await dfetch(`${DAPI}/users/@me`, { headers: { Authorization: 'Bearer ' + at } });
    if (me.status !== 200 || !me.data?.id || !me.data?.username) return fail('user');
    const why = await verifyMembership(at);
    if (why) return fail(why);
    const u = await upsertUser(String(me.data.id), String(me.data.global_name || me.data.username), String(me.data.username));
    if (!u) return fail('disabled');
    startSession(res, u.id, [clear]);
    redirect(res, '/');
  } catch (e) {
    console.error('[discord] callback error', (e as Error)?.message);
    fail('discord_api');
  }
}

// ---------- username + password (accounts created by an admin; no sign-up) ----------
const loginFails = new Map<string, { n: number; until: number }>();
const DUMMY_HASH = hashPassword(token(12));
export function passwordLogin(req: IncomingMessage, res: ServerResponse, body: any) {
  const ip = String((config.trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || '');
  const f = loginFails.get(ip);
  if (f && f.n >= 8 && f.until > now()) throw new HttpError(429, 'too_many_attempts');
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const u = username ? one('SELECT * FROM users WHERE username = ?', username) : undefined;
  const ok = checkPassword(password, u?.pass_hash || DUMMY_HASH) && !!u;
  if (!ok) {
    const cur = f && f.until > now() ? f : { n: 0, until: 0 };
    loginFails.set(ip, { n: cur.n + 1, until: now() + 15 * 60000 });
    throw new HttpError(401, 'bad_credentials');
  }
  loginFails.delete(ip);
  if (!u!.active) throw new HttpError(403, 'disabled');
  run('UPDATE users SET last_login = ? WHERE id = ?', now(), u!.id);
  startSession(res, u!.id);
}

// ---------- dev login (tests only, loopback only) ----------
export async function devLogin(res: ServerResponse, body: any) {
  if (!config.devLogin) throw new HttpError(404, 'not_found');
  const discordId = String(body?.discordId || '').trim();
  if (!/^\d{1,25}$/.test(discordId)) throw new HttpError(400, 'invalid_id');
  const name = String(body?.name || 'dev-' + discordId).slice(0, 40);
  const u = await upsertUser(discordId, name, name);
  if (!u) throw new HttpError(403, 'disabled');
  if (body?.admin === true) run("UPDATE users SET role = 'admin' WHERE id = ?", u.id);
  startSession(res, u.id);
}

// ---------- disable / enable a user ----------
/** Disabling a user disables their keys (checked at request time), their sessions, and their CPA credentials. */
export async function setUserActive(userId: number, active: boolean, reason: 'admin' | 'discord') {
  if (!active) {
    run('UPDATE users SET active = 0, disabled_reason = ? WHERE id = ?', reason, userId);
    run('DELETE FROM sessions WHERE user_id = ?', userId);
    const c = await cpa.creds(0).catch(() => null);
    for (const a of all('SELECT auth_id FROM accounts WHERE owner_id = ?', userId)) {
      const cred = c?.byId.get(a.auth_id);
      if (cred && !cred.disabled) {
        try {
          await cpa.setDisabled(a.auth_id, true);
          run('UPDATE accounts SET suspended = 1 WHERE auth_id = ?', a.auth_id);
        } catch (e) {
          console.error('[suspend] failed to disable', a.auth_id, (e as Error).message);
        }
      }
    }
  } else {
    run('UPDATE users SET active = 1, disabled_reason = NULL WHERE id = ?', userId);
    for (const a of all('SELECT auth_id FROM accounts WHERE owner_id = ? AND suspended = 1', userId)) {
      try {
        await cpa.setDisabled(a.auth_id, false);
        run('UPDATE accounts SET suspended = 0 WHERE auth_id = ?', a.auth_id);
      } catch (e) {
        console.error('[unsuspend] failed to enable', a.auth_id, (e as Error).message);
      }
    }
  }
}

// ---------- periodic role recheck with a bot token ----------
async function recheckOnce() {
  const d = discord();
  if (!d.botToken || !d.guildId) return;
  const admins = adminIds();
  for (const u of all("SELECT id, discord_id FROM users WHERE active = 1 AND username IS NULL")) {
    if (admins.has(u.discord_id)) continue;
    try {
      const r = await dfetch(`${DAPI}/guilds/${d.guildId}/members/${u.discord_id}`, { headers: { Authorization: 'Bot ' + d.botToken } });
      let ok: boolean | null = null;
      if (r.status === 404) ok = false;
      else if (r.status === 200) ok = !d.roleIds.length || (r.data?.roles || []).some((x: string) => d.roleIds.includes(x));
      if (ok === false) {
        console.log('[recheck] user lost guild/role, disabling', u.id);
        await setUserActive(u.id, false, 'discord');
      } else if (ok === true) {
        run('UPDATE users SET role_checked_at = ? WHERE id = ?', now(), u.id);
      }
    } catch {}
    await sleep(500);
  }
}

export function startRoleRecheck() {
  if (config.roleRecheckMinutes <= 0) return;
  const tick = () => recheckOnce().catch((e) => console.error('[recheck]', e?.message));
  setInterval(tick, config.roleRecheckMinutes * 60000).unref();
  setTimeout(tick, 30000).unref();
}

export function pruneSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('DELETE FROM oauth_flows WHERE created_at < ?', now() - 3600000);
}
