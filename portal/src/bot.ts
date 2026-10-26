// Discord bot, without a gateway connection:
//  - account health watch: a credential that needs verification / lost its login / looks banned gets
//    an @owner message in the bot channel (once per problem, at most once a day per account, and once when it
//    recovers). CPA only reports a 403 while the credential cools down, so a "Verify your account" seen here is
//    handed to autodisable: the account stays off (and reported) until a probe shows it works again;
//  - slash commands (/我的号 answered privately, /今日榜) arrive as signed HTTP POSTs at <base>/discord/interactions;
//  - a daily leaderboard is posted to the bot channel at the configured hour.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { one, all, run, now, getSetting, setSetting, type Row } from './db.ts';
import { HttpError, readBody, sendJSON } from './util.ts';
import * as cpa from './cpa.ts';
import * as site from './site.ts';
import { storedQuota } from './quota.ts';
import { dailyWith } from './limits.ts';
import { forbiddenReason, disableForbidden } from './autodisable.ts';

const DAPI = 'https://discord.com/api/v10';
const GRACE = 10 * 60e3;           // a problem must persist this long before anyone is pinged
const REPING = 24 * 3600e3;        // the same account pings its owner at most once a day, even if it flaps
const CLEAR_GRACE = 30 * 60e3;     // a problem must be gone this long before it counts as recovered

// ---------- account problems ----------
export type Problem = { kind: 'verify' | 'auth' | 'banned' | 'error'; label: string; hint: string };
const KINDS: Record<Problem['kind'], [string, string]> = {
  verify: ['需要验证', '用这个 Google 账号登录 Antigravity，按提示完成验证，之后会自动恢复'],
  auth: ['登录失效', '去小锅饭「我的凭证」删掉这个号，再重新添加'],
  banned: ['可能被封', 'Google 停用了这个账号，暂时没法用了'],
  error: ['异常', ''],
};
function classify(msg: string): Problem['kind'] | null {
  if (!msg) return null;
  if (/verify your account|validation_required|account verification/i.test(msg)) return 'verify';
  if (/has been disabled|suspended|terms of service|violat|account.{0,20}(banned|disabled)/i.test(msg)) return 'banned';
  if (/invalid_grant|invalid_token|unauthenticated|\b401\b|token.{0,20}(expired|revoked)|refresh.{0,20}fail/i.test(msg)) return 'auth';
  if (/\b403\b|permission_denied/i.test(msg)) return 'error';
  return null;
}
/** What is wrong with an account right now, or null. Quota exhaustion / cooldown is not a problem. */
export function accountProblem(row: Row, cred: cpa.Cred | undefined): Problem | null {
  if (!cred || row.suspended) return null;
  const auto = !!row.auto_disabled_at; // disabled by autodisable.ts after a 403: still a problem until it recovers
  if (cred.disabled && !auto) return null;
  const sources = [auto ? String(row.auto_disabled_reason || '403') : '', cred.status === 'error' || cred.unavailable ? cred.statusMessage : '', String(row.quota_err || '')];
  let kind: Problem['kind'] | null = null;
  for (const s of sources) {
    const k = classify(s);
    if (k && (!kind || kind === 'error')) kind = k;
  }
  if (!kind && cred.status === 'error' && !(cred.nextRetryAfter && Date.parse(cred.nextRetryAfter) > Date.now()) && cred.statusMessage && !/429|quota|exhaust|rate/i.test(cred.statusMessage)) kind = 'error';
  if (!kind && auto) kind = 'error';
  if (!kind) return null;
  const [label, hint] = KINDS[kind];
  const detail = (sources.find((s) => s) || '').replace(/\s+/g, ' ').slice(0, 120);
  return { kind, label: auto ? label + '，已自动停用' : label, hint: (hint || detail) + (auto ? '。恢复后会自动重新启用' : '') };
}

