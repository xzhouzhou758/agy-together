import { safeLookup, isPrivateIP, isBlockedHostname } from './subparse.ts';
import { isIP } from 'node:net';
import net from 'node:net';
import tls from 'node:tls';

export type NodePurity = {
  at: number;
  ok: boolean;
  level: 'good' | 'warn' | 'bad';
  label: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  isp?: string;
  hosting?: boolean;
  proxy?: boolean;
  aisOk: boolean;
  aisStatus?: number;
  latencyMs?: number;
  err?: string;
};

const BLOCKED_CC = new Set(['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU']);

function connectViaProxy(proxyUrl: string, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(proxyUrl); } catch { return reject(new Error('代理地址格式无效')); }
    const pHost = u.hostname.replace(/^\[|\]$/g, '');
    const pPort = Number(u.port) || (u.protocol.startsWith('socks') ? 1080 : 8080);
    const user = decodeURIComponent(u.username || '');
    const pass = decodeURIComponent(u.password || '');

    const isManaged = pHost === '172.17.0.1' && pPort >= 22001 && pPort <= 22299;
    if (!isManaged) {
      if (isBlockedHostname(pHost) || (isIP(pHost) && isPrivateIP(pHost))) return reject(new Error('代理地址不可为内网或受限主机'));
    }
    const sock = net.connect({ host: pHost, port: pPort, ...(isManaged ? {} : { lookup: safeLookup }) });
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('连接代理超时')), timeoutMs);
    const onErr = (e: Error) => { clearTimeout(timer); fail(e); };
    const onClose = () => { clearTimeout(timer); fail(new Error('代理连接已关闭')); };
    sock.once('error', onErr);
    sock.once('close', onClose);

    if (u.protocol.startsWith('socks5')) {
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.once('connect', () => {
        const methods = user || pass ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
        sock.write(methods);
      });
      const sendConnect = () => {
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + hostBuf.length);
        stage = 2;
        sock.write(req);
      };
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0x00) {
            sendConnect();
          } else if (method === 0x02 && (user || pass)) {
            stage = 1;
            const ub = Buffer.from(user, 'utf8'), pb = Buffer.from(pass, 'utf8');
            if (ub.length > 255 || pb.length > 255) { clearTimeout(timer); return fail(new Error('SOCKS5 账密长度超限')); }
            const auth = Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]);
            sock.write(auth);
          } else {
            clearTimeout(timer);
            fail(new Error('SOCKS5 认证方式不支持'));
          }
        } else if (stage === 1) {
          if (buf.length < 2) return;
          const st = buf[1];
          buf = buf.subarray(2);
          if (st !== 0x00) { clearTimeout(timer); return fail(new Error('SOCKS5 账密认证失败')); }
          sendConnect();
        } else if (stage === 2) {
          if (buf.length < 4) return;
          const rep = buf[1], atyp = buf[3];
          const need = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? (buf.length >= 5 ? 7 + buf[4] : 999) : 999;
          if (buf.length < need) return;
          clearTimeout(timer);
          sock.removeListener('data', onData);
          if (rep !== 0x00) return fail(new Error(`SOCKS5 连接目标失败 (0x${rep.toString(16)})`));
          sock.removeListener('error', onErr);
          sock.removeListener('close', onClose);
          const rest = buf.subarray(need);
          if (rest.length) sock.unshift(rest);
          done = true;
          resolve(sock);
        }
      };
      sock.on('data', onData);
    } else if (u.protocol === 'http:' || u.protocol === 'https:') {
      let raw = '';
      sock.once('connect', () => {
        const hdrs = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
        if (user || pass) hdrs.push('Proxy-Authorization: Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
        sock.write(hdrs.join('\r\n') + '\r\n\r\n');
      });
      const onData = (chunk: Buffer) => {
        raw += chunk.toString('latin1');
        const idx = raw.indexOf('\r\n\r\n');
        if (idx < 0) { if (raw.length > 8192) { clearTimeout(timer); fail(new Error('代理响应过长')); } return; }
        clearTimeout(timer);
        sock.removeListener('data', onData);
        const line = raw.slice(0, raw.indexOf('\r\n'));
        if (!/HTTP\/1\.[01]\s+200\b/i.test(line)) return fail(new Error('HTTP 代理拒绝连接: ' + line.slice(0, 40)));
        sock.removeListener('error', onErr);
        sock.removeListener('close', onClose);
        const leftover = raw.slice(idx + 4);
        if (leftover.length) sock.unshift(Buffer.from(leftover, 'latin1'));
        done = true;
        resolve(sock);
      };
      sock.on('data', onData);
    } else {
      clearTimeout(timer);
      fail(new Error('仅支持 socks5 / http 代理'));
    }
  });
}

