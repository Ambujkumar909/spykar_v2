'use strict';
/**
 * diagnose_sync.js  — Full ERP vs PostgreSQL stock comparison
 *
 * Fetches AIGetStock '01-feb-26' from SQL Server and compares every
 * (store, barcode, qty) row against inventory_snapshot in PostgreSQL.
 *
 * Prints:
 *   - Summary totals (ERP vs PG)
 *   - Rows present in ERP but missing from PG
 *   - Rows where qty differs
 *   - Rows in PG but not in ERP (stale/ghost stock)
 *
 * Run:  node src/database/diagnose_sync.js
 */
require('dotenv').config();
const sql  = require('mssql');
const { Pool } = require('pg');

const STOCK_DATE = '01-feb-26';  // the sample data date — must match syncEngine

const sqlCfg = {
  server: process.env.MSSQL_HOST, port: parseInt(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE, user: process.env.MSSQL_USER, password: process.env.MSSQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true, requestTimeout: 600000, connectionTimeout: 30000 },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
};
const pg = new Pool({
  host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
});

async function run() {
  console.log('='.repeat(72));
  console.log(`ERP vs PostgreSQL STOCK COMPARISON  (AIGetStock '${STOCK_DATE}')`);
  console.log('='.repeat(72));

  let pool;
  try {
    pool = await sql.connect(sqlCfg);
    console.log('✅ SQL Server connected');
  } catch (e) { console.error('❌ SQL Server:', e.message); process.exit(1); }

  // ── 1. Fetch full ERP snapshot ──────────────────────────────────────────────
  console.log(`\nFetching AIGetStock '${STOCK_DATE}' from ERP (may take 1-2 min)...`);
  const erpResult = await pool.request().query(`EXEC AIGetStock '${STOCK_DATE}'`);
  const erpRows   = erpResult.recordset || [];
  console.log(`ERP returned ${erpRows.length} rows`);

  // Build ERP map: "storecode:barcode" → summed qty (handles multi-bin duplicates)
  const erpMap = new Map(); // key → { qty, storeCode, barcode }
  let erpSkipped = 0;
  for (const row of erpRows) {
    const store   = String(row.Storecode || row.STORECODE || row.storecode || '').trim();
    const barcode = String(row.barcode   || row.BARCODE   || row.Barcode   || '').trim();
    const qty     = Math.max(0, parseInt(row.qty || row.QTY || row.Qty || 0));
    if (!store || !barcode) { erpSkipped++; continue; }
    const key = `${store}:${barcode}`;
    const prev = erpMap.get(key);
    if (prev) prev.qty += qty; // SUM multi-bin rows
    else       erpMap.set(key, { qty, store, barcode });
  }
  console.log(`ERP unique (store, barcode) pairs: ${erpMap.size}  (skipped ${erpSkipped} blank rows)`);

  // Count duplicate pairs in ERP (same store+barcode appeared more than once)
  const rawCountMap = new Map();
  for (const row of erpRows) {
    const store   = String(row.Storecode || row.STORECODE || row.storecode || '').trim();
    const barcode = String(row.barcode   || row.BARCODE   || row.Barcode   || '').trim();
    if (!store || !barcode) continue;
    const key = `${store}:${barcode}`;
    rawCountMap.set(key, (rawCountMap.get(key) || 0) + 1);
  }
  const dupeCount = [...rawCountMap.values()].filter(c => c > 1).length;
  if (dupeCount > 0) {
    console.log(`⚠️  ${dupeCount} (store, barcode) pairs had MULTIPLE rows in ERP (multi-bin) — qty was SUMMED`);
  }

  // ── 2. Fetch full PG snapshot ──────────────────────────────────────────────
  console.log('\nFetching inventory_snapshot from PostgreSQL...');
  const pgResult = await pg.query(`
    SELECT l.external_id AS store, s.external_id AS barcode, i.qty_on_hand
    FROM inventory_snapshot i
    JOIN locations l ON l.id = i.location_id
    JOIN skus s ON s.id = i.sku_id
  `);
  const pgRows = pgResult.rows;
  console.log(`PG snapshot rows: ${pgRows.length}`);

  // Build PG map: "storecode:barcode" → qty
  const pgMap = new Map();
  for (const r of pgRows) {
    pgMap.set(`${r.store}:${r.barcode}`, r.qty_on_hand);
  }

  // ── 3. Compare ──────────────────────────────────────────────────────────────
  let erpTotal = 0, pgTotal = 0;
  const missingFromPG  = []; // in ERP but not in PG
  const qtyMismatch    = []; // both exist but qty differs
  const extraInPG      = []; // in PG but not in ERP

  for (const [key, erp] of erpMap) {
    erpTotal += erp.qty;
    const pgQty = pgMap.get(key);
    if (pgQty === undefined) {
      missingFromPG.push({ store: erp.store, barcode: erp.barcode, erpQty: erp.qty });
    } else if (pgQty !== erp.qty) {
      qtyMismatch.push({ store: erp.store, barcode: erp.barcode, erpQty: erp.qty, pgQty });
    }
  }

  for (const [key, pgQty] of pgMap) {
    pgTotal += pgQty;
    if (!erpMap.has(key)) {
      const [store, barcode] = key.split(':', 2);
      extraInPG.push({ store, barcode, pgQty });
    }
  }

  // ── 4. Results ──────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(72));
  console.log('SUMMARY');
  console.log('─'.repeat(72));
  console.log(`  ERP total qty (AIGetStock '${STOCK_DATE}') : ${erpTotal.toLocaleString()}`);
  console.log(`  PG  total qty (inventory_snapshot)        : ${pgTotal.toLocaleString()}`);
  console.log(`  Difference (PG - ERP)                     : ${(pgTotal - erpTotal).toLocaleString()}`);
  console.log(`  ERP unique pairs                          : ${erpMap.size.toLocaleString()}`);
  console.log(`  PG  snapshot rows                         : ${pgMap.size.toLocaleString()}`);
  console.log();
  console.log(`  ❌ Missing from PG (in ERP, not in PG)    : ${missingFromPG.length.toLocaleString()}`);
  console.log(`  ❌ Qty mismatch (both exist, diff value)   : ${qtyMismatch.length.toLocaleString()}`);
  console.log(`  ⚠️  Extra in PG (stale / not in ERP)       : ${extraInPG.length.toLocaleString()}`);

  const missingQty  = missingFromPG.reduce((s, r) => s + r.erpQty, 0);
  const mismatchQty = qtyMismatch.reduce((s, r) => s + Math.abs(r.erpQty - r.pgQty), 0);
  const extraQty    = extraInPG.reduce((s, r) => s + r.pgQty, 0);
  console.log(`  Units missing from PG                     : ${missingQty.toLocaleString()}`);
  console.log(`  Units with wrong qty in PG                : ${mismatchQty.toLocaleString()}`);
  console.log(`  Extra (stale) units in PG                 : ${extraQty.toLocaleString()}`);

  // ── 5. Top mismatches ───────────────────────────────────────────────────────
  if (qtyMismatch.length > 0) {
    console.log('\n─── Top 20 qty mismatches ───────────────────────────────────────────');
    console.log('  Store   Barcode             ERP qty  PG qty   Diff');
    console.log('  ' + '-'.repeat(60));
    qtyMismatch
      .sort((a, b) => Math.abs(b.erpQty - b.pgQty) - Math.abs(a.erpQty - a.pgQty))
      .slice(0, 20)
      .forEach(r => {
        const diff = r.erpQty - r.pgQty;
        console.log(`  ${String(r.store).padEnd(7)} ${String(r.barcode).padEnd(19)} ${String(r.erpQty).padEnd(8)} ${String(r.pgQty).padEnd(8)} ${diff > 0 ? '+' : ''}${diff}`);
      });
  }

  if (missingFromPG.length > 0) {
    console.log('\n─── Top 20 missing from PG ──────────────────────────────────────────');
    console.log('  Store   Barcode             ERP qty');
    console.log('  ' + '-'.repeat(40));
    missingFromPG
      .sort((a, b) => b.erpQty - a.erpQty)
      .slice(0, 20)
      .forEach(r => console.log(`  ${String(r.store).padEnd(7)} ${String(r.barcode).padEnd(19)} ${r.erpQty}`));
  }

  if (extraInPG.length > 0) {
    console.log('\n─── Top 20 stale PG rows (not in ERP) ──────────────────────────────');
    console.log('  Store   Barcode             PG qty (stale)');
    console.log('  ' + '-'.repeat(45));
    extraInPG
      .sort((a, b) => b.pgQty - a.pgQty)
      .slice(0, 20)
      .forEach(r => console.log(`  ${String(r.store).padEnd(7)} ${String(r.barcode).padEnd(19)} ${r.pgQty}`));
  }

  // ── 6. Per-store summary ────────────────────────────────────────────────────
  console.log('\n─── Per-store mismatch summary (top 20 by discrepancy) ─────────────');
  const storeDiscrepancy = new Map();
  for (const r of qtyMismatch) {
    const d = storeDiscrepancy.get(r.store) || { erpQty: 0, pgQty: 0, items: 0 };
    d.erpQty += r.erpQty; d.pgQty += r.pgQty; d.items++;
    storeDiscrepancy.set(r.store, d);
  }
  for (const r of missingFromPG) {
    const d = storeDiscrepancy.get(r.store) || { erpQty: 0, pgQty: 0, items: 0 };
    d.erpQty += r.erpQty; d.items++;
    storeDiscrepancy.set(r.store, d);
  }
  [...storeDiscrepancy.entries()]
    .sort((a, b) => Math.abs(b[1].erpQty - b[1].pgQty) - Math.abs(a[1].erpQty - a[1].pgQty))
    .slice(0, 20)
    .forEach(([store, d]) => {
      console.log(`  Store ${String(store).padEnd(8)} ERP=${d.erpQty} PG=${d.pgQty} diff=${d.erpQty - d.pgQty} (${d.items} SKUs)`);
    });

  console.log('\n' + '='.repeat(72));
  if (missingFromPG.length === 0 && qtyMismatch.length === 0 && extraInPG.length === 0) {
    console.log('✅ PERFECT MATCH — PG exactly matches ERP');
  } else {
    console.log('Fix: run a FULL sync (syncEngine.runDeltaSync("FULL")) to re-align PG with ERP');
  }
  console.log('='.repeat(72));

  await pool.close();
  await pg.end();
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
