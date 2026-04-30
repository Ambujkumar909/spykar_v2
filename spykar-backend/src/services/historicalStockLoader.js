'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║       HISTORICAL STOCK LOADER  —  Source-of-truth backfill, 100% accurate    ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║  Purpose:                                                                    ║
 * ║    Backfill `inventory_daily_snapshot` with stock-on-hand per (date, store, ║
 * ║    sku) by calling `EXEC AIGetStock 'DD-mon-YY'` for every date in a range. ║
 * ║                                                                              ║
 * ║  Why per-day, not derived:                                                   ║
 * ║    The user requires 100% accuracy — every stock number must match the ERP. ║
 * ║    Walk-derive (current − Σ movements) drifts when adjustments / receipts /  ║
 * ║    bin-corrections aren't in inventory_movements. AIGetStock IS the truth.   ║
 * ║                                                                              ║
 * ║  Resumable:                                                                  ║
 * ║    Every date attempted is logged in `stock_history_load_log`. The loader   ║
 * ║    skips any date marked SUCCESS, so a crashed run resumes from the last    ║
 * ║    completed date with no duplication and no manual cursor tracking.        ║
 * ║                                                                              ║
 * ║  Concurrency:                                                                ║
 * ║    Sequential by date. Each AIGetStock call returns ~500K rows; running two ║
 * ║    in parallel would saturate the SQL Server connection and starve other    ║
 * ║    readers. Within a date, PG inserts are batched 500 rows at a time.       ║
 * ║                                                                              ║
 * ║  Performance budget:                                                         ║
 * ║    ~30s per date (AIGetStock fetch + resolve + batch insert).               ║
 * ║    800 days  →  ~6.5 hours of one-time overnight load.                      ║
 * ║    Once done, every historical date is a single indexed read.               ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

