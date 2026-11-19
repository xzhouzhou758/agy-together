// Discord /骨头 /借骨头 /还骨头：私密钱包、公开借还 + 狗哥点评、失败只给本人看、没注册给登录提示。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir = '';
let db: typeof import('../src/db.ts');
let fun: typeof import('../src/fun.ts');
let bo: typeof import('../src/discordbones.ts');
const A = '200000000000000001', NOBODY = '299999999999999999';
let uid = 0;
const ix = (who: string, name: string, options: any[] = []) => ({ type: 2, member: { user: { id: who } }, data: { name, options } });
const W = () => db.one('SELECT * FROM fun_wallet WHERE user_id = ?', uid)!;
const all = (kind: string) => bo.QUIPS[kind].map((f) => f({ who: '<@' + A + '>', n: 30, owed: 120, left: 50 }));

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-dcbones-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  db = await import('../src/db.ts');
  fun = await import('../src/fun.ts');
  bo = await import('../src/discordbones.ts');
  db.run('INSERT INTO users (discord_id, name, created_at, role) VALUES (?, ?, ?, ?)', A, 'a', Date.now(), 'user');
  uid = Number(db.one('SELECT id FROM users WHERE discord_id = ?', A)!.id);
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('没注册：三个命令都给私密登录提示', () => {
  for (const r of [bo.onWallet(ix(NOBODY, '骨头')), bo.onBorrow(ix(NOBODY, '借骨头', [{ name: '金额', value: 10 }])), bo.onRepay(ix(NOBODY, '还骨头'))]) {
    assert.equal(r.type, 4); assert.equal(r.data.flags, 64); assert.match(r.data.content, /登录/);
  }
});

test('/骨头：只给本人看，没有按钮', () => {
  const r = bo.onWallet(ix(A, '骨头'));
  assert.equal(r.data.flags, 64);
  assert.equal(r.data.components, undefined);
  assert.equal(r.data.content, `🦴 白骨头 **${fun.DAILY}** · 红骨头 **0**\n不欠狗哥钱`);
});

test('/借骨头：公开，写谁借了多少、一共欠多少、利滚利，配第一次借的点评；不 @ 人', () => {
  const r = bo.onBorrow(ix(A, '借骨头', [{ name: '金额', value: 30 }]), undefined, () => 0);
  assert.equal(r.type, 4); assert.equal(r.data.flags, undefined);
  assert.deepEqual(r.data.allowed_mentions, { parse: [] });
  const [l1, l2] = r.data.content.split('\n');
  assert.equal(l1, `💸 <@${A}> 向狗哥借了 **30** 根红骨头，现在一共欠 **30** 根，每小时 +10% 利滚利`);
  assert.ok(all('first').includes(l2.replace('🐕‍🦺 狗哥：', '')));
  assert.equal(W().red, 30);
  assert.match(bo.onWallet(ix(A, '骨头')).data.content, /红骨头 \*\*30\*\*\n欠狗哥 \*\*30\.00\*\*🦴 · 每小时 \+10% 利滚利$/);
  // 再借：越借越多
  const r2 = bo.onBorrow(ix(A, '借骨头', [{ name: '金额', value: 10 }]));
  assert.match(r2.data.content, /一共欠 \*\*40\*\* 根/);
  assert.ok(bo.QUIPS.more.some((f) => r2.data.content.endsWith(f({ who: `<@${A}>`, n: 10, owed: 40, left: 40 }))));
});

test('借款不设上限；欠得多换点评', () => {
  db.run('UPDATE fun_wallet SET owed = 1000, red = 1000 WHERE user_id = ?', uid);
  const r = bo.onBorrow(ix(A, '借骨头', [{ name: '金额', value: 10 }]));
  assert.equal(r.data.flags, undefined);
  db.run('UPDATE fun_wallet SET owed = 100, red = 100 WHERE user_id = ?', uid);
  const ok = bo.onBorrow(ix(A, '借骨头', [{ name: '金额', value: 10 }]));
  assert.equal(ok.data.flags, undefined);
  assert.match(ok.data.content, /一共欠 \*\*110\*\* 根/);
  assert.ok(bo.QUIPS.near.some((f) => ok.data.content.endsWith(f({ who: `<@${A}>`, n: 10, owed: Number(/一共欠 \*\*(\d+)/.exec(ok.data.content)![1]), left: 0 }))));
});

test('/还骨头：部分还公开，先红后白；没骨头还只给本人看；还清换点评', () => {
  db.run('UPDATE fun_wallet SET owed = 100, red = 20, bones = 20 WHERE user_id = ?', uid);
  const r = bo.onRepay(ix(A, '还骨头'), undefined, () => 0);
  assert.equal(r.data.flags, undefined);
  assert.match(r.data.content, new RegExp(`^💰 <@${A}> 还了狗哥 \\*\\*40\\*\\* 根（红骨头 20 \\+ 白骨头 20），还欠 \\*\\*6[0-9]\\*\\* 根\\n🐕‍🦺 狗哥：`));
  assert.equal(W().red, 0); assert.equal(W().bones, 0);
  const broke = bo.onRepay(ix(A, '还骨头'));
  assert.equal(broke.data.flags, 64); assert.match(broke.data.content, /^❌ 没有骨头还/);
  db.run('UPDATE fun_wallet SET owed = 10, red = 0, bones = 50, owed_since = ? WHERE user_id = ?', Date.now() - 3600e3, uid);
  const clear = bo.onRepay(ix(A, '还骨头'));
  assert.match(clear.data.content, /\*\*已经还清\*\*/);
  assert.ok(all('clear').some((q) => clear.data.content.endsWith(q)));
  assert.equal(W().owed, 0);
  const none = bo.onRepay(ix(A, '还骨头'));
  assert.equal(none.data.flags, 64); assert.match(none.data.content, /没欠钱/);
});

test('点评分类和不重复', () => {
  const w = { bones: 0, red: 0, owed: 0, overdue: false, inf: false };
  assert.equal(bo.borrowKind(w, 10), 'first');
  assert.equal(bo.borrowKind({ ...w, owed: 10 }, 40), 'more');
  assert.equal(bo.borrowKind({ ...w, owed: 90 }, 120), 'near');
  assert.equal(bo.borrowKind({ ...w, owed: 90, overdue: true }, 120), 'overdue');
  assert.equal(bo.repayKind({ ...w, owed: 50 }, 10), 'part');
  assert.equal(bo.repayKind({ ...w, owed: 50, since: Date.now() - 3600e3 }, 0), 'clear');
  assert.equal(bo.repayKind({ ...w, owed: 50, since: Date.now() - 13 * 3600e3 }, 0), 'late');
  assert.equal(bo.repayKind({ ...w, owed: 50, overdue: true }, 0), 'late');
  for (const k of Object.keys(bo.QUIPS)) assert.ok(bo.QUIPS[k].length >= 4 && bo.QUIPS[k].length <= 6, k);
  // 随机数连着给同一个，也不会连着出同一句
  const c = { who: 'x', n: 1, owed: 1, left: 1 };
  let prev = '';
  for (let k = 0; k < 10; k++) { const q = bo.quip('part', c, () => 0); assert.notEqual(q, prev); prev = q; }
});
