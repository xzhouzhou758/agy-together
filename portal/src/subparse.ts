// Safe subscription fetcher & US-node filter (no external YAML/proxy deps).
import { lookup as dnsLookup, ADDRCONFIG } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export type ParsedProxy = Record<string, any> & { name: string; type: string; server: string; port: number };

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata.google.internal', 'metadata']);

function isPrivateIPv4(parts: number[]): boolean {
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 88 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIPv6Groups(raw: string): number[] | null {
  let s = raw.toLowerCase().split('%')[0];
  let v4Tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const p = s.slice(lastColon + 1).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    v4Tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, lastColon);
    if (s.endsWith(':')) s += ':'; // preserve '::' when input was '::1.2.3.4'
  }
  const need = 8 - v4Tail.length;
  const dbl = s.indexOf('::');
  let groups: number[] = [];
  if (dbl >= 0) {
    if (s.indexOf('::', dbl + 2) >= 0) return null;
    const left = dbl === 0 ? [] : s.slice(0, dbl).split(':');
    const right = dbl + 2 === s.length ? [] : s.slice(dbl + 2).split(':');
    if (left.length + right.length >= need) return null;
    const parseHex = (arr: string[]) => arr.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : -1));
    const lNum = parseHex(left), rNum = parseHex(right);
    if (lNum.some((x) => x < 0) || rNum.some((x) => x < 0)) return null;
    groups = [...lNum, ...Array(need - lNum.length - rNum.length).fill(0), ...rNum, ...v4Tail];
  } else {
    const parts = s ? s.split(':') : [];
    if (parts.length !== need) return null;
    const nums = parts.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : -1));
    if (nums.some((x) => x < 0)) return null;
    groups = [...nums, ...v4Tail];
  }
  return groups.length === 8 ? groups : null;
}

export function isPrivateIP(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  const ver = isIP(clean);
  if (ver === 4) {
    return isPrivateIPv4(clean.split('.').map(Number));
  }
  if (ver === 6) {
    const g = parseIPv6Groups(clean);
    if (!g) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
    const v4From67 = () => [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
    // :: and ::1 and IPv4-compatible ::w.x.y.z
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
      return isPrivateIPv4(v4From67());
    }
    // IPv4-mapped ::ffff:w.x.y.z
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isPrivateIPv4(v4From67());
    }
    // IPv4-translated ::ffff:0:w.x.y.z
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
      return isPrivateIPv4(v4From67());
    }
    // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
    if (g0 === 0x0064 && g1 === 0xff9b) {
      return isPrivateIPv4(v4From67());
    }
    // Discard 100::/64
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    // Teredo 2001:0000::/32 & Documentation 2001:db8::/32
    if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8)) return true;
    // 6to4 2002::/16 embeds IPv4 in g1,g2
    if (g0 === 0x2002) return isPrivateIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
    // ULA fc00::/7, Link-Local fe80::/10, Multicast ff00::/8, or anything outside global unicast 2000::/3
    if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) return true;
    if ((g0 & 0xe000) !== 0x2000) return true;
    return false;
  }
  return true;
}

export function isBlockedHostname(host: string): boolean {
  const h = host.replace(/\.+$/, '').toLowerCase();
  if (!h || BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.arpa')) return true;
  return false;
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error('链接格式无效'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 链接');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isBlockedHostname(host)) throw new Error('不允许访问该地址');
  if (isIP(host)) {
    if (isPrivateIP(host)) throw new Error('不允许访问内网或本机地址');
    return u;
  }
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error('域名无法解析'); }
  if (!addrs.length || addrs.some((a) => isPrivateIP(a.address))) throw new Error('域名解析到了内网地址，已拦截');
  return u;
}

export function isValidNodeTarget(server: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const host = String(server || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f/@\\]/.test(host)) return false;
  if (isBlockedHostname(host)) return false;
  if (isIP(host)) return !isPrivateIP(host);
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false;
  return /^[a-z0-9._-]+$/.test(host);
}

