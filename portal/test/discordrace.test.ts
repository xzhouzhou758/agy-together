// 赛狗 Discord 版：身份对应、按钮调用的 fun 函数、文字跑道渲染。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir = '';
let db: typeof import('../src/db.ts');
let fun: typeof import('../src/fun.ts');
let dr: typeof import('../src/discordrace.ts');
const ID: Record<string, string> = { a: '100000000000000001', b: '100000000000000002', c: '100000000000000003', off: '100000000000000009' };
const U: Record<string, { id: number; role: string }> = {};
const ix = (who: string, data: any) => ({ type: data.custom_id ? 3 : 2, member: { user: { id: ID[who] || who } }, data });
const btn = (who: string, race: number, act: string, values?: string[]) => ix(who, { custom_id: `race:${race}:${act}`, values });

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-dcrace-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  db = await import('../src/db.ts');
  fun = await import('../src/fun.ts');
  dr = await import('../src/discordrace.ts');
  for (const n of ['a', 'b', 'c', 'off']) {
    db.run('INSERT INTO users (discord_id, name, created_at, role, active) VALUES (?, ?, ?, ?, ?)', ID[n], n, Date.now(), 'user', n === 'off' ? 0 : 1);
    U[n] = { id: Number(db.one('SELECT id FROM users WHERE name = ?', n)!.id), role: 'user' };
    fun.claim(U[n]);
  }
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('身份：Discord ID 对上门户用户；没注册 / 停用 / 乱写的都给私密登录提示', () => {
  assert.equal(dr.portalUser(ID.a)?.id, U.a.id);
  assert.equal(dr.portalUser(ID.off), null);
  assert.equal(dr.portalUser('999999999999999999'), null);
  assert.equal(dr.portalUser('local:bob'), null);
  for (const r of [dr.onCommand(ix('999999999999999999', { name: '赛狗' })), dr.onComponent(btn('999999999999999999', 1, 'join'))]) {
    assert.equal(r.body.type, 4);
    assert.equal(r.body.data.flags, 64);
    assert.match(r.body.data.content, /登录/);
    assert.equal(r.race, undefined);
  }
});

test('按钮调用对应的 fun 函数', () => {
  const calls: string[] = [];
  const fake: any = {
    raceCreate: () => { calls.push('create'); return { id: 7 }; },
    raceJoin: () => { calls.push('join'); }, raceDog: (_u: any, _id: number, d: number) => { calls.push('dog' + d); },
    raceReady: () => { calls.push('ready'); }, raceLeave: () => { calls.push('leave'); },
    raceGet: () => ({ id: 7, size: 3, mode: 'ready', fee: 5, pot: 5, phase: 'wait', startAt: null, endAt: null, order: null, plan: null, seats: [], mine: false }),
  };
  for (const a of ['join', 'ready', 'leave']) dr.onComponent(btn('a', 7, a), fake);
  dr.onComponent(btn('a', 7, 'dog', ['3']), fake);       // 还没进房：先加入再换狗
  const g = fake.raceGet; fake.raceGet = () => ({ ...g(), mine: true });
  dr.onComponent(btn('a', 7, 'dog', ['2']), fake);       // 已在房里：直接换
  assert.deepEqual(calls, ['join', 'ready', 'leave', 'join', 'dog3', 'dog2']);
  const r = dr.onComponent(btn('a', 7, 'ready'), fake);
  assert.equal(r.body.type, 7);                           // 成功 = 更新这条消息
  assert.equal(dr.onComponent(ix('a', { custom_id: 'race:x:boom' }), fake).body.data.flags, 64);
  // 出错只给自己看
  fake.raceJoin = () => { const e: any = new Error('满员了'); e.status = 400; throw e; };
  const err = dr.onComponent(btn('a', 7, 'join'), fake);
  assert.equal(err.body.type, 4); assert.equal(err.body.data.flags, 64); assert.equal(err.body.data.content, '满员了');
  // 带参数开房
  calls.length = 0;
  assert.equal(dr.onCommand(ix('a', { name: '赛狗', options: [{ name: '人数', value: 2 }] }), fake).race, 7);
  assert.deepEqual(calls, ['create']);
});

