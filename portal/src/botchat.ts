// Discord bot chat: a gateway (websocket) connection so people can @ the bot in the server and ask
// about their errors or who is eating the most. The answer comes from a model run on the admins' own
// accounts through CPA (pinned with the allow header), fed with the asker's recent failures and the
// public leaderboards. Needs the "Message Content" privileged intent turned on for the bot.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { one, all, run, now, getSetting, getRules, counted } from './db.ts';
import * as cpa from './cpa.ts';
import { poolResources } from './poolres.ts';
import * as site from './site.ts';
import { parseTrace, recentAllowed } from './gateway.ts';
import { leaderboard, allTimeLine, tk, myAccounts, maskEmail, mentionsOn, unping, proactive } from './bot.ts';
import { dayStart, sharedModels } from './limits.ts';
import { kbSearch, kbHits, kbDoc, kbTitles, kbAdd, tavernGuide } from './kb.ts';
import { upstreamById, upstreamRequest, isUp, upAuthId } from './upstream.ts';
import { inspectRequest } from './reqdiag.ts';
import { restartLog } from './restarts.ts';
import { stockForChat, subscribe } from './stock.ts';

const DAPI = 'https://discord.com/api/v10';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
export const chatModel = () => getSetting('bot_llm_model') || 'gemini-3-flash';
/** 'cpa' = the admins' own accounts through CPA; 'up:<id>' = an external upstream (Tools) with its own key. */
export const chatSource = () => getSetting('bot_llm_source') || 'cpa';

export const DEFAULT_PROMPT = `你是「AGY Together 小锅饭」Discord 群里的机器人二狗子，一只聪明又有点贫嘴的柴犬。
回答控制在 Discord 一条消息能放下的长度（大约 1500 字以内）。提到被 @ 的人时写「@名字」。说话像群友聊天：自然、口语化、带点幽默，可以用「哈」「嘛」「啧」这类语气词和少量 emoji，别像报表、别用「如下」「具体明细」这种腔调。
先把问题答清楚（数字准确，最多 8 行），最后加 1~2 句自己的点评或调侃，比如谁太能吃、哪个模型最受宠、报错是不是自己作的；点评要友善，别人身攻击。
群里的人基本都是 SillyTavern（酒馆）玩家，用小锅饭 / 大锅饭的 API 在酒馆里跑角色卡聊天；回答时用酒馆的说法（API 连接、预设、角色卡、世界书、上下文长度、流式、预填充等），步骤具体到酒馆里点哪里。
你回答三类问题：0) 酒馆怎么接小锅饭、酒馆里的设置和用法（以「酒馆接入」和「知识库」里的内容为准）；1) 用户自己的报错是怎么回事、怎么解决；2) 用量统计（站内谁吃得最多、今天多少请求，以及数据里给出的其它机器人用了什么模型、多少 Token）。和酒馆、本站无关的问题一句话婉拒。
只根据下面给的数据回答，不知道就说不知道，不要编造数字。不要泄露任何邮箱、密钥；提问人自己的号只在他问自己的号时才提。
常见报错对照：
- 预填充 / Requests ending with a model turn：最后一条是 AI 消息，Gemini 不支持，关掉客户端的「助手预填充」。
- 输入过限（门户返回「输入过限：…你设置的上限 / 大锅饭的输入上限」）：超过个人或大锅饭的输入上限，个人上限可以在「个人中心」调。
- The input token count exceeds the maximum number of tokens allowed N：这是模型本身的上下文窗口（如 131072 = 128K），调不了，只能缩短上下文（酒馆里把上下文长度设到 N 以下、总结 / 隐藏旧楼层、精简世界书和预设），或换窗口更大的模型。
- 次数用完 daily_limit：今日大锅饭次数用完，0 点重置；共享一个 Pro 号每天多 500 次。
- 额度用完 / 429 / RESOURCE_EXHAUSTED：号的额度或上游限流，等刷新或换号。
- 没有可用的号 / no_account：号都在冷却、停用或不支持这个模型。
- 模型不支持 / no_model：大锅饭没开放这个模型，或号不支持，换模型或用小锅饭。
- 需要验证 Verify your account：号主用这个 Google 账号登录 Antigravity 完成验证。
- 客户端断开 499：用户自己取消或客户端超时，不是服务端问题。
- 上游出错 5xx：上游临时故障，重试即可。`;
export const chatPrompt = () => getSetting('bot_llm_prompt') || DEFAULT_PROMPT;

