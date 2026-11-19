// 游乐场：白骨头（每天自动送）+ 狗哥借贷 + 水果机 + 每小时彩票（2+1 倍投）+ 真人赛狗；白骨头可兑换大锅饭 G4A（Gemini 4 Argon）次数。
import { randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, one, all, run, tx } from './db.ts';
import { HttpError } from './util.ts';

/* —— 经济 —— */
export const DAILY = 20;          // 每人每天自动送的白骨头
/* —— G4A 兑换：大锅饭下线后关闭 —— */
export let G4A_ON = false;
export const G4A_RATE = 5;        // 多少白骨头换 1 次
export const G4A_CAP = 20;        // 每人每天最多换几次
export const G4A_STEPS = [1, 5];  // 界面上的兑换按钮
/* —— 狗哥借贷：借来的是红骨头，只能押注 —— */
export const LOAN_STEP = [10, 30];
export const LOAN_MAX = 0;        // 最多欠多少（含利息），0 = 不设上限
export const LOAN_HEAVY = 105;    // 欠到这么多，狗哥换狼脸
export const LOAN_RATE = 0.10;    // 每小时复利
export const LOAN_DUE = 24;       // 超过多少小时没还清算逾期
/* —— 水果机 —— */
// 图案, 权重, 三连倍数, 两连倍数（0 = 两连不赔）。基础返还约 89.9%，中奖率约 22.6%
export const SYM: [string, number, number, number][] = [['🐾', 8, 4, 0], ['🦴', 7, 7, 0], ['🍖', 5, 15, 2], ['💩', 4, 25, 3], ['🐶', 2, 50, 4]];
export const SLOT_BETS = [1, 2, 5, 10, 20];
/* —— 彩票：2 位号码 + 1 位特码，可倍投 —— */
export const TICKET = 2;          // 每注（×倍数）
export const TICKETS = 5;         // 每人每期最多几注
export const LOT_MULTS = [1, 2, 5, 10];
export const SECOND_PRIZE = 6;
export const SEED = 20;           // 每期保底奖池
export const SP_BACK = 3;         // 特码命中回血（×倍数）
export const LOT_KEEP = 12;       // 保留多少期历史
/* —— 赛狗 —— */
// 编号就是下标：只能往后加，不能改顺序（旧比赛记录里存的是编号）
export const DOGS: [string, string][] = [['🐕', '闪电'], ['🐩', '卷毛'], ['🦮', '金毛'], ['🐕‍🦺', '黑背'], ['🐺', '野狼'],
  ['🐓', '铁爪'], ['🐒', '金刚'], ['🐖', '獠牙'], ['🐢', '玄甲'], ['🦆', '疾风']];
export const FEES = [1, 5, 10, 20];   // 入场费
export const RACE_SIZES = [2, 5];     // 最少 / 最多人数
export const PRIZES: Record<number, number[]> = { 2: [100], 3: [70, 30], 4: [60, 30, 10], 5: [50, 30, 20] }; // 按人数分奖（%）
export const RACE_WAIT = 10 * 60e3;   // 等这么久没发车就解散
export const RACE_KEEP = 2 * 60e3;    // 跑完后在大厅里留多久
export const RACE_LEAD = 3500;        // 发车前倒数
export const RACE_MS = [7000, 8200];  // 冠军用时范围
export const RACE_GAP = [140, 480];   // 后一名比前一名慢多少
export const RACE_CP = 10;            // 赛程分几段（中途名次变化）
/* —— 实时推送 —— */
export const SSE_PING = 25e3;
export const SSE_MAX = 2000;

db.exec(`
CREATE TABLE IF NOT EXISTS fun_wallet (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bones INTEGER NOT NULL DEFAULT 0,
  red INTEGER NOT NULL DEFAULT 0,
  owed REAL NOT NULL DEFAULT 0,
  owed_t INTEGER NOT NULL DEFAULT 0,
  owed_since INTEGER NOT NULL DEFAULT 0,
  claimed_day TEXT,
  swapped INTEGER NOT NULL DEFAULT 0,
  swap_day TEXT,
  inf INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fun_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  what TEXT NOT NULL,
  n INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fun_log_user ON fun_log(user_id, id);
CREATE TABLE IF NOT EXISTS fun_daily (day TEXT PRIMARY KEY, given INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS fun_issue (
  id INTEGER PRIMARY KEY,
  hour TEXT NOT NULL,
  label TEXT NOT NULL,
  carry INTEGER NOT NULL,
  drawn INTEGER NOT NULL DEFAULT 0,
  res TEXT, sp INTEGER, pot INTEGER, n3 INTEGER, n2 INTEGER, nsp INTEGER, per3 INTEGER, per2 INTEGER, carry_out INTEGER, drawn_at INTEGER
);
CREATE TABLE IF NOT EXISTS fun_ticket (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES fun_issue(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nums TEXT NOT NULL,
  sp INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  hits INTEGER, sp_hit INTEGER, win INTEGER
);
CREATE INDEX IF NOT EXISTS fun_ticket_issue ON fun_ticket(issue_id);
CREATE TABLE IF NOT EXISTS fun_race (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full','ready')),
  state TEXT NOT NULL DEFAULT 'wait' CHECK (state IN ('wait','run','gone')),
  created_at INTEGER NOT NULL,
  start_at INTEGER, end_at INTEGER, winner INTEGER, order_json TEXT, times_json TEXT
);
CREATE TABLE IF NOT EXISTS fun_seat (
  race_id INTEGER NOT NULL REFERENCES fun_race(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dog INTEGER NOT NULL,
  stake INTEGER NOT NULL,
  paid_red INTEGER NOT NULL DEFAULT 0,
  paid_white INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  win INTEGER,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (race_id, user_id)
);
`);
const hasCol = (t: string, c: string) => !!db.prepare(`SELECT name FROM pragma_table_info('${t}') WHERE name = ?`).get(c);
if (!hasCol('fun_issue', 'rules')) db.exec('ALTER TABLE fun_issue ADD COLUMN rules INTEGER NOT NULL DEFAULT 1');
db.exec(`CREATE TABLE IF NOT EXISTS fun_slot_boost (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  uses INTEGER NOT NULL, ready INTEGER NOT NULL
)`);

