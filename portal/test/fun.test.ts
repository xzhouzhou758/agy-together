// 游乐场：钱包 / 借贷 / G4A 兑换 / 水果机 / 彩票 2+1 / 赛狗。Run: node --test test/fun.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir = '';
let db: typeof import('../src/db.ts');
let fun: typeof import('../src/fun.ts');
const U: Record<string, { id: number; role: string }> = {};
const W = (u: { id: number }) => db.one('SELECT * FROM fun_wallet WHERE user_id = ?', u.id)!;
const setW = (u: { id: number }, k: string, v: any) => db.run(`UPDATE fun_wallet SET ${k} = ? WHERE user_id = ?`, v, u.id);
const total = (u: { id: number }) => W(u).bones + W(u).red;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-fun-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  delete process.env.FUN_G4A;
  db = await import('../src/db.ts');
  fun = await import('../src/fun.ts');
  for (const n of ['a', 'b', 'c', 'd', 'e', 'boss']) {
    db.run('INSERT INTO users (discord_id, name, created_at, role) VALUES (?, ?, ?, ?)', 'u' + n, n, Date.now(), n === 'boss' ? 'admin' : 'user');
    U[n] = { id: Number(db.one('SELECT id FROM users WHERE name = ?', n)!.id), role: n === 'boss' ? 'admin' : 'user' };
    fun.claim(U[n]);
  }
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('每天自动送骨头', () => {
  assert.equal(W(U.a).bones, fun.DAILY);
});

test('押注先扣红骨头，赢的给白骨头', () => {
  const a = U.a;
  fun.borrow(a, 10);
  assert.equal(W(a).red, 10);
  const r = fun.slots(a, 5, [0, 1, 2]); // 不中
  assert.equal(r.win, 0);
  assert.equal(W(a).red, 5); assert.equal(W(a).bones, 20);
  const r2 = fun.slots(a, 5, [4, 4, 4]); // 🐶 三连 ×100
  assert.equal(r2.win, 500); assert.ok(r2.three);
  assert.equal(W(a).red, 0); assert.equal(W(a).bones, 520);
  fun.repay(a);
  assert.equal(W(a).owed, 0);
});

test('水果机赔付表：三连 / 只有三种两连赔 / 无平局；返还和中奖率', () => {
  const m3 = [5, 8, 15, 30, 100];
  m3.forEach((m, i) => assert.equal(fun.slotPay(i, i, i), m));
  // 两连：任意两个位置相同都算
  for (const [a, b, c] of [[4, 4, 0], [4, 0, 4], [0, 4, 4]]) assert.equal(fun.slotPay(a, b, c), 5);
  assert.equal(fun.slotPay(3, 3, 1), 2);
  assert.equal(fun.slotPay(2, 0, 2), 2);
  assert.equal(fun.slotPay(0, 0, 1), 0);
  assert.equal(fun.slotPay(1, 2, 1), 0);
  assert.equal(fun.slotPay(0, 1, 2), 0);
  // 没有 ×1 的平局
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) assert.notEqual(fun.slotPay(a, b, c), 1);
  // 按权重精确算
  const w = fun.SYM.map((s) => s[1]), T = w.reduce((x, y) => x + y, 0);
  let rtp = 0, hit = 0;
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) {
    const p = (w[a] * w[b] * w[c]) / T ** 3, m = fun.slotPay(a, b, c);
    rtp += p * m; if (m) hit += p;
  }
  assert.ok(Math.abs(rtp - 0.945) < 0.002, `rtp ${rtp}`);
  assert.ok(Math.abs(hit - 0.226) < 0.002, `hit ${hit}`);
});

test('管理员无限：押注不扣骨头', () => {
  const before = W(U.boss).bones;
  fun.slots(U.boss, 5, [0, 1, 2]);
  assert.equal(W(U.boss).bones, before);
});

test('G4A：关着时兑换被拒、网关拒绝', () => {
  assert.equal(fun.G4A_ON, false);
  assert.throws(() => fun.g4a(U.b, 1), (e: any) => e.status === 403 && e.code === 'g4a_off');
  assert.equal(fun.argonCharge(U.b.id, false), 'off');
  assert.equal(fun.argonCharge(U.boss.id, true), 'free'); // 管理员开着无限：没开放也能测
  assert.equal(fun.overview(U.b).wallet.argon, undefined);
});