/** Always added after the (admin-editable) prompt: the model's own training and older knowledge-base pages
 *  still think 32K–128K is a big context, so people sending 60K got told off for it. */
export const CONTEXT_FACTS = `【上下文长度常识（以这里为准，知识库里旧文章和你自己的印象如果说得更小，都是过时的）】
- 现在站里的主力模型（Gemini 3.x / 4 系列、Claude 4.6 / 5.x）上下文窗口基本都是百万级（约 100 万 Token）；报错里出现 131072 说明这次落到了 128K 窗口的号或通道。
- 输入几万到二三十万 Token 都是正常的酒馆长聊天，不要说别人「太长」「太多」或建议压缩。只有这些情况才提醒：接近或超过模型窗口（报 The input token count exceeds…）、超过个人或大锅饭的输入上限被拦下、或单次输入到了五十万以上。
- 长上下文的真实代价是更慢、更费额度，而不是「模型装不下」；要说就说这个。
【服务器重启】有人问报错时，先对一下数据里的「服务器重启 / 中断记录」：失败的时间落在某次重启 / 中断的时间段里或前后一两分钟内，就直接告诉他多半是服务器当时在重启，重试就好，不是他设置的问题。
【买号】有人问「有号吗」「哪里买号」「有没有货」时，算本站相关问题：先用 check_stock 实时查一次成品号库存，再告诉他哪些有货、价格和链接；全缺货就直接说缺货。提醒一句谨慎购买、炸了不管。`;
const STOCK_NOTIFY_HINT = '\n有人让你补货时 @他 / 不要再 @他，用 stock_notify 订阅或取消，再告诉他结果。';
const QUIET_HINT = '\n你现在不会在群里主动发任何消息（没有补货通知、报错提醒、日报），只在被 @ 时回答。有人让你补货时叫他、到时候提醒他什么，就说现在不主动发消息，想知道有没有货随时 @你问。';

/** What the model gets to see: the asker's recent requests and the public boards. */
export function chatContext(discordId: string): string {
  const u = one('SELECT id, name FROM users WHERE discord_id = ?', discordId);
  const parts: string[] = [];
  if (!u) parts.push('提问的人还没登录过小锅饭，查不到他的请求。');
  else {
    const rows = all(`SELECT ts, pool, model, status, result, reason, COALESCE(in_tok, in_est) AS inp FROM usage WHERE user_id = ? ORDER BY ts DESC LIMIT 15`, u.id);
    const fmt = (r: any) => `${new Date(r.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} ${r.pool === 'shared' ? '大锅饭' : '小锅饭'} ${r.model} → ${r.result} ${r.status}${r.reason ? ' ' + r.reason : ''}${r.inp ? ` 输入≈${r.inp}` : ''}`;
    parts.push(`提问的人：${u.name}。他最近 ${rows.length} 次请求（新的在前）：\n${rows.map(fmt).join('\n') || '（没有）'}`);
  }
  parts.push(leaderboard(dayStart(), now(), '今日榜（0 点到现在）'));
  parts.push(leaderboard(now() - 86400e3, now(), '过去 24 小时'));
  parts.push(allTimeLine());
  parts.push(rankings('今天', dayStart()), rankings('过去 24 小时', now() - 86400e3), rankings('全站历史（含每人分模型）', 0, true));
  parts.push(liveModels(), restartLog());
  const ob = otherBot();
  if (ob) parts.push(ob);
  return parts.join('\n\n').replace(/<@\d+>/g, (m) => { const r = one('SELECT name FROM users WHERE discord_id = ?', m.slice(2, -1)); return r ? r.name : '某人'; });
}

const TOK = 'COALESCE(u.total_tok, COALESCE(u.in_tok,0) + COALESCE(u.out_tok,0) + COALESCE(u.reasoning_tok,0))';
/** Per-user table (tokens, requests, failures with the main reason) and per-model use, for one period;
 *  byModel adds each user's own split by model. */
