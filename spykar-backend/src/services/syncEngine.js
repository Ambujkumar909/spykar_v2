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
const copyFrom          = require('pg-copy-streams').from;
const { query, pool: pgPool } = require('../config/database');
const { invalidatePattern } = require('../config/cache');
const logger            = require('../config/logger');

// ─── CSV-safe encoder for COPY FROM STDIN (FORMAT csv) ────────────────────────
// Postgres CSV rules: wrap in double-quotes if the value contains a delimiter,
// quote, or newline; double-up embedded quotes. Empty → empty (NULL). We hand
// fully-resolved typed values to COPY so we never quote UUIDs / ints / floats.
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length === 0) return '';
  if (s.indexOf(',') === -1 && s.indexOf('"') === -1 && s.indexOf('\n') === -1 && s.indexOf('\r') === -1) {
    return s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

// Format a JS Date / string as 'YYYY-MM-DD HH:MM:SS.mmm+00' for Postgres
// TIMESTAMPTZ. node-pg's parameterized path would do this for us; with COPY we
// emit text, so we normalize here.
function tsForCopy(v) {
  if (v === null || v === undefined) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').replace('Z', '+00');
}

// ─── Pipeline constants ───────────────────────────────────────────────────────

// Earliest date Spykar ERP has reliable data from (do not go before this)
const FULL_HISTORY_START = new Date('2024-01-01');

// SALES_DATA_CEILING and STOCK_SNAPSHOT_DATE are evaluated per-run inside
// runDeltaSync() via today() — never hardcode a date here.

// Months of lookback on a DELTA sync
const DELTA_LOOKBACK_MONTHS = 2;

// NOTE: BATCH_STOCK / BATCH_MOVEMENTS were the row-count tunables for the
// legacy "INSERT … VALUES (…), …" path. The new streaming COPY pipeline has
// no batch size — rows flow one-at-a-time with backpressure — so those knobs
// are gone. Tuning now happens at the staging-table level (UNLOGGED, no
// indexes) and via Postgres's internal COPY buffer (default 64 KB).

// Concurrent monthly chunks sent to SQL Server simultaneously.
// Keep ≤ 3: SQL Server 2014 Standard Edition has limited worker threads.
// Bumped 2→3 (the documented ceiling) for ~50% more sales/returns throughput.
// Overridable via env without a code change if the ERP shows strain.
const MAX_PARALLEL_CHUNKS = parseInt(process.env.SYNC_MAX_PARALLEL_CHUNKS) || 3;

// Retry config for transient network / SP errors
const MAX_RETRIES   = 3;
const RETRY_BASE_MS = 4000; // exponential backoff base

// ─── Snapshot-replace safety floors ───────────────────────────────────────────
// Guard against a transient master-data gap silently wiping live stock.
// Incident 2026-05-31: every AIGetStock row missed the locations/skus lookup
// (masters not yet loaded) → stg_stock ended up empty → the FULL rebuild
// TRUNCATE'd inventory_snapshot and reloaded 0 rows, then reported SUCCESS.
// A real Spykar snapshot is millions of (loc,sku) rows, so a resolve below
// these floors is never legitimate — fail loudly instead of replacing.
//   • Absolute floor: minimum resolved rows before we touch the live table.
//   • Retain ratio: if the table already has data, a new load that keeps less
//     than this fraction of it is treated as a partial ERP/master outage.
const SNAPSHOT_MIN_ROWS         = parseInt(process.env.SYNC_SNAPSHOT_MIN_ROWS) || 1000;
const SNAPSHOT_MIN_RETAIN_RATIO = parseFloat(process.env.SYNC_SNAPSHOT_MIN_RETAIN_RATIO) || 0.5;

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
    // ── Streaming throughput tuning ──────────────────────────────────────────
    // packetSize is the TDS packet size. The 4 KB default means a 5M-row
    // AIGetStock result is chopped into ~80,000 network packets — the single
    // biggest cost of the stock stage (~7 min). 32 KB (the TDS max) carries
    // ~8× more rows per packet → ~8× fewer round-trips → the stream is
    // network-bandwidth-bound instead of round-trip-bound.
    packetSize:             32768,
    // We consume rows via the streaming 'row' event and write them straight to
    // a COPY pipe — never materialise the full recordset. Make that explicit so
    // tedious doesn't buffer rows in memory waiting for request completion.
    rowCollectionOnRequestCompletion: false,
    rowCollectionOnDone:              false,
    enableArithAbort:                 true,
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

function guardClientErrors(client, label) {
  // MUST be .on (not .once): a dropped PG connection can emit 'error' more than
  // once during teardown. With .once the listener is removed after the first
  // emission, so a second 'error' is unhandled → Node throws and hard-kills the
  // (detached) sync child, leaving its sync_logs row stuck RUNNING. Keeping the
  // listener attached for the client's whole life prevents that crash.
  client.on('error', (err) => {
    logger.error(`[PG:${label}] checked-out client connection error: ${err.message}`);
  });
}

const SNAPSHOT_SECONDARY_INDEXES = [
  {
    name: 'idx_inventory_snapshot_location',
    ddl: `CREATE INDEX idx_inventory_snapshot_location
          ON inventory_snapshot(location_id)
          INCLUDE (qty_on_hand, qty_available, qty_in_transit)`,
  },
  { name: 'idx_snapshot_date',       ddl: `CREATE INDEX idx_snapshot_date       ON inventory_snapshot(snapshot_date)` },
  { name: 'idx_snapshot_loc_sku',    ddl: `CREATE INDEX idx_snapshot_loc_sku    ON inventory_snapshot(location_id, sku_id)` },
  { name: 'idx_snapshot_location',   ddl: `CREATE INDEX idx_snapshot_location   ON inventory_snapshot(location_id)` },
  { name: 'idx_snapshot_low',        ddl: `CREATE INDEX idx_snapshot_low        ON inventory_snapshot(qty_on_hand) WHERE qty_on_hand <= safety_stock` },
  { name: 'idx_snapshot_qty',        ddl: `CREATE INDEX idx_snapshot_qty        ON inventory_snapshot(qty_on_hand)` },
  { name: 'idx_snapshot_qty_safety', ddl: `CREATE INDEX idx_snapshot_qty_safety ON inventory_snapshot(qty_on_hand, safety_stock)` },
  { name: 'idx_snapshot_sku',        ddl: `CREATE INDEX idx_snapshot_sku        ON inventory_snapshot(sku_id)` },
];

async function dropSnapshotSecondaryIndexes(client) {
  for (const idx of SNAPSHOT_SECONDARY_INDEXES) {
    await client.query(`DROP INDEX IF EXISTS ${idx.name}`);
  }
}

async function recreateSnapshotSecondaryIndexes(client) {
  for (const idx of SNAPSHOT_SECONDARY_INDEXES) {
    await client.query(idx.ddl);
  }
}

// ─── inventory_movements secondary indexes (the FULL-rebuild speed lever) ─────
//
// A FULL sync re-inserts the entire movement history (tens of millions of rows).
// If those rows land in a fully-indexed table, every row pays per-row b-tree
// maintenance on 9 secondary indexes — that is the dominant "merge latency".
//
// So for FULL we drop these 9, bulk-load with only the PK + the dedup unique
// index (uq_movements_reference) live, then rebuild all 9 at once in parallel
// (one bulk sort per index instead of millions of random b-tree inserts). DELTA
// never drops them — it loads a small window while the dashboard still reads,
// so its index maintenance cost is negligible and we keep reads fast.
//
// Names + DDL mirror schema.sql + migrations 005/006 exactly. IF NOT EXISTS so
// a retry after a partial rebuild is idempotent.
const MOVEMENTS_SECONDARY_INDEXES = [
  { name: 'idx_movements_location',           ddl: `CREATE INDEX IF NOT EXISTS idx_movements_location           ON inventory_movements(location_id)` },
  { name: 'idx_movements_sku',                ddl: `CREATE INDEX IF NOT EXISTS idx_movements_sku                ON inventory_movements(sku_id)` },
  { name: 'idx_movements_type',               ddl: `CREATE INDEX IF NOT EXISTS idx_movements_type               ON inventory_movements(movement_type)` },
  { name: 'idx_movements_date',               ddl: `CREATE INDEX IF NOT EXISTS idx_movements_date               ON inventory_movements(moved_at DESC)` },
  { name: 'idx_movements_ref',                ddl: `CREATE INDEX IF NOT EXISTS idx_movements_ref                ON inventory_movements(reference_id)` },
  { name: 'idx_movements_type_date',          ddl: `CREATE INDEX IF NOT EXISTS idx_movements_type_date          ON inventory_movements(movement_type, moved_at DESC)` },
  { name: 'idx_movements_sku_type_date',      ddl: `CREATE INDEX IF NOT EXISTS idx_movements_sku_type_date      ON inventory_movements(sku_id, movement_type, moved_at DESC)` },
  { name: 'idx_movements_location_type_date', ddl: `CREATE INDEX IF NOT EXISTS idx_movements_location_type_date ON inventory_movements(location_id, movement_type, moved_at DESC)` },
  { name: 'idx_movements_sale_loc_sku_date',  ddl: `CREATE INDEX IF NOT EXISTS idx_movements_sale_loc_sku_date  ON inventory_movements(movement_type, moved_at DESC, location_id, sku_id) WHERE movement_type = 'SALE'` },
];

async function dropMovementsSecondaryIndexes() {
  const client = await pgPool.connect();
  guardClientErrors(client, 'mv-idx-drop');
  try {
    for (const idx of MOVEMENTS_SECONDARY_INDEXES) {
      await client.query(`DROP INDEX IF EXISTS ${idx.name}`);
    }
    // Junk index on free-text notes — nothing queries it; keep it gone.
    await client.query('DROP INDEX IF EXISTS uq_inv_movements_notes');
    logger.info(`[MOVE] Dropped ${MOVEMENTS_SECONDARY_INDEXES.length} secondary indexes — bulk load runs index-light`);
  } finally {
    client.release();
  }
}

// Rebuild all secondary indexes concurrently across separate connections. Plain
// CREATE INDEX takes a SHARE lock (multiple builds coexist), and nothing writes
// to the table at this point, so 4-wide concurrency saturates CPU safely on a
// 10-core box without each build also forking parallel workers (we pin
// max_parallel_maintenance_workers=1 to avoid oversubscription).
async function rebuildMovementsSecondaryIndexes(concurrency = 4) {
  const t0 = Date.now();
  logger.info(`[MOVE] Rebuilding ${MOVEMENTS_SECONDARY_INDEXES.length} secondary indexes (parallel x${concurrency})…`);

  const tasks = MOVEMENTS_SECONDARY_INDEXES.map(idx => async () => {
    const client = await pgPool.connect();
    guardClientErrors(client, `mv-idx-build:${idx.name}`);
    try {
      await client.query(`SET maintenance_work_mem = '1GB'`);
      await client.query(`SET max_parallel_maintenance_workers = 1`);
      await client.query(`SET synchronous_commit = off`);
      await client.query(idx.ddl);
      return idx.name;
    } finally {
      try { await client.query('RESET maintenance_work_mem'); } catch (_) {}
      try { await client.query('RESET synchronous_commit'); } catch (_) {}
      client.release();
    }
  });

  const results = await pooledChunks(tasks, concurrency);
  const failed  = results.filter(r => r.status === 'rejected');
  for (const f of failed) logger.error(`[MOVE] Index rebuild failed: ${f.reason?.message}`);
  if (failed.length) {
    throw new Error(`${failed.length}/${MOVEMENTS_SECONDARY_INDEXES.length} movement indexes failed to rebuild`);
  }
  logger.info(`[MOVE] ✅ Secondary indexes rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Clear synced movements before a FULL rebuild. Fast path: when every row came
// from the sync (the normal case), TRUNCATE — instant, no dead tuples, no
// per-row index deletes. Only if manually-entered movements exist do we fall
// back to a targeted DELETE so we never destroy hand-entered data.
async function clearSyncedMovements() {
  const other = await query(
    `SELECT EXISTS(SELECT 1 FROM inventory_movements WHERE synced_from IS DISTINCT FROM 'SQL_SERVER_SYNC') AS has_other`
  );
  if (!other.rows[0].has_other) {
    await query('TRUNCATE inventory_movements');
    logger.info('[RANGE] Cleared all movements via TRUNCATE (fast path) for full rebuild');
  } else {
    const del = await query(`DELETE FROM inventory_movements WHERE synced_from = 'SQL_SERVER_SYNC'`);
    logger.info(`[RANGE] Cleared ${del.rowCount.toLocaleString()} synced movements (manual rows preserved)`);
  }
}

// ─── FULL-refresh snapshot replace — "build off-lock, swap briefly" ───────────
//
// HISTORY (the bug this replaced): the previous version did everything inside
// ONE long transaction — TRUNCATE, DROP/ADD/VALIDATE the foreign keys to
// locations & skus, the 5M-row GROUP BY aggregation, and the index rebuild.
// Adding/dropping a FK takes an ACCESS EXCLUSIVE lock on the *referenced*
// parent tables (locations, skus), held until COMMIT. Because every dashboard
// query joins locations and skus, the entire app froze for the full 15-25 min
// the rebuild ran. Measured live: 15 dashboard queries stuck on Lock/relation
// for 13+ minutes behind a single snapshot rebuild.
//
// THE FIX — two phases:
//   Phase 1 (off-lock): do the expensive aggregation (GROUP BY over 5M staging
//     rows) into a brand-new side table. This touches only stg_stock
//     (AccessShare) and a fresh table, so it NEVER locks inventory_snapshot,
//     locations, or skus. The dashboard serves reads at full speed throughout.
//   Phase 2 (brief, snapshot-only): swap the contents in one short transaction.
//     We must keep the table IDENTITY — v_inventory_full, v_executive_summary
//     and v_top_distributors depend on it and bind by OID, so DROP/RENAME is
//     not an option. So we TRUNCATE + bulk-copy the pre-aggregated rows in
//     place. Crucially we DO NOT touch the FK constraints anymore: the FKs stay
//     live, so the INSERT only takes a RowShareLock on locations/skus (which
//     does NOT block readers) instead of an AccessExclusiveLock. The only thing
//     locked is inventory_snapshot itself, and only for the ~1-3 min copy+index
//     rebuild — down from a ~20 min app-wide freeze.
//
// Net: identical end state (same columns, same FKs, same indexes, same views),
// no parent-table lock, and the snapshot-only lock window shrinks ~10x because
// the aggregation already happened in Phase 1.
async function bulkReplaceInventorySnapshot(client) {
  // ── Phase 1 — heavy aggregation, OFF-LOCK ──────────────────────────────────
  await client.query(`SET work_mem = '2GB'`);
  await client.query('DROP TABLE IF EXISTS inventory_snapshot_next');
  const agg = await client.query(`
    CREATE UNLOGGED TABLE inventory_snapshot_next AS
    SELECT location_id, sku_id, SUM(qty)::int AS qty_on_hand
    FROM   stg_stock
    GROUP  BY location_id, sku_id
    HAVING SUM(qty) > 0
  `);
  // CRITICAL INVARIANT: inventory_snapshot holds ONLY positive-stock (loc,sku)
  // positions. AIGetStock returns a row for every store×SKU combination it
  // tracks — and ~80% carry qty=0 (a store simply doesn't stock that SKU). The
  // whole platform relies on "a row exists ⇒ stock is present" (e.g. NetworkPulse
  // detects empty stores by the ABSENCE of positive-qty rows; alerts derive
  // OUT_OF_STOCK from movement velocity, not from zero-rows). Without this
  // HAVING filter the table balloons 10× (5.0M rows vs the correct ~484K),
  // which (a) breaks every "row exists ⇒ in stock" assumption and (b) made the
  // Phase-2 rebuild INSERT + index build run for 45+ minutes, wedging the app.
  // The Docker DB produced 473,954 snapshot rows; this filter yields 483,933 —
  // a match. DO NOT remove this HAVING clause.
  logger.info(`[STOCK] Pre-aggregated ${(agg.rowCount || 0).toLocaleString()} (loc,sku) rows off-lock — swapping…`);

  // Defense-in-depth: never TRUNCATE the live table to swap in a near-empty
  // staging set. The caller (syncStockSnapshot) already gates on resolved-row
  // floors, but this keeps the swap safe-by-construction for any caller.
  if ((agg.rowCount || 0) < SNAPSHOT_MIN_ROWS) {
    await client.query('DROP TABLE IF EXISTS inventory_snapshot_next');
    throw new Error(
      `[STOCK] Refusing FULL snapshot swap: staging aggregated to only ` +
      `${(agg.rowCount || 0).toLocaleString()} rows, below floor ${SNAPSHOT_MIN_ROWS.toLocaleString()} — ` +
      `not truncating the live inventory_snapshot.`
    );
  }

  // ── Phase 2 — brief in-place content swap (locks inventory_snapshot only) ──
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL maintenance_work_mem = '2GB'`);
    await client.query(`SET LOCAL synchronous_commit = off`);
    // Don't wait forever if a long dashboard query is mid-flight; surface a
    // clear error to the retry envelope instead of blocking the swap.
    await client.query(`SET LOCAL lock_timeout = '90s'`);

    // Drop only the SECONDARY indexes (NOT the PK / unique / FKs). This locks
    // inventory_snapshot — which TRUNCATE locks anyway — but never the parents.
    await dropSnapshotSecondaryIndexes(client);
    await client.query('TRUNCATE inventory_snapshot');

    const insert = await client.query(`
      INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at, updated_at)
      SELECT location_id, sku_id, qty_on_hand, NOW(), NOW()
      FROM   inventory_snapshot_next
    `);

    // Bulk-rebuild the secondary indexes once over the static table (one sort
    // per index with maintenance_work_mem=2GB) — far cheaper than per-row
    // b-tree maintenance during the INSERT.
    await recreateSnapshotSecondaryIndexes(client);
    await client.query('COMMIT');

    await client.query('ANALYZE inventory_snapshot');
    await client.query('DROP TABLE IF EXISTS inventory_snapshot_next');
    return insert.rowCount || 0;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    try { await client.query('DROP TABLE IF EXISTS inventory_snapshot_next'); } catch (_) {}
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — Stock Snapshot (AIGetStock)  —  Streaming + COPY pipeline
// ─────────────────────────────────────────────────────────────────────────────
//
// Architecture: MSSQL row-stream → CSV encode → pg-copy-streams (COPY FROM
// STDIN) → UNLOGGED stg_stock → set-based MERGE into inventory_snapshot.
//
// Why this replaces the old "buffer everything in JS arrays" path:
//   • Peak JS heap drops from ~500 MB (full recordset + qtyByKey + resolved
//     array) to ~30 MB (just the lookup Maps + one row in flight).
//   • COPY is 5–20× faster than the previous "INSERT … VALUES (…), …
//     ON CONFLICT" batched path on 500 k+ rows.
//   • Backpressure is automatic: when the COPY writer's internal buffer
//     fills, request.pause() halts MSSQL until the writer drains.
//   • Aggregation moves from a JS Map to a SQL GROUP BY in the merge —
//     identical semantics, runs in the database where it belongs.
//
// Identical contract to the previous implementation:
//   • Same stats fields are updated (fetched / updated / failed).
//   • Same "purge phantom rows updated before this run" behaviour.
//   • Same retry envelope (withRetry around the MSSQL SP call).
//   • Same lookup-miss warning cadence (first 30 logged, total summarised).
async function syncStockSnapshot(erpPool, lookupMaps, asOfDate, stats, options = {}) {
  const dateStr       = toErpDate(asOfDate);
  const syncStartedAt = new Date();
  logger.info(`[STOCK] Streaming AIGetStock '${dateStr}' → COPY pipeline`);

  // We hold a single dedicated PG client for the duration of the COPY +
  // merge. COPY is a session-scoped protocol; it cannot share a pooled
  // client with other queries until it has finished.
  const pgClient = await pgPool.connect();
  guardClientErrors(pgClient, 'stock');
  let   lookupMiss = 0;
  let   streamedRows = 0;

  try {
    // ── 1. Reset staging table (UNLOGGED, no WAL, fast TRUNCATE) ────────────
    await pgClient.query('TRUNCATE stg_stock');

    // ── 2. Stream from MSSQL into Postgres COPY (one row at a time) ─────────
    // Wrapped in withRetry so a mid-stream transport failure restarts the
    // entire stage from a fresh TRUNCATE — same all-or-nothing semantics the
    // old code had on a batch failure.
    await withRetry(async () => {
      // Re-TRUNCATE on retry so partial rows from a failed attempt don't merge.
      if (streamedRows > 0) {
        await pgClient.query('TRUNCATE stg_stock');
        streamedRows = 0;
        lookupMiss   = 0;
      }

      const copyStream = pgClient.query(copyFrom(
        `COPY stg_stock (location_id, sku_id, qty) FROM STDIN WITH (FORMAT csv)`
      ));

      const request = erpPool.request();
      request.stream = true;

      await new Promise((resolve, reject) => {
        const onError = (err) => {
          // Surface either side's error to the retry envelope.
          request.removeAllListeners();
          copyStream.removeAllListeners();
          try { copyStream.destroy(err); } catch (_) {}
          reject(err);
        };

        // Resolve the actual column keys ONCE from the first row instead of
        // calling col() (which does up to 9 property probes + 6 string
        // allocations) for every field of every one of 5M rows. Direct
        // property access in the hot loop after this is ~5× cheaper per row.
        let K = null;
        const pick = (row, ...names) => names.find(n => row[n] !== undefined) || names[0];

        request.on('row', (row) => {
          if (K === null) {
            K = {
              store: pick(row, 'Storecode', 'STORECODE', 'storecode'),
              bar:   pick(row, 'barcode', 'BARCODE', 'Barcode'),
              style: pick(row, 'InforItemCode', 'INFORITEMCODE', 'style_variant'),
              qty:   pick(row, 'qty', 'QTY', 'Qty'),
            };
          }
          const qty = Math.max(0, parseInt(row[K.qty] || 0));
          // NOTE: zero-qty rows are intentionally NOT skipped here (per request:
          // fetch the FULL AIGetStock result into stg_stock first). The merge
          // still applies HAVING SUM(qty) > 0, so inventory_snapshot stays
          // positive-only — but stg_stock retains every fetched row for
          // inspection/verification. Re-enable the `if (qty <= 0) return;`
          // skip later to make the COPY + merge ~10× lighter.

          const storeCode    = String(row[K.store] || '').trim().toUpperCase();
          const barcode      = String(row[K.bar]   || '').trim().toUpperCase();
          const styleVariant = String(row[K.style] || '').trim().toUpperCase();

          if (!storeCode || !barcode) return;

          const locationId = lookupMaps.locationByExtId.get(storeCode) || lookupMaps.locationByCode.get(storeCode);
          const skuId      = lookupMaps.skuByExtId.get(barcode) || lookupMaps.skuByStyleVariant.get(styleVariant);

          if (!locationId || !skuId) {
            lookupMiss++;
            stats.failed++;
            if (lookupMiss <= 30) {
              logger.warn(`[STOCK] MISS #${lookupMiss}: store=${storeCode} barcode=${barcode} qty=${qty} reason=${!locationId ? 'STORE_NOT_IN_MASTER' : 'SKU_NOT_IN_MASTER'}`);
            }
            return;
          }

          streamedRows++;
          // Aggregation happens in SQL (GROUP BY in the merge below) — we
          // intentionally do NOT pre-aggregate per (loc, sku) in JS so the
          // memory footprint is O(1) instead of O(unique keys).
          const line = `${locationId},${skuId},${qty}\n`;
          if (!copyStream.write(line)) {
            // Backpressure: pause MSSQL until the COPY writer drains.
            request.pause();
            copyStream.once('drain', () => request.resume());
          }

          if (streamedRows % 50000 === 0) {
            logger.info(`[STOCK] Streamed ${streamedRows.toLocaleString()} rows…`);
          }
        });

        request.on('error', onError);
        copyStream.on('error', onError);

        request.on('done', () => {
          copyStream.end();
        });
        copyStream.on('finish', resolve);

        // Kick off the MSSQL SP. Tedious starts emitting rows immediately;
        // pg-copy-streams starts consuming as soon as the first chunk arrives.
        request.query(`EXEC AIGetStock '${dateStr}'`);
      });
    }, `AIGetStock '${dateStr}' (stream)`);

    if (lookupMiss > 0) {
      logger.warn(`[STOCK] ${lookupMiss.toLocaleString()} rows skipped — store/SKU not found in master (run load_party_master + load_item_master to fix)`);
    }
    logger.info(`[STOCK] Streamed ${streamedRows.toLocaleString()} resolved rows into stg_stock — merging…`);

    // ── 2b. SAFETY GATE — never replace the snapshot from a near-empty resolve ─
    // Both merge paths below are destructive: the FULL path TRUNCATEs
    // inventory_snapshot, and the DELTA path DELETEs every row not touched this
    // run. If a transient master-data gap made every ERP row miss the lookup,
    // stg_stock is empty/tiny and proceeding would silently wipe live stock and
    // report SUCCESS. Refuse unless the resolve clears the floors. Throwing here
    // aborts the stage BEFORE any TRUNCATE/DELETE and marks the run FAILED.
    const prevSnapshotCount =
      (await pgClient.query('SELECT count(*)::int AS n FROM inventory_snapshot')).rows[0].n;

    if (streamedRows < SNAPSHOT_MIN_ROWS) {
      throw new Error(
        `[STOCK] Refusing to replace snapshot: only ${streamedRows.toLocaleString()} rows resolved ` +
        `(${lookupMiss.toLocaleString()} lookup misses), below floor ${SNAPSHOT_MIN_ROWS.toLocaleString()}. ` +
        `Master data (locations/skus) is likely out of sync with the ERP — ` +
        `leaving the existing ${prevSnapshotCount.toLocaleString()} rows untouched. ` +
        `Run load_party_master + load_item_master, then re-sync.`
      );
    }
    if (prevSnapshotCount > 0 && streamedRows < prevSnapshotCount * SNAPSHOT_MIN_RETAIN_RATIO) {
      throw new Error(
        `[STOCK] Refusing to replace snapshot: ${streamedRows.toLocaleString()} resolved rows is below ` +
        `${Math.round(SNAPSHOT_MIN_RETAIN_RATIO * 100)}% of the existing ${prevSnapshotCount.toLocaleString()} ` +
        `(${lookupMiss.toLocaleString()} lookup misses) — suspected partial ERP/master outage. ` +
        `Not shrinking the snapshot. Override via SYNC_SNAPSHOT_MIN_RETAIN_RATIO if this drop is real.`
      );
    }

    // ── 3. Set-based merge: aggregate per (loc, sku), upsert in one stmt ────
    // SUM(qty) replaces the JS qtyByKey aggregation. GROUP BY (loc, sku)
    // collapses bin-split rows. ON CONFLICT preserves the previous upsert
    // semantics — same conflict target (uq_inventory_location_sku).
    //
    // The GROUP BY produces ~5M groups on a full load. The global work_mem
    // (256 MB, tuned for dashboard queries) is too small for that hash
    // aggregate and spills ~800 MB to disk, dragging the merge to 20–60 min.
    // Bump work_mem for THIS client's session only so the aggregate stays in
    // RAM (full merge drops to ~1–2 min). Reset in the finally block so the
    // pooled connection never carries 2 GB back to ordinary queries.
    let upserted = 0;

    if (options.fullReplace) {
      logger.info('[STOCK] FULL refresh detected — using truncate + bulk rebuild instead of ON CONFLICT merge');
      upserted = await bulkReplaceInventorySnapshot(pgClient);
    } else {
      await pgClient.query(`SET work_mem = '2GB'`);
      const merge = await pgClient.query(`
        INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at, updated_at)
        SELECT location_id, sku_id, SUM(qty)::int, NOW(), NOW()
        FROM   stg_stock
        GROUP BY location_id, sku_id
        HAVING SUM(qty) > 0
        ON CONFLICT (location_id, sku_id) DO UPDATE SET
          qty_on_hand      = EXCLUDED.qty_on_hand,
          last_movement_at = NOW(),
          updated_at       = NOW()
      `);

      upserted = merge.rowCount || 0;

      // POSITIVE-STOCK INVARIANT (see bulkReplaceInventorySnapshot): the
      // HAVING SUM(qty) > 0 above means a (loc,sku) that the ERP now reports
      // at zero is NOT upserted, so its existing row keeps its old updated_at
      // and is swept by the phantom-purge below (updated_at < syncStartedAt).
      // Net effect: positions that went to zero are DELETED, not kept at 0.
      // Without the HAVING, ~80% of AIGetStock's zero rows bloated the table
      // 10× (5.0M vs ~484K) and dragged the merge to 20-60 min.

      // ── 4. Purge phantom rows — same semantics as the legacy path ──────────
      const del = await pgClient.query(
        `DELETE FROM inventory_snapshot WHERE updated_at < $1`,
        [syncStartedAt]
      );
      if (del.rowCount > 0) {
        logger.info(`[STOCK] Removed ${del.rowCount} stale snapshot rows (not in today's ERP snapshot)`);
      }
    }

    // ── 5. Free staging — keep the table around (DDL is expensive) ──────────
    await pgClient.query('TRUNCATE stg_stock');

    stats.fetched += upserted;
    stats.updated += upserted;
    logger.info(`[STOCK] ✅ Snapshot complete: ${upserted.toLocaleString()} rows from AIGetStock '${dateStr}' via COPY`);
  } finally {
    // Drop the elevated work_mem before returning this client to the pool so
    // dashboard/analytics queries don't inherit a 2 GB per-sort budget.
    try { await pgClient.query('RESET work_mem'); } catch (_) { /* client may be dead */ }
    pgClient.release();
  }
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

    // The streaming pipeline (TRUNCATE → COPY → MERGE) is the unit of retry.
    // A mid-stream transport failure rolls back to a fresh TRUNCATE on retry,
    // preserving the legacy "batch failed → batch redone" semantics.
    const inserted = await withRetry(
      () => streamMovements({
        erpPool,
        executeSp: (req) => req.query(`EXEC SalesAI '${fromStr}','${toStr}'`),
        movementType: 'SALE',
        direction: -1,
        resolverFn: resolveSalesRow,
        lookupMaps,
        label: chunk.label,
      }),
      `SalesAI ${chunk.label} (stream)`
    );

    return { chunk: chunk.label, inserted };
  });

  const results = await pooledChunks(tasks, MAX_PARALLEL_CHUNKS);

  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalInserted += r.value.inserted;
    } else {
      failedChunks++;
      logger.error(`[SALES] Chunk failed: ${r.reason?.message}`);
    }
  }

  // With streaming, "fetched" rows from MSSQL are no longer materialized in
  // memory so we no longer have a cheap count of them. We report inserted
  // (the count Postgres actually persisted) for both — this is the number
  // every downstream consumer of sync_logs actually cares about (dashboards
  // show "records_inserted").
  totalRows = totalInserted;
  stats.fetched  += totalRows;
  stats.inserted += totalInserted;
  stats.failed   += failedChunks;

  logger.info(`[SALES] ✅ Done: ${totalInserted.toLocaleString()} inserted via COPY, ${failedChunks} chunks failed`);
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

    const inserted = await withRetry(
      () => streamMovements({
        erpPool,
        executeSp: (req) => req.query(`EXEC SalesReturnAI '${fromStr}','${toStr}'`),
        movementType: 'RETURN',
        direction: +1,
        resolverFn: resolveReturnRow,
        lookupMaps,
        label: chunk.label,
      }),
      `SalesReturnAI ${chunk.label} (stream)`
    );

    return { chunk: chunk.label, inserted };
  });

  const results = await pooledChunks(tasks, MAX_PARALLEL_CHUNKS);

  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalInserted += r.value.inserted;
    } else {
      failedChunks++;
      logger.error(`[RETURNS] Chunk failed: ${r.reason?.message}`);
    }
  }

  // See syncSalesChunked — fetched count no longer materialized in JS; report
  // the inserted count so sync_logs records a meaningful number.
  totalRows = totalInserted;
  stats.fetched  += totalRows;
  stats.inserted += totalInserted;
  stats.failed   += failedChunks;

  logger.info(`[RETURNS] ✅ Done: ${totalInserted.toLocaleString()} inserted via COPY, ${failedChunks} chunks failed`);
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

