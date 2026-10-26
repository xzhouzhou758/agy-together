// Discord bot chat: a gateway (websocket) connection so people can @ the bot in the server and ask
// about their errors or who is eating the most. The answer comes from a model run on the admins' own
// accounts through CPA (pinned with the allow header), fed with the asker's recent failures and the
// public leaderboards. Needs the "Message Content" privileged intent turned on for the bot.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { one, all, run, now, getSetting } from './db.ts';
import { tk } from './bot.ts';
import * as site from './site.ts';
import { parseTrace, recentAllowed } from './gateway.ts';
import { leaderboard, allTimeLine } from './bot.ts';
import { dayStart } from './limits.ts';

const DAPI = 'https://discord.com/api/v10';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
export const chatModel = () => getSetting('bot_llm_model') || 'gemini-3-flash';

export const DEFAULT_PROMPT = `你是「AGY Together 小锅饭」Discord 群里的机器人二狗子，回答简短、口语化、中文，最多 8 行，不寒暄。
你只回答两类问题：1) 用户自己的报错是怎么回事、怎么解决；2) 用量统计（站内谁吃得最多、今天多少请求，以及数据里给出的其它机器人用了什么模型、多少 Token）。其它问题一句话婉拒。
只根据下面给的数据回答，不知道就说不知道，不要编造数字。不要泄露任何邮箱、密钥。
常见报错对照：
- 预填充 / Requests ending with a model turn：最后一条是 AI 消息，Gemini 不支持，关掉客户端的「助手预填充」。
- 输入过限：输入超过个人或大锅饭的输入上限，检查聊天记录 / 预设长度，或在「个人中心」调上限。
- 次数用完 daily_limit：今日大锅饭次数用完，0 点重置；共享一个 Pro 号每天多 500 次。
- 额度用完 / 429 / RESOURCE_EXHAUSTED：号的额度或上游限流，等刷新或换号。
- 没有可用的号 / no_account：号都在冷却、停用或不支持这个模型。
- 模型不支持 / no_model：大锅饭没开放这个模型，或号不支持，换模型或用小锅饭。
- 需要验证 Verify your account：号主用这个 Google 账号登录 Antigravity 完成验证。
- 客户端断开 499：用户自己取消或客户端超时，不是服务端问题。
- 上游出错 5xx：上游临时故障，重试即可。`;
export const chatPrompt = () => getSetting('bot_llm_prompt') || DEFAULT_PROMPT;

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
  parts.push(rankings('今天', dayStart()), rankings('过去 24 小时', now() - 86400e3), rankings('全站历史', 0));
  const ob = otherBot();
  if (ob) parts.push(ob);
  return parts.join('\n\n').replace(/<@\d+>/g, (m) => { const r = one('SELECT name FROM users WHERE discord_id = ?', m.slice(2, -1)); return r ? r.name : '某人'; });
}

