// 真人赛狗 · Discord 版：/赛狗 开房或拉出等人的房，频道里一条「房间消息」带 加入 / 选狗 / 准备 / 退出 按钮，
// 发车时机器人在频道里另发一条「比赛消息」放倒数、文字跑道、名次和奖金；房间消息改成「已发车」+ 跳转链接，
// 跑完补一行冠军。发不出新消息时退回到在房间消息里放。房间和钱包与网页共用（都走 fun.ts）。
// 交互走 bot.ts 的 /discord/interactions（HTTP 回调，没有网关）；之后的编辑用 Bot Token 改消息，
// 同一频道两次编辑至少隔 EDIT_GAP，每条消息只发最新一帧，429 按 retry_after 等。
import { db, one, all, run, getSetting } from './db.ts';
import * as site from './site.ts';
import * as fun from './fun.ts';

const DAPI = 'https://discord.com/api/v10';
export const FRAME = 1500;      // 动画每帧间隔
export const EDIT_GAP = 1100;   // 同一频道两次编辑最少间隔（Discord 约 5 次 / 5 秒）
export const GLOBAL_GAP = 500;  // 所有频道合计：两次发 / 改消息最少间隔
/** 网页开的房除了机器人频道还发到这里（设置项 bot_race_channel，空 = 不发）。默认是聊天室。 */
export const DEFAULT_RACE_CHANNEL = '1544697187978580100';
export const raceChannel = () => (getSetting('bot_race_channel') ?? DEFAULT_RACE_CHANNEL).trim();
export const LANE = 20;         // 跑道格数
const TOKEN_TTL = 14 * 60e3;    // 交互令牌 15 分钟过期，留 1 分钟余量
const MEDAL = ['🥇', '🥈', '🥉'];
const MODE: Record<string, string> = { full: '人齐就跑', ready: '全员准备' };
export const DEFAULTS = { size: 3, mode: 'full', fee: 5 };

db.exec(`CREATE TABLE IF NOT EXISTS fun_race_dc (
  race_id INTEGER NOT NULL REFERENCES fun_race(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, message_id)
)`);
if (!all("SELECT name FROM pragma_table_info('fun_race_dc')").some((c) => c.name === 'kind')) db.exec("ALTER TABLE fun_race_dc ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'");

/* —— 渲染（纯函数） —— */
export type Seat = { name: string; dog: number; ready: boolean; place: number | null; win: number | null };
export type View = { id: number; size: number; mode: string; fee: number; pot: number; phase: string; startAt: number | null; endAt: number | null;
  order: number[] | null; plan: Record<string, number[]> | null; seats: Seat[] };
export type Msg = { content: string; components: any[] };