db.exec('CREATE TABLE IF NOT EXISTS fun_boost_excluded (discord_id TEXT PRIMARY KEY)');
if (!hasCol('fun_slot_discovery','reward')) tx(() => {
  const old = hasCol('fun_slot_discovery','id');
  if (old) db.exec('ALTER TABLE fun_slot_discovery RENAME TO fun_slot_discovery_old');
  db.exec(`CREATE TABLE fun_slot_discovery (
    id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 3), user_id INTEGER NOT NULL UNIQUE,
    awarded_at INTEGER NOT NULL, reward INTEGER NOT NULL
  )`);
  if (old) db.exec(`INSERT INTO fun_slot_discovery(id,user_id,awarded_at,reward)
    SELECT id,user_id,awarded_at,500 FROM fun_slot_discovery_old;
    DROP TABLE fun_slot_discovery_old;`);
});
if (!hasCol('fun_slot_boost', 'taps')) db.exec('ALTER TABLE fun_slot_boost ADD COLUMN taps INTEGER NOT NULL DEFAULT 0');
if (!hasCol('fun_slot_boost', 'last_tap')) db.exec('ALTER TABLE fun_slot_boost ADD COLUMN last_tap INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS fun_slot_total (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  net INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fun_slot_total_net ON fun_slot_total(net,user_id);`);
// G4A：已兑换未用完的次数（今天换了几次沿用 swapped / swap_day）
if (!hasCol('fun_wallet', 'argon')) db.exec('ALTER TABLE fun_wallet ADD COLUMN argon INTEGER NOT NULL DEFAULT 0');
// 彩票 2+1：倍数。旧的 3 位票（还没开奖的）作废，按 2🦴/注 退白骨头
if (!hasCol('fun_ticket', 'mult')) {
  db.exec('ALTER TABLE fun_ticket ADD COLUMN mult INTEGER NOT NULL DEFAULT 1');
  tx(() => {
    for (const t of all('SELECT t.id, t.user_id FROM fun_ticket t JOIN fun_issue i ON i.id = t.issue_id WHERE i.drawn = 0 AND json_array_length(t.nums) <> 2')) {
      run('UPDATE fun_wallet SET bones = bones + ? WHERE user_id = ?', TICKET, t.user_id);
      run('INSERT INTO fun_log(user_id, ts, what, n) VALUES(?,?,?,?)', t.user_id, Date.now(), '彩票改版退款', TICKET);
      run('DELETE FROM fun_ticket WHERE id = ?', t.id);
    }
  });
}
// 赛狗重做：入场费按场。旧规则下还没发车的全退，跑完的直接收起
if (!hasCol('fun_race', 'fee')) {
  db.exec('ALTER TABLE fun_race ADD COLUMN fee INTEGER NOT NULL DEFAULT 0');
  tx(() => {
    for (const r of all("SELECT id FROM fun_race WHERE state = 'wait'")) {
      for (const s of all('SELECT * FROM fun_seat WHERE race_id = ?', r.id)) {
        run('UPDATE fun_wallet SET red = red + ?, bones = bones + ? WHERE user_id = ?', s.paid_red, s.paid_white, s.user_id);
        run('INSERT INTO fun_log(user_id, ts, what, n) VALUES(?,?,?,?)', s.user_id, Date.now(), '赛狗改版退款', s.stake);
      }
      run('DELETE FROM fun_seat WHERE race_id = ?', r.id);
    }
    run("UPDATE fun_race SET state = 'gone' WHERE state <> 'gone'");
  });
}
// 房间从哪开的：web = 网页，dc = Discord（只用来互相提示，不影响规则）
if (!hasCol('fun_race', 'src')) db.exec("ALTER TABLE fun_race ADD COLUMN src TEXT NOT NULL DEFAULT 'web'");

const bad = (code: string, msg: string) => new HttpError(400, code, msg);
const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hourKey = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}`;
const nextHour = () => { const d = new Date(); d.setMinutes(60, 0, 0); return d.getTime(); };
const rnd = (n: number) => randomInt(n);
const rf = () => randomInt(1e9) / 1e9;
function weighted(ws: number[]): number { const t = ws.reduce((a, b) => a + b, 0); let r = rf() * t; for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r < 0) return i; } return 0; }

export type FunUser = { id: number; role: string };
const isAdmin = (u: FunUser) => u.role === 'admin';
/** 只给测试 / 管理用：开关 G4A 兑换。 */
export function setG4A(on: boolean) { G4A_ON = on; }

/* —— 实时推送（SSE）：状态一变就广播一个版本号，客户端收到再来拉 —— */
let ver = 0, pending: Set<number> | null = null;
let fresh: { id: number; src: string; host: string }[] = []; // 这一轮新开的房：推送里带上，网页据此弹提示
const subs = new Set<ServerResponse>();
function bump(race?: number) {
  ver++;
  if (!pending) { pending = new Set(); setImmediate(flush); }
  if (race) pending.add(race);
}
/** 赛狗房间有变化时回调（Discord 那边用来改房间消息）。 */
const raceHooks = new Set<(races: number[]) => void>();
export function onRaceChange(fn: (races: number[]) => void) { raceHooks.add(fn); return () => { raceHooks.delete(fn); }; }
function flush() {
  const races = [...(pending || [])]; pending = null;
  const news = fresh; fresh = [];
  if (races.length) for (const f of raceHooks) { try { f(races); } catch (e) { console.error('[fun] race hook', e); } }
  if (!subs.size) return;
  const msg = `data: ${JSON.stringify({ v: ver, ...(races.length ? { races } : {}), ...(news.length ? { news } : {}) })}\n\n`;
  for (const res of subs) { try { res.write(msg); } catch { subs.delete(res); } }
}
export function stream(req: IncomingMessage, res: ServerResponse) {
  if (subs.size >= SSE_MAX) throw new HttpError(503, 'busy');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 3000\ndata: ${JSON.stringify({ v: ver, hello: 1 })}\n\n`);
  subs.add(res);
  const bye = () => subs.delete(res);
  req.on('close', bye); res.on('close', bye); res.on('error', bye);
}
export const streamCount = () => subs.size;

