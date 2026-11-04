// Unit tests for account error details: verify / appeal link extraction, reason text, cooldowns. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAction, safeGoogleURL, errText, activeCooldowns } from '../src/accerr.ts';
import { mapCooldowns, mapCred } from '../src/cpa.ts';

const VURL = 'https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbs';
const verifyBody = (md: Record<string, string>) => JSON.stringify({ error: { code: 403, message: 'Verify your account to continue.', status: 'PERMISSION_DENIED',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'VALIDATION_REQUIRED', domain: 'cloudcode-pa.googleapis.com', metadata: md }] } });

test('extractAction: validation_url -> verify, appeal_url -> appeal', () => {
  assert.deepEqual(extractAction(verifyBody({ validation_url: VURL })), { kind: 'verify', url: VURL });
  assert.deepEqual(extractAction(verifyBody({ appeal_url: 'https://support.google.com/accounts/contact/disabled2' })), { kind: 'appeal', url: 'https://support.google.com/accounts/contact/disabled2' });
  // Google sometimes answers with an array of errors
  assert.equal(extractAction('[' + verifyBody({ validation_url: VURL }) + ']')?.url, VURL);
  // status prefix as in quota_err / probe text
  assert.equal(extractAction('403 ' + verifyBody({ validation_url: VURL }))?.kind, 'verify');
});

test('extractAction: escaped JSON (body inside a string, \\u0026 / \\/ escapes)', () => {
  const inner = verifyBody({ validation_url: VURL });
  // CPA wraps the upstream body as a string inside its own error
  assert.equal(extractAction(JSON.stringify({ error: { message: inner } }))?.url, VURL);
  // Go-style escaping, not valid as the outer JSON (cut off at the end) -> regex fallback
  const goEsc = '{"error":{"message":"' + inner.replace(/"/g, '\\"').replace(/&/g, '\\u0026').replace(/\//g, '\\/') + '"}';
  assert.equal(extractAction(goEsc.slice(0, goEsc.length - 1))?.url, VURL);
  // HTML-escaped ampersands in plain text
  assert.equal(extractAction('validation_url: https://accounts.google.com/x?a=1&amp;b=2 more')?.url, 'https://accounts.google.com/x?a=1&b=2');
});

test('extractAction: non-Google hosts and non-https links are rejected', () => {
  assert.equal(extractAction(verifyBody({ validation_url: 'https://evil.example/accounts.google.com' })), null);
  assert.equal(extractAction(verifyBody({ validation_url: 'https://accounts.google.com.evil.example/' })), null);
  assert.equal(extractAction(verifyBody({ validation_url: 'http://accounts.google.com/x' })), null);
  assert.equal(extractAction(verifyBody({ validation_url: 'javascript:alert(1)' })), null);
  assert.equal(extractAction(verifyBody({ validation_url: 'https://user:pw@accounts.google.com/' })), null);
  assert.equal(extractAction('"validation_url": "https://evil.example/"'), null);
  assert.equal(safeGoogleURL('https://goo.gl/abc'), 'https://goo.gl/abc');
  assert.equal(safeGoogleURL('https://cloudcode-pa.googleapis.com/x'), 'https://cloudcode-pa.googleapis.com/x');
  assert.equal(safeGoogleURL('https://notgoogle.com/'), null);
});

test('extractAction: truncated or garbage input', () => {
  assert.equal(extractAction(''), null);
  assert.equal(extractAction(null), null);
  assert.equal(extractAction('<html>502 Bad Gateway</html>'), null);
  assert.equal(extractAction('{"error":{"code":403,"message":"Verify your account"}}'), null); // no link at all
  assert.equal(extractAction('{"error":{"details":[{"metadata":{"validation_url":"https://acc'), null); // cut inside the host
  assert.equal(extractAction('{"error":{"details":[{"metadata":{"validation_url":'), null);
  assert.equal(extractAction('validation_url{{{]]]'), null);
});

test('errText: CPA reasons and status codes in plain Chinese', () => {
  assert.equal(errText('payment_required'), 'Google 拒绝访问 (403)');
  assert.equal(errText('unauthorized'), '登录失效 (401)');
  assert.equal(errText('invalid_grant'), '授权已失效，需要重新登录');
  assert.equal(errText('quota exhausted'), '额度用完 (429)');
  assert.equal(errText('transient upstream error', 503), '上游临时故障 (503)');
  assert.equal(errText('not_found'), '模型不可用 (404)');
  assert.equal(errText('cloudflare challenge'), '被 Cloudflare 拦截');
  assert.equal(errText('VALIDATION_REQUIRED'), '需要验证账号');
  assert.equal(errText('', 429), '额度用完 (429)');
  assert.equal(errText('', 403), 'Google 拒绝访问 (403)');
  assert.equal(errText('something odd happened'), 'something odd happened');
  assert.equal(errText(''), '');
});

test('cooldowns: CPA fields normalized, only future ones shown, soonest first', () => {
  const t = Date.now();
  const raw = [
    { scope: 'model', model_key: 'claude-sonnet-4-6', reason: 'quota exhausted', retry_at: new Date(t + 30 * 60e3).toISOString(), remaining_seconds: 1800, backoff_level: 2, http_status: 429 },
    { scope: 'model', model_key: 'gemini-3-pro-high', reason: 'transient upstream error', retry_at: new Date(t + 5 * 60e3).toISOString(), remaining_seconds: 300, http_status: 503 },
    { scope: 'auth', reason: 'unauthorized', retry_at: new Date(t - 60e3).toISOString(), remaining_seconds: 0, http_status: 401 }, // expired
    null, 'junk',
  ];
  const cds = mapCooldowns(raw);
  assert.equal(cds.length, 3);
  assert.deepEqual({ ...cds[0], retryAt: null }, { scope: 'model', model: 'claude-sonnet-4-6', reason: 'quota exhausted', retryAt: null, remainingSeconds: 1800, backoffLevel: 2, httpStatus: 429 });
  assert.equal(cds[1].backoffLevel, null);
  assert.deepEqual(mapCooldowns(null), []);
  // no retry_at: derived from remaining_seconds
  assert.ok(Date.parse(mapCooldowns([{ scope: 'auth', reason: 'x', remaining_seconds: 60 }])[0].retryAt!) > t);

  const v = activeCooldowns(cds, t);
  assert.deepEqual(v.map((x) => [x.model, x.text, x.status]), [['gemini-3-pro-high', '上游临时故障 (503)', 503], ['claude-sonnet-4-6', '额度用完 (429)', 429]]);

  const c = mapCred({ id: 'a.json', cooldowns: raw, success: '12', failed: 3, last_refresh: '2026-11-04T00:00:00Z' });
  assert.equal(c.cooldowns.length, 3);
  assert.equal(c.success, 12);
  assert.equal(c.failed, 3);
  assert.equal(c.lastRefresh, '2026-11-04T00:00:00Z');
  assert.deepEqual(mapCred({ id: 'b.json' }).cooldowns, []);
});

test('extractAction: real ToS body with a forms.gle appeal link', () => {
  const body = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TOS_VIOLATION', metadata: { uiMessage: 'true', appeal_url: 'https://forms.gle/hGzM9MEUv2azZsrb9', appeal_url_link_text: 'Submit Appeal' } }] } });
  assert.deepEqual(extractAction(body), { kind: 'appeal', url: 'https://forms.gle/hGzM9MEUv2azZsrb9' });
});
