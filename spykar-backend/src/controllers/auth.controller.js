const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query, transaction } = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { revokeAccessToken } = require('../middleware/auth');
const sessions = require('../services/sessions');

// Compared against when the email is unknown, so a miss costs the same bcrypt
// time as a hit (no account enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('no-such-user-placeholder', 12);

const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRY || '15m';

// POST /api/v1/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const result = await query(
      'SELECT id, name, email, password_hash, role, is_active FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];

    // Always run one bcrypt compare, so the response time doesn't reveal
    // whether the email is an account.
    const passwordValid = await bcrypt.compare(String(password), user?.password_hash || DUMMY_HASH);
    if (!user || !user.is_active || !passwordValid) {
      throw new AppError('Invalid credentials.', 401);
    }

    // New server-side session (one per device) + httpOnly refresh cookie.
    const { session, refresh, accessToken } = await transaction(async (client) => {
      const out = await sessions.createSession(client, user, req);
      await client.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
      return out;
    });
    sessions.setRefreshCookie(req, res, refresh, new Date(session.idle_expires_at));

    logger.info(`User logged in: ${user.email}`);

    res.json({
      success: true,
      data: {
        accessToken,
        expiresIn: ACCESS_TOKEN_EXPIRY,
        session: { id: session.id, idleExpiresAt: session.idle_expires_at, absoluteExpiresAt: session.absolute_expires_at, idleTimeoutSec: Math.round(sessions.IDLE_MS / 1000) },
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
// Rotates the httpOnly refresh cookie (see services/sessions.js). A 401 carries
// a reason code (SESSION_IDLE, SESSION_EXPIRED, SESSION_REVOKED, …) so the
// app can tell the user why; any other failure leaves the session intact.
async function refresh(req, res, next) {
  try {
    const out = await sessions.rotate(sessions.readRefreshToken(req), req);
    if (out.refresh) sessions.setRefreshCookie(req, res, out.refresh, new Date(out.session.idle_expires_at));
    res.json({
      success: true,
      data: {
        accessToken: out.accessToken,
        expiresIn: sessions.ACCESS_TOKEN_EXPIRY,
        session: { id: out.session.id, idleExpiresAt: out.session.idle_expires_at, absoluteExpiresAt: out.session.absolute_expires_at, idleTimeoutSec: Math.round(sessions.IDLE_MS / 1000) },
      },
    });
  } catch (err) {
    if (err.statusCode === 401) sessions.clearRefreshCookie(req, res);
    next(err);
  }
}

// POST /api/v1/auth/logout — ends THIS device's session.
async function logout(req, res, next) {
  try {
    revokeCurrentAccessToken(req);
    if (req.sessionId) await sessions.revokeSession(req.sessionId, 'logout', req.user.id);
    else await transaction((c) => sessions.revokeUserSessions(c, req.user.id, 'logout'));   // pre-session token
    sessions.clearRefreshCookie(req, res);
    logger.info(`User logged out: ${req.user.email} (session ${req.sessionId || 'legacy'})`);
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/logout-all — ends every session of this user, everywhere.
async function logoutAll(req, res, next) {
  try {
    revokeCurrentAccessToken(req);
    const n = await transaction((c) => sessions.revokeUserSessions(c, req.user.id, 'logout_all'));
    sessions.clearRefreshCookie(req, res);
    logger.info(`User logged out everywhere: ${req.user.email} (${n} session(s))`);
    res.json({ success: true, message: `Signed out of ${n} session(s).` });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/auth/sessions — this user's live sessions (devices).
async function listMySessions(req, res, next) {
  try {
    const rows = await sessions.listSessions(req.user.id);
    res.json({ success: true, data: rows.map((r) => ({ ...r, current: r.id === req.sessionId })) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/auth/sessions/:id — sign out one of this user's devices.
async function revokeMySession(req, res, next) {
  try {
    const n = await sessions.revokeSession(req.params.id, 'revoked_by_user', req.user.id);
    if (!n) throw new AppError('Session not found.', 404);
    if (req.params.id === req.sessionId) { revokeCurrentAccessToken(req); sessions.clearRefreshCookie(req, res); }
    res.json({ success: true, message: 'Session signed out.' });
  } catch (err) {
    next(err);
  }
}

function revokeCurrentAccessToken(req) {
  const decoded = jwt.decode(req.token);
  const ttl = decoded && decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 0;
  if (ttl > 0) revokeAccessToken(req.token, ttl);
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

    const valid = await bcrypt.compare(String(currentPassword), result.rows[0].password_hash);
    if (!valid) throw new AppError('Current password is incorrect.', 400);

    // A password change must end every existing session (a stolen refresh
    // token used to keep working), like the admin reset already does.
    const newHash = await bcrypt.hash(newPassword, 12);
    await transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);
      // End every OTHER session; the device that changed the password stays signed in.
      await sessions.revokeUserSessions(client, req.user.id, 'password_changed', req.sessionId || null);
    });

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
          u.created_at,
          u.updated_at
        FROM users u
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
    const { name, email, password, role } = req.body;
    if (role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      throw new AppError('Only a SUPER_ADMIN can create a SUPER_ADMIN.', 403);
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      throw new AppError('A user with this email already exists.', 409);
    }

    const password_hash = await bcrypt.hash(password, 12);
    const result = await query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, role, is_active, last_login_at, created_at, updated_at
    `, [name, email, password_hash, role]);

    logger.info(`User created: ${email} by ${req.user.email}`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    const { name, role, is_active } = req.body;

    const target = await query('SELECT role FROM users WHERE id = $1', [id]);
    if (!target.rows.length) throw new AppError('User not found.', 404);
    if (req.user.role !== 'SUPER_ADMIN' && (target.rows[0].role === 'SUPER_ADMIN' || role === 'SUPER_ADMIN')) {
      throw new AppError('Only a SUPER_ADMIN can change a SUPER_ADMIN or grant that role.', 403);
    }
    if (id === req.user.id && ((role != null && role !== req.user.role) || is_active === false)) {
      throw new AppError('You cannot change your own role or deactivate your own account.', 400);
    }

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
    if (!updates.length) {
      throw new AppError('No valid fields were provided for update.', 400);
    }

    params.push(id);
    const result = await query(`
      UPDATE users
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING id, name, email, role, is_active, last_login_at, created_at, updated_at
    `, params);

    if (!result.rows.length) {
      throw new AppError('User not found.', 404);
    }

    if (is_active === false) await transaction((c) => sessions.revokeUserSessions(c, id, 'account_disabled'));
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
      RETURNING id, name, email, role, is_active, last_login_at, created_at, updated_at
    `, [id]);

    if (!result.rows.length) {
      throw new AppError('User not found.', 404);
    }

    if (!result.rows[0].is_active) await transaction((c) => sessions.revokeUserSessions(c, id, 'account_disabled'));
    logger.info(`User toggled: ${result.rows[0].email} by ${req.user.email}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/auth/users/:id/password
// Admin resets ANOTHER user's password (no current-password needed — that's
// the whole point of an admin reset). Authorisation (SUPER_ADMIN/ADMIN) is
// enforced on the route. We also invalidate the target's refresh tokens so any
// old session can't silently keep working after the reset.
async function resetUserPassword(req, res, next) {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    const target = await query('SELECT id, email, role FROM users WHERE id = $1', [id]);
    if (!target.rows.length) {
      throw new AppError('User not found.', 404);
    }
    const targetUser = target.rows[0];

    // Privilege guard: only a SUPER_ADMIN may reset another SUPER_ADMIN's
    // password — stops a regular ADMIN from hijacking a super-admin account.
    if (targetUser.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      throw new AppError("Only a SUPER_ADMIN can reset a SUPER_ADMIN's password.", 403);
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await transaction(async (client) => {
      await client.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, id]
      );
      // Force re-login everywhere: end every session of this user.
      await sessions.revokeUserSessions(client, id, 'password_reset_by_admin');
    });

    logger.info(`Password reset for ${targetUser.email} by ${req.user.email}`);
    res.json({ success: true, message: `Password reset for ${targetUser.email}.` });
  } catch (err) {
    next(err);
  }
}

// Permanently removes a user. Their sessions, refresh tokens and AI query log
// go with them (ON DELETE CASCADE); dispatch orders they created are kept,
// with no creator. Authorisation (SUPER_ADMIN/ADMIN) is enforced on the route.
async function deleteUser(req, res, next) {
  try {
    const { id } = req.params;
    if (id === req.user.id) throw new AppError('You cannot delete your own account.', 400);

    const target = await query('SELECT email, role FROM users WHERE id = $1', [id]);
    if (!target.rows.length) throw new AppError('User not found.', 404);
    if (target.rows[0].role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      throw new AppError('Only a SUPER_ADMIN can delete a SUPER_ADMIN.', 403);
    }

    await transaction(async (client) => {
      await client.query('UPDATE dispatch_orders SET created_by = NULL WHERE created_by = $1', [id]);
      await client.query('DELETE FROM users WHERE id = $1', [id]);
    });

    logger.info(`User deleted: ${target.rows[0].email} by ${req.user.email}`);
    res.json({ success: true, message: `${target.rows[0].email} deleted.` });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login,
  refresh,
  logout,
  logoutAll,
  listMySessions,
  revokeMySession,
  me,
  changePassword,
  listUsers,
  createUser,
  updateUser,
  toggleUser,
  resetUserPassword,
  deleteUser,
};