export const safeLookup: typeof dnsLookup = ((hostname: string, options: any, cb: any) => {
  const callback = typeof options === 'function' ? options : cb;
  const opts = typeof options === 'function' ? {} : options || {};
  dnsLookup(hostname, { hints: ADDRCONFIG, ...opts, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [];
    const pub = list.filter((a) => a && typeof a.address === 'string' && !isPrivateIP(a.address));
    if (!pub.length) return callback(new Error('域名解析到了内网地址，已拦截'));
    if (opts.all) return callback(null, pub);
    return callback(null, pub[0].address, pub[0].family);
  });
}) as typeof dnsLookup;

function requestOnce(u: URL, maxBytes: number, timeoutMs: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const tls = u.protocol === 'https:';
    const req = (tls ? https : http).request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (tls ? 443 : 80),
      path: (u.pathname || '/') + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'clash.meta/1.19.0', Accept: '*/*' },
      lookup: safeLookup,
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('订阅内容超过 2MB 上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('拉取订阅超时')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchSafeSubscription(rawUrl: string, maxBytes = 2 * 1024 * 1024, timeoutMs = 12000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let cur = await assertSafeUrl(rawUrl);
  for (let hop = 0; hop <= 5; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('拉取订阅超时');
    const res = await requestOnce(cur, maxBytes, Math.max(500, left));
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop === 5) throw new Error('订阅跳转次数过多');
      const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
      let nextRaw: string;
      try { nextRaw = new URL(loc, cur).toString(); } catch { throw new Error('订阅跳转地址无效'); }
      cur = await assertSafeUrl(nextRaw);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`拉取订阅失败（HTTP ${res.status}）`);
    return res.body;
  }
  throw new Error('订阅跳转次数过多');
}

const INFO_NOISE = /剩余流量|套餐|到期|过期|重置|官网|网址|频道|群组|通知|维护|失联|防失联|放丢失|更新订阅|建议\s*[:：]|\btraffic\s*reset\b|\bexpire\s*[:：]|\d+(?:\.\d+)?\s*[GMKT]B\s*[|/]\s*\d+(?:\.\d+)?\s*[GMKT]B|(?:倍率\s*[:：]?\s*)?(?<![.\d])(?:[5-9]\d|1\d{2})x/i;
const HARD_NON_US = /香港|日本|新加坡|狮城|台湾|韩国|英国|德国|法国|加拿大|多伦多|温哥华|蒙特利尔|澳大利亚|澳洲|悉尼|印度|孟买|俄罗斯|土耳其|马来西亚|泰国|越南|菲律宾|印尼|雅加达|巴西|阿根廷|荷兰|瑞士|瑞典|芬兰|挪威|波兰|乌克兰|爱尔兰|意大利|西班牙|迪拜|阿联酋|以色列|南非|尼日利亚|(\b|[^a-z])(HK|JP|SG|TW|KR|UK|GB|DE|FR|AU|RU|TR|MY|TH|VN|PH|NL|CH|SE|FI|PL|IT|ES|AE|Canada)(\b|[^a-z])|🇭🇰|🇯🇵|🇸🇬|🇹🇼|🇰🇷|🇬🇧|🇩🇪|🇫🇷|🇨🇦|🇦🇺/i;
const AMBIG_NON_US = /(\b|[^a-z])(CA|IN|ID)(\b|[^a-z])/i;
const STRONG_US = /🇺🇸|美国|美西|美东|United\s*States|\bUSA\b|\bUS\b|洛杉矶|圣何塞|硅谷|西雅图|纽约|芝加哥|达拉斯|凤凰城|波特兰|亚特兰大|迈阿密|华盛顿|阿什本|丹佛|拉斯维加斯|Los\s*Angeles|San\s*Jose|Silicon\s*Valley|Seattle|New\s*York|Chicago|Dallas|Phoenix|Portland|Atlanta|Miami|Ashburn|Denver|Las\s*Vegas/i;
const US_AIRPORT = /\b(LA|LAX|SJC|SEA|NYC|JFK|DFW|ORD|PHX|IAD|ATL|MIA)\b/i;

