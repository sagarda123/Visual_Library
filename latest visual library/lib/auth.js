/**
 * Client session helper for the upload/delete gate.
 *
 * Talks to server.mjs (/api/login, /api/session, /api/logout). Credentials are
 * verified server-side only; the browser holds an HttpOnly session cookie it
 * cannot read. On static hosting (no backend) every call reports
 * { available: false } and gated actions stay disabled.
 *
 * Note: library data lives in each visitor's IndexedDB, so this gate protects
 * the curated publishing workflow — it is not cryptographic protection of the
 * assets themselves.
 */

let sessionCache; // Promise<{available, user}>

async function fetchSession() {
  try {
    const r = await fetch('/api/session', { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { available: false, user: null };
    if (r.ok) {
      const data = await r.json();
      return { available: true, user: data.user || null };
    }
    return { available: r.status === 401, user: null };
  } catch (_) {
    return { available: false, user: null };
  }
}

export function getSession(force = false) {
  if (!sessionCache || force) sessionCache = fetchSession();
  return sessionCache;
}

export async function login(username, password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.error || 'Login failed');
  sessionCache = Promise.resolve({ available: true, user: data.user });
  notify();
  return data.user;
}

export async function logout() {
  // Only clear the cached session once the server confirms the cookie is gone —
  // otherwise the UI shows "logged out" while the session is still valid.
  try {
    const r = await fetch('/api/logout', { method: 'POST' });
    if (r.ok) sessionCache = Promise.resolve({ available: true, user: null });
    else sessionCache = getSession(true);
  } catch (_) {
    sessionCache = getSession(true);
  }
  notify();
}

const listeners = new Set();
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { getSession().then((s) => listeners.forEach((fn) => fn(s))); }

/* ── login modal ─────────────────────────────────────────────── */
const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ensureModal() {
  let root = document.getElementById('gvl-login');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'gvl-login';
  root.className = 'rv-modal hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Sign in');
  root.innerHTML = `
    <div class="rv-modal-card" style="max-width:380px">
      <div class="rv-modal-head">
        <h2 class="heading-small">Restricted action</h2>
        <button class="rv-icon-btn" id="gvl-login-close" aria-label="Close">✕</button>
      </div>
      <div class="rv-modal-body">
        <p class="body-small" style="color:var(--contentSecondary);margin:0 0 12px">Uploading and deleting assets requires maintainer credentials.</p>
        <div class="rv-field"><label>Username</label><input class="rv-input" id="gvl-login-user" autocomplete="username"></div>
        <div class="rv-field"><label>Password</label><input class="rv-input" id="gvl-login-pass" type="password" autocomplete="current-password"></div>
        <div class="body-small" id="gvl-login-err" style="color:var(--contentNegative);min-height:18px;margin-top:8px"></div>
        <button class="rv-btn rv-btn-accent" id="gvl-login-submit" style="width:100%;margin-top:4px">Sign in</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  return root;
}

/**
 * Run `onAuthed` if a session exists; otherwise show the login modal and run
 * it after a successful sign-in. No-ops with a message when no backend exists.
 */
export async function requireAuth(onAuthed, { toast } = {}) {
  const say = toast || (() => {});
  const session = await getSession();
  if (!session.available) { say('Requires the library server (auth API unavailable)', 'err'); return; }
  if (session.user) { onAuthed(); return; }

  const root = ensureModal();
  const err = root.querySelector('#gvl-login-err');
  const userEl = root.querySelector('#gvl-login-user');
  const passEl = root.querySelector('#gvl-login-pass');
  err.textContent = '';
  passEl.value = '';
  root.classList.remove('hidden');
  root.setAttribute('aria-hidden', 'false');
  setTimeout(() => userEl.focus(), 0);

  const close = () => { root.classList.add('hidden'); root.setAttribute('aria-hidden', 'true'); cleanup(); };
  const submit = async () => {
    err.textContent = '';
    try {
      await login(userEl.value.trim(), passEl.value);
      close();
      onAuthed();
    } catch (e) {
      err.textContent = escAttr(e.message);
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.target === userEl || e.target === passEl)) submit();
  };
  function cleanup() {
    root.removeEventListener('keydown', onKey, true);
    root.querySelector('#gvl-login-submit').onclick = null;
    root.querySelector('#gvl-login-close').onclick = null;
    root.onclick = null;
  }
  root.addEventListener('keydown', onKey, true);
  root.querySelector('#gvl-login-submit').onclick = submit;
  root.querySelector('#gvl-login-close').onclick = close;
  root.onclick = (e) => { if (e.target === root) close(); };
}

// Bridge for the non-module app.js IIFE.
window.GVLAuth = { getSession, login, logout, requireAuth, onAuthChange };
