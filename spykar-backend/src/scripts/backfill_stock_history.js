#!/usr/bin/env node
'use strict';
/**
 * Stock History Backfill — CLI runner
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads historical stock from SQL Server (`EXEC AIGetStock 'DD-mon-YY'`) into
 * `inventory_daily_snapshot` for every date in a given range.
 *
 * Run migration 007 BEFORE invoking this script:
 *   psql $PG_URL -f src/database/migrations/007_world_class_foundation.sql
 *
 * Usage:
 *   node src/scripts/backfill_stock_history.js                     # default: 2024-01-01 → 2026-02-01
 *   node src/scripts/backfill_stock_history.js 2024-06-01 2024-12-31
 *   node src/scripts/backfill_stock_history.js --retry-failed      # retry FAILED rows only
 *   node src/scripts/backfill_stock_history.js --force 2024-01-01 2024-01-31  # re-load even SUCCESS dates
 *
 * Designed to be run overnight. Resumes from the last completed date if
 * interrupted (Ctrl+C, crash, network blip — all safe). Per-date progress is
 * persisted in stock_history_load_log so you can tail it from another shell:
 *   psql $PG_URL -c "SELECT snapshot_date, status, resolved_rows, duration_ms
 *                      FROM stock_history_load_log ORDER BY snapshot_date DESC LIMIT 20;"
 */

require('dotenv').config();

const {
  backfillStockHistory,
  retryFailedDates,
} = require('../services/historicalStockLoader');

// Defaults match the ERP data window declared in syncEngine.js
// (FULL_HISTORY_START = 2024-01-01, STOCK_SNAPSHOT_DATE = 2026-02-01)
const DEFAULT_FROM = '2024-01-01';
const DEFAULT_TO   = '2026-02-01';

function parseArgs(argv) {
  const args = { force: false, retryFailed: false, from: DEFAULT_FROM, to: DEFAULT_TO };
  const positional = [];
  for (const a of argv.slice(2)) {
    if (a === '--force')         args.force = true;
    else if (a === '--retry-failed') args.retryFailed = true;
    else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    else positional.push(a);
  }
  if (positional.length === 1) { args.from = positional[0]; args.to = positional[0]; }
  else if (positional.length === 2) { args.from = positional[0]; args.to = positional[1]; }
  else if (positional.length > 2) { console.error('Too many positional args; expected at most 2 (from, to)'); process.exit(2); }
  return args;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

(async () => {
  const args = parseArgs(process.argv);
  console.log('═'.repeat(78));
  console.log('  SPYKAR — Historical Stock Backfill');
  console.log('═'.repeat(78));
  if (args.retryFailed) {
    console.log('  Mode      : RETRY FAILED');
  } else {
    console.log(`  Range     : ${args.from} → ${args.to}`);
    console.log(`  Force     : ${args.force}`);
  }
  console.log('  ERP source: EXEC AIGetStock \'DD-mon-YY\'  (SQL Server STOREDB)');
  console.log('  Target    : inventory_daily_snapshot (PostgreSQL)');
  console.log('═'.repeat(78));
  console.log();

  const startedAt = Date.now();

  // Live progress line (carriage-return updates) so the operator can leave it
  // running overnight and check on it without spamming the log file.
  const onProgress = ({ done, total, lastDate, stats }) => {
    const pct       = ((done / total) * 100).toFixed(1);
    const elapsed   = Date.now() - startedAt;
    const perDate   = elapsed / done;
    const remaining = (total - done) * perDate;
    process.stdout.write(
      `\r  ▸ ${done}/${total} (${pct}%)  last=${lastDate}  ` +
      `ok=${stats.succeeded} fail=${stats.failed}  ` +
      `eta=${fmtDuration(remaining)}    `
    );
  };

  try {
    const result = args.retryFailed
      ? await retryFailedDates()
      : await backfillStockHistory(args.from, args.to, { force: args.force, onProgress });

    process.stdout.write('\n\n');
    console.log('─'.repeat(78));
    console.log('  RESULT');
    console.log('─'.repeat(78));
    console.log(`  Total dates queued : ${result.totalDates}`);
    console.log(`  ✅ Succeeded        : ${result.succeeded}`);
    console.log(`  ❌ Failed           : ${result.failed}`);
    console.log(`  ⏭  Skipped (cached) : ${result.skipped}`);
    console.log(`  Total duration     : ${fmtDuration(result.durationMs || (Date.now() - startedAt))}`);
    console.log('─'.repeat(78));

    if (result.failed > 0) {
      console.log();
      console.log('  Some dates failed. Re-run with --retry-failed once the source is reachable:');
      console.log('    node src/scripts/backfill_stock_history.js --retry-failed');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    process.stdout.write('\n\n');
    console.error('❌ Backfill aborted:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
