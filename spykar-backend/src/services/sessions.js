// ─── Server-side sessions ────────────────────────────────────────────────────
//
// One auth_sessions row per signed-in device (migration 029).
//
//   access token   JWT, 15 min, carries sid → every request checks the session
//                  is live, so logout / revoke / deactivation bite immediately.
//   refresh token  opaque 64-byte random, stored only as a SHA-256 hash, sent
//                  as an httpOnly + SameSite=Strict (+ Secure over HTTPS)
//                  cookie scoped to /api/v1/auth — JavaScript never sees it.
//
//   idle timeout      slides forward on every refresh → an active user is
//                     never cut off (SESSION_IDLE_HOURS, default 24).
//   absolute lifetime hard cap from sign-in (SESSION_ABSOLUTE_DAYS, default 30).
//
//   rotation   every refresh swaps the refresh token; the old row is kept with
//              rotated_at.
//   grace      the SAME old token presented within SESSION_ROTATION_GRACE_SEC
//              (default 60) is a benign race — two tabs / a retried request —
//              and gets a fresh access token for the same session.
//   reuse      presented AFTER the grace window it can only be a copy — the
//              whole session is revoked and a security event is logged.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query, transaction } = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');

const HOUR = 3600 * 1000;
const IDLE_MS = (parseFloat(process.env.SESSION_IDLE_HOURS) || 24) * HOUR;
const ABSOLUTE_MS = (parseFloat(process.env.SESSION_ABSOLUTE_DAYS) || 30) * 24 * HOUR;
const GRACE_MS = (parseInt(process.env.SESSION_ROTATION_GRACE_SEC, 10) || 60) * 1000;
const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRY || '15m';

const COOKIE = 'spk_rt';
const COOKIE_PATH = '/api/v1/auth';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newRefreshToken = () => crypto.randomBytes(64).toString('hex');
const clientIp = (req) => req.ip || null;
const clientUa = (req) => String(req.headers['user-agent'] || '').slice(0, 300) || null;

// Explicit ids only — never infer from a row object (a refresh_tokens row's own
// `id` is NOT the user id; that mix-up would sign users out at the first refresh).
function signAccess(userId, role, sid) {
  if (!userId || !sid) throw new Error('signAccess: userId and sid are required');
  return jwt.sign({ userId, role, sid }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

// ── Cookie I/O (no cookie-parser dependency) ─────────────────────────────────
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
// Cookie first; body token only for tabs still running the pre-cookie build.
function readRefreshToken(req) {
  const c = readCookie(req, COOKIE);
  if (c) return c;
  const b = req.body && req.body.refreshToken;
  return typeof b === 'string' && b.length >= 32 && b !== 'undefined' ? b : null;
}
function setRefreshCookie(req, res, token, expiresAt) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: req.secure,            // true behind nginx (X-Forwarded-Proto: https)
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}
function clearRefreshCookie(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: req.secure, sameSite: 'strict', path: COOKIE_PATH });
}

const sessionEnded = (code, message) => new AppError(message, 401, code);
// One device per login: a new sign-in ends the older session with this reason.
const REPLACED = 'signed_in_elsewhere';
const replacedError = () => sessionEnded('SESSION_REPLACED', 'You were signed in on another device.');

