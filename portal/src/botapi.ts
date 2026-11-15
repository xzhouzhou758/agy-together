// Dedicated bot upstream: never registered with the shared pool.
import { getSetting } from './db.ts';
import { unseal } from './util.ts';
export function botAPISettings() {
  return { url: getSetting('bot_api_url') || '', keySet: !!getSetting('bot_api_key'), model: getSetting('bot_api_model') || '' };
}
export function normalizeBotURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('API 地址无效');
  const u = new URL(value.trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('API 地址只支持 HTTP / HTTPS，不能包含密码或查询参数');
  let path = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!path) path = '/v1';
  return u.origin + path;
}
export async function botAPIPost(body: string): Promise<{ status: number; trace: undefined; body: string }> {
  const { url } = botAPISettings(), key = unseal(getSetting('bot_api_key'));
  if (!url || !key) throw new Error('upstream');
  const r = await fetch(url + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key },
    body, redirect: 'error', signal: AbortSignal.timeout(90000),
  });
  return { status: r.status, trace: undefined, body: await r.text() };
}