function rankings(label: string, since: number, byModel = false): string {
  const rows = all(`SELECT u.user_id, us.name, COUNT(*) AS n, SUM(u.result != 'ok' AND u.status != 499) AS bad, SUM(${TOK}) AS tok,
      SUM(u.pool = 'shared') AS shared FROM usage u JOIN users us ON us.id = u.user_id WHERE u.ts >= ? AND u.path != '/discord/chat' AND ${counted('u.')} GROUP BY u.user_id ORDER BY tok DESC LIMIT 25`, since);
  if (!rows.length) return `【${label}】没有请求`;
  const RES: Record<string, string> = { client: '请求错误', quota: '额度用完/限流', no_account: '没有可用的号', no_model: '模型不支持', upstream: '上游出错', blocked: '被拦截', rate_limited: '限速', daily_limit: '次数用完', input_limit: '输入过限' };
  const why = (uid: number) => {
    const w = one(`SELECT reason, result, status, COUNT(*) AS c FROM usage WHERE user_id = ? AND ts >= ? AND result != 'ok' AND status != 499 GROUP BY COALESCE(reason, result || status) ORDER BY c DESC LIMIT 1`, uid, since);
    return w ? { r: w.reason || `${RES[w.result] || w.result}（HTTP ${w.status}，没记录原文）` } : null;
  };
  const per = new Map<number, string[]>();
  if (byModel) for (const m of all(`SELECT u.user_id, u.model, COUNT(*) AS n, SUM(${TOK}) AS tok FROM usage u WHERE u.ts >= ? AND u.path != '/discord/chat' AND ${counted('u.')}
      GROUP BY u.user_id, u.model ORDER BY u.user_id, tok DESC`, since)) {
    const l = per.get(m.user_id) || [];
    if (l.length < 8) l.push(`${m.model || '?'} ${m.n} 次 ${tk(m.tok)}`);
    per.set(m.user_id, l);
  }
  const lines = rows.map((r: any, i: number) => {
    const bad = Number(r.bad || 0), w = bad ? why(r.user_id) : null;
    return `${i + 1}. ${r.name}：${tk(r.tok)} Token，${r.n} 次请求（大锅饭 ${r.shared}），失败 ${bad} 次${bad ? `（失败率 ${Math.round(bad / Number(r.n) * 100)}%，主要是 ${String(w?.r || '').slice(0, 60)}）` : ''}` +
      (per.get(r.user_id) ? `\n   分模型：${per.get(r.user_id)!.join('；')}` : '');
  });
  const models = all(`SELECT u.model, COUNT(*) AS n, SUM(${TOK}) AS tok FROM usage u WHERE u.ts >= ? AND u.path != '/discord/chat' AND ${counted('u.')} GROUP BY u.model ORDER BY tok DESC LIMIT 8`, since)
    .map((m: any) => `${m.model || '?'} ${m.n} 次 ${tk(m.tok)}`).join('；');
  return `【${label}】按 Token 排序的用户（客户端断开不算失败）：\n${lines.join('\n')}\n模型：${models}`;
}

/** The models people actually used in the last two weeks: the largest input that went through and any
 *  context-window refusals, so the bot judges "too long" from this site's data instead of old articles. */
export function liveModels(): string {
  const since = now() - 14 * 86400e3;
  const rows = all(`SELECT model, COUNT(*) AS n, MAX(CASE WHEN result = 'ok' THEN COALESCE(in_tok, in_est) END) AS big FROM usage
    WHERE ts >= ? AND path != '/discord/chat' AND ${counted()} AND model IS NOT NULL AND model != '' GROUP BY model HAVING n >= 5 ORDER BY n DESC LIMIT 20`, since);
  if (!rows.length) return '【本站最近两周在用的模型】没有数据';
  const over = new Map<string, string[]>();
  for (const r of all(`SELECT model, reason, COUNT(*) AS c FROM usage WHERE ts >= ? AND reason LIKE '%maximum number of tokens allowed%' GROUP BY model, reason`, since)) {
    const m = /allowed (\d+)/.exec(String(r.reason));
    if (m) (over.get(r.model) || over.set(r.model, []).get(r.model)!).push(`${m[1]}（${r.c} 次）`);
  }
  return '【本站最近两周在用的模型】（实时数据；「最大输入」= 实际成功跑过的最长一次，说明窗口至少有这么大）\n' +
    rows.map((r: any) => `- ${r.model}：${r.n} 次，最大输入 ${r.big ? tk(Number(r.big)) : '?'}${over.get(r.model) ? `；报过超出窗口 ${over.get(r.model)!.join('、')}` : ''}`).join('\n');
}

