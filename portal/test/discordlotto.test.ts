// Discord /彩票：和网页同一期同一钱包；小票公开、失败私密、没注册给登录提示；开奖公告内容。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir = '';
let db: typeof import('../src/db.ts');
let fun: typeof import('../src/fun.ts');
let lo: typeof import('../src/discordlotto.ts');
const A = '300000000000000001', B = '300000000000000002';
const U: Record<string, { id: number; role: string }> = {};
const ix = (who: string, options: any[] = []) => ({ type: 2, member: { user: { id: who } }, data: { name: '彩票', options } });
const bones = (u: { id: number }) => db.one('SELECT bones FROM fun_wallet WHERE user_id = ?', u.id)!.bones;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-dclotto-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  db = await import('../src/db.ts');
  fun = await import('../src/fun.ts');
  lo = await import('../src/discordlotto.ts');
  for (const [n, d] of [['a', A], ['b', B], ['w', 'local:w']]) {
    db.run('INSERT INTO users (discord_id, name, created_at, role) VALUES (?, ?, ?, ?)', d, n, Date.now(), 'user');
    U[n] = { id: Number(db.one('SELECT id FROM users WHERE name = ?', n)!.id), role: 'user' };
    fun.claim(U[n]);
  }
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('没注册：私密登录提示', () => {
  const r = lo.onBuy(ix('399999999999999999'));
  assert.equal(r.data.flags, 64); assert.match(r.data.content, /登录/);
});

test('自选号码 ×2：公开小票，扣同一个钱包，算进同一期', () => {
  const before = bones(U.a);
  const r = lo.onBuy(ix(A, [{ name: '号码1', value: 3 }, { name: '号码2', value: 7 }, { name: '特码', value: 5 }, { name: '倍数', value: 2 }]));
  assert.equal(r.data.flags, undefined);
  assert.deepEqual(r.data.allowed_mentions, { parse: [] });
  const [l1, l2] = r.data.content.split('\n');
  assert.equal(l1, `🎟️ <@${A}> 买了彩票 **3 7** + 特码 **5** ×2`);
  const l = fun.overview(U.a).lotto;
  assert.match(l2, new RegExp(`^第 ${l.label} 期 · 奖池 ${l.pot}🦴 · 还有 (\\d+ 分钟|不到 1 分钟)开奖$`));
  assert.equal(bones(U.a), before - fun.TICKET * 2);
  assert.ok(l.tickets.some((t: any) => t.name === 'a' && t.nums.join('') === '37' && t.sp === 5 && t.mult === 2));
});

test('不带参数：机选一注 ×1；买满后只给本人看', () => {
  const r = lo.onBuy(ix(B), undefined, () => 4);
  assert.match(r.data.content, new RegExp(`^🎟️ <@${B}> 买了彩票 \\*\\*4 4\\*\\* \\+ 特码 \\*\\*4\\*\\*（机选）`));
  for (let k = 1; k < fun.TICKETS; k++) lo.onBuy(ix(B), undefined, () => 4);   // 固定机选，免得碰巧中奖
  const full = lo.onBuy(ix(B));
  assert.equal(full.data.flags, 64); assert.match(full.data.content, /^❌ 每期最多/);
  db.run('UPDATE fun_wallet SET bones = 0, red = 0 WHERE user_id = ?', U.a.id);
  const broke = lo.onBuy(ix(A));
  assert.equal(broke.data.flags, 64); assert.match(broke.data.content, /^❌ 骨头不够/);
});

test('开奖钩子：网页买的票也算；公告写开奖号、中奖人、滚存', async () => {
  fun.lottoBuy(U.w, [3, 1], 5, 1);   // 网页买的：中 1 位 + 特码
  let got: any = null;
  const off = fun.onLottoDrawn((d) => { got = d; });
  fun.lottoDrawNow([3, 7, 5]);
  await new Promise((r) => setImmediate(r));
  off();
  assert.equal(got.label.length > 0, true);
  assert.deepEqual([got.res, got.sp, got.nTop, got.nSub], [[3, 7], 5, 1, 1]);
  const w = db.all('SELECT u.discord_id, u.name, t.hits, t.sp_hit AS sp, t.win FROM fun_ticket t JOIN users u ON u.id = t.user_id WHERE t.issue_id = ? AND t.win > 0', got.id) as any[];
  const text = lo.drawText(got, w);
  const lines = text.split('\n');
  assert.equal(lines[0], `🎰 **彩票 ${got.label} 期开奖**：**3 7** + 特码 **5** · 奖池 ${got.pot}🦴`);
  assert.match(lines[1], new RegExp(`^🥇 全中 <@${A}> → \\*\\*\\+\\d+\\*\\*🦴$`));
  assert.ok(lines.some((l) => /^🥈 中两位 \*\*w\*\* → \*\*\+\d+\*\*🦴$/.test(l)));      // 网页用户没有 Discord ID：写名字
  // 没人全中
  const t2 = lo.drawText({ ...got, nTop: 0, carryOut: 30 }, []);
  assert.match(t2, /这期没人中奖\n没人全中，滚存 30🦴 到下期$/);
});

test('剩余时间', () => {
  assert.equal(lo.leftText(30e3), '不到 1 分钟');
  assert.equal(lo.leftText(23 * 60e3 + 5e3), '23 分钟');
});
