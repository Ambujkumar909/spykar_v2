const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { get } = require('../config/redis');
const logger = require('../config/logger');
const { AppError } = require('./errorHandler');

/**
 * Verify JWT access token and attach user to request
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication required. Please provide a valid token.', 401);
    }

    const token = authHeader.split(' ')[1];

    // Check if token is blacklisted (logged out)
    const blacklisted = await get(`blacklist:${token}`);
    if (blacklisted) {
      throw new AppError('Token has been invalidated. Please log in again.', 401);
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new AppError('Token expired. Please refresh your session.', 401);
      }
      throw new AppError('Invalid token. Please log in again.', 401);
    }

    // Fetch fresh user from DB (ensures revoked access is caught)
    const result = await query(
      'SELECT id, name, email, role, is_active, zone_id FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      throw new AppError('User account not found or deactivated.', 401);
    }

    req.user = result.rows[0];
    req.token = token;
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(
      'SELECT id, name, email, role, zone_id FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );
    if (result.rows.length) req.user = result.rows[0];
  } catch {
    // Silently ignore invalid token in optional auth
  }

  next();
}

module.exports = { authenticate, authorize, optionalAuth };