// Another community bot running on its own Antigravity Tools instance (OTHER_BOT_DB = its token_stats.db,
// mounted read-only). Opened immutable: the file is on a read-only mount, so rows still in Tools' WAL show up
// only after its next checkpoint.
function otherBot(): string {
  const name = process.env.OTHER_BOT_NAME || '', path = process.env.OTHER_BOT_DB || '';
  if (!name || !path || !existsSync(path)) return '';
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync('file:' + path + '?immutable=1', { readOnly: true });
    const sec = (ms: number) => Math.floor(ms / 1000);
    const period = (label: string, since: number) => {
      const rows = db!.prepare(`SELECT model, COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(total_tokens) AS t FROM token_usage WHERE timestamp >= ? GROUP BY model ORDER BY t DESC LIMIT 12`).all(since) as any[];
      if (!rows.length) return `${label}：没有请求`;
      const n = rows.reduce((a, r) => a + Number(r.n), 0), t = rows.reduce((a, r) => a + Number(r.t || 0), 0);
      return `${label}：${n} 次请求，${tk(t)} Token；按模型：${rows.map((r) => `${r.model} ${r.n} 次 ${tk(Number(r.t || 0))}（入 ${tk(Number(r.i || 0))} 出 ${tk(Number(r.o || 0))}）`).join('；')}`;
    };
    const first = (db.prepare('SELECT MIN(timestamp) AS f FROM token_usage').get() as any)?.f;
    const alias = process.env.OTHER_BOT_ALIASES ? `，Discord 上也叫 ${process.env.OTHER_BOT_ALIASES}` : '';
    return `【${name}】（社区里另一个机器人${alias}，用的是单独的 Tools 号池，不是小锅饭的用户${first ? `，记录从 ${new Date(first * 1000).toLocaleDateString('zh-CN')} 开始` : ''}）\n` +
      [period('今天', sec(dayStart())), period('过去 24 小时', sec(now() - 86400e3)), period('过去 7 天', sec(now() - 7 * 86400e3)), period('全部', 0)].join('\n');
  } catch (e) {
    return '';
  } finally {
    try { db?.close(); } catch {}
  }
}