// ─── Streaming movement upsert (MSSQL row-stream → COPY → MERGE) ──────────────
//
// Replaces the previous "buffer the recordset → batched INSERT … VALUES" path.
// Per-chunk contract is preserved:
//   • Same retry envelope (each chunk wrapped in withRetry by the caller).
//   • Same conflict semantics — ON CONFLICT … DO NOTHING on the existing
//     unique partial index (location_id, sku_id, movement_type, reference_no,
//     moved_at) WHERE reference_no IS NOT NULL.
//   • Same row resolution (resolverFn) and direction sign convention.
//   • Returns the number of rows inserted into inventory_movements (DO NOTHING
//     means duplicates are silently skipped — rowCount excludes them, matching
//     the previous code's "batch succeeded" accounting).
//
// `executeSp` lets the caller drive any SQL Server stored proc (SalesAI or
// SalesReturnAI) — both share the streaming + COPY shell.
async function streamMovements({ erpPool, executeSp, movementType, direction, resolverFn, lookupMaps, label }) {
  const pgClient = await pgPool.connect();
  guardClientErrors(pgClient, `movements:${movementType}:${label}`);
  let streamedRows = 0;

  try {
    // Each monthly chunk may run in parallel. A shared staging table plus
    // TRUNCATE lets one chunk erase another chunk before it merges, so every
    // worker gets its own session-local staging table.
    await pgClient.query(`
      DROP TABLE IF EXISTS tmp_movements;
      CREATE TEMP TABLE tmp_movements (
        location_id    UUID         NOT NULL,
        sku_id         UUID         NOT NULL,
        movement_type  VARCHAR(20)  NOT NULL,
        qty_change     INTEGER      NOT NULL,
        reference_no   TEXT,
        sale_value     NUMERIC(15,2),
        moved_at       TIMESTAMPTZ  NOT NULL
      )
    `);

    const copyStream = pgClient.query(copyFrom(
      `COPY tmp_movements (location_id, sku_id, movement_type, qty_change, reference_no, sale_value, moved_at) FROM STDIN WITH (FORMAT csv)`
    ));

    const request = erpPool.request();
    request.stream = true;

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        request.removeAllListeners();
        copyStream.removeAllListeners();
        try { copyStream.destroy(err); } catch (_) {}
        reject(err);
      };

      request.on('row', (row) => {
        const r = resolverFn(row, lookupMaps);
        if (!r) return;
        streamedRows++;

        const line =
          csvEscape(r.locationId)             + ',' +
          csvEscape(r.skuId)                   + ',' +
          csvEscape(movementType)              + ',' +
          csvEscape(String(direction * r.qty)) + ',' +
          csvEscape(r.refNo)                   + ',' +
          csvEscape(r.saleValue == null ? '' : String(r.saleValue)) + ',' +
          csvEscape(tsForCopy(r.movedAt))      + '\n';

        if (!copyStream.write(line)) {
          request.pause();
          copyStream.once('drain', () => request.resume());
        }
      });

      request.on('error', onError);
      copyStream.on('error', onError);
      request.on('done', () => copyStream.end());
      copyStream.on('finish', resolve);

      // Caller-supplied SP execution — keeps SalesAI vs SalesReturnAI
      // parameter formatting in one place (the chunk task) and lets us reuse
      // this primitive for any future row-producing SP.
      executeSp(request);
    });

    logger.info(`[${movementType}] ${label}: streamed ${streamedRows.toLocaleString()} resolved rows → merging…`);

    // Set-based merge. The qty_before / qty_after columns are not maintained
    // by the legacy path either (always 0) — preserved for schema parity.
    // synced_from = 'SQL_SERVER_SYNC' matches the legacy literal so the
    // existing FULL-sync cleanup query (DELETE … WHERE synced_from =
    // 'SQL_SERVER_SYNC') keeps working unchanged.
    const merge = await pgClient.query(`
      INSERT INTO inventory_movements
        (location_id, sku_id, movement_type, qty_change, qty_before, qty_after,
         reference_no, sale_value, moved_at, synced_from)
      SELECT
        location_id, sku_id, movement_type::movement_type, qty_change,
        0, 0,
        reference_no, sale_value, moved_at, 'SQL_SERVER_SYNC'
      FROM tmp_movements
      ON CONFLICT (location_id, sku_id, movement_type, reference_no, moved_at)
        WHERE reference_no IS NOT NULL DO NOTHING
    `);

    return merge.rowCount || 0;
  } finally {
    try { await pgClient.query('DROP TABLE IF EXISTS tmp_movements'); } catch (_) {}
    pgClient.release();
  }
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
  //   - ERP sales data may lag the wall clock by hours/days depending on the
  //     last successful sync. Using NOW() makes every item appear staler than
  //     it really is, collapsing stock into the 180+ "Dead Stock" bucket.
  //
  // Instead: use MAX(moved_at) of SALE movements as the reference point.
  // This measures "days since last sale" relative to the latest date in our
  // data, which is the correct business interpretation.
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

  // Run on a dedicated client with a big work_mem + parallel workers: this
  // statement aggregates every SALE movement twice (the ref MAX and the
  // per-(loc,sku) last_sold_at GROUP BY) and hash-joins the result against the
  // whole snapshot. At the default 256 MB work_mem those hashes spill to disk
  // and the recompute crawls. 1 GB keeps them in RAM; reset on the finally so
  // the pooled connection never carries the elevated budget back to dashboard
  // queries.
  const ageClient = await pgPool.connect();
  guardClientErrors(ageClient, 'ageing');
  try {
  await ageClient.query(`SET work_mem = '1GB'`);
  await ageClient.query(`SET max_parallel_workers_per_gather = 4`);
  await ageClient.query(`
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
  const refRow = await ageClient.query(`
    SELECT MAX(moved_at)::date AS ref_date, COUNT(*)::int AS total_sales
    FROM inventory_movements WHERE movement_type = 'SALE'
  `);
  const { ref_date, total_sales } = refRow.rows[0];
  logger.info(`[AGEING] ✅ Buckets updated — reference date: ${ref_date} (${total_sales?.toLocaleString()} sale records)`);
  } finally {
    try { await ageClient.query('RESET work_mem'); } catch (_) {}
    try { await ageClient.query('RESET max_parallel_workers_per_gather'); } catch (_) {}
    ageClient.release();
  }
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
// ─── Advisory-lock liveness signal ────────────────────────────────────────────
// The sync process acquires a session-level Postgres advisory lock and
// holds it on a dedicated client for the entire run. When this process
// dies (crash, kill, console-close cascade on Windows), the client's TCP
// connection drops, Postgres releases the lock, and the orphan reaper in
// sync.controller.js detects it within one poll cycle (~15 s) — instead
// of waiting the 30-min wall-clock fallback.
//
// Key picked to be (a) constant across the codebase, (b) unlikely to
// collide with any other advisory-lock user. Two-int form makes the
// pg_locks lookup straightforward (no bit-shift).
const SYNC_LOCK_CLASSID = 4815;
const SYNC_LOCK_OBJID   = 162342;

async function runDeltaSync(syncType = 'DELTA') {
  const pipelineStart = Date.now();
  logger.info(`${'═'.repeat(70)}`);
  logger.info(`  SPYKAR SYNC ENGINE  —  ${syncType} SYNC  —  ${new Date().toISOString()}`);
  logger.info(`${'═'.repeat(70)}`);

  // Acquire the liveness lock on a DEDICATED client — must outlive any
  // single query for the lock to survive across pool re-allocation.
  const lockClient = await pgPool.connect();
  guardClientErrors(lockClient, 'sync-lock');
  let lockHeld = false;
  try {
    const tryLock = await lockClient.query(
      'SELECT pg_try_advisory_lock($1, $2) AS got',
      [SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID]
    );
    if (!tryLock.rows[0].got) {
      // Another live process holds it. We do NOT INSERT a sync_logs row
      // in this case — the caller (controller / scheduler) should have
      // gated this already, but defence in depth.
      throw new Error('Another sync is already running (advisory lock held by a live process)');
    }
    lockHeld = true;
    logger.info(`[LOCK] Acquired advisory lock (${SYNC_LOCK_CLASSID}, ${SYNC_LOCK_OBJID}) — pid ${process.pid}`);
  } catch (err) {
    lockClient.release();
    throw err;
  }

  // Record sync start in log
  const logResult = await query(
    `INSERT INTO sync_logs (sync_type, status, source) VALUES ($1, 'RUNNING', 'SQL_SERVER') RETURNING id`,
    [syncType]
  );
  syncLogId = logResult.rows[0].id;

  const stats = { fetched: 0, inserted: 0, updated: 0, failed: 0 };

  try {
    // ── Determine date range ───────────────────────────────────────────────────
    // Stock snapshot + sales ceiling are always TODAY (evaluated per run).
    const runToday  = today();
    const stockDate = runToday;

    let salesFrom, salesTo;

    if (syncType === 'FULL') {
      // Full history: 2024-01-01 → today
      salesFrom = FULL_HISTORY_START;
      salesTo   = runToday;
      logger.info(`[RANGE] FULL sync: ${toErpDate(salesFrom)} → ${toErpDate(salesTo)} (${generateMonthlyChunks(salesFrom, salesTo).length} months)`);
      // NOTE: the movement wipe used to happen HERE, before we knew whether the
      // ERP was even reachable — so an ERP-down FULL would empty the table and
      // then have nothing to reload. It now happens inside the pipeline block
      // below, only after SQL Server is confirmed up.

    } else {
      // Delta: last N months → today
      const now = new Date();
      const deltaStart = startOfMonth(now.getFullYear(), now.getMonth() - DELTA_LOOKBACK_MONTHS);
      salesFrom = new Date(Math.max(deltaStart, FULL_HISTORY_START));
      salesTo   = runToday;
      logger.info(`[RANGE] DELTA sync: ${toErpDate(salesFrom)} → ${toErpDate(salesTo)}`);
    }

    // ── Connect to SQL Server ─────────────────────────────────────────────────
    const pool = await tryConnectSqlServer();

    if (pool) {
      try {
        logger.info('[PIPELINE] SQL Server connected — starting ERP pipeline');
        const fullRebuild = syncType === 'FULL';

        // STAGE 0: Build lookup maps
        const lookupMaps = await buildLookupMaps();

        // STAGE 1: Stock snapshot (current date)
        await syncStockSnapshot(pool, lookupMaps, stockDate, stats, {
          fullReplace: fullRebuild,
        });

        // FULL only: ERP is confirmed up, so clear the old movement history and
        // go index-light for the bulk reload. DELTA skips both — it loads a small
        // window into the live, fully-indexed table so the dashboard stays fast.
        if (fullRebuild) {
          await clearSyncedMovements();
          await dropMovementsSecondaryIndexes();
        }

        // STAGE 2: Sales history (chunked by month)
        await syncSalesChunked(pool, lookupMaps, salesFrom, salesTo, stats);

        // STAGE 3: Return history (chunked by month)
        await syncReturnsChunked(pool, lookupMaps, salesFrom, salesTo, stats);

        // FULL only: rebuild the 9 secondary indexes in parallel over the now-
        // fully-loaded table (one bulk sort each, not millions of per-row b-tree
        // hits), then refresh planner stats so the dashboard plans optimally.
        if (fullRebuild) {
          await rebuildMovementsSecondaryIndexes();
          await query('ANALYZE inventory_movements');
        }

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

    // Invalidate all Redis caches so fresh data is served immediately.
    // CRITICAL: also bust the v2 universal-filter caches so when tomorrow's
    // stock lands and a SKU goes OOS at every store, the dropdown options
    // and Network Pulse widgets update on the very next request — not 5
    // minutes later when their TTL would naturally expire.
    await Promise.all([
      invalidatePattern('inventory:*'),
      invalidatePattern('analytics:*'),
      invalidatePattern('locations:*'),
      invalidatePattern('distributors:*'),
      invalidatePattern('sku:*'),
      invalidatePattern('dispatch:*'),
      invalidatePattern('filters:*'),       // v2 dropdown options
      invalidatePattern('network:*'),       // network-pulse aggregations
      invalidatePattern('skuids:*'),        // pre-resolved SKU UUID lists
      invalidatePattern('category:*'),      // category → sku_id[] cache
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
  } finally {
    // Release the liveness lock. On a clean shutdown this runs and the
    // unlock query lands before the client returns to the pool. On an
    // abrupt process death (kill -9, OS shutdown, console close) this
    // never runs — but Postgres releases the lock automatically when
    // the TCP connection drops, which is exactly the signal we want.
    if (lockHeld) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID]);
        logger.info(`[LOCK] Released advisory lock — pid ${process.pid}`);
      } catch (_) { /* connection may already be torn down — Postgres releases anyway */ }
    }
    try { lockClient.release(); } catch (_) {}
  }
}

module.exports = { runDeltaSync, SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID };
