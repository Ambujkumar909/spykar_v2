/**
 * load_primary_sales.js  —  CLI wrapper for the primary-sales (MITTRA) feed
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin command-line front-end over src/services/primarySales.js. The same engine
 * is reused by the syncEngine `syncPrimarySales` stage, so CLI and scheduled
 * sync share one code path.
 *
 *   node src/database/load_primary_sales.js --warehouses
 *        Load/refresh the AAA warehouse master (MITWHL). Run this FIRST.
 *   node src/database/load_primary_sales.js --backfill [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *        One-time history load, date-windowed (monthly chunks). Default from=2022-01-01.
 *   node src/database/load_primary_sales.js --delta
 *        Daily incremental — pulls LMTS > last_lmts, advances the high-water mark.
 *
 * See primary_sales_discovery.sql for the Phase 0 checks that confirm the
 * LMTS / TRDT-index / (cono,whlo,itno,repn) assumptions baked into the engine.
 */

'use strict';

require('dotenv').config();
const primary  = require('../services/primarySales');
const { pool } = require('../config/database');

const ARGS   = process.argv.slice(2);
const argVal = (k) => { const a = ARGS.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
const MODE   = ARGS.includes('--warehouses') ? 'warehouses'
             : ARGS.includes('--delta')      ? 'delta'
             : ARGS.includes('--backfill')   ? 'backfill'
             : ARGS.includes('--reconcile')  ? 'reconcile'
             : null;

async function main() {
  if (!MODE) {
    console.error('Usage: node load_primary_sales.js --warehouses | --backfill [--from= --to=] | --delta [--force] | --reconcile [--from= --to=]');
    process.exit(1);
  }
  console.log('='.repeat(64));
  console.log(`load_primary_sales.js — mode: ${MODE}`);
  console.log('='.repeat(64));

  const t0 = Date.now();
  try {
    if (MODE === 'warehouses') {
      const n = await primary.runWarehouses();
      console.log(`Warehouses upserted: ${n}`);
    } else if (MODE === 'backfill') {
      const r = await primary.runBackfill({
        from: argVal('from') || undefined,
        to: argVal('to') || undefined,
        limit: argVal('limit') || undefined,   // TOP N — validation/smoke test
        truncate: ARGS.includes('--truncate'), // clear the table first
      });
      console.log(`Backfill: loaded=${r.streamed} misses=${r.miss} seconds=${r.seconds} highWaterLmts=${r.maxLmts ? r.maxLmts.toISOString() : 'n/a'}`);
    } else if (MODE === 'reconcile') {
      const r = await primary.reconcile({ from: argVal('from') || undefined, to: argVal('to') || undefined });
      if (r.skipped) console.log('Reconcile skipped — no data window.');
      else console.log(`Reconcile: window=${r.window.join('..')} shortDays=${r.shortDays} healed=${r.healed} unmappableResidual=${r.residual} seconds=${r.seconds}`);
    } else if (MODE === 'delta') {
      // `--force` bootstraps the whole history through the delta path when no
      // backfill has run (high-water = 0). Normally run --backfill first.
      const r = await primary.runDelta({ force: ARGS.includes('--force') });
      if (r.skipped) console.log('Delta skipped — no backfill yet. Run --backfill first, or --delta --force to bootstrap.');
      else console.log(`Delta: merged=${r.merged} misses=${r.miss} highWaterLmts=${r.maxLmts}`);
    }
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch(err => {
  // Preflight errors are already a clear, actionable one-liner — don't bury it
  // under a stack trace.
  if (err.preflight) {
    console.error('\n❌ ' + (err.message || err));
    process.exit(1);
  }
  console.error('\n❌ Fatal:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