test('真流程：/赛狗 开房 → 下拉进房选狗 → 人齐发车 → 结算', () => {
  const r = dr.onCommand(ix('a', { name: '赛狗', options: [{ name: '人数', value: 2 }, { name: '入场费', value: 5 }] }));
  const id = r.race!;
  assert.equal(r.body.type, 4);
  assert.match(r.body.data.content, new RegExp(`赛狗 #${id}.*人齐就跑.*入场费 5🦴.*1/2`));
  const rows = r.body.data.components;
  assert.equal(rows[0].components[0].type, 3);           // 选狗下拉
  assert.equal(rows[0].components[0].options.length, 9); // 10 只里房主占了一只
  assert.ok(rows[1].components.some((b: any) => b.custom_id === `race:${id}:join`));
  // 不带参数：拉出这个等人的房
  assert.equal(dr.onCommand(ix('c', { name: '赛狗' })).race, id);
  // 抢已经有主的狗
  const taken = (fun.raceGet(U.a.id, id) as any).seats[0].dog;
  const bad = dr.onComponent(btn('b', id, 'dog', [String(taken)]));
  assert.equal(bad.body.data.flags, 64);
  // 加入：人齐就发车了
  const before = db.one('SELECT bones FROM fun_wallet WHERE user_id = ?', U.b.id)!.bones;
  const ok = dr.onComponent(btn('b', id, 'join'));
  assert.equal(ok.body.type, 7);
  assert.deepEqual(ok.body.data.components, []);          // 发车后去掉按钮
  assert.match(ok.body.data.content, /已发车/);            // 房间消息不放跑道
  assert.doesNotMatch(ok.body.data.content, /│/);
  const v = fun.raceGet(0, id) as any;
  assert.equal(v.phase, 'run');
  assert.ok(v.order.length === 2);
  const after = db.one('SELECT bones FROM fun_wallet WHERE user_id = ?', U.b.id)!.bones;
  const bWin = v.seats.find((s: any) => s.name === 'b').win;
  assert.equal(after, before - 5 + bWin);                  // 共用钱包
  // 结果帧
  const fin = dr.render(v, v.endAt + 1);
  assert.ok(fin.done);
  assert.match(fin.content, /🏁/);
  assert.match(fin.content, /🥇/);
  assert.match(fin.content, /\+10🦴/);                     // 2 人：冠军拿走 10
});

test('文字跑道：倒数在起点、中途在中间、冲线到终点并标奖牌，各道一样宽', () => {
  const v: any = { id: 9, size: 3, mode: 'full', fee: 5, pot: 15, phase: 'run', startAt: 10_000, endAt: 10_000 + 8000,
    order: [3, 0, 1], plan: { 0: [700, 1400, 2100, 2800, 3500, 4200, 4900, 5600, 6300, 7600], 1: [800, 1600, 2400, 3200, 4000, 4800, 5600, 6400, 7200, 8000], 3: [600, 1300, 2000, 2700, 3400, 4100, 4800, 5500, 6200, 7000] },
    seats: [{ name: 'a', dog: 0, ready: false, place: 2, win: 3 }, { name: 'b', dog: 1, ready: false, place: 3, win: 0 }, { name: '`c`', dog: 3, ready: false, place: 1, win: 12 }] };
  const start = dr.trackLines(v, -1000);
  assert.equal(start.length, 3);
  assert.ok(start[0].startsWith(' 1 │🐕 '));
  assert.ok(!start.join('').includes('`'));               // 名字里的反引号去掉，免得弄坏代码块
  const mid = dr.trackLines(v, 3500);
  const dots = (l: string) => (l.match(/·/g) || []).length;
  assert.ok(dots(mid[0]) > 5 && dots(mid[0]) < 15);
  const lane = (l: string) => l.slice(0, l.lastIndexOf('│')).replace(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/gu, 'D').length;
  assert.equal(new Set(mid.map(lane)).size, 1);           // 每道同宽，对得齐
  const end = dr.trackLines(v, 7000);
  assert.equal(dots(end[2]), dr.LANE);
  assert.match(end[2], /🥇$/);
  assert.doesNotMatch(end[0], /🥈/);                       // 1 号还没到
  // 整条消息：倒数 / 跑 / 结果
  assert.match(dr.render(v, 7000).content, /3…/);
  assert.match(dr.render(v, 12_000).content, /冲啊/);
  assert.ok(!dr.render(v, 12_000).done);
  const r = dr.render(v, 18_001);
  assert.ok(r.done);
  assert.deepEqual(r.content.split('\n').slice(2, 5).map((l) => l.slice(0, 2)), ['🥇', '🥈', '🥉']);
  assert.match(dr.render({ ...v, phase: 'gone', order: null }).content, /已解散/);
});

test('解散/重启：房间变化会推给 Discord 订阅者', async () => {
  const seen: number[][] = [];
  const off = fun.onRaceChange((ids) => seen.push(ids));
  const { id } = fun.raceCreate(U.c, { size: 3, mode: 'ready', fee: 1 });
  fun.raceLeave(U.c, id);
  await new Promise((r) => setImmediate(r));
  off();
  assert.ok(seen.flat().includes(id));
  assert.match(dr.render(fun.raceGet(0, id) as any).content, /已解散/);
});