const BLOCKED_REGION = /香港|中国|回国|大陆|内地|澳门|俄罗斯|白俄罗斯|伊朗|朝鲜|叙利亚|古巴|\b(HK|CN|MO|RU|BY|IR|KP|SY|CU)\b|🇭🇰|🇲🇴|🇷🇺|🇰🇵|🇮🇷|🇸🇾|🇨🇺|🇧🇾|(?:🇨🇳(?!.*台湾))/i;
export function isSupportedRegionNode(name: string): boolean {
  if (!name) return false;
  if (INFO_NOISE.test(name)) return false;
  if (BLOCKED_REGION.test(name)) return false;
  return true;
}

export function isUsNode(name: string): boolean {
  if (!name) return false;
  if (INFO_NOISE.test(name)) return false;
  if (HARD_NON_US.test(name)) return false;
  if (STRONG_US.test(name)) return true;
  if (AMBIG_NON_US.test(name)) return false;
  return US_AIRPORT.test(name);
}

// Parse scalar YAML value
function stripInlineComment(v: string): string {
  let q = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (q) {
      if (ch === q && v[i - 1] !== '\\') q = '';
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(v[i - 1]))) {
      return v.slice(0, i).trim();
    }
  }
  return v.trim();
}
function parseVal(v: string): any {
  const s = stripInlineComment(v);
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

// Parse Clash flow-style mapping `{name: "xx", type: vless, ...}`
function parseFlowMap(line: string): Record<string, any> | null {
  const inner = line.trim().replace(/^-\s*/, '').trim();
  if (!inner.startsWith('{') || !inner.endsWith('}')) return null;
  const body = inner.slice(1, -1);
  const obj: Record<string, any> = {};
  let i = 0;
  const n = body.length;
  const skipWs = () => { while (i < n && (body[i] === ' ' || body[i] === ',' || body[i] === '\t')) i++; };
  const readStr = (q: string) => {
    i++;
    let out = '';
    while (i < n && body[i] !== q) {
      if (body[i] === '\\' && i + 1 < n) { out += body[i + 1]; i += 2; }
      else out += body[i++];
    }
    if (body[i] === q) i++;
    return out;
  };
  const readVal = (): any => {
    skipWs();
    if (i >= n) return '';
    if (body[i] === '"' || body[i] === "'") return readStr(body[i]);
    if (body[i] === '{') {
      let d = 0, start = i;
      while (i < n) {
        if (body[i] === '"' || body[i] === "'") readStr(body[i]);
        else { if (body[i] === '{') d++; else if (body[i] === '}') { d--; i++; if (d === 0) break; } else i++; }
      }
      return parseFlowMap(body.slice(start, i)) ?? body.slice(start, i);
    }
    if (body[i] === '[') {
      let d = 0, start = i;
      while (i < n) {
        if (body[i] === '"' || body[i] === "'") readStr(body[i]);
        else { if (body[i] === '[') d++; else if (body[i] === ']') { d--; i++; if (d === 0) break; } else i++; }
      }
      const raw = body.slice(start + 1, i - 1).trim();
      return raw ? raw.split(',').map((x) => parseVal(x)) : [];
    }
    const start = i;
    while (i < n && body[i] !== ',' && body[i] !== '}') i++;
    return parseVal(body.slice(start, i));
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    let key = '';
    if (body[i] === '"' || body[i] === "'") key = readStr(body[i]);
    else {
      const start = i;
      while (i < n && body[i] !== ':' && body[i] !== ',') i++;
      key = body.slice(start, i).trim();
    }
    if (body[i] !== ':') { while (i < n && body[i] !== ',') i++; continue; }
    i++; // skip ':'
    if (key) obj[key] = readVal();
  }
  return obj;
}

const ALLOWED_PROXY_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'socks5', 'http', 'wireguard', 'anytls']);
function normalizeProxyObj(obj: Record<string, any> | null): ParsedProxy | null {
  if (!obj || !obj.name || !obj.type || !obj.server) return null;
  const ptype = String(obj.type).trim().toLowerCase();
  if (!ALLOWED_PROXY_TYPES.has(ptype)) return null;
  const server = String(obj.server).trim().replace(/^\[|\]$/g, '');
  const port = Number(obj.port);
  if (!isValidNodeTarget(server, port)) return null;
  obj.name = String(obj.name).trim();
  obj.type = ptype;
  obj.server = server;
  obj.port = port;
  return obj as ParsedProxy;
}

