/**
 * smoke_endpoints.js — every GET endpoint against a FRESH, EMPTY database
 *
 *   node src/scripts/smoke_endpoints.js         (add --keep to keep the test DB)
 *   node src/scripts/smoke_endpoints.js --live  (READ-ONLY against the real DB in .env;
 *        log in with SMOKE_EMAIL / SMOKE_PASSWORD, default admin@spykar.com / Admin@123)
 *
 * Creates <db>_smoke from the real schema + migrations, seeds the login users,
 * boots the real Express app in-process (no scheduler, no warmup), logs in as
 * admin, discovers every GET route from the router stack, and calls each with
 * no query and with the common period presets. A fresh install is exactly this
 * state, so any 5xx here is a bug a new deployment would show its users.
 * Exit 0 = no 5xx and nothing slower than 10s.
 */
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const LIVE = process.argv.includes('--live');
const DB = LIVE ? process.env.PG_DATABASE : `${process.env.PG_DATABASE || 'spykar_inventory'}_smoke`;
const KEEP = LIVE || process.argv.includes('--keep');
const SLOW_MS = LIVE ? 3000 : 10000;   // on real data, flag anything a user would feel
process.env.PG_DATABASE = DB;
process.env.LOG_LEVEL = 'error';
process.env.ENABLE_SCHEDULER = 'false';

const pgAdmin = () => new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT || 5432,
  user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });

// Walk the express router stack → [{ method, path }].
function routesOf(app) {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
      } else if (layer.name === 'router' && layer.handle.stack) {
        const src = layer.regexp.source.replace('^\\', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
        walk(layer.handle.stack, prefix + (src.startsWith('/') ? src : '/' + src));
      }
    }
  };
  walk(app._router.stack, '');
  return out;
}

(async () => {
  const admin = pgAdmin(); await admin.connect();
  if (!LIVE) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const run = (file) => spawnSync(process.execPath, [file], { env: process.env, encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
    const mig = run(path.join(__dirname, '..', 'database', 'migrate.js'));
    if (!/completed successfully/.test(mig.stdout)) { console.error(mig.stdout, mig.stderr); process.exit(2); }
    const seed = run(path.join(__dirname, '..', '..', 'seed_users.js'));
    if (seed.status !== 0) { console.error(seed.stdout, seed.stderr); process.exit(2); }
  }

  const app = require('../app');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.SMOKE_EMAIL || 'admin@spykar.com', password: process.env.SMOKE_PASSWORD || 'Admin@123' }) }).then((r) => r.json());
  const token = login?.data?.accessToken;
  if (!token) { console.error('login failed', login); process.exit(2); }
  const auth = { authorization: `Bearer ${token}` };

  const gets = routesOf(app).filter((r) => r.method === 'GET' && r.path.startsWith('/api/'));
  const bad = []; const slowest = []; let calls = 0;
  const variants = ['', '?period=today', '?period=mtd', '?period=ytd'];
  for (const r of gets) {
    const p = r.path.replace(/:[A-Za-z_]+/g, '00000000-0000-0000-0000-000000000000');
    for (const v of variants) {
      if (/export|csv/.test(p) && v) continue;
      const t0 = Date.now();
      let status, body = '';
      try {
        const res = await fetch(base + p + v, { headers: auth, signal: AbortSignal.timeout(30000) });
        status = res.status; body = (await res.text()).slice(0, 160);
      } catch (e) { status = 'ERR'; body = e.message; }
      const ms = Date.now() - t0; calls++;
      slowest.push({ url: p + v, ms });
      if (status === 'ERR' || status >= 500 || ms > SLOW_MS) bad.push({ url: p + v, status, ms, body });
    }
  }
  console.log(`${gets.length} GET routes, ${calls} calls against ${LIVE ? `the LIVE database ${DB} (cold cache)` : 'an empty database'}`);
  console.log('slowest:', slowest.sort((a, b) => b.ms - a.ms).slice(0, 8).map((x) => `${x.ms}ms ${x.url}`).join(' | '));
  if (bad.length) { console.log(`\n❌ ${bad.length} failing call(s):`); for (const b of bad) console.log(` ${b.status} ${b.ms}ms ${b.url}\n     ${b.body}`); }
  else console.log(`✅ no 5xx, nothing over ${SLOW_MS / 1000}s`);

  server.close();
  await require('../config/database').pool.end().catch(() => {});
  if (!KEEP) await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
