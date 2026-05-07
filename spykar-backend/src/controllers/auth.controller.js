const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, transaction } = require('../config/database');
const { set, del, TTL } = require('../config/redis');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');

const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRY || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function generateAccessToken(userId, role) {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

// POST /api/v1/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const result = await query(
      'SELECT id, name, email, password_hash, role, is_active FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      throw new AppError('Invalid credentials.', 401);
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      throw new AppError('Invalid credentials.', 401);
    }

    // Generate tokens
    const accessToken = generateAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await transaction(async (client) => {
      // Store refresh token
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshTokenHash, expiresAt]
      );
      // Update last login
      await client.query(
        'UPDATE users SET last_login_at = NOW() WHERE id = $1',
        [user.id]
      );
    });

    logger.info(`User logged in: ${user.email}`);

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/refresh
async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const result = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, u.name, u.email, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    const record = result.rows[0];

    if (!record || !record.is_active || new Date(record.expires_at) < new Date()) {
      throw new AppError('Invalid or expired refresh token.', 401);
    }

    // Rotate: delete old, issue new
    const newAccessToken = generateAccessToken(record.user_id, record.role);
    const newRefreshToken = generateRefreshToken();
    const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await transaction(async (client) => {
      await client.query('DELETE FROM refresh_tokens WHERE id = $1', [record.id]);
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [record.user_id, newHash, expiresAt]
      );
    });

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/logout
async function logout(req, res, next) {
  try {
    // Blacklist the current access token until its natural expiry
    const decoded = jwt.decode(req.token);
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) {
      await set(`blacklist:${req.token}`, '1', ttl);
    }

    // Delete all refresh tokens for this user (logout all devices) or just current
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);

    logger.info(`User logged out: ${req.user.email}`);
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/auth/me
async function me(req, res) {
  res.json({
    success: true,
    data: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      state: req.user.state || null,
      zone_id: req.user.zone_id || null,
    },
  });
}

// PATCH /api/v1/auth/password
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;

    const result = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) throw new AppError('Current password is incorrect.', 400);

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    logger.info(`Password changed for user: ${req.user.email}`);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const { search = '', role = '', page = 1, limit = 100 } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }

    if (role) {
      params.push(role);
      conditions.push(`u.role = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limitNum, offset);

    const [usersResult, countResult] = await Promise.all([
      query(`
        SELECT
          u.id,
          u.name,
          u.email,
          u.role,
          u.is_active,
          u.last_login_at,
          u.state,
          u.zone_id,
          z.name AS zone_name,
          u.created_at,
          u.updated_at
        FROM users u
        LEFT JOIN zones z ON z.id = u.zone_id
        ${whereClause}
        ORDER BY u.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      query(`
        SELECT COUNT(*)::int AS total
        FROM users u
        ${whereClause}
      `, params.slice(0, -2)),
    ]);

    res.json({
      success: true,
      data: usersResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countResult.rows[0]?.total || 0,
        totalPages: Math.max(1, Math.ceil((countResult.rows[0]?.total || 0) / limitNum)),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function createUser(req, res, next) {
  try {
    const { name, email, password, role, state } = req.body;

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      throw new AppError('A user with this email already exists.', 409);
    }

    const password_hash = await bcrypt.hash(password, 12);
    const result = await query(`
      INSERT INTO users (name, email, password_hash, role, state)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, role, is_active, last_login_at, state, zone_id, created_at, updated_at
    `, [name, email, password_hash, role, state || null]);

    logger.info(`User created: ${email} by ${req.user.email}`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    const { name, role, is_active, state } = req.body;
    const updates = [];
    const params = [];

    if (name != null) {
      params.push(name);
      updates.push(`name = $${params.length}`);
    }
    if (role != null) {
      params.push(role);
      updates.push(`role = $${params.length}`);
    }
    if (is_active != null) {
      params.push(is_active);
      updates.push(`is_active = $${params.length}`);
    }
    if (state !== undefined) {
      params.push(state || null);
      updates.push(`state = $${params.length}`);
    }

    if (!updates.length) {
      throw new AppError('No valid fields were provided for update.', 400);
    }

    params.push(id);
    const result = await query(`
      UPDATE users
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING id, name, email, role, is_active, last_login_at, state, zone_id, created_at, updated_at
    `, params);

    if (!result.rows.length) {
      throw new AppError('User not found.', 404);
    }

    logger.info(`User updated: ${result.rows[0].email} by ${req.user.email}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function toggleUser(req, res, next) {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      throw new AppError('You cannot deactivate your own account.', 400);
    }

    const result = await query(`
      UPDATE users
      SET is_active = NOT is_active, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, email, role, is_active, last_login_at, zone_id, created_at, updated_at
    `, [id]);

    if (!result.rows.length) {
      throw new AppError('User not found.', 404);
    }

    logger.info(`User toggled: ${result.rows[0].email} by ${req.user.email}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login,
  refresh,
  logout,
  me,
  changePassword,
  listUsers,
  createUser,
  updateUser,
  toggleUser,
};