function parseClashYaml(text: string): ParsedProxy[] {
  const lines = text.split(/\r?\n/);
  const out: ParsedProxy[] = [];
  let inProxies = false;
  let proxiesIndent = -1;
  let cur: Record<string, any> | null = null;
  let subKey = '';
  let subIndent = -1;
  let sub2Key = '';
  let sub2Indent = -1;

  const flush = () => {
    const norm = normalizeProxyObj(cur);
    if (norm) out.push(norm);
    cur = null;
    subKey = '';
    subIndent = -1;
    sub2Key = '';
    sub2Indent = -1;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (!inProxies) {
      if (/^proxies\s*:\s*(?:#.*)?$/.test(trimmed)) {
        inProxies = true;
        proxiesIndent = indent;
      }
      continue;
    }
    if (indent <= proxiesIndent && !trimmed.startsWith('-')) {
      flush();
      break;
    }
    if (trimmed.startsWith('- ')) {
      flush();
      if (trimmed.slice(2).trim().startsWith('{')) {
        const norm = normalizeProxyObj(parseFlowMap(trimmed));
        if (norm) out.push(norm);
        continue;
      }
      cur = {};
      const rest = trimmed.slice(2).trim();
      const kv = /^([^:]+):\s*(.*)$/.exec(rest);
      if (kv) cur[kv[1].trim()] = parseVal(kv[2]);
      continue;
    }
    if (!cur) continue;
    if (subKey && indent > subIndent) {
      if (sub2Key && indent > sub2Indent) {
        const kv2 = /^([^:]+):\s*(.*)$/.exec(trimmed);
        if (kv2 && cur[subKey] && typeof cur[subKey] === 'object') {
          if (!cur[subKey][sub2Key] || typeof cur[subKey][sub2Key] !== 'object' || Array.isArray(cur[subKey][sub2Key])) cur[subKey][sub2Key] = {};
          cur[subKey][sub2Key][kv2[1].trim()] = parseVal(kv2[2]);
        }
        continue;
      }
      sub2Key = '';
      if (trimmed.startsWith('- ')) {
        if (!Array.isArray(cur[subKey])) cur[subKey] = [];
        cur[subKey].push(parseVal(trimmed.slice(2)));
      } else {
        const kv = /^([^:]+):\s*(.*)$/.exec(trimmed);
        if (kv) {
          if (!cur[subKey] || typeof cur[subKey] !== 'object' || Array.isArray(cur[subKey])) cur[subKey] = {};
          const k2 = kv[1].trim(), v2 = stripInlineComment(kv[2]);
          if (!v2) {
            sub2Key = k2;
            sub2Indent = indent;
            cur[subKey][k2] = {};
          } else {
            cur[subKey][k2] = parseVal(v2);
          }
        }
      }
      continue;
    }
    subKey = '';
    sub2Key = '';
    const kv = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const k = kv[1].trim();
    const v = kv[2].trim();
    if (!v) {
      subKey = k;
      subIndent = indent;
      cur[k] = {};
    } else if (v.startsWith('{') && v.endsWith('}')) {
      cur[k] = parseFlowMap(v) ?? parseVal(v);
    } else {
      cur[k] = parseVal(v);
    }
  }
  flush();
  return out;
}

function decodeB64(s: string): string {
  const norm = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64').toString('utf8');
}

function parseUriLine(raw: string): ParsedProxy | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    if (line.startsWith('vmess://')) {
      const j = JSON.parse(decodeB64(line.slice(8)));
      if (!j.add || !j.port || !j.id) return null;
      const p: Record<string, any> = {
        name: String(j.ps || `${j.add}:${j.port}`),
        type: 'vmess',
        server: String(j.add),
        port: Number(j.port),
        uuid: String(j.id),
        alterId: Number(j.aid || 0),
        cipher: String(j.scy || 'auto'),
        tls: j.tls === 'tls',
        udp: true,
      };
      if (j.sni) p.servername = String(j.sni);
      if (j.net === 'ws') {
        p.network = 'ws';
        p['ws-opts'] = { path: String(j.path || '/'), headers: j.host ? { Host: String(j.host) } : {} };
      } else if (j.net === 'grpc') {
        p.network = 'grpc';
        if (j.path) p['grpc-opts'] = { 'grpc-service-name': String(j.path) };
      }
      return normalizeProxyObj(p);
    }
    if (line.startsWith('vless://') || line.startsWith('trojan://') || line.startsWith('hysteria2://') || line.startsWith('hy2://')) {
      const u = new URL(line.replace(/^hy2:\/\//, 'hysteria2://'));
      const proto = u.protocol.replace(':', '');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const name = decodeURIComponent(u.hash.replace(/^#/, '') || `${host}:${u.port}`);
      const port = Number(u.port || 443);
      if (!host || !port) return null;
      const sp = u.searchParams;
      const base: Record<string, any> = {
        name,
        type: proto,
        server: host,
        port,
        udp: true,
      };
      if (proto === 'vless') {
        base.uuid = decodeURIComponent(u.username);
        if (sp.get('flow')) base.flow = sp.get('flow');
        const sec = sp.get('security');
        if (sec === 'tls' || sec === 'reality') base.tls = true;
        if (sp.get('sni')) base.servername = sp.get('sni');
        if (sp.get('fp')) base['client-fingerprint'] = sp.get('fp');
        if (sec === 'reality') {
          base['reality-opts'] = {
            'public-key': sp.get('pbk') || '',
            'short-id': sp.get('sid') || '',
          };
        }
        const net = sp.get('type') || 'tcp';
        if (net !== 'tcp') base.network = net;
        if (net === 'ws') base['ws-opts'] = { path: sp.get('path') || '/', headers: sp.get('host') ? { Host: sp.get('host') } : {} };
        if (net === 'grpc' && sp.get('serviceName')) base['grpc-opts'] = { 'grpc-service-name': sp.get('serviceName') };
        if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') base['skip-cert-verify'] = true;
      } else if (proto === 'trojan') {
        base.password = decodeURIComponent(u.username);
        if (sp.get('sni')) base.sni = sp.get('sni');
        if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') base['skip-cert-verify'] = true;
        if (sp.get('type') === 'ws') {
          base.network = 'ws';
          base['ws-opts'] = { path: sp.get('path') || '/', headers: sp.get('host') ? { Host: sp.get('host') } : {} };
        }
      } else if (proto === 'hysteria2') {
        base.password = decodeURIComponent(u.username);
        if (sp.get('sni')) base.sni = sp.get('sni');
        if (sp.get('obfs')) {
          base.obfs = sp.get('obfs');
          if (sp.get('obfs-password')) base['obfs-password'] = sp.get('obfs-password');
        }
        if (sp.get('insecure') === '1') base['skip-cert-verify'] = true;
      }
      return normalizeProxyObj(base);
    }
    if (line.startsWith('ss://')) {
      const hashIdx = line.indexOf('#');
      const name = hashIdx >= 0 ? decodeURIComponent(line.slice(hashIdx + 1)) : 'SS';
      let body = hashIdx >= 0 ? line.slice(5, hashIdx) : line.slice(5);
      const qIdx = body.indexOf('?');
      if (qIdx >= 0) body = body.slice(0, qIdx);
      let cipher = '', password = '', server = '', port = 0;
      const at = body.lastIndexOf('@');
      if (at >= 0) {
        const cred = body.slice(0, at);
        const addr = body.slice(at + 1);
        const dec = cred.includes(':') ? decodeURIComponent(cred) : decodeB64(cred);
        const ci = dec.indexOf(':');
        if (ci < 0) return null;
        cipher = dec.slice(0, ci);
        password = dec.slice(ci + 1);
        const u = new URL('http://' + addr);
        server = u.hostname.replace(/^\[|\]$/g, '');
        port = Number(u.port);
      } else {
        const dec = decodeB64(body);
        const dat = dec.lastIndexOf('@');
        if (dat < 0) return null;
        const cred = dec.slice(0, dat);
        const ci = cred.indexOf(':');
        if (ci < 0) return null;
        cipher = cred.slice(0, ci);
        password = cred.slice(ci + 1);
        const u = new URL('http://' + dec.slice(dat + 1));
        server = u.hostname.replace(/^\[|\]$/g, '');
        port = Number(u.port);
      }
      if (!server || !port || !cipher) return null;
      return normalizeProxyObj({ name, type: 'ss', server, port, cipher, password, udp: true });
    }
  } catch {}
  return null;
}

type SubscriptionResult = { total: number; us: ParsedProxy[] };

async function parseSubscription(rawUrl: string): Promise<SubscriptionResult> {
  const buf = await fetchSafeSubscription(rawUrl, 2 * 1024 * 1024, 12000);
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');

  let parsed: ParsedProxy[] = [];
  if (/^proxies\s*:/m.test(text)) {
    parsed = parseClashYaml(text);
  } else {
    const rawLines = text.includes('://') ? text.split(/\r?\n/) : decodeB64(text).split(/\r?\n/);
    for (const l of rawLines) {
      const p = parseUriLine(l);
      if (p) parsed.push(p);
    }
  }

  const seen = new Set<string>();
  const us: ParsedProxy[] = [];
  for (const p of parsed) {
    if (!isSupportedRegionNode(p.name)) continue;
    const key = `${p.type}:${p.server}:${p.port}:${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    us.push(p);
    if (us.length >= 60) break;
  }
  return { total: parsed.length, us };
}


type SubscriptionReply = { result: SubscriptionResult } | { error: string };
const SUBSCRIPTION_WORKER = 'agy-subscription';
let subscriptionWorkerRunning = false;

if (!isMainThread && workerData?.task === SUBSCRIPTION_WORKER) {
  void parseSubscription(workerData.url).then(
    (result) => parentPort!.postMessage({ result } satisfies SubscriptionReply),
    (error: Error) => parentPort!.postMessage({ error: error.message } satisfies SubscriptionReply),
  ).finally(() => parentPort!.close());
}

export async function fetchAndFilterUsNodes(rawUrl: string): Promise<SubscriptionResult> {
  if (subscriptionWorkerRunning) throw new Error('已有订阅正在拉取，请稍后重试');
  subscriptionWorkerRunning = true;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL(import.meta.url), {
      workerData: { task: SUBSCRIPTION_WORKER, url: rawUrl },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
    const w = worker;
    return await new Promise<SubscriptionResult>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      const deadline = setTimeout(() => done(() => reject(new Error('拉取或解析订阅超时，请稍后重试'))), 15000);
      w.once('message', (reply: SubscriptionReply) => {
        done(() => ('error' in reply ? reject(new Error(reply.error)) : resolve(reply.result)));
      });
      w.once('error', (err: Error & { code?: string }) => {
        done(() => {
          if (err?.code === 'ERR_WORKER_OUT_OF_MEMORY') reject(new Error('订阅内容过大，解析内存超限'));
          else reject(new Error(err?.message ? `订阅解析失败：${err.message}` : '订阅解析失败'));
        });
      });
      w.once('exit', () => {
        done(() => reject(new Error('订阅解析已退出')));
      });
    });
  } finally {
    try { await worker?.terminate(); } catch {}
    subscriptionWorkerRunning = false;
  }
}
