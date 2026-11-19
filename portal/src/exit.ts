import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { config } from './config.ts';
import { one, all, run, tx, now, getSetting, setSetting } from './db.ts';
import { HttpError, token } from './util.ts';
import * as aistudio2 from './aistudio2.ts';
import * as fun from './fun.ts';
import { fetchAndFilterUsNodes, assertSafeUrl, isValidNodeTarget, type ParsedProxy } from './subparse.ts';
import { checkProxyPurity } from './purity.ts';

export type ExitNode = {
  id: string;
  name: string;
  airport: string;
  port: number;
  ip: string;
  proxyUrl: string;
  group: string;
  vip?: boolean;
};

export type ExitAccount = {
  kind: 'ais2';
  id: string;
  label: string;
  active: boolean;
  state: string;
  nodeId: string;
};

const MIHOMO_API = 'http://127.0.0.1:19091';
const MIHOMO_DIR = '/opt/mihomo-exit';
const MIHOMO_USER_YAML = '/opt/mihomo-exit/user-nodes.yaml';
const MIHOMO_CFG_YAML = '/opt/mihomo-exit/config.yaml';
const MIHOMO_BASE_YAML = '/opt/mihomo-exit/config.base.yaml';
const MAX_PUBLIC_NODES = 20;
const MAX_USER_NODES = 3;
const delayCache = new Map<string, number>();

export const isExitEnabled = () => getSetting('exit_enabled') !== '0';
export const isVipAccount = (email: string) => { if (!isExitEnabled()) return false; const r = one("SELECT node_id FROM exit_bindings WHERE kind = 'ais2' AND lower(acc_id) = ?", String(email || '').trim().toLowerCase()); return !!(r && loadNodes().some((n) => !!n.vip && n.id === r.node_id)); };
export const isVipProxyUrl = (proxyUrl: string) => !!proxyUrl && loadNodes().some((n) => !!n.vip && n.proxyUrl === proxyUrl);

let _nodesCache: { at: number; mtime: number; list: ExitNode[] } = { at: 0, mtime: -1, list: [] };
export function loadNodes(): ExitNode[] {
  const file = join(config.dataDir, 'exit-nodes.json');
  if (!existsSync(file)) return [];
  const t = Date.now();
  if (t - _nodesCache.at < 2000 && _nodesCache.mtime >= 0) return _nodesCache.list;
  try {
    const mt = statSync(file).mtimeMs;
    if (mt === _nodesCache.mtime) { _nodesCache.at = t; return _nodesCache.list; }
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw.slice(0, MAX_PUBLIC_NODES) : [];
    _nodesCache = { at: t, mtime: mt, list };
    return list;
  } catch {
    return [];
  }
}

const DELAY_TTL_MS = 10 * 60_000;
let delayAt = 0;
let delayInflight: Promise<any> | null = null;
async function fetchMihomoDelays(nodes: ExitNode[]): Promise<void> {
  const missing = nodes.some((n) => !delayCache.has(n.id));
  if (!missing && Date.now() - delayAt < DELAY_TTL_MS) return;
  if (!delayInflight) {
    delayInflight = testNodes().catch(() => {}).finally(() => { delayInflight = null; delayAt = Date.now(); });
  }
  if (delayAt === 0 || missing) {
    await Promise.race([delayInflight, new Promise((r) => setTimeout(r, 3800))]);
  }
}

export function triggerPublicDelayTest() {
  const nodes = loadNodes();
  const missing = nodes.some((n) => !delayCache.has(n.id));
  if (delayInflight) return { ok: true, fresh: false, running: true, delayAt };
  if (!missing && delayAt > 0 && Date.now() - delayAt < DELAY_TTL_MS) {
    return { ok: true, fresh: true, running: false, delayAt };
  }
  delayInflight = testNodes().finally(() => { delayInflight = null; delayAt = Date.now(); });
  void delayInflight;
  return { ok: true, fresh: false, started: true, delayAt };
}

export async function testNodes() {
  const nodes = loadNodes();
  await Promise.all(nodes.map(async (n) => {
    const u = `${MIHOMO_API}/proxies/${encodeURIComponent(n.group)}/delay?url=${encodeURIComponent('http://www.gstatic.com/generate_204')}&timeout=3500`;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) { delayCache.set(n.id, -1); return; }
      const j: any = await r.json();
      delayCache.set(n.id, typeof j?.delay === 'number' && j.delay > 0 ? j.delay : -1);
    } catch {
      delayCache.set(n.id, -1);
    }
  }));
  delayAt = Date.now();
  return nodes.map((n) => ({ id: n.id, delay: delayCache.get(n.id) ?? -1 }));
}

