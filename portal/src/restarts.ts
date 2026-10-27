// Restart / outage log, so the bot can tell someone "your request failed because the server was restarting".
// Records: the portal itself starting (deploy or crash, with how long it was down), the machine rebooting,
// and CPA not accepting connections (probed every few seconds; a docker restart takes longer than that).
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import { db, all, run, now, getSetting, setSetting } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS server_events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ts INTEGER NOT NULL, until INTEGER, detail TEXT)`);

const BEAT = 30e3, PROBE = 5e3;

function bootTime(): number | null {
  try { const m = /^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8')); return m ? Number(m[1]) * 1000 : null; } catch { return null; }
}

/** Called once at startup: how the previous run ended and whether the machine rebooted. */
export function recordStart(t = now(), btime = bootTime()): void {
  const beat = Number(getSetting('heartbeat_ts') || 0), stop = Number(getSetting('portal_stop_ts') || 0);
  if (btime && Number(getSetting('host_btime') || 0) !== btime) {
    if (getSetting('host_btime')) run(`INSERT INTO server_events(kind, ts, until, detail) VALUES('host', ?, ?, '服务器整机重启')`, beat || btime, btime);
    setSetting('host_btime', String(btime));
  }
  const clean = stop && stop >= beat;
  run(`INSERT INTO server_events(kind, ts, until, detail) VALUES('portal', ?, ?, ?)`, beat ? (clean ? stop : beat) : t, t,
    !beat ? '门户首次启动' : clean ? '门户重启（更新 / 部署）' : '门户意外退出后重启');
  setSetting('heartbeat_ts', String(t));
}
export function recordStop(t = now()): void { setSetting('portal_stop_ts', String(t)); }

let down: number | null = null, fails = 0;
/** One CPA probe result: an outage opens on the first failure and closes on the next success. */
export function cpaProbe(ok: boolean, t = now()): void {
  if (!ok) {
    if (down == null) { down = t; fails = 0; }
    fails++;
    return;
  }
  if (down != null) run(`INSERT INTO server_events(kind, ts, until, detail) VALUES('cpa', ?, ?, ?)`, down, t, `CPA 连不上（${fails} 次探测失败，多半是在重启）`);
  down = null;
}

function probe(): Promise<boolean> {
  const u = new URL(config.cpaURL);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(3000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export function startRestartLog(): void {
  recordStart();
  setInterval(() => setSetting('heartbeat_ts', String(now())), BEAT).unref();
  setInterval(() => void probe().then((ok) => cpaProbe(ok)), PROBE).unref();
  setInterval(() => run('DELETE FROM server_events WHERE ts < ?', now() - 30 * 86400e3), 3600e3).unref();
}

/** For the bot: restarts and outages of the last week, newest first, plus one still going on. */
export function restartLog(days = 7): string {
  const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const span = (a: number, b: number) => { const s = Math.max(0, Math.round((b - a) / 1000)); return s < 90 ? `${s} 秒` : `${Math.round(s / 60)} 分钟`; };
  const rows = all('SELECT kind, ts, until, detail FROM server_events WHERE ts >= ? ORDER BY ts DESC LIMIT 30', now() - days * 86400e3);
  const lines = rows.map((r: any) => `- ${fmt(r.ts)} ~ ${fmt(r.until ?? r.ts)}（中断约 ${span(r.ts, r.until ?? r.ts)}）${r.detail}`);
  if (down != null) lines.unshift(`- ${fmt(down)} 起到现在：CPA 连不上，正在中断中`);
  return `【服务器重启 / 中断记录（最近 ${days} 天，新的在前）】这段时间内正在进行的请求会断开或报错（常见 499、5xx、连接被重置、回复中途截断）。\n` + (lines.join('\n') || '（没有记录）');
}