test('G4A：打开后扣白骨头加次数；欠款不能换；每天上限；网关扣次数、失败退回', () => {
  const b = U.b;
  fun.setG4A(true);
  try {
    setW(b, 'bones', 100);
    fun.borrow(b, 10);
    assert.throws(() => fun.g4a(b, 1), /fun_debt|狗哥/);
    fun.repay(b);
    const bones = W(b).bones;
    const r = fun.g4a(b, 2);
    assert.equal(r.argon, 2);
    assert.equal(W(b).bones, bones - 2 * fun.G4A_RATE);
    assert.equal(W(b).argon, 2);
    assert.throws(() => fun.g4a(b, fun.G4A_CAP - 1), /fun_g4a_cap|最多/);
    assert.throws(() => fun.g4a(b, 0), /次数不对/);
    // 网关：扣次数
    assert.equal(fun.argonCharge(b.id, false), 'paid');
    assert.equal(fun.argonCharge(b.id, false), 'paid');
    assert.equal(fun.argonCharge(b.id, false), 'none');
    fun.argonRefund(b.id);
    assert.equal(W(b).argon, 1);
    // 管理员无限不扣
    assert.equal(fun.argonCharge(U.boss.id, true), 'free');
    const v = fun.overview(b);
    assert.equal(v.wallet.argon, 1); assert.equal(v.wallet.g4aToday, 2);
  } finally { fun.setG4A(false); }
});

test('彩票 2+1：倍数权重平分、特码回血、红骨头先扣', () => {
  const { a, b, c, d } = U;
  for (const u of [a, b, c, d]) { setW(u, 'bones', 200); setW(u, 'red', 0); }
  fun.lottoDrawNow([0, 0, 0]); // 清空当前期，下一期保底
  fun.lottoBuy(a, [1, 2], 7, 2);   // 全中 + 特码，×2
  fun.lottoBuy(b, [1, 9], 7, 1);   // 中 1 位
  fun.lottoBuy(c, [5, 5], 7, 5);   // 只中特码，×5
  fun.lottoBuy(d, [1, 2], 4, 1);   // 中 1 位（第 2 位）
  assert.throws(() => fun.lottoBuy(a, [1, 2, 3], 7), /号码不对/);
  assert.throws(() => fun.lottoBuy(a, [1, 2], 7, 3), /倍数不对/);
  const v0 = fun.overview(a).lotto;
  assert.equal(v0.pot, 20 + 2 * 9);
  assert.deepEqual(v0.tickets.map((t) => [t.name, t.nums.join(''), t.sp, t.mult]), [['d', '12', 4, 1], ['c', '55', 7, 5], ['b', '19', 7, 1], ['a', '12', 7, 2]]);
  const wa = W(a).bones, wb = W(b).bones, wc = W(c).bones, wd = W(d).bones;
  const r = fun.lottoDrawNow([1, 2, 7]);
  assert.equal(r.pot, 38);
  assert.equal(r.nTop, 1); assert.equal(r.nSub, 2);
  assert.equal(W(a).bones - wa, 38);
  assert.equal(W(b).bones - wb, 6);
  assert.equal(W(d).bones - wd, 6);
  assert.equal(W(c).bones - wc, 3 * 5);
  assert.equal(r.carryOut, 0);
  const h = fun.overview(a).lotto.hist[0];
  assert.deepEqual([h.res, h.sp, h.myWin], [[1, 2], 7, 38]);
});

test('彩票：没人中的档滚到下期，保底 20；每期最多 5 注', () => {
  const { c, d } = U;
  fun.lottoBuy(c, [0, 0], 1, 10);  // 奖池 20 + 20
  fun.lottoBuy(d, [5, 0], 2, 1);   // 中 1 位
  const r = fun.lottoDrawNow([9, 0, 9]);
  assert.equal(r.pot, 42);
  assert.equal(r.nTop, 0); assert.equal(r.nSub, 0);
  assert.equal(r.carryOut, 42); // 只有头奖滚存
  assert.equal(fun.overview(c).lotto.carry, 42);
  const r2 = fun.lottoDrawNow([3, 3, 3]); // 空期：全部滚存
  assert.equal(r2.carryOut, 42);
  assert.equal(fun.overview(c).lotto.carry, Math.max(20, r2.carryOut));
  for (let i = 0; i < 5; i++) fun.lottoBuy(c, [i, i], i, 1);
  assert.throws(() => fun.lottoBuy(c, [9, 9], 9, 1), /每期最多/);
});

test('赛狗奖池分配：2/3/4/5 人', () => {
  assert.deepEqual(fun.prizeSplit(10, 2), [10]);
  assert.deepEqual(fun.prizeSplit(15, 3), [11, 4]);
  assert.deepEqual(fun.prizeSplit(20, 4), [12, 6, 2]);
  assert.deepEqual(fun.prizeSplit(25, 5), [13, 7, 5]);
  assert.deepEqual(fun.prizeSplit(100, 5), [50, 30, 20]);
});

