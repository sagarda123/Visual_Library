/**
 * Groww Visual Library server — static files + credential-gated session API.
 *
 * Zero dependencies (node:http/crypto/fs). Auth material lives in
 * auth.config.json (gitignored — create it with `node scripts/setup-auth.mjs`);
 * the client never sees credentials, only an HttpOnly HMAC-signed cookie.
 *
 *   node server.mjs            → http://localhost:8080
 *   PORT=9000 node server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const AUTH_CONFIG_PATH = path.join(ROOT, 'auth.config.json');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = 'gvl_session';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.riv': 'application/octet-stream',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* ── auth config ─────────────────────────────────────────────── */
function loadAuthConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
    if (cfg.username && cfg.salt && cfg.passwordHash && cfg.hmacSecret) return cfg;
  } catch (_) {}
  return null;
}
let authConfig = loadAuthConfig();
if (!authConfig) {
  console.warn('auth.config.json missing/invalid — /api/login disabled. Run: node scripts/setup-auth.mjs');
}

// Explicit scrypt cost params so hashes stay verifiable if Node's defaults
// ever change. Must match api/_auth.mjs and scripts/setup-auth.mjs.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
function scryptHash(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32, SCRYPT).toString('hex');
}
function safeEqual(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── sessions (stateless HMAC cookie) ────────────────────────── */
function sign(payload) {
  return crypto.createHmac('sha256', authConfig.hmacSecret).update(payload).digest('base64url');
}
function issueSessionCookie(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function verifySession(cookieHeader) {
  if (!authConfig) return null;
  const raw = (cookieHeader || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  const token = raw.slice(COOKIE_NAME.length + 1);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return { user: data.u };
  } catch (_) { return null; }
}

/* ── login rate limit (per-IP, in-memory) ────────────────────── */
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

/* ── helpers ─────────────────────────────────────────────────── */
function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const cookieFlags = 'HttpOnly; SameSite=Strict; Path=/';

/* ── API routes ──────────────────────────────────────────────── */
async function handleApi(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!authConfig) return json(res, 503, { error: 'Auth not configured on this server' });
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return json(res, 429, { error: 'Too many attempts — try again later' });
    let creds;
    try { creds = JSON.parse(await readBody(req)); } catch (_) { return json(res, 400, { error: 'Invalid request' }); }
    const { username, password } = creds || {};
    const okUser = typeof username === 'string' &&
      crypto.timingSafeEqual(Buffer.from(username.padEnd(256).slice(0, 256)), Buffer.from(authConfig.username.padEnd(256).slice(0, 256)));
    const okPass = typeof password === 'string' && safeEqual(scryptHash(password, authConfig.salt), authConfig.passwordHash);
    if (!okUser || !okPass) return json(res, 401, { error: 'Invalid credentials' });
    return json(res, 200, { user: authConfig.username }, {
      'Set-Cookie': `${COOKIE_NAME}=${issueSessionCookie(authConfig.username)}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieFlags}`,
    });
  }
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const session = verifySession(req.headers.cookie);
    return session ? json(res, 200, { user: session.user }) : json(res, 401, { error: 'Not authenticated' });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Max-Age=0; ${cookieFlags}` });
  }
  return json(res, 404, { error: 'Not found' });
}

/* ── static files ────────────────────────────────────────────── */
// Never serve these, whatever the path/casing. Matched case-insensitively
// because the filesystem (APFS) is case-insensitive: without this, a request
// for /AUTH.CONFIG.JSON resolves to the real file and leaks credentials.
const DENY_BASENAMES = new Set(['auth.config.json']);
const DENY_DIRS = ['scripts', 'api', 'node_modules', '.git'];

function serveStatic(req, res, url) {
  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(400).end('Bad request'); return; }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  const rel = path.relative(ROOT, filePath);
  const topDir = rel.split(path.sep)[0]?.toLowerCase();
  // Confine to ROOT, block the auth config (any casing), and never expose
  // server-side tooling directories.
  if (
    (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) ||
    DENY_BASENAMES.has(path.basename(filePath).toLowerCase()) ||
    DENY_DIRS.includes(topDir)
  ) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => json(res, 500, { error: 'Server error' }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('Method not allowed'); return; }
  serveStatic(req, res, url);
}).listen(PORT, () => {
  console.log(`Groww Visual Library at http://localhost:${PORT}/ (auth ${authConfig ? 'enabled' : 'DISABLED'})`);
});
