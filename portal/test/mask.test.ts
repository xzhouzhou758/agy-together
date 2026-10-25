import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../src/util.ts';

test('request-log masking hides credentials, keeps content', () => {
  const s = [
    'Authorization: Bearer sk-agyABCDEFGHIJKLMNOP',
    'Authorization: Bearer ya29.a0AfB_byC123456789',
    'x-api-key: abcdefg123',
    'Cookie: agy_sid=secretsession',
    '{"access_token":"ya29.zzz","refresh_token":"1//0eXYZabcdefghijk","project":"p1"}',
    'key=AIzaSyA1234567890abcdefghijk text sk-agy-0123456789abcdef hi',
    '{"messages":[{"role":"user","content":"hello world"}]}',
  ].join('\n');
  const m = maskSecrets(s);
  for (const leak of ['ABCDEFGHIJKLMNOP', 'a0AfB_byC123456789', 'abcdefg123', 'secretsession', 'ya29.zzz', '0eXYZabcdefghijk', '1234567890abcdefghijk', '0123456789abcdef']) {
    assert.ok(!m.includes(leak), 'leaked ' + leak + '\n' + m);
  }
  assert.ok(m.includes('"project":"p1"'));
  assert.ok(m.includes('hello world'));
});