test('赛狗：选狗独占、换狗，场上只有本场的狗；人齐发车按名次派奖', () => {
  const { a, b, c, d } = U;
  for (const u of [a, b, c, d]) { setW(u, 'bones', 100); setW(u, 'red', 0); }
  assert.throws(() => fun.raceCreate(a, { size: 4, mode: 'full', fee: 3 }), /入场费不对/);
  const { id } = fun.raceCreate(a, { size: 4, mode: 'full', fee: 5 });
  fun.raceJoin(b, id);
  let v = fun.raceGet(a.id, id);
  const da = v.seats.find((s) => s.me)!.dog, db_ = v.seats.find((s) => !s.me)!.dog;
  assert.notEqual(da, db_);
  assert.throws(() => fun.raceDog(b, id, da), /有主了/);
  const free = [0, 1, 2, 3, 4].find((x) => x !== da && x !== db_)!;
  fun.raceDog(b, id, free);
  v = fun.raceGet(a.id, id);
  assert.equal(v.seats.find((s) => !s.me)!.dog, free);
  assert.equal(v.pot, 10); assert.equal(v.phase, 'wait');
  assert.throws(() => fun.raceJoin(a, id), /已经在一场/);
  fun.raceJoin(c, id);
  const w = { a: W(a).bones, b: W(b).bones, c: W(c).bones, d: W(d).bones };
  fun.raceJoin(d, id, [c.id, a.id, d.id, b.id]);
  v = fun.raceGet(a.id, id);
  assert.equal(v.phase, 'run');
  const dogs = v.seats.map((s) => s.dog);
  assert.equal(new Set(dogs).size, 4);
  assert.deepEqual(Object.keys(v.plan).map(Number).sort(), dogs.slice().sort());
  for (const p of Object.values(v.plan) as number[][]) assert.equal(p.length, fun.RACE_CP);
  assert.equal(v.order!.length, 4);
  // 奖池 20：60/30/10
  assert.equal(W(c).bones - w.c, 12);
  assert.equal(W(a).bones - w.a, 6);
  assert.equal(W(d).bones - w.d, 2 - 5);
  assert.equal(W(b).bones - w.b, 0);
  assert.equal(v.seats.find((s) => s.me)!.place, 2);
  assert.throws(() => fun.raceDog(a, id, 0), /已经发车/);
});

test('赛狗：准备模式至少 2 人且全员准备才发车；2 人冠军拿全部', () => {
  const { c, d } = U;
  const { id } = fun.raceCreate(c, { size: 5, mode: 'ready', fee: 10 });
  fun.raceReady(c, id);
  assert.equal(fun.raceGet(c.id, id).phase, 'wait'); // 只有 1 人
  fun.raceJoin(d, id);
  assert.equal(fun.raceGet(c.id, id).phase, 'wait');
  const wd = total(d);
  fun.raceReady(d, id, [d.id, c.id]);
  const v = fun.raceGet(d.id, id);
  assert.equal(v.phase, 'run');
  assert.equal(v.seats.length, 2);
  assert.equal(total(d) - wd, 20);
});

test('赛狗：退出按原比例退回红 / 白骨头；最后一人退出解散', () => {
  const { e } = U;
  setW(e, 'bones', 15); setW(e, 'red', 0);
  fun.borrow(e, 10);
  const { id } = fun.raceCreate(e, { size: 3, mode: 'full', fee: 20 });
  assert.deepEqual([W(e).red, W(e).bones], [0, 5]);
  fun.raceLeave(e, id);
  assert.deepEqual([W(e).red, W(e).bones], [10, 15]);
  assert.equal(fun.raceGet(e.id, id).phase, 'gone');
  fun.repay(e);
});

test('还款：先收回没花掉的红骨头，还清后红骨头清零', () => {
  const a = U.c;
  setW(a, 'owed', 0); setW(a, 'red', 0); setW(a, 'owed_since', 0);
  fun.borrow(a, 10);
  const before = W(a).bones;
  const r = fun.repay(a);
  assert.equal(r.left, 0);
  assert.equal(r.red, 10);
  assert.equal(W(a).red, 0);
  assert.equal(W(a).owed, 0);
  assert.equal(W(a).bones, before);
});

test('卖屁股只记一次，余额不足保留加成，20 根拉杆后消耗', () => {
  const u = U.e;
  setW(u, 'bones', 0);
  setW(u, 'red', 0);
  fun.boostSlots(u);
  fun.boostSlots(u);
  assert.throws(() => fun.slots(u, 20), /骨头不够/);
  const state = fun.overview(u).slotBoost;
  assert.equal(state.ready, true);
  assert.equal(state.uses, 1);
  assert.equal(state.leaders[0].name, 'e');
  setW(u, 'bones', 20);
  fun.slots(u, 20, [0,0,0]);
  assert.equal(fun.overview(u).slotBoost.ready, false);
  fun.boostSlots(u);
  assert.equal(fun.overview(u).slotBoost.uses, 2);
});

