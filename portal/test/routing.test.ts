// Unit tests: session key derivation and error-reason helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agy-pot-unit-'));
const { sessionKey, conversationAnchor, userMode } = await import('../src/routing.ts');
const { humanWait, errorBody, dialectOf, reasonText, exhaustedFor } = await import('../src/reason.ts');

const k = (body: any, o: { keyId?: number; model?: string; headers?: any; salt?: string } = {}) =>
  sessionKey({ keyId: o.keyId ?? 1, model: o.model ?? 'claude-sonnet-4-6', headers: o.headers ?? {}, body, salt: o.salt ?? 's' });

test('session key: anthropic body, stable across turns, differs by conversation / key / salt / family', () => {
  const turn = (n: number, first = 'fix the bug in foo.ts') => {
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: first }] }];
    for (let i = 1; i < n; i++) messages.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'and ' + i });
    return { model: 'claude-sonnet-4-6', system: [{ type: 'text', text: 'You are Claude Code' }], messages };
  };
  const a = k(turn(1))!;
  assert.equal(a.source, 'first_message');
  assert.match(a.key, /^[0-9a-f]{32}$/);
  assert.equal(k(turn(5))!.key, a.key);
  assert.notEqual(k(turn(1, 'write a README'))!.key, a.key);
  assert.notEqual(k(turn(1), { keyId: 2 })!.key, a.key);
  assert.notEqual(k(turn(1), { salt: 't' })!.key, a.key);
  assert.notEqual(k(turn(1), { model: 'gemini-3-flash' })!.key, a.key);
  assert.equal(k(turn(1), { model: 'claude-opus-4-6-thinking' })!.key, a.key, 'same family (Claude group) keeps the key');
  assert.ok(!a.key.includes('fix'));
});

test('session key: source priority header > prompt_cache_key > metadata.user_id > first message', () => {
  const body = { prompt_cache_key: 'pck-1', metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 'sid-1' }) }, messages: [{ role: 'user', content: 'x' }] };
  assert.equal(k(body, { headers: { 'x-claude-code-session-id': 'cc-1' } })!.source, 'header');
  assert.equal(k(body)!.source, 'prompt_cache_key');
  const { prompt_cache_key: _, ...noPck } = body;
  const u = k(noPck)!;
  assert.equal(u.source, 'claude_user_id');
  // same Claude Code session, different first message -> same key
  assert.equal(k({ ...noPck, messages: [{ role: 'user', content: 'y' }] })!.key, u.key);
  // legacy user_id format
  const legacy = k({ metadata: { user_id: 'user_abc_account__session_123e4567-e89b-12d3-a456-426614174000' }, messages: [] })!;
  assert.equal(legacy.source, 'claude_user_id');
  assert.equal(k({ metadata: { user_id: 'user_zzz_account__session_123e4567-e89b-12d3-a456-426614174000' }, messages: [] })!.key, legacy.key);
  // control characters / oversized ids are ignored
  assert.equal(k({ messages: [{ role: 'user', content: 'x' }] }, { headers: { 'x-session-id': 'a'.repeat(300) } })!.source, 'first_message');
});

test('session key: OpenAI chat, Responses and Gemini bodies; nothing to anchor -> null', () => {
  assert.equal(conversationAnchor({ messages: [{ role: 'developer', content: 'D' }, { role: 'user', content: 'U' }] }), 'D\u0000U');
  assert.equal(conversationAnchor({ instructions: 'I', input: 'U' }), 'I\u0000U');
  assert.equal(conversationAnchor({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'U' }] }] }), '\u0000U');
  assert.equal(conversationAnchor({ systemInstruction: { parts: [{ text: 'S' }] }, contents: [{ role: 'user', parts: [{ text: 'U' }] }, { role: 'model', parts: [{ text: 'M' }] }] }), 'S\u0000U');
  assert.equal(k({ model: 'x' }), null);
  assert.equal(k(null), null);
  assert.equal(userMode('cache'), 'cache');
  assert.equal(userMode('weird'), 'balance');
  assert.equal(userMode(null), 'balance');
});

test('error helpers: wait text, dialects, reasons, exhausted quota', () => {
  assert.equal(humanWait(30), '1 分钟');
  assert.equal(humanWait(8100), '2 小时 15 分');
  assert.equal(humanWait(7200), '2 小时');
  assert.equal(humanWait(90000), '1 天 1 小时');
  assert.equal(dialectOf('/v1/messages'), 'anthropic');
  assert.equal(dialectOf('/v1/messages/count_tokens'), 'anthropic');
  assert.equal(dialectOf('/v1beta/models/gemini-3-flash:streamGenerateContent'), 'gemini');
  assert.equal(dialectOf('/v1/chat/completions'), 'openai');
  assert.equal(dialectOf('/v1/responses'), 'openai');
  assert.deepEqual(JSON.parse(errorBody('/v1/messages', 429, 'insufficient_quota', 'm')), { type: 'error', error: { type: 'rate_limit_error', message: 'm' } });
  assert.deepEqual(JSON.parse(errorBody('/v1beta/models/x:generateContent', 503, 'no_available_account', 'm')), { error: { code: 503, message: 'm', status: 'UNAVAILABLE' } });
  assert.deepEqual(JSON.parse(errorBody('/v1/chat/completions', 429, 'rate_limited', 'm')), { error: { message: 'm', type: 'rate_limited', code: 'rate_limited' } });
  assert.equal(reasonText({ result: 'upstream', status: 502, upstream_status: 500 }), '上游错误（502，上游 500）');
  assert.equal(reasonText({ result: 'client', status: 499 }), '客户端断开');
  assert.equal(reasonText({ result: 'quota', status: 429, reason: '自定义' }), '自定义');
  const reset = new Date(Date.now() + 3 * 3600e3).toISOString();
  const row = { quota_json: JSON.stringify({ groups: [['cl', 0.4, null], ['gf', 0, reset]], windows: [{ key: 'claude', buckets: [{ window: '5h', frac: 0, reset }, { window: 'weekly', frac: 0.5, reset: null }] }] }) };
  assert.ok(Math.abs(exhaustedFor(row, 'claude-sonnet-4-6') - 3 * 3600) < 5);
  assert.ok(exhaustedFor(row, 'gemini-3-flash') > 3 * 3600 - 5);
  assert.equal(exhaustedFor(row, 'gemini-3-pro-high'), 0);
  assert.equal(exhaustedFor({ quota_json: null }, 'claude-sonnet-4-6'), 0);
});
