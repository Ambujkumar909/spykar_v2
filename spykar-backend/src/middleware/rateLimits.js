// ─── Rate limiting — the application layer ────────────────────────────────────
//
// Two layers protect the API:
//   1. nginx (edge)  — per-IP flood shield + login throttle, BEFORE Node runs.
//                      Generous on purpose: a whole office shares one public IP.
//   2. this module   — business limits keyed by WHO is calling:
//        • signed-in requests → the user id from the JWT (signature verified;
//          an expired-but-genuine token still identifies its user), so
//          colleagues behind one office IP never throttle each other;
//        • anonymous requests → the client IP (real IP: app trusts
//          X-Forwarded-For from loopback only, see app.js).
//
// Every 429 has one shape — { success:false, code:'RATE_LIMITED', message,
// retryAfter } — plus Retry-After and IETF RateLimit headers, and is logged.
//
// Store: in-process memory. Correct for the single fork-mode API process
// (ecosystem.config.js). Scaling to several instances needs a shared store —
// warned at startup below.

const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

const MIN = 60 * 1000;

// Who is calling: 'u:<userId>' for a genuinely signed token, else 'ip:<ip>'.
// Cached on the request so every limiter verifies the token at most once.
function identity(req) {
  if (req._rlIdentity) return req._rlIdentity;
  let id = `ip:${req.ip}`;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const d = jwt.verify(h.slice(7), process.env.JWT_SECRET, { ignoreExpiration: true });
      if (d && d.userId) id = `u:${d.userId}`;
    } catch (_) { /* forged / malformed → treated as anonymous */ }
  }
  req._rlIdentity = id;
  return id;
}
const isUser = (req) => identity(req).startsWith('u:');

// Health probes and CORS preflights never count.
const exempt = (req) => req.method === 'OPTIONS' || req.path === '/health' || req.path === '/health/deep';

function limiter(name, { windowMs, max, key = identity, message, skip, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit: max,
    keyGenerator: (req) => `${name}|${key(req)}`,
    standardHeaders: 'draft-7',   // RateLimit + RateLimit-Policy
    legacyHeaders: false,
    skipSuccessfulRequests,
    skip: (req) => exempt(req) || (skip ? skip(req) : false),
    handler: (req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)) || Math.ceil(options.windowMs / 1000);
      res.set('Retry-After', String(retryAfter));
      logger.warn(`[RATE-LIMIT] ${name} blocked ${identity(req)} ${req.method} ${req.originalUrl} (limit ${req.rateLimit.limit}/${Math.round(options.windowMs / 1000)}s)`);
      res.status(429).json({ success: false, code: 'RATE_LIMITED', message, retryAfter });
    },
  });
}

// ── General API ──────────────────────────────────────────────────────────────
// A dashboard page fires ~20-30 calls; filter clicking multiplies that.
// Login and token refresh are anonymous by nature and have their OWN limiters
// below; counting them here too would lock an office out at 9:30 AM when
// dozens of people behind one IP sign in within the same minute.
const AUTH_OWN_LIMITS = new Set(['/api/v1/auth/login', '/api/v1/auth/refresh']);
const hasOwnLimits = (req) => AUTH_OWN_LIMITS.has(req.path);
const burst = limiter('burst', {
  windowMs: 1 * MIN,
  max: (req) => (isUser(req) ? 300 : 60),
  skip: hasOwnLimits,
  message: 'Too many requests in a short time. Please wait a few seconds.',
});
const sustained = limiter('sustained', {
  windowMs: 15 * MIN,
  max: (req) => (isUser(req) ? 3000 : 300),
  skip: hasOwnLimits,
  message: 'Too many requests. Please try again in a few minutes.',
});

// ── Authentication ───────────────────────────────────────────────────────────
// Only FAILED logins count, so an office logging in each morning never trips it.
// 100 FAILED logins / 15 min per IP: high enough that typos (or one broken
// script) behind an office IP can never lock the whole office out; the
// per-account lock below (5 failures) is what stops password guessing.
const loginByIp = limiter('login-ip', {
  windowMs: 15 * MIN,
  max: 100,
  key: (req) => `ip:${req.ip}`,
  skipSuccessfulRequests: true,
  message: 'Too many failed login attempts from this network. Please try again in 15 minutes.',
});
const loginByAccount = limiter('login-account', {
  windowMs: 15 * MIN,
  max: 5,
  key: (req) => `acct:${String((req.body && req.body.email) || '').trim().toLowerCase() || req.ip}`,
  skipSuccessfulRequests: true,
  message: 'Too many failed attempts for this account. Please try again in 15 minutes.',
});
// Refresh is keyed per SESSION (hash of the presented refresh token), not per
// IP — an office of many users × tabs refreshing every 15 min must never trip
// it. A normal session refreshes ~4×/hour; 30 per 15 min per token is a
// hammering client. The per-IP ceiling only stops token-guessing floods.
const { readRefreshToken, sha256 } = require('../services/sessions');
// A refresh WITHOUT a token fails at once (401, no DB work) — it must not
// share a small per-IP bucket, or the 31st cookie-less person behind an
// office IP would get 429 instead of a clean "please sign in".
const refreshPerSession = limiter('refresh-session', {
  windowMs: 15 * MIN,
  max: 30,
  key: (req) => `rt:${sha256(readRefreshToken(req)).slice(0, 32)}`,
  skip: (req) => !readRefreshToken(req),
  message: 'Too many session refreshes. Please wait a moment.',
});
const refreshPerIp = limiter('refresh-ip', {
  windowMs: 15 * MIN,
  max: 2000,
  key: (req) => `ip:${req.ip}`,
  message: 'Too many session refreshes from this network. Please wait a moment.',
});
const refresh = [refreshPerIp, refreshPerSession];

// ── Expensive endpoints ──────────────────────────────────────────────────────
const ai = limiter('ai', { windowMs: 1 * MIN, max: 30, message: 'AI query limit reached. Please wait a moment.' });
const exportCsv = limiter('export', { windowMs: 1 * MIN, max: 10, message: 'Too many exports. Please wait a minute.' });
const syncTrigger = limiter('sync-trigger', {
  windowMs: 15 * MIN,
  max: 5,
  skip: (req) => req.method !== 'POST',
  message: 'Sync was triggered several times already. Please wait for the running sync.',
});

if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') {
  logger.warn('[RATE-LIMIT] running as one of several instances — in-memory limits are per instance; use a shared store');
}

module.exports = { identity, burst, sustained, loginByIp, loginByAccount, refresh, ai, exportCsv, syncTrigger };
