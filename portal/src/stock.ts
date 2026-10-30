// Stock watch on an outside card shop (yh-mo.xyz, an acg-faka store): its public commodity list carries each
// item's stock. Watched items post to the bot channel (no mentions) when they go from sold out to in stock;
// the bot chat can also look up the shop's 成品号 when someone asks whether there are accounts for sale.
import { db, all, run, now, getSetting, setSetting } from './db.ts';
import { post, proactive, stockOnly } from './bot.ts';

const SHOP = 'https://yh-mo.xyz';
const EVERY = 5 * 60e3, FAIL_TELL = 6;    // 6 failed polls in a row (30 min) → say the watch is broken, once
export type Item = { id: number; name: string; stock: number; price: number; sold: number };
/** Watched item ids, setting stock_watch (comma-separated), default 47 and 32. */
export const watched = () => (getSetting('stock_watch') ?? '47,32').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
// people who asked the bot "补货的时候@我": mentioned in every restock post until they say stop
db.exec(`CREATE TABLE IF NOT EXISTS stock_subs (discord_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`);
export function subscribe(discordId: string, on: boolean): string {
  if (!/^\d{5,25}$/.test(discordId)) return '没认出提问人的 Discord 账号';
  if (on) { run('INSERT OR IGNORE INTO stock_subs(discord_id, created_at) VALUES(?, ?)', discordId, now()); return '已订阅：以后监控的成品号补货时会 @他（想停就说「补货别 @我了」）'; }
  return Number(run('DELETE FROM stock_subs WHERE discord_id = ?', discordId).changes) ? '已取消订阅，补货不再 @他' : '他本来就没订阅';
}
export const subscribers = (): string[] => all('SELECT discord_id FROM stock_subs ORDER BY created_at').map((r: any) => String(r.discord_id));
export const itemURL = (id: number) => `${SHOP}/item/${id}`;

export async function fetchItems(): Promise<Item[]> {
  const r = await fetch(SHOP + '/user/api/index/commodity', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j: any = await r.json();
  if (j?.code !== 200 || !Array.isArray(j.data)) throw new Error('bad response ' + r.status);
  const items = j.data.map((c: any) => ({ id: Number(c.id), name: String(c.name || '').trim(), stock: Number(c.stock) || 0, price: Number(c.price) || 0, sold: Number(c.order_sold) || 0 }));
  setSetting('stock_items', JSON.stringify({ at: now(), items }));   // the admin page lists these without calling the shop
  return items;
}

/** For the admin page: the last item list seen (refresh = fetch it now) and which ids are watched. */
export async function stockAdmin(refresh = false): Promise<{ at: number | null; items: Item[]; watched: number[] }> {
  if (refresh) await fetchItems();
  let c: any = {};
  try { c = JSON.parse(getSetting('stock_items') || '{}'); } catch {}
  return { at: c.at ?? null, items: Array.isArray(c.items) ? c.items : [], watched: watched() };
}
export function setWatched(ids: number[]): number[] {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
  setSetting('stock_watch', list.join(','));
  return list;
}

/** One poll's worth of decisions: messages for items back in stock, and the new remembered stocks. */
export function restocked(items: Item[], ids: number[], last: Record<string, number>): { msgs: string[]; next: Record<string, number> } {
  const msgs: string[] = [], next: Record<string, number> = {};
  for (const id of ids) {
    const it = items.find((x) => x.id === id);
    if (!it) continue;
    next[id] = it.stock;
    // an item ticked just now is only learned, so one already in stock isn't announced as a restock
    if (it.stock > 0 && id in last && last[id] <= 0) msgs.push(`📦 **补货了**：${it.name}\n库存 **${it.stock}** · ¥${it.price} · ${itemURL(id)}`);
  }
  return { msgs, next };
}

let fails = 0;
export async function stockTick(): Promise<void> {
  let items: Item[];
  try { items = await fetchItems(); fails = 0; } catch (e) {
    if (++fails === FAIL_TELL) await post(`⚠️ 库存监控连续 ${FAIL_TELL} 次查不到 yh-mo.xyz 了（${(e as Error).message}），可能是对方改了接口或加了防护`);
    return;
  }
  let last: Record<string, number> = {};
  try { last = JSON.parse(getSetting('stock_last') || '{}'); } catch {}
  const first = !getSetting('stock_last');
  const { msgs, next } = restocked(items, watched(), last);
  const subs = subscribers().slice(0, 100);           // Discord lets one message ping at most 100 users
  const tail = subs.length ? '\n' + subs.map((id) => `<@${id}>`).join(' ') : '';
  for (const m of first ? [] : msgs) await post((m + tail).length <= 2000 ? m + tail : m, subs, false, true);   // the very first poll only learns the current stock
  setSetting('stock_last', JSON.stringify(next));
}

/** For the bot chat: the shop's ready-made accounts (成品号) and their stock right now. */
export async function stockForChat(): Promise<string> {
  try {
    const items = (await fetchItems()).filter((x) => x.name.includes('成品号'));
    if (!items.length) return 'yh-mo.xyz 现在没有上架成品号';
    return `yh-mo.xyz 成品号实时库存：\n` + items.map((x) => `- ${x.name}：${x.stock > 0 ? `有货 ${x.stock}` : '缺货'}，¥${x.price}，${itemURL(x.id)}`).join('\n');
  } catch (e) {
    return '查不到 yh-mo.xyz 的库存：' + (e as Error).message;
  }
}

export function startStockWatch(): void {
  const tick = () => !proactive() && !stockOnly() ? undefined : stockTick().catch((e) => console.error('[stock]', (e as Error).message));
  setTimeout(tick, 30e3).unref();
  setInterval(tick, EVERY).unref();
}
