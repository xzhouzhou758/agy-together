// Discord bot chat: a gateway (websocket) connection so people can @ the bot in the server and ask
// about their errors or who is eating the most. The answer comes from a model run on the admins' own
// accounts through CPA (pinned with the allow header), fed with the asker's recent failures and the
// public leaderboards. Needs the "Message Content" privileged intent turned on for the bot.
import http from 'node:http';
import { config } from './config.ts';
import { one, all, run, now, getSetting } from './db.ts';
import * as site from './site.ts';
import { parseTrace, recentAllowed } from './gateway.ts';
import { leaderboard, allTimeLine } from './bot.ts';
import { dayStart } from './limits.ts';

const DAPI = 'https://discord.com/api/v10';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
export const chatModel = () => getSetting('bot_llm_model') || 'gemini-3-flash';

const SYSTEM = `你是「AGY Together 小锅饭」Discord 群里的机器人二狗子，回答简短、口语化、中文，最多 8 行，不寒暄。
你只回答两类问题：1) 用户自己的报错是怎么回事、怎么解决；2) 站内用量排行之类的统计（谁吃得最多、今天多少请求等）。其它问题一句话婉拒。
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
  return parts.join('\n\n').replace(/<@\d+>/g, (m) => { const r = one('SELECT name FROM users WHERE discord_id = ?', m.slice(2, -1)); return r ? r.name : '某人'; });
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
  const messages = [{ role: 'system', content: SYSTEM + '\n\n===== 数据 =====\n' + chatContext(discordId) }];
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
