// ─── Licence: user seats + validity, from keys signed by the platform owner ──
// A key is `SPK1.<payload>.<signature>` (base64url). The payload is JSON:
//   { v: 1, id, kind: 'license', seats, starts, expires, useBy, iat }
//   { v: 1, id, kind: 'upgrade', add,   expires, useBy, iat }
// signed with the owner's Ed25519 private key, which is never on this server.
// Only the public key is here, so the server can check a key but not make one.
//
// Every applied key is kept in license_keys and in a copy file (COPY). Either
// one rebuilds the other, so deleting one of them changes nothing. Seats and
// expiry are always recomputed from the signed keys themselves.
//
// Rules: the licence ends at 00:00 IST on `expires`. An upgrade key adds seats
// and keeps the expiry (its `expires` must match the running licence). A key
// works once, and only until the end of its `useBy` day. Super Admins never use
// a seat.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { query, transaction } = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');

const PUBLIC_KEY = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+hYdMH3hGxsL73VVYe83mf1DjUI9i7Xa18KrTJ+DUGQ=
-----END PUBLIC KEY-----`);
// One copy per database, so a test database's keys never reach another one.
const COPY = process.env.LICENSE_COPY || path.join(os.homedir(), 'spykar', 'license-data',
  `applied-keys.${process.env.PG_PORT || 5432}.${String(process.env.PG_DATABASE || 'db').replace(/[^\w-]/g, '_')}.json`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK = 731_204;                                    // advisory lock: seat changes + key applies
const atIST = (d) => Date.parse(`${d}T00:00:00+05:30`);  // 00:00 IST that day, in ms
const DAY = 864e5;

// Signed key → payload, or null if it is not a genuine, well-formed key.
function decode(key) {
  const m = /^SPK1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(key || '').replace(/\s+/g, ''));
  if (!m) return null;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(m[1]), PUBLIC_KEY, Buffer.from(m[2], 'base64url')); } catch { ok = false; }
  if (!ok) return null;
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!p || p.v !== 1 || typeof p.id !== 'string' || !p.id || !DATE.test(p.expires) || !DATE.test(p.useBy) || !Number.isFinite(p.iat)) return null;
  if (p.kind === 'license') return Number.isInteger(p.seats) && p.seats >= 0 && DATE.test(p.starts) ? { ...p, token: `SPK1.${m[1]}.${m[2]}` } : null;
  if (p.kind === 'upgrade') return Number.isInteger(p.add) && p.add > 0 ? { ...p, token: `SPK1.${m[1]}.${m[2]}` } : null;
  return null;
}

// A key only counts if it was applied inside its own window (from when it was
// made to the end of its use-by day, a day's slack for clock drift) — a genuine
// key slipped into the table or the copy file later does not.
const inWindow = (k) => k.appliedAt != null && k.appliedAt >= k.iat - DAY && k.appliedAt < atIST(k.useBy) + 2 * DAY;

// The licence that a set of genuine keys adds up to.
function compute(keys, now) {
  const byId = new Map(keys.filter(inWindow).map((k) => [k.id, k]));
  const all = [...byId.values()];
  const base = all.filter((k) => k.kind === 'license')
    .sort((a, b) => (a.expires < b.expires ? -1 : a.expires > b.expires ? 1 : a.iat - b.iat)).pop();
  if (!base) return { valid: false, reason: 'LICENSE_MISSING', seats: 0, base: null };
  const ups = all.filter((k) => k.kind === 'upgrade' && k.expires === base.expires && k.iat >= base.iat);
  const seats = base.seats + ups.reduce((a, k) => a + k.add, 0);
  const end = atIST(base.expires);
  const expired = now >= end;
  return {
    valid: !expired, reason: expired ? 'LICENSE_EXPIRED' : null, seats, base,
    starts: base.starts, expires: base.expires, daysLeft: Math.max(0, Math.ceil((end - now) / DAY)), upgrades: ups.length,
  };
}

// ── store: table + copy file, each restores the other ───────────────────────
function readCopy() {
  try { const j = JSON.parse(fs.readFileSync(COPY, 'utf8')); return { keys: Array.isArray(j.keys) ? j.keys : [], lastSeen: Number(j.lastSeen) || 0 }; } catch { return { keys: [], lastSeen: 0 }; }
}
function writeCopy(rows, lastSeen) {
  try {
    fs.mkdirSync(path.dirname(COPY), { recursive: true, mode: 0o700 });
    const tmp = `${COPY}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ keys: rows.map((r) => ({ token: r.token, applied_at: r.applied_at, applied_by: r.applied_by })), lastSeen }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, COPY);
  } catch (e) { logger.warn(`Licence copy not written (${COPY}): ${e.message}`); }
}

