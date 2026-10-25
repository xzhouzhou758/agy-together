// Admin-only window onto CLIProxyAPI's own management panel, served under <base>/cpa/.
// CPA stays on 127.0.0.1; the portal checks the admin session and injects the management key,
// so the browser never sees it. Whatever key the admin types into the panel's login is ignored.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { requireAdmin } from './auth.ts';
import { HttpError } from './util.ts';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'cookie', 'authorization', 'content-length']);

export async function handleCpaPanel(req: IncomingMessage, res: ServerResponse, url: URL) {
  requireAdmin(req);
  const sub = url.pathname.slice('/cpa'.length) || '/';
  if (sub === '/' || sub === '/management.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    return sendPanel(res);
  }
  // Plugin pages (e.g. Lamplighter) are loaded by the panel in an iframe; they call /v0/management/... by absolute path.
  if (sub.startsWith('/v0/resource/plugins/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    return sendPluginPage(res, sub + url.search);
  }
  // The panel's 中心信息 lists models from <apiBase>/v1/models; read-only, so answer with CPA's own list.
  if (sub === '/v1/models' || sub === '/v1beta/models') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const r = await fetch(config.cpaURL + sub, { headers: { Authorization: 'Bearer ' + config.cpaAPIKey } });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (!/^\/v[08]\/management(\/|$)/.test(sub)) throw new HttpError(404, 'not_found');
  // Cookie auth would make these CSRF-able; a custom header can't be sent cross-site without CORS, which we never grant.
  if (!req.headers.authorization) throw new HttpError(401, 'unauthorized');
  return proxy(req, res, sub + url.search);
}

async function sendPanel(res: ServerResponse) {
  const r = await fetch(config.cpaURL + '/management.html');
  if (!r.ok) throw new HttpError(502, 'cpa_panel_unavailable');
  let html = await r.text();
  // The panel defaults its API base to location.origin; point it at our prefix instead.
  html = html.replace('return np(`${e}//${t}${n?`:${n}`:``}`)', `return np(location.origin+${JSON.stringify(config.basePath + '/cpa')})`);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

async function sendPluginPage(res: ServerResponse, path: string) {
  const r = await fetch(config.cpaURL + path);
  const type = r.headers.get('content-type') || 'application/octet-stream';
  const h: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' };
  if (!/text\/html|javascript/.test(type)) {
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const prefix = config.basePath + '/cpa';
  const body = (await r.text()).replace(/(["'`])\/v0\/(management|resource)\//g, `$1${prefix}/v0/$2/`);
  res.writeHead(r.status, h);
  res.end(body);
}

function proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const target = new URL(config.cpaURL + path);
  const headers: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-forwarded') && k !== 'x-real-ip') headers[k] = v;
  headers.authorization = 'Bearer ' + config.cpaMgmtKey;
  return new Promise((resolve) => {
    const up = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (ur) => {
      const h: Record<string, any> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && !k.startsWith('access-control-') && k !== 'set-cookie') h[k] = v;
      h['cache-control'] = 'no-store';
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
      ur.on('end', () => resolve());
      ur.on('error', () => { res.destroy(); resolve(); });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"cpa_unavailable"}');
      else res.destroy();
      resolve();
    });
    req.pipe(up);
  });
}
