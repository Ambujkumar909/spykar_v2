// Auth & user-management checks over real HTTP on a fresh DB.
// Run: node src/scripts/verify_auth.js
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_auth_test';
process.env.PG_DATABASE = DB; process.env.LOG_LEVEL = 'error'; process.env.NODE_ENV = 'production';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT || 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  const run = (f) => spawnSync(process.execPath, [f], { env: process.env, encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
  ok(/completed successfully/.test(run(path.join(__dirname, '..', 'database', 'migrate.js')).stdout), 'fresh DB migrated');
  ok(/3 user\(s\) created/.test(run(path.join(__dirname, '..', '..', 'seed_users.js')).stdout), 'seed inserts the 3 default users');
  ok(/0 user\(s\) created/.test(run(path.join(__dirname, '..', '..', 'seed_users.js')).stdout), 're-running the seed leaves existing users alone');

  const app = require('../app');
  const cache = require('../config/cache');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  const login = async (email, password) => (await call('POST', '/auth/login', { email, password })).json?.data;

  const sa = await login('admin@spykar.com', 'Admin@123');
  ok(!!sa?.accessToken, 'super admin logs in');
  const mk = await call('POST', '/users', { name: 'Adam Admin', email: 'adam@spykar.com', password: 'Passw0rdX', role: 'ADMIN' }, sa.accessToken);
  ok(mk.status === 201, 'super admin creates an ADMIN');
  const adminId = mk.json.data.id;
  const saId = (await call('GET', '/auth/me', null, sa.accessToken)).json.data.id;
  const ad = await login('adam@spykar.com', 'Passw0rdX');

  // ── escalation paths an ADMIN must NOT have ──
  ok((await call('PATCH', `/users/${adminId}`, { role: 'SUPER_ADMIN' }, ad.accessToken)).status === 403, 'ADMIN cannot promote themselves to SUPER_ADMIN');
  ok((await call('PATCH', `/users/${saId}`, { is_active: false }, ad.accessToken)).status === 403, 'ADMIN cannot deactivate the SUPER_ADMIN');
  ok((await call('PATCH', `/users/${saId}`, { role: 'VIEWER' }, ad.accessToken)).status === 403, 'ADMIN cannot demote the SUPER_ADMIN');
  ok((await call('POST', '/users', { name: 'Evil', email: 'evil@spykar.com', password: 'Passw0rdX', role: 'SUPER_ADMIN' }, ad.accessToken)).status === 403, 'ADMIN cannot create a SUPER_ADMIN');
  ok((await call('PATCH', `/users/${adminId}`, { is_active: false }, ad.accessToken)).status === 400, 'nobody can deactivate their own account');
  ok((await call('PATCH', `/users/${saId}`, { role: 'VIEWER' }, sa.accessToken)).status === 400, 'SUPER_ADMIN cannot demote themselves (no lock-out)');
  ok((await call('PATCH', `/users/${adminId}`, { name: 'Adam A.' }, ad.accessToken)).status === 200, 'ADMIN can still edit their own name');
  const v = (await call('GET', '/users/?limit=100', null, sa.accessToken)).json.data;
  const viewer = (v.users || v).find((u) => u.email === 'viewer@spykar.com');
  ok((await call('PATCH', `/users/${viewer.id}`, { role: 'MANAGER' }, ad.accessToken)).status === 200, 'ADMIN can still manage a VIEWER');
  ok((await call('PATCH', '/users/not-a-uuid', { name: 'xx' }, sa.accessToken)).status === 400, 'non-UUID user id → 400, not 500');
  ok((await call('GET', '/users/?page=0', null, sa.accessToken)).status === 400, 'page=0 → 400, not a negative-OFFSET 500');

  // ── sessions ──
  const r1 = await Promise.all([1, 2].map(() => call('POST', '/auth/refresh', { refreshToken: ad.refreshToken })));
  ok(r1.filter((r) => r.status === 200).length === 1, `replaying one refresh token twice at once → exactly one succeeds (${r1.map((r) => r.status)})`);
  const live = r1.find((r) => r.status === 200).json.data;
  ok((await call('PATCH', '/auth/password', { currentPassword: 'Passw0rdX', newPassword: 'NewPassw0rd' }, live.accessToken)).status === 200, 'ADMIN changes their password');
  ok((await call('POST', '/auth/refresh', { refreshToken: live.refreshToken })).status === 401, 'password change ends the old refresh token');
  const s2 = await login('adam@spykar.com', 'NewPassw0rd');
  ok((await call('POST', '/auth/logout', null, s2.accessToken)).status === 200, 'logout');
  cache.clear();   // what every sync does
  ok((await call('GET', '/auth/me', null, s2.accessToken)).status === 401, 'logged-out token stays rejected after a sync flushes the cache');
  ok((await call('POST', '/auth/refresh', { refreshToken: ['x'] })).status === 400, 'non-string refresh token → 400, not a 500');

  // ── limiter scope + timing ──
  const sa2 = await login('admin@spykar.com', 'Admin@123');
  const mes = await Promise.all(Array.from({ length: 40 }, () => call('GET', '/auth/me', null, sa2.accessToken)));
  ok(mes.every((r) => r.status === 200), '40 × /auth/me in a row: never rate-limited');
  const t = async (email) => { const t0 = Date.now(); await call('POST', '/auth/login', { email, password: 'WrongPass1' }); return Date.now() - t0; };
  const miss = await t('nobody@spykar.com'), hit = await t('viewer@spykar.com');
  ok(miss > 80 && Math.abs(miss - hit) < 150, `unknown email costs a bcrypt compare too (miss ${miss}ms, hit ${hit}ms)`);
  let limited = false;
  for (let i = 0; i < 35 && !limited; i++) limited = (await call('POST', '/auth/login', { email: 'x@y.com', password: 'WrongPass1' })).status === 429;
  ok(limited, 'login itself is still rate-limited');

  server.close();
  await require('../config/database').pool.end().catch(() => {});
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
