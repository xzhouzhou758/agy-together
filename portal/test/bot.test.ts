// Unit tests for the bot's account-problem classifier and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agy-bot-'));
const { accountProblem, maskEmail, tk, ownerMessage, alertPosts } = await import('../src/bot.ts');

const cred = (o: Record<string, unknown> = {}) => ({ id: 'x', authIndex: '1', type: 'antigravity', email: 'e@x', disabled: false, status: 'active', statusMessage: '', unavailable: false, nextRetryAfter: null, projectId: '', note: '', updatedAt: '', createdAt: '', ...o }) as any;

test('problems: verify, login expired, banned; quota and cooldown are not problems', () => {
  assert.equal(accountProblem({}, cred()), null);
  assert.equal(accountProblem({ quota_err: 'fetchAvailableModels 403: {"error":{"message":"Verify your account to continue."}}' }, cred())?.kind, 'verify');
  assert.equal(accountProblem({}, cred({ status: 'error', statusMessage: 'invalid_grant: Token has been expired or revoked.' }))?.kind, 'auth');
  assert.equal(accountProblem({}, cred({ status: 'error', statusMessage: 'This account has been disabled for violating our Terms of Service' }))?.kind, 'banned');
  assert.equal(accountProblem({}, cred({ status: 'error', statusMessage: '429 RESOURCE_EXHAUSTED quota', nextRetryAfter: new Date(Date.now() + 6e5).toISOString() })), null);
  assert.equal(accountProblem({}, cred({ status: 'error', statusMessage: 'quota exhausted' })), null);
  // disabled by the owner: none of our business; suspended with the owner: same
  assert.equal(accountProblem({ quota_err: 'fetchAvailableModels 403' }, cred({ disabled: true })), null);
  assert.equal(accountProblem({ suspended: 1, quota_err: 'Verify your account' }, cred()), null);
  // disabled by the 403 auto-disable: still reported, and says so
  const p = accountProblem({ auto_disabled_at: 1, auto_disabled_reason: '403 Verify your account to continue' }, cred({ disabled: true }));
  assert.equal(p?.kind, 'verify');
  assert.match(p!.label, /自动停用/);
});

test('helpers', () => {
  assert.equal(maskEmail('someone673@gmail.com'), 'som***@gmail.com');
  assert.equal(maskEmail('ab@x.io'), 'a**@x.io');
  assert.equal(tk(9999), '9999');
  assert.equal(tk(12345), '1.2 万');
  assert.equal(tk(3.2e8), '3.20 亿');
});