const TOK = 'COALESCE(u.total_tok, COALESCE(u.in_tok,0) + COALESCE(u.out_tok,0) + COALESCE(u.reasoning_tok,0))';
/** Per-user table (tokens, requests, failures with the main reason) and per-model use, for one period. */
function rankings(label: string, since: number): string {
  const rows = all(`SELECT u.user_id, us.name, COUNT(*) AS n, SUM(u.result != 'ok' AND u.status != 499) AS bad, SUM(${TOK}) AS tok,
      SUM(u.pool = 'shared') AS shared FROM usage u JOIN users us ON us.id = u.user_id WHERE u.ts >= ? AND u.path != '/discord/chat' GROUP BY u.user_id ORDER BY tok DESC LIMIT 25`, since);
  if (!rows.length) return `【${label}】没有请求`;
  const RES: Record<string, string> = { client: '请求错误', quota: '额度用完/限流', no_account: '没有可用的号', no_model: '模型不支持', upstream: '上游出错', blocked: '被拦截', rate_limited: '限速', daily_limit: '次数用完', input_limit: '输入过限' };
  const why = (uid: number) => {
    const w = one(`SELECT reason, result, status, COUNT(*) AS c FROM usage WHERE user_id = ? AND ts >= ? AND result != 'ok' AND status != 499 GROUP BY COALESCE(reason, result || status) ORDER BY c DESC LIMIT 1`, uid, since);
    return w ? { r: w.reason || `${RES[w.result] || w.result}（HTTP ${w.status}，没记录原文）` } : null;
  };
  const lines = rows.map((r: any, i: number) => {
    const bad = Number(r.bad || 0), w = bad ? why(r.user_id) : null;
    return `${i + 1}. ${r.name}：${tk(r.tok)} Token，${r.n} 次请求（大锅饭 ${r.shared}），失败 ${bad} 次${bad ? `（失败率 ${Math.round(bad / Number(r.n) * 100)}%，主要是 ${String(w?.r || '').slice(0, 60)}）` : ''}`;
  });
  const models = all(`SELECT u.model, COUNT(*) AS n, SUM(${TOK}) AS tok FROM usage u WHERE u.ts >= ? AND u.path != '/discord/chat' GROUP BY u.model ORDER BY tok DESC LIMIT 8`, since)
    .map((m: any) => `${m.model || '?'} ${m.n} 次 ${tk(m.tok)}`).join('；');
  return `【${label}】按 Token 排序的用户（客户端断开不算失败）：\n${lines.join('\n')}\n模型：${models}`;
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
    return `【${name}】（社区里另一个机器人，用的是单独的 Tools 号池，不是小锅饭的用户${first ? `，记录从 ${new Date(first * 1000).toLocaleDateString('zh-CN')} 开始` : ''}）\n` +
      [period('今天', sec(dayStart())), period('过去 24 小时', sec(now() - 86400e3)), period('过去 7 天', sec(now() - 7 * 86400e3)), period('全部', 0)].join('\n');
  } catch (e) {
    return '';
  } finally {
    try { db?.close(); } catch {}
  }
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

/** One answer; runs on the admins' accounts only. */
export async function answer(discordId: string, question: string, previous?: string): Promise<string> {
  const allow = all(`SELECT a.auth_id FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.role = 'admin' ORDER BY a.auth_id`).map((r) => r.auth_id);
  if (!allow.length) return '站长还没有可用的号，我暂时说不了话 🐶';
  const messages = [{ role: 'system', content: chatPrompt() + '\n\n===== 数据（用户名都是站内昵称，可以直接说）=====\n' + chatContext(discordId) }];
  if (previous) messages.push({ role: 'assistant', content: previous });
  messages.push({ role: 'user', content: question || '你好' });
  const start = now(), admin = one(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id ?? null;
  const log = (status: number, requestId: string | null, reason: string | null) => run(`INSERT INTO usage(ts, user_id, key_id, pool, auth_id, owner_id, model, requested_model, path, status, result, reason, latency_ms, stream, request_id)
    VALUES(?,?,NULL,'private',NULL,?,?,?,'/discord/chat',?,?,?,?,0,?)`, start, admin, admin, chatModel(), chatModel(), status, status < 300 ? 'ok' : status === 429 ? 'quota' : status < 500 ? 'client' : 'upstream', reason, now() - start, requestId);
  try {
    const r = await cpaPost(JSON.stringify({ model: chatModel(), stream: false, max_tokens: 800, messages }), allow);
    const tr = parseTrace(r.trace);
    if (tr) recentAllowed.set(tr.requestId, { allowed: new Set(allow), ts: now() });
    log(r.status, tr?.requestId || null, r.status < 300 ? 'Discord 机器人回答' : 'Discord 机器人回答失败');
    if (r.status >= 300) return `我这边出错了（HTTP ${r.status}），晚点再问我 🐶`;
    const c = JSON.parse(r.body)?.choices?.[0]?.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.text || '').join('') : '';
    return text.trim().slice(0, 1900) || '……我没想出来 🐶';
  } catch (e) {
    return (e as Error).message === 'timeout' ? '想太久超时了，再问一次吧 🐶' : '连不上模型，晚点再问我 🐶';
  }
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
  const q = String(d.content || '').replace(new RegExp(`<@!?${me}>`, 'g'), '').trim().slice(0, 1000);
  const prev = d.referenced_message?.author?.id === me ? String(d.referenced_message.content || '') : undefined;
  rest('POST', `/channels/${d.channel_id}/typing`).catch(() => {});
  const text = await answer(String(d.author.id), q, prev);
  await rest('POST', `/channels/${d.channel_id}/messages`, {
    content: text, message_reference: { message_id: d.id, fail_if_not_exists: false }, allowed_mentions: { parse: [], replied_user: true },
  }).catch(() => {});
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
