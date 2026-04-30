#!/usr/bin/env node
'use strict';
/**
 * Stock History Verifier — 100% accuracy gate
 * ─────────────────────────────────────────────────────────────────────────────
 * For each sample date, fetches `EXEC AIGetStock 'DD-mon-YY'` LIVE from SQL
 * Server, aggregates by (storecode, barcode), and compares against
 * `inventory_daily_snapshot` in PostgreSQL.
 *
 * Reports:
 *   - ERP total qty vs PG total qty
 *   - Row-level diffs (missing in PG, extra in PG, qty mismatches)
 *   - Per-store diff buckets
 *   - PASS/FAIL gate (FAIL if any qty mismatch above the tolerance threshold)
 *
 * Usage:
 *   node src/scripts/verify_stock_history.js                       # samples 5 random loaded dates
 *   node src/scripts/verify_stock_history.js 2025-01-25 2025-02-01 # specific dates
 *   node src/scripts/verify_stock_history.js --all                 # every date in load log (slow!)
 *
 * The user's success criterion is "100% accuracy, not 1 item absent" — this
 * script is the audit gate. Wire it into CI to block deploys if drift appears.
 */

require('dotenv').config();

const sql       = require('mssql');
const { query } = require('../config/database');
const { toErpDate, toPgDate } = require('../services/historicalStockLoader');

const sqlServerConfig = {
  server:   process.env.MSSQL_HOST,
  port:     parseInt(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt:                process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    requestTimeout:         900000,
    connectionTimeout:      30000,
  },
  pool: { max: 2, min: 0 },
};

function col(row, ...names) {
  for (const name of names) {
    if (row[name]               !== undefined && row[name] !== null) return row[name];
    if (row[name.toUpperCase()] !== undefined && row[name.toUpperCase()] !== null) return row[name.toUpperCase()];
    if (row[name.toLowerCase()] !== undefined && row[name.toLowerCase()] !== null) return row[name.toLowerCase()];
  }
  return null;
}

async function pickSampleDates() {
  const r = await query(`
    SELECT snapshot_date FROM stock_history_load_log
     WHERE status = 'SUCCESS'
     ORDER BY random()
     LIMIT 5
  `);
  return r.rows.map(x => toPgDate(x.snapshot_date));
}

async function loadedDates() {
  const r = await query(`SELECT snapshot_date FROM stock_history_load_log WHERE status = 'SUCCESS' ORDER BY snapshot_date`);
  return r.rows.map(x => toPgDate(x.snapshot_date));
}

async function fetchErpStock(pool, snapshotDate) {
  const erpDateStr = toErpDate(snapshotDate);
  const r = await pool.request().query(`EXEC AIGetStock '${erpDateStr}'`);
  const rows = r.recordset || [];
  const map  = new Map();
  let total  = 0;
  for (const row of rows) {
    const storeCode = String(col(row, 'Storecode', 'STORECODE', 'storecode') || '').trim().toUpperCase();
    const barcode   = String(col(row, 'barcode',   'BARCODE',   'Barcode')   || '').trim().toUpperCase();
    const qty       = Math.max(0, parseInt(col(row, 'qty', 'QTY', 'Qty') || 0));
    if (!storeCode || !barcode) continue;
    const key = `${storeCode}:${barcode}`;
    map.set(key, (map.get(key) || 0) + qty);
    total += qty;
  }
  return { rows: rows.length, map, total };
}

async function fetchPgStock(snapshotDate) {
  const r = await query(`
    SELECT
      COALESCE(l.external_id, l.code)::text          AS store_code,
      COALESCE(s.barcode, s.external_id)::text       AS barcode,
      ids.qty_on_hand                                AS qty
    FROM inventory_daily_snapshot ids
    JOIN locations l ON l.id = ids.location_id
    JOIN skus      s ON s.id = ids.sku_id
    WHERE ids.snapshot_date = $1
  `, [snapshotDate]);
  const map = new Map();
  let total = 0;
  for (const row of r.rows) {
    const key = `${String(row.store_code).toUpperCase().trim()}:${String(row.barcode).toUpperCase().trim()}`;
    map.set(key, (map.get(key) || 0) + row.qty);
    total += row.qty;
  }
  return { map, total };
}

