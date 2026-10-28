// 闲置自动休眠, in-process against the mock CPA. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';

const mock = startMockCPA({ apiKey: 'k', mgmtKey: 'm' });
let dataDir = '';
let as: typeof import('../src/autosleep.ts');
let db: typeof import('../src/db.ts');
let cpa: typeof import('../src/cpa.ts');
let alice = 0, bob = 0;
const H = 3600e3;

function account(id: string, owner: number, extra: Record<string, any> = {}) {
  const c = mock.addCred(id, id + '@example.invalid');
  db.run('INSERT INTO accounts (auth_id, owner_id, email, created_at) VALUES (?, ?, ?, ?)', id, owner, c.email, Date.now() - 5 * H);
  for (const [k, v] of Object.entries(extra)) db.run(`UPDATE accounts SET ${k} = ? WHERE auth_id = ?`, v, id);
  return c;
}
const used = (id: string, ago: number) => db.run("INSERT INTO usage (ts, user_id, pool, auth_id, path, status, result, latency_ms) VALUES (?, ?, 'private', ?, '/v1/chat/completions', 200, 'ok', 1)", Date.now() - ago, alice, id);
const row = (id: string) => db.one('SELECT * FROM accounts WHERE auth_id = ?', id)!;

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-as-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_URL: `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  db = await import('../src/db.ts');
  cpa = await import('../src/cpa.ts');
  as = await import('../src/autosleep.ts');
  db.run("INSERT INTO users (discord_id, name, created_at, auto_sleep) VALUES ('u1', 'alice', ?, 1)", Date.now());
  db.run("INSERT INTO users (discord_id, name, created_at) VALUES ('u2', 'bob', ?)", Date.now());
  alice = Number(db.one("SELECT id FROM users WHERE discord_id = 'u1'")!.id);
  bob = Number(db.one("SELECT id FROM users WHERE discord_id = 'u2'")!.id);
});
after(() => {
  mock.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('sweep sleeps idle 小锅饭 accounts only; wakeFor brings back only those', async () => {
  const idle = account('idle', alice); used('idle', 2 * H);
  const fresh = account('fresh', alice); used('fresh', 10 * 60000);
  const shared = account('shared', alice, { shared: 1 });
  const manual = account('manual', alice); manual.disabled = true;
  const other = account('other', bob);
  await cpa.creds(0);
  await as.sweep();
  assert.equal(idle.disabled, true); assert.ok(row('idle').sleep_at);
  assert.equal(fresh.disabled, false); assert.equal(row('fresh').sleep_at, null);
  assert.equal(shared.disabled, false); // in 大锅饭: others may need it
  assert.equal(row('manual').sleep_at, null); // switched off by hand: not ours
  assert.equal(other.disabled, false); // bob has the switch off
  assert.equal(await as.wakeFor(alice), 1);
  assert.equal(idle.disabled, false); assert.equal(row('idle').sleep_at, null);
  assert.equal(manual.disabled, true);
});
