const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// Logged-out access tokens, until they would have expired anyway. Kept OUT of
// the response cache on purpose: that cache is flushed after every sync
// (4×/day), which silently re-validated logged-out tokens.
// ponytail: in-process only — a restart forgets them; access tokens live 15 min.
const revoked = new Map();   // token -> expiresAtMs
function revokeAccessToken(token, ttlSec) {
  revoked.set(token, Date.now() + ttlSec * 1000);
  if (revoked.size > 5000) for (const [t, exp] of revoked) if (exp <= Date.now()) revoked.delete(t);
}
function isRevoked(token) {
  const exp = revoked.get(token);
  if (exp === undefined) return false;
  if (exp <= Date.now()) { revoked.delete(token); return false; }
  return true;
}
const logger = require('../config/logger');
const { AppError } = require('./errorHandler');
const license = require('../services/license');

/**
 * Verify JWT access token and attach user to request
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication required. Please provide a valid token.', 401, 'TOKEN_MISSING');
    }

    const token = authHeader.split(' ')[1];

    // Check if token is blacklisted (logged out)
    if (isRevoked(token)) {
      throw new AppError('Token has been invalidated. Please log in again.', 401, 'SESSION_REVOKED');
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new AppError('Token expired. Please refresh your session.', 401, 'TOKEN_EXPIRED');
      }
      throw new AppError('Invalid token. Please log in again.', 401, 'TOKEN_INVALID');
    }

    // Fresh user + (for session tokens) the session, in ONE query: a
    // deactivated user or an ended session is refused on the very next request.
    // Tokens without sid were minted before server-side sessions existed and
    // expire within 15 min on their own.
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active,
              s.id AS sid, s.revoked_at, s.revoke_reason, s.absolute_expires_at
         FROM users u
         LEFT JOIN auth_sessions s ON s.id = $2::uuid AND s.user_id = u.id
        WHERE u.id = $1`,
      [decoded.userId, decoded.sid || null]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      throw new AppError('User account not found or deactivated.', 401, 'ACCOUNT_DISABLED');
    }
    const row = result.rows[0];
    if (decoded.sid && row.revoked_at && row.revoke_reason === 'signed_in_elsewhere') {
      throw new AppError('You were signed in on another device.', 401, 'SESSION_REPLACED');
    }
    if (decoded.sid && (!row.sid || row.revoked_at || new Date(row.absolute_expires_at) <= new Date())) {
      throw new AppError('This session has ended. Please sign in again.', 401, 'SESSION_REVOKED');
    }
    req.sessionId = decoded.sid || null;
    delete row.sid; delete row.revoked_at; delete row.revoke_reason; delete row.absolute_expires_at;

    req.user = result.rows[0];
    req.token = token;
    // Licence: no valid licence or no seat → refused (Super Admins always pass).
    const block = await license.gate(req.user, req.originalUrl);
    if (block) throw new AppError(block.message, block.status, block.code);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Authorize by roles
 * @param {...string} roles - Allowed roles
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required.', 401));
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(`Unauthorized access attempt by ${req.user.email} (role: ${req.user.role}) to ${req.path}`);
      return next(new AppError(`Access denied. Required roles: ${roles.join(', ')}`, 403));
    }

    next();
  };
}

/**
 * Optional auth — attach user if token present, don't fail if not
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  try {
    const token = authHeader.split(' ')[1];
    if (isRevoked(token)) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(
      'SELECT id, name, email, role FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );
    if (result.rows.length) req.user = result.rows[0];
  } catch {
    // Silently ignore invalid token in optional auth
  }

  next();
}

module.exports = { authenticate, authorize, optionalAuth, revokeAccessToken };
