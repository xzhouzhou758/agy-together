// Account error details, without any database access (unit-testable):
//  - classify(): what kind of account problem a message describes (used by bot.ts accountProblem)
//  - errText(): CPA reasons / status codes / Google error bodies as short plain Chinese
//  - extractAction(): the verify / appeal link Google puts into a 403 body (details[].metadata)

export type ProblemKind = 'verify' | 'auth' | 'banned' | 'error';
export function classify(msg: string): ProblemKind | null {
  if (!msg) return null;
  if (/verify your account|validation_required|account verification/i.test(msg)) return 'verify';
  if (/has been disabled|suspended|terms of service|violat|account.{0,20}(banned|disabled)/i.test(msg)) return 'banned';
  if (/invalid_grant|invalid_token|unauthenticated|\b401\b|token.{0,20}(expired|revoked)|refresh.{0,20}fail/i.test(msg)) return 'auth';
  if (/\b403\b|permission_denied/i.test(msg)) return 'error';
  return null;
}

/** Short plain-Chinese reason. Unknown text comes back as is (trimmed); nothing at all -> ''. */
export function errText(msg: string | null | undefined, status?: number | null): string {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  const code = Number(status) || 0;
  const k = classify(s);
  if (k === 'verify') return '需要验证账号';
  if (k === 'banned') return '账号被 Google 停用';
  if (/invalid_grant/i.test(s)) return '授权已失效，需要重新登录';
  if (/cloudflare/i.test(s)) return '被 Cloudflare 拦截';
  if (/payment_required|permission_denied|forbidden/i.test(s) || code === 403 || (!code && /\b403\b/.test(s))) return 'Google 拒绝访问 (403)';
  if (k === 'auth' || /unauthori[sz]ed/i.test(s) || code === 401 || (!code && /\b401\b/.test(s))) return '登录失效 (401)';
  if (/quota|exhaust|rate.?limit|too many requests/i.test(s) || code === 429 || (!code && /\b429\b/.test(s))) return '额度用完 (429)';
  if (/not.?found/i.test(s) || code === 404 || (!code && /\b404\b/.test(s))) return '模型不可用 (404)';
  if (/transient|unavailable|timeout|bad gateway|internal/i.test(s) || code >= 500 || (!code && /\b5\d\d\b/.test(s))) return '上游临时故障' + (code >= 500 ? ` (${code})` : '');
  if (s) return s.slice(0, 120);
  return code ? 'HTTP ' + code : '';
}

export type Action = { kind: 'verify' | 'appeal'; url: string };

/** Only https links on Google's own hosts. Returns the normalized URL or null. */
export function safeGoogleURL(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  const ok = h === 'google.com' || h.endsWith('.google.com') || h === 'googleapis.com' || h.endsWith('.googleapis.com') || h === 'goo.gl';
  return ok ? u.href : null;
}

const KEYS: [string, Action['kind']][] = [['appeal_url', 'appeal'], ['validation_url', 'verify']];

function fromJSON(v: any, depth = 0): Action | null {
  if (depth > 8 || v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200000) {
      try { return fromJSON(JSON.parse(t), depth + 1); } catch { return null; }
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (const x of v) { const a = fromJSON(x, depth + 1); if (a) return a; }
    return null;
  }
  if (typeof v !== 'object') return null;
  const md = v.metadata;
  if (md && typeof md === 'object') {
    for (const [key, kind] of KEYS) {
      const url = typeof md[key] === 'string' ? safeGoogleURL(md[key]) : null;
      if (url) return { kind, url };
    }
  }
  for (const x of Object.values(v)) { const a = fromJSON(x, depth + 1); if (a) return a; }
  return null;
}

function unescapeURL(s: string): string {
  return s
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+\//g, '/')
    .replace(/&amp;/gi, '&');
}

/** The verify / appeal link in an upstream error body (JSON, JSON inside a string, or plain text), or null. */
export function extractAction(body: string | null | undefined): Action | null {
  const s = String(body || '');
  if (!/validation_url|appeal_url/i.test(s)) return null;
  // the body may carry a status prefix ("403 {...}") or be wrapped by CPA: try the JSON part
  const at = s.search(/[{[]/);
  if (at >= 0) {
    try {
      const a = fromJSON(JSON.parse(s.slice(at)));
      if (a) return a;
    } catch {}
  }
  for (const [key, kind] of KEYS) {
    const re = new RegExp(key + '\\\\*["\']?\\s*[:=]\\s*\\\\*["\']?(https:(?:[^"\'\\s\\\\<>]|\\\\+u[0-9a-fA-F]{4}|\\\\+/)+)', 'gi');
    for (const m of s.matchAll(re)) {
      const url = safeGoogleURL(unescapeURL(m[1]));
      if (url) return { kind, url };
    }
  }
  return null;
}

export type Cooldown = { scope: string; model: string; reason: string; retryAt: string | null; remainingSeconds: number; backoffLevel: number | null; httpStatus: number | null };
export type CooldownView = { scope: string; model: string; text: string; status: number | null; retryAt: string };

/** Cooldowns whose retry time is still ahead, translated, soonest first. */
export function activeCooldowns(list: Cooldown[] | null | undefined, t = Date.now()): CooldownView[] {
  const out: CooldownView[] = [];
  for (const c of list || []) {
    const at = c.retryAt ? Date.parse(c.retryAt) : NaN;
    if (!(at > t)) continue;
    out.push({ scope: c.scope, model: c.model, text: errText(c.reason, c.httpStatus), status: c.httpStatus, retryAt: new Date(at).toISOString() });
  }
  return out.sort((a, b) => Date.parse(a.retryAt) - Date.parse(b.retryAt));
}