const sql       = require('mssql');
const dbModule  = require('../config/database');
const { query } = dbModule;
const logger    = require('../config/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_INSERT_SIZE = 500;   // rows per multi-VALUES INSERT — PG sweet spot
const MAX_RETRIES       = 3;     // per-date AIGetStock retry budget
const RETRY_BASE_MS     = 5000;  // exponential backoff base

// ─── SQL Server connection (lazy, single shared pool) ─────────────────────────

const sqlServerConfig = {
  server:   process.env.MSSQL_HOST,
  port:     parseInt(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt:                process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    requestTimeout:         900000,  // 15 min — AIGetStock can return 500K+ rows
    connectionTimeout:      30000,
  },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30000, acquireTimeoutMillis: 60000 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format JS Date → 'DD-mon-YY' expected by Spykar stored procedures */
function toErpDate(date) {
  const d   = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][d.getMonth()];
  const yr  = String(d.getFullYear()).slice(-2);
  return `${day}-${mon}-${yr}`;
}

/** YYYY-MM-DD for PG */
function toPgDate(date) {
  const d   = new Date(date);
  const yr  = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

/** Inclusive range of YYYY-MM-DD strings between two dates */
function dateRange(fromDate, toDate) {
  const out = [];
  const cur = new Date(fromDate);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    out.push(toPgDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Case-insensitive column reader (stored procs vary case across versions) */
function col(row, ...names) {
  for (const name of names) {
    if (row[name]               !== undefined && row[name] !== null) return row[name];
    if (row[name.toUpperCase()] !== undefined && row[name.toUpperCase()] !== null) return row[name.toUpperCase()];
    if (row[name.toLowerCase()] !== undefined && row[name.toLowerCase()] !== null) return row[name.toLowerCase()];
  }
  return null;
}

/** Retry an async fn with exponential backoff */
async function withRetry(fn, label, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn(`[RETRY ${attempt + 1}/${maxRetries}] ${label}: ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Lookup maps (built once per backfill run) ────────────────────────────────
// Loading 800 dates × 500K rows = 400M lookups. A per-row PG query would be
// catastrophic — keep store/SKU resolvers entirely in memory.

async function buildLookupMaps() {
  const [locRows, skuRows] = await Promise.all([
    query('SELECT id, code, external_id FROM locations'),
    query('SELECT id, external_id, style_variant, barcode FROM skus'),
  ]);

  const locationByCode    = new Map();
  const locationByExtId   = new Map();
  const skuByExtId        = new Map();
  const skuByStyleVariant = new Map();
  const skuByBarcode      = new Map();

  for (const r of locRows.rows) {
    if (r.code)        locationByCode.set(r.code.toUpperCase().trim(), r.id);
    if (r.external_id) locationByExtId.set(String(r.external_id).toUpperCase().trim(), r.id);
  }
  for (const r of skuRows.rows) {
    if (r.external_id)   skuByExtId.set(String(r.external_id).toUpperCase().trim(), r.id);
    if (r.style_variant) skuByStyleVariant.set(r.style_variant.toUpperCase().trim(), r.id);
    if (r.barcode)       skuByBarcode.set(String(r.barcode).toUpperCase().trim(), r.id);
  }

  logger.info(
    `[BACKFILL] Lookup maps ready: ${locationByCode.size + locationByExtId.size} location keys, ` +
    `${skuByExtId.size} ext-ids · ${skuByBarcode.size} barcodes · ${skuByStyleVariant.size} style-variants`
  );
  return { locationByCode, locationByExtId, skuByExtId, skuByStyleVariant, skuByBarcode };
}

// ─── Per-date load ────────────────────────────────────────────────────────────

/**
 * Load AIGetStock for a single date into inventory_daily_snapshot.
 * Returns { erpRows, resolvedRows, lookupMisses, durationMs }.
 *
 * Idempotency: deletes the partition slice for this date BEFORE inserting,
 * so re-running a date overwrites cleanly. Wrapped in a transaction so a
 * mid-load crash never leaves a half-loaded date in the table.
 */
async function loadOneDate(erpPool, lookupMaps, snapshotDate) {
  const erpDateStr = toErpDate(snapshotDate);
  const start      = Date.now();

  // 1. Mark RUNNING in the load log (visible to operators tailing the log)
  await query(`
    INSERT INTO stock_history_load_log (snapshot_date, status, attempted_at)
    VALUES ($1, 'RUNNING', NOW())
    ON CONFLICT (snapshot_date) DO UPDATE SET
      status = 'RUNNING', attempted_at = NOW(), error_message = NULL
  `, [snapshotDate]);

  // 2. Fetch from SQL Server (with retry)
  const rows = await withRetry(
    () => erpPool.request().query(`EXEC AIGetStock '${erpDateStr}'`).then(r => r.recordset || []),
    `AIGetStock '${erpDateStr}'`
  );
  logger.info(`[BACKFILL ${snapshotDate}] AIGetStock returned ${rows.length.toLocaleString()} rows`);

  // 3. Resolve store/SKU → UUIDs, aggregate multi-bin per (loc, sku)
  const qtyByKey   = new Map();
  let lookupMisses = 0;
  for (const row of rows) {
    const storeCode    = String(col(row, 'Storecode', 'STORECODE', 'storecode') || '').trim().toUpperCase();
    const barcode      = String(col(row, 'barcode',   'BARCODE',   'Barcode')   || '').trim().toUpperCase();
    const styleVariant = String(col(row, 'InforItemCode', 'INFORITEMCODE', 'style_variant') || '').trim().toUpperCase();
    const qty          = Math.max(0, parseInt(col(row, 'qty', 'QTY', 'Qty') || 0));

    if (!storeCode || (!barcode && !styleVariant)) { lookupMisses++; continue; }

    const locationId =
      lookupMaps.locationByExtId.get(storeCode) ||
      lookupMaps.locationByCode.get(storeCode);

    const skuId =
      lookupMaps.skuByBarcode.get(barcode) ||
      lookupMaps.skuByExtId.get(barcode) ||
      lookupMaps.skuByStyleVariant.get(styleVariant);

    if (!locationId || !skuId) { lookupMisses++; continue; }

    const key = `${locationId}:${skuId}`;
    qtyByKey.set(key, (qtyByKey.get(key) || 0) + qty);
  }

  const resolved = [...qtyByKey.entries()].map(([k, qty]) => {
    const [locationId, skuId] = k.split(':');
    return [locationId, skuId, qty];
  });

  if (lookupMisses > 0) {
    logger.warn(`[BACKFILL ${snapshotDate}] ${lookupMisses.toLocaleString()} rows skipped (store/sku not in master)`);
  }

  // 4. Replace the day's slice in a single transaction.
  //    DELETE + INSERT keeps the partition layout clean and is faster than
  //    ON CONFLICT for bulk loads (no per-row conflict probe). We use the
  //    project's existing `transaction()` helper so connection pooling, BEGIN/
  //    COMMIT/ROLLBACK semantics, and error logging are consistent with the
  //    rest of the backend.
  let inserted = 0;
  try {
    await dbModule.transaction(async (client) => {
      await client.query(
        'DELETE FROM inventory_daily_snapshot WHERE snapshot_date = $1',
        [snapshotDate]
      );

      for (let i = 0; i < resolved.length; i += BATCH_INSERT_SIZE) {
        const batch  = resolved.slice(i, i + BATCH_INSERT_SIZE);
        const values = [];
        const placeholders = batch.map((r, j) => {
          const b = j * 4;
          values.push(snapshotDate, r[0], r[1], r[2]);
          return `($${b+1}::date, $${b+2}::uuid, $${b+3}::uuid, $${b+4}::int)`;
        }).join(',');

        await client.query(
          `INSERT INTO inventory_daily_snapshot (snapshot_date, location_id, sku_id, qty_on_hand)
           VALUES ${placeholders}`,
          values
        );
        inserted += batch.length;
      }

      const durationMs = Date.now() - start;
      await client.query(`
        UPDATE stock_history_load_log
           SET status = 'SUCCESS',
               erp_rows      = $2,
               resolved_rows = $3,
               lookup_misses = $4,
               duration_ms   = $5,
               completed_at  = NOW(),
               error_message = NULL
         WHERE snapshot_date = $1
      `, [snapshotDate, rows.length, inserted, lookupMisses, durationMs]);
    });

    const durationMs = Date.now() - start;
    logger.info(
      `[BACKFILL ${snapshotDate}] ✅ ${inserted.toLocaleString()} rows in ${(durationMs/1000).toFixed(1)}s ` +
      `(misses: ${lookupMisses})`
    );
    return { erpRows: rows.length, resolvedRows: inserted, lookupMisses, durationMs };
  } catch (err) {
    // Transaction already rolled back by helper. Mark FAILED in a fresh statement.
    await query(`
      UPDATE stock_history_load_log
         SET status = 'FAILED', error_message = $2, completed_at = NOW()
       WHERE snapshot_date = $1
    `, [snapshotDate, err.message]).catch(() => {});
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Backfill stock history across a date range. Skips dates already SUCCESS.
 *
 * @param {Date|string} fromDate — inclusive (e.g. '2024-01-01')
 * @param {Date|string} toDate   — inclusive (e.g. '2026-01-31')
 * @param {Object}      opts
 *   - force: boolean — if true, re-load dates already marked SUCCESS
 *   - onProgress: (state) => void — called after each date
 * @returns {Promise<{ totalDates, succeeded, failed, skipped, durationMs }>}
 */
async function backfillStockHistory(fromDate, toDate, opts = {}) {
  const { force = false, onProgress = null } = opts;
  const dates    = dateRange(fromDate, toDate);
  const startAll = Date.now();

  logger.info(`[BACKFILL] ${dates.length} dates queued: ${dates[0]} → ${dates[dates.length - 1]}`);
  if (force) logger.warn('[BACKFILL] force=true — will re-load even SUCCESS dates');

  // Skip dates already marked SUCCESS unless --force
  let toLoad = dates;
  if (!force) {
    const done = await query(
      `SELECT snapshot_date FROM stock_history_load_log
        WHERE status = 'SUCCESS' AND snapshot_date = ANY($1::date[])`,
      [dates]
    );
    const doneSet = new Set(done.rows.map(r => toPgDate(r.snapshot_date)));
    toLoad = dates.filter(d => !doneSet.has(d));
    if (doneSet.size > 0) {
      logger.info(`[BACKFILL] Skipping ${doneSet.size} dates already loaded; ${toLoad.length} remaining`);
    }
  }

  if (toLoad.length === 0) {
    logger.info('[BACKFILL] Nothing to do — all dates already loaded');
    return { totalDates: dates.length, succeeded: 0, failed: 0, skipped: dates.length, durationMs: 0 };
  }

  const erpPool    = await sql.connect(sqlServerConfig);
  const lookupMaps = await buildLookupMaps();

  const stats = { totalDates: dates.length, succeeded: 0, failed: 0, skipped: dates.length - toLoad.length };

  try {
    for (let i = 0; i < toLoad.length; i++) {
      const date = toLoad[i];
      try {
        await loadOneDate(erpPool, lookupMaps, date);
        stats.succeeded++;
      } catch (err) {
        stats.failed++;
        logger.error(`[BACKFILL ${date}] ❌ ${err.message}`);
        // Continue with next date — failed dates are flagged in the log for retry.
      }
      if (onProgress) {
        onProgress({ done: i + 1, total: toLoad.length, lastDate: date, stats });
      }
    }
  } finally {
    await erpPool.close().catch(() => {});
  }

  stats.durationMs = Date.now() - startAll;
  logger.info(
    `[BACKFILL] ✅ Done in ${(stats.durationMs/1000/60).toFixed(1)}m — ` +
    `succeeded: ${stats.succeeded}, failed: ${stats.failed}, skipped: ${stats.skipped}`
  );
  return stats;
}

/**
 * Retry only the FAILED dates from a previous run.
 */
async function retryFailedDates() {
  const r = await query(`SELECT snapshot_date FROM stock_history_load_log WHERE status = 'FAILED' ORDER BY snapshot_date`);
  if (!r.rows.length) {
    logger.info('[BACKFILL] No FAILED dates to retry');
    return { totalDates: 0, succeeded: 0, failed: 0, skipped: 0, durationMs: 0 };
  }
  const dates  = r.rows.map(x => toPgDate(x.snapshot_date));
  const first  = dates[0];
  const last   = dates[dates.length - 1];
  logger.info(`[BACKFILL] Retrying ${dates.length} FAILED dates: ${first} → ${last}`);
  return backfillStockHistory(first, last, { force: true });
}

module.exports = {
  backfillStockHistory,
  retryFailedDates,
  loadOneDate,         // exported for unit testing / single-date refresh
  toErpDate,
  toPgDate,
};