// ── Create (login) ───────────────────────────────────────────────────────────
async function createSession(client, user, req) {
  // Serialise sign-ins of the same user, so two at once can't both stay live.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('auth_session:' || $1::text))", [user.id]);
  const now = Date.now();
  const absolute = new Date(now + ABSOLUTE_MS);
  const idle = new Date(Math.min(now + IDLE_MS, absolute.getTime()));
  const s = (await client.query(
    `INSERT INTO auth_sessions (user_id, idle_expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, idle_expires_at, absolute_expires_at`,
    [user.id, idle, absolute, clientIp(req), clientUa(req)])).rows[0];
  // One device per login: every other live session of this user ends now.
  await client.query(
    'UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = $3 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
    [user.id, s.id, REPLACED]);
  const refresh = newRefreshToken();
  await client.query(
    'INSERT INTO refresh_tokens (user_id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [user.id, s.id, sha256(refresh), idle]);
  // Housekeeping for this user: rows of sessions that are over.
  await client.query(
    `DELETE FROM auth_sessions WHERE user_id = $1
       AND (revoked_at < NOW() - INTERVAL '30 days' OR absolute_expires_at < NOW() - INTERVAL '30 days' OR idle_expires_at < NOW() - INTERVAL '30 days')`,
    [user.id]);
  return { session: s, refresh, accessToken: signAccess(user.id, user.role, s.id) };
}

// ── Refresh (rotate) ─────────────────────────────────────────────────────────
// Returns { accessToken, refresh|null, session }. refresh === null means the
// grace path: the caller keeps the cookie it already has.
async function rotate(presented, req) {
  if (!presented) throw sessionEnded('SESSION_MISSING', 'No session. Please sign in.');
  const hash = sha256(presented);
  const out = await transaction(async (client) => {
    const rt = (await client.query(
      `SELECT rt.id, rt.user_id, rt.session_id, rt.rotated_at, rt.expires_at, u.role, u.is_active
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
        FOR UPDATE OF rt`, [hash])).rows[0];
    if (!rt) return { error: sessionEnded('SESSION_INVALID', 'Session not recognised. Please sign in.') };

    // A token issued before migration 029 got its session there; one minted by
    // an old API build in between gets one now — nobody is logged out.
    let sid = rt.session_id;
    if (!sid) {
      const now = Date.now();
      sid = (await client.query(
        `INSERT INTO auth_sessions (user_id, idle_expires_at, absolute_expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [rt.user_id, new Date(now + IDLE_MS), new Date(now + ABSOLUTE_MS), clientIp(req), clientUa(req)])).rows[0].id;
      await client.query('UPDATE refresh_tokens SET session_id = $1 WHERE id = $2', [sid, rt.id]);
    }
    const s = (await client.query('SELECT * FROM auth_sessions WHERE id = $1 FOR UPDATE', [sid])).rows[0];
    const revoke = (reason) => client.query(
      'UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sid, reason]);

    if (!rt.is_active) { await revoke('account_disabled'); return { error: sessionEnded('ACCOUNT_DISABLED', 'This account has been deactivated.') }; }
    if (s.revoked_at && s.revoke_reason === REPLACED) return { error: replacedError() };
    if (s.revoked_at) return { error: sessionEnded('SESSION_REVOKED', 'This session was signed out. Please sign in again.') };
    const now = new Date();
    if (s.absolute_expires_at <= now) { await revoke('absolute_expiry'); return { error: sessionEnded('SESSION_EXPIRED', 'Your session reached its maximum length. Please sign in again.') }; }
    if (s.idle_expires_at <= now) { await revoke('idle_expiry'); return { error: sessionEnded('SESSION_IDLE', 'You were signed out after a period of inactivity.') }; }

    if (rt.rotated_at) {
      if (now - rt.rotated_at <= GRACE_MS) {
        // Benign race (another tab / a retried request) — same session, new access token.
        return { accessToken: signAccess(rt.user_id, rt.role, sid), refresh: null, session: s };
      }
      await revoke('refresh_token_reuse');
      logger.warn(`[SECURITY] refresh-token REUSE detected — session ${sid} of user ${rt.user_id} revoked (ip ${clientIp(req)}, ua ${clientUa(req)})`);
      return { error: sessionEnded('SESSION_REVOKED', 'For your security this session was signed out. Please sign in again.') };
    }

    const idle = new Date(Math.min(Date.now() + IDLE_MS, new Date(s.absolute_expires_at).getTime()));
    const refresh = newRefreshToken();
    await client.query('UPDATE refresh_tokens SET rotated_at = NOW() WHERE id = $1', [rt.id]);
    await client.query(
      'INSERT INTO refresh_tokens (user_id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [rt.user_id, sid, sha256(refresh), idle]);
    const upd = (await client.query(
      `UPDATE auth_sessions SET last_seen_at = NOW(), idle_expires_at = $2, ip = $3, user_agent = COALESCE($4, user_agent)
        WHERE id = $1 RETURNING *`,
      [sid, idle, clientIp(req), clientUa(req)])).rows[0];
    return { accessToken: signAccess(rt.user_id, rt.role, sid), refresh, session: upd };
  });
  if (out.error) throw out.error;
  return out;
}

// ── Revoke ───────────────────────────────────────────────────────────────────
async function revokeSession(sid, reason, userId = null) {
  const r = await query(
    `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = $2
      WHERE id = $1 AND revoked_at IS NULL ${userId ? 'AND user_id = $3' : ''} RETURNING id`,
    userId ? [sid, reason, userId] : [sid, reason]);
  return r.rowCount;
}
async function revokeUserSessions(client, userId, reason, exceptSid = null) {
  const r = await client.query(
    `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [userId, reason, exceptSid]);
  // Tokens minted before migration 029 carry no session row — drop them too.
  await client.query(
    'DELETE FROM refresh_tokens WHERE user_id = $1 AND (session_id IS NULL OR session_id IN (SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL))',
    [userId]);
  return r.rowCount;
}

async function listSessions(userId) {
  return (await query(
    `SELECT id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, ip, user_agent
       FROM auth_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND idle_expires_at > NOW() AND absolute_expires_at > NOW()
      ORDER BY last_seen_at DESC`, [userId])).rows;
}

// Super Admin "Sessions" tab: one row per user (Super Admins are never listed) — the live session (if any)
// plus 7-day sign-in counts, which show a login being shared around.
async function overview() {
  return (await query(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login_at,
            cur.created_at AS signed_in_at, cur.last_seen_at, cur.ip, cur.user_agent,
            st.logins_7d, st.ips_7d, st.replaced_7d
       FROM users u
       LEFT JOIN LATERAL (
         SELECT created_at, last_seen_at, ip, user_agent FROM auth_sessions s
          WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.idle_expires_at > NOW() AND s.absolute_expires_at > NOW()
          ORDER BY s.created_at DESC LIMIT 1) cur ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS logins_7d, COUNT(DISTINCT s.ip)::int AS ips_7d,
                COUNT(*) FILTER (WHERE s.revoke_reason = $1)::int AS replaced_7d
           FROM auth_sessions s WHERE s.user_id = u.id AND s.created_at > NOW() - INTERVAL '7 days') st ON true
      WHERE u.role <> 'SUPER_ADMIN'
      ORDER BY (cur.created_at IS NULL), cur.last_seen_at DESC NULLS LAST, u.name`, [REPLACED])).rows;
}

module.exports = {
  REPLACED, overview,
  COOKIE, COOKIE_PATH, IDLE_MS, ABSOLUTE_MS, GRACE_MS, ACCESS_TOKEN_EXPIRY,
  sha256, readRefreshToken, setRefreshCookie, clearRefreshCookie,
  createSession, rotate, revokeSession, revokeUserSessions, listSessions,
};
