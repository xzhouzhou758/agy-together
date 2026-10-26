// Knowledge base for the Discord bot: documents the admin uploads (.md / .txt) or imports from a URL
// (e.g. SillyTavern docs pages). On each question the few best-matching chunks go into the prompt.
import { one, all, run, now } from './db.ts';
import * as site from './site.ts';

export const KB_MAX_DOC = 200_000;   // characters per document
const CHUNK = 700;                    // characters per retrieval chunk
const BUDGET = 4500;                  // characters of knowledge per answer

export function kbList() {
  return all('SELECT id, title, source, LENGTH(body) AS size, created_at FROM kb_docs ORDER BY id');
}
export function kbAdd(title: string, body: string, source: string | null): number {
  const t = title.trim().slice(0, 120) || '未命名';
  const b = body.replace(/\r\n?/g, '\n').trim().slice(0, KB_MAX_DOC);
  if (!b) throw new Error('empty');
  return Number(run('INSERT INTO kb_docs(title, source, body, created_at) VALUES(?,?,?,?)', t, source, b, now()).lastInsertRowid);
}
export function kbDelete(id: number): boolean {
  return Number(run('DELETE FROM kb_docs WHERE id = ?', id).changes) > 0;
}

/** HTML page -> readable text (scripts / styles / nav dropped, block tags become line breaks). */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (x: string) => x.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, k) => ENT[k]).replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
export function htmlText(html: string): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim());

  let h = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(h);
  if (main) h = main[0];
  h = h.replace(/<(h[1-6])[^>]*>/gi, '\n\n## ').replace(/<li[^>]*>/gi, '\n- ').replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  h = decode(h);
  const text = h.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}
export async function kbFetch(url: string): Promise<{ title: string; text: string }> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad_url');
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'User-Agent': 'agy-pot-kb/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const raw = (await r.text()).slice(0, 3_000_000);
  if (/html/i.test(r.headers.get('content-type') || '') || /^\s*<(!doctype|html)/i.test(raw)) return htmlText(raw);
  return { title: u.pathname.split('/').pop() || u.hostname, text: raw };
}

// ---------- retrieval ----------
function terms(s: string): Set<string> {
  const t = new Set<string>();
  const low = s.toLowerCase();
  for (const w of low.match(/[a-z0-9][a-z0-9_.+-]{1,}/g) || []) t.add(w);
  for (const run_ of low.match(/[㐀-鿿]+/g) || []) for (let i = 0; i < run_.length - 1; i++) t.add(run_.slice(i, i + 2));
  return t;
}
function chunks(title: string, body: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of body.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > CHUNK) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + para;
    while (cur.length > CHUNK * 1.6) { out.push(cur.slice(0, CHUNK)); cur = cur.slice(CHUNK); }
  }
  if (cur) out.push(cur);
  return out.map((c) => `《${title}》${c}`);
}
/** The best-matching pieces of the knowledge base for a question, within a size budget. */
export function kbSearch(question: string): string {
  const q = terms(question);
  if (!q.size) return '';
  const scored: { s: number; c: string }[] = [];
  for (const d of all('SELECT title, body FROM kb_docs')) {
    for (const c of chunks(d.title, d.body)) {
      const ct = terms(c);
      let s = 0;
      for (const w of q) if (ct.has(w)) s += w.length > 2 ? 2 : 1;
      if (s) scored.push({ s: s / Math.sqrt(c.length / 300 + 1), c });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  const pick: string[] = [];
  let len = 0;
  for (const x of scored) {
    if (len + x.c.length > BUDGET) continue;
    pick.push(x.c); len += x.c.length;
    if (pick.length >= 6) break;
  }
  return pick.join('\n---\n');
}

/** Always given: how this site plugs into SillyTavern. */
export function tavernGuide(): string {
  const base = site.publicURL() || '（站点地址）';
  return `【酒馆接入小锅饭】
1. 登录 ${base}/ ，在「API 密钥」创建密钥：小锅饭密钥只用自己的号，大锅饭密钥用大家共享的号。
2. 酒馆顶部「API 连接」（插头图标）：API 选「Chat Completion」，来源选「Custom (OpenAI-compatible)」；地址填 ${base}/v1 ，API Key 填刚才的密钥，点「Connect」，再在模型列表里选模型。
3. 也可以用 Gemini / Claude 原生格式：地址同样是 ${base}/v1 （或 /v1beta）。
4. 大锅饭只能用管理员开放的模型；看不到某个模型 = 没开放或你的号不支持。
5. 常见设置：开着「流式」体验更好；上下文长度别拉满到几十万，聊天记录太长会触发「输入过限」；Gemini 不支持「助手预填充（Prefill）」，在预设 / 补全设置里把它清空；开头放 {{random}} 等随机宏会让缓存失效、更费额度。`;
}
