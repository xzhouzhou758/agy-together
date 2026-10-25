// Runtime configuration, read once from the environment.

const env = process.env;

function str(name: string, def = ''): string {
  const v = env[name];
  return v === undefined ? def : v.trim();
}
function int(name: string, def: number): number {
  const v = Number.parseInt(str(name), 10);
  return Number.isFinite(v) ? v : def;
}
function bool(name: string, def = false): boolean {
  const v = str(name).toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function list(name: string): string[] {
  return str(name).split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 8320),
  dataDir: str('DATA_DIR', './data'),
  publicURL: str('PUBLIC_URL', '').replace(/\/+$/, ''), // shown to users as the API base, e.g. https://pot.example.com
  basePath: str('BASE_PATH', '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/'), // e.g. /xgf when served under a sub-path
  cookieSecure: bool('COOKIE_SECURE', true),
  sessionDays: int('SESSION_DAYS', 14),
  trustProxy: bool('TRUST_PROXY', true),

  // CLIProxyAPI
  cpaURL: str('CPA_URL', 'http://127.0.0.1:8317').replace(/\/+$/, ''),
  cpaAPIKey: str('CPA_API_KEY'),
  cpaMgmtKey: str('CPA_MANAGEMENT_KEY'),
  pluginID: str('CPA_PLUGIN_ID', 'agy-scheduler'),
  allowHeader: str('ALLOW_HEADER', 'X-Agy-Allow'),
  pluginCacheMs: int('PLUGIN_CHECK_CACHE_MS', 3000),
  usagePollMs: int('USAGE_POLL_MS', 3000),

  // Quota (upstream calls go through CPA /requests/api-call)
  quotaBaseURL: str('QUOTA_BASE_URL', 'https://daily-cloudcode-pa.googleapis.com').replace(/\/+$/, ''),
  quotaUserAgent: str('QUOTA_USER_AGENT', 'antigravity/hub/2.26.0 (aidev_client; os_type=darwin; arch=arm64)'),
  quotaRefreshMinutes: int('QUOTA_REFRESH_MINUTES', 15), // background refresh of every owned account; 0 = off

  // Discord
  discordClientID: str('DISCORD_CLIENT_ID'),
  discordClientSecret: str('DISCORD_CLIENT_SECRET'),
  discordRedirectURI: str('DISCORD_REDIRECT_URI'),
  discordGuildID: str('DISCORD_GUILD_ID'),
  discordRoleIDs: list('DISCORD_ROLE_IDS'),
  discordBotToken: str('DISCORD_BOT_TOKEN'),
  roleRecheckMinutes: int('ROLE_RECHECK_MINUTES', 30),
  adminDiscordIDs: new Set(list('ADMIN_DISCORD_IDS')),

  devLogin: bool('DEV_LOGIN', false),

  maxBodyBytes: int('MAX_BODY_MB', 50) * 1024 * 1024,
  usageRetentionDays: int('USAGE_RETENTION_DAYS', 90),
};

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

export function validateConfig(): string[] {
  const errs: string[] = [];
  if (!config.cpaAPIKey) errs.push('CPA_API_KEY is required');
  if (!config.cpaMgmtKey) errs.push('CPA_MANAGEMENT_KEY is required');
  if (config.devLogin && !isLoopback(config.host)) errs.push('DEV_LOGIN=1 refuses to start on a non-loopback HOST');
  return errs;
}
