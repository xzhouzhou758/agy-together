import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sfKind } from '../src/sf.ts';
import { bannedPreset } from '../src/gateway.ts';

test('sfKind matches only the two relay paths', () => {
  assert.equal(sfKind('/v1/embeddings'), 'embeddings');
  assert.equal(sfKind('/v1/rerank/'), 'rerank');
  assert.equal(sfKind('/v1/chat/completions'), null);
  assert.equal(sfKind('/v1/embeddings/x'), null);
});

test('bannedPreset spots the kunlun preset, lets the bot and normal chats through', () => {
  const b = (s: string) => Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: s }] }));
  assert.equal(bannedPreset(b('C:\\\\huatu\\\\Project_Workspace\\\\Novel_Engine\\\\a.md')), true);
  assert.equal(bannedPreset(b('huatu/Project_Workspace/Novel_Engine')), true);
  assert.equal(bannedPreset(b('LOCAL_WINDOWS_HOST_DAEMON ready')), true);
  assert.equal(bannedPreset(b('【ToolCall引导】')), true);
  assert.equal(bannedPreset(b('===== 数据（用户名都是站内昵称，可以直接说）===== LOCAL_WINDOWS_HOST_DAEMON')), false);
  assert.equal(bannedPreset(b('你好')), false);
  assert.equal(bannedPreset(Buffer.alloc(0)), false);
});