test('alerts: one message per owner, one mention, truncated under 2000 chars', () => {
  const alice = { discord_id: '123456789012345678', name: 'alice' };
  const items = [{ email: 'abc***@gmail.com', label: '需要验证', hint: '去验证' }, { email: 'def***@gmail.com', label: '登录失效', hint: '重新添加' }];
  const m = ownerMessage(alice, items);
  assert.equal(m.match(/<@123456789012345678>/g)?.length, 1);
  assert.match(m, /2 个号/);
  assert.equal(m.split('\n').length, 3);
  assert.match(m, /abc\*\*\*@gmail\.com.*需要验证.*去验证/);
  assert.match(m, /def\*\*\*@gmail\.com.*登录失效/);
  // no real Discord id: bold name, no mention
  const bob = ownerMessage({ discord_id: 'local:bob', name: 'bob' }, items);
  assert.match(bob, /\*\*bob\*\*/);
  assert.doesNotMatch(bob, /<@/);
  assert.notEqual(bob, m);
  // recoveries combine too
  assert.match(ownerMessage(alice, items, true), /^✅ <@123456789012345678> 你的 2 个号恢复正常了\n· `abc/);
  assert.equal(ownerMessage(alice, items.slice(0, 1)), '⚠️ <@123456789012345678> 你的号 `abc***@gmail.com` **需要验证**\n去验证');
  // truncation
  const many = Array.from({ length: 40 }, (_, i) => ({ email: `u${i}***@gmail.com`, label: '可能被封', hint: 'Google 停用了这个账号，暂时没法用了'.repeat(2) }));
  const t = ownerMessage(alice, many);
  assert.ok(t.length <= 2000, String(t.length));
  const shown = t.split('\n').filter((l) => l.startsWith('· ')).length;
  assert.ok(shown > 5 && shown < 40);
  assert.ok(t.endsWith(`…还有 ${40 - shown} 个号`));
  assert.match(t, /你的 40 个号/);
});

test('alerts: grouped per owner across one run', () => {
  const alice = { discord_id: '123456789012345678', name: 'alice' }, bob = { discord_id: 'local:bob', name: 'bob' };
  const a = (owner_id: number, owner: object, auth_id: string, recovered = false) => ({ owner_id, owner, auth_id, email: auth_id + '***@x.io', label: '登录失效', hint: '重新添加', recovered });
  const posts = alertPosts([a(1, alice, 'a1'), a(2, bob, 'b1'), a(1, alice, 'a2'), a(1, alice, 'a3', true)]);
  assert.equal(posts.length, 3); // alice ✅, alice ⚠️, bob ⚠️
  const [ok, due, b] = posts;
  assert.match(ok.content, /^✅/);
  assert.deepEqual(ok.mention, []);
  assert.deepEqual(ok.authIds, []);
  assert.deepEqual(due.mention, ['123456789012345678']);
  assert.deepEqual(due.authIds, ['a1', 'a2']);
  assert.equal(due.content.match(/<@/g)?.length, 1);
  assert.deepEqual(b.mention, []);
  assert.deepEqual(b.authIds, ['b1']);
  assert.match(b.content, /\*\*bob\*\*/);
});

test('account watch: a flapping "Verify your account" pings once, turns the account off, no recovery spam', async () => {
  const { run, setSetting } = await import('../src/db.ts');
  const { checkAccounts } = await import('../src/bot.ts');
  const cpa = await import('../src/cpa.ts');
  setSetting('bot_channel_id', 'chan');
  setSetting('discord_bot_token', 'bot-token');
  run("INSERT INTO users(discord_id, name, handle, role, created_at) VALUES('111', 'owner', 'owner', 'user', 0)");
  run("INSERT INTO accounts(auth_id, email, owner_id, shared, created_at) VALUES('acc.json', 'flappy@gmail.com', (SELECT id FROM users WHERE discord_id = '111'), 1, 0)");
  const st = { status: 'error', message: '403 {"error":{"code":403,"message":"Verify your account to continue.","status":"PERMISSION_DENIED"}}', disabled: false };
  const posts: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('discord.com')) { posts.push(JSON.parse(init.body).content); return j({ id: '1' }); }
    if (u.includes('/credentials/status')) { st.disabled = JSON.parse(init.body).disabled; return j({ ok: true }); }
    if (u.includes('/credentials')) return j({ files: [{ id: 'acc.json', name: 'acc.json', auth_index: 'a1', type: 'antigravity', email: 'flappy@gmail.com', disabled: st.disabled,
      status: st.disabled ? 'disabled' : st.status, status_message: st.disabled ? '' : st.status === 'error' ? st.message : '', unavailable: false }] });
    return real(url, init);
  }) as typeof fetch;
  const age = (ms: number) => run('UPDATE bot_alerts SET since = since - ?, notified_at = notified_at - ?, cleared_at = cleared_at - ?', ms, ms, ms);
  const tick = async () => { await cpa.refreshCreds(); await checkAccounts(); };
  try {
    await tick();                       // seen: auto-disabled right away, grace starts
    assert.equal(st.disabled, true);
    assert.equal(posts.length, 0);
    age(11 * 60e3); await tick();       // after the grace: one ping
    assert.equal(posts.length, 1);
    assert.match(posts[0], /需要验证/);
    for (let i = 0; i < 3; i++) { age(60 * 60e3); await tick(); }
    assert.equal(posts.length, 1);      // stays off and reported, no repeats
    // someone re-enables it by hand while it still needs verification: CPA cools it down again -> no new ping today
    run('UPDATE accounts SET auto_disabled_at = NULL'); st.disabled = false; st.status = 'active'; await tick();
    st.status = 'error'; await tick(); age(11 * 60e3); await tick();
    assert.equal(posts.length, 1, posts.join('\n---\n'));
    // really fixed: gone for 30 minutes -> one ✅ (no mention)
    run('UPDATE accounts SET auto_disabled_at = NULL'); st.disabled = false; st.status = 'active';
    await tick(); age(10 * 60e3); await tick();
    assert.equal(posts.length, 1);
    age(31 * 60e3); await tick();
    assert.equal(posts.length, 2);
    assert.doesNotMatch(posts[1], /<@/);
    age(60 * 60e3); await tick();
    assert.equal(posts.length, 2);
  } finally { globalThis.fetch = real; }
});

test('/免打扰 users are never mentioned in alerts', async () => {
  const { run } = await import('../src/db.ts');
  run("INSERT INTO users(discord_id, name, handle, role, created_at, bot_quiet) VALUES('222333444', 'quiet', 'quiet', 'user', 0, 1)");
  const o = { discord_id: '222333444', name: 'quiet' };
  const [p] = alertPosts([{ owner_id: 9, owner: o, auth_id: 'q1', email: 'q***@x', label: '需要验证', hint: 'h' }]);
  assert.deepEqual(p.mention, []);
  assert.ok(!p.content.includes('<@'), p.content);
  assert.match(p.content, /quiet/);
});

test('usage watch: 3 failures in a row and a 500k+ input @ the caller once, with the reason', async () => {
  const { run, one, setSetting } = await import('../src/db.ts');
  const { watchUsage } = await import('../src/bot.ts');
  setSetting('bot_channel_id', 'chan'); setSetting('discord_bot_token', 'bot-token');
  run("INSERT INTO users(discord_id, name, handle, role, created_at) VALUES('555666777', 'streaky', 'streaky', 'user', 0)");
  const uid = one("SELECT id FROM users WHERE discord_id = '555666777'").id;
  const add = (ago: number, result: string, status: number, reason: string | null, inTok: number | null = null, inEst: number | null = null) =>
    run(`INSERT INTO usage(ts, user_id, key_id, pool, model, path, status, result, reason, latency_ms, in_tok, in_est) VALUES(?,?,1,'shared','gemini-3-flash','/v1/chat/completions',?,?,?,1,?,?)`,
      Date.now() - ago, uid, status, result, reason, inTok, inEst);
  const posts: { content: string; users: string[] }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (String(url).includes('discord.com')) { const b = JSON.parse(init.body); posts.push({ content: b.content, users: b.allowed_mentions.users }); return new Response('{"id":"1"}', { status: 200 }); }
    return real(url, init);
  }) as typeof fetch;
  try {
    setSetting('bot_watch_ts', String(Date.now() - 10 * 60e3));
    add(9 * 60e3, 'ok', 200, null);
    add(8 * 60e3, 'client', 400, '预填充（最后一条是 AI 消息）不支持');
    add(7 * 60e3, 'client', 499, '客户端断开');                    // not counted
    add(6 * 60e3, 'client', 400, '预填充（最后一条是 AI 消息）不支持');
    add(5 * 60e3, 'quota', 429, null, null, 620000);                // failed, but the estimate shows a huge input
    await watchUsage();
    assert.equal(posts.length, 2, JSON.stringify(posts));
    const big = posts.find((p) => p.content.includes('📏'))!, err = posts.find((p) => p.content.includes('🚨'))!;
    assert.match(big.content, /62 万 Token/);
    assert.match(err.content, /连续 \*\*3\*\* 次请求失败/);
    assert.match(err.content, /预填充.*（2 次）/);
    assert.match(err.content, /额度用完/);
    assert.deepEqual(err.users, ['555666777']);
    // same streak continues: quiet until 3 more failures, then told again
    add(4 * 60e3, 'client', 400, '预填充（最后一条是 AI 消息）不支持');
    await watchUsage();
    assert.equal(posts.length, 2);
    setSetting('bot_watch_ts', String(Date.now() - 4 * 60e3));
    add(3.5 * 60e3, 'client', 400, 'x'); add(3.2 * 60e3, 'client', 400, 'x');
    await watchUsage();
    assert.equal(posts.length, 3, JSON.stringify(posts));
    assert.match(posts[2].content, /连续 \*\*6\*\* 次/);
    // every huge input is reported, no cooldown
    setSetting('bot_watch_ts', String(Date.now() - 3 * 60e3));
    add(2.5 * 60e3, 'ok', 200, null, 700000);
    await watchUsage();
    assert.ok(posts.at(-1)!.content.includes('📏'), JSON.stringify(posts.at(-1)));
  } finally { globalThis.fetch = real; }
});

test('usage watch: 大锅饭 input-cap refusal @s the caller even with /免打扰', async () => {
  const { run, one, setSetting } = await import('../src/db.ts');
  const { watchUsage } = await import('../src/bot.ts');
  run("INSERT INTO users(discord_id, name, handle, role, created_at, bot_quiet) VALUES('888999000', 'capped', 'capped', 'user', 0, 1)");
  const uid = one("SELECT id FROM users WHERE discord_id = '888999000'").id;
  run(`INSERT INTO usage(ts, user_id, key_id, pool, model, path, status, result, reason, latency_ms, in_est) VALUES(?,?,1,'shared','m','/v1/chat/completions',400,'input_limit','输入过限：这次输入约 62 万 Token，超过了大锅饭的输入上限 50 万。',1,620000)`, Date.now() - 3 * 60e3, uid);
  setSetting('bot_watch_ts', String(Date.now() - 5 * 60e3));
  const posts: { content: string; users: string[] }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (String(url).includes('discord.com')) { const b = JSON.parse(init.body); posts.push({ content: b.content, users: b.allowed_mentions.users }); return new Response('{"id":"1"}', { status: 200 }); }
    return real(url, init);
  }) as typeof fetch;
  try {
    await watchUsage();
    const mine = posts.filter((p) => p.content.includes('<@888999000>'));
    assert.equal(mine.length, 1, JSON.stringify(posts));
    assert.match(mine[0].content, /大锅饭的输入上限/);
    assert.deepEqual(mine[0].users, ['888999000']);
  } finally { globalThis.fetch = real; }
});