// Merge table + copy, put back whatever either is missing, advance the clock.
async function sync(client = { query }) {
  const db = (await client.query('SELECT token, applied_at, applied_by FROM license_keys')).rows;
  const clock = (await client.query('SELECT last_seen FROM license_clock WHERE id = 1')).rows[0];
  const file = readCopy();
  const rows = new Map();
  for (const r of [...db, ...file.keys]) {
    const k = decode(r.token);
    const at = r.applied_at ? Date.parse(r.applied_at) : NaN;
    if (k && Number.isFinite(at) && !rows.has(k.id)) rows.set(k.id, { k: { ...k, appliedAt: at }, token: k.token, applied_at: new Date(at).toISOString(), applied_by: r.applied_by || null });
  }
  const inDb = new Set(db.map((r) => decode(r.token)?.id).filter(Boolean));
  for (const r of rows.values()) {
    if (!inDb.has(r.k.id)) {
      await client.query('INSERT INTO license_keys (key_id, kind, token, applied_at, applied_by) VALUES ($1, $2, $3, $4::timestamptz, $5) ON CONFLICT (key_id) DO NOTHING',
        [r.k.id, r.k.kind, r.token, r.applied_at, r.applied_by]);
      logger.warn(`Licence key ${r.k.id} restored to the database from the copy file`);
    }
  }
  const applied = Math.max(0, ...[...rows.values()].map((r) => (r.applied_at ? Date.parse(r.applied_at) : 0)));
  // The newest sales day the ERP delivered (a day with 20+ stores, so one bad
  // row can't count) — a clock wound back can't go before data that exists.
  let data = 0;
  const { rows: [has] } = await client.query("SELECT to_regclass('public.wr_store_day') IS NOT NULL AS ok");
  if (has.ok) {
    const { rows: [d] } = await client.query(`SELECT max(sale_date)::text AS d FROM (SELECT sale_date FROM wr_store_day
      WHERE sale_date >= (SELECT max(sale_date) FROM wr_store_day) - 45 GROUP BY sale_date HAVING count(*) >= 20) x`);
    if (d && d.d) data = atIST(d.d) + DAY;
  }
  const lastSeen = Math.max(Date.now(), clock ? clock.last_seen.getTime() : 0, file.lastSeen, applied, data);
  if (!clock || lastSeen - clock.last_seen.getTime() > 5 * 60e3) {
    await client.query('INSERT INTO license_clock (id, last_seen) VALUES (1, to_timestamp($1 / 1000.0)) ON CONFLICT (id) DO UPDATE SET last_seen = GREATEST(license_clock.last_seen, EXCLUDED.last_seen)', [lastSeen]);
  }
  const list = [...rows.values()];
  const fileIds = new Set(file.keys.map((r) => decode(r.token)?.id).filter(Boolean));
  if (list.some((r) => !fileIds.has(r.k.id)) || fileIds.size !== list.length || lastSeen - file.lastSeen > 5 * 60e3) writeCopy(list, lastSeen);
  return { keys: list.map((r) => r.k), rows: list, now: lastSeen };
}

