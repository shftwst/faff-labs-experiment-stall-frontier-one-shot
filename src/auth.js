'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { db } = require('./db');

const SESSION_COOKIE = 'stall_session';
const SESSION_DAYS = 30;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function createSession(memberId) {
  const token = 'st_' + crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)'
  ).run(sha256(token), memberId, expires);
  return token;
}

function memberForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
       WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .get(sha256(token));
  return row || null;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Attaches req.member (or null). Accepts the session cookie (browser) or an
// Authorization: Bearer token (API clients and the harness).
function sessionMiddleware(req, res, next) {
  let token = parseCookies(req)[SESSION_COOKIE] || null;
  const auth = req.headers.authorization;
  if (!token && auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  req.member = memberForToken(token);
  next();
}

function requireAuth(req, res, next) {
  if (!req.member) return res.status(401).json({ error: 'authentication required' });
  next();
}

function setSessionCookie(res, token) {
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function upsertGithubMember(ghUser) {
  const existing = db.prepare('SELECT * FROM members WHERE github_id = ?').get(ghUser.id);
  if (existing) {
    db.prepare('UPDATE members SET display_name = ?, avatar_url = ? WHERE id = ?').run(
      ghUser.name || ghUser.login,
      ghUser.avatar_url || null,
      existing.id
    );
    return db.prepare('SELECT * FROM members WHERE id = ?').get(existing.id);
  }
  let login = ghUser.login;
  if (db.prepare('SELECT 1 FROM members WHERE login = ?').get(login)) {
    login = `${login}-gh${ghUser.id}`;
  }
  const info = db
    .prepare(
      'INSERT INTO members (github_id, login, display_name, avatar_url) VALUES (?, ?, ?, ?)'
    )
    .run(ghUser.id, login, ghUser.name || ghUser.login, ghUser.avatar_url || null);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
}

const router = express.Router();

// --- GitHub OAuth (device authorization grant, RFC 8628). No passwords are
// ever collected or stored; we never persist the GitHub access token either —
// it is used once to read the public identity, then discarded.

router.post('/api/auth/device/start', async (req, res) => {
  try {
    const r = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.github.clientId, scope: '' }),
    });
    const data = await r.json();
    if (!data.device_code) {
      return res.status(502).json({ error: 'github device flow unavailable', detail: data });
    }
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare(
      'INSERT INTO device_logins (id, device_code, interval_s) VALUES (?, ?, ?)'
    ).run(id, data.device_code, data.interval || 5);
    res.json({
      login_id: id,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval || 5,
    });
  } catch (e) {
    res.status(502).json({ error: 'github unreachable' });
  }
});

router.post('/api/auth/device/poll', async (req, res) => {
  const { login_id } = req.body || {};
  const row = db.prepare('SELECT * FROM device_logins WHERE id = ?').get(login_id || '');
  if (!row) return res.status(404).json({ error: 'unknown login attempt' });
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.github.clientId,
        device_code: row.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await r.json();
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      return res.json({ status: 'pending' });
    }
    if (!data.access_token) {
      db.prepare('DELETE FROM device_logins WHERE id = ?').run(login_id);
      return res.json({ status: 'failed', reason: data.error || 'unknown' });
    }
    const ur = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}`, 'User-Agent': 'stall' },
    });
    const ghUser = await ur.json();
    db.prepare('DELETE FROM device_logins WHERE id = ?').run(login_id);
    if (!ghUser.id) return res.json({ status: 'failed', reason: 'github user fetch failed' });
    const member = upsertGithubMember(ghUser);
    const token = createSession(member.id);
    setSessionCookie(res, token);
    res.json({ status: 'ok', member: { id: member.id, login: member.login } });
  } catch (e) {
    res.status(502).json({ error: 'github unreachable' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// --- Harness auth: mints sessions for synthetic members so the verification
// harness can act as real, distinct authenticated members over the public API.
// Disabled entirely unless HARNESS_SECRET is configured; the secret never
// grants access to any human member's account (github_id IS NULL enforced).

router.post('/api/harness/login', (req, res) => {
  if (!config.harnessSecret) return res.status(404).json({ error: 'not found' });
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(sha256(presented));
  const b = Buffer.from(sha256(config.harnessSecret));
  if (!crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'forbidden' });
  const name = String((req.body || {}).name || '').toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(name)) {
    return res.status(400).json({ error: 'name must be [a-z0-9-]{1,40}' });
  }
  const login = `harness-${name}`;
  let member = db.prepare('SELECT * FROM members WHERE login = ? AND is_harness = 1').get(login);
  if (!member) {
    const info = db
      .prepare(
        "INSERT INTO members (github_id, login, display_name, is_harness) VALUES (NULL, ?, ?, 1)"
      )
      .run(login, `Harness ${name}`);
    member = db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
  }
  const token = createSession(member.id);
  res.json({ token, member: { id: member.id, login: member.login } });
});

module.exports = { router, sessionMiddleware, requireAuth, createSession, setSessionCookie };
