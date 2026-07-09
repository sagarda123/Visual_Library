import { authConfig, verifyCredentials, issueSessionCookie } from './_auth.mjs';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const cfg = authConfig();
  if (!cfg) return res.status(503).json({ error: 'Auth not configured on this server' });
  // @vercel/node only auto-parses JSON when Content-Type is application/json;
  // otherwise req.body is a string/Buffer/undefined. Normalize before reading.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid request' });
  const { username, password } = body;
  if (!verifyCredentials(cfg, username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.setHeader('Set-Cookie', issueSessionCookie(cfg));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ user: cfg.username });
}
