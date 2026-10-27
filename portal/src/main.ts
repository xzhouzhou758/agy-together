import http from 'node:http';
import { startBotChat } from './botchat.ts';
import { startRestartLog, recordStop } from './restarts.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.ts';
import { handleCpaPanel } from './cpapanel.ts';
import './db.ts';
import { sendError, HttpError } from './util.ts';
import { handleAPI } from './api.ts';
import { handleGateway } from './gateway.ts';
import { discordLogin, discordCallback, startRoleRecheck, pruneSessions } from './auth.ts';
import { startUsageDrainer, pruneUsage } from './usage.ts';
import { startQuotaRefresher } from './quota.ts';
import { initSetup, setupDone } from './site.ts';
import { handleInteraction, startBot } from './bot.ts';
import { startAutoDisable } from './autodisable.ts';
import * as cpa from './cpa.ts';

const errs = validateConfig();
if (errs.length) {
  for (const e of errs) console.error('[config]', e);
  process.exit(1);
}

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SEC = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

// static files are small: load once
const files = new Map<string, Buffer>();
for (const f of ['index.html', 'app.js', 'app.css', 'setup.html', 'setup.js', 'theme.js', 'icons/gemini.svg', 'icons/claude.svg', 'icons/openai.svg', 'icons/openai-dark.svg', 'favicon.png', 'apple-touch-icon.png', 'logo.jpg']) {
  const p = join(PUBLIC, f);
  if (existsSync(p)) files.set(f, readFileSync(p));
}
function sendStatic(res: http.ServerResponse, name: string) {
  const b = files.get(name);
  if (!b) throw new HttpError(404, 'not_found');
  const ext = name.slice(name.lastIndexOf('.'));
  res.writeHead(200, { ...SEC, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  let url: URL;
  try {
    url = new URL(req.url || '/', 'http://local');
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (config.basePath) {
    if (url.pathname === config.basePath) {
      res.writeHead(301, { Location: config.basePath + '/' + url.search }).end();
      return;
    }
    if (url.pathname.startsWith(config.basePath + '/')) url.pathname = url.pathname.slice(config.basePath.length);
  }
  const p = url.pathname;
  try {
    if (p.startsWith('/v1/') || p === '/v1' || p.startsWith('/v1beta/')) return await handleGateway(req, res, url);
    if (p.startsWith('/api/')) return await handleAPI(req, res, url);
    if (p === '/cpa' || p.startsWith('/cpa/')) return await handleCpaPanel(req, res, url);
    if (p === '/auth/discord/login') return discordLogin(res);
    if (p === '/auth/discord/callback') return await discordCallback(req, res, url);
    if (p === '/discord/interactions') return await handleInteraction(req, res);
    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    if (p === '/setup') {
      if (setupDone()) throw new HttpError(404, 'not_found');
      return sendStatic(res, 'setup.html');
    }
    if (p === '/app.js' || p === '/app.css' || p === '/setup.js' || p === '/theme.js' || (p.startsWith('/icons/') && files.has(p.slice(1))) || p === '/favicon.png' || p === '/apple-touch-icon.png' || p === '/logo.jpg') return sendStatic(res, p.slice(1));
    if (p === '/' || p === '/index.html') return sendStatic(res, 'index.html');
    throw new HttpError(404, 'not_found');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    sendError(res, e);
  }
});
server.headersTimeout = 60000;
server.requestTimeout = 0; // long streams
server.keepAliveTimeout = 65000;

server.listen(config.port, config.host, () => {
  console.log(`[portal] listening on ${config.host}:${config.port}${config.devLogin ? ' (DEV_LOGIN enabled)' : ''}`);
  initSetup();
  startUsageDrainer();
  startRoleRecheck();
  startQuotaRefresher();
  startBot();
  startBotChat();
  startAutoDisable();
  startRestartLog();
  cpa.refreshCreds().catch((e) => console.error('[cpa] initial credential list failed:', e.message));
  setInterval(() => {
    try { pruneSessions(); pruneUsage(); } catch (e) { console.error('[prune]', e); }
  }, 3600000).unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    recordStop();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