// ---------- Discord REST ----------
function botReady() {
  const d = site.discord(), b = site.bot();
  return d.botToken && b.channelId ? { token: d.botToken, channel: b.channelId } : null;
}
async function post(content: string, mention: string[] = []): Promise<boolean> {
  const b = botReady();
  if (!b) return false;
  try {
    const r = await fetch(`${DAPI}/channels/${b.channel}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bot ' + b.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [], users: mention } }),
    });
    if (!r.ok) console.error('[bot] post failed', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.error('[bot] post failed', (e as Error).message);
    return false;
  }
}
// ---------- setup from the admin page (everything the bot token can do by itself) ----------
async function dapi(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const t = site.discord().botToken;
  if (!t) return { status: 0, data: null };
  try {
    const r = await fetch(DAPI + path, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bot ' + t, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch {
    return { status: 0, data: null };
  }
}
const SEND = 1024 + 2048 + 274877906944; // View Channel + Send Messages + Send Messages in Threads
/** State of each setup step, plus the text channels to choose from. */
export async function botStatus() {
  const d = site.discord(), b = site.bot(), base = site.publicURL();
  const invite = d.clientId ? `https://discord.com/oauth2/authorize?client_id=${d.clientId}&scope=bot%20applications.commands&permissions=${SEND}` : '';
  const out = { tokenSet: !!d.botToken, guildSet: !!d.guildId, inGuild: false, botName: '', channels: [] as { id: string; name: string }[], channelId: b.channelId,
    connected: false, endpoint: base ? base + '/discord/interactions' : '', dailyHour: b.dailyHour, invite, error: '' };
  if (!d.botToken) return out;
  const me = await dapi('GET', '/applications/@me');
  if (me.status === 401) { out.error = 'bad_token'; return out; }
  out.botName = me.data?.bot?.username || me.data?.name || '';
  out.connected = !!b.publicKey && me.data?.verify_key === b.publicKey && me.data?.interactions_endpoint_url === out.endpoint;
  if (!d.guildId) return out;
  const ch = await dapi('GET', `/guilds/${d.guildId}/channels`);
  if (ch.status !== 200) return out; // 403/404: the bot is not in the server
  out.inGuild = true;
  out.channels = (ch.data as any[]).filter((c) => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position).map((c) => ({ id: String(c.id), name: String(c.name) }));
  // threads (子区) are not in the channel list; active ones come from a separate call
  const th = await dapi('GET', `/guilds/${d.guildId}/threads/active`);
  for (const t of th.data?.threads || []) out.channels.push({ id: String(t.id), name: '🧵 ' + String(t.name) });
  if (b.channelId && !out.channels.some((c) => c.id === b.channelId)) {
    const one_ = await dapi('GET', `/channels/${b.channelId}`);
    out.channels.push({ id: b.channelId, name: one_.status === 200 ? (one_.data?.thread_metadata ? '🧵 ' : '') + String(one_.data?.name || b.channelId) : b.channelId + '（机器人看不到）' });
  }
  return out;
}
/** Stores the app's public key, points Discord's Interactions Endpoint URL at us, registers the commands. */
export async function connectInteractions(): Promise<void> {
  const base = site.publicURL();
  if (!base) throw new Error('no_public_url');
  const me = await dapi('GET', '/applications/@me');
  if (me.status !== 200 || !/^[0-9a-f]{64}$/i.test(me.data?.verify_key || '')) throw new Error(me.status === 401 ? 'bad_token' : 'discord_api');
  setSetting('discord_public_key', String(me.data.verify_key).toLowerCase());
  // Discord PINGs the URL during this call; the key above is already in place to answer it.
  const r = await dapi('PATCH', '/applications/@me', { interactions_endpoint_url: base + '/discord/interactions' });
  if (r.status !== 200) {
    console.error('[bot] set interactions url failed', r.status, JSON.stringify(r.data).slice(0, 300));
    throw new Error('endpoint_rejected');
  }
  await registerCommands();
}
/** Post an announcement to the bot channel (no pings). */
export async function postAnnouncement(title: string, body: string, url: string): Promise<boolean> {
  return post(`📢 **${title}**\n${body}${url ? `\n${url}` : ''}`);
}
export async function testMessage(): Promise<boolean> {
  return post('🐶 小锅饭机器人已就位：号出问题会在这里 @ 号主，每天发日报。试试 `/我的号` 和 `/今日榜`');
}

export async function registerCommands(): Promise<void> {
  const d = site.discord();
  if (!d.botToken || !d.clientId || !d.guildId) return;
  const cmds = [
    { name: '我的号', description: '看看我的号现在怎么样（只有你看得到）', type: 1 },
    { name: '今日榜', description: '今天到现在的用量排行', type: 1 },
    { name: '免打扰', description: '机器人发消息时不再 @ 我（号出问题照样会说，只是不 @）', type: 1,
      options: [{ name: '开启', description: '开启 = 不 @ 我；关闭 = 恢复 @ 我。不填就是切换', type: 5, required: false }] },
  ];
  try {
    const r = await fetch(`${DAPI}/applications/${d.clientId}/guilds/${d.guildId}/commands`, {
      method: 'PUT', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bot ' + d.botToken, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
    });
    if (!r.ok) console.error('[bot] command registration failed', r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.error('[bot] command registration failed', (e as Error).message);
  }
}

// ---------- formatting ----------
const realId = (d: unknown) => (typeof d === 'string' && /^\d{5,25}$/.test(d) ? d : '');
/** The user asked the bot not to @ them (/免打扰): their name is written out instead. */
export const isQuiet = (discordId: unknown) => !!realId(discordId) && !!one('SELECT bot_quiet FROM users WHERE discord_id = ?', discordId)?.bot_quiet;
const who = (r: { discord_id?: unknown; name?: unknown }) => (realId(r.discord_id) && !isQuiet(r.discord_id) ? `<@${r.discord_id}>` : `**${String(r.name || '—')}**`);
export function maskEmail(e: string): string {
  const [u, d] = String(e || '').split('@');
  if (!d) return u ? u.slice(0, 3) + '***' : '—';
  return (u.length <= 3 ? u[0] + '**' : u.slice(0, 3) + '***') + '@' + d;
}
export function tk(n: number): string {
  n = Number(n) || 0;
  return n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : String(n);
}
function dayStart(t = now()): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const TOK = 'COALESCE(u.total_tok, COALESCE(u.in_tok,0) + COALESCE(u.out_tok,0) + COALESCE(u.reasoning_tok,0))';

// ---------- health watch ----------
export type Owner = { discord_id?: unknown; name?: unknown };
export type Item = { email: string; label?: string; hint?: string };
/** One owner's message for this check run: all their newly-due problems (or recoveries) in one post, one @. */
export function ownerMessage(o: Owner, items: Item[], recovered = false, max = 2000): string {
  if (items.length === 1) {
    const [i] = items;
    return recovered ? `✅ ${who(o)} 你的号 \`${i.email}\` 恢复正常了` : `⚠️ ${who(o)} 你的号 \`${i.email}\` **${i.label}**\n${i.hint}`;
  }
  const out = [recovered ? `✅ ${who(o)} 你的 ${items.length} 个号恢复正常了` : `⚠️ ${who(o)} 你的 ${items.length} 个号出问题了`];
  let len = out[0].length;
  for (let k = 0; k < items.length; k++) {
    const i = items[k];
    const line = recovered ? `· \`${i.email}\`` : `· \`${i.email}\` **${i.label}**${i.hint ? ' — ' + i.hint : ''}`;
    const tail = k < items.length - 1 ? `\n…还有 ${items.length - k - 1} 个号`.length : 0; // room for the cut-off line
    if (len + 1 + line.length + tail > max) {
      out.push(`…还有 ${items.length - k} 个号`);
      break;
    }
    out.push(line);
    len += 1 + line.length;
  }
  return out.join('\n');
}
export type Alert = Item & { owner_id: unknown; owner: Owner; auth_id: string; recovered?: boolean };
/** Groups one run's alerts by owner: per owner one ✅ post (no ping) and one ⚠️ post (pings once). */
export function alertPosts(alerts: Alert[]): { content: string; mention: string[]; authIds: string[] }[] {
  const by = new Map<unknown, Alert[]>();
  for (const a of alerts) by.set(a.owner_id, [...(by.get(a.owner_id) || []), a]);
  const out: ReturnType<typeof alertPosts> = [];
  for (const list of by.values()) {
    const o = list[0].owner, id = realId(o.discord_id);
    const ok = list.filter((a) => a.recovered), due = list.filter((a) => !a.recovered);
    if (ok.length) out.push({ content: ownerMessage(o, ok, true), mention: [], authIds: [] });
    // truncated accounts count as notified too: the owner was pinged about the whole batch
    if (due.length) out.push({ content: ownerMessage(o, due), mention: id && !isQuiet(id) ? [id] : [], authIds: due.map((a) => a.auth_id) });
  }
  return out;
}
export async function checkAccounts(): Promise<void> {
  const c = await cpa.creds(30000);
  const rows = all(`SELECT a.*, us.discord_id, us.name AS owner_name, us.active AS owner_active FROM accounts a LEFT JOIN users us ON us.id = a.owner_id WHERE a.owner_id IS NOT NULL`);
  const seen = new Set<string>(), alerts: Alert[] = [], t = now();
  for (const r of rows) {
    const cred = c.byId.get(r.auth_id);
    if (!cred) continue;
    seen.add(r.auth_id);
    const p = r.owner_active ? accountProblem(r, cred) : null;
    // a 403 (verify / banned) only shows while CPA cools the credential down: keep it off until a probe says it works
    if (p && (p.kind === 'verify' || p.kind === 'banned') && r.auto_disabled_at == null && !cred.disabled) {
      const why = forbiddenReason(r, cred);
      if (why) await disableForbidden(cred, why).catch(() => {});
    }
    const st = one('SELECT * FROM bot_alerts WHERE auth_id = ?', r.auth_id);
    const a = { owner_id: r.owner_id, owner: { discord_id: r.discord_id, name: r.owner_name }, auth_id: r.auth_id, email: maskEmail(cred.email || r.email) };
    if (!p) {
      if (!st || st.closed) continue;
      if (st.cleared_at == null) { run('UPDATE bot_alerts SET cleared_at = ? WHERE auth_id = ?', t, r.auth_id); continue; }
      if (t - st.cleared_at < CLEAR_GRACE) continue;
      run('UPDATE bot_alerts SET closed = 1 WHERE auth_id = ?', r.auth_id);
      if (st.notified_at && st.notified_at >= st.since) alerts.push({ ...a, recovered: true });
      continue;
    }
    if (st && !st.closed && st.kind === p.kind) {
      if (st.cleared_at != null) run('UPDATE bot_alerts SET cleared_at = NULL WHERE auth_id = ?', r.auth_id); // a flap: same episode
    } else {
      // new episode; notified_at is kept so a relapse soon after a ping stays quiet
      run('INSERT INTO bot_alerts(auth_id, kind, since, notified_at, cleared_at, closed) VALUES(?,?,?,NULL,NULL,0) ON CONFLICT(auth_id) DO UPDATE SET kind = excluded.kind, since = excluded.since, cleared_at = NULL, closed = 0', r.auth_id, p.kind, t);
      continue;
    }
    if (t - st.since < GRACE) continue;
    if (st.notified_at && (st.notified_at >= st.since || t - st.notified_at < REPING)) continue;
    alerts.push({ ...a, label: p.label, hint: p.hint });
  }
  for (const m of alertPosts(alerts)) {
    if (await post(m.content, m.mention)) for (const id of m.authIds) run('UPDATE bot_alerts SET notified_at = ? WHERE auth_id = ?', t, id);
  }
  for (const s of all('SELECT auth_id, cleared_at, closed FROM bot_alerts')) {
    if (!seen.has(s.auth_id) || (s.closed && t - s.cleared_at > 7 * 86400e3)) run('DELETE FROM bot_alerts WHERE auth_id = ?', s.auth_id);
  }
}

// ---------- leaderboard ----------
export function leaderboard(since: number, until: number, title: string): string {
  const w = 'u.ts >= ? AND u.ts < ?';
  const tot = one(`SELECT COUNT(*) AS n, SUM(u.result = 'ok') AS ok, SUM(${TOK}) AS tok, COUNT(DISTINCT u.user_id) AS users FROM usage u WHERE ${w}`, since, until);
  if (!Number(tot?.n)) return `${title}\n这段时间还没有人用 😴`;
  const top = (sql: string, ...a: any[]) => one(sql, since, until, ...a);
  const byUser = (extra: string, order = 'tok') => top(`SELECT us.name, us.discord_id, COUNT(*) AS n, SUM(${TOK}) AS tok FROM usage u JOIN users us ON us.id = u.user_id WHERE ${w} ${extra} GROUP BY u.user_id ORDER BY ${order} DESC LIMIT 1`);
  const lines = [title, `全站 **${Number(tot.n).toLocaleString()}** 次请求 · **${tk(tot.tok)}** Token · 成功率 ${Math.round(Number(tot.ok) / Number(tot.n) * 100)}% · ${tot.users} 人在用`, ''];
  const king = byUser('');
  if (king) lines.push(`👑 **用量王** ${who(king)} · ${tk(king.tok)} Token`);
  const chat = byUser('', 'n');
  if (chat && chat.name !== king?.name) lines.push(`💬 **话痨** ${who(chat)} · ${Number(chat.n).toLocaleString()} 次请求`);
  const free = byUser(`AND u.pool = 'shared' AND (u.owner_id IS NULL OR u.owner_id != u.user_id)`);
  if (free) lines.push(`🍚 **白嫖之王** ${who(free)} · 吃了大锅饭 ${tk(free.tok)} Token`);
  const giver = top(`SELECT us.name, us.discord_id, SUM(${TOK}) AS tok, COUNT(DISTINCT u.user_id) AS fed FROM usage u JOIN users us ON us.id = u.owner_id WHERE ${w} AND u.pool = 'shared' AND u.result = 'ok' AND (u.user_id IS NULL OR u.user_id != u.owner_id) GROUP BY u.owner_id ORDER BY tok DESC LIMIT 1`);
  if (giver) lines.push(`🙏 **大善人** ${who(giver)} · 共享的号喂饱了 ${giver.fed} 个人，${tk(giver.tok)} Token`);
  const worker = top(`SELECT u.auth_id, a.email, us.name, us.discord_id, COUNT(*) AS n FROM usage u JOIN accounts a ON a.auth_id = u.auth_id LEFT JOIN users us ON us.id = u.owner_id WHERE ${w} AND u.result = 'ok' GROUP BY u.auth_id ORDER BY n DESC LIMIT 1`);
  if (worker) lines.push(`🐂 **劳模号** ${who(worker)} 的 \`${maskEmail(worker.email)}\` · 扛了 ${Number(worker.n).toLocaleString()} 次请求`);
  const owl = top(`SELECT us.name, us.discord_id, COUNT(*) AS n FROM usage u JOIN users us ON us.id = u.user_id WHERE ${w} AND CAST(strftime('%H', u.ts / 1000, 'unixepoch', 'localtime') AS INTEGER) < 6 GROUP BY u.user_id ORDER BY n DESC LIMIT 1`);
  if (owl) lines.push(`🦉 **夜猫子** ${who(owl)} · 凌晨还发了 ${owl.n} 次请求`);
  const wall = top(`SELECT us.name, us.discord_id, COUNT(*) AS n FROM usage u JOIN users us ON us.id = u.user_id WHERE ${w} AND u.result IN ('quota', 'no_account', 'rate_limited') GROUP BY u.user_id ORDER BY n DESC LIMIT 1`);
  if (wall && Number(wall.n) >= 10) lines.push(`🧱 **撞墙王** ${who(wall)} · 撞了 ${wall.n} 次额度墙，号该歇歇了`);
  return lines.join('\n');
}
async function dailyTick(): Promise<void> {
  const h = site.bot().dailyHour;
  if (h < 0 || !botReady()) return;
  const d = new Date();
  if (d.getHours() !== h) return;
  const key = d.toISOString().slice(0, 10) + ':' + dayStart();
  if (getSetting('bot_daily_last') === key) return;
  setSetting('bot_daily_last', key);
  await post(leaderboard(now() - 86400e3, now(), `🐶 **${d.getMonth() + 1} 月 ${d.getDate()} 日 · 小锅饭日报**（过去 24 小时）`) + '\n\n' + allTimeLine());
}
/** 全站历史总用量 */
export function allTimeLine(): string {
  const t = one(`SELECT COUNT(*) AS n, SUM(${TOK}) AS tok, COUNT(DISTINCT u.user_id) AS users, MIN(u.ts) AS first FROM usage u WHERE u.result = 'ok'`);
  if (!Number(t?.n)) return '';
  const f = new Date(Number(t.first));
  return `📦 **全站累计**（${f.getFullYear()}.${f.getMonth() + 1}.${f.getDate()} 起）· **${Number(t.n).toLocaleString()}** 次成功请求 · **${tk(t.tok)}** Token · ${t.users} 人用过`;
}

// ---------- /我的号 ----------
const WIN: Record<string, string> = { gemini: 'Gemini', claude: 'Claude/GPT' };
const BUCKET: Record<string, string> = { '5h': '5 小时', weekly: '本周' };
export function myAccounts(discordId: string, c: cpa.Creds): string {
  const u = one('SELECT * FROM users WHERE discord_id = ?', discordId);
  const base = site.publicURL();
  if (!u) return `你还没登录过小锅饭${base ? `：${base}/` : ''}`;
  const d = dailyWith(u.id, c);
  const dl = `大锅饭今天 **${d.used}${d.limit == null ? '' : ' / ' + d.limit}** 次${d.limit == null ? '（不限）' : `（${d.base} + ${d.per} × ${d.valid} 个共享的 Pro 号）`}`;
  const rows = all('SELECT * FROM accounts WHERE owner_id = ? ORDER BY created_at', u.id).filter((r) => c.byId.has(r.auth_id));
  if (!rows.length) return dl + '\n' + `你还没有绑定号${base ? `，去这里添加：${base}/` : ''}`;
  const since = dayStart();
  const out = [dl, `**你的 ${rows.length} 个号**`];
  for (const r of rows) {
    const cred = c.byId.get(r.auth_id)!;
    const p = accountProblem(r, cred);
    const retry = cred.nextRetryAfter && Date.parse(cred.nextRetryAfter) > Date.now() ? cred.nextRetryAfter : null;
    const state = cred.disabled ? '⏸️ 已停用' : p ? `⚠️ ${p.label}` : retry || cred.unavailable ? '🧊 冷却中' : '✅ 正常';
    const today = one(`SELECT COUNT(*) AS n, SUM(user_id != owner_id OR user_id IS NULL) AS others FROM usage WHERE auth_id = ? AND ts >= ?`, r.auth_id, since);
    out.push(`\n**${cred.email || r.email}** ${r.shared ? '· 🍲 大锅饭' : '· 🔒 小锅饭'}\n${state}${p ? ` — ${p.hint}` : ''}`);
    const q = storedQuota(r);
    if (q?.windows?.length) {
      for (const w of q.windows) out.push(`${WIN[w.key] || w.label}：${w.buckets.map((b) => `${BUCKET[b.window] || b.window} ${Math.round(b.frac * 100)}%`).join(' · ')}`);
    } else if (q?.groups?.length) out.push('额度：' + q.groups.map(([g, f]) => `${g === 'cl' ? 'Claude' : g === 'gp' ? 'Gemini Pro' : 'Gemini Flash'} ${Math.round(f * 100)}%`).join(' · '));
    if (r.quota_at) out.push(`-# 额度更新于 ${new Date(r.quota_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    out.push(`今天 ${Number(today?.n || 0)} 次请求${Number(today?.others) ? `，其中 ${today.others} 次在帮别人` : ''}`);
  }
  return out.join('\n');
}

// ---------- interactions endpoint ----------
let keyCache: [string, ReturnType<typeof createPublicKey>] | null = null;
function pubKey(hex: string) {
  if (keyCache?.[0] !== hex) keyCache = [hex, createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' })];
  return keyCache[1];
}
export function verifySignature(hex: string, sig: string, ts: string, body: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/i.test(hex) || !/^[0-9a-f]{128}$/i.test(sig) || !ts) return false;
  try { return verify(null, Buffer.concat([Buffer.from(ts), body]), pubKey(hex), Buffer.from(sig, 'hex')); } catch { return false; }
}
export async function handleInteraction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const key = site.bot().publicKey;
  if (!key) throw new HttpError(404, 'not_found');
  const body = await readBody(req, 64 * 1024);
  if (!verifySignature(key, String(req.headers['x-signature-ed25519'] || ''), String(req.headers['x-signature-timestamp'] || ''), body)) throw new HttpError(401, 'invalid_signature');
  let i: any;
  try { i = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'bad_json'); }
  if (i.type === 1) return sendJSON(res, 200, { type: 1 });
  if (i.type !== 2) return sendJSON(res, 200, { type: 4, data: { content: '不支持的操作', flags: 64 } });
  const guild = site.discord().guildId;
  const uid = String(i.member?.user?.id || i.user?.id || '');
  const reply = (content: string, priv: boolean) => sendJSON(res, 200, { type: 4, data: { content: content.slice(0, 2000), flags: priv ? 64 : 0, allowed_mentions: { parse: [] } } });
  if (guild && i.guild_id !== guild) return reply('请在服务器里使用这个命令', true);
  const name = String(i.data?.name || '');
  if (name === '我的号') return reply(myAccounts(uid, await cpa.creds(30000)), true);
  if (name === '今日榜') return reply(leaderboard(dayStart(), now(), '🐶 **今日榜**（截至现在）') + '\n\n' + allTimeLine(), false);
  if (name === '免打扰') {
    const u = one('SELECT id, bot_quiet FROM users WHERE discord_id = ?', uid);
    if (!u) return reply('你还没登录过小锅饭，机器人本来也不会 @ 你', true);
    const opt = (i.data?.options || []).find((o: any) => o.name === '开启');
    const on = typeof opt?.value === 'boolean' ? opt.value : !u.bot_quiet;
    run('UPDATE users SET bot_quiet = ? WHERE id = ?', on ? 1 : 0, u.id);
    return reply(on ? '🔕 好的，以后机器人发消息不再 @ 你（号出问题照样会在频道里说，只是写你的名字）。想恢复再用一次 /免打扰' : '🔔 已恢复：号出问题时机器人会 @ 你', true);
  }
  return reply('不认识这个命令', true);
}

export function startBot(): void {
  registerCommands().catch(() => {});
  const watch = () => checkAccounts().catch((e) => console.error('[bot] account check', e.message));
  setInterval(watch, 5 * 60e3).unref();
  setTimeout(watch, 90e3).unref();
  setInterval(() => dailyTick().catch((e) => console.error('[bot] daily', e.message)), 60e3).unref();
}
