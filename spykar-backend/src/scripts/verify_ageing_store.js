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

  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
