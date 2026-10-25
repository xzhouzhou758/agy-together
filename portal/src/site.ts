// Site settings editable from the admin UI (stored in the DB; env values are fallbacks).
// Secrets (client secret, bot token) are write-only: never returned by any API.
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { getSetting, setSetting, one } from './db.ts';
import { token, safeEqual } from './util.ts';

export type Discord = {
  clientId: string;
  clientSecret: string;
  redirectURI: string; // effective
  redirectOverride: string;
  guildId: string;
  roleIds: string[];
  botToken: string;
};

function s(k: string, envFallback = ''): string {
  const v = getSetting(k);
  return v !== undefined ? v : envFallback;
}

export function publicURL(): string {
  return s('public_url', config.publicURL).replace(/\/+$/, '');
}

export function discord(): Discord {
  const override = s('discord_redirect_uri', config.discordRedirectURI);
  const base = publicURL();
  return {
    clientId: s('discord_client_id', config.discordClientID),
    clientSecret: s('discord_client_secret', config.discordClientSecret),
    redirectOverride: override,
    redirectURI: override || (base ? base + '/auth/discord/callback' : ''),
    guildId: s('discord_guild_id', config.discordGuildID),
    roleIds: s('discord_role_ids', config.discordRoleIDs.join(',')).split(',').map((x) => x.trim()).filter(Boolean),
    botToken: s('discord_bot_token', config.discordBotToken),
  };
}

export function discordReady(): boolean {
  const d = discord();
  return !!(d.clientId && d.clientSecret && d.redirectURI && d.guildId);
}

export function bot(): { channelId: string; publicKey: string; dailyHour: number } {
  const h = Number(s('bot_daily_hour', '23'));
  return { channelId: s('bot_channel_id'), publicKey: s('discord_public_key'), dailyHour: Number.isInteger(h) && h >= -1 && h <= 23 ? h : 23 };
}

export function adminIds(): Set<string> {
  const ids = new Set(config.adminDiscordIDs);
  for (const x of s('admin_discord_ids').split(',')) if (x.trim()) ids.add(x.trim());
  return ids;
}

/** Public view for the admin settings page: secrets reduced to "is set". */
export function siteView() {
  const d = discord();
  return {
    publicURL: publicURL(),
    clientId: d.clientId,
    clientSecretSet: !!d.clientSecret,
    redirectURI: d.redirectURI,
    redirectOverride: d.redirectOverride,
    derivedRedirectURI: publicURL() ? publicURL() + '/auth/discord/callback' : '',
    guildId: d.guildId,
    roleIds: d.roleIds.join(','),
    botTokenSet: !!d.botToken,
    adminIds: [...adminIds()].join(','),
    botChannelId: bot().channelId,
    publicKey: bot().publicKey,
    dailyHour: bot().dailyHour,
    interactionsURL: publicURL() ? publicURL() + '/discord/interactions' : '',
  };
}

const ID_RE = /^\d{5,25}$/;
function idList(v: string): string {
  const ids = v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  for (const x of ids) if (!ID_RE.test(x)) throw new Error('invalid_id');
  return ids.join(',');
}

export function updateSite(p: Record<string, unknown>) {
  const get = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : undefined);
  const pub = get('publicURL');
  if (pub !== undefined) {
    if (pub && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(pub.replace(/\/+$/, ''))) throw new Error('invalid_public_url');
    setSetting('public_url', pub.replace(/\/+$/, ''));
  }
  const cid = get('clientId');
  if (cid !== undefined) {
    if (cid && !ID_RE.test(cid)) throw new Error('invalid_client_id');
    setSetting('discord_client_id', cid);
  }
  const sec = get('clientSecret');
  if (sec) setSetting('discord_client_secret', sec.slice(0, 200)); // empty = keep
  const red = get('redirectOverride');
  if (red !== undefined) {
    if (red && !/^https?:\/\/\S+$/i.test(red)) throw new Error('invalid_redirect_uri');
    setSetting('discord_redirect_uri', red);
  }
  const gid = get('guildId');
  if (gid !== undefined) {
    if (gid && !ID_RE.test(gid)) throw new Error('invalid_guild_id');
    setSetting('discord_guild_id', gid);
  }
  const roles = get('roleIds');
  if (roles !== undefined) setSetting('discord_role_ids', idList(roles));
  const bot = get('botToken');
  if (bot) setSetting('discord_bot_token', bot.slice(0, 200));
  if (p.clearBotToken === true) setSetting('discord_bot_token', '');
  const ch = get('botChannelId');
  if (ch !== undefined) {
    if (ch && !ID_RE.test(ch)) throw new Error('invalid_channel_id');
    setSetting('bot_channel_id', ch);
  }
  const pk = get('publicKey');
  if (pk !== undefined) {
    if (pk && !/^[0-9a-f]{64}$/i.test(pk)) throw new Error('invalid_public_key');
    setSetting('discord_public_key', pk.toLowerCase());
  }
  if (p.dailyHour !== undefined) {
    const h = Number(p.dailyHour);
    if (!Number.isInteger(h) || h < -1 || h > 23) throw new Error('invalid_daily_hour');
    setSetting('bot_daily_hour', String(h));
  }
  const admins = get('adminIds');
  if (admins !== undefined) setSetting('admin_discord_ids', idList(admins));
}

// ---------- one-time setup ----------
let setupToken: string | null = null;
const tokenFile = () => join(config.dataDir, 'setup-token');

export function setupDone(): boolean {
  return getSetting('setup_done') === '1';
}

export function initSetup() {
  if (setupDone()) {
    if (existsSync(tokenFile())) try { unlinkSync(tokenFile()); } catch {}
    return;
  }
  setupToken = token(24);
  writeFileSync(tokenFile(), setupToken + '\n', { mode: 0o600 });
  console.log(`[setup] first start: open ${publicURL() || ''}/setup and use the setup token: ${setupToken}`);
  console.log(`[setup] the token is also in ${tokenFile()} (mode 600)`);
}

export function checkSetupToken(t: string): boolean {
  return !setupDone() && !!setupToken && !!t && safeEqual(t, setupToken);
}

export function finishSetup() {
  setSetting('setup_done', '1');
  setupToken = null;
  try { unlinkSync(tokenFile()); } catch {}
}

export function hasAdmin(): boolean {
  return adminIds().size > 0 || !!one("SELECT 1 FROM users WHERE role = 'admin'");
}