/** Pool health, the asker's own accounts and daily count, the 大锅饭 rules / models, recent announcements. */
export async function siteContext(discordId: string): Promise<string> {
  const out: string[] = [];
  const pct = (x: number) => Math.round(x * 100) + '%';
  try {
    const R: any = await poolResources(false);
    const c = R.counts, fam = (k: string, lab: string) => {
      const F = R.fam[k];
      if (!F || (!F.accounts && !F.off)) return '';
      const w = (x: any, l: string) => (x?.n ? `${l} 平均剩 ${pct(x.sum / x.n)}、${x.ok}/${x.n} 个号有余量${x.next ? `、最早 ${new Date(x.next).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 刷新` : ''}` : '');
      return `- ${lab}${F.open ? '' : '（大锅饭未开放）'}：约 ${F.full} 个满额号；${[w(F.h5, '5 小时窗口'), w(F.weekly, '周窗口')].filter(Boolean).join('；')}${k === 'argon' && F.off ? `；${F.off} 个号没开通 Argon` : ''}`;
    };
    out.push(`【大锅饭号池现状】${c.total} 个号：正常 ${c.ok}、冷却 ${c.cooldown}、出问题 ${c.problem}、停用 ${c.off}（Ultra ${c.ultra}、Pro ${c.pro}、Free ${c.free}）。已扣除号主的自用保留。\n` +
      [fam('gemini', 'Gemini'), fam('claude', 'Claude'), fam('argon', 'Gemini 4 Argon')].filter(Boolean).join('\n') +
      `\n大锅饭号池今天 ${R.shared.today.n} 次请求 ${tk(R.shared.today.t)} Token；站长兜底公益池${R.upstreams ? '在线' : '未启用'}，今天接了 ${R.backup.today.n} 次 ${tk(R.backup.today.t)} Token，占大锅饭今日请求的 ${R.backup.share}%。`);
  } catch {}
  const r = getRules(), open = sharedModels();
  out.push(`【大锅饭规则】每人每天次数 = ${r.dailyBase} + ${r.dailyPer} × 自己共享进大锅饭的 Pro/Ultra 号数（出问题的号不算），0 点重置；` +
    `大锅饭输入上限 ${r.sharedInput ? Math.round(r.sharedInput / 1e4) + ' 万 Token' : '不限'}；单号并发 ${r.accConc}；号主默认自用保留 ${r.reserve}%。` +
    `大锅饭开放的模型：${open ? [...open].join('、') || '无' : '全部'}。小锅饭（自己的号）不受这些限制。个人还能在「个人中心」设输入上限。`);
  try {
    const mine = myAccounts(discordId, await cpa.creds(30000)).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (e) => maskEmail(e));
    out.push(`【提问人自己的号和今日次数】（只给他本人看的，回答时邮箱只能用打码后的样子）\n${mine}`);
  } catch {}
  const anns = all('SELECT title, body, created_at FROM announcements ORDER BY pinned DESC, id DESC LIMIT 5');
  if (anns.length) out.push('【最近公告 / 更新】\n' + anns.map((a: any) => `· ${new Date(a.created_at).toLocaleDateString('zh-CN')} ${a.title}：${String(a.body).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n'));
  return out.join('\n\n');
}

function knowledge(question: string, previous?: string): string {
  const k = kbSearch((previous ? previous.slice(0, 300) + '\n' : '') + question);
  return k ? '\n\n【知识库（和问题最相关的几段，答酒馆问题时优先依据这里）】\n' + k : '';
}

function cpaPost(body: string, allow: string[]): Promise<{ status: number; trace: string | undefined; body: string }> {
  const t = new URL(config.cpaURL);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: t.hostname, port: t.port || 80, method: 'POST', path: '/v1/chat/completions', timeout: 90000,
      headers: { authorization: 'Bearer ' + config.cpaAPIKey, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), [config.allowHeader]: allow.join(',') } }, (res) => {
      const ch: Buffer[] = [];
      res.on('data', (c: Buffer) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 502, trace: res.headers['x-cpa-trace-id'] as string | undefined, body: Buffer.concat(ch).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(body);
  });
}

function upPost(id: number, body: string): Promise<{ status: number; trace: string | undefined; body: string }> {
  const u = upstreamById(id);
  if (!u || !u.key) return Promise.reject(new Error('upstream'));
  return new Promise((resolve, reject) => {
    const r = upstreamRequest(u, 'POST', '/v1/chat/completions', { 'content-type': 'application/json' }, Buffer.byteLength(body));
    r.on('response', (res) => {
      const ch: Buffer[] = [];
      res.on('data', (c: Buffer) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 502, trace: undefined, body: Buffer.concat(ch).toString('utf8') }));
      res.on('error', reject);
    });
    r.setTimeout(90000, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(body);
  });
}

/** One answer; runs on the admins' accounts only. */
// tools the model may call to look things up itself before answering
const TOOLS = [
  { type: 'function', function: { name: 'search_kb', description: '在酒馆知识库里按关键词搜索，返回最相关的几段（带文档编号）。用词不对就换个说法再搜。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词或一句话，中英文都行' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'check_stock', description: '实时查 yh-mo.xyz 发卡站上成品号（Gemini / 反重力 Pro 成品号）的库存、价格和购买链接。有人问「有号吗」「哪里买号」「有没有货」时用。',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'stock_notify', description: '提问人说「补货的时候@我」「有货叫我」时订阅（on=true）；说「别@我了」「取消补货提醒」时取消（on=false）。只对提问人自己生效。',
    parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } } },
  { type: 'function', function: { name: 'open_doc', description: '打开知识库里某一篇文档的全文（每次最多 6000 字，用 offset 往后翻）。',
    parameters: { type: 'object', properties: { id: { type: 'integer' }, offset: { type: 'integer' } }, required: ['id'] } } },
];
const INSPECT = { type: 'function', function: { name: 'inspect_my_request',
  description: '读取提问人自己最近一次请求的完整内容（参数、每条消息的长度、系统提示词和最后几条消息、上游报错）来找原因。只能看提问人自己的。',
  parameters: { type: 'object', properties: { which: { type: 'integer', description: '0 = 最近一次，1 = 再往前一次…（最多 4）' }, failed_only: { type: 'boolean', description: '默认只看失败的请求' } } } } };
// admins only: "@二狗子 记住 …" writes a note into the knowledge base
const REMEMBER = { type: 'function', function: { name: 'remember',
  description: '把站长让你记住的内容写进知识库（以后回答时能搜到）。只在站长明确让你记住 / 写进记忆库时调用。',
  parameters: { type: 'object', properties: { title: { type: 'string', description: '简短标题，方便以后搜到' }, content: { type: 'string', description: '要记的内容，保留原文要点、数字、链接，不要编造' } }, required: ['title', 'content'] } } };
const MAX_STEPS = 4;
export async function runTool(name: string, args: any, userId: number | null, admin = false, discordId = ''): Promise<string> {
  if (name === 'stock_notify') return subscribe(discordId, args?.on !== false);
  if (name === 'remember') {
    if (!admin) return '只有站长能让我记东西';
    try { return `已写进知识库，文档 #${kbAdd('记忆 · ' + String(args?.title || '').trim(), String(args?.content || ''), 'discord')}`; } catch { return '内容是空的，没记'; }
  }
  if (name === 'inspect_my_request') return userId ? inspectRequest(userId, Number(args?.which || 0), args?.failed_only !== false).catch(() => '读日志失败') : '提问人没登录过小锅饭';
  if (name === 'search_kb') {
    const h = kbHits(String(args?.query || ''), 5, 3500);
    return h.length ? h.map((x) => `[文档 #${x.id}] ${x.c}`).join('\n---\n') : '没搜到，换个关键词试试';
  }
  if (name === 'check_stock') return stockForChat();
  if (name === 'open_doc') return kbDoc(Number(args?.id), Number(args?.offset || 0));
  return '没有这个工具';
}

/** One answer; runs on the admins' accounts only. The model may search the knowledge base a few times first. */
const MAX_IMAGES = 3, MAX_IMAGE_BYTES = 4 << 20;
/** Image attachments (the message's own and the one it replies to) → data URLs the model can look at. */
export async function fetchImages(atts: any[]): Promise<string[]> {
  const out: string[] = [];
  for (const a of atts.filter((x) => /^image\/(png|jpe?g|webp|gif)/.test(String(x?.content_type || '')) && Number(x.size || 0) <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES)) {
    try {
      const r = await fetch(String(a.url), { signal: AbortSignal.timeout(15000) });
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length <= MAX_IMAGE_BYTES) out.push(`data:${String(a.content_type).split(';')[0]};base64,${b.toString('base64')}`);
    } catch {}
  }
  return out;
}

