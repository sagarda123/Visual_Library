/**
 * Shared auth helpers for the Vercel serverless API (api/login|session|logout).
 * Mirrors server.mjs (local dev server) — same cookie format, same scrypt
 * verification. Credentials come from Vercel env vars, never from the repo:
 *
 *   AUTH_USERNAME       maintainer username
 *   AUTH_SALT           hex salt for scrypt
 *   AUTH_PASSWORD_HASH  hex scrypt hash of the password
 *   AUTH_HMAC_SECRET    hex secret signing session cookies
 *
 * Provision with scripts/setup-vercel-env.sh (reads local auth.config.json).
 */
import crypto from 'node:crypto';

export const COOKIE_NAME = 'gvl_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export function authConfig() {
  const { AUTH_USERNAME, AUTH_SALT, AUTH_PASSWORD_HASH, AUTH_HMAC_SECRET } = process.env;
  if (!AUTH_USERNAME || !AUTH_SALT || !AUTH_PASSWORD_HASH || !AUTH_HMAC_SECRET) return null;
  return { username: AUTH_USERNAME, salt: AUTH_SALT, passwordHash: AUTH_PASSWORD_HASH, hmacSecret: AUTH_HMAC_SECRET };
}

// Must match server.mjs and scripts/setup-auth.mjs so a hash made by one
// verifies under the others.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export function verifyCredentials(cfg, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const pad = (s) => Buffer.from(String(s).padEnd(256).slice(0, 256));
  const okUser = crypto.timingSafeEqual(pad(username), pad(cfg.username));
  const hash = crypto.scryptSync(password, Buffer.from(cfg.salt, 'hex'), 32, SCRYPT);
  const expected = Buffer.from(cfg.passwordHash, 'hex');
  const okPass = hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  return okUser && okPass;
}

const sign = (cfg, payload) => crypto.createHmac('sha256', cfg.hmacSecret).update(payload).digest('base64url');

export function issueSessionCookie(cfg) {
  const payload = Buffer.from(JSON.stringify({ u: cfg.username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${COOKIE_NAME}=${payload}.${sign(cfg, payload)}; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

export const clearSessionCookie = () => `${COOKIE_NAME}=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/`;

export function verifySession(cfg, cookieHeader) {
  const raw = (cookieHeader || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  const token = raw.slice(COOKIE_NAME.length + 1);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(cfg, payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return { user: data.u };
  } catch (_) { return null; }
}
