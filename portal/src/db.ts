import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'portal.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,             -- 'admin' | 'discord'
  default_pool TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL,
  last_login INTEGER,
  role_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- One row per CPA credential the portal knows about. auth_id = CPA auth ID (file name).
CREATE TABLE IF NOT EXISTS accounts (
  auth_id TEXT PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL DEFAULT '',
  shared INTEGER NOT NULL DEFAULT 0,
  proxy_id INTEGER UNIQUE REFERENCES proxies(id) ON DELETE SET NULL,
  suspended INTEGER NOT NULL DEFAULT 0, -- disabled in CPA by the portal because the owner was disabled
  quota_json TEXT,
  quota_at INTEGER,
  quota_err TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pool TEXT NOT NULL CHECK (pool IN ('private','shared')),
  key_hash TEXT NOT NULL UNIQUE,
  tail TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- One row per gateway request. Bodies are never stored.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  key_id INTEGER,
  pool TEXT NOT NULL,
  auth_id TEXT,
  owner_id INTEGER,
  model TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL,
  result TEXT NOT NULL,            -- ok | quota | no_account | upstream | blocked | rate_limited | client
  latency_ms INTEGER NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  request_id TEXT,
  in_tok INTEGER,
  out_tok INTEGER,
  total_tok INTEGER
);
CREATE INDEX IF NOT EXISTS usage_user_ts ON usage(user_id, ts);
CREATE INDEX IF NOT EXISTS usage_owner_ts ON usage(owner_id, ts);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_req ON usage(request_id);

CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_flows (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL,          -- JSON {authId: updated_at}
  status TEXT NOT NULL DEFAULT 'pending',
  auth_id TEXT,
  message TEXT
);
`);

// Password accounts (admin-created, no self sign-up). Their discord_id is 'local:<username>'.
if (!(db.prepare("SELECT name FROM pragma_table_info('users') WHERE name = 'pass_hash'").get())) {
  db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  db.exec('ALTER TABLE users ADD COLUMN pass_hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username) WHERE username IS NOT NULL');
}
if (!(db.prepare("SELECT name FROM pragma_table_info('api_keys') WHERE name = 'key_enc'").get())) db.exec('ALTER TABLE api_keys ADD COLUMN key_enc TEXT');
// Traffic log: cached input tokens (from the CPA usage queue) and time to first response byte.
if (!(db.prepare("SELECT name FROM pragma_table_info('usage') WHERE name = 'cache_tok'").get())) db.exec('ALTER TABLE usage ADD COLUMN cache_tok INTEGER');
if (!(db.prepare("SELECT name FROM pragma_table_info('usage') WHERE name = 'ttfb_ms'").get())) db.exec('ALTER TABLE usage ADD COLUMN ttfb_ms INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS usage_auth_ts ON usage(auth_id, ts)');
// Traffic log on CPA's real usage-queue fields (one queue record per upstream attempt).
const addCol = (table: string, col: string, type: string) => {
  if (!(db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`).get(col))) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
};
addCol('usage', 'requested_model', 'TEXT');   // CPA alias: what the client asked for
addCol('usage', 'upstream_model', 'TEXT');    // CPA model (or response_model when it differs)
addCol('usage', 'reasoning_tok', 'INTEGER');  // kept apart from out_tok
addCol('usage', 'cache_write_tok', 'INTEGER');
addCol('usage', 'attempts', 'INTEGER');       // number of queue records for this request_id
addCol('usage', 'cpa_ttft_ms', 'INTEGER');
addCol('usage', 'cpa_latency_ms', 'INTEGER');
addCol('usage', 'upstream_status', 'INTEGER'); // fail.status_code of the last failed attempt (bodies never stored)
addCol('usage', 'reasoning_effort', 'TEXT');
addCol('usage', 'reason', 'TEXT');            // short readable reason for a non-ok result
// Accounts the portal disabled itself after an upstream 403 (re-enabled automatically once they work again).
addCol('accounts', 'auto_disabled_at', 'INTEGER');
addCol('accounts', 'auto_disabled_reason', 'TEXT');
// Discord bot: one row per account with an open problem (see bot.ts).
db.exec(`CREATE TABLE IF NOT EXISTS bot_alerts (
  auth_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  since INTEGER NOT NULL,
  notified_at INTEGER
)`);
addCol('bot_alerts', 'cleared_at', 'INTEGER'); // problem not seen since then (a flap inside CLEAR_GRACE continues the episode)
addCol('bot_alerts', 'closed', 'INTEGER');     // episode over; the row stays so a relapse within REPING doesn't ping again
// Announcements (admin-written, shown to every user; users.ann_seen = newest id the user has seen).
db.exec(`CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',   -- info | important
  pinned INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
addCol('users', 'ann_seen', 'INTEGER');
// 大锅饭 daily request limit: NULL = rule default, -1 = unlimited, >= 0 = fixed per day.
addCol('users', 'daily_limit', 'INTEGER');
addCol('users', 'input_limit', 'INTEGER'); // 输入上限 in estimated tokens, NULL = off
// Per-account self-use reserve chosen by the owner when sharing (NULL = the admin's default rule).
addCol('accounts', 'reserve', 'INTEGER');
// External upstreams (Tools / Antigravity Manager) that take turns with the shared Google accounts.
db.exec(`CREATE TABLE IF NOT EXISTS upstreams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  owner_id INTEGER,
  created_at INTEGER NOT NULL
)`);
addCol('upstreams', 'models_allow', 'TEXT'); // JSON array of model ids this upstream may serve, NULL = all
// Per-user account rotation: stickiness mode and the salt mixed into session keys.
addCol('users', 'rotation_mode', 'TEXT');
addCol('users', 'session_salt', 'TEXT');

export type Row = Record<string, any>;

export function one(sql: string, ...params: any[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}
export function all(sql: string, ...params: any[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(k: string): string | undefined {
  return one('SELECT v FROM settings WHERE k = ?', k)?.v;
}
export function setSetting(k: string, v: string) {
  run('INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
}

export type Rules = { keyConc: number; keyRpm: number; accConc: number; reserve: number; dailyBase: number; dailyPer: number };
const DEFAULT_RULES: Rules = { keyConc: 8, keyRpm: 60, accConc: 2, reserve: 30, dailyBase: 200, dailyPer: 500 };
let rulesCache: Rules | null = null;
export function getRules(): Rules {
  if (rulesCache) return rulesCache;
  let r = DEFAULT_RULES;
  try {
    const raw = getSetting('rules');
    if (raw) r = { ...DEFAULT_RULES, ...JSON.parse(raw) };
  } catch {}
  rulesCache = r;
  return r;
}
export function setRules(r: Rules) {
  setSetting('rules', JSON.stringify(r));
  rulesCache = r;
}

export function now() {
  return Date.now();
}