test('财富榜计入红骨头及实时利息；三个水果机榜至少展示五位真实玩家', () => {
  const u = U.e;
  setW(u, 'bones', 40);
  setW(u, 'red', 30);
  setW(u, 'owed', 30);
  setW(u, 'owed_t', Date.now() - 3600000);
  const d = fun.overview(u);
  const me = d.wealth.mine!;
  assert.equal(me.balance, 70);
  assert.ok(Math.abs(me.debt - 30 * (1 + fun.LOAN_RATE)) < 0.01);
  assert.equal(me.assets, 70 - me.debt);
  assert.equal(d.wealth.leaders[me.rank - 1].me, true);
  for (const list of [d.slotRanks.wins, d.slotRanks.losses, d.slotBoost.leaders]) {
    assert.equal(list.length,5);
    assert.ok(list.every(p => Object.hasOwn(U, p.name)));
  }
});

test('负债榜只排欠款、含利息、个人名次独立', () => {
  const d=fun.overview(U.e).wealth;
  assert.ok(d.debtors.every((p,i)=>p.debt>0 && p.rank===i+1 && (!i || d.debtors[i-1].debt>=p.debt)));
  assert.equal(d.debtors[d.myDebt!.rank-1].me,true);
});
test('连续十次只计一次，下一把消耗', () => {
  const u=U.c;
  for(let i=0;i<9;i++) assert.equal(fun.boostSlots(u).golden,false);
  const state=()=>db.one('SELECT taps,uses,ready FROM fun_slot_boost WHERE user_id=?',u.id)!;
  assert.equal(state().taps,9);
  db.run('UPDATE fun_slot_boost SET last_tap=? WHERE user_id=?',Date.now()-5000,u.id);
  assert.equal(fun.boostSlots(u).golden,true);
  assert.equal(fun.overview(u).slotBoost.golden,true);
  assert.equal(state().taps,10);
  assert.equal(state().uses,21);
  setW(u,'bones',20);
  fun.slots(u,1,[0,0,0]);
  assert.equal(state().ready,0);
  assert.equal(state().taps,0);
  assert.equal(fun.overview(u).slotBoost.golden,false);
});

test('测试账号加运正常，永不计次或补位', () => {
  const u=U.a;
  db.run('INSERT INTO fun_boost_excluded(discord_id) SELECT discord_id FROM users WHERE id=?',u.id);
  db.run('DELETE FROM fun_slot_boost WHERE user_id=?',u.id);
  for(let i=0;i<10;i++) fun.boostSlots(u);
  setW(u,'bones',20);
  fun.slots(u,1,[0,0,0]);
  fun.boostSlots(u);
  const board=fun.overview(u).slotBoost;
  assert.equal(board.ready,true);
  assert.equal(board.uses,0);
  assert.ok(!board.leaders.some(p=>p.name==='a'));
});

test('彩蛋前三名：跳过测试账号，每人只领一次，重复触发仍加次数', () => {
  db.run('DELETE FROM fun_slot_discovery');
  const trigger=(u:typeof U.a)=>{
    db.run('DELETE FROM fun_slot_boost WHERE user_id=?',u.id);
    for(let i=0;i<9;i++) assert.equal(fun.boostSlots(u).reward,0);
    return fun.boostSlots(u);
  };
  assert.equal(trigger(U.a).reward,0);
  const before=W(U.b).bones;
  assert.equal(trigger(U.b).reward,500);
  assert.equal(W(U.b).bones,before+500);
  assert.equal(fun.boostSlots(U.b).reward,0);
  assert.equal(trigger(U.b).reward,0);
  const second=W(U.c).bones, third=W(U.d).bones;
  assert.equal(trigger(U.c).reward,100);
  assert.equal(W(U.c).bones,second+100);
  assert.equal(trigger(U.d).reward,50);
  assert.equal(W(U.d).bones,third+50);
  assert.equal(trigger(U.e).reward,0);
  assert.equal(fun.overview(U.e).slotBoost.uses,21);
  assert.equal(fun.boostSlots(U.e).uses,21);
  assert.equal(db.one('SELECT user_id FROM fun_slot_discovery WHERE id=1')!.user_id,U.b.id);
  const d=fun.overview(U.b);
  for(const list of [d.slotRanks.wins,d.slotRanks.losses,d.slotBoost.leaders]){
    assert.equal(list.length,5);
    for(const p of list) assert.equal(p.discoverer,p.name==='b');
  }
  assert.ok(d.slotBoost.leaders.some(p=>p.discoverer));
});