test('发车后的房间消息：已发车 + 跳转链接，跑完补一行冠军', () => {
  const v: any = { id: 5, size: 2, mode: 'full', fee: 5, pot: 10, phase: 'run', startAt: 1000, endAt: 9000, order: [2, 0], plan: { 0: [9000], 2: [8000] },
    seats: [{ name: 'a', dog: 0, ready: false, place: 2, win: 0 }, { name: 'b_*x', dog: 2, ready: false, place: 1, win: 10 }] };
  const link = dr.jumpLink('1', '2', '3');
  assert.equal(link, 'https://discord.com/channels/1/2/3');
  const run = dr.renderRoom(v, link, 5000);
  assert.equal(run.content, `🐶 **赛狗 #5** · 已发车 → [看比赛](${link})`);
  assert.deepEqual(run.components, []);
  assert.ok(!run.done);
  assert.match(dr.renderRoom(v, '', 5000).content, /已发车$/);   // 比赛消息还没发出来：先不带链接
  const end = dr.renderRoom(v, link, 9000);
  assert.ok(end.done);
  assert.match(end.content, /\n🏆 冠军 3 号 🦮 金毛 · b\\_\\\*x \+10🦴$/);  // 名字里的 markdown 符号转义
  // 等人 / 解散时和房间渲染一样
  assert.equal(dr.renderRoom({ ...v, phase: 'gone', order: null }).content, dr.render({ ...v, phase: 'gone', order: null }).content);
});

test('来源：Discord 开的房记成 dc，网页开的记成 web；推送带上新房间和房主', async () => {
  const { EventEmitter } = await import('node:events');
  const got: string[] = [];
  const req: any = new EventEmitter(), res: any = Object.assign(new EventEmitter(), { writeHead() {}, write(s: string) { got.push(s); return true; } });
  fun.stream(req, res);
  const r = dr.onCommand(ix('b', { name: '赛狗', options: [{ name: '人数', value: 3 }] }));
  const web = fun.raceCreate(U.c, { size: 3, mode: 'full', fee: 1 });
  await new Promise((ok) => setImmediate(ok));
  req.emit('close');
  assert.equal(db.one('SELECT src FROM fun_race WHERE id = ?', r.race)!.src, 'dc');
  assert.equal(db.one('SELECT src FROM fun_race WHERE id = ?', web.id)!.src, 'web');
  const news = got.map((s) => /^data: (.*)$/m.exec(s)?.[1]).filter(Boolean).map((s) => JSON.parse(s!)).flatMap((m) => m.news || []);
  assert.deepEqual(news, [{ id: r.race, src: 'dc', host: 'b' }, { id: web.id, src: 'web', host: 'c' }]);
  fun.raceLeave(U.b, r.race!); fun.raceLeave(U.c, web.id);
});

test('网页房自动发到机器人频道：只发本次启动后新开、还在等人、没绑过消息的网页房', () => {
  const boot = 1000, ok = { src: 'web', state: 'wait', created_at: 2000 };
  assert.ok(dr.shouldAnnounce(ok, false, boot));
  assert.ok(!dr.shouldAnnounce(ok, true, boot));                         // 已经有 Discord 消息了
  assert.ok(!dr.shouldAnnounce({ ...ok, src: 'dc' }, false, boot));        // Discord 自己开的
  assert.ok(!dr.shouldAnnounce({ ...ok, created_at: 500 }, false, boot));  // 重启前的旧房
  assert.ok(!dr.shouldAnnounce({ ...ok, state: 'run' }, false, boot));
  assert.ok(!dr.shouldAnnounce(undefined, false, boot));
});

test('网页房发到机器人频道 + 聊天室：默认聊天室、可配置、去重去空', () => {
  assert.equal(dr.raceChannel(), dr.DEFAULT_RACE_CHANNEL);
  db.setSetting('bot_race_channel', '555');
  assert.equal(dr.raceChannel(), '555');
  db.setSetting('bot_race_channel', '');
  assert.equal(dr.raceChannel(), '');
  assert.deepEqual(dr.announceChannels('111', '222'), ['111', '222']);
  assert.deepEqual(dr.announceChannels('111', '111'), ['111']);
  assert.deepEqual(dr.announceChannels('', '222'), ['222']);
  assert.deepEqual(dr.announceChannels('111', ''), ['111']);
  db.run("DELETE FROM settings WHERE k = 'bot_race_channel'");
});

test('10 只选手：原来 5 只编号不变，新的接在后面；能换到新狗，房间消息和下拉都认得', () => {
  assert.equal(fun.DOGS.length, 10);
  assert.deepEqual(fun.DOGS.slice(0, 5).map((d) => d[1]), ['闪电', '卷毛', '金毛', '黑背', '野狼']);
  assert.deepEqual(fun.DOGS.slice(5).map((d) => d.join('')), ['🐓铁爪', '🐒金刚', '🐖獠牙', '🐢玄甲', '🦆疾风']);
  const r = dr.onCommand(ix('a', { name: '赛狗', options: [{ name: '人数', value: 3 }] }));
  const id = r.race!;
  const picked = dr.onComponent(btn('a', id, 'dog', ['9']));
  assert.equal(picked.body.type, 7);
  assert.match(picked.body.data.content, /10 🦆 疾风　  a/);
  assert.ok(!picked.body.data.components[0].components[0].options.some((o: any) => o.value === '9'));
  fun.raceLeave(U.a, id);
});
