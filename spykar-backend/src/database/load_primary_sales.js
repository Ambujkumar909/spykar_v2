/**
 * load_primary_sales.js  —  CLI wrapper for the primary-sales (MITTRA) feed
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin command-line front-end over src/services/primarySales.js. The same engine
 * is reused by the syncEngine `syncPrimarySales` stage, so CLI and scheduled
 * sync share one code path.
 *
 *   node src/database/load_primary_sales.js --warehouses
 *        Load/refresh the AAA warehouse master (MITWHL). Run this FIRST.
 *   node src/database/load_primary_sales.js --backfill [--truncate] [--from=YYYY-MM-DD --to=YYYY-MM-DD] [--limit=N]
 *        History load, streamed ONE WHLO AT A TIME with per-chunk progress in
 *        primary_backfill_progress — re-run the same command after a crash /
 *        VPN drop and it resumes at the interrupted warehouse.
 *          empty ledger            → bulk index-light COPY, then full rollup (off-lock swap)
 *          progress rows present   → resume
 *          --from/--to on a loaded → (re)load that window via UPSERT, indexes live
 *          --truncate              → wipe ledger + feed state, fresh full load
 *          --limit=N               → smoke test via UPSERT (safe on any table state)
 *        A populated ledger with no progress and no window is REFUSED (would duplicate).
 *   node src/database/load_primary_sales.js --delta [--force]
 *        Incremental — pulls LMTS > high-water (minus overlap), upserts, refreshes
 *        the rollup for the touched dates only. --force on an EMPTY ledger runs the
 *        backfill instead (never the 110M-row temp-table path).
 *   node src/database/load_primary_sales.js --remap
 *        Heal previously-unmappable item codes that the SKU master now resolves
 *        (pulls exactly those ITNOs from M3). Runs automatically in every sync.
 *   node src/database/load_primary_sales.js --rollup
 *        Rebuild the speed layer (both rollups) from the ledger, off-lock, atomic swap.
 *   node src/database/load_primary_sales.js --reconcile [--from= --to=]
 *        Self-heal: per-day M3 vs PG counts (default last PRIMARY_RECONCILE_DAYS=45
 *        days), batched re-pull of short days, remembers unmappable residue so
 *        it is not re-chased. Runs automatically in the 23:00 sync.
 *
 * See primary_sales_discovery.sql for the Phase 0 checks that confirm the
 * LMTS / TRDT-index / (cono,whlo,itno,rgdt,rgtm,tmsx) assumptions baked into the engine.
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
             : ARGS.includes('--rollup')     ? 'rollup'
             : ARGS.includes('--remap')      ? 'remap'
             : null;

async function main() {
  if (!MODE) {
    console.error('Usage: node load_primary_sales.js --warehouses | --backfill [--truncate] [--from= --to=] [--limit=N] | --delta [--force] | --reconcile [--from= --to=] | --rollup | --remap');
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
      console.log(`Backfill (${r.mode}): streamed=${r.streamed} changed=${r.merged} unmappable=${r.miss} seconds=${r.seconds} highWaterLmts=${r.maxLmts ? r.maxLmts.toISOString() : 'n/a'}`);
    } else if (MODE === 'remap') {
      // After a SKU-master refresh: load the history of item codes that were
      // unmappable before and resolve now.
      const r = await primary.remap();
      console.log(`Remap: items=${r.items} streamed=${r.streamed} loaded=${r.merged} dates=${r.dates} seconds=${r.seconds}`);
    } else if (MODE === 'rollup') {
      // Rebuild both rollups from the ledger off-lock and swap them in (no M3
      // needed). Use after a SKU-master price/category change, or to physically
      // re-cluster the sku-grain rollup by date on an existing deployment.
      const n = await primary.rebuildRollup();
      console.log(`Rollup rebuilt: ${n} sku-grain rows (warehouse grain derived + swapped in the same transaction)`);
    } else if (MODE === 'reconcile') {
      const r = await primary.reconcile({ from: argVal('from') || undefined, to: argVal('to') || undefined });
      if (r.skipped) console.log('Reconcile skipped — no data window.');
      else console.log(`Reconcile: window=${r.window.join('..')} checkedDays=${r.checkedDays} rePulledDays=${r.shortDays} knownResidualDays=${r.knownDays} healed=${r.healed} changed=${r.changed} newResidual=${r.residual} knownResidual=${r.knownResidual} seconds=${r.seconds}`);
    } else if (MODE === 'delta') {
      // `--force` on an empty ledger bootstraps via the chunked backfill.
      const r = await primary.runDelta({ force: ARGS.includes('--force') });
      if (r.skipped) console.log('Delta skipped — no backfill yet. Run --backfill first, or --delta --force to bootstrap.');
      else if (r.bootstrapped) console.log(`Delta bootstrapped via backfill: loaded=${r.streamed} unmappable=${r.miss} highWaterLmts=${r.maxLmts ? r.maxLmts.toISOString() : 'n/a'}`);
      else console.log(`Delta: streamed=${r.streamed} changed=${r.merged} dates=${(r.dates || []).length} unmappable=${r.miss} highWaterLmts=${r.maxLmts ? r.maxLmts.toISOString() : 'n/a'}`);
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
