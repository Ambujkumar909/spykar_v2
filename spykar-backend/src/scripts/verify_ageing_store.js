// Store ageing (continuous-on-hand) on a fresh DB with hand-built snapshots.
// 45 days of history ending on the as-of date:
//   A: 10 units every day                       → 10 units aged ≥ 30 days (bucket 1+)
//   B: 10 units, but NO row on the as-of date   → sold out → no ageing rows at all
//   C: 10 units, missing one day 10 days ago    → restocked → all 10 fresh (bucket 0)
// Run: node src/scripts/verify_ageing_store.js
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_ageing_test';
process.env.PG_DATABASE = DB; process.env.LOG_LEVEL = 'error';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  ok(/completed successfully/.test(spawnSync(process.execPath, [path.join(__dirname, '..', 'database', 'migrate.js')], { env: process.env, encoding: 'utf8' }).stdout), 'fresh DB migrated');
  const { query, pool } = require('../config/database');
  const { ensureMonthPartition } = require('../services/historicalStockLoader');
  const loc = (await query(`INSERT INTO locations (code, name, type, external_id) VALUES ('S1','Store','COCO','S1') RETURNING id`)).rows[0].id;
  const sku = {};
  for (const k of ['A', 'B', 'C']) sku[k] = (await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, external_id) VALUES ($1,'P','B','Black','32',100,$1) RETURNING id`, [k])).rows[0].id;
  const asOf = '2026-09-20';
  for (let back = 0; back < 45; back++) {
    const d = new Date(`${asOf}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - back);
    const day = d.toISOString().slice(0, 10);
    await ensureMonthPartition(day);
    await query(`INSERT INTO inventory_daily_snapshot (snapshot_date, location_id, sku_id, qty_on_hand) VALUES ($1, $2, $3, 10)`, [day, loc, sku.A]);
    if (back !== 0) await query(`INSERT INTO inventory_daily_snapshot (snapshot_date, location_id, sku_id, qty_on_hand) VALUES ($1, $2, $3, 10)`, [day, loc, sku.B]);
    if (back !== 10) await query(`INSERT INTO inventory_daily_snapshot (snapshot_date, location_id, sku_id, qty_on_hand) VALUES ($1, $2, $3, 10)`, [day, loc, sku.C]);
  }
  const { loadStore } = require('../database/load_inventory_ageing');
  await loadStore();
  const rows = (await query(`SELECT s.sku_code k, a.age_bucket b, a.units::int u FROM inventory_ageing a JOIN skus s ON s.id = a.sku_id WHERE a.source = 'store' ORDER BY 1, 2`)).rows;
  const by = (k) => rows.filter((r) => r.k === k);
  ok(by('A').reduce((t, r) => t + r.u, 0) === 10 && by('A').every((r) => r.b >= 1), `A: 10 continuous units aged past 30 days ${JSON.stringify(by('A'))}`);
  ok(by('B').length === 0, `B: sold out on the as-of date → no phantom stock ${JSON.stringify(by('B'))}`);
  ok(by('C').length === 1 && by('C')[0].b === 0 && by('C')[0].u === 10, `C: a gap 10 days ago → all 10 units fresh ${JSON.stringify(by('C'))}`);

  // Through the controller, as the page calls it.
  const ctrl = require('../controllers/ageing.controller');
  const call = (fn, q) => new Promise((resolve, reject) => fn({ query: q, params: {}, headers: {} }, { json: (b) => resolve(b.data), status() { return this; } }, reject));
  const sum = await call(ctrl.getSummary, { source: 'store', status: 'all' });
  const total = (sum.buckets || []).reduce((t, b) => t + Number(b.units || 0), 0);
  ok(total === 20, `summary: 20 units aged across buckets (A 10 + C 10) — got ${total}`);
  const pv = await call(ctrl.getPivot, { source: 'store', group_by: 'store', status: 'all' });
  ok(pv.rows.length === 1 && pv.rows[0].key === 'S1', `store rows are keyed by store CODE (${pv.rows[0] && pv.rows[0].key})`);
  const drill = await call(ctrl.getPivot, { source: 'store', group_by: 'store', status: 'all', store: pv.rows[0].key });
  ok(drill.rows.length === 1, 'drilling with that key (what a row click sends) keeps the store, not an empty page');
  await query(`UPDATE inventory_ageing_meta SET computed_at = computed_at + interval '1 second' WHERE source = 'store'`);
  await query(`DELETE FROM inventory_ageing WHERE source = 'store' AND sku_id = $1`, [sku.C]);
  const sum2 = await call(ctrl.getSummary, { source: 'store', status: 'all' });
  ok((sum2.buckets || []).reduce((t, b) => t + Number(b.units || 0), 0) === 10, 'a rebuild (new computed_at) is visible at once, not after the 24 h cache');

  // Warehouse FIFO (MITTRA ledger): +10 on day-100, +5 on day-10, −8 on day-5
  // → 7 on hand; FIFO consumes the oldest first → 2 left from the 100-day
  // receipt (bucket 3: 91–180) and all 5 from the 10-day one (bucket 0).
  const wh = (await query(`INSERT INTO primary_warehouses (cono, whlo, whnm, divi) VALUES (92, 'W1', 'DC', 'AAA') RETURNING id`)).rows[0].id;
  let t = 1;
  for (const [daysAgo, q] of [[100, 10], [10, 5], [5, -8]]) {
    await query(`INSERT INTO primary_sales_movements (warehouse_id, sku_id, cono, whlo, itno, trdt, rgdt, rgtm, tmsx, trqt)
                 VALUES ($1, $2, 92, 'W1', 'A', DATE '2026-09-20' - $3::int, DATE '2026-09-20' - $3::int, 0, $4, $5)`, [wh, sku.A, daysAgo, t++, q]);
  }
  const { loadWarehouse } = require('../database/load_inventory_ageing');
  await loadWarehouse();
  const w = (await query(`SELECT age_bucket b, units::int u FROM inventory_ageing WHERE source = 'warehouse' ORDER BY 1`)).rows;
  ok(JSON.stringify(w) === JSON.stringify([{ b: 0, u: 5 }, { b: 3, u: 2 }]), `warehouse FIFO: 5 fresh + 2 at 91–180 days ${JSON.stringify(w)}`);
  const wsum = await call(ctrl.getSummary, { source: 'warehouse' });
  ok((wsum.buckets || []).reduce((tt, b) => tt + Number(b.units || 0), 0) === 7, 'warehouse summary shows the 7 units on hand');

  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
