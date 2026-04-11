/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║           SPYKAR ERP SYNC ENGINE  —  Production Grade v2.0                 ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║  Architecture: Multi-source ETL with monthly chunking + parallel loading   ║
 * ║                                                                              ║
 * ║  ERP Stored Procedures (SQL Server STOREDB):                                ║
 * ║    EXEC AIGetStock   'DD-mon-YY'           → stock snapshot (all locations) ║
 * ║    EXEC SalesAI      'DD-mon-YY','DD-mon-YY' → sales movements              ║
 * ║    EXEC SalesReturnAI 'DD-mon-YY','DD-mon-YY' → return movements            ║
 * ║    EXEC AIgetParty                          → store/party master            ║
 * ║    SELECT * FROM Item_spykar                → SKU master                    ║
 * ║                                                                              ║
 * ║  Data range: Jan 2024 → today (full history on FULL sync)                  ║
 * ║  Delta sync: last successful sync date → today                              ║
 * ║                                                                              ║
 * ║  Pipeline stages:                                                            ║
 * ║    1. Connect to SQL Server                                                 ║
 * ║    2. Build in-memory lookup maps (locations + SKUs)                        ║
 * ║    3. Sync stock snapshot (AIGetStock — today's date)                       ║
 * ║    4. Sync sales history in monthly chunks (parallel, with retry)           ║
 * ║    5. Sync return history in monthly chunks (parallel, with retry)          ║
 * ║    6. Recompute stock ageing buckets                                        ║
 * ║    7. Invalidate Redis cache                                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const sql               = require('mssql');
const { query }         = require('../config/database');
const { invalidatePattern } = require('../config/redis');
const logger            = require('../config/logger');

// ─── Pipeline constants ───────────────────────────────────────────────────────

// Earliest date Spykar ERP has reliable data from (do not go before this)
const FULL_HISTORY_START = new Date('2024-01-01');

// ERP sales data is available up to this date (SalesAI ceiling — Jan 31 2026)
const SALES_DATA_CEILING = new Date('2026-01-31');

// AIGetStock snapshot date — stock as of Feb 1, 2026 closing
const STOCK_SNAPSHOT_DATE = new Date('2026-02-01');

// Months of lookback on a DELTA sync
const DELTA_LOOKBACK_MONTHS = 2;

// Rows per INSERT statement — tuned for PostgreSQL sweet spot
const BATCH_STOCK     = 500;
const BATCH_MOVEMENTS = 1000;

// Concurrent monthly chunks sent to SQL Server simultaneously
// Keep ≤ 3: SQL Server 2014 Standard Edition has limited worker threads
const MAX_PARALLEL_CHUNKS = 2;

// Retry config for transient network / SP errors
const MAX_RETRIES   = 3;
const RETRY_BASE_MS = 4000; // exponential backoff base

// ─── SQL Server connection config ─────────────────────────────────────────────
const sqlServerConfig = {
  server:   process.env.MSSQL_HOST,
  port:     parseInt(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt:                process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    requestTimeout:         900000,   // 15 min — AIGetStock returns 500k+ rows
    connectionTimeout:      30000,
  },
  pool: {
    max:              8,
    min:              0,
    idleTimeoutMillis: 30000,
    acquireTimeoutMillis: 60000,
  },
};

let syncLogId = null;

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Format JS Date → 'DD-mon-YY' expected by Spykar stored procedures */
function toErpDate(date) {
  const d   = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][d.getMonth()];
  const yr  = String(d.getFullYear()).slice(-2);
  return `${day}-${mon}-${yr}`;
}

/** Last day of a calendar month */
function endOfMonth(year, month) {
  return new Date(year, month + 1, 0); // month is 0-indexed, day 0 = last day of prev month
}

/** First day of a calendar month */
function startOfMonth(year, month) {
  return new Date(year, month, 1);
}

/**
 * Generate array of { from, to } month chunks between two dates (inclusive).
 * Each chunk is exactly one calendar month to keep SP response size predictable.
 */