async function httpOverProxy(proxyUrl: string, targetHost: string, targetPort: number, useTls: boolean, path: string, timeoutMs = 6000): Promise<{ status: number; body: string; latencyMs: number }> {
  const t0 = Date.now();
  const rawSock = await connectViaProxy(proxyUrl, targetHost, targetPort, timeoutMs);
  return new Promise((resolve, reject) => {
    const conn: net.Socket = useTls ? tls.connect({ socket: rawSock, servername: targetHost }) : rawSock;
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy(); if (conn !== rawSock) rawSock.destroy();
      if (err) return reject(err);
      const text = Buffer.concat(chunks).toString('utf8');
      const sep = text.indexOf('\r\n\r\n');
      const head = sep >= 0 ? text.slice(0, sep) : text;
      const body = sep >= 0 ? text.slice(sep + 4) : '';
      const m = /HTTP\/1\.[01]\s+(\d{3})/.exec(head);
      resolve({ status: m ? Number(m[1]) : 0, body, latencyMs: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish(new Error('请求超时')), timeoutMs);
    rawSock.once('error', (e) => finish(e));
    conn.once('error', (e) => finish(e));
    conn.once('close', () => finish());
    const send = () => {
      conn.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json,*/*\r\nConnection: close\r\n\r\n`);
    };
    if (useTls) (conn as tls.TLSSocket).once('secureConnect', send);
    else send();
    conn.on('data', (c: Buffer) => {
      if (total < 65536) { chunks.push(c); total += c.length; }
    });
    conn.on('end', () => finish());
  });
}

export async function checkProxyPurity(proxyUrl: string): Promise<NodePurity> {
  const at = Date.now();
  let ipInfo: any = null;
  let ipErr = '';
  try {
    const r = await httpOverProxy(proxyUrl, 'ip-api.com', 80, false, '/json/?fields=status,country,countryCode,isp,org,hosting,proxy,query&lang=zh-CN', 6000);
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      if (j && j.status === 'success') ipInfo = j;
    }
  } catch (e) {
    ipErr = (e as Error).message || 'IP检测失败';
  }

  let aisOk = false;
  let aisStatus = 0;
  let latencyMs = 0;
  let aisErr = '';
  try {
    const r2 = await httpOverProxy(proxyUrl, 'generativelanguage.googleapis.com', 443, true, '/$discovery/rest?version=v1beta', 6500);
    aisStatus = r2.status;
    latencyMs = r2.latencyMs;
    aisOk = r2.status === 200;
    if (!aisOk && r2.status) aisErr = `HTTP ${r2.status}`;
  } catch (e) {
    aisErr = (e as Error).message || 'AI Studio 不可达';
  }

  const cc = String(ipInfo?.countryCode || '').toUpperCase();
  const blocked = cc ? BLOCKED_CC.has(cc) : false;
  const hosting = ipInfo?.hosting === true;
  const proxy = ipInfo?.proxy === true;

  if (!aisOk || blocked) {
    return {
      at, ok: false, level: 'bad',
      label: blocked ? `地区不支持 (${ipInfo?.country || cc})` : `不可用 (${aisErr || ipErr || '受限'})`,
      ip: ipInfo?.query, country: ipInfo?.country, countryCode: cc || undefined,
      isp: ipInfo?.isp || ipInfo?.org, hosting, proxy,
      aisOk, aisStatus: aisStatus || undefined, latencyMs: latencyMs || undefined,
      err: aisErr || ipErr || undefined,
    };
  }

  if (!hosting && !proxy) {
    return {
      at, ok: true, level: 'good',
      label: '纯净原生',
      ip: ipInfo?.query, country: ipInfo?.country, countryCode: cc || undefined,
      isp: ipInfo?.isp || ipInfo?.org, hosting, proxy,
      aisOk: true, aisStatus, latencyMs,
    };
  }

  return {
    at, ok: true, level: 'warn',
    label: hosting ? '机房可用' : '代理可用',
    ip: ipInfo?.query, country: ipInfo?.country, countryCode: cc || undefined,
    isp: ipInfo?.isp || ipInfo?.org, hosting, proxy,
    aisOk: true, aisStatus, latencyMs,
  };
}