export async function answer(discordId: string, question: string, previous?: string, quoted?: string, images: string[] = []): Promise<string> {
  const src = chatSource(), upId = isUp(src) ? Number(src.slice(3)) : null;
  const allow = upId == null ? all(`SELECT a.auth_id FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.role = 'admin' ORDER BY a.auth_id`).map((r) => r.auth_id) : [];
  if (upId == null && !allow.length) return '站长还没有可用的号，我暂时说不了话 🐶';
  const send = (b: string) => (upId == null ? cpaPost(b, allow) : upPost(upId, b));
  const titles = kbTitles(), me = one('SELECT id, role FROM users WHERE discord_id = ?', discordId), asker: number | null = me?.id ?? null, isAdmin = me?.role === 'admin';
  const messages: any[] = [{ role: 'system', content: chatPrompt() + '\n\n' + CONTEXT_FACTS + (proactive() ? STOCK_NOTIFY_HINT : QUIET_HINT) +
    (asker ? '\n\n提问人问自己为什么报错 / 回复不对时，用 inspect_my_request 读他自己最近的请求，看参数、消息结构、预填充、哪条特别长、上游报错原文，定位到具体原因再说怎么改。回答在公开频道：可以点出是哪一部分（比如系统提示词里的某段、第几条消息），但不要大段复述他的聊天内容，引用原文最多一两句，也不要评论他写的内容本身（题材、剧情、人物）。' : '') +
    (isAdmin ? '\n\n提问人是站长。他让你「记住」「记下来」「写进记忆库 / 知识库」时，用 remember 把要记的内容（他这条消息里的，或他回复的那条消息里的）整理成一条写进去，写完简短告诉他记了什么、标题是什么。' :
      '\n\n有人让你记住什么、写进记忆库时，告诉他只有站长能让你记。') +
    (titles ? '\n\n酒馆相关的问题，先看下面已经附上的知识库片段；不够或对不上就自己用 search_kb 换关键词搜、用 open_doc 读全文，查清楚再答，别凭印象瞎说。数据类问题（排行、报错、额度）直接看数据，不用查知识库。\n知识库目录：\n' + titles : '') +
    '\n\n===== 数据（用户名都是站内昵称，可以直接说）=====\n' + chatContext(discordId) + '\n\n' + await siteContext(discordId) + '\n\n' + tavernGuide() + knowledge(question, previous) }];
  if (previous) messages.push({ role: 'assistant', content: previous });
  const said = (quoted ? `（他回复了这条消息）\n${quoted}\n\n` : '') + (question || (images.length ? '看看这张图' : '你好'));
  // screenshots: an error message, a SillyTavern settings page… the model reads them like text
  messages.push({ role: 'user', content: images.length ? [{ type: 'text', text: said + `\n\n（附了 ${images.length} 张图，按图里的内容回答；报错截图就照报错对照和数据来分析）` }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : said });
  const admin = one(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id ?? null;
  const upOwner = upId == null ? admin : upstreamById(upId)?.ownerId ?? admin;
  const log = (start: number, status: number, requestId: string | null, reason: string | null) => run(`INSERT INTO usage(ts, user_id, key_id, pool, auth_id, owner_id, model, requested_model, path, status, result, reason, latency_ms, stream, request_id)
    VALUES(?,?,NULL,'private',?,?,?,?,'/discord/chat',?,?,?,?,0,?)`, start, admin, upId == null ? null : upAuthId(upId), upOwner, chatModel(), chatModel(), status, status < 300 ? 'ok' : status === 429 ? 'quota' : status < 500 ? 'client' : 'upstream', reason, now() - start, requestId);
  try {
    for (let step = 0; step <= MAX_STEPS; step++) {
      const start = now(), last = step === MAX_STEPS;
      const r = await send(JSON.stringify({ model: chatModel(), stream: false, max_tokens: 8192, messages, ...(last ? {} : { tools: [...TOOLS.filter((t) => proactive() || t.function.name !== 'stock_notify'), ...(asker ? [INSPECT] : []), ...(isAdmin ? [REMEMBER] : [])], tool_choice: 'auto' }) }));
      const tr = parseTrace(r.trace);
      if (tr) recentAllowed.set(tr.requestId, { allowed: new Set(allow), ts: now() });
      if (r.status >= 300) { log(start, r.status, tr?.requestId || null, 'Discord 机器人回答失败'); return `我这边出错了（HTTP ${r.status}），晚点再问我 🐶`; }
      const m = JSON.parse(r.body)?.choices?.[0]?.message || {};
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      log(start, r.status, tr?.requestId || null, calls.length ? 'Discord 机器人查知识库：' + calls.map((c: any) => c.function?.name).join('、') : 'Discord 机器人回答');
      if (calls.length && !last) {
        messages.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
        for (const c of calls) {
          let args: any = {};
          try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
          messages.push({ role: 'tool', tool_call_id: c.id, content: await runTool(String(c.function?.name || ''), args, asker, isAdmin, discordId) });
        }
        continue;
      }
      const ct = m.content;
      const text = typeof ct === 'string' ? ct : Array.isArray(ct) ? ct.map((p: any) => p?.text || '').join('') : '';
      const cut = JSON.parse(r.body)?.choices?.[0]?.finish_reason === 'length';
      return (text.trim() + (cut ? '\n……（说太多被截了，想听后面的再 @ 我）' : '')).slice(0, 5800) || '……我没想出来 🐶';
    }
    return '……我没想出来 🐶';
  } catch (e) {
    const m = (e as Error).message;
    return m === 'timeout' ? '想太久超时了，再问一次吧 🐶' : m === 'upstream' ? '机器人用的外部上游不见了，站长去后台重新选一下 🐶' : '连不上模型，晚点再问我 🐶';
  }
}

export function splitMessage(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n', max);
    if (at < max * 0.5) at = rest.lastIndexOf('。', max) + 1 || max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.slice(0, 3);
}

// ---------- gateway ----------
async function rest(method: string, path: string, body?: unknown) {
  const tok = site.discord().botToken;
  return fetch(DAPI + path, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bot ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

let ws: WebSocket | null = null, hb: ReturnType<typeof setInterval> | null = null, seq: number | null = null;
let session: { id: string; url: string } | null = null, me = '', stopped = false, retry = 1;
export const chatStatus = { connected: false, error: '' as string };

async function onMessage(d: any) {
  if (!me || d.author?.bot || !Array.isArray(d.mentions) || !d.mentions.some((m: any) => m.id === me)) return;
  const guild = site.discord().guildId;
  if (guild && d.guild_id !== guild) return;
  // other people / bots @-ed in the question: their display name instead of the bare <@id>
  const names = new Map<string, string>(), back = new Map<string, string>();
  for (const m of d.mentions || []) {
    if (m.id === me) continue;
    names.set(String(m.id), `${m.member?.nick || m.global_name || m.username || '某人'}${m.bot ? '（机器人）' : ''}`);
    for (const n of [m.member?.nick, m.global_name, m.username]) if (n) back.set(String(n), String(m.id));
  }
  const q = String(d.content || '').replace(new RegExp(`<@!?${me}>`, 'g'), '')
    .replace(/<@!?(\d+)>/g, (_x, id) => '@' + (names.get(id) || one('SELECT name FROM users WHERE discord_id = ?', id)?.name || '某人'))
    .trim().slice(0, 4000);
  const ref = d.referenced_message, prev = ref?.author?.id === me ? String(ref.content || '') : undefined;
  // replying to someone else's message: its text (and attachment names) go along, e.g. "@二狗子 记住这个"
  const quoted = ref && ref.author?.id !== me ? `${ref.member?.nick || ref.author?.global_name || ref.author?.username || '某人'}：${String(ref.content || '').slice(0, 4000)}${(ref.attachments || []).map((a: any) => `\n[附件 ${a.filename} ${a.url}]`).join('')}` : undefined;
  rest('POST', `/channels/${d.channel_id}/typing`).catch(() => {});
  // "@Name" in the answer for someone the asker @-ed becomes a real Discord mention again
  const images = await fetchImages([...(d.attachments || []), ...(ref?.attachments || [])]);
  let text = await answer(String(d.author.id), q, prev, quoted, images);
  for (const [n, id] of [...back.entries()].sort((a, b) => b[0].length - a[0].length)) text = text.split('@' + n).join(`<@${id}>`).replace(/<@(\d+)>（机器人）/g, '<@$1>');
  let pinged = [...new Set(back.values())];
  const ping = mentionsOn();
  if (!ping) { text = unping(text); pinged = []; }
  // Discord caps a message at 2000 characters: longer answers go out as a few replies, split at line breaks
  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    await rest('POST', `/channels/${d.channel_id}/messages`, {
      content: parts[i], ...(i === 0 ? { message_reference: { message_id: d.id, fail_if_not_exists: false } } : {}), allowed_mentions: { parse: [], users: pinged, replied_user: ping && i === 0 },
    }).catch(() => {});
  }
}

function send(op: number, d: unknown) { if (ws?.readyState === 1) ws.send(JSON.stringify({ op, d })); }
function close() { if (hb) clearInterval(hb); hb = null; try { ws?.close(); } catch {} ws = null; chatStatus.connected = false; }

async function connect(): Promise<void> {
  if (stopped || ws) return;
  const tok = site.discord().botToken;
  if (!tok) { setTimeout(connect, 60e3).unref(); return; }
  let url = session?.url;
  if (!url) {
    try { const r = await rest('GET', '/gateway/bot'); url = (await r.json())?.url; } catch {}
    if (!url) { setTimeout(connect, Math.min(300, (retry *= 2)) * 1000).unref(); return; }
  }
  const sock = new WebSocket(url + '/?v=10&encoding=json');
  ws = sock;
  sock.onmessage = (ev) => {
    let p: any; try { p = JSON.parse(String(ev.data)); } catch { return; }
    if (p.s != null) seq = p.s;
    if (p.op === 10) {
      hb = setInterval(() => send(1, seq), p.d.heartbeat_interval);
      if (session) send(6, { token: tok, session_id: session.id, seq });
      else send(2, { token: tok, intents: INTENTS, properties: { os: 'linux', browser: 'agy-pot', device: 'agy-pot' } });
    } else if (p.op === 1) send(1, seq);
    else if (p.op === 7) close();                       // reconnect (resume)
    else if (p.op === 9) { session = null; close(); }   // invalid session: identify again
    else if (p.op === 0) {
      if (p.t === 'READY') { me = p.d.user.id; session = { id: p.d.session_id, url: p.d.resume_gateway_url }; chatStatus.connected = true; chatStatus.error = ''; retry = 1; console.log('[botchat] connected as', p.d.user.username); }
      else if (p.t === 'RESUMED') { chatStatus.connected = true; retry = 1; }
      else if (p.t === 'MESSAGE_CREATE') onMessage(p.d).catch((e) => console.error('[botchat]', (e as Error).message));
    }
  };
  sock.onclose = (ev) => {
    if (ws === sock) close();
    if (ev.code === 4014) { chatStatus.error = '没开 Message Content Intent：去 Discord 开发者后台 Bot 页面打开它'; console.error('[botchat]', chatStatus.error); setTimeout(connect, 10 * 60e3).unref(); return; }
    if (ev.code === 4004) { chatStatus.error = 'Bot Token 无效'; session = null; setTimeout(connect, 10 * 60e3).unref(); return; }
    if ([4007, 4009].includes(ev.code)) session = null;
    setTimeout(connect, Math.min(60, (retry *= 2)) * 1000).unref();
  };
  sock.onerror = () => {};
}

export function startBotChat(): void { setTimeout(connect, 5000).unref(); }
export function stopBotChat(): void { stopped = true; close(); }
