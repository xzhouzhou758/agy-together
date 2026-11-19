// Discord 里的钱包和狗哥借贷：
//  /骨头    只给本人看：白骨头、红骨头、欠狗哥多少（含实时利息）、是否逾期；
//  /借骨头  金额 10 / 30，结果公开发在频道里，配一句狗哥的点评；
//  /还骨头  能还多少还多少，结果公开，也配点评。
// 借还直接调 fun.ts 的 borrow / repay（规则全在那边）；失败（没骨头还等）只给本人看。
import { randomInt } from 'node:crypto';
import * as fun from './fun.ts';
import { portalUser, needLogin } from './discordrace.ts';

export type Wallet = { bones: number; red: number; owed: number; overdue: boolean; inf: boolean; since?: number };
export type Ops = Pick<typeof fun, 'overview' | 'borrow' | 'repay'>;
const realOps: Ops = { overview: fun.overview, borrow: fun.borrow, repay: fun.repay };
export const LONG = 12 * 3600e3;   // 欠这么久才还清算「拖了很久」

/* —— 狗哥点评：每类随机抽，同一类不连着出同一句 —— */
type Ctx = { who: string; n: number; owed: number; left: number };
export const QUIPS: Record<string, ((c: Ctx) => string)[]> = {
  first: [
    (c) => `开张了开张了！${c.who} 第一次来，${c.n} 根先拿去，利息的事咱们慢慢聊。`,
    (c) => `${c.who} 头回借钱，手还挺稳。记住，我这儿的利息比你的手气涨得快。`,
    () => '新客户八折？没有的事。每小时 10%，童叟无欺。',
    (c) => `${c.n} 根红骨头，拿去玩吧。输了别哭，赢了也别忘了我。`,
    (c) => `欢迎光临狗哥钱庄，${c.who}。合同没有，记性我有。`,
  ],
  more: [
    (c) => `又来了？上回的还在利滚利呢，现在一共欠我 ${c.owed} 根。`,
    (c) => `${c.who} 你这是把我当提款机了吧？行，${c.n} 根，记账上。`,
    () => '借钱的时候叫狗哥，还钱的时候叫什么来着？',
    (c) => `一共 ${c.owed} 根了啊。我不催，利息替我催。`,
    (c) => `${c.who} 再借下去，我得给你开个 VIP 专属账本了。`,
    () => '你这借钱的频率，赛狗都追不上。',
  ],
  near: [
    (c) => `${c.who} 欠到 ${c.owed} 根了，我照借，利息也照滚，懂吧？`,
    () => '狗哥不设上限，你的胆子也不设上限是吧？',
    (c) => `${c.owed} 根！你这账本我都不敢翻了。`,
    (c) => `${c.who}，狗哥没有上限，可你的骨头有啊，收收手吧。`,
    () => '利滚利滚成雪球了，滚到我脚边记得停一下。',
  ],
  overdue: [
    (c) => `逾期了还敢来借？${c.who} 你的脸皮比我的骨头还硬。`,
    () => '老账没清就来开新账，你当我这是许愿池啊？',
    (c) => `${c.who}，你那笔已经逾期了，每天的骨头我照收，今天的 ${c.n} 根也一起记上。`,
    () => '借！当然借！反正你每天的骨头都归我了。',
    () => '欠着钱还来借，狗哥欣赏你的勇气，不欣赏你的信用。',
  ],
  part: [
    (c) => `还了一点是一点，${c.who}，剩下 ${c.left} 根继续给你算利息。`,
    (c) => `收到。还欠 ${c.left} 根，别以为我会忘。`,
    () => '这叫还钱？这叫给利息上个香。',
    (c) => `${c.who} 有进步，不过 ${c.left} 根还在跑，跑得比赛狗还快。`,
    () => '分期还款也是还款，狗哥大度，利息不大度。',
  ],
  clear: [
    (c) => `${c.who} 一次还清！爽快，下次还来找我啊。`,
    () => '账清了，咱俩又是清清白白的好朋友了。',
    (c) => `两清！${c.who} 你现在是全场最干净的狗。`,
    () => '还清了？我这账本突然少了个老朋友，有点寂寞。',
    () => '干脆！就冲这份利索，下回利息……还是 10%。',
  ],
  late: [
    (c) => `${c.who} 终于还清了，我都快把你写进遗嘱了。`,
    () => '拖了这么久才还，利息都快比本金高了，划不划算自己算。',
    (c) => `还清了！这笔钱在外面过得比 ${c.who} 还滋润。`,
    () => '迟到总比不到好，下回早点来，省得我天天念叨你。',
    () => '恭喜你，用实际行动证明了复利的威力。',
  ],
};
const lastPick = new Map<string, number>();
export function quip(kind: string, c: Ctx, rnd = (n: number) => randomInt(n)): string {
  const list = QUIPS[kind];
  let k = rnd(list.length);
  if (list.length > 1 && k === lastPick.get(kind)) k = (k + 1 + rnd(list.length - 1)) % list.length;
  lastPick.set(kind, k);
  return list[k](c);
}
/** 借款点评挑哪一类：逾期还来借 > 第一次 > 欠得很多 > 越借越多。before = 借之前的钱包，owed = 借之后的欠款。 */
export function borrowKind(before: Wallet, owed: number): string {
  if (before.overdue) return 'overdue';
  if (!before.owed) return 'first';
  if (owed >= fun.LOAN_HEAVY) return 'near';
  return 'more';
}
/** 还款点评：没还清 = 部分还；还清了看欠了多久。 */
export function repayKind(before: Wallet, left: number, now = Date.now()): string {
  if (left > 0) return 'part';
  return before.overdue || (before.since && now - before.since > LONG) ? 'late' : 'clear';
}

