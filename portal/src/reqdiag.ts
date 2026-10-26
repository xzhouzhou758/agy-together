// Request diagnosis for the Discord bot: the asker's own recent request, read back from CPA's request
// log (request-log must be on), reduced to its structure plus trimmed content, with credentials masked.
import { all } from './db.ts';
import * as cpa from './cpa.ts';
import { maskSecrets } from './util.ts';
import { estimateInput } from './inputsize.ts';

const CONTENT_BUDGET = 9000;

/** "=== NAME ===" sections of a CPA request log. Repeated names (API REQUEST 1, 2 …) keep the last one. */
function sections(log: string): Record<string, string> {
  const out: Record<string, string> = {};
  const p = log.split(/^=== (.+?) ===$/m);
  for (let i = 1; i + 1 < p.length; i += 2) out[p[i].replace(/\s+\d+$/, '')] = p[i + 1].trim();
  return out;
}
const afterLabel = (s: string, label: string) => { const i = s.indexOf(label + ':'); return i < 0 ? s : s.slice(i + label.length + 1).trim(); };
const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => typeof p === 'string' ? p : p?.text ?? (p?.inline_data || p?.inlineData || p?.image_url || p?.source ? '[图片/文件]' : '')).join('') : c && typeof c === 'object' ? textOf((c as any).parts ?? (c as any).text ?? '') : '';
const tok = (s: string) => estimateInput(s);
const trim = (s: string, head: number, tail: number) => (s.length <= head + tail + 20 ? s : `${s.slice(0, head)}\n…（中间省略 ${s.length - head - tail} 字）…\n${s.slice(-tail)}`);

/** Structure + trimmed content of one client request body (OpenAI / Anthropic / Gemini). */
export function digestBody(raw: string): string {
  let j: any;
  try { j = JSON.parse(raw); } catch { return `请求体不是 JSON（${raw.length} 字）`; }
  let system = '', msgs: { role: string; text: string }[] = [];
  if (Array.isArray(j.messages)) {
    for (const m of j.messages) {
      if (m.role === 'system' || m.role === 'developer') system += (system ? '\n' : '') + textOf(m.content);
      else msgs.push({ role: m.role, text: textOf(m.content) });
    }
    if (j.system) system = textOf(j.system) + (system ? '\n' + system : '');
  } else if (Array.isArray(j.contents)) {
    system = textOf(j.systemInstruction ?? j.system_instruction ?? '');
    msgs = j.contents.map((c: any) => ({ role: c.role === 'model' ? 'assistant' : c.role || 'user', text: textOf(c.parts) }));
  } else if (j.input !== undefined) {
    msgs = (Array.isArray(j.input) ? j.input : [{ role: 'user', content: j.input }]).map((m: any) => ({ role: m.role || 'user', text: textOf(m.content) }));
    system = textOf(j.instructions ?? '');
  }
  const params = ['model', 'stream', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'stop', 'reasoning_effort']
    .filter((k) => j[k] !== undefined).map((k) => `${k}=${JSON.stringify(j[k])}`);
  const gc = j.generationConfig || j.generation_config;
  if (gc) params.push('generationConfig=' + JSON.stringify(gc).slice(0, 300));
  const sizes = msgs.map((m, i) => ({ i, role: m.role, t: tok(m.text) }));
  const big = [...sizes].sort((a, b) => b.t - a.t).slice(0, 3).filter((x) => x.t > 2000);
  const lines = [
    `参数：${params.join('，') || '（无）'}`,
    `总输入约 ${estimateInput(j)} Token；系统提示词约 ${tok(system)} Token；${msgs.length} 条消息`,
    `最后一条是 ${msgs.at(-1)?.role || '无'}${msgs.at(-1)?.role === 'assistant' ? '（= 预填充，Gemini 不支持）' : ''}`,
    `最后 8 条的角色：${msgs.slice(-8).map((m) => m.role).join(' → ')}`,
  ];
  if (big.length) lines.push(`最大的消息：${big.map((x) => `第 ${x.i + 1} 条（${x.role}）约 ${x.t} Token`).join('；')}`);
  // trimmed content: system head, then the last messages, newest last
  let budget = CONTENT_BUDGET;
  const parts: string[] = [];
  if (system) { const s = trim(system, 1500, 300); parts.push(`【系统提示词】\n${s}`); budget -= s.length; }
  const tail: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && budget > 300 && tail.length < 6; i--) {
    const s = trim(msgs[i].text, 1000, 300);
    tail.unshift(`【第 ${i + 1} 条 · ${msgs[i].role}】\n${s}`); budget -= s.length;
  }
  return lines.join('\n') + '\n\n' + parts.concat(tail).join('\n\n');
}

/** Upstream answer of the last attempt: status line and error text. */
function digestResponse(sec: Record<string, string>): string {
  const r = sec['API RESPONSE'] || sec['RESPONSE'] || '';
  const status = /Status:\s*(\d+)/i.exec(r)?.[1] || '';
  const body = afterLabel(r, 'Body');
  const err = /"message"\s*:\s*"([^"]{1,400})"/.exec(body)?.[1] || (Number(status) >= 400 ? body.slice(0, 400) : '');
  return `上游返回：${status || '未知'}${err ? `；报错：${err}` : ''}`;
}

/** The asker's n-th most recent request (failed ones first), digested for the model. */
export async function inspectRequest(userId: number, which = 0, failedOnly = true): Promise<string> {
  const rows = all(`SELECT id, ts, pool, model, status, result, reason, request_id, auth_id, in_est FROM usage WHERE user_id = ? AND path NOT IN ('/discord/chat', '/portal/model-test')
    ${failedOnly ? "AND result != 'ok' AND status != 499" : ''} ORDER BY ts DESC LIMIT 5`, userId);
  const r = rows[Math.max(0, Math.min(rows.length - 1, Math.floor(which) || 0))];
  if (!r) return failedOnly ? '他最近没有失败的请求' : '他最近没有请求';
  const when = new Date(r.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const head = `${when} ${r.pool === 'shared' ? '大锅饭' : '小锅饭'} ${r.model} → ${r.result} ${r.status}${r.reason ? `（${r.reason}）` : ''}`;
  if (!r.request_id) {
    const why = String(r.auth_id || '').startsWith('up:') ? '这次走的是兜底上游，CPA 没有它的日志'
      : '这次在门户就被拦下了，没发到上游，所以没有请求日志';
    return `${head}\n${why}${r.in_est ? `；当时输入估算约 ${r.in_est} Token` : ''}`;
  }
  const log = await cpa.requestLog(String(r.request_id)).catch(() => null);
  if (!log) return `${head}\n日志已经被清理了（只保留最近一天左右）`;
  const sec = sections(log);
  const body = sec['REQUEST BODY'] || '';
  return maskSecrets(`${head}\n${digestResponse(sec)}\n\n${digestBody(body)}`);
}
