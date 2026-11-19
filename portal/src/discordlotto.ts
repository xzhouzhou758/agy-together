// Discord 里买彩票：/彩票 号码1 号码2 特码 倍数（都可不填，不填就机选），和网页同一期、同一个奖池、同一个钱包。
// 买成功公开发一张小票；失败只给本人看。整点开奖后在机器人频道发开奖公告（只在本进程里开奖时发，重启不补发）。
import { randomInt } from 'node:crypto';
import { all } from './db.ts';
import * as site from './site.ts';
import * as fun from './fun.ts';
import { portalUser, needLogin, post, announceChannels, DEFAULT_RACE_CHANNEL } from './discordrace.ts';

export type Ops = Pick<typeof fun, 'lottoBuy' | 'overview'>;
const realOps: Ops = { lottoBuy: fun.lottoBuy, overview: fun.overview };
const priv = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
const pub = (content: string) => ({ type: 4, data: { content, allowed_mentions: { parse: [] } } });  // <@id> 显示名字但不 @ 人
const errText = (e: any) => (e && typeof e.message === 'string' && e.status ? e.message : '出错了，稍后再试');
const optOf = (i: any, name: string) => (i.data?.options || []).find((o: any) => o.name === name)?.value;

/** 距开奖还有多久 */
export function leftText(ms: number): string {
  const m = Math.floor(ms / 60e3);
  return m < 1 ? '不到 1 分钟' : `${m} 分钟`;
}
/** 小票 */
export function ticketText(who: string, nums: number[], sp: number, mult: number, picked: boolean, lotto: { label: string; pot: number; endsAt: number }, now = Date.now()): string {
  return `🎟️ ${who} 买了彩票 **${nums.join(' ')}** + 特码 **${sp}**${mult > 1 ? ` ×${mult}` : ''}${picked ? '（机选）' : ''}\n` +
    `第 ${lotto.label} 期 · 奖池 ${lotto.pot}🦴 · 还有 ${leftText(lotto.endsAt - now)}开奖`;
}

/** /彩票 */
export function onBuy(i: any, ops: Ops = realOps, rnd = (n: number) => randomInt(n), now = Date.now()): any {
  const id = String(i.member?.user?.id || i.user?.id || ''), u = portalUser(id);
  if (!u) return needLogin();
  const a = optOf(i, '号码1'), b = optOf(i, '号码2'), s = optOf(i, '特码'), mult = Number(optOf(i, '倍数') ?? 1);
  const picked = a == null || b == null || s == null;
  const nums = [a ?? rnd(10), b ?? rnd(10)], sp = s ?? rnd(10);
  try { ops.lottoBuy(u, nums, sp, mult); } catch (e) { return priv(`❌ ${errText(e)}`); }
  const l = ops.overview(u).lotto as { label: string; pot: number; endsAt: number };
  return pub(ticketText(`<@${id}>`, nums, sp, mult, picked, l, now));
}

/* —— 开奖公告 —— */
const realId = (d: unknown) => (typeof d === 'string' && /^\d{5,25}$/.test(d) ? d : '');
export function drawText(d: fun.Drawn, winners: { discord_id: string; name: string; hits: number; sp: number; win: number }[]): string {
  const lines = [`🎰 **彩票 ${d.label} 期开奖**：**${d.res.join(' ')}** + 特码 **${d.sp}** · 奖池 ${d.pot}🦴`];
  const by = new Map<string, { who: string; hits: number; sp: number; win: number }>();
  for (const w of winners) {
    const k = w.discord_id || w.name;
    const who = realId(w.discord_id) ? `<@${w.discord_id}>` : `**${String(w.name || '某人').replace(/[*_~`|]/g, '')}**`;
    const x = by.get(k) || { who, hits: 0, sp: 0, win: 0 };
    x.hits = Math.max(x.hits, w.hits + Number(w.sp)); x.sp += w.sp; x.win += w.win; by.set(k, x);
  }
  const list = [...by.values()].sort((a, b) => b.hits - a.hits || b.win - a.win);
  for (const x of list.slice(0, 20)) {
    const what = x.hits === 3 ? '🥇 全中' : x.hits === 2 ? '🥈 中两位' : '🎯 特码回血';
    lines.push(`${what} ${x.who} +${x.win}🦴`);
  }
  if (list.length > 20) lines.push(`…还有 ${list.length - 20} 人中奖`);
  if (!list.length) lines.push('这期没人中奖');
  if (d.carryOut > 0) lines.push(`${d.nTop ? '' : '没人全中，'}滚存 ${d.carryOut}🦴 到下期`);
  return lines.join('\n');
}
async function announce(d: fun.Drawn) {
  if (!d.tickets) return;   // 这期没人买：不发
  const w = all(`SELECT u.discord_id, u.name, t.hits, t.sp_hit AS sp, t.win FROM fun_ticket t JOIN users u ON u.id = t.user_id
    WHERE t.issue_id = ? AND t.win > 0`, d.id) as any[];
  const message = { content: drawText(d, w), components: [] };
  for (const channel of announceChannels(site.bot().channelId, DEFAULT_RACE_CHANNEL)) {
    if (!await post(channel, message)) console.warn('[lotto-dc] 公告发送失败', channel, d.label);
  }
}
export function startLottoDc() {
  fun.onLottoDrawn((d) => { announce(d).catch((e) => console.error('[lotto-dc]', (e as Error).message)); });
}
