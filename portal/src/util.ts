import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
// AES-256-GCM for values the owner must be able to read back (API keys). Key lives in data/secret.key.
let sealKey: Buffer | null = null;
function getSealKey(): Buffer {
  if (sealKey) return sealKey;
  const f = join(config.dataDir, 'secret.key');
  if (!existsSync(f)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(f, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  sealKey = Buffer.from(readFileSync(f, 'utf8').trim(), 'base64');
  return sealKey;
}
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getSealKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    const b = Buffer.from(sealed, 'base64');
    const d = createDecipheriv('aes-256-gcm', getSealKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return 'scrypt$' + salt.toString('base64') + '$' + scryptSync(pw, salt, 32).toString('base64');
}
export function checkPassword(pw: string, stored: string | null | undefined): boolean {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(pw, Buffer.from(salt, 'base64'), 32);
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sendJSON(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof HttpError) {
    sendJSON(res, e.status, { error: e.code, message: e.message });
    return;
  }
  console.error('[error]', e);
  sendJSON(res, 500, { error: 'internal' });
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJSON(req: IncomingMessage, limit = 1024 * 1024): Promise<any> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; secure: boolean; path?: string }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || config.basePath || '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_number');
  return Math.max(min, Math.min(max, n));
}

export function str(v: unknown, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_string');
  return v.trim().slice(0, max);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Model group used by quota bars and the reserve rule. */
export type Group = 'gp' | 'gf' | 'ar' | 'cl'; // ar = Gemini 4 Argon: its own upstream quota
export function modelGroup(model: string): Group | null {
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('gpt')) return 'cl';
  if (m.includes('gemini') || m.startsWith('models/gemini')) {
    if (m.includes('argon')) return 'ar';
    if (m.includes('flash')) return 'gf';
    if (m.includes('pro')) return 'gp';
  }
  return null;
}

// Mask credentials in CPA request-log text before showing it to an admin.
export function maskSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{6,}/gi, '$1***')
    .replace(/\b(ya29\.)[A-Za-z0-9._-]+/g, '$1***')
    .replace(/\b(1\/\/)[A-Za-z0-9._-]{10,}/g, '$1***')
    .replace(/\b(sk-[A-Za-z0-9]*-?)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/\b(AIza)[A-Za-z0-9_-]{20,}/g, '$1***')
    .replace(/^((?:x-api-key|x-goog-api-key|api-key|cookie|set-cookie|proxy-authorization|authorization)\s*:\s*).+$/gim, '$1***')
    .replace(/("(?:access_token|refresh_token|id_token|api_key|apiKey|client_secret|password|token)"\s*:\s*")[^"]+"/g, '$1***"');
}