function resolveProxyUrl(nodeId: string, nodes: ExitNode[], userId?: number): string | null {
  if (!nodeId) return '';
  if (nodeId.startsWith('usr:')) {
    const uid = Number(nodeId.slice(4));
    if (!Number.isInteger(uid) || uid <= 0 || pendingNodeIds.has(uid)) return null;
    const row = userId != null
      ? one('SELECT proxy_url FROM user_exit_nodes WHERE id = ? AND user_id = ?', uid, userId)
      : one('SELECT proxy_url FROM user_exit_nodes WHERE id = ?', uid);
    return row ? String(row.proxy_url) : null;
  }
  const pub = nodes.find((n) => n.id === nodeId);
  return pub ? pub.proxyUrl : null;
}

/** Normalize exit_bindings.acc_id -> lowercase email map so admin (email) and user (ais2_*) stay 100% aligned. */
function loadSavedAIS2Bindings(): Map<string, string> {
  const idToEmail = new Map<string, string>();
  for (const a of all('SELECT account_id, email FROM aistudio2_accounts')) {
    idToEmail.set(String(a.account_id), String(a.email).trim().toLowerCase());
  }
  const saved = new Map<string, string>();
  for (const r of all("SELECT acc_id, node_id FROM exit_bindings WHERE kind = 'ais2'")) {
    const rawKey = String(r.acc_id).trim();
    const em = aistudio2.isAIS2(rawKey) ? (idToEmail.get(rawKey) || rawKey.toLowerCase()) : rawKey.toLowerCase();
    saved.set(em, String(r.node_id));
  }
  return saved;
}

let mihomoSync = Promise.resolve();
let savingSubscription = false;
const pendingNodeIds = new Set<number>();

function requirePrivateListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '172.17.0.1', port });
    socket.setTimeout(1500, () => socket.destroy(new Error('Mihomo listener timeout')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
  });
}

async function reloadMihomo(): Promise<void> {
  const response = await fetch(MIHOMO_API + '/configs?force=true', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: MIHOMO_CFG_YAML }),
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Mihomo reload HTTP ' + response.status);
}

function reportMihomoSyncError(error: unknown) {
  console.error('[exit] Mihomo configuration sync failed:', (error as Error).message);
}

export function syncUserNodesToMihomo() {
  void queueMihomoSync().catch(reportMihomoSyncError);
}

function queueMihomoSync(createdPorts: number[] = []): Promise<void> {
  const next = mihomoSync.then(() => applyMihomoConfig(createdPorts));
  mihomoSync = next.catch(() => {});
  return next;
}

