// AI SQL sandbox: fresh DB → prove model-written SQL can read business data
// but not secrets, cannot write, cannot run two statements, and is cancelled by
// the SERVER on timeout. Run: node src/scripts/verify_ai_sql.js
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_ai_sql_test';
process.env.LOG_LEVEL = 'error';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT || 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  const mig = spawnSync(process.execPath, [path.join(__dirname, '..', 'database', 'migrate.js')], { env: { ...process.env, PG_DATABASE: DB }, encoding: 'utf8' });
  ok(/completed successfully/.test(mig.stdout), 'fresh DB migrated');
  process.env.PG_DATABASE = DB;
  const { query, pool } = require('../config/database');
  const { safeAiSql, runSqlWithTimeout } = require('../controllers/ai.controller')._internal;
  await query(`INSERT INTO users (name, email, password_hash, role) VALUES ('x','x@x.com','SECRET_HASH','VIEWER')`);
  await query(`INSERT INTO locations (code, name, type, external_id) VALUES ('L1','Store A','WAREHOUSE','L1'), ('L2','Store B','WAREHOUSE','L2')`);
  const hasRole = (await query(`SELECT pg_has_role(current_user, 'spykar_ai', 'MEMBER') AS ok`).catch(() => ({ rows: [{ ok: false }] }))).rows[0].ok;
  ok(hasRole, 'migration 025 created spykar_ai and made the app user a member');

  // allowed
  let rows = await runSqlWithTimeout(safeAiSql('SELECT name FROM locations ORDER BY name DESC;'), 5000);
  ok(rows.length === 2 && rows[0].name === 'Store B', 'business SELECT works, ORDER BY kept, trailing ; accepted');
  rows = await runSqlWithTimeout(safeAiSql('WITH x AS (SELECT count(*)::int n FROM locations) SELECT n FROM x'), 5000);
  ok(rows[0].n === 2, 'CTE (WITH …) query works inside the wrapper');
  rows = await runSqlWithTimeout(safeAiSql('SELECT g FROM generate_series(1, 5000) g'), 5000);
  ok(rows.length === 1000, `outer row cap enforced (${rows.length})`);
  rows = await runSqlWithTimeout(safeAiSql('SELECT g FROM generate_series(1, 5000) g WHERE g IN (SELECT g FROM generate_series(1,3000) g LIMIT 3000)'), 5000);
  ok(rows.length === 1000, 'cap holds even when a LIMIT hides in a subquery');

  // the static gate
  for (const [label, q] of [
    ['users table', 'SELECT email, password_hash FROM users'],
    ['quoted/qualified users', 'SELECT * FROM public."users"'],
    ['refresh tokens', 'SELECT * FROM refresh_tokens'],
    ['unicode-escaped identifier', 'SELECT * FROM U&"\\0075sers"'],
    ['second statement', 'SELECT 1; SET statement_timeout = 0'],
    ['pg_terminate_backend', 'SELECT pg_terminate_backend(123)'],
    ['advisory lock', 'SELECT pg_advisory_lock(1)'],
    ['pg_sleep', 'SELECT pg_sleep(30)'],
    ['write', 'DELETE FROM locations'],
    ['SELECT INTO', 'SELECT * INTO newtab FROM locations'],
  ]) ok((await err(() => safeAiSql(q)))?.statusCode >= 400, `gate refuses: ${label}`);

  // the runtime boundary, even if the gate were bypassed
  let e = await err(() => runSqlWithTimeout('SELECT password_hash FROM users', 5000));
  ok(/permission denied/.test(e?.message || ''), `restricted role: users unreadable at the DB level (${e?.message})`);
  e = await err(() => runSqlWithTimeout('SELECT 1) q; SELECT (1', 5000));
  ok(e && !/^$/.test(e.message), `multi-statement impossible (${e?.message})`);
  e = await err(() => runSqlWithTimeout("SELECT setval('_migrations_id_seq', 1)", 5000));
  ok(/read-only|permission denied|does not exist/.test(e?.message || ''), `writes impossible (${e?.message})`);
  const t0 = Date.now();
  e = await err(() => runSqlWithTimeout('SELECT pg_sleep(20)', 1500));
  const took = Date.now() - t0;
  ok(e?.code === '57014' && took < 5000, `server cancels at the timeout (${took}ms, ${e?.code})`);
  const lingering = (await query(`SELECT count(*)::int c FROM pg_stat_activity WHERE query LIKE '%pg_sleep(20)%' AND state = 'active' AND pid <> pg_backend_pid()`)).rows[0].c;
  ok(lingering === 0, 'no query left running on the server after the timeout');
  const role = (await query('SELECT current_user AS u')).rows[0].u;
  ok(role === process.env.PG_USER, `pooled connection is back to ${role} (SET LOCAL ROLE did not leak)`);

  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
