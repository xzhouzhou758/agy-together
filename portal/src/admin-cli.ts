// Create (or reset) a password admin from the command line, for installs without Discord login.
// Reads two lines from stdin: username, password. Also closes the one-time /setup page.
//   printf '%s\n%s\n' admin 'secret' | docker compose run --rm -T agy-pot node src/admin-cli.ts
import { one, run, now } from './db.ts';
import { hashPassword } from './util.ts';
import { finishSetup } from './site.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const [rawUser = '', pw = ''] = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
const username = rawUser.trim().toLowerCase();
if (!/^[a-z0-9_.-]{3,32}$/.test(username)) { console.error('username: 3-32 chars of a-z 0-9 _ . -'); process.exit(2); }
if (pw.length < 8 || pw.length > 128) { console.error('password: 8-128 chars'); process.exit(2); }

const u = one('SELECT id FROM users WHERE username = ? OR discord_id = ?', username, 'local:' + username);
if (u) {
  run("UPDATE users SET pass_hash = ?, role = 'admin', active = 1, disabled_reason = NULL WHERE id = ?", hashPassword(pw), u.id);
  run('DELETE FROM sessions WHERE user_id = ?', u.id);
  console.log(`admin "${username}" updated`);
} else {
  run("INSERT INTO users(discord_id, name, handle, role, username, pass_hash, created_at) VALUES(?,?,?,'admin',?,?,?)",
    'local:' + username, username, username, username, hashPassword(pw), now());
  console.log(`admin "${username}" created`);
}
finishSetup();
