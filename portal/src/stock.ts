// Stock watch on an outside card shop (yh-mo.xyz, an acg-faka store): its public commodity list carries each
// item's stock. Watched items post to the bot channel (no mentions) when they go from sold out to in stock;
// the bot chat can also look up the shop's 成品号 when someone asks whether there are accounts for sale.
import { getSetting, setSetting } from './db.ts';
import { post } from './bot.ts';

const SHOP = 'https://yh-mo.xyz';
const EVERY = 5 * 60e3, FAIL_TELL = 6;    // 6 failed polls in a row (30 min) → say the watch is broken, once
export type Item = { id: number; name: string; stock: number; price: number; sold: number };
/** Watched item ids, setting stock_watch (comma-separated), default 47 and 32. */
export const watched = () => (getSetting('stock_watch') ?? '47,32').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
export const itemURL = (id: number) => `${SHOP}/item/${id}`;

export async function fetchItems(): Promise<Item[]> {
  const r = await fetch(SHOP + '/user/api/index/commodity', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j: any = await r.json();
  if (j?.code !== 200 || !Array.isArray(j.data)) throw new Error('bad response ' + r.status);
  return j.data.map((c: any) => ({ id: Number(c.id), name: String(c.name || '').trim(), stock: Number(c.stock) || 0, price: Number(c.price) || 0, sold: Number(c.order_sold) || 0 }));
}

/** One poll's worth of decisions: messages for items back in stock, and the new remembered stocks. */
export function restocked(items: Item[], ids: number[], last: Record<string, number>): { msgs: string[]; next: Record<string, number> } {
  const msgs: string[] = [], next: Record<string, number> = {};
  for (const id of ids) {
    const it = items.find((x) => x.id === id);
    if (!it) continue;
    next[id] = it.stock;
    if (it.stock > 0 && (last[id] ?? 0) <= 0) msgs.push(`📦 **补货了**：${it.name}\n库存 **${it.stock}** · ¥${it.price} · ${itemURL(id)}`);
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
  for (const m of first ? [] : msgs) await post(m);   // the very first poll only learns the current stock
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
  const tick = () => stockTick().catch((e) => console.error('[stock]', (e as Error).message));
  setTimeout(tick, 30e3).unref();
  setInterval(tick, EVERY).unref();
}
