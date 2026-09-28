// ERP-unreachable sync on a fresh DB: stock must be left exactly as it was,
// nothing archived, and the run marked FAILED (it used to rebuild stock from
// sales-only movements → ~0 everywhere → SUCCESS). No ERP needed: MSSQL points
// at a closed local port. Run: node src/scripts/verify_sync_offline.js
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_sync_offline_test';
Object.assign(process.env, {
  PG_DATABASE: DB, LOG_LEVEL: 'error', MSSQL_HOST: '127.0.0.1', MSSQL_PORT: '1',
  MSSQL_CONNECT_RETRIES: '1', SYNC_PRIMARY_SALES: 'false', SYNC_MASTER_REFRESH: 'false',
});
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  ok(/completed successfully/.test(spawnSync(process.execPath, [path.join(__dirname, '..', 'database', 'migrate.js')], { env: process.env, encoding: 'utf8' }).stdout), 'fresh DB migrated');
  const { query, pool } = require('../config/database');
  const loc = (await query(`INSERT INTO locations (code, name, type, external_id) VALUES ('S1','Store','COCO','S1') RETURNING id`)).rows[0].id;
  const sku = (await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, external_id) VALUES ('K1','P','B','Black','32',1000,'K1') RETURNING id`)).rows[0].id;
  await query(`INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand) VALUES ($1, $2, 25)`, [loc, sku]);
  // Sales-only history: the old fallback netted this to 25 - 10 → forced to 0.
  await query(`INSERT INTO inventory_movements (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, reference_no, synced_from)
               VALUES ($1, $2, 'SALE', -10, 0, 0, NOW() - interval '1 day', 'INV-1', 'TEST')`, [loc, sku]);

  const { runDeltaSync } = require('../services/syncEngine');
  let err = null;
  try { await runDeltaSync('DELTA'); } catch (e) { err = e; }
  const log = (await query(`SELECT status, error_message FROM sync_logs ORDER BY started_at DESC LIMIT 1`)).rows[0];
  ok(log && log.status === 'FAILED', `sync marked FAILED (${log && log.status}: ${log && log.error_message})`);
  ok(!!err || log.status === 'FAILED', 'caller sees the failure');
  const snap = (await query(`SELECT qty_on_hand FROM inventory_snapshot`)).rows;
  ok(snap.length === 1 && snap[0].qty_on_hand === 25, `stock left untouched (${JSON.stringify(snap)})`);
  const hist = (await query(`SELECT count(*)::int c FROM inventory_daily_snapshot`)).rows[0].c;
  ok(hist === 0, 'no stock history archived from a non-synced snapshot');
  const lock = (await query(`SELECT count(*)::int c FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].c;
  ok(lock === 0, 'sync lock released after the failure');

  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