/* —— 钱包 —— */
type W = { user_id: number; bones: number; red: number; owed: number; owed_t: number; owed_since: number; claimed_day: string | null; swapped: number; swap_day: string | null; inf: number; argon: number };
function accruedDebt(owed: number, since: number, at: number) {
  return owed > 0 && since > 0 ? owed * Math.pow(1 + LOAN_RATE, Math.max(0, at-since) / 3600e3) : owed;
}
function wallet(uid: number): W {
  let w = one('SELECT * FROM fun_wallet WHERE user_id = ?', uid) as W | undefined;
  if (!w) { run('INSERT INTO fun_wallet(user_id) VALUES(?)', uid); w = one('SELECT * FROM fun_wallet WHERE user_id = ?', uid) as W; }
  // 利滚利：读的时候把利息算进去
  const at = Date.now();
  w.owed = accruedDebt(w.owed, w.owed_t, at);
  w.owed_t = at;
  if (w.swap_day !== dayKey()) { w.swapped = 0; w.swap_day = dayKey(); }
  // 每天第一次碰到钱包就送 DAILY 根；逾期的先扣去抵债
  if (w.claimed_day !== dayKey()) {
    w.claimed_day = dayKey();
    let g = DAILY;
    if (overdue(w)) { const take = Math.min(g, Math.ceil(w.owed)); w.owed -= take; g -= take; log(uid, '狗哥扣走', -take); }
    w.bones += g; log(uid, '每日骨头', DAILY); saveW(w);
  }
  return w;
}
function saveW(w: W) {
  if (w.owed < 0.5) { w.owed = 0; w.owed_since = 0; }
  run('UPDATE fun_wallet SET bones=?, red=?, owed=?, owed_t=?, owed_since=?, claimed_day=?, swapped=?, swap_day=?, inf=?, argon=? WHERE user_id=?',
    w.bones, w.red, w.owed, w.owed_t, w.owed_since, w.claimed_day, w.swapped, w.swap_day, w.inf, w.argon, w.user_id);
}
const infOn = (u: FunUser, w: W) => isAdmin(u) && !!w.inf;
const overdue = (w: W) => w.owed > 0 && !!w.owed_since && Date.now() - w.owed_since > LOAN_DUE * 3600e3;
export function log(uid: number, what: string, n: number) {
  run('INSERT INTO fun_log(user_id, ts, what, n) VALUES(?,?,?,?)', uid, Date.now(), what, n);
  run('DELETE FROM fun_log WHERE user_id = ? AND id NOT IN (SELECT id FROM fun_log WHERE user_id = ? ORDER BY id DESC LIMIT 15)', uid, uid);
}
/** 押注扣钱：先红后白。返回各扣了多少（退款按这个比例退）。调用方在事务里。 */
function charge(u: FunUser, n: number): { red: number; white: number } {
  const w = wallet(u.id);
  if (infOn(u, w)) return { red: 0, white: 0 };
  if (w.red + w.bones < n) throw bad('fun_broke', '骨头不够，找狗哥借点？');
  const r = Math.min(w.red, n);
  w.red -= r; w.bones -= n - r; saveW(w);
  return { red: r, white: n - r };
}
function refund(uid: number, red: number, white: number) {
  const w = wallet(uid); w.red += red; w.bones += white; saveW(w);
}
function credit(uid: number, n: number) { if (n <= 0) return; const w = wallet(uid); w.bones += n; saveW(w); }

export function claim(u: FunUser) {
  const r = tx(() => {
    const w = wallet(u.id);
    if (w.claimed_day === dayKey()) { saveW(w); return { took: 0 }; } // wallet() 已自动送过
    w.claimed_day = dayKey();
    let g = DAILY;
    if (overdue(w)) { const take = Math.min(g, Math.ceil(w.owed)); w.owed -= take; g -= take; saveW(w); log(u.id, '狗哥扣走', -take); }
    w.bones += g; saveW(w); log(u.id, '领骨头', DAILY);
    return { took: DAILY - g };
  });
  bump(); return r;
}
/** 白骨头换 G4A 次数。 */
export function g4a(u: FunUser, n: unknown) {
  if (!G4A_ON) throw new HttpError(403, 'g4a_off', '大锅饭 G4A 暂未开放');
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > G4A_CAP) throw bad('fun_bad_amount', '次数不对');
  const k = n as number;
  const r = tx(() => {
    const w = wallet(u.id);
    if (w.owed > 0) throw bad('fun_debt', '先把狗哥的债还了');
    if (w.swapped + k > G4A_CAP) throw bad('fun_g4a_cap', `每天最多换 ${G4A_CAP} 次，今天还能换 ${Math.max(0, G4A_CAP - w.swapped)} 次`);
    const cost = k * G4A_RATE;
    if (!infOn(u, w)) { if (w.bones < cost) throw bad('fun_broke', '白骨头不够'); w.bones -= cost; }
    w.swapped += k; w.argon += k; saveW(w);
    run('INSERT INTO fun_daily(day, given) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET given = given + ?', dayKey(), k, k);
    log(u.id, `换 ${k} 次 G4A`, -cost);
    return { argon: w.argon, left: G4A_CAP - w.swapped };
  });
  bump(); return r;
}
export const VIP_RATE = 20;
export function redeemVip(u: FunUser, n: unknown) {
  const k = Number(n);
  if (!Number.isInteger(k) || k < 1 || k > 50) throw bad('fun_bad_amount', '兑换次数须在 1–50 之间');
  const r = tx(() => {
    const w = wallet(u.id);
    if (w.owed > 0) throw bad('fun_debt', '先把狗哥的债还了');
    const cost = k * VIP_RATE;
    if (!infOn(u, w)) { if (w.bones < cost) throw bad('fun_broke', '白骨头不够'); w.bones -= cost; }
    saveW(w);
    run('UPDATE users SET vip_quota = COALESCE(vip_quota, 0) + ? WHERE id = ?', k, u.id);
    log(u.id, `换 ${k} 次 VIP 节点`, -cost);
    const vq = Number(one('SELECT vip_quota FROM users WHERE id = ?', u.id)?.vip_quota || 0);
    return { vipQuota: vq, bones: w.bones };
  });
  bump(); return r;
}
export function borrow(u: FunUser, n: number) {
  if (!LOAN_STEP.includes(n)) throw bad('fun_bad_amount', '金额不对');
  const r = tx(() => {
    const w = wallet(u.id);
    if (LOAN_MAX && w.owed + n > LOAN_MAX) throw bad('fun_loan_max', `最多欠 ${LOAN_MAX}🦴`);
    if (!w.owed) w.owed_since = Date.now();
    w.owed += n; w.red += n; saveW(w); log(u.id, `向狗哥借 ${n}`, 0);
    return { n, owed: Math.ceil(w.owed) };
  });
  bump(); return r;
}
export function repay(u: FunUser) {
  const r = tx(() => {
    const w = wallet(u.id), o = Math.ceil(w.owed - 0.005); // 刚借完的几毫秒利息不算一根
    if (!o) throw bad('fun_no_debt', '没欠钱');
    // 先把没花掉的红骨头还回去，不够的再扣白骨头
    const r = Math.min(Math.floor(w.red), o);
    const wh = infOn(u, w) ? o - r : Math.min(w.bones, o - r);
    const p = r + wh;
    if (!p) throw bad('fun_broke', '没有骨头还');
    w.red -= r; if (!infOn(u, w)) w.bones -= wh;
    w.owed = Math.max(0, w.owed - p);
    if (w.owed < 0.5) { w.owed = 0; w.red = 0; } // 还清了，零头红骨头一起收回
    saveW(w); log(u.id, '还狗哥', -p);
    return { paid: p, red: r, white: wh, left: Math.ceil(w.owed < 0.5 ? 0 : w.owed) };
  });
  bump(); return r;
}
export function toggleInf(u: FunUser) {
  if (!isAdmin(u)) throw new HttpError(403, 'forbidden');
  const r = tx(() => { const w = wallet(u.id); w.inf = w.inf ? 0 : 1; saveW(w); return { inf: !!w.inf }; });
  bump(); return r;
}

/* —— 水果机 —— */
export function slotPay(a: number, b: number, c: number): number {
  if (a === b && b === c) return SYM[a][2];
  const p = a === b || a === c ? a : b === c ? b : -1;
  return p < 0 ? 0 : SYM[p][3];
}
export function boostSlots(u: FunUser) {
  return tx(() => {
    const now = Date.now();
    const state = one(`INSERT INTO fun_slot_boost(user_id, uses, ready, taps, last_tap) VALUES(?, NOT EXISTS(SELECT 1 FROM fun_boost_excluded e JOIN users u ON u.discord_id=e.discord_id WHERE u.id=?),1,1,?)
      ON CONFLICT(user_id) DO UPDATE SET
        uses=uses+excluded.uses*(ready=0), ready=1, taps=1,
        last_tap=excluded.last_tap RETURNING uses`, u.id, u.id, now)!;
    return { ready: true, golden: false, uses: state.uses, reward: 0, place: 0, counted: false };
  });
}
function luckyPair() {
  const pair = 2 + rnd(2);
  const reels = [pair, pair, pair];
  reels[rnd(3)] = rnd(2);
  return reels;
}
const luckyPairOdds = 14;
function boostedHitChance() {
  const weight = SYM.reduce((s,x)=>s+x[1],0);
  let hits = 0;
  for (const [a,x] of SYM.entries()) for (const [b,y] of SYM.entries()) for (const [c,z] of SYM.entries()) {
    if (slotPay(a,b,c)) hits += x[1]*y[1]*z[1];
  }
  const base = hits / weight**3;
  const first = base + (1-base)/luckyPairOdds;
  return first + (1-first)*base/4;
}
const boostedChance = boostedHitChance();
function spinReels(boosted = false) {
  if (boosted && rnd(luckyPairOdds) === 0) return luckyPair();
  return [0, 0, 0].map(() => weighted(SYM.map((s) => s[1])));
}
export function slots(u: FunUser, bet: number, rig?: number[]) {
  if (!SLOT_BETS.includes(bet)) throw bad('fun_bad_amount', '押注不对');
  const r = tx(() => {
    charge(u, bet);
    const boost = one('SELECT ready,taps FROM fun_slot_boost WHERE user_id=?', u.id);
    const boosted = !!boost?.ready;
    let out = rig || spinReels(!!boosted);
    if (boosted) {
      run('UPDATE fun_slot_boost SET ready=0,taps=0,last_tap=0 WHERE user_id=?', u.id);
      if (!slotPay(out[0], out[1], out[2]) && rnd(4) === 0) out = spinReels();
    }
    const m = slotPay(out[0], out[1], out[2]), win = m * bet;
    credit(u.id, win);
    run(`INSERT INTO fun_slot_total(user_id, net) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET net=net+excluded.net`, u.id, win - bet);
    log(u.id, `水果机 ${out.map((i) => SYM[i][0]).join('')}`, win - bet);
    return { reels: out, mult: m, win, three: out[0] === out[1] && out[1] === out[2] };
  });
  bump(); return r;
}

/* —— 彩票 —— */
// fun_issue 列复用：n3 = 全中注数，n2 = 中 1 位注数，per3 / per2 = 每 1 倍分到多少
type Issue = { id: number; hour: string; label: string; carry: number; drawn: number; res: string | null; sp: number | null; pot: number | null; n3: number | null; n2: number | null; nsp: number | null; per3: number | null; per2: number | null; carry_out: number | null; drawn_at: number | null };
const potOf = (iss: { id: number; carry: number }) => iss.carry + TICKET * Number(one('SELECT COALESCE(SUM(mult),0) m FROM fun_ticket WHERE issue_id = ?', iss.id)?.m || 0);
function openIssue(): Issue {
  let cur = one('SELECT * FROM fun_issue WHERE drawn = 0 ORDER BY id DESC LIMIT 1') as Issue | undefined;
  if (cur && cur.hour < hourKey()) { settle(cur); cur = undefined; }
  if (!cur) {
    const last = one('SELECT carry_out, hour FROM fun_issue WHERE drawn = 1 ORDER BY id DESC LIMIT 1');
    const h = hourKey(), same = Number(one('SELECT COUNT(*) n FROM fun_issue WHERE hour = ?', h)?.n || 0);
    const label = `${h.slice(4, 6)}${h.slice(6, 8)}-${h.slice(8)}${same ? '·' + (same + 1) : ''}`;
    run('INSERT INTO fun_issue(hour, label, carry) VALUES(?,?,?)', h, label, Math.max(SEED, Number(last?.carry_out || 0)));
    cur = one('SELECT * FROM fun_issue WHERE drawn = 0 ORDER BY id DESC LIMIT 1') as Issue;
  }
  return cur;
}
export type Drawn = { id: number; label: string; tickets: number; res: number[]; sp: number; pot: number; nTop: number; nSub: number; perTop: number; perSub: number; carryOut: number };
/** 每期开奖后回调（Discord 那边用来发开奖公告）。 */
const drawHooks = new Set<(d: Drawn) => void>();
export function onLottoDrawn(fn: (d: Drawn) => void) { drawHooks.add(fn); return () => { drawHooks.delete(fn); }; }
/** 开奖结算。rig 只给测试用：[d,d,sp]。 */
export function settle(iss: Issue, rig?: number[]) {
  const res = rig ? rig.slice(0, 2) : [rnd(10), rnd(10)], sp = rig ? rig[2] : rnd(10);
  const T = all('SELECT * FROM fun_ticket WHERE issue_id = ?', iss.id);
  const pot = potOf(iss);
  const H = T.map((t) => {
    const nums = JSON.parse(t.nums) as number[];
    return { t, m: Number(t.mult) || 1, h: nums.length === 2 ? nums.filter((d, i) => d === res[i]).length : 0, s: t.sp === sp ? 1 : 0 };
  });
  const matches = (x: typeof H[number]) => x.h + x.s;
  const top = H.filter(x => matches(x) === 3);
  const second = H.filter(x => matches(x) === 2);
  const weight = top.reduce((sum, x) => sum + x.m, 0);
  const per2 = weight ? Math.floor(pot / weight) : 0;
  const per1 = SECOND_PRIZE;
  let carryOut = pot;
  const byUser = new Map<number, number>();
  for (const x of H) {
    const jackpot = matches(x) === 3 ? Math.floor(pot * x.m / weight) : 0;
    carryOut -= jackpot;
    const win = matches(x) === 3 ? jackpot : matches(x) === 2 ? SECOND_PRIZE * x.m : x.s ? SP_BACK * x.m : 0;
    run('UPDATE fun_ticket SET hits=?, sp_hit=?, win=? WHERE id=?', x.h, x.s, win, x.t.id);
    if (win) byUser.set(x.t.user_id, (byUser.get(x.t.user_id) || 0) + win);
  }
  for (const [uid, n] of byUser) { credit(uid, n); log(uid, `彩票 ${iss.label} 期`, n); }
  run('UPDATE fun_issue SET drawn=1, rules=2, res=?, sp=?, pot=?, n3=?, n2=?, nsp=?, per3=?, per2=?, carry_out=?, drawn_at=? WHERE id=?',
    JSON.stringify(res), sp, pot, top.length, second.length, H.filter((x) => x.s).length, per2, per1, carryOut, Date.now(), iss.id);
  // 只留最近几期
  const keep = all('SELECT id FROM fun_issue WHERE drawn = 1 ORDER BY id DESC LIMIT ?', LOT_KEEP).map((r) => r.id);
  if (keep.length >= LOT_KEEP) run(`DELETE FROM fun_issue WHERE drawn = 1 AND id < ?`, Math.min(...keep));
  bump();
  const d: Drawn = { id: iss.id, label: iss.label, tickets: T.length, res, sp, pot, nTop: top.length, nSub: second.length, perTop: per2, perSub: per1, carryOut };
  if (drawHooks.size) setImmediate(() => { for (const f of drawHooks) { try { f(d); } catch (e) { console.error('[fun] draw hook', e); } } }); // 等事务提交后再通知
  return { res, sp, pot, nTop: top.length, nSub: second.length, perTop: per2, perSub: per1, carryOut };
}
export function lottoTick() { tx(() => openIssue()); }
export function lottoBuy(u: FunUser, nums: unknown, sp: unknown, mult: unknown = 1) {
  const ok = (d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 9;
  if (!Array.isArray(nums) || nums.length !== 2 || !nums.every(ok) || !ok(sp)) throw bad('fun_bad_nums', '号码不对');
  if (!LOT_MULTS.includes(mult as number)) throw bad('fun_bad_amount', '倍数不对');
  const m = mult as number;
  const r = tx(() => {
    const iss = openIssue();
    const n = Number(one('SELECT COUNT(*) n FROM fun_ticket WHERE issue_id = ? AND user_id = ?', iss.id, u.id)?.n || 0);
    if (n >= TICKETS) throw bad('fun_ticket_cap', `每期最多 ${TICKETS} 注`);
    charge(u, TICKET * m);
    run('INSERT INTO fun_ticket(issue_id, user_id, nums, sp, ts, mult) VALUES(?,?,?,?,?,?)', iss.id, u.id, JSON.stringify(nums), sp, Date.now(), m);
    log(u.id, `彩票 ${(nums as number[]).join('')}+${sp}${m > 1 ? ` ×${m}` : ''}`, -TICKET * m);
  });
  bump(); return r;
}
export function lottoDrawNow(rig?: number[]) { return tx(() => settle(openIssue(), rig)); }
function lottoView(uid: number) {
  const iss = openIssue();
  const T = all('SELECT t.*, u.name FROM fun_ticket t JOIN users u ON u.id = t.user_id WHERE t.issue_id = ? ORDER BY t.id DESC', iss.id);
  const hist = all('SELECT * FROM fun_issue WHERE drawn = 1 ORDER BY id DESC LIMIT ?', LOT_KEEP).map((h: any) => {
    const mine = all('SELECT nums, sp, mult, hits, sp_hit, win FROM fun_ticket WHERE issue_id = ? AND user_id = ?', h.id, uid)
      .map((t: any) => ({ nums: JSON.parse(t.nums), sp: t.sp, mult: t.mult || 1, hits: t.hits, spHit: !!t.sp_hit, win: t.win || 0 }));
    const res = JSON.parse(h.res) as number[];
    const top = res.length === 2 ? 2 : 3;
    const winners = all('SELECT u.name FROM fun_ticket t JOIN users u ON u.id = t.user_id WHERE t.issue_id = ? AND t.hits >= ? AND (? = 1 OR t.sp_hit = 1)', h.id, top, h.rules).map((r) => r.name);
    return { rules: h.rules, label: h.label, res, sp: h.sp, pot: h.pot, nTop: h.n3, nSub: h.n2, nsp: h.nsp, perTop: h.per3, perSub: h.per2, mine, myWin: mine.reduce((a: number, t: any) => a + t.win, 0), winners };
  });
  return {
    label: iss.label, endsAt: nextHour(), carry: iss.carry, pot: potOf(iss), count: T.length,
    mineCount: T.filter((t) => t.user_id === uid).length,
    tickets: T.map((t) => ({ name: t.name, nums: JSON.parse(t.nums), sp: t.sp, mult: t.mult || 1, me: t.user_id === uid })),
    hist,
  };
}

/* —— 赛狗 —— */
function raceTick() {
  // 等太久没发车：解散全退
  for (const r of all("SELECT id FROM fun_race WHERE state = 'wait' AND created_at < ?", Date.now() - RACE_WAIT)) { dissolve(r.id, '赛狗解散'); bump(r.id); }
}
function dissolve(id: number, why: string) {
  for (const s of all('SELECT * FROM fun_seat WHERE race_id = ?', id)) { refund(s.user_id, s.paid_red, s.paid_white); log(s.user_id, why, s.stake); }
  run('DELETE FROM fun_seat WHERE race_id = ?', id);
  run("UPDATE fun_race SET state = 'gone' WHERE id = ?", id);
}
function inWaiting(uid: number) {
  return one("SELECT s.race_id FROM fun_seat s JOIN fun_race r ON r.id = s.race_id WHERE s.user_id = ? AND r.state = 'wait'", uid);
}
const freeDogs = (raceId: number) => { const used = new Set(all('SELECT dog FROM fun_seat WHERE race_id = ?', raceId).map((r) => r.dog)); return DOGS.map((_, i) => i).filter((i) => !used.has(i)); };
/** 入座：交入场费，自动分一条空闲的狗。 */
function sit(u: FunUser, raceId: number, fee: number) {
  const f = freeDogs(raceId);
  if (!f.length) throw bad('fun_race_full', '满员了');
  const dog = f[rnd(f.length)];
  const p = charge(u, fee);
  run('INSERT INTO fun_seat(race_id, user_id, dog, stake, paid_red, paid_white, joined_at) VALUES(?,?,?,?,?,?,?)', raceId, u.id, dog, fee, p.red, p.white, Date.now());
  log(u.id, '赛狗入场', -fee);
}
/** 奖金：按名次分奖池，取整，余数给第一名。 */
export function prizeSplit(pot: number, n: number): number[] {
  const pct = PRIZES[n] || [100];
  const a = pct.map((p) => Math.floor((pot * p) / 100));
  a[0] += pot - a.reduce((x, y) => x + y, 0);
  return a;
}
/** 每条狗的分段用时（累计毫秒），最后一个就是完赛时间。所有狗同一分布，机会均等。 */
function runPlan(dogs: number[], rigOrder?: number[]) {
  const segs = dogs.map(() => Array.from({ length: RACE_CP }, () => 0.7 + rf() * 0.6));
  const tot = segs.map((s) => s.reduce((a, b) => a + b, 0));
  const order = rigOrder ? rigOrder.slice() : dogs.map((d, i) => ({ d, t: tot[i] })).sort((a, b) => a.t - b.t).map((x) => x.d);
  const fin: Record<number, number> = {};
  let t = RACE_MS[0] + rnd(RACE_MS[1] - RACE_MS[0] + 1);
  order.forEach((d, k) => { if (k) t += RACE_GAP[0] + rnd(RACE_GAP[1] - RACE_GAP[0] + 1); fin[d] = t; });
  const cum = (s: number[], total: number) => { const sum = s.reduce((a, b) => a + b, 0); let acc = 0; return s.map((x) => Math.round((acc += x) * total / sum)); };
  const plan: Record<number, number[]> = {};
  dogs.forEach((d, i) => { plan[d] = cum(segs[i], fin[d]); });
  // 悬念：冠军跑到一半还领先的话，多半让它前慢后快（总用时不变）
  const mid = Math.floor(RACE_CP / 2) - 1, w = order[0];
  if (dogs.length > 1 && dogs.every((d) => plan[d][mid] >= plan[w][mid]) && rf() < 0.7) {
    const i = dogs.indexOf(w); plan[w] = cum(segs[i].slice().sort((a, b) => b - a), fin[w]);
  }
  return { order, plan };
}
/** 条件满足就发车：生成名次、分段时间并立即派奖。rigOrder（按名次排的用户 id）只给测试用。 */
export function maybeLaunch(id: number, rigOrder?: number[]) {
  const r = one("SELECT * FROM fun_race WHERE id = ? AND state = 'wait'", id);
  if (!r) return false;
  const S = all('SELECT * FROM fun_seat WHERE race_id = ?', id);
  const go = r.mode === 'full' ? S.length >= r.size : S.length >= RACE_SIZES[0] && S.every((s) => s.ready);
  if (!go) return false;
  const { order, plan } = runPlan(S.map((s) => s.dog), rigOrder?.map((uid) => S.find((s) => s.user_id === uid)?.dog ?? -1).filter((d) => d >= 0));
  const start = Date.now() + RACE_LEAD, end = start + Math.max(...Object.values(plan).map((p) => p[p.length - 1]));
  run("UPDATE fun_race SET state='run', start_at=?, end_at=?, winner=?, order_json=?, times_json=? WHERE id=?", start, end, order[0], JSON.stringify(order), JSON.stringify(plan), id);
  const prize = prizeSplit(r.fee * S.length, S.length);
  order.forEach((d, k) => {
    const s = S.find((x) => x.dog === d); if (!s) return;
    const win = prize[k] || 0;
    run('UPDATE fun_seat SET win = ? WHERE race_id = ? AND user_id = ?', win, id, s.user_id);
    credit(s.user_id, win);
    log(s.user_id, `赛狗第 ${k + 1} 名`, win);
  });
  return true;
}
export function raceCreate(u: FunUser, b: any, src: 'web' | 'dc' = 'web') {
  const size = Number(b?.size), mode = b?.mode, fee = b?.fee;
  if (!Number.isInteger(size) || size < RACE_SIZES[0] || size > RACE_SIZES[1]) throw bad('fun_bad_size', '人数不对');
  if (mode !== 'full' && mode !== 'ready') throw bad('fun_bad_mode', '发车方式不对');
  if (!FEES.includes(fee)) throw bad('fun_bad_amount', '入场费不对');
  const out = tx(() => {
    raceTick();
    if (inWaiting(u.id)) throw bad('fun_in_race', '你已经在一场比赛里了');
    const id = Number(run('INSERT INTO fun_race(creator_id, size, mode, created_at, fee, src) VALUES(?,?,?,?,?,?)', u.id, size, mode, Date.now(), fee, src).lastInsertRowid);
    sit(u, id, fee);
    return { id };
  });
  fresh.push({ id: out.id, src, host: String(one('SELECT name FROM users WHERE id = ?', u.id)?.name || '') });
  bump(out.id); return out;
}
export function raceJoin(u: FunUser, id: number, rigOrder?: number[]) {
  const out = tx(() => {
    raceTick();
    const r = one('SELECT * FROM fun_race WHERE id = ?', id);
    if (!r || r.state !== 'wait') throw bad('fun_race_closed', '这场已经发车或解散了');
    if (inWaiting(u.id)) throw bad('fun_in_race', '你已经在一场比赛里了');
    const n = Number(one('SELECT COUNT(*) n FROM fun_seat WHERE race_id = ?', id)?.n || 0);
    if (n >= r.size) throw bad('fun_race_full', '满员了');
    sit(u, id, r.fee);
    maybeLaunch(id, rigOrder);
    return { id };
  });
  bump(id); return out;
}
/** 换狗：只能换没人选的。 */
export function raceDog(u: FunUser, id: number, dog: unknown) {
  if (!Number.isInteger(dog) || (dog as number) < 0 || (dog as number) >= DOGS.length) throw bad('fun_bad_dog', '选一条狗');
  const out = tx(() => {
    const r = one("SELECT * FROM fun_race WHERE id = ? AND state = 'wait'", id);
    const s = r && one('SELECT * FROM fun_seat WHERE race_id = ? AND user_id = ?', id, u.id);
    if (!r || !s) throw bad('fun_race_closed', '已经发车了');
    if (s.dog === dog) return { dog };
    if (!freeDogs(id).includes(dog as number)) throw bad('fun_dog_taken', '这条狗有主了');
    run('UPDATE fun_seat SET dog = ? WHERE race_id = ? AND user_id = ?', dog, id, u.id);
    return { dog };
  });
  bump(id); return out;
}
export function raceLeave(u: FunUser, id: number) {
  tx(() => {
    const r = one("SELECT * FROM fun_race WHERE id = ? AND state = 'wait'", id);
    const s = r && one('SELECT * FROM fun_seat WHERE race_id = ? AND user_id = ?', id, u.id);
    if (!r || !s) throw bad('fun_race_closed', '已经发车了');
    refund(u.id, s.paid_red, s.paid_white); log(u.id, '赛狗退出', s.stake);
    run('DELETE FROM fun_seat WHERE race_id = ? AND user_id = ?', id, u.id);
    const left = one('SELECT user_id FROM fun_seat WHERE race_id = ? ORDER BY joined_at LIMIT 1', id);
    if (!left) run("UPDATE fun_race SET state = 'gone' WHERE id = ?", id);
    else { if (r.creator_id === u.id) run('UPDATE fun_race SET creator_id = ? WHERE id = ?', left.user_id, id); maybeLaunch(id); }
  });
  bump(id);
}
export function raceReady(u: FunUser, id: number, rigOrder?: number[]) {
  tx(() => {
    const r = one("SELECT * FROM fun_race WHERE id = ? AND state = 'wait'", id);
    const s = r && one('SELECT * FROM fun_seat WHERE race_id = ? AND user_id = ?', id, u.id);
    if (!r || !s) throw bad('fun_race_closed', '已经发车了');
    run('UPDATE fun_seat SET ready = ? WHERE race_id = ? AND user_id = ?', s.ready ? 0 : 1, id, u.id);
    maybeLaunch(id, rigOrder);
  });
  bump(id);
}
function raceView(r: any, uid: number) {
  const S = all('SELECT s.*, u.name FROM fun_seat s JOIN users u ON u.id = s.user_id WHERE s.race_id = ? ORDER BY s.dog', r.id);
  const creator = one('SELECT name FROM users WHERE id = ?', r.creator_id)?.name || '';
  const phase = r.state === 'wait' ? 'wait' : r.state === 'gone' ? 'gone' : Date.now() < r.end_at ? 'run' : 'done';
  const order: number[] | null = r.state === 'run' && r.order_json ? JSON.parse(r.order_json) : null;
  return {
    id: r.id, creator, size: r.size, mode: r.mode, fee: r.fee, pot: r.fee * S.length, phase, createdAt: r.created_at, startAt: r.start_at, endAt: r.end_at,
    order, plan: r.state === 'run' && r.times_json ? JSON.parse(r.times_json) : null,
    prizes: prizeSplit(r.fee * Math.max(S.length, RACE_SIZES[0]), Math.max(S.length, RACE_SIZES[0])),
    seats: S.map((s) => ({ name: s.name, dog: s.dog, ready: !!s.ready, me: s.user_id === uid, host: s.user_id === r.creator_id,
      place: order ? order.indexOf(s.dog) + 1 : null, win: order ? s.win : null })),
    mine: S.some((s) => s.user_id === uid),
  };
}
export function raceGet(uid: number, id: number) {
  tx(() => raceTick());
  const r = one('SELECT * FROM fun_race WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'not_found');
  return raceView(r, uid);
}
function lobby(uid: number) {
  return all("SELECT * FROM fun_race WHERE state = 'wait' OR (state = 'run' AND end_at > ?) ORDER BY id DESC LIMIT 30", Date.now() - RACE_KEEP).map((r) => raceView(r, uid));
}

/* —— 大锅饭 G4A：每次扣 1 次已兑换的次数，失败退回 —— */
export function argonCharge(uid: number, admin: boolean): 'paid' | 'free' | 'none' | 'off' {
  return tx(() => {
    const w = wallet(uid);
    if (admin && w.inf) { saveW(w); return 'free'; } // 管理员开着无限：没开放也能测
    if (!G4A_ON) { saveW(w); return 'off'; }
    if (w.argon < 1) { saveW(w); return 'none'; }
    w.argon -= 1; saveW(w); return 'paid';
  });
}
export function argonRefund(uid: number) { tx(() => { const w = wallet(uid); w.argon += 1; saveW(w); }); }
export function peekWallet(uid: number) { const w = tx(() => wallet(uid)); const isAdm = one('SELECT role FROM users WHERE id = ?', uid)?.role === 'admin'; return { bones: Number(w.bones || 0), owed: Number(w.owed || 0), inf: isAdm && !!w.inf }; }

/* —— 总览 —— */
function walletBoards(uid: number) {
  const at = Date.now();
  const players = all(`SELECT u.id,u.name,w.bones,w.red,w.owed,w.owed_t,t.net,b.uses,e.discord_id AS excluded
    FROM fun_wallet w JOIN users u ON u.id=w.user_id
    LEFT JOIN fun_slot_total t ON t.user_id=w.user_id
    LEFT JOIN fun_slot_boost b ON b.user_id=w.user_id
    LEFT JOIN fun_boost_excluded e ON e.discord_id=u.discord_id`).map(r => {
    const debt = accruedDebt(r.owed, r.owed_t, at);
    const balance = r.bones + r.red;
    return { id: r.id, name: r.name, white: r.bones, red: r.red, balance, debt,
      assets: balance - debt, excluded: !!r.excluded, net: r.net, uses: Number(r.uses || 0) };
  });
  const wealth = [...players].sort((a,b) => b.assets-a.assets || a.id-b.id)
    .map((p,i) => ({ name:p.name, white:p.white, red:p.red, balance:p.balance, debt:p.debt,
      assets:p.assets, rank:i+1, me:p.id===uid }));
  const debtors = wealth.filter(p=>p.debt>0).sort((a,b)=>b.debt-a.debt || a.rank-b.rank)
    .map((p,i)=>({...p, rank:i+1}));
  const discovererId = one('SELECT user_id FROM fun_slot_discovery WHERE id=1')?.user_id;
  function slotList(kind: 'wins'|'losses'|'peach') {
    const score = (p: typeof players[number]) => kind==='peach' ? p.uses : (p.net || 0)*(kind==='wins'?1:-1);
    const sorted = players.filter(p=>kind!=='peach' || !p.excluded).sort((a,b) => score(b)-score(a) || Number(b.net!=null)-Number(a.net!=null) || a.id-b.id);
    return sorted.slice(0,5)
      .map(p=>({name:p.name, net:p.net, uses:p.uses, discoverer:p.id===discovererId}));
  }
  return { wealth:{leaders:wealth.slice(0,20), mine:wealth.find(p=>p.me), debtors:debtors.slice(0,20), myDebt:debtors.find(p=>p.me)},
    wins:slotList('wins'), losses:slotList('losses'), peach:slotList('peach') };
}
export function overview(u: FunUser) {
  return tx(() => {
    raceTick();
    const w = wallet(u.id); saveW(w);
    const boost = one('SELECT ready,taps,uses FROM fun_slot_boost WHERE user_id=?', u.id);
    const boards = walletBoards(u.id);
    const myRace = inWaiting(u.id)?.race_id ?? null;
    return {
      now: Date.now(), admin: isAdmin(u), v: ver,
      wallet: { bones: w.bones, red: w.red, owed: w.owed, owedAt: w.owed_t, since: w.owed_since, overdue: overdue(w), inf: infOn(u, w),
        ...(G4A_ON ? { argon: w.argon, g4aToday: w.swapped } : {}), vipQuota: Number(one('SELECT vip_quota FROM users WHERE id = ?', u.id)?.vip_quota || 0), vipRate: VIP_RATE },
      cfg: { DAILY, VIP_RATE, G4A_ON, G4A_RATE, G4A_CAP, G4A_STEPS, LOAN_STEP, LOAN_MAX, LOAN_HEAVY, LOAN_RATE, LOAN_DUE, SYM, SLOT_BETS, TICKET, TICKETS, LOT_MULTS, SECOND_PRIZE, SEED, SP_BACK, DOGS, FEES, RACE_SIZES, PRIZES, RACE_CP },
      slotRanks: {
        mine: Number(one('SELECT net FROM fun_slot_total WHERE user_id=?', u.id)?.net || 0),
        wins: boards.wins, losses: boards.losses,
      },
      wealth: boards.wealth,
      slotBoost: {
        chance: boostedChance,
        ready: !!boost?.ready, golden: false,
        uses: Number(boost?.uses || 0),
        leaders: boards.peach,
      },
      lotto: lottoView(u.id),
      races: lobby(u.id), myRace,
      log: all('SELECT ts, what, n FROM fun_log WHERE user_id = ? ORDER BY id DESC LIMIT 15', u.id),
    };
  });
}

export function startFun() {
  setInterval(() => { try { lottoTick(); tx(() => raceTick()); } catch (e) { console.error('[fun]', e); } }, 15e3).unref();
  setInterval(() => { for (const res of subs) { try { res.write(': ping\n\n'); } catch { subs.delete(res); } } }, SSE_PING).unref();
}
