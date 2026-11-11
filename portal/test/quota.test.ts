// Background quota refresher against the mock CPA. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';

const mock = startMockCPA({ apiKey: 'k', mgmtKey: 'm' });
let dataDir = '';
let quota: typeof import('../src/quota.ts');
let db: typeof import('../src/db.ts');
let owner = 0;

function account(id: string, quotaAt: number | null) {
  const c = mock.addCred(id, id + '@example.invalid');
  db.run('INSERT INTO accounts (auth_id, owner_id, email, created_at, quota_at) VALUES (?, ?, ?, ?, ?)', id, owner, c.email, Date.now(), quotaAt);
  return c;
}
const row = (id: string) => db.one('SELECT * FROM accounts WHERE auth_id = ?', id)!;

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-q-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_URL: `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  db = await import('../src/db.ts');
  quota = await import('../src/quota.ts');
  db.run("INSERT INTO users (discord_id, name, created_at) VALUES ('u1', 'alice', ?)", Date.now());
  owner = Number(db.one("SELECT id FROM users WHERE discord_id = 'u1'")!.id);
});
after(() => {
  mock.server.closeAllConnections();
  mock.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('refresher: a hung account times out, is pushed back and never blocks the rest', async () => {
  account('hung.json', null); // NULL quota_at sorts first
  account('ok1.json', 1);
  account('ok2.json', 2);
  mock.st.hang.add('hung.json');
  await Promise.all([quota.refreshStale(300, 0), quota.refreshStale(300, 0)]); // second pass: no-op while one runs
  assert.match(row('hung.json').quota_err, /timed out/);
  assert.ok(row('hung.json').quota_at > 2);
  for (const id of ['ok1.json', 'ok2.json']) {
    assert.ok(row(id).quota_json, id);
    assert.equal(row(id).quota_err, null, id);
  }
  // the timed-out fetch no longer holds the account
  mock.st.hang.delete('hung.json');
  const q = await quota.refreshQuota('hung.json', 5000);
  assert.ok(q.groups.length);
  assert.equal(row('hung.json').quota_err, null);
});
