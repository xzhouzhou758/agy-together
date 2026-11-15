import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../src/botsearch.ts';

test('search uses native grounding, strips thoughts, retains citations and handles failures', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: any, init: any) => {
      assert.equal(url, 'http://localhost:8889/v1beta/models/gemini-3.8-flash:generateContent');
      const b = JSON.parse(init.body);
      assert.deepEqual(b.tools, [{ googleSearch: {} }]);
      assert.equal(b.contents.length, 1);
      assert.equal(b.messages, undefined);
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text: '搜索结果 https://example.com' }] }, groundingMetadata: { groundingChunks: [{ web: { title: '官方', uri: 'https://example.org' } }] } }] });
    }) as typeof fetch;
    const result = await searchWeb('http://localhost:8889/v1/', 'test-key', '公开查询');
    assert.match(result, /搜索结果/); assert.match(result, /https:\/\/example.org/);
    assert.doesNotMatch(result, /private reasoning/);
    globalThis.fetch = (async () => new Response('secret upstream error', { status: 403 })) as typeof fetch;
    assert.match(await searchWeb('http://localhost/v1', 'k', 'query'), /HTTP 403/);
    assert.doesNotMatch(await searchWeb('http://localhost/v1', 'k', 'query'), /secret/);
    globalThis.fetch = (async () => Response.json({ candidates: [] })) as typeof fetch;
    assert.match(await searchWeb('http://localhost/v1', 'k', 'query'), /没有返回有效内容/);
    globalThis.fetch = (async () => { throw new Error('secret'); }) as typeof fetch;
    assert.match(await searchWeb('http://localhost/v1', 'k', 'query'), /连接失败或超时/);
    assert.match(await searchWeb('http://localhost/v1', 'k', '  '), /关键词/);
  } finally { globalThis.fetch = original; }
});