// ── cached state, refreshed every minute and after every change ─────────────
let cache = null; let cacheAt = 0; let inflight = null;
let seatCache = null; let seatAt = 0;
function touch() { cacheAt = 0; seatAt = 0; }
async function state() {
  if (cache && Date.now() - cacheAt < 60e3) return { ...cache, valid: cache.valid && Date.now() < atIST(cache.expires) };
  if (!inflight) {
    inflight = sync().then((s) => { cache = compute(s.keys, s.now); cacheAt = Date.now(); return cache; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// The active non-Super-Admin accounts that hold a seat. Normally that is all of
// them; if the table ever shows more active users than seats, only the first
// `seats` (oldest accounts) get in.
async function seated(seats) {
  if (!seatCache || Date.now() - seatAt > 30e3) {
    const { rows } = await query("SELECT id FROM users WHERE is_active AND role <> 'SUPER_ADMIN' ORDER BY created_at, id");
    seatCache = rows.map((r) => r.id); seatAt = Date.now();
  }
  return { used: seatCache.length, ids: new Set(seatCache.slice(0, seats)) };
}

// null = let the request through; otherwise { status, code, message }.
const OWN = /^\/api\/v1\/(license|auth|users)(\/|\?|$)/;
async function gate(user, url) {
  if (user.role === 'SUPER_ADMIN') return null;
  const st = await state();
  if (!st.valid) {
    if (user.role === 'ADMIN' && OWN.test(url || '')) return null;   // admins can still renew
    const message = st.reason === 'LICENSE_EXPIRED' ? `The licence expired on ${st.expires}. Ask your administrator to renew it.` : 'No licence is installed. Ask your administrator to add one.';
    return { status: user.role === 'ADMIN' ? 403 : 401, code: st.reason, message };
  }
  const s = await seated(st.seats);
  if (!s.ids.has(user.id)) return { status: 401, code: 'NO_SEAT', message: 'This account has no licence seat. Ask your Super Admin.' };
  return null;
}

// Throws unless one more active (non-Super-Admin) user fits. Call inside a
// transaction; takes the seat lock so two requests cannot take the last seat.
async function requireSeat(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const st = await state();
  if (!st.valid) throw new AppError(st.reason === 'LICENSE_EXPIRED' ? `The licence expired on ${st.expires}. Renew it first.` : 'No licence is installed.', 403, st.reason);
  const { rows: [{ n }] } = await client.query("SELECT count(*)::int AS n FROM users WHERE is_active AND role <> 'SUPER_ADMIN'");
  if (n >= st.seats) throw new AppError(`No free licence seat (${n} of ${st.seats} in use). Upgrade the licence.`, 403, 'NO_SEAT');
}

// Apply a key. Returns the new state and the users deactivated to fit.
async function apply(key, by, revokeSessions) {
  const k = decode(key);
  if (!k) throw new AppError('This key is not valid.', 400, 'KEY_INVALID');
  const out = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    const s = await sync(client);
    if (s.now >= atIST(k.useBy) + DAY) throw new AppError(`This key could only be used until ${k.useBy}.`, 400, 'KEY_EXPIRED');
    if (s.keys.some((x) => x.id === k.id)) throw new AppError('This key has already been used.', 409, 'KEY_USED');
    const cur = compute(s.keys, s.now);
    if (k.kind === 'upgrade') {
      if (!cur.base || !cur.valid) throw new AppError('There is no running licence to upgrade. Use a licence (renewal) key.', 400, 'KEY_NO_BASE');
      if (k.expires !== cur.expires) throw new AppError(`This upgrade key is for a licence ending ${k.expires}; the current licence ends ${cur.expires}.`, 400, 'KEY_PERIOD');
    } else {
      if (s.now >= atIST(k.expires)) throw new AppError(`This licence key ended on ${k.expires}.`, 400, 'KEY_PERIOD');
      if (cur.base && k.expires < cur.expires) throw new AppError(`This licence ends ${k.expires}, before the current one (${cur.expires}).`, 400, 'KEY_PERIOD');
    }
    const at = Math.max(Date.now(), k.iat);   // never before the key was made
    await client.query('INSERT INTO license_keys (key_id, kind, token, applied_at, applied_by) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)', [k.id, k.kind, k.token, at, by]);
    const next = compute([...s.keys, { ...k, appliedAt: at }], s.now);
    // More active users than seats → keep the most recently signed-in ones.
    const { rows } = await client.query(`SELECT id, email FROM users WHERE is_active AND role <> 'SUPER_ADMIN'
      ORDER BY last_login_at DESC NULLS LAST, created_at OFFSET $1`, [next.seats]);
    for (const u of rows) {
      await client.query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1', [u.id]);
      await revokeSessions(client, u.id);
    }
    return { next, off: rows.map((r) => r.email) };
  });
  touch();
  await sync().catch((e) => logger.warn(`Licence copy refresh failed: ${e.message}`));
  logger.info(`Licence key ${k.id} (${k.kind}) applied by ${by}: ${out.next.seats} seats, ends ${out.next.expires}${out.off.length ? `; deactivated ${out.off.join(', ')}` : ''}`);
  return out;
}

async function summary() {
  const st = await state();
  const s = await seated(st.seats);
  return { valid: st.valid, reason: st.reason, seats: st.seats, used: s.used, free: Math.max(0, st.seats - s.used), starts: st.starts || null, expires: st.expires || null, daysLeft: st.daysLeft ?? 0 };
}

module.exports = { decode, compute, state, gate, requireSeat, apply, summary, touch, _test: { atIST, COPY } };