async function applyMihomoConfig(createdPorts: number[]) {
  if (createdPorts.length && !existsSync(MIHOMO_BASE_YAML)) {
    throw new Error('Missing Mihomo base configuration');
  }
  const rows = all("SELECT id, name, config_json, port FROM user_exit_nodes WHERE kind = 'mihomo' AND port IS NOT NULL ORDER BY id");
  const proxies: string[] = [];
  const listeners: string[] = [];
  for (const r of rows) {
    let cfg: Record<string, any>;
    try { cfg = JSON.parse(String(r.config_json || '{}')); } catch { continue; }
    if (!cfg || typeof cfg !== 'object' || !isValidNodeTarget(String(cfg.server || ''), Number(cfg.port))) continue;
    const pname = `U${r.id}`;
    const proxyObj = { ...cfg, name: pname };
    proxies.push(`  - ${JSON.stringify(proxyObj)}`);
    listeners.push(`  - ${JSON.stringify({ name: `L${r.port}`, type: 'mixed', port: Number(r.port), listen: '172.17.0.1', udp: true, proxy: pname })}`);
  }
  const yaml = [
    '# auto-generated by agy-pot',
    proxies.length ? 'proxies:\n' + proxies.join('\n') : 'proxies: []',
    listeners.length ? 'listeners:\n' + listeners.join('\n') : 'listeners: []',
    '',
  ].join('\n');
  writeFileSync(join(config.dataDir, 'user-nodes.yaml'), yaml);
  if (existsSync(MIHOMO_DIR)) {
    writeFileSync(MIHOMO_USER_YAML, yaml);
    if (!existsSync(MIHOMO_BASE_YAML) && existsSync(MIHOMO_CFG_YAML)) {
      writeFileSync(MIHOMO_BASE_YAML, readFileSync(MIHOMO_CFG_YAML, 'utf8'));
    }
    if (existsSync(MIHOMO_BASE_YAML)) {
      let merged = readFileSync(MIHOMO_BASE_YAML, 'utf8');
      if (listeners.length) {
        if (/^listeners\s*:\s*\[\]\s*(?:#.*)?$/m.test(merged)) {
          merged = merged.replace(/^listeners\s*:\s*\[\]\s*(?:#.*)?$/m, () => 'listeners:\n' + listeners.join('\n'));
        } else if (/^listeners\s*:\s*(?:#.*)?$/m.test(merged)) {
          merged = merged.replace(/^listeners\s*:\s*(?:#.*)?$/m, (m) => m + '\n' + listeners.join('\n'));
        } else {
          merged = merged.trimEnd() + '\n\nlisteners:\n' + listeners.join('\n') + '\n';
        }
      }
      if (proxies.length) {
        if (/^proxies\s*:\s*\[\]\s*(?:#.*)?$/m.test(merged)) {
          merged = merged.replace(/^proxies\s*:\s*\[\]\s*(?:#.*)?$/m, () => 'proxies:\n' + proxies.join('\n'));
        } else if (/^proxies\s*:\s*(?:#.*)?$/m.test(merged)) {
          merged = merged.replace(/^proxies\s*:\s*(?:#.*)?$/m, (m) => m + '\n' + proxies.join('\n'));
        } else {
          merged = merged.trimEnd() + '\n\nproxies:\n' + proxies.join('\n') + '\n';
        }
      }
      const previous = existsSync(MIHOMO_CFG_YAML) ? readFileSync(MIHOMO_CFG_YAML, 'utf8') : readFileSync(MIHOMO_BASE_YAML, 'utf8');
      if (existsSync(MIHOMO_CFG_YAML) && merged === previous && !createdPorts.length) return;
      const writeConfig = (content: string) => {
        writeFileSync(MIHOMO_CFG_YAML + '.tmp', content, { mode: 0o640 });
        renameSync(MIHOMO_CFG_YAML + '.tmp', MIHOMO_CFG_YAML);
      };
      writeConfig(merged);
      try {
        await reloadMihomo();
        await Promise.all(createdPorts.map(requirePrivateListener));
      } catch (error) {
        writeConfig(previous);
        await reloadMihomo().catch(reportMihomoSyncError);
        throw error;
      }
    }
  }
}

// ---------- User subscription preview / save / direct proxy ----------
const subCache = new Map<string, { userId: number; at: number; us: ParsedProxy[] }>();

export async function previewSubscription(userId: number, rawUrl: string) {
  for (const [k, v] of subCache) if (now() - v.at > 600000) subCache.delete(k);
  let res: { total: number; us: ParsedProxy[] };
  try {
    res = await fetchAndFilterUsNodes(rawUrl);
  } catch (e) {
    throw new HttpError(400, 'sub_error', (e as Error).message);
  }
  const parseId = token(12);
  subCache.set(parseId, { userId, at: now(), us: res.us });
  return {
    parseId,
    total: res.total,
    usCount: res.us.length,
    nodes: res.us.map((p, idx) => ({ idx, name: p.name, type: p.type, server: p.server, port: p.port })),
  };
}

function allocUserPort(): number {
  const used = new Set(all('SELECT port FROM user_exit_nodes WHERE port IS NOT NULL').map((r) => Number(r.port)));
  for (let p = 22101; p <= 22299; p++) if (!used.has(p)) return p;
  throw new HttpError(400, 'no_port', '私有分流端口已满');
}

export async function saveSubscriptionNodes(userId: number, parseId: string, indices: number[]) {
  const cached = subCache.get(parseId);
  if (!cached || cached.userId !== userId || now() - cached.at > 600000) {
    throw new HttpError(400, 'expired', '解析结果已过期，请重新拉取订阅');
  }
  const uniq = [...new Set(indices.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < cached.us.length))];
  if (!uniq.length) throw new HttpError(400, 'empty', '请至少选择一个节点');
  const preExisting = Number(one('SELECT COUNT(*) AS n FROM user_exit_nodes WHERE user_id = ?', userId)?.n || 0);
  if (preExisting + uniq.length > MAX_USER_NODES) {
    throw new HttpError(400, 'too_many_nodes', `每人最多保存 ${MAX_USER_NODES} 个私有节点（当前已有 ${preExisting} 个）`);
  }
  for (const idx of uniq) {
    const p = cached.us[idx];
    if (!isValidNodeTarget(p.server, p.port)) {
      throw new HttpError(400, 'invalid_node', `节点 ${p.name} 地址无效或指向内网`);
    }
    try {
      await assertSafeUrl(`http://${p.server.includes(':') ? '[' + p.server + ']' : p.server}:${p.port}`);
    } catch (e) {
      throw new HttpError(400, 'invalid_node', `节点 ${p.name} 校验未通过：${(e as Error).message}`);
    }
  }
  if (savingSubscription) throw new HttpError(409, 'node_save_busy', '正在加载另一批节点，请稍后重试');
  if (subCache.get(parseId) !== cached) throw new HttpError(400, 'expired', '解析结果已使用，请重新拉取订阅');
  savingSubscription = true;
  try {
    const created = tx(() => {
      const existing = Number(one('SELECT COUNT(*) AS n FROM user_exit_nodes WHERE user_id = ?', userId)?.n || 0);
      if (existing + uniq.length > MAX_USER_NODES) {
        throw new HttpError(400, 'too_many_nodes', `每人最多保存 ${MAX_USER_NODES} 个私有节点（当前已有 ${existing} 个）`);
      }
      const nodes: { id: number; port: number }[] = [];
      for (const idx of uniq) {
        const p = cached.us[idx];
        const port = allocUserPort();
        const proxyUrl = `socks5://172.17.0.1:${port}`;
        const r = run(
          'INSERT INTO user_exit_nodes(user_id, name, kind, config_json, port, proxy_url, created_at) VALUES(?,?,?,?,?,?,?)',
          userId, p.name.slice(0, 80), 'mihomo', JSON.stringify(p), port, proxyUrl, now(),
        );
        nodes.push({ id: Number(r.lastInsertRowid), port });
      }
      return nodes;
    });
    for (const { id } of created) pendingNodeIds.add(id);
    try {
      await queueMihomoSync(created.map(({ port }) => port));
    } catch (error) {
      tx(() => {
        for (const { id } of created) run('DELETE FROM user_exit_nodes WHERE id = ?', id);
      });
      await queueMihomoSync().catch(reportMihomoSyncError);
      reportMihomoSyncError(error);
      throw new HttpError(502, 'node_load_failed', '代理引擎未能加载所选节点，节点未保存，请换节点后重试');
    } finally {
      for (const { id } of created) pendingNodeIds.delete(id);
    }
    subCache.delete(parseId);
    probeNodesInBackground(userId, created.map((x) => x.id));
    return { ok: true, count: created.length };
  } finally {
    savingSubscription = false;
  }
}

function probeNodesInBackground(userId: number, ids: number[]) {
  void (async () => {
    for (const id of ids) {
      try {
        const row = one('SELECT proxy_url FROM user_exit_nodes WHERE id = ? AND user_id = ?', id, userId);
        if (!row?.proxy_url) continue;
        const purity = await checkProxyPurity(String(row.proxy_url));
        run('UPDATE user_exit_nodes SET purity_json = ? WHERE id = ? AND user_id = ?', JSON.stringify(purity), id, userId);
      } catch {}
    }
  })();
}

export async function addDirectProxy(userId: number, name: string, rawProxy: string) {

  const trimmed = rawProxy.trim();
  if (!trimmed || trimmed.length > 500) throw new HttpError(400, 'invalid_proxy', '代理地址长度无效');
  let u: URL;
  try { u = new URL(trimmed); } catch { throw new HttpError(400, 'invalid_proxy', '代理地址格式无效，例如 socks5://user:pass@ip:port'); }
  if (!['socks5:', 'http:'].includes(u.protocol)) {
    throw new HttpError(400, 'invalid_proxy', '只支持 socks5:// 或 http:// 代理');
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new HttpError(400, 'invalid_proxy', '代理地址不能包含路径或参数');
  }
  const portNum = Number(u.port);
  if (!u.port || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new HttpError(400, 'invalid_proxy', '请填写有效的代理端口（1–65535）');
  }
  try {
    await assertSafeUrl('http://' + u.host);
  } catch (e) {
    throw new HttpError(400, 'invalid_proxy', (e as Error).message);
  }
  const auth = u.username
    ? `${encodeURIComponent(decodeURIComponent(u.username))}${u.password ? ':' + encodeURIComponent(decodeURIComponent(u.password)) : ''}@`
    : '';
  const cleanUrl = `${u.protocol}//${auth}${u.hostname}:${portNum}`;
  const hostPlain = u.hostname.replace(/^\[|\]$/g, '');
  const label = (name || '').trim().slice(0, 60) || `${hostPlain}:${portNum}`;
  const saved = tx(() => {
    const existing = Number(one('SELECT COUNT(*) AS n FROM user_exit_nodes WHERE user_id = ?', userId)?.n || 0);
    if (existing >= MAX_USER_NODES) throw new HttpError(400, 'too_many_nodes', `每人最多保存 ${MAX_USER_NODES} 个私有节点`);
    const r = run(
      'INSERT INTO user_exit_nodes(user_id, name, kind, config_json, port, proxy_url, created_at) VALUES(?,?,?,?,?,?,?)',
      userId, label, 'direct', JSON.stringify({ server: hostPlain, port: String(portNum) }), null, cleanUrl, now(),
    );
    return { id: Number(r.lastInsertRowid) };
  });
  probeNodesInBackground(userId, [saved.id]);
  return saved;
}

export async function deleteUserNode(userId: number, id: number) {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'not_found');
  if (pendingNodeIds.has(id)) throw new HttpError(409, 'node_save_busy', '节点正在加载，请稍后重试');
  const row = one('SELECT id FROM user_exit_nodes WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new HttpError(404, 'not_found');
  const nodeKey = 'usr:' + id;
  for (const b of all('SELECT acc_id FROM exit_bindings WHERE kind = ? AND node_id = ?', 'ais2', nodeKey)) {
    try { if (isExitEnabled()) await aistudio2.setAccountProxy(String(b.acc_id), ''); } catch {}
  }
  run('DELETE FROM exit_bindings WHERE kind = ? AND node_id = ?', 'ais2', nodeKey);
  run('DELETE FROM user_exit_nodes WHERE id = ? AND user_id = ?', id, userId);
  syncUserNodesToMihomo();
  return { ok: true };
}

export function listUserNodes(userId: number) {
  return all('SELECT id, name, kind, config_json, port, purity_json, created_at FROM user_exit_nodes WHERE user_id = ? ORDER BY id', userId).filter((r) => !pendingNodeIds.has(Number(r.id))).map((r) => {
    let server = '';
    let purity: any = null;
    try { server = String(JSON.parse(String(r.config_json || '{}')).server || ''); } catch {}
    try { if (r.purity_json) purity = JSON.parse(String(r.purity_json)); } catch {}
    return { id: Number(r.id), nodeId: 'usr:' + r.id, name: String(r.name), kind: String(r.kind), server, port: r.port ? Number(r.port) : null, purity, created: Number(r.created_at) };
  });
}

const checkCooldown = new Map<number, number>();
export async function checkUserNodePurity(userId: number, id: number) {
  const prevAt = checkCooldown.get(userId) || 0;
  if (now() - prevAt < 5000) throw new HttpError(429, 'too_fast', '检测太频繁，请 5 秒后再试');
  checkCooldown.set(userId, now());
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'not_found');
  const row = one('SELECT id, proxy_url FROM user_exit_nodes WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new HttpError(404, 'not_found');
  const purity = await checkProxyPurity(String(row.proxy_url));
  run('UPDATE user_exit_nodes SET purity_json = ? WHERE id = ? AND user_id = ?', JSON.stringify(purity), id, userId);
  return { id, purity };
}

// ---------- User-facing overview & self-bind ----------
export async function getUserExits(userId: number) {
  const nodes = loadNodes();
  await fetchMihomoDelays(nodes);
  const byUrl = new Map(nodes.map((n) => [n.proxyUrl, n.id]));
  const saved = loadSavedAIS2Bindings();

  const rawByEmail = new Map<string, { proxy?: string }>();
  if (aistudio2.aistudio2On()) {
    try {
      for (const a of await aistudio2.listRawAccounts()) {
        rawByEmail.set(a.id.toLowerCase(), a);
      }
    } catch {}
  }

  const pubCnt = new Map<string, number>();
  for (const a of all("SELECT email FROM aistudio2_accounts WHERE status = 'valid'")) {
    const em = String(a.email).trim().toLowerCase();
    const raw = rawByEmail.get(em);
    const nid = saved.get(em) || (raw?.proxy && byUrl.get(raw.proxy)) || '';
    if (nid && !nid.startsWith('usr:')) pubCnt.set(nid, (pubCnt.get(nid) || 0) + 1);
  }

  const userNodes = listUserNodes(userId);
  const myAccs = all('SELECT account_id, email, label, status FROM aistudio2_accounts WHERE owner_id = ? ORDER BY created_at', userId);
  return {
    enabled: isExitEnabled(),
    maxUserNodes: MAX_USER_NODES,
    vipQuota: Number(one('SELECT vip_quota FROM users WHERE id = ?', userId)?.vip_quota || 0),
    vipRate: 20,
    ...fun.peekWallet(userId),
    publicNodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      airport: n.airport,
      ip: n.ip,
      delay: delayCache.has(n.id) ? delayCache.get(n.id)! : null,
      count: pubCnt.get(n.id) || 0,
      vip: !!n.vip,
    })),
    userNodes,
    accounts: myAccs.map((a) => {
      const id = String(a.account_id);
      const em = String(a.email).trim().toLowerCase();
      const raw = rawByEmail.get(em);
      const nodeId = saved.get(em) || (raw?.proxy && byUrl.get(raw.proxy)) || '';
      return { id, label: String(a.label || a.email || id), status: String(a.status), nodeId };
    }),
  };
}

export async function bindUserAccount(userId: number, accId: string, nodeId: string) {
  const cleanId = accId.trim();
  const own = one(
    'SELECT account_id, email, status FROM aistudio2_accounts WHERE (account_id = ? OR lower(email) = ?) AND owner_id = ?',
    cleanId, cleanId.toLowerCase(), userId,
  );
  if (!own) throw new HttpError(404, 'not_found', '账号不存在或无权操作');
  const email = String(own.email).trim().toLowerCase();
  const nodes = loadNodes();
  const proxyUrl = resolveProxyUrl(nodeId, nodes, userId);
  if (proxyUrl === null) throw new HttpError(400, 'invalid_node', '节点不存在或无权使用');
  if (nodeId && nodes.some((n) => n.id === nodeId && n.vip)) {
    const vq = Number(one('SELECT vip_quota FROM users WHERE id = ?', userId)?.vip_quota || 0);
    if (vq <= 0) throw new HttpError(400, 'vip_quota_empty', 'VIP 节点次数不足，请先前往游乐场用 20 🦴 兑换');
  }
  if (isExitEnabled()) {
    try {
      await aistudio2.setAccountProxy(email, proxyUrl);
    } catch (e) {
      if (!(own.status !== 'valid' && e instanceof HttpError && e.status === 404)) throw e;
    }
  }
  tx(() => {
    run('DELETE FROM exit_bindings WHERE kind = ? AND (acc_id = ? OR lower(acc_id) = ?)', 'ais2', String(own.account_id), email);
    if (nodeId) {
      run('INSERT OR REPLACE INTO exit_bindings (kind, acc_id, node_id, updated_at) VALUES (?, ?, ?, ?)', 'ais2', email, nodeId, now());
    }
  });
  return { ok: true, nodeId };
}

// ---------- Admin overview & management ----------
export async function getOverview() {
  const nodes = loadNodes();
  await fetchMihomoDelays(nodes);

  const byUrl = new Map(nodes.map((n) => [n.proxyUrl, n.id]));
  const saved = loadSavedAIS2Bindings();

  const accounts: ExitAccount[] = [];
  if (aistudio2.aistudio2On()) {
    try {
      const ownedEmails = new Set(all('SELECT lower(email) AS em FROM aistudio2_accounts').map((r) => String(r.em || '')));
      const list = await aistudio2.listRawAccounts();
      for (const a of list) {
        const em = a.id.trim().toLowerCase();
        if (!ownedEmails.has(em)) continue;
        const matched = saved.get(em) || (a.proxy && byUrl.get(a.proxy)) || '';
        accounts.push({
          kind: 'ais2',
          id: a.id,
          label: a.label || a.id,
          active: a.enabled,
          state: !a.enabled ? 'disabled' : (a.state === 'ready' || a.state === 'ok' ? 'ok' : a.state || 'ok'),
          nodeId: matched,
        });
      }
    } catch {}
  }

  const ais2Cnt = new Map<string, number>();
  for (const a of accounts) {
    if (!a.nodeId || a.nodeId.startsWith('usr:')) continue;
    ais2Cnt.set(a.nodeId, (ais2Cnt.get(a.nodeId) || 0) + 1);
  }

  return {
    enabled: isExitEnabled(),
    nodes: nodes.map((n) => ({
      ...n,
      delay: delayCache.has(n.id) ? delayCache.get(n.id)! : null,
      cpaCount: 0,
      ais2Count: ais2Cnt.get(n.id) || 0,
    })),
    accounts,
  };
}

export async function bindAccount(kind: 'ais2', id: string, nodeId: string) {
  if (kind !== 'ais2') throw new HttpError(400, 'invalid_kind');
  const cleanId = id.trim();
  const row = aistudio2.isAIS2(cleanId)
    ? one('SELECT account_id, email FROM aistudio2_accounts WHERE account_id = ?', cleanId)
    : one('SELECT account_id, email FROM aistudio2_accounts WHERE lower(email) = ?', cleanId.toLowerCase());
  const email = row ? String(row.email).trim().toLowerCase() : cleanId.toLowerCase();
  const nodes = loadNodes();
  const proxyUrl = resolveProxyUrl(nodeId, nodes);
  if (proxyUrl === null) throw new HttpError(400, 'invalid_node', '节点不存在');
  if (isExitEnabled()) {
    await aistudio2.setAccountProxy(email, proxyUrl);
  }
  if (row) {
    run('DELETE FROM exit_bindings WHERE kind = ? AND acc_id = ?', 'ais2', String(row.account_id));
  }
  if (nodeId) {
    run('INSERT OR REPLACE INTO exit_bindings (kind, acc_id, node_id, updated_at) VALUES (?, ?, ?, ?)', kind, email, nodeId, now());
  } else {
    run('DELETE FROM exit_bindings WHERE kind = ? AND lower(acc_id) = ?', kind, email);
  }
  return { ok: true, nodeId };
}

export async function setEnabled(enabled: boolean) {
  setSetting('exit_enabled', enabled ? '1' : '0');
  const nodes = loadNodes();
  const saved = loadSavedAIS2Bindings();
  let synced = 0;
  for (const [email, nid] of saved) {
    const url = enabled ? (resolveProxyUrl(nid, nodes) || '') : '';
    try {
      await aistudio2.setAccountProxy(email, url);
      synced++;
    } catch {}
  }
  return { ok: true, enabled, synced };
}

export async function autoDistribute(scope: 'all' | 'unbound' = 'all') {
  const ov = await getOverview();
  const pubNodes = ov.nodes.filter((n) => !n.vip);
  const healthy = pubNodes.filter((n) => n.delay === null || n.delay > 0);
  const pool = healthy.length ? healthy : pubNodes;
  if (!pool.length) throw new HttpError(400, 'no_nodes', '没有可用的公共节点');

  const counts = new Map<string, number>(pool.map((n) => [n.id, 0]));
  if (scope === 'unbound') {
    for (const a of ov.accounts) {
      if (a.nodeId && counts.has(a.nodeId)) counts.set(a.nodeId, counts.get(a.nodeId)! + 1);
    }
  }

  const targets = ov.accounts.filter((a) => a.active && (scope === 'all' ? !a.nodeId.startsWith('usr:') : !a.nodeId));
  let updated = 0;
  for (const a of targets) {
    let bestId = pool[0].id;
    let bestCnt = Infinity;
    for (const n of pool) {
      const cnt = counts.get(n.id) ?? 0;
      if (cnt < bestCnt) { bestCnt = cnt; bestId = n.id; }
    }
    await bindAccount('ais2', a.id, bestId);
    counts.set(bestId, bestCnt + 1);
    updated++;
  }
  return { ok: true, updated };
}

export async function reapplyAccountProxy(email: string) {
  if (!isExitEnabled() || !email) return;
  const b = one("SELECT node_id FROM exit_bindings WHERE kind = 'ais2' AND lower(acc_id) = lower(?)", email);
  if (!b?.node_id) return;
  const nodes = loadNodes();
  const proxyUrl = resolveProxyUrl(String(b.node_id), nodes);
  if (proxyUrl) {
    try { await aistudio2.setAccountProxy(email, proxyUrl); } catch {}
  }
}