const clean = (s: string) => String(s || '—').replace(/[`\n\r]/g, '').slice(0, 16);
const dogE = (d: number) => fun.DOGS[d]?.[0] || '🐶';
const dogN = (d: number) => fun.DOGS[d]?.[1] || '';
const block = (lines: string[]) => '```\n' + lines.join('\n') + '\n```';
/** 和网页 games.js 的 lerpPos 一样：分段时间 → 0..1 的进度。 */
export function lerpPos(cp: number[], t: number): number {
  const K = cp.length;
  if (!K || t <= 0) return 0;
  if (t >= cp[K - 1]) return 1;
  let k = 0; while (cp[k] <= t) k++;
  const a = k ? cp[k - 1] : 0;
  return (k + (t - a) / (cp[k] - a)) / K;
}
/** 一帧文字跑道。t = 距发车的毫秒（负数 = 还在倒数）。 */
export function trackLines(v: View, t: number): string[] {
  const seats = [...v.seats].sort((a, b) => a.dog - b.dog);
  return seats.map((s) => {
    const cp = v.plan?.[s.dog] || [1];
    const p = lerpPos(cp, t), n = Math.min(LANE, Math.round(p * LANE));
    const fin = t >= cp[cp.length - 1] && v.order ? v.order.indexOf(s.dog) : -1;
    return `${String(s.dog + 1).padStart(2)} │${'·'.repeat(n)}${dogE(s.dog)}${' '.repeat(LANE - n)}│ ${clean(s.name)}${fin >= 0 && fin < 3 ? ' ' + MEDAL[fin] : ''}`;
  });
}
function head(v: View) { return `🐶 **赛狗 #${v.id}** · ${MODE[v.mode] || v.mode} · 入场费 ${v.fee}🦴 · 奖池 ${v.pot}🦴 · ${v.seats.length}/${v.size}`; }
// 只列已入座的；名字统一补到 3 个字宽，对齐
const pad3 = (n: string) => n + '　'.repeat(Math.max(0, 3 - [...n].length));
function waitLines(v: View): string[] {
  const seats = [...v.seats].sort((a, b) => a.dog - b.dog);
  const lines = seats.map((s) => `${String(s.dog + 1).padStart(2)} ${dogE(s.dog)} ${pad3(dogN(s.dog))}  ${clean(s.name)}${v.mode === 'ready' && s.ready ? ' ✅' : ''}`);
  for (let k = seats.length; k < v.size; k++) lines.push('   …  空位');
  return lines;
}
function waitComponents(v: View): any[] {
  const id = v.id, taken = new Set(v.seats.map((s) => s.dog)), rows: any[] = [];
  const free = fun.DOGS.map((_, d) => d).filter((d) => !taken.has(d));
  if (free.length) {
    rows.push({ type: 1, components: [{ type: 3, custom_id: `race:${id}:dog`, placeholder: '选狗 / 换狗',
      options: free.map((d) => ({ label: `${d + 1} 号 ${dogN(d)}`, value: String(d), emoji: { name: dogE(d) } })) }] });
  }
  const btn: any[] = [];
  if (v.seats.length < v.size) btn.push({ type: 2, style: 3, label: '加入', custom_id: `race:${id}:join` });
  if (v.mode === 'ready') btn.push({ type: 2, style: 1, label: '准备', custom_id: `race:${id}:ready` });
  btn.push({ type: 2, style: 4, label: '退出', custom_id: `race:${id}:leave` });
  const base = site.publicURL();
  if (base) btn.push({ type: 2, style: 5, label: '网页打开', url: base + '/' });
  rows.push({ type: 1, components: btn });
  return rows;
}
/** 房间消息在 now 这一刻应该长什么样；done = 以后不会再变了。 */
export function render(v: View, now = Date.now()): Msg & { done: boolean } {
  if (v.phase === 'wait') return { content: head(v) + '\n' + block(waitLines(v)), components: waitComponents(v), done: false };
  if (v.phase === 'gone' || !v.order || v.startAt == null) return { content: `🐶 **赛狗 #${v.id}** · 已解散，入场费已退`, components: [], done: true };
  const t = now - v.startAt;
  if (v.endAt != null && now >= v.endAt) {
    const lines = v.order.map((d, k) => {
      const s = v.seats.find((x) => x.dog === d);
      return `${MEDAL[k] || '  '} ${String(d + 1).padStart(2)} ${dogE(d)} ${pad3(dogN(d))}  ${clean(s?.name || '')}${s?.win ? `  +${s.win}🦴` : ''}`;
    });
    return { content: `🏁 **赛狗 #${v.id}** · 奖池 ${v.pot}🦴\n` + block(lines), components: [], done: true };
  }
  const tag = t < 0 ? `${Math.ceil(-t / 1000)}…` : t < (v.plan ? Math.min(...Object.values(v.plan).map((p) => p[p.length - 1])) * 0.8 : 0) ? '冲啊！' : '冲线！';
  return { content: `🐶 **赛狗 #${v.id}** · ${tag}\n` + block(trackLines(v, t)), components: [], done: false };
}

const md = (s: string) => clean(s).replace(/[*_~|>\\]/g, (c) => '\\' + c);
export const jumpLink = (guild: string, channel: string, message: string) => `https://discord.com/channels/${guild}/${channel}/${message}`;
/** 发车后的房间消息：已发车 + 去比赛消息的链接；跑完补一行冠军。 */
export function renderRoom(v: View, link = '', now = Date.now()): Msg & { done: boolean } {
  if (v.phase === 'wait' || v.phase === 'gone' || !v.order || v.startAt == null) return render(v, now);
  let content = `🐶 **赛狗 #${v.id}** · 已发车${link ? ` → [看比赛](${link})` : ''}`;
  const done = v.endAt != null && now >= v.endAt;
  if (done) {
    const d = v.order[0], s = v.seats.find((x) => x.dog === d);
    content += `\n🏆 冠军 ${d + 1} 号 ${dogE(d)} ${dogN(d)} · ${md(s?.name || '')}${s?.win ? ` +${s.win}🦴` : ''}`;
  }
  return { content, components: [], done };
}

/* —— 交互（纯逻辑，fun 的函数可替换，方便测试） —— */
export type Ops = Pick<typeof fun, 'raceCreate' | 'raceJoin' | 'raceDog' | 'raceReady' | 'raceLeave' | 'raceGet'>;
const realOps: Ops = { raceCreate: fun.raceCreate, raceJoin: fun.raceJoin, raceDog: fun.raceDog, raceReady: fun.raceReady, raceLeave: fun.raceLeave, raceGet: fun.raceGet };
export type PortalUser = { id: number; role: string };
/** Discord ID → 门户用户（没注册 / 被停用 = null）。 */
export function portalUser(discordId: string): PortalUser | null {
  if (!/^\d{5,25}$/.test(discordId)) return null;
  const u = one('SELECT id, role, active FROM users WHERE discord_id = ?', discordId);
  return u && u.active ? { id: Number(u.id), role: String(u.role) } : null;
}
const priv = (content: string, components: any[] = []) => ({ type: 4, data: { content, flags: 64, components, allowed_mentions: { parse: [] } } });
export function needLogin() {
  const base = site.publicURL();
  return priv('你还没登录过小锅饭，先去登录一次再来玩', base ? [{ type: 1, components: [{ type: 2, style: 5, label: '去小锅饭登录', url: base + '/' }] }] : []);
}
const errText = (e: any) => (e && typeof e.message === 'string' && e.status ? e.message : '出错了，稍后再试');
const view = (ops: Ops, id: number) => ops.raceGet(0, id) as unknown as View;
const opt = (i: any, name: string) => (i.data?.options || []).find((o: any) => o.name === name)?.value;
export type Reply = { body: any; race?: number; msg?: Msg & { done: boolean } };

/** /赛狗：带参数 = 开新房；不带参数 = 拉出最新一个等人的房，没有就按默认开一个。 */
export function onCommand(i: any, ops: Ops = realOps, now = Date.now()): Reply {
  const u = portalUser(String(i.member?.user?.id || i.user?.id || ''));
  if (!u) return { body: needLogin() };
  const size = opt(i, '人数'), mode = opt(i, '发车'), fee = opt(i, '入场费');
  let id: number;
  if (size == null && mode == null && fee == null && (id = Number(one("SELECT id FROM fun_race WHERE state = 'wait' ORDER BY id DESC LIMIT 1")?.id || 0))) {
    // 已有等人的房：直接展示
  } else {
    try { id = ops.raceCreate(u, { size: size ?? DEFAULTS.size, mode: mode ?? DEFAULTS.mode, fee: fee ?? DEFAULTS.fee }, 'dc').id; }
    catch (e) { return { body: priv(errText(e)) }; }
  }
  const m = render(view(ops, id), now);
  return { body: { type: 4, data: { content: m.content, components: m.components, allowed_mentions: { parse: [] } } }, race: id, msg: m };
}
/** 按钮 / 下拉：custom_id = race:<id>:join|dog|ready|leave。成功就把这条消息更新成最新状态（type 7）。 */
export function onComponent(i: any, ops: Ops = realOps, now = Date.now()): Reply {
  const m = /^race:(\d+):(join|dog|ready|leave)$/.exec(String(i.data?.custom_id || ''));
  if (!m) return { body: priv('这个按钮过期了') };
  const id = Number(m[1]), act = m[2];
  const u = portalUser(String(i.member?.user?.id || i.user?.id || ''));
  if (!u) return { body: needLogin() };
  try {
    if (act === 'join') ops.raceJoin(u, id);
    else if (act === 'ready') ops.raceReady(u, id);
    else if (act === 'leave') ops.raceLeave(u, id);
    else {
      const dog = Number(i.data?.values?.[0]);
      const cur = ops.raceGet(u.id, id) as any, mine = !!cur.mine;
      if (!mine && (cur.seats || []).some((s: any) => s.dog === dog)) return { body: priv('这条狗有主了') };
      if (!mine) { ops.raceJoin(u, id); if (view(ops, id).phase !== 'wait') return reply(ops, id, now); }
      ops.raceDog(u, id, dog);
    }
  } catch (e) { return { body: priv(errText(e)) }; }
  return reply(ops, id, now);
}
function reply(ops: Ops, id: number, now: number): Reply {
  const msg = renderRoom(view(ops, id), '', now);
  return { body: { type: 7, data: { content: msg.content, components: msg.components, allowed_mentions: { parse: [] } } }, race: id, msg };
}

/* —— 消息编辑：按频道排队、只发最新帧、尊重 429 —— */
type Target = { race: number; channel: string; message: string; kind: 'room' | 'show'; token?: string; tokenAt?: number; last?: string; want?: Msg & { done: boolean }; busy?: boolean };
const targets = new Map<string, Target>();          // message_id → 目标
const chanNext = new Map<string, number>();          // channel → 下次可以编辑的时刻
let globalNext = 0;                                  // 所有频道合计：下次可以发 / 改的时刻
/** 预约一个发送时刻（同频道隔 EDIT_GAP、全局隔 GLOBAL_GAP），返回要等多久。预约是同步的，并发也不会撞车。 */
function reserve(channel: string): number {
  const now = Date.now(), at = Math.max(now, chanNext.get(channel) || 0, globalNext);
  chanNext.set(channel, at + EDIT_GAP); globalNext = at + GLOBAL_GAP;
  return at - now;
}
const anims = new Set<number>();                     // 正在放动画的比赛
const launching = new Set<number>();                 // 正在发比赛消息的比赛
const fallback = new Set<string>();                  // 比赛消息发不出去：这些房间消息自己放动画
const announced = new Set<number>();                 // 已经往机器人频道发过的网页房
const BOOT = Date.now();                             // 重启前开的房不补发
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bind(race: number, channel: string, message: string, token?: string, kind: Target['kind'] = 'room') {
  run('INSERT OR IGNORE INTO fun_race_dc(race_id, channel_id, message_id, kind) VALUES(?,?,?,?)', race, channel, message, kind);
  let t = targets.get(message);
  if (!t) { t = { race, channel, message, kind }; targets.set(message, t); }
  if (token) { t.token = token; t.tokenAt = Date.now(); }
  return t;
}
async function send(t: Target, m: Msg): Promise<number> {
  const d = site.discord(), body = JSON.stringify({ content: m.content, components: m.components, allowed_mentions: { parse: [] } });
  const go = (url: string, auth: boolean) => fetch(url, { method: 'PATCH', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bot ' + d.botToken } : {}) }, body });
  let r = await go(`${DAPI}/channels/${t.channel}/messages/${t.message}`, true);
  // 机器人看不到的频道：交互令牌还没过期就用它改
  if (r.status === 403 && t.token && Date.now() - (t.tokenAt || 0) < TOKEN_TTL && d.clientId) r = await go(`${DAPI}/webhooks/${d.clientId}/${t.token}/messages/@original`, false);
  if (r.status === 429) { const j: any = await r.json().catch(() => ({})); return Math.ceil((Number(j?.retry_after) || 1) * 1000); }
  if (!r.ok) { console.error('[race-dc] edit failed', r.status); if ([403, 404].includes(r.status)) return -1; }
  return 0;
}
/** 把这条消息改成 m（只保留最新一帧）。 */
function want(t: Target, m: Msg & { done: boolean }) {
  if (m.content === t.last && !m.done) return;
  t.want = m;
  if (!t.busy) pump(t).catch((e) => console.error('[race-dc]', e.message));
}
async function pump(t: Target) {
  t.busy = true;
  try {
    while (t.want) {
      let m = t.want; t.want = undefined;
      if (m.content === t.last && !m.done) continue;
      const wait = reserve(t.channel);
      if (wait > 0) { await sleep(wait); if (t.want) { m = t.want; t.want = undefined; } } // 等的时候又来了新帧：发新的
      let r: number;
      try { r = await send(t, m); } catch (e) { console.error('[race-dc] edit', (e as Error).message); continue; } // 网络抖了：丢这一帧
      if (r > 0) { chanNext.set(t.channel, Date.now() + r); if (!t.want) t.want = m; continue; }
      if (r < 0) { finish(t); return; }   // 消息没了 / 改不了：不再管
      t.last = m.content;
      if (m.done) { finish(t); return; }
    }
  } finally { t.busy = false; }
}
function finish(t: Target) {
  run('UPDATE fun_race_dc SET done = 1 WHERE race_id = ? AND message_id = ?', t.race, t.message);
  targets.delete(t.message);
  fallback.delete(t.message);
}
function targetsOf(race: number): Target[] {
  for (const r of all('SELECT * FROM fun_race_dc WHERE race_id = ? AND done = 0', race)) if (!targets.has(r.message_id)) targets.set(r.message_id, { race, channel: r.channel_id, message: r.message_id, kind: r.kind === 'show' ? 'show' : 'room' });
  return [...targets.values()].filter((t) => t.race === race);
}
/** 在频道里发一条新消息（Bot Token），返回消息 id；失败返回空。 */
export async function post(channel: string, m: Msg): Promise<string> {
  const tok = site.discord().botToken;
  if (!tok) return '';
  for (let k = 0; k < 2; k++) {
    const wait = reserve(channel);
    if (wait > 0) await sleep(wait);
    try {
      const r = await fetch(`${DAPI}/channels/${channel}/messages`, { method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: 'Bot ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: m.content, components: m.components, allowed_mentions: { parse: [] } }) });
      if (r.status === 429) { const j: any = await r.json().catch(() => ({})); chanNext.set(channel, Date.now() + Math.ceil((Number(j?.retry_after) || 1) * 1000)); continue; }
      const j: any = await r.json().catch(() => null);
      if (r.ok && j?.id) return String(j.id);
      console.error(`[race-dc] post to channel ${channel} failed`, r.status, r.status === 403 ? '（机器人在这个频道没有发消息权限）' : r.status === 404 ? '（频道不存在或机器人看不到）' : '');
      return '';
    } catch (e) { console.error('[race-dc] post', (e as Error).message); return ''; }
  }
  return '';
}
/** 发车：每个有房间消息的频道发一条比赛消息（已经发过的不再发），然后放动画。 */
async function launch(race: number) {
  if (launching.has(race)) return;
  launching.add(race);
  try {
    const v = fun.raceGet(0, race) as unknown as View;
    const posted = new Set(all("SELECT channel_id FROM fun_race_dc WHERE race_id = ? AND kind = 'show'", race).map((r) => String(r.channel_id)));
    const rooms = targetsOf(race).filter((t) => t.kind === 'room');
    for (const ch of new Set(rooms.map((t) => t.channel))) {
      if (posted.has(ch)) continue;
      // 已经跑完（比如重启错过了）就不再补发新消息，直接在房间消息里给结果
      const id = v.phase === 'run' && Date.now() < (v.endAt || 0) ? await post(ch, render(v)) : '';
      if (id) { bind(race, ch, id, undefined, 'show').last = render(v).content; posted.add(ch); }
      else for (const t of rooms) if (t.channel === ch) fallback.add(t.message);
    }
  } catch (e) { console.error('[race-dc] launch', (e as Error).message); }
  finally { launching.delete(race); }
  return animate(race);
}
/** 网页新开的房（本次启动后开的、还没绑过 Discord 消息）：在机器人频道发一条房间消息。 */
export function shouldAnnounce(r: { src?: string; state?: string; created_at?: number } | undefined, bound: boolean, boot = BOOT): boolean {
  return !!r && r.src === 'web' && r.state === 'wait' && Number(r.created_at) >= boot && !bound;
}
/** 网页房发到哪些频道：机器人频道 + 聊天室（去重、去空）。 */
export const announceChannels = (bot = site.bot().channelId, chat = raceChannel()) => [...new Set([bot, chat].filter(Boolean))];
async function announce(race: number) {
  const chs = announceChannels();
  if (!chs.length || announced.has(race)) return;
  const r = one('SELECT src, state, created_at FROM fun_race WHERE id = ?', race) as any;
  if (!shouldAnnounce(r, !!one('SELECT 1 FROM fun_race_dc WHERE race_id = ?', race))) return;
  announced.add(race);
  // 各频道各发一条，互不影响；任意一边点按钮，refresh 会把所有绑定的消息一起刷新，发车后每个频道各发一条比赛消息同步播放
  await Promise.all(chs.map(async (ch) => {
    const m = render(fun.raceGet(0, race) as unknown as View);
    const id = await post(ch, m).catch(() => '');
    if (id) bind(race, ch, id).last = m.content;
    else console.error(`[race-dc] 网页房 #${race} 没能发到频道 ${ch}，只在其他频道显示`);
  }));
  refresh(race);   // 发出去之前房间可能已经变了（有人进、甚至发车）
}
function refresh(race: number) {
  const ts = targetsOf(race);
  if (!ts.length) { announce(race).catch((e) => console.error('[race-dc] announce', (e as Error).message)); return; }
  let v: View;
  try { v = fun.raceGet(0, race) as unknown as View; } catch { for (const t of ts) finish(t); return; }
  if (v.phase === 'run' || (v.phase === 'done' && v.order)) return void launch(race);
  const m = render(v);
  for (const t of ts) want(t, m);
}
/** 发车后每 FRAME 毫秒一帧，跑完发结果帧。 */
async function animate(race: number) {
  if (anims.has(race)) return;
  anims.add(race);
  try {
    for (;;) {
      const ts = targetsOf(race);
      if (!ts.length) return;
      const v = fun.raceGet(0, race) as unknown as View, m = render(v), guild = site.discord().guildId;
      const shows = new Map(ts.filter((t) => t.kind === 'show').map((t) => [t.channel, t.message]));
      for (const t of ts) {
        if (t.kind === 'show' || fallback.has(t.message) || !shows.has(t.channel) && !anyShow(race, t.channel)) want(t, m);
        else want(t, renderRoom(v, shows.has(t.channel) && guild ? jumpLink(guild, t.channel, shows.get(t.channel)!) : linkOf(race, t.channel)));
      }
      if (m.done) return;
      await sleep(Math.min(FRAME, Math.max(200, (v.endAt || 0) - Date.now() + 50)));
    }
  } catch (e) { console.error('[race-dc] animate', (e as Error).message); }
  finally { anims.delete(race); }
}

const anyShow = (race: number, ch: string) => !!one("SELECT 1 FROM fun_race_dc WHERE race_id = ? AND channel_id = ? AND kind = 'show'", race, ch);
function linkOf(race: number, ch: string) {
  const r = one("SELECT message_id FROM fun_race_dc WHERE race_id = ? AND channel_id = ? AND kind = 'show'", race, ch), g = site.discord().guildId;
  return r && g ? jumpLink(g, ch, String(r.message_id)) : '';
}

/* —— 接到 bot.ts —— */
export function handleCommand(i: any): any {
  const r = onCommand(i);
  if (r.race && i.token) setTimeout(() => adopt(r.race!, String(i.token)).catch((e) => console.error('[race-dc] adopt', e.message)), 300).unref?.();
  return r.body;
}
/** /赛狗 的回复发出去之后，查出这条消息的 id 记下来，以后才能改它。 */
async function adopt(race: number, token: string) {
  const d = site.discord();
  if (!d.clientId) return;
  for (let k = 0; k < 3; k++) {
    const r = await fetch(`${DAPI}/webhooks/${d.clientId}/${token}/messages/@original`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const j: any = r?.ok ? await r.json().catch(() => null) : null;
    if (j?.id) {
      const t = bind(race, String(j.channel_id), String(j.id), token);
      t.last = String(j.content || '');
      refresh(race);   // 回复发出后到现在房间可能已经变了
      return;
    }
    await sleep(1000);
  }
}
export function handleComponent(i: any): any {
  const r = onComponent(i);
  if (r.race && r.msg && i.message?.id && i.channel_id) {
    const t = bind(r.race, String(i.channel_id), String(i.message.id), i.token ? String(i.token) : undefined);
    t.last = r.msg.content;
    if (r.msg.done) finish(t);
    else if (!r.msg.components.length) setTimeout(() => refresh(r.race!), 0); // 刚发车：去发比赛消息
  }
  return r.body;
}
/** 启动：订阅房间变化；把重启前没收尾的房间消息补上（等人的刷新、跑着的接着放、跑完的直接给结果）。 */
export function startRaceDc() {
  fun.onRaceChange((ids) => { for (const id of ids) refresh(id); });
  for (const r of all('SELECT DISTINCT race_id FROM fun_race_dc WHERE done = 0')) refresh(Number(r.race_id));
}
/** 只给测试用。 */
export const _internal = { targets, bind, want };
