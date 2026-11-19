import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'stock-discovery-'));
const { planStock, stockTick, watched } = await import('../src/stock.ts');
const { setSetting, getSetting } = await import('../src/db.ts');
const item = (id: number, stock = 0) => ({ id, name: `商品${id}`, stock, price: 10, sold: 0 });
test('baseline, all-store discoveries, sold-out launch, restock, disappearance and restart', () => {
  let r = planStock([item(1), item(2, 3)], [1], null);
  assert.deepEqual(r.state.pending, []);
  r = planStock([item(1), item(2, 3), item(3), item(4, 5)], [1], r.state);
  assert.deepEqual(r.added, [3, 4]);
  assert.equal(r.state.pending.length, 2);
  assert.match(r.state.pending[0], /暂时缺货/);
  r.state.pending = [];
  r = planStock([item(1), item(3, 2), item(4, 5)], [1, 3, 4], JSON.parse(JSON.stringify(r.state)));
  assert.equal(r.state.pending.length, 1);
  assert.match(r.state.pending[0], /补货了/);
  r.state.pending = [];
  r = planStock([item(2, 3), item(3, 2), item(4, 5)], [1, 3, 4], r.state);
  assert.equal(r.state.pending.length, 0);
  assert.deepEqual(r.added, []);
});
test('failed send stays queued; retries once; admin cache cannot consume discoveries; bad list preserves state', async () => {
  setSetting('bot_proactive', '1'); setSetting('bot_channel_id', 'C1'); setSetting('discord_bot_token', 'bot-token');
  setSetting('stock_watch', '1');
  const real = globalThis.fetch;
  let items = [item(1)], fail = false, bad = false, sends = 0;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('yh-mo')) return new Response(JSON.stringify({ code: 200, data: bad ? [] : items }));
    sends++; return new Response('{}', { status: fail ? 503 : 200 });
  }) as any;
  try {
    await stockTick(); assert.equal(sends, 0);
    items = [item(1), item(9, 2)]; fail = true;
    setSetting('stock_items', JSON.stringify({items}));
    await stockTick(); assert.equal(sends, 1);
    assert.ok(watched().includes(9));
    assert.equal(JSON.parse(getSetting('stock_discovery')!).pending.length, 1);
    fail = false; await stockTick(); assert.equal(sends, 2);
    await stockTick(); assert.equal(sends, 2);
    const before = getSetting('stock_discovery'); bad = true;
    await stockTick(); assert.equal(getSetting('stock_discovery'), before);
  } finally { globalThis.fetch = real; }
});