function diffMaps(erpMap, pgMap) {
  const missingInPg = [];
  const extraInPg   = [];
  const qtyMismatch = [];
  for (const [k, erpQty] of erpMap) {
    const pgQty = pgMap.get(k);
    if (pgQty === undefined) missingInPg.push({ key: k, erpQty });
    else if (pgQty !== erpQty) qtyMismatch.push({ key: k, erpQty, pgQty, diff: pgQty - erpQty });
  }
  for (const [k, pgQty] of pgMap) {
    if (!erpMap.has(k)) extraInPg.push({ key: k, pgQty });
  }
  return { missingInPg, extraInPg, qtyMismatch };
}

async function verifyDate(pool, snapshotDate) {
  console.log(`\n── ${snapshotDate} ─────────────────────────────────────────────────────`);
  const t0 = Date.now();
  const [erp, pg] = await Promise.all([
    fetchErpStock(pool, snapshotDate),
    fetchPgStock(snapshotDate),
  ]);
  const fetchMs = Date.now() - t0;

  const diff = diffMaps(erp.map, pg.map);
  const allMatch =
    diff.missingInPg.length === 0 &&
    diff.extraInPg.length   === 0 &&
    diff.qtyMismatch.length === 0;

  console.log(`  ERP : ${erp.rows.toLocaleString()} raw rows · ${erp.map.size.toLocaleString()} unique pairs · qty=${erp.total.toLocaleString()}`);
  console.log(`  PG  : ${pg.map.size.toLocaleString()} pairs · qty=${pg.total.toLocaleString()}`);
  console.log(`  Δ   : qty diff=${(pg.total - erp.total).toLocaleString()}  (fetched in ${fetchMs}ms)`);
  console.log(`  Missing in PG : ${diff.missingInPg.length.toLocaleString()}`);
  console.log(`  Extra in PG   : ${diff.extraInPg.length.toLocaleString()}`);
  console.log(`  Qty mismatch  : ${diff.qtyMismatch.length.toLocaleString()}`);

  if (!allMatch) {
    console.log('  Sample diffs:');
    diff.missingInPg.slice(0, 5).forEach(d => console.log(`    [MISSING]  ${d.key}  erp=${d.erpQty}`));
    diff.qtyMismatch.slice(0, 5).forEach(d => console.log(`    [MISMATCH] ${d.key}  erp=${d.erpQty} pg=${d.pgQty} (Δ${d.diff})`));
    diff.extraInPg.slice(0, 5).forEach(d => console.log(`    [EXTRA]    ${d.key}  pg=${d.pgQty}`));
  }

  console.log(`  ${allMatch ? '✅ PASS' : '❌ FAIL'}`);
  return { date: snapshotDate, pass: allMatch, diff, erpTotal: erp.total, pgTotal: pg.total };
}

(async () => {
  const argv = process.argv.slice(2);
  let dates;
  if (argv.length === 0)        dates = await pickSampleDates();
  else if (argv[0] === '--all') dates = await loadedDates();
  else                          dates = argv;

  if (!dates.length) {
    console.log('No loaded dates found in stock_history_load_log. Run the backfill first.');
    process.exit(1);
  }

  console.log('═'.repeat(78));
  console.log('  STOCK HISTORY VERIFIER  —  ERP (AIGetStock) vs PG (inventory_daily_snapshot)');
  console.log('═'.repeat(78));
  console.log(`  Verifying ${dates.length} date${dates.length === 1 ? '' : 's'}`);

  const pool = await sql.connect(sqlServerConfig);
  const results = [];
  try {
    for (const d of dates) results.push(await verifyDate(pool, d));
  } finally {
    await pool.close().catch(() => {});
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log('\n' + '═'.repeat(78));
  console.log('  SUMMARY');
  console.log('═'.repeat(78));
  console.log(`  Dates verified : ${results.length}`);
  console.log(`  ✅ Passed       : ${passed}`);
  console.log(`  ❌ Failed       : ${failed}`);
  console.log('═'.repeat(78));

  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('❌', err.message); console.error(err.stack); process.exit(1); });