/* —— 消息 —— */
export function walletText(w: Wallet): string {
  const lines = [`🦴 白骨头 **${w.inf ? '∞' : w.bones}** · 红骨头 **${w.red}**`];
  if (w.owed) lines.push(`欠狗哥 **${w.owed.toFixed(2)}**🦴 · 每小时 +${Math.round(fun.LOAN_RATE * 100)}% 利滚利${w.overdue ? ' · ⚠️ 已逾期' : ''}`);
  else lines.push('不欠狗哥钱');
  return lines.join('\n');
}
const priv = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
const pub = (content: string) => ({ type: 4, data: { content, allowed_mentions: { parse: [] } } });  // 写 <@id> 显示名字但不 @ 人
const errText = (e: any) => (e && typeof e.message === 'string' && e.status ? e.message : '出错了，稍后再试');
const uidOf = (i: any) => String(i.member?.user?.id || i.user?.id || '');
const walletOf = (ops: Ops, u: { id: number; role: string }) => ops.overview(u).wallet as Wallet;
const optOf = (i: any, name: string) => (i.data?.options || []).find((o: any) => o.name === name)?.value;

/** /骨头 */
export function onWallet(i: any, ops: Ops = realOps): any {
  const u = portalUser(uidOf(i));
  if (!u) return needLogin();
  return priv(walletText(walletOf(ops, u)));
}
/** /借骨头 金额 */
export function onBorrow(i: any, ops: Ops = realOps, rnd?: (n: number) => number): any {
  const id = uidOf(i), u = portalUser(id);
  if (!u) return needLogin();
  const n = Number(optOf(i, '金额') ?? fun.LOAN_STEP[0]);
  const before = walletOf(ops, u);
  let r: { n: number; owed: number };
  try { r = ops.borrow(u, n); } catch (e) { return priv(`❌ ${errText(e)}`); }
  const who = `<@${id}>`, owed = Math.max(r.n, Math.round(walletOf(ops, u).owed)); // borrow 返回的是向上取整，刚借完几毫秒的利息会多出 1 根
  return pub(`💸 ${who} 向狗哥借了 **${r.n}** 根红骨头，现在一共欠 **${owed}** 根，每小时 +${Math.round(fun.LOAN_RATE * 100)}% 利滚利\n` +
    `🐕‍🦺 狗哥：${quip(borrowKind(before, owed), { who, n: r.n, owed, left: owed }, rnd)}`);
}
/** /还骨头：能还多少还多少 */
export function onRepay(i: any, ops: Ops = realOps, rnd?: (n: number) => number, now = Date.now()): any {
  const id = uidOf(i), u = portalUser(id);
  if (!u) return needLogin();
  const before = walletOf(ops, u);
  let r: { paid: number; red: number; white: number; left: number };
  try { r = ops.repay(u); } catch (e) { return priv(`❌ ${errText(e)}`); }
  const who = `<@${id}>`;
  const parts = [r.red ? `红骨头 ${r.red}` : '', r.white ? `白骨头 ${r.white}` : ''].filter(Boolean).join(' + ');
  return pub(`💰 ${who} 还了狗哥 **${r.paid}** 根${parts ? `（${parts}）` : ''}，${r.left ? `还欠 **${r.left}** 根` : '**已经还清**'}\n` +
    `🐕‍🦺 狗哥：${quip(repayKind(before, r.left, now), { who, n: r.paid, owed: r.left, left: r.left }, rnd)}`);
}
