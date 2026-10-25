// Auto-disable of 403 accounts, in-process against the mock CPA. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';

const mock = startMockCPA({ apiKey: 'k', mgmtKey: 'm' });
let dataDir = '';
let ad: typeof import('../src/autodisable.ts');
let db: typeof import('../src/db.ts');

const VERIFY = JSON.stringify({ error: { code: 403, message: 'Verify your account to continue.', status: 'PERMISSION_DENIED', details: [{ reason: 'VALIDATION_REQUIRED' }] } }, null, 2);
const R429 = JSON.stringify({ error: { code: 429, message: 'You have exhausted your capacity on this model.', status: 'RESOURCE_EXHAUSTED' } });
const R401 = JSON.stringify({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });

let owner = 0;
function account(id: string, cpaState: { status?: string; status_message?: string; unavailable?: boolean; disabled?: boolean } = {}, rowExtra: Record<string, any> = {}) {
  const c = mock.addCred(id, id + '@example.invalid');
  Object.assign(c, cpaState);
  db.run('INSERT INTO accounts (auth_id, owner_id, email, created_at) VALUES (?, ?, ?, ?)', id, owner, c.email, Date.now());
  for (const [k, v] of Object.entries(rowExtra)) db.run(`UPDATE accounts SET ${k} = ? WHERE auth_id = ?`, v, id);
  return c;
}
const row = (id: string) => db.one('SELECT * FROM accounts WHERE auth_id = ?', id)!;
const err = (msg: string) => ({ status: 'error', unavailable: true, status_message: msg });

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  dataDir = mkdtempSync(join(tmpdir(), 'agy-pot-ad-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_URL: `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`, CPA_API_KEY: 'k', CPA_MANAGEMENT_KEY: 'm' });
  db = await import('../src/db.ts');
  ad = await import('../src/autodisable.ts');
  db.run("INSERT INTO users (discord_id, name, created_at) VALUES ('u1', 'alice', ?)", Date.now());
  owner = Number(db.one("SELECT id FROM users WHERE discord_id = 'u1'")!.id);
});
after(() => {
  mock.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('forbiddenReason: 403 forms count, 429 / 401 / cooldown do not', () => {
  const r = { quota_err: null };
  const cred = (status: string, statusMessage: string, unavailable = false) => ({ status, statusMessage, unavailable }) as any;
  assert.match(ad.forbiddenReason(r, cred('error', VERIFY))!, /^403 Verify your account/);
  assert.ok(ad.forbiddenReason(r, cred('error', 'Your account has been suspended')));
  assert.ok(ad.forbiddenReason(r, cred('active', 'HTTP 403 Forbidden', true)));
  assert.equal(ad.forbiddenReason(r, cred('error', R429)), null);
  assert.equal(ad.forbiddenReason(r, cred('error', R401)), null);
  assert.equal(ad.forbiddenReason(r, cred('error', 'invalid_grant: Token has been expired or revoked.')), null);
  assert.equal(ad.forbiddenReason(r, cred('error', 'quota cooldown, retry after 30s', true)), null);
  assert.equal(ad.forbiddenReason(r, cred('active', VERIFY)), null); // stale message on a healthy credential
  assert.ok(ad.forbiddenReason({ quota_err: 'fetchAvailableModels 403: ' + VERIFY, quota_at: Date.now() }, cred('active', '')));
  assert.equal(ad.forbiddenReason({ quota_err: 'fetchAvailableModels 429: ' + R429, quota_at: Date.now() }, cred('active', '')), null);
  assert.equal(ad.forbiddenReason({ quota_err: 'fetchAvailableModels 403: ' + VERIFY, quota_at: Date.now() - 3600e3 }, cred('active', '')), null);
});

test('sweep: 403 account is disabled, 429 / 401 / manual / suspended left alone', async () => {
  const bad = account('bad.json', err(VERIFY));
  const busy = account('busy.json', err(R429));
  const expired = account('expired.json', err(R401));
  const manual = account('manual.json', { disabled: true });
  const susp = account('susp.json', err(VERIFY), { suspended: 1 });
  await ad.sweep();
  assert.equal(bad.disabled, true);
  assert.ok(row('bad.json').auto_disabled_at > 0);
  assert.match(row('bad.json').auto_disabled_reason, /Verify your account/);
  for (const [c, id] of [[busy, 'busy.json'], [expired, 'expired.json'], [susp, 'susp.json']] as const) {
    assert.equal(c.disabled, false, id);
    assert.equal(row(id).auto_disabled_at, null, id);
  }
  assert.equal(manual.disabled, true);
  assert.equal(row('manual.json').auto_disabled_at, null);
});

test('sweep: manually disabled account is never re-enabled', async () => {
  await ad.sweep();
  await ad.sweep();
  assert.equal(mock.st.creds.get('manual.json')!.disabled, true);
});

test('sweep: probe waits 30 min, stays off while still 403, recovers once it works', async () => {
  mock.st.gen.set('bad.json', { status: 403, body: VERIFY });
  await ad.sweep(); // disabled just now: no probe yet
  assert.equal(mock.st.creds.get('bad.json')!.disabled, true);

  db.run('UPDATE accounts SET auto_disabled_at = ? WHERE auth_id = ?', Date.now() - 31 * 60000, 'bad.json');
  await ad.sweep(); // probe: still 403
  assert.equal(mock.st.creds.get('bad.json')!.disabled, true);
  assert.ok(row('bad.json').auto_disabled_at);

  mock.st.gen.set('bad.json', { status: 200, body: '{"response":{}}' });
  await ad.sweep(); // probed a moment ago: waits
  assert.equal(mock.st.creds.get('bad.json')!.disabled, true);
});

test('sweep: auto-disabled account that works again is re-enabled and columns cleared', async () => {
  const c = account('back.json', err(VERIFY));
  await ad.sweep();
  assert.equal(c.disabled, true);
  db.run('UPDATE accounts SET auto_disabled_at = ? WHERE auth_id = ?', Date.now() - 31 * 60000, 'back.json');
  mock.st.gen.set('back.json', { status: 429, body: R429 }); // only out of quota: no longer a 403
  await ad.sweep();
  assert.equal(c.disabled, false);
  assert.equal(row('back.json').auto_disabled_at, null);
  assert.equal(row('back.json').auto_disabled_reason, null);
  await ad.sweep(); // CPA reset the status on enable: stays on
  assert.equal(c.disabled, false);
});

test('sweep: re-enabled by hand outside the portal -> columns cleared, not fought', async () => {
  const c = account('hand.json', err(VERIFY));
  await ad.sweep();
  assert.equal(c.disabled, true);
  c.disabled = false; // e.g. admin / CPA panel
  await ad.sweep();
  assert.equal(c.disabled, false);
  assert.equal(row('hand.json').auto_disabled_at, null);
});
