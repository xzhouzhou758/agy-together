// Account rotation for agy-scheduler: per-user stickiness mode and the session key (X-Agy-Session).
import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { modelGroup } from './util.ts';

// ---------- rotation mode (per user) ----------
export type Mode = 'cache' | 'balance' | 'performance';
export const MODES: Mode[] = ['cache', 'balance', 'performance'];
export const DEFAULT_MODE: Mode = 'balance';
export function userMode(v: unknown): Mode {
  return MODES.includes(v as Mode) ? (v as Mode) : DEFAULT_MODE;
}
/** A fresh per-user salt. Bumping it (「清除会话绑定」) changes every session key of that user. */
export function newSalt(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- session key ----------
// Explicit session headers CPA itself recognizes (sdk/cliproxy/session/identity.go), lower-case.
const SESSION_HEADERS = ['x-claude-code-session-id', 'session-id', 'session_id', 'x-session-id', 'x-session-affinity', 'x-conversation-id', 'x-thread-id', 'thread-id'];

function explicitID(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return '';
  const s = v.trim();
  return s && s.length <= 256 ? s : '';
}

function textOf(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')).join('\n');
  if (c && typeof c === 'object' && Array.isArray(c.parts)) return textOf(c.parts);
  if (c && typeof c.text === 'string') return c.text;
  return '';
}

/** First system prompt + first user message, across OpenAI chat, Anthropic, Responses and Gemini bodies. */
export function conversationAnchor(b: any): string {
  if (!b || typeof b !== 'object') return '';
  let sys = '', user = '';
  if (b.system !== undefined) sys = textOf(b.system);
  if (!sys && typeof b.instructions === 'string') sys = b.instructions;
  if (!sys && b.systemInstruction) sys = textOf(b.systemInstruction);
  const lists = [b.messages, Array.isArray(b.input) ? b.input : null, b.contents].filter(Array.isArray) as any[][];
  for (const list of lists) {
    for (const m of list) {
      const role = String(m?.role || '').toLowerCase();
      if (!sys && (role === 'system' || role === 'developer')) sys = textOf(m.content);
      if (!user && (role === 'user' || (!role && list === b.contents))) user = textOf(m.content ?? m.parts ?? m);
      if (sys && user) break;
    }
  }
  if (!user && typeof b.input === 'string') user = b.input;
  if (!user && typeof b.prompt === 'string') user = b.prompt;
  if (!sys && !user) return '';
  return sys.slice(0, 20000) + '\u0000' + user.slice(0, 20000);
}

function claudeSession(userID: string): string {
  if (userID.startsWith('{')) {
    try { return explicitID(JSON.parse(userID)?.session_id); } catch { return ''; }
  }
  const m = /_session_([0-9a-zA-Z-]+)$/.exec(userID);
  return m ? m[1] : userID;
}

/**
 * Opaque session key sent as X-Agy-Session. Sources, in order: an explicit client session header,
 * prompt_cache_key, Claude metadata.user_id, else a hash of the first system + user message.
 * Always mixed with the user's salt, the portal key id and the model family; raw content never leaves here.
 */
export function sessionKey(o: { keyId: number; model: string; headers: IncomingHttpHeaders; body: any; salt: string }): { key: string; source: string } | null {
  let source = '', value = '';
  for (const h of SESSION_HEADERS) {
    const v = explicitID(Array.isArray(o.headers[h]) ? (o.headers[h] as string[])[0] : o.headers[h]);
    if (v) { source = 'header'; value = v; break; }
  }
  const b = o.body && typeof o.body === 'object' ? o.body : null;
  if (!value && b) {
    const pck = explicitID(b.prompt_cache_key ?? b.promptCacheKey);
    if (pck) { source = 'prompt_cache_key'; value = pck; }
  }
  if (!value && b) {
    const uid = typeof b.metadata?.user_id === 'string' ? b.metadata.user_id.trim() : '';
    const sid = uid ? explicitID(claudeSession(uid)) : '';
    if (sid) { source = 'claude_user_id'; value = sid; }
  }
  if (!value && b) {
    const a = conversationAnchor(b);
    if (a) { source = 'first_message'; value = a; }
  }
  if (!value) return null;
  const family = modelGroup(o.model) || o.model.toLowerCase();
  const key = createHash('sha256').update(['agy-session:v1', o.salt, String(o.keyId), family, source, value].join('\u0000')).digest('hex').slice(0, 32);
  return { key, source };
}
