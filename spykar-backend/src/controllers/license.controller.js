// ─── Licence controller — /api/v1/license ───────────────────────────────────
// GET  /        seats, seats in use, expiry   (Super Admin, Admin)
// POST /apply   apply a key from the owner    (Super Admin, Admin)
const license = require('../services/license');
const sessions = require('../services/sessions');

async function getLicense(req, res, next) {
  try { res.json({ success: true, data: await license.summary() }); } catch (err) { next(err); }
}

async function applyKey(req, res, next) {
  try {
    const out = await license.apply(req.body.key, req.user.email, (client, id) => sessions.revokeUserSessions(client, id, 'license_seats'));
    res.json({ success: true, data: await license.summary(), deactivated: out.off });
  } catch (err) { next(err); }
}

module.exports = { getLicense, applyKey };
