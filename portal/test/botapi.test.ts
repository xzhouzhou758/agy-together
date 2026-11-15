import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'bot-api-test-'));
process.env.DATA_DIR = dir;
const { botAPISettings, normalizeBotURL, botAPIPost } = await import('../src/botapi.ts');
const { db, setSetting, getSetting } = await import('../src/db.ts');
const { seal } = await import('../src/util.ts');
test('dedicated bot API keeps key private and sends to configured endpoint', async () => {
  assert.equal(normalizeBotURL('https://example.com/'), 'https://example.com/v1');
  assert.equal(normalizeBotURL('https://example.com/api/v1/chat/completions'), 'https://example.com/api/v1');
  for (const url of ['file:///tmp/a', 'https://user:pass@example.com', 'https://example.com?key=x']) assert.throws(() => normalizeBotURL(url));
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/custom/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-only-secret');
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      assert.equal(JSON.parse(body).model, 'test-model');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    setSetting('bot_api_url', `http://127.0.0.1:${port}/custom/v1`);
    setSetting('bot_api_key', seal('test-only-secret')); setSetting('bot_api_model', 'test-model');
    assert.ok(!JSON.stringify(botAPISettings()).includes('test-only-secret'));
    assert.notEqual(getSetting('bot_api_key'), 'test-only-secret');
    const r = await botAPIPost(JSON.stringify({ model: 'test-model' }));
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).choices[0].message.content, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS n FROM upstreams').get()?.n, 0);
  } finally { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
