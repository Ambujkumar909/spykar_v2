// Sales analytics consistency on a fresh DB with seeded movements:
//   • rollup fast path == live path, for every mode (active / inactive / all)
//   • archived stores (is_active=false) never count, on either path
//   • city / state filters match exactly (no "Navi Mumbai" in "Mumbai")
//   • category totals include sales of since-deactivated SKUs
//   • a missing / array mode behaves as 'active'
// Run: node src/scripts/verify_sales_paths.js
'use strict';
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_sales_paths_test';
process.env.PG_DATABASE = DB; process.env.LOG_LEVEL = 'error';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT || 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  ok(/completed successfully/.test(spawnSync(process.execPath, [path.join(__dirname, '..', 'database', 'migrate.js')], { env: process.env, encoding: 'utf8' }).stdout), 'fresh DB migrated');
  const { query, pool } = require('../config/database');
  const cache = require('../config/cache');
  const { rebuildAll } = require('../services/salesRollup');
  const ctrl = require('../controllers/analytics.controller');

  // stores: Mumbai open, Navi Mumbai open, closed store, ARCHIVED store (dropped from ERP)
  const L = {};
  for (const [code, city, closed, active] of [['S1', 'Mumbai', false, true], ['S2', 'Navi Mumbai', false, true], ['S3', 'Pune', true, true], ['S4', 'Mumbai', false, false]]) {
    L[code] = (await query(`INSERT INTO locations (code, name, type, external_id, city, state, group_name, shop_closed, is_active)
      VALUES ($1, $5, 'COCO', $1, $2, 'Maharashtra', 'EBO', $3, $4) RETURNING id`, [code, city, closed, active, `${code} store`])).rows[0].id;
  }
  const K = {};
  for (const [code, cat, active] of [['K1', 'DENIM', true], ['K2', 'DENIM', false], ['K3', 'SHIRT', true]]) {
    K[code] = (await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, cost_price, gst_rate, category_norm, is_active, external_id)
      VALUES ($1, $4, 'B', 'Black', '32', 1000, 400, 12, $2, $3, $1) RETURNING id`, [code, cat, active, `P ${code}`])).rows[0].id;
  }
  // 30 days of sales + some returns across every store/sku, IST dates
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    const day = `2026-06-${String(d).padStart(2, '0')}`;
    for (const s of Object.keys(L)) for (const k of Object.keys(K)) {
      const q = ((d * 7 + s.charCodeAt(1) * 3 + k.charCodeAt(1)) % 5) + 1;
      await query(`INSERT INTO inventory_movements (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, sale_value, reference_no, synced_from)
        VALUES ($1, $2, 'SALE', $3, 0, 0, ($4::date + time '14:00') AT TIME ZONE 'Asia/Kolkata', $5, $6, 'TEST')`, [L[s], K[k], -q, day, q * 900, `INV-${++n}`]);
      if (d % 6 === 0) await query(`INSERT INTO inventory_movements (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, sale_value, reference_no, synced_from)
        VALUES ($1, $2, 'RETURN', 1, 0, 0, ($3::date + time '23:30') AT TIME ZONE 'Asia/Kolkata', 900, $4, 'TEST')`, [L[s], K[k], day, `RET-${++n}`]);
    }
  }
  const c = await pool.connect();
  try { await c.query('BEGIN'); await rebuildAll(c); await c.query('COMMIT'); } finally { c.release(); }
  ok(true, `seeded ${n} movements and built the rollups`);

  const call = (q) => new Promise((resolve, reject) => ctrl.getSalesAnalytics({ query: q, params: {}, headers: {} }, { json: (b) => resolve(b.data), status() { return this; } }, reject));
  const S = (d) => d.summary || {};
  const expect = async (sql, params) => (await query(sql, params)).rows[0];
  const truth = (modeSql) => expect(`
    SELECT COALESCE(SUM(ABS(m.qty_change)) FILTER (WHERE m.movement_type='SALE'),0)::int AS sold,
           COALESCE(SUM(ABS(m.qty_change)) FILTER (WHERE m.movement_type='RETURN'),0)::int AS returned
      FROM inventory_movements m JOIN locations l ON l.id = m.location_id
     WHERE l.is_active ${modeSql} AND m.moved_at >= '2026-06-01' AND m.moved_at < '2026-07-01'`);

  const win = { date_from: '2026-06-01', date_to: '2026-06-30' };
  for (const [mode, modeSql] of [['active', 'AND NOT l.shop_closed'], ['inactive', 'AND l.shop_closed'], ['all', '']]) {
    cache.clear();
    const fast = await call({ ...win, mode });                                   // rollup fast path
    cache.clear();
    const live = await call({ ...win, mode, state: 'Maharashtra' });             // forces the live path, same set
    const t = await truth(modeSql);
    const fs = S(fast), ls = S(live);
    const soldKey = Object.keys(fs).find((k) => /units_sold|sales_qty|total_units/.test(k));
    ok(!!soldKey, `[${mode}] summary exposes units sold (${soldKey})`);
    ok(Number(fs[soldKey]) === t.sold && Number(ls[soldKey]) === t.sold, `[${mode}] fast path ${fs[soldKey]} == live path ${ls[soldKey]} == truth ${t.sold} (archived store excluded)`);
    const keys = Object.keys(fs).filter((k) => typeof fs[k] === 'number');
    const diff = keys.filter((k) => Math.abs(Number(fs[k]) - Number(ls[k])) > 1);
    ok(diff.length === 0, `[${mode}] every numeric summary field agrees between paths${diff.length ? ' — differs: ' + diff.map((k) => `${k} ${fs[k]}≠${ls[k]}`).join(', ') : ''}`);
  }

  cache.clear();
  const mum = S(await call({ ...win, mode: 'all', city: 'Mumbai' }));
  const tMum = await expect(`SELECT SUM(ABS(m.qty_change))::int AS sold FROM inventory_movements m JOIN locations l ON l.id=m.location_id
    WHERE m.movement_type='SALE' AND l.is_active AND l.city='Mumbai'`);
  const soldKey = Object.keys(mum).find((k) => /units_sold|sales_qty|total_units/.test(k));
  ok(Number(mum[soldKey]) === tMum.sold, `city=Mumbai is exact: ${mum[soldKey]} == ${tMum.sold} (Navi Mumbai not included)`);

  cache.clear();
  const denim = S(await call({ ...win, mode: 'all', category: 'DENIM' }));
  const tDen = await expect(`SELECT SUM(ABS(m.qty_change))::int AS sold FROM inventory_movements m JOIN locations l ON l.id=m.location_id JOIN skus s ON s.id=m.sku_id
    WHERE m.movement_type='SALE' AND l.is_active AND s.category_norm='DENIM'`);
  ok(Number(denim[soldKey]) === tDen.sold, `category=DENIM includes the deactivated DENIM SKU: ${denim[soldKey]} == ${tDen.sold}`);

  cache.clear();
  const noMode = S(await call({ ...win }));
  cache.clear();
  const arrMode = S(await call({ ...win, mode: ['active', 'all'] }));
  const tAct = await truth('AND NOT l.shop_closed');
  ok(Number(noMode[soldKey]) === tAct.sold && Number(arrMode[soldKey]) === tAct.sold, `missing mode and ?mode=a&mode=b both behave as active (${noMode[soldKey]}, ${arrMode[soldKey]})`);

  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
  console.log(fails ? `❌ ${fails} failed` : '✅ all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
