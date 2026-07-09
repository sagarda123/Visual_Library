/**
 * One-time auth provisioning for server.mjs.
 *
 *   node scripts/setup-auth.mjs <username> <password>
 *
 * Writes auth.config.json (repo root) with a scrypt password hash, random
 * salt, and random HMAC session secret. The file must stay gitignored — the
 * script refuses to write if git tracks it. The password itself is never
 * stored or logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'auth.config.json');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/setup-auth.mjs <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

// Refuse if git would ever commit this file.
try {
  execFileSync('git', ['check-ignore', '-q', OUT], { cwd: ROOT });
} catch (_) {
  console.error('Refusing: auth.config.json is not gitignored. Add it to .gitignore first.');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
// Explicit params — must match server.mjs and api/_auth.mjs.
const passwordHash = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
const hmacSecret = crypto.randomBytes(32).toString('hex');

fs.writeFileSync(OUT, JSON.stringify({ username, salt, passwordHash, hmacSecret }, null, 2), { mode: 0o600 });
console.log(`auth.config.json written for user "${username}" (password hashed, not stored).`);