function generateMonthlyChunks(fromDate, toDate) {
  const chunks = [];
  let cursor   = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  const end    = new Date(toDate.getFullYear(), toDate.getMonth(), 1);

  while (cursor <= end) {
    const y   = cursor.getFullYear();
    const m   = cursor.getMonth();
    const chunkFrom = new Date(Math.max(startOfMonth(y, m), fromDate));
    const chunkTo   = new Date(Math.min(endOfMonth(y, m),   toDate));
    chunks.push({ from: chunkFrom, to: chunkTo, label: `${y}-${String(m+1).padStart(2,'0')}` });
    cursor = startOfMonth(y, m + 1); // advance to next month
  }

  return chunks;
}

/** Today at midnight (for delta bounds) */
function today() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

/**
 * Execute fn(), retrying on failure up to maxRetries times.
 * Uses exponential backoff: 4s, 8s, 16s (base * 2^attempt)
 */
async function withRetry(fn, label, maxRetries = MAX_RETRIES, baseDelayMs = RETRY_BASE_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        logger.warn(`[RETRY ${attempt + 1}/${maxRetries}] ${label} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  logger.error(`[FAILED] ${label} exhausted all ${maxRetries} retries: ${lastErr.message}`);
  throw lastErr;
}

// ─── Parallel chunk executor ──────────────────────────────────────────────────

/**
 * Execute an array of async tasks with controlled concurrency.
 * Never runs more than `concurrency` tasks simultaneously.
 * Returns array of { status: 'fulfilled'|'rejected', value?, reason? } — like Promise.allSettled.
 */
async function pooledChunks(tasks, concurrency = MAX_PARALLEL_CHUNKS) {
  const results = [];
  let index     = 0;

  async function worker() {
    while (index < tasks.length) {
      const myIndex = index++;
      try {
        results[myIndex] = { status: 'fulfilled', value: await tasks[myIndex]() };
      } catch (err) {
        results[myIndex] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── SQL Server connection ────────────────────────────────────────────────────

async function tryConnectSqlServer() {
  try {
    const pool = await sql.connect(sqlServerConfig);
    logger.info('SQL Server connected successfully');
    return pool;
  } catch (err) {
    logger.warn(`SQL Server not reachable: ${err.message}`);
    return null;
  }
}

// ─── Flexible column reader ───────────────────────────────────────────────────
// Handles case variations from different stored procedures

function col(row, ...names) {
  for (const name of names) {
    if (row[name]               !== undefined && row[name] !== null) return row[name];
    if (row[name.toUpperCase()] !== undefined && row[name.toUpperCase()] !== null) return row[name.toUpperCase()];
    if (row[name.toLowerCase()] !== undefined && row[name.toLowerCase()] !== null) return row[name.toLowerCase()];
  }
  return null;
}

// ─── In-memory lookup maps ────────────────────────────────────────────────────
// Built once per sync run — eliminates per-row PG queries (critical for 500k+ row loads)

async function buildLookupMaps() {
  const [locRows, skuRows] = await Promise.all([
    query('SELECT id, code, external_id FROM locations WHERE is_active = true'),
    query('SELECT id, external_id, style_variant FROM skus WHERE is_active = true'),
  ]);

  const locationByCode    = new Map();
  const locationByExtId   = new Map();
  const skuByStyleVariant = new Map();
  const skuByExtId        = new Map();

  for (const r of locRows.rows) {
    if (r.code)        locationByCode.set(r.code.toUpperCase().trim(), r.id);
    if (r.external_id) locationByExtId.set(String(r.external_id).toUpperCase().trim(), r.id);
  }
  for (const r of skuRows.rows) {
    if (r.style_variant) skuByStyleVariant.set(r.style_variant.toUpperCase().trim(), r.id);
    if (r.external_id)   skuByExtId.set(String(r.external_id).toUpperCase().trim(), r.id);
  }

  logger.info(`Lookup maps ready: ${locationByCode.size} locations, ${skuByExtId.size} SKUs`);
  return { locationByCode, locationByExtId, skuByStyleVariant, skuByExtId };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — Stock Snapshot (AIGetStock)
// ─────────────────────────────────────────────────────────────────────────────

async function syncStockSnapshot(erpPool, lookupMaps, asOfDate, stats) {
  const dateStr      = toErpDate(asOfDate);
  const syncStartedAt = new Date();
  logger.info(`[STOCK] Fetching AIGetStock '${dateStr}'...`);

  const rows = await withRetry(
    () => erpPool.request().query(`EXEC AIGetStock '${dateStr}'`).then(r => r.recordset || []),
    `AIGetStock '${dateStr}'`
  );

  logger.info(`[STOCK] AIGetStock returned ${rows.length.toLocaleString()} rows — resolving...`);

  // Aggregate by (location, SKU) — ERP may return multiple bins per store
  const qtyByKey   = new Map();
  let   lookupMiss = 0;

  for (const row of rows) {
    const storeCode    = String(col(row, 'Storecode', 'STORECODE', 'storecode') || '').trim().toUpperCase();
    const barcode      = String(col(row, 'barcode', 'BARCODE', 'Barcode')       || '').trim().toUpperCase();
    const styleVariant = String(col(row, 'InforItemCode', 'INFORITEMCODE', 'style_variant') || '').trim().toUpperCase();
    const qty          = Math.max(0, parseInt(col(row, 'qty', 'QTY', 'Qty') || 0));

    if (!storeCode || !barcode) continue;

    const locationId = lookupMaps.locationByExtId.get(storeCode) || lookupMaps.locationByCode.get(storeCode);
    const skuId      = lookupMaps.skuByExtId.get(barcode) || lookupMaps.skuByStyleVariant.get(styleVariant);

    if (!locationId || !skuId) {
      lookupMiss++;
      stats.failed++;
      if (lookupMiss <= 30) {
        logger.warn(`[STOCK] MISS #${lookupMiss}: store=${storeCode} barcode=${barcode} qty=${qty} reason=${!locationId ? 'STORE_NOT_IN_MASTER' : 'SKU_NOT_IN_MASTER'}`);
      }
      continue;
    }

    const key = `${locationId}:${skuId}`;
    qtyByKey.set(key, (qtyByKey.get(key) || 0) + qty);
  }

  if (lookupMiss > 0) {
    logger.warn(`[STOCK] ${lookupMiss.toLocaleString()} rows skipped — store/SKU not found in master (run load_party_master + load_item_master to fix)`);
  }

  // Batch upsert resolved rows
  const resolved = [...qtyByKey.entries()].map(([key, qty]) => {
    const [locationId, skuId] = key.split(':');
    return [locationId, skuId, qty];
  });

  let upserted = 0;
  for (let i = 0; i < resolved.length; i += BATCH_STOCK) {
    const batch       = resolved.slice(i, i + BATCH_STOCK);
    const values      = batch.flatMap(r => r);
    const placeholders = batch.map((_, j) => {
      const b = j * 3;
      return `($${b+1},$${b+2},$${b+3},NOW(),NOW())`;
    }).join(',');

    await query(`
      INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at, updated_at)
      VALUES ${placeholders}
      ON CONFLICT (location_id, sku_id) DO UPDATE SET
        qty_on_hand      = EXCLUDED.qty_on_hand,
        last_movement_at = NOW(),
        updated_at       = NOW()
    `, values);

    upserted += batch.length;
    if (i % (BATCH_STOCK * 20) === 0 || i + BATCH_STOCK >= resolved.length) {
      logger.info(`[STOCK] Upserted ${upserted.toLocaleString()} / ${resolved.length.toLocaleString()} rows`);
    }
  }

  // Purge phantom rows — locations/SKUs no longer present in today's ERP snapshot
  const del = await query(`DELETE FROM inventory_snapshot WHERE updated_at < $1`, [syncStartedAt]);
  if (del.rowCount > 0) {
    logger.info(`[STOCK] Removed ${del.rowCount} stale snapshot rows (not in today's ERP snapshot)`);
  }

  stats.fetched += upserted;
  stats.updated += upserted;
  logger.info(`[STOCK] ✅ Snapshot complete: ${upserted.toLocaleString()} rows from AIGetStock '${dateStr}'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 2 — Sales History in Monthly Chunks (SalesAI)
// ─────────────────────────────────────────────────────────────────────────────

async function syncSalesChunked(erpPool, lookupMaps, fromDate, toDate, stats) {
  const chunks = generateMonthlyChunks(fromDate, toDate);
  logger.info(`[SALES] Loading ${chunks.length} monthly chunks: ${toErpDate(fromDate)} → ${toErpDate(toDate)}`);

  let totalRows     = 0;
  let totalInserted = 0;
  let failedChunks  = 0;

  const tasks = chunks.map(chunk => async () => {
    const fromStr = toErpDate(chunk.from);
    const toStr   = toErpDate(chunk.to);

    const rows = await withRetry(
      () => erpPool.request()
              .query(`EXEC SalesAI '${fromStr}','${toStr}'`)
              .then(r => r.recordset || []),
      `SalesAI ${chunk.label}`
    );

    logger.info(`[SALES] ${chunk.label}: ${rows.length.toLocaleString()} rows`);
    const inserted = await upsertMovements(rows, 'SALE', -1, resolveSalesRow, lookupMaps);
    return { chunk: chunk.label, rows: rows.length, inserted };
  });

  const results = await pooledChunks(tasks, MAX_PARALLEL_CHUNKS);

  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalRows     += r.value.rows;
      totalInserted += r.value.inserted;
    } else {
      failedChunks++;
      logger.error(`[SALES] Chunk failed: ${r.reason?.message}`);
    }
  }

  stats.fetched  += totalRows;
  stats.inserted += totalInserted;
  stats.failed   += failedChunks;

  logger.info(`[SALES] ✅ Done: ${totalRows.toLocaleString()} rows, ${totalInserted.toLocaleString()} inserted, ${failedChunks} chunks failed`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 3 — Return History in Monthly Chunks (SalesReturnAI)
// ─────────────────────────────────────────────────────────────────────────────

async function syncReturnsChunked(erpPool, lookupMaps, fromDate, toDate, stats) {
  const chunks = generateMonthlyChunks(fromDate, toDate);
  logger.info(`[RETURNS] Loading ${chunks.length} monthly chunks: ${toErpDate(fromDate)} → ${toErpDate(toDate)}`);

  let totalRows     = 0;
  let totalInserted = 0;
  let failedChunks  = 0;

  const tasks = chunks.map(chunk => async () => {
    const fromStr = toErpDate(chunk.from);
    const toStr   = toErpDate(chunk.to);

    const rows = await withRetry(
      () => erpPool.request()
              .query(`EXEC SalesReturnAI '${fromStr}','${toStr}'`)
              .then(r => r.recordset || []),
      `SalesReturnAI ${chunk.label}`
    );

    logger.info(`[RETURNS] ${chunk.label}: ${rows.length.toLocaleString()} rows`);
    const inserted = await upsertMovements(rows, 'RETURN', +1, resolveReturnRow, lookupMaps);
    return { chunk: chunk.label, rows: rows.length, inserted };
  });

  const results = await pooledChunks(tasks, MAX_PARALLEL_CHUNKS);

  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalRows     += r.value.rows;
      totalInserted += r.value.inserted;
    } else {
      failedChunks++;
      logger.error(`[RETURNS] Chunk failed: ${r.reason?.message}`);
    }
  }

  stats.fetched  += totalRows;
  stats.inserted += totalInserted;
  stats.failed   += failedChunks;

  logger.info(`[RETURNS] ✅ Done: ${totalRows.toLocaleString()} rows, ${totalInserted.toLocaleString()} inserted, ${failedChunks} chunks failed`);
}

// ─── Row resolvers — extract typed fields from SP result rows ─────────────────

function resolveSalesRow(row, lookupMaps) {
  const storeCode    = String(col(row, 'storeid', 'STOREID', 'StoreId', 'storecode') || '').trim().toUpperCase();
  const barcode      = String(col(row, 'BARCODE', 'barcode', 'Barcode')              || '').trim().toUpperCase();
  const styleVariant = String(col(row, 'style', 'STYLE', 'InforItemCode')            || '').trim().toUpperCase();
  const qty          = Math.abs(parseInt(col(row, 'QTY', 'qty', 'Qty')              || 0));
  const saleValue    = parseFloat(col(row, 'SALEAMT', 'saleamt', 'SaleAmt')         || 0);
  const refNo        = String(col(row, 'Invoice No', 'INVOICE_NO', 'InvoiceNo', 'invoice_no') || '').trim();
  const movedAt      = col(row, 'DATE', 'date', 'Date') || new Date();

  if (!storeCode || qty === 0) return null;

  const locationId = lookupMaps.locationByExtId.get(storeCode) || lookupMaps.locationByCode.get(storeCode);
  const skuId      = lookupMaps.skuByExtId.get(barcode) || lookupMaps.skuByStyleVariant.get(styleVariant);

  if (!locationId || !skuId) return null;

  return { locationId, skuId, qty, refNo: refNo || null, saleValue: saleValue || null, movedAt };
}

function resolveReturnRow(row, lookupMaps) {
  const storeCode    = String(col(row, 'STORENUMBER', 'storeid', 'STOREID', 'storecode') || '').trim().toUpperCase();
  const barcode      = String(col(row, 'BARCODE', 'barcode', 'Barcode')                  || '').trim().toUpperCase();
  const styleVariant = String(col(row, 'style', 'STYLE')                                  || '').trim().toUpperCase();
  const inforCode    = String(col(row, 'InforItemCode', 'INFORITEMCODE')                  || '').trim().toUpperCase();
  const qty          = Math.abs(parseInt(col(row, 'QTY', 'qty', 'Qty')                   || 0));
  const returnValue  = parseFloat(col(row, 'SALEAMT', 'saleamt', 'SaleAmt')              || 0);
  const refNo        = String(col(row, 'VOUDNO', 'voudno', 'VoudNo')                      || '').trim();
  const movedAt      = col(row, 'DATE', 'date', 'Date') || new Date();

  if (!storeCode || qty === 0) return null;

  const locationId = lookupMaps.locationByExtId.get(storeCode) || lookupMaps.locationByCode.get(storeCode);
  const skuId      = lookupMaps.skuByExtId.get(barcode)
                  || lookupMaps.skuByStyleVariant.get(inforCode)
                  || lookupMaps.skuByStyleVariant.get(styleVariant);

  if (!locationId || !skuId) return null;

  return { locationId, skuId, qty, refNo: refNo || null, saleValue: returnValue || null, movedAt };
}

// ─── Batch movement upsert ────────────────────────────────────────────────────

async function upsertMovements(rows, movementType, direction, resolverFn, lookupMaps) {
  const resolved = [];

  for (const row of rows) {
    const r = resolverFn(row, lookupMaps);
    if (!r) continue;
    resolved.push([
      r.locationId, r.skuId,
      direction * r.qty,
      r.refNo,
      r.saleValue,
      r.movedAt,
    ]);
  }

  let inserted = 0;
  for (let i = 0; i < resolved.length; i += BATCH_MOVEMENTS) {
    const batch       = resolved.slice(i, i + BATCH_MOVEMENTS);
    const placeholders = batch.map((_, j) => {
      const b = j * 6;
      return `($${b+1},$${b+2},'${movementType}',$${b+3},0,0,$${b+4},$${b+5},$${b+6},'SQL_SERVER_SYNC')`;
    }).join(',');
    const values = batch.flatMap(r => r);

    try {
      await query(`
        INSERT INTO inventory_movements
          (location_id, sku_id, movement_type, qty_change, qty_before, qty_after,
           reference_no, sale_value, moved_at, synced_from)
        VALUES ${placeholders}
        ON CONFLICT (location_id, sku_id, movement_type, reference_no, moved_at)
        WHERE reference_no IS NOT NULL DO NOTHING
      `, values);
      inserted += batch.length;
    } catch (err) {
      logger.error(`[${movementType}] Batch ${i}–${i + batch.length} insert failed: ${err.message}`);
    }
  }

  return inserted;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 4 — Stock Ageing Recomputation
// ─────────────────────────────────────────────────────────────────────────────
// Uses SALE movement dates to determine when stock last moved out of each location.
// Buckets map to retail industry standard: 0-30 Fresh, 31-60 Healthy,
// 61-90 Slow-moving, 91-180 At-Risk, 180+ Dead Stock.

async function updateStockAgeing() {
  logger.info('[AGEING] Recomputing stock ageing buckets...');

  // ── Reference date strategy ────────────────────────────────────────────────
  // We NEVER use NOW() as the ageing reference because:
  //   - ERP sales data is capped at Jan 31, 2026 (SALES_DATA_CEILING)
  //   - Using NOW() (e.g. Apr 2026) makes every item appear 65–95+ days staler
  //     than it really is, collapsing ALL stock into the 180+ "Dead Stock" bucket
  //
  // Instead: use MAX(moved_at) of SALE movements as the reference point.
  // This measures "days since last sale" relative to the latest date in our data
  // (Jan 2026), which is the correct business interpretation.
  //
  // Bucket definitions (industry standard retail):
  //   0–30  days  → Fresh / Fast-moving
  //   31–60 days  → Healthy
  //   61–90 days  → Slow-moving — watch list
  //   91–180 days → At Risk — markdown candidate
  //   180+  days  → Dead Stock — liquidate / write-off
  //
  // Items with NO sale history at all → Dead Stock (180+)
  // ─────────────────────────────────────────────────────────────────────────

  await query(`
    WITH ref AS (
      -- Anchor to the latest sale date in our data, NOT the wall clock
      SELECT COALESCE(MAX(moved_at), CURRENT_TIMESTAMP) AS ref_date
      FROM   inventory_movements
      WHERE  movement_type = 'SALE'
    ),
    last_sale AS (
      -- Pre-compute last sale date per (location, SKU) — eliminates correlated subqueries
      SELECT location_id, sku_id, MAX(moved_at) AS last_sold_at
      FROM   inventory_movements
      WHERE  movement_type = 'SALE'
      GROUP BY location_id, sku_id
    )
    INSERT INTO stock_ageing
      (location_id, sku_id, qty_0_30, qty_31_60, qty_61_90, qty_91_180, qty_180_plus, ageing_date)
    SELECT
      i.location_id,
      i.sku_id,

      -- 0–30 days: sold within the last 30 days of available data
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '30 days'
           THEN i.qty_on_hand ELSE 0 END                                    AS qty_0_30,

      -- 31–60 days
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '60 days'
                AND ls.last_sold_at <  ref.ref_date - INTERVAL '30 days'
           THEN i.qty_on_hand ELSE 0 END                                    AS qty_31_60,

      -- 61–90 days: slow-moving
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '90 days'
                AND ls.last_sold_at <  ref.ref_date - INTERVAL '60 days'
           THEN i.qty_on_hand ELSE 0 END                                    AS qty_61_90,

      -- 91–180 days: at risk
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '180 days'
                AND ls.last_sold_at <  ref.ref_date - INTERVAL '90 days'
           THEN i.qty_on_hand ELSE 0 END                                    AS qty_91_180,

      -- 180+ days: dead stock (includes items never sold — NULL last_sold_at)
      CASE WHEN ls.last_sold_at IS NULL
                OR ls.last_sold_at < ref.ref_date - INTERVAL '180 days'
           THEN i.qty_on_hand ELSE 0 END                                    AS qty_180_plus,

      CURRENT_DATE
    FROM  inventory_snapshot i
    CROSS JOIN ref
    LEFT  JOIN last_sale ls ON ls.location_id = i.location_id
                            AND ls.sku_id      = i.sku_id
    WHERE i.qty_on_hand > 0
    ON CONFLICT (location_id, sku_id, ageing_date) DO UPDATE SET
      qty_0_30     = EXCLUDED.qty_0_30,
      qty_31_60    = EXCLUDED.qty_31_60,
      qty_61_90    = EXCLUDED.qty_61_90,
      qty_91_180   = EXCLUDED.qty_91_180,
      qty_180_plus = EXCLUDED.qty_180_plus
  `);

  // Log the reference date used so it's auditable
  const refRow = await query(`
    SELECT MAX(moved_at)::date AS ref_date, COUNT(*)::int AS total_sales
    FROM inventory_movements WHERE movement_type = 'SALE'
  `);
  const { ref_date, total_sales } = refRow.rows[0];
  logger.info(`[AGEING] ✅ Buckets updated — reference date: ${ref_date} (${total_sales?.toLocaleString()} sale records)`);
}

// ─── Snapshot rebuild (ERP-unreachable fallback) ──────────────────────────────

async function rebuildInventorySnapshot(stats) {
  logger.info('[SNAPSHOT] Rebuilding from movement history (ERP unreachable)...');
  await query(`
    INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at)
    SELECT
      m.location_id,
      m.sku_id,
      GREATEST(0, SUM(m.qty_change)) AS qty_on_hand,
      MAX(m.moved_at)                AS last_movement_at
    FROM inventory_movements m
    GROUP BY m.location_id, m.sku_id
    ON CONFLICT (location_id, sku_id) DO UPDATE SET
      qty_on_hand      = GREATEST(0, EXCLUDED.qty_on_hand),
      last_movement_at = EXCLUDED.last_movement_at,
      updated_at       = NOW()
  `);
  logger.info('[SNAPSHOT] Rebuilt from movements');
  stats.updated++;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full ETL pipeline.
 *
 * syncType = 'FULL'  → loads complete history from FULL_HISTORY_START (Jan 2024) → today
 * syncType = 'DELTA' → loads last DELTA_LOOKBACK_MONTHS (default 2) months only
 *
 * FULL sync is idempotent — safe to re-run. ON CONFLICT DO NOTHING prevents duplicates.
 */
async function runDeltaSync(syncType = 'DELTA') {
  const pipelineStart = Date.now();
  logger.info(`${'═'.repeat(70)}`);
  logger.info(`  SPYKAR SYNC ENGINE  —  ${syncType} SYNC  —  ${new Date().toISOString()}`);
  logger.info(`${'═'.repeat(70)}`);

  // Record sync start in log
  const logResult = await query(
    `INSERT INTO sync_logs (sync_type, status, source) VALUES ($1, 'RUNNING', 'SQL_SERVER') RETURNING id`,
    [syncType]
  );
  syncLogId = logResult.rows[0].id;

  const stats = { fetched: 0, inserted: 0, updated: 0, failed: 0 };

  try {
    // ── Determine date range ───────────────────────────────────────────────────
    // Stock snapshot is always Feb 1, 2026 (latest available AIGetStock date)
    const stockDate = STOCK_SNAPSHOT_DATE;

    let salesFrom, salesTo;

    if (syncType === 'FULL') {
      // Full history: Jan 1 2024 → Jan 31 2026 (complete ERP data window)
      salesFrom = FULL_HISTORY_START;
      salesTo   = SALES_DATA_CEILING;
      logger.info(`[RANGE] FULL sync: ${toErpDate(salesFrom)} → ${toErpDate(salesTo)} (${generateMonthlyChunks(salesFrom, salesTo).length} months)`);

      // Wipe existing SQL Server movements for clean rebuild
      const del = await query(`DELETE FROM inventory_movements WHERE synced_from = 'SQL_SERVER_SYNC'`);
      logger.info(`[RANGE] Cleared ${del.rowCount.toLocaleString()} existing movements for full rebuild`);

    } else {
      // Delta: last N months — capped at sales data ceiling (Jan 31 2026)
      const now = new Date();
      const deltaStart = startOfMonth(now.getFullYear(), now.getMonth() - DELTA_LOOKBACK_MONTHS);
      salesFrom = new Date(Math.max(deltaStart, FULL_HISTORY_START));
      salesTo   = new Date(Math.min(today(),    SALES_DATA_CEILING));
      logger.info(`[RANGE] DELTA sync: ${toErpDate(salesFrom)} → ${toErpDate(salesTo)}`);
    }

    // ── Connect to SQL Server ─────────────────────────────────────────────────
    const pool = await tryConnectSqlServer();

    if (pool) {
      try {
        logger.info('[PIPELINE] SQL Server connected — starting ERP pipeline');

        // STAGE 0: Build lookup maps
        const lookupMaps = await buildLookupMaps();

        // STAGE 1: Stock snapshot (current date)
        await syncStockSnapshot(pool, lookupMaps, stockDate, stats);

        // STAGE 2: Sales history (chunked by month)
        await syncSalesChunked(pool, lookupMaps, salesFrom, salesTo, stats);

        // STAGE 3: Return history (chunked by month)
        await syncReturnsChunked(pool, lookupMaps, salesFrom, salesTo, stats);

      } finally {
        try { await pool.close(); } catch { /* ignore close errors */ }
      }
    } else {
      // ERP unreachable — rebuild snapshot from existing movements
      logger.warn('[PIPELINE] SQL Server unreachable — running offline snapshot rebuild');
      await rebuildInventorySnapshot(stats);
    }

    // STAGE 4: Ageing (always runs — uses PG data only)
    await updateStockAgeing();

    // ── Finalise sync log ─────────────────────────────────────────────────────
    const duration  = Date.now() - pipelineStart;
    const source    = pool !== null ? 'SQL_SERVER' : 'LOCAL_REBUILD';

    await query(`
      UPDATE sync_logs
      SET status = 'SUCCESS', completed_at = NOW(), duration_ms = $1,
          records_fetched = $2, records_inserted = $3, records_updated = $4,
          records_failed = $5, source = $6
      WHERE id = $7
    `, [duration, stats.fetched, stats.inserted, stats.updated, stats.failed, source, syncLogId]);

    // Invalidate all Redis caches so fresh data is served immediately
    await Promise.all([
      invalidatePattern('inventory:*'),
      invalidatePattern('analytics:*'),
      invalidatePattern('locations:*'),
      invalidatePattern('distributors:*'),
      invalidatePattern('sku:*'),
      invalidatePattern('dispatch:*'),
    ]);

    const mins = Math.floor(duration / 60000);
    const secs = Math.floor((duration % 60000) / 1000);
    const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    logger.info(`${'─'.repeat(70)}`);
    logger.info(`  ✅ SYNC COMPLETE in ${time}  [${source}]`);
    logger.info(`     Fetched:  ${stats.fetched.toLocaleString()}`);
    logger.info(`     Inserted: ${stats.inserted.toLocaleString()}`);
    logger.info(`     Updated:  ${stats.updated.toLocaleString()}`);
    logger.info(`     Failed:   ${stats.failed.toLocaleString()}`);
    logger.info(`${'─'.repeat(70)}`);

    return { success: true, duration, stats, source };

  } catch (err) {
    logger.error(`[PIPELINE] ❌ Sync failed: ${err.message}`);
    await query(
      `UPDATE sync_logs SET status = 'FAILED', completed_at = NOW(), error_message = $1 WHERE id = $2`,
      [err.message, syncLogId]
    ).catch(() => {});
    throw err;
  }
}

module.exports = { runDeltaSync };
