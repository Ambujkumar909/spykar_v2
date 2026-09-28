// Stock alerts on a fresh DB. Owner's rule: OUT OF STOCK = SKU in the master,
// carried by the store, 0 now (v_oos_positions). The sync never stores
// zero-stock rows, so "0 now" = no positive snapshot row.
//   X: 100 in stock, selling            → no alert
//   Y: carried (sold 5 days ago), 0 now → OUT_OF_STOCK
//   Z: carried (sold 100 days ago), 0 now → OUT_OF_STOCK
//   W: 2 in stock, selling              → REORDER_NOW
//   R: carried, 0 now, RETIRED in master → not an alert
//   N: in the master, never carried here → not an alert
// Also: /alerts and /alerts/summary agree; detail_limit is part of the cache key.
// Run: node src/scripts/verify_alerts.js
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_alerts_test';
process.env.PG_DATABASE = DB; process.env.LOG_LEVEL = 'error';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  ok(/completed successfully/.test(spawnSync(process.execPath, [path.join(__dirname, '..', 'database', 'migrate.js')], { env: process.env, encoding: 'utf8' }).stdout), 'fresh DB migrated');
  const { query, pool } = require('../config/database');
  const ctrl = require('../controllers/inventory.controller');
  const loc = (await query(`INSERT INTO locations (code, name, type, external_id) VALUES ('S1','Store','COCO','S1') RETURNING id`)).rows[0].id;
  const sku = {};
  for (const k of ['X', 'Y', 'Z', 'W', 'R', 'N']) sku[k] = (await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, external_id, is_active) VALUES ($1,'P','B','Black','32',100,$1,$2) RETURNING id`, [k, k !== 'R'])).rows[0].id;
  const sale = (k, daysAgo) => query(`INSERT INTO inventory_movements (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, reference_no, synced_from)
    VALUES ($1, $2, 'SALE', -1, 0, 0, NOW() - make_interval(days => $3), $4, 'TEST')`, [loc, sku[k], daysAgo, `${k}-${daysAgo}`]);
  for (const d of [1, 3, 7, 12]) { await sale('X', d); await sale('W', d); }
  await sale('Y', 5); await sale('Y', 20);
  await sale('Z', 100);
  await sale('R', 3);
  await query(`INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand) VALUES ($1,$2,100), ($1,$3,2)`, [loc, sku.X, sku.W]);
  // What the sync records every run (stock feed + sales/returns).
  await query(`INSERT INTO stock_positions (location_id, sku_id)
               SELECT location_id, sku_id FROM inventory_snapshot UNION SELECT DISTINCT location_id, sku_id FROM inventory_movements
               ON CONFLICT DO NOTHING`);

  const call = (fn, q) => new Promise((resolve, reject) => fn({ query: q, params: {}, headers: {} },
    { json: (b) => resolve(b), send: (b) => resolve(typeof b === 'string' ? JSON.parse(b) : b), setHeader() {}, set() { return this; }, type() { return this; }, status() { return this; } }, reject));
  const a = await call(ctrl.getAlerts, { mode: 'active' });
  const lv = Object.fromEntries(a.data.map((r) => [r.sku_code, r.alert_level]));
  ok(a.summary.out_of_stock === 2 && lv.Y === 'OUT_OF_STOCK' && lv.Z === 'OUT_OF_STOCK', `carried + in master + 0 now → OUT_OF_STOCK (out_of_stock=${a.summary.out_of_stock}, Y=${lv.Y}, Z=${lv.Z})`);
  ok(!lv.R, 'a retired SKU is never an alert');
  ok(!lv.N, 'a master SKU the store never carried is not out of stock there');
  ok(!lv.X, 'healthy stock raises no alert');
  ok(lv.W === 'REORDER_NOW', `low stock of a seller → REORDER_NOW (${lv.W})`);
  const s = await call(ctrl.getAlertsSummary, { mode: 'active' });
  ok(['out_of_stock', 'reorder_now', 'low_stock', 'total'].every((k) => s.summary[k] === a.summary[k]), `/alerts/summary == /alerts summary ${JSON.stringify(s.summary)}`);
  const zero = await call(ctrl.getAlerts, { mode: 'active', detail_limit: '0' });
  const again = await call(ctrl.getAlerts, { mode: 'active' });
  ok(zero.data.length === 0 && again.data.length === a.data.length, `detail_limit=0 does not poison the default list (${again.data.length} rows)`);
  const ex = await call(ctrl.getExecutiveSummary, { mode: 'active' });
  ok(ex.data.totals.out_of_stock === 2 && ex.data.totals.total_alerts >= 3, `executive summary counts the same out-of-stock positions (${ex.data.totals.out_of_stock}, total ${ex.data.totals.total_alerts})`);
  const arr = await call(ctrl.getAlerts, { mode: ['active', 'all'] });
  ok(arr.summary.mode === 'active', '?mode=a&mode=b → active, not a crash');

  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
