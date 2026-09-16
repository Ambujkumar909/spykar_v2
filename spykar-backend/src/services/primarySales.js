/**
 * primarySales.js  —  Primary sales (MITTRA) ETL engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared engine for the primary-sales feed. Used by BOTH the CLI wrapper
 * (src/database/load_primary_sales.js) and the syncEngine daily-delta stage.
 *
 * Source : Infor M3 reporting DB M3ReportdataPRD (SQL Server @ M3_HOST)
 *            MITTRA A ⋈ MITMAS B (CONO,ITNO) ⋈ MITWHL D (CONO,WHLO)
 *            WHERE A.CONO=92 AND B.STCD=1 AND D.DIVI='AAA'
 * Target : PostgreSQL  primary_warehouses + primary_sales_movements (ledger)
 *          + primary_sales_daily (the rollup every dashboard query reads)
 * SKU map: MITTRA.ITNO → skus.infor_item_code / style_variant / external_id
 *
 * DATA SHAPE (confirmed via Phase 0 against the live server — see migration 016):
 *   • TRDT, RGDT      → DATE          (mssql returns JS Date; format YYYY-MM-DD)
 *   • RGTM, TMSX, TTYP→ INT
 *   • LMTS            → DATETIME2      (the delta high-water; NOT a bigint)
 *   • REAL PK / dedup key = (CONO,WHLO,ITNO,RGDT,RGTM,TMSX)  — REPN is NOT unique
 *   • Full filtered size ≈ 110M rows. TRDT is unindexed on M3; the clustered key
 *     leads with (CONO, WHLO, …), so the backfill streams ONE WHLO AT A TIME —
 *     each chunk is a range seek, and progress is persisted per chunk so a
 *     multi-hour load survives a VPN drop and resumes where it stopped.
 *
 * DESIGN INVARIANTS (the things that were wrong before and must stay fixed):
 *   1. The dashboard never waits on the ETL. The full rollup rebuild is built
 *      off-lock in a side table and swapped in via RENAME (milliseconds); the
 *      incremental path re-aggregates only the dates a batch touched.
 *   2. The rollup is never re-summed over the whole ledger except by the
 *      one-time backfill. Delta/reconcile drain `primary_rollup_dirty`.
 *   3. Every state transition is durable: dirty dates are marked in the same
 *      transaction as the ledger merge; backfill progress is per WHLO; the
 *      reconcile remembers per-day counts so unmappable residue isn't re-chased.
 *   4. Duplicates are impossible: the UNIQUE MITTRA key + UPSERT everywhere the
 *      table already has rows; the index-light bulk COPY only ever runs into an
 *      empty table / disjoint WHLO chunks.
 */

'use strict';

const sql      = require('mssql');
const copyFrom = require('pg-copy-streams').from;
const { pool: pgPool, query } = require('../config/database');
const logger   = require('../config/logger');

const FEED = 'mittra_primary_sales';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLLUP_CHUNK_DATES = 31;         // dates per incremental rollup transaction
const RECONCILE_BATCH_DATES = 60;      // short days re-pulled per M3 pass
const MISS_TRACK_CAP = 20000;          // distinct unmappable keys kept in memory per run
// A VPN drop without a TCP reset leaves the M3 stream silently open forever
// (requestTimeout is 0 by design — the backfill runs for hours). The watchdog
// fails the stream when NO row/done arrives for this long; the sync moves on
// and the next run retries from the same high-water / progress state.
const stallTimeoutMs = () => Math.max(5000, parseInt(process.env.M3_STALL_TIMEOUT_MS, 10) || 180000);

// ─── M3 connection ────────────────────────────────────────────────────────────
function m3Config() {
  return {
    server:   process.env.M3_HOST     || process.env.MSSQL_HOST,
    port:     parseInt(process.env.M3_PORT || process.env.MSSQL_PORT) || 1433,
    // Fully-qualified queries (M3ReportdataPRD.dbo.*) mean the initial catalog
    // only needs to be one the login can open. Falls back to MSSQL_DATABASE.
    database: process.env.M3_DATABASE || process.env.MSSQL_DATABASE,
    user:     process.env.M3_USER     || process.env.MSSQL_USER,
    password: process.env.M3_PASSWORD || process.env.MSSQL_PASSWORD,
    // mssql reads these at the TOP level (options.* is tedious-only).
    connectionTimeout: parseInt(process.env.M3_CONNECT_TIMEOUT_MS) || 30000,
    requestTimeout:    0,   // 0 = no cap — the backfill stream runs long
    options: {
      encrypt:                (process.env.M3_ENCRYPT || process.env.MSSQL_ENCRYPT) === 'true',
      trustServerCertificate: true,
      packetSize:             32768,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone:              false,
      enableArithAbort:                 true,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
  };
}

// Connect to M3 with retry — the VPN link can blip. A transient connect failure
// should never fail a sync/reconcile outright; retry with backoff first.
// `connectM3` is the indirection every public entry point uses, so the
// verification harness (src/scripts/verify_primary_sales.js) can substitute a
// fake M3 and drive the whole pipeline end-to-end without the VPN.
let connectM3 = m3Connect;
async function m3Connect() {
  const tries = parseInt(process.env.M3_CONNECT_RETRIES) || 4;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await sql.connect(m3Config()); }
    catch (err) {
      lastErr = err;
      if (i < tries - 1) {
        const delay = 4000 * (i + 1);
        logger.warn(`[PRIMARY] M3 connect attempt ${i + 1}/${tries} failed (${err.message}) — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// Columns pulled from M3 (the agreed query + the PK columns RGDT/RGTM/TMSX,
// which are the real MITTRA unique key used for the delta upsert).
const SELECT_COLS = `
  A.CONO, A.WHLO, A.ITNO, A.TRDT, A.RGDT, A.RGTM, A.TMSX, A.NSTT, A.TTYP, A.TRTP,
  A.WHSL, A.TRPR, B.PUPR, A.TRQT, A.REPN, A.STAS, A.LMTS`;
const BASE_JOIN = `
  FROM        M3ReportdataPRD.dbo.MITTRA A
  INNER JOIN  M3ReportdataPRD.dbo.MITMAS B ON A.CONO = B.CONO AND A.ITNO = B.ITNO
  INNER JOIN  M3ReportdataPRD.dbo.MITWHL D ON D.CONO = A.CONO AND D.WHLO = A.WHLO`;
const BASE_WHERE = `WHERE A.CONO = 92 AND B.STCD = 1 AND D.DIVI = 'AAA'`;
const selectSql = (whereExtra = '', top = null) =>
  `SELECT ${top ? `TOP ${top} ` : ''}${SELECT_COLS} ${BASE_JOIN} ${BASE_WHERE} ${whereExtra}`;

// Canonical destination column order — used by every COPY + INSERT.
const COPY_COLS = [
  'warehouse_id', 'sku_id', 'cono', 'whlo', 'itno', 'trdt', 'rgdt', 'rgtm', 'tmsx',
  'nstt', 'ttyp', 'trtp', 'whsl', 'trpr', 'pupr', 'trqt', 'repn', 'stas', 'lmts',
];
const KEY_COLS = ['cono', 'whlo', 'itno', 'rgdt', 'rgtm', 'tmsx'];
const KEY_LIST = KEY_COLS.join(', ');
const NON_KEY_UPDATE_COLS = ['warehouse_id', 'sku_id', 'trdt', 'nstt', 'ttyp', 'trtp', 'whsl', 'trpr', 'pupr', 'trqt', 'repn', 'stas', 'lmts'];

// The ledger's index set. Only what is actually read: the unique MITTRA key
// (upsert) and trdt (incremental rollup / reconcile / ageing). Dropped during
// the bulk backfill and rebuilt after (migration 021 removed the dead ones).
const LEDGER_INDEXES = [
  { name: 'uq_primary_movement',      ddl: `CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_movement ON primary_sales_movements (${KEY_LIST})` },
  { name: 'idx_primary_mv_trdt',      ddl: `CREATE INDEX IF NOT EXISTS idx_primary_mv_trdt ON primary_sales_movements (trdt)` },
  { name: 'idx_primary_mv_trdt_brin', ddl: `CREATE INDEX IF NOT EXISTS idx_primary_mv_trdt_brin ON primary_sales_movements USING BRIN (trdt) WITH (pages_per_range = 32)` },
];

// Rollup indexes (canonical names — migrations 018/022). Every dashboard query
// is TRDT-windowed. The sku-grain composite (trdt, sku_id) additionally serves
// COUNT(DISTINCT sku_id) as an index-only scan.
const ROLLUP_TABLES = [
  { table: 'primary_sales_daily',    indexes: [{ name: 'idx_psd_trdt_sku', ddl: (tbl, nm) => `CREATE INDEX ${nm} ON ${tbl} (trdt, sku_id)` }] },
  { table: 'primary_sales_daily_wh', indexes: [{ name: 'idx_psdw_trdt',    ddl: (tbl, nm) => `CREATE INDEX ${nm} ON ${tbl} (trdt)` }] },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function col(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null) return row[n];
    const u = n.toUpperCase(); if (row[u] !== undefined && row[u] !== null) return row[u];
    const l = n.toLowerCase(); if (row[l] !== undefined && row[l] !== null) return row[l];
  }
  return null;
}

// DATE column → 'YYYY-MM-DD' (mssql returns a JS Date at UTC midnight).
function dOnly(v) {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : '';
}

// DATETIME2 column → JS Date | null (also tracked for the high-water mark).
function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length === 0) return '';
  if (!/[",\n\r]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// SQL Server datetime2 literal (naive wall-clock) from a JS Date — round-trips
// consistently with what tedious read from the source column.
function sqlDatetimeLiteral(d) { return d.toISOString().slice(0, 23); } // 'YYYY-MM-DDTHH:MM:SS.mmm'

// Anything interpolated into M3 SQL is validated/escaped first. Dates come from
// the CLI or from M3 itself; warehouse codes from primary_warehouses.
function assertDate(s, label) {
  if (!DATE_RE.test(String(s || ''))) throw new Error(`[PRIMARY] ${label} must be YYYY-MM-DD (got '${s}')`);
  return String(s);
}
const sqlStr = (s) => String(s).replace(/'/g, "''");
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1);
const fmtN = (n) => Number(n || 0).toLocaleString();

function guardClientErrors(client, label) {
  client.on('error', (err) => logger.error(`[PRIMARY:${label}] client error: ${err.message}`));
}

// Reset session settings we may have raised. Best-effort.
async function resetSession(pg) {
  for (const s of ['work_mem', 'maintenance_work_mem', 'synchronous_commit']) {
    try { await pg.query(`RESET ${s}`); } catch (_) { /* ignore */ }
  }
}

// ─── Lookup maps ──────────────────────────────────────────────────────────────
// ALL skus, not just active ones: the ledger is history, and a SKU deactivated
// today still owns years of movements. Active rows win on a key collision.
async function buildLookupMaps() {
  const [skuRows, whRows] = await Promise.all([
    query(`SELECT id, external_id, style_variant, infor_item_code FROM skus ORDER BY is_active DESC`),
    query(`SELECT id, whlo FROM primary_warehouses WHERE is_active = true ORDER BY whlo`),
  ]);
  const skuByItno = new Map();
  const warehouseMap = new Map();
  for (const r of skuRows.rows) {
    for (const key of [r.infor_item_code, r.style_variant, r.external_id]) {
      if (key) { const k = String(key).toUpperCase().trim(); if (k && !skuByItno.has(k)) skuByItno.set(k, r.id); }
    }
  }
  for (const r of whRows.rows) if (r.whlo) warehouseMap.set(String(r.whlo).trim(), r.id);
  const whlos = [...warehouseMap.keys()].sort();
  logger.info(`[PRIMARY] Lookup maps: ${warehouseMap.size} warehouses, ${skuByItno.size} item keys`);
  return { skuByItno, warehouseMap, whlos };
}

// ─── Unmappable-row tracking ─────────────────────────────────────────────────
// Rows whose ITNO isn't in the SKU master (or whose WHLO isn't an AAA warehouse)
// can never be loaded. Instead of a bare "N misses" counter, keep a bounded
// per-key tally and persist it so the residual is explainable + fixable.
function newMissTracker() { return { total: 0, byKey: new Map(), overflowKeys: 0 }; }
function trackMiss(t, key) {
  t.total++;
  const cur = t.byKey.get(key);
  if (cur !== undefined) t.byKey.set(key, cur + 1);
  else if (t.byKey.size < MISS_TRACK_CAP) t.byKey.set(key, 1);
  else t.overflowKeys++;
}
async function recordUnmapped(t, label) {
  if (!t.total) return;
  const entries = [...t.byKey.entries()].sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 8).map(([k, n]) => `${k}×${n}`).join(', ');
  logger.warn(`[PRIMARY] [${label}] ${fmtN(t.total)} unmappable rows over ${fmtN(entries.length + t.overflowKeys)} keys — top: ${top}` +
    ` (see primary_unmapped_items)`);
  try {
    for (const part of chunk(entries, 5000)) {
      await query(`
        INSERT INTO primary_unmapped_items (itno, rows_seen, last_run_rows, last_label)
        SELECT k, c, c, $3 FROM unnest($1::text[], $2::bigint[]) AS u(k, c)
        ON CONFLICT (itno) DO UPDATE SET
          rows_seen = primary_unmapped_items.rows_seen + EXCLUDED.rows_seen,
          last_run_rows = EXCLUDED.last_run_rows, last_seen_at = NOW(), last_label = EXCLUDED.last_label
      `, [part.map((e) => e[0]), part.map((e) => e[1]), label]);
    }
  } catch (err) {
    logger.warn(`[PRIMARY] could not persist unmapped items (non-fatal): ${err.message}`);
  }
}

// Resolve one MITTRA row → CSV field values in COPY_COLS order, or a miss.
function resolveRow(row, maps) {
  const whlo = String(col(row, 'WHLO') || '').trim();
  const itno = String(col(row, 'ITNO') || '').trim();
  const warehouseId = maps.warehouseMap.get(whlo);
  if (!warehouseId) return { miss: `WH:${whlo || '?'}` };
  const skuId = maps.skuByItno.get(itno.toUpperCase());
  if (!skuId) return { miss: itno || '?' };

  const lmts = toDate(col(row, 'LMTS'));
  const fields = [
    warehouseId, skuId,
    parseInt(col(row, 'CONO'), 10) || 92,
    whlo, itno,
    dOnly(col(row, 'TRDT')),
    dOnly(col(row, 'RGDT')),
    col(row, 'RGTM') ?? 0,
    col(row, 'TMSX') ?? 0,
    col(row, 'NSTT'),
    col(row, 'TTYP'),
    col(row, 'TRTP'),
    col(row, 'WHSL'),
    col(row, 'TRPR'),
    col(row, 'PUPR'),
    col(row, 'TRQT') ?? 0,   // SIGNED — do NOT abs()
    col(row, 'REPN'),
    col(row, 'STAS'),
    lmts ? lmts.toISOString() : '',
  ];
  return { fields, lmts };
}

// ─── Core streaming primitive ─────────────────────────────────────────────────
// Streams a fully-formed M3 SELECT straight into a Postgres COPY target with
// backpressure, and returns the loaded row count + max LMTS seen. Misses are
// tallied into `misses`. `copyTarget` is the live ledger (bulk backfill) or a
// session TEMP table (everything else).
async function streamInto(pg, erpPool, maps, sqlText, copyTarget, label, misses) {
  let streamed = 0, maxLmts = null;
  const copyStream = pg.query(copyFrom(
    `COPY ${copyTarget} (${COPY_COLS.join(', ')}) FROM STDIN WITH (FORMAT csv)`
  ));
  const request = erpPool.request();
  request.stream = true;

  await new Promise((resolve, reject) => {
    let settled = false;
    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => fail(new Error(`M3 stream stalled: no data for ${stallTimeoutMs() / 1000}s (${label}) — link dropped?`)), stallTimeoutMs());
      if (watchdog.unref) watchdog.unref();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      request.removeAllListeners('row');
      try { request.cancel(); } catch (_) { /* ignore */ }
      try { copyStream.destroy(err); } catch (_) { /* ignore */ }
      reject(err);
    };
    armWatchdog();
    request.on('row', (row) => {
      armWatchdog();
      const r = resolveRow(row, maps);
      if (r.miss) { trackMiss(misses, r.miss); return; }
      streamed++;
      if (r.lmts && (!maxLmts || r.lmts > maxLmts)) maxLmts = r.lmts;
      if (!copyStream.write(r.fields.map(csvEscape).join(',') + '\n')) {
        request.pause();
        copyStream.once('drain', () => request.resume());
      }
      if (streamed % 250000 === 0) logger.info(`[PRIMARY] [${label}] streamed ${fmtN(streamed)}…`);
    });
    request.on('error', fail);
    copyStream.on('error', fail);
    request.on('done', () => { if (watchdog) clearTimeout(watchdog); copyStream.end(); });
    copyStream.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    request.query(sqlText);
  });

  return { streamed, maxLmts };
}

// ─── Warehouses (MITWHL → primary_warehouses) ────────────────────────────────
async function upsertWarehouses(erpPool) {
  const res = await erpPool.request().query(
    `SELECT CONO, WHLO, WHNM, DIVI, FACI, WHTY
       FROM M3ReportdataPRD.dbo.MITWHL WHERE CONO = 92 AND DIVI = 'AAA' ORDER BY WHLO`
  );
  let n = 0;
  for (const row of res.recordset) {
    await query(`
      INSERT INTO primary_warehouses (cono, whlo, whnm, divi, faci, whty, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,true)
      ON CONFLICT (cono, whlo) DO UPDATE SET
        whnm = EXCLUDED.whnm, divi = EXCLUDED.divi, faci = EXCLUDED.faci,
        whty = EXCLUDED.whty, is_active = true, updated_at = NOW()
    `, [
      parseInt(col(row, 'CONO'), 10) || 92, String(col(row, 'WHLO') || '').trim(),
      col(row, 'WHNM'), col(row, 'DIVI'), col(row, 'FACI'), col(row, 'WHTY'),
    ]);
    n++;
  }
  logger.info(`[PRIMARY] ✓ Upserted ${n} warehouses`);
  return n;
}

// ─── High-water helpers (LMTS datetime2) ─────────────────────────────────────
async function getHighWater() {
  const r = await query(`SELECT last_lmts_ts FROM primary_sync_state WHERE feed = $1`, [FEED]);
  return r.rows[0] ? r.rows[0].last_lmts_ts : null; // JS Date | null
}
async function advanceHighWater(maxLmts, addRows) {
  if (!maxLmts) return;
  await query(`
    INSERT INTO primary_sync_state (feed, last_lmts_ts, last_run_at, rows_total)
    VALUES ($1, $2, NOW(), $3)
    ON CONFLICT (feed) DO UPDATE SET
      last_lmts_ts = GREATEST(primary_sync_state.last_lmts_ts, EXCLUDED.last_lmts_ts),
      last_run_at  = NOW(),
      rows_total   = primary_sync_state.rows_total + EXCLUDED.rows_total
  `, [FEED, maxLmts, addRows || 0]);
}

// ─── Rollup SQL (one definition each, used by full + incremental) ────────────
// Sku grain (trdt, warehouse_id, sku_id, ttyp). Prices resolved once here
// (trpr→mrp fallback, pupr→cost_price fallback) so the controller never joins
// the raw ledger. Rows with a NULL trdt are unaddressable by any date window
// (and by the dirty-date mechanism), so they are excluded consistently.
// Warehouse grain (trdt, warehouse_id, ttyp, category_norm) is DERIVED from the
// sku grain — the instant layer every non-SKU dashboard query reads (226×
// smaller on the FY). Both are always written in the same transaction.
const ROLLUP_COLS = 'trdt, warehouse_id, sku_id, ttyp, qty, gross, gross_abs, cost, txns';
const WH_ROLLUP_COLS = 'trdt, warehouse_id, ttyp, category_norm, qty, gross, gross_abs, cost, txns, sku_rows';
const whRollupSelect = (src, whereExtra = '') => `
  SELECT r.trdt, r.warehouse_id, r.ttyp, s.category_norm,
         SUM(r.qty)::numeric(20,3), SUM(r.gross)::numeric(22,2), SUM(r.gross_abs)::numeric(22,2),
         SUM(r.cost)::numeric(22,2), SUM(r.txns)::bigint, COUNT(*)::int
    FROM ${src} r
    JOIN skus s ON s.id = r.sku_id
   WHERE TRUE ${whereExtra}
   GROUP BY r.trdt, r.warehouse_id, r.ttyp, s.category_norm`;
const rollupSelect = (whereExtra = '') => `
  SELECT m.trdt, m.warehouse_id, m.sku_id, m.ttyp,
         SUM(m.trqt)::numeric(20,3)                                              AS qty,
         SUM(m.trqt * COALESCE(NULLIF(m.trpr,0), s.mrp, 0))::numeric(22,2)       AS gross,
         SUM(ABS(m.trqt * COALESCE(NULLIF(m.trpr,0), s.mrp, 0)))::numeric(22,2)  AS gross_abs,
         SUM(m.trqt * COALESCE(NULLIF(m.pupr,0), s.cost_price, 0))::numeric(22,2) AS cost,
         COUNT(*)::int                                                            AS txns
    FROM primary_sales_movements m
    JOIN skus s ON s.id = m.sku_id
   WHERE m.trdt IS NOT NULL ${whereExtra}
   GROUP BY m.trdt, m.warehouse_id, m.sku_id, m.ttyp`;

// ─── Full rollup rebuild — OFF-LOCK build + millisecond swap ─────────────────
// Reserved for the one-time backfill (or an explicit `--rollup`). The heavy
// aggregation writes into side tables with NO lock on the live rollups;
// indexes are built there; then one tiny transaction renames both into place.
// The old version (TRUNCATE + INSERT inside one transaction) held an ACCESS
// EXCLUSIVE lock on the dashboard's table for the entire multi-minute sum.
// The rollups have no FKs and no dependent views, so a rename swap is safe
// here (unlike inventory_snapshot). The sku-grain heap is written in
// (trdt, …) order so every date-window scan reads contiguous pages.
async function rebuildRollup() {
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'rollup');
  const t0 = Date.now();
  const dropSide = async () => {
    for (const t of ROLLUP_TABLES) for (const sfx of ['_next', '_old']) await pg.query(`DROP TABLE IF EXISTS ${t.table}${sfx}`);
  };
  try {
    await pg.query(`SET work_mem = '1GB'`);
    await pg.query(`SET maintenance_work_mem = '1GB'`);
    await pg.query(`SET synchronous_commit = off`);
    await dropSide();
    // Same column types / NOT NULLs as the live tables, no indexes yet.
    for (const t of ROLLUP_TABLES) await pg.query(`CREATE TABLE ${t.table}_next (LIKE ${t.table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    const ins = await pg.query(`INSERT INTO primary_sales_daily_next (${ROLLUP_COLS}) ${rollupSelect('')} ORDER BY 1, 2, 3, 4`);
    logger.info(`[PRIMARY] rollup side table: ${fmtN(ins.rowCount)} sku-grain rows aggregated in ${secs(t0)}s — deriving warehouse grain…`);
    const insW = await pg.query(`INSERT INTO primary_sales_daily_wh_next (${WH_ROLLUP_COLS}) ${whRollupSelect('primary_sales_daily_next')} ORDER BY 1, 2, 3, 4`);
    for (const t of ROLLUP_TABLES) {
      for (const ix of t.indexes) await pg.query(ix.ddl(`${t.table}_next`, `${ix.name}_next`));
      // VACUUM (not just ANALYZE): sets the visibility map on the fresh heap so
      // COUNT(DISTINCT sku_id) is index-only from the first request after the
      // swap instead of after autovacuum gets round to it. Autocommit here.
      await pg.query(`VACUUM (ANALYZE) ${t.table}_next`);
    }

    // Swap. Bounded lock wait + retries so a long dashboard read never wedges
    // the ETL (and the ETL never queues readers behind it for more than 5s).
    const tries = 12;
    for (let i = 1; i <= tries; i++) {
      try {
        await pg.query('BEGIN');
        await pg.query(`SET LOCAL lock_timeout = '5s'`);
        for (const t of ROLLUP_TABLES) {
          await pg.query(`ALTER TABLE ${t.table} RENAME TO ${t.table}_old`);
          await pg.query(`ALTER TABLE ${t.table}_next RENAME TO ${t.table}`);
          for (const ix of t.indexes) await pg.query(`ALTER INDEX IF EXISTS ${ix.name} RENAME TO ${ix.name}_old`);
          for (const ix of t.indexes) await pg.query(`ALTER INDEX ${ix.name}_next RENAME TO ${ix.name}`);
          await pg.query(`DROP TABLE ${t.table}_old`);
        }
        // A full rebuild supersedes every pending incremental refresh.
        await pg.query('DELETE FROM primary_rollup_dirty');
        await pg.query('COMMIT');
        break;
      } catch (err) {
        try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
        if (i === tries || !/lock timeout|could not obtain lock/i.test(err.message)) throw err;
        logger.warn(`[PRIMARY] rollup swap blocked by a reader (attempt ${i}/${tries}) — retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    logger.info(`[PRIMARY] ✅ Rollups rebuilt + swapped: ${fmtN(ins.rowCount)} sku-grain + ${fmtN(insW.rowCount)} warehouse-grain rows in ${secs(t0)}s (readers never blocked)`);
    return ins.rowCount || 0;
  } catch (err) {
    try { await dropSide(); } catch (_) { /* ignore */ }
    logger.error(`[PRIMARY] Rollup rebuild failed: ${err.message}`);
    throw err;
  } finally {
    await resetSession(pg);
    pg.release();
  }
}

// ─── Incremental rollup — re-aggregate ONLY the given TRDT dates ─────────────
// O(rows on those dates) via idx_primary_mv_trdt. Processed in chunks of
// ROLLUP_CHUNK_DATES, each chunk ATOMIC (DELETE+INSERT+clear-dirty in one
// transaction), so a reader never sees a half-updated date and a failure
// leaves the unprocessed dates still marked dirty. Idempotent — running it on
// an already-correct date is a no-op rewrite. There is deliberately NO
// "fall back to a full rebuild if many dates" valve any more: that valve fired
// on every wide reconcile and re-summed the whole ledger.
async function rebuildRollupForDates(datesIn) {
  const dates = [...new Set((datesIn || []).map((d) => String(d)).filter((d) => DATE_RE.test(d)))].sort();
  if (dates.length === 0) return 0;
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'rollup-inc');
  const t0 = Date.now();
  let total = 0;
  try {
    await pg.query(`SET work_mem = '256MB'`);
    for (const part of chunk(dates, ROLLUP_CHUNK_DATES)) {
      try {
        await pg.query('BEGIN');
        await pg.query(`DELETE FROM primary_sales_daily WHERE trdt = ANY($1::date[])`, [part]);
        const ins = await pg.query(
          `INSERT INTO primary_sales_daily (${ROLLUP_COLS}) ${rollupSelect('AND m.trdt = ANY($1::date[])')} ORDER BY 1, 2, 3, 4`, [part]);
        await pg.query(`DELETE FROM primary_sales_daily_wh WHERE trdt = ANY($1::date[])`, [part]);
        await pg.query(
          `INSERT INTO primary_sales_daily_wh (${WH_ROLLUP_COLS}) ${whRollupSelect('primary_sales_daily', 'AND r.trdt = ANY($1::date[])')}`, [part]);
        await pg.query(`DELETE FROM primary_rollup_dirty WHERE trdt = ANY($1::date[])`, [part]);
        await pg.query('COMMIT');
        total += ins.rowCount || 0;
      } catch (err) {
        try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
      }
    }
    logger.info(`[PRIMARY] ✅ Rollup refreshed for ${dates.length} date(s) (${dates[0]} → ${dates[dates.length - 1]}): ${fmtN(total)} rows in ${secs(t0)}s`);
    return total;
  } catch (err) {
    logger.error(`[PRIMARY] Incremental rollup failed: ${err.message}`);
    throw err;
  } finally {
    await resetSession(pg);
    pg.release();
  }
}

// Drain primary_rollup_dirty: refresh every date any merge has marked stale —
// this batch's AND any left over from an earlier failed refresh.
async function refreshRollupFromDirty() {
  const r = await query('SELECT trdt::text AS d FROM primary_rollup_dirty ORDER BY trdt');
  if (!r.rows.length) return 0;
  return rebuildRollupForDates(r.rows.map((x) => x.d));
}

// ─── Preflight ────────────────────────────────────────────────────────────────
async function preflight(erpPool) {
  const cfg = m3Config();
  const where = `${cfg.server}:${cfg.port} (catalog: ${cfg.database || '(default)'})`;
  try {
    await erpPool.request().query(`SELECT TOP 1 1 FROM M3ReportdataPRD.dbo.MITWHL D WHERE D.CONO=92 AND D.DIVI='AAA'`);
    await erpPool.request().query(`SELECT TOP 1 1 FROM M3ReportdataPRD.dbo.MITMAS`);
    await erpPool.request().query(`SELECT TOP 1 1 FROM M3ReportdataPRD.dbo.MITTRA`);
    logger.info(`[PRIMARY] Preflight OK — M3ReportdataPRD reachable on ${where}`);
  } catch (err) {
    const m = String(err.message || err);
    let hint;
    if (/Invalid object name/i.test(m)) hint = `M3ReportdataPRD not on ${cfg.server}; set M3_HOST/M3_DATABASE/M3_USER/M3_PASSWORD.`;
    else if (/Login failed/i.test(m)) hint = `Login rejected for ${where}. Check M3_USER/M3_PASSWORD + catalog access.`;
    else if (/permission|denied/i.test(m)) hint = `Connected but missing SELECT on MITWHL/MITMAS/MITTRA — grant read.`;
    else if (/getaddrinfo|ETIMEOUT|ECONNREFUSED|failed to connect/i.test(m)) hint = `Cannot reach ${cfg.server}:${cfg.port} — check host/port/firewall.`;
    else hint = `Verify M3_HOST/M3_PORT/M3_DATABASE/M3_USER/M3_PASSWORD in .env.`;
    const e = new Error(`[PRIMARY] M3 preflight failed: ${m}\n   → ${hint}`);
    e.preflight = true;
    throw e;
  }
}

// ─── Staged merge: M3 → TEMP → UPSERT on the real MITTRA key ─────────────────
// Used by delta, reconcile, smoke tests and window re-loads — i.e. whenever the
// ledger already has rows. Idempotent + dedup by construction. In ONE
// transaction: the upsert, and marking every affected TRDT (the batch's dates
// PLUS the OLD date of any existing row whose trdt is being moved — without
// that, the old day's rollup kept a phantom row) in primary_rollup_dirty.
// Re-pulled rows that changed nothing are skipped by the UPDATE's WHERE, so
// `merged` = rows that actually changed and no dirty date is marked for a
// pure overlap no-op batch.
// The merge step alone (tmp_primary must exist on `pg`). Split out so it can be
// exercised against a hand-built staging table without an M3 connection.
async function mergeStaged(pg) {
  await pg.query('ANALYZE tmp_primary');
  const keyTuple = (alias) => `(${KEY_COLS.map((c) => `${alias}.${c}`).join(', ')})`;
  await pg.query('BEGIN');
  try {
    const moved = await pg.query(`
      SELECT DISTINCT m.trdt::text AS d
        FROM primary_sales_movements m
        JOIN tmp_primary t ON ${keyTuple('m')} = ${keyTuple('t')}
       WHERE m.trdt IS NOT NULL AND m.trdt IS DISTINCT FROM t.trdt`);
    const setList = NON_KEY_UPDATE_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const tgtTuple = `(${NON_KEY_UPDATE_COLS.map((c) => `primary_sales_movements.${c}`).join(', ')})`;
    const excTuple = `(${NON_KEY_UPDATE_COLS.map((c) => `EXCLUDED.${c}`).join(', ')})`;
    const merge = await pg.query(`
      INSERT INTO primary_sales_movements (${COPY_COLS.join(', ')}, synced_at)
      SELECT DISTINCT ON (${KEY_LIST}) ${COPY_COLS.join(', ')}, NOW()
        FROM tmp_primary
       ORDER BY ${KEY_LIST}, lmts DESC NULLS LAST
      ON CONFLICT (${KEY_LIST}) DO UPDATE SET ${setList}, synced_at = NOW()
      WHERE ${tgtTuple} IS DISTINCT FROM ${excTuple}`);
    const merged = merge.rowCount || 0;
    const dRes = await pg.query('SELECT DISTINCT trdt::text AS d FROM tmp_primary WHERE trdt IS NOT NULL');
    const dates = [...new Set([...dRes.rows, ...moved.rows].map((r) => r.d))].sort();
    if (merged > 0 && dates.length) {
      await pg.query(`INSERT INTO primary_rollup_dirty (trdt) SELECT unnest($1::date[]) ON CONFLICT (trdt) DO NOTHING`, [dates]);
    }
    await pg.query('COMMIT');
    return { merged, dates: merged > 0 ? dates : [] };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

async function pullMerge(pg, erpPool, maps, sqlText, label, misses) {
  await pg.query('DROP TABLE IF EXISTS tmp_primary');
  await pg.query('CREATE TEMP TABLE tmp_primary (LIKE stg_primary_sales)');
  try {
    const out = await streamInto(pg, erpPool, maps, sqlText, 'tmp_primary', label, misses);
    if (out.streamed === 0) return { merged: 0, streamed: 0, maxLmts: null, dates: [] };
    const m = await mergeStaged(pg);
    return { merged: m.merged, streamed: out.streamed, maxLmts: out.maxLmts, dates: m.dates };
  } finally {
    try { await pg.query('DROP TABLE IF EXISTS tmp_primary'); } catch (_) { /* ignore */ }
  }
}

// ─── Backfill progress (per WHLO, per scope) ─────────────────────────────────
async function loadProgress(pg, scope) {
  const r = await pg.query('SELECT whlo, status, rows_loaded, max_lmts FROM primary_backfill_progress WHERE scope = $1', [scope]);
  return new Map(r.rows.map((x) => [x.whlo, x]));
}
async function setProgress(pg, scope, whlo, status, rows = 0, maxLmts = null) {
  await pg.query(`
    INSERT INTO primary_backfill_progress (scope, whlo, status, rows_loaded, max_lmts, started_at, finished_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), CASE WHEN $3 = 'done' THEN NOW() END)
    ON CONFLICT (scope, whlo) DO UPDATE SET
      status = EXCLUDED.status, rows_loaded = EXCLUDED.rows_loaded, max_lmts = EXCLUDED.max_lmts,
      started_at = CASE WHEN EXCLUDED.status = 'running' THEN NOW() ELSE primary_backfill_progress.started_at END,
      finished_at = EXCLUDED.finished_at
  `, [scope, whlo, status, rows, maxLmts]);
}

// Build the ledger indexes concurrently (one client each) after a bulk load.
async function buildLedgerIndexes() {
  const t0 = Date.now();
  const results = await Promise.allSettled(LEDGER_INDEXES.map(async (ix) => {
    const c = await pgPool.connect();
    guardClientErrors(c, `idx:${ix.name}`);
    try {
      await c.query(`SET maintenance_work_mem = '768MB'`);
      await c.query(`SET synchronous_commit = off`);
      await c.query(ix.ddl);
      return ix.name;
    } finally {
      await resetSession(c);
      c.release();
    }
  }));
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) logger.error(`[PRIMARY] index build failed: ${f.reason?.message}`);
  if (failed.length) throw new Error(`${failed.length}/${LEDGER_INDEXES.length} ledger indexes failed to build`);
  logger.info(`[PRIMARY] ✓ Ledger indexes built in ${secs(t0)}s`);
}

// ─── Public: warehouses ───────────────────────────────────────────────────────
async function runWarehouses() {
  const erpPool = await connectM3();
  try { await preflight(erpPool); return await upsertWarehouses(erpPool); }
  finally { try { await erpPool.close(); } catch (_) { /* ignore */ } }
}

// ─── Public: backfill — chunked by WHLO, resumable, index-light ──────────────
// Modes (chosen from the table's state, never guessed):
//   smoke        --limit=N          TOP N via staged upsert; safe on any table state.
//   bulk         empty table        drop indexes → COPY per WHLO → rebuild → full rollup.
//   bulk-resume  progress rows      skip finished WHLOs, redo the interrupted one.
//   merge        --from/--to on a   staged UPSERT per WHLO (indexes stay live);
//                populated ledger   rollup refreshed incrementally for the window.
//   refuse       populated ledger, unbounded, no progress → tell the operator
//                exactly which flag they want (never silently duplicate rows).
async function runBackfill({ from = null, to = null, limit = null, truncate = false } = {}) {
  if (from || to) {
    if (!(from && to)) throw new Error('[PRIMARY] --from and --to must be given together');
    assertDate(from, '--from'); assertDate(to, '--to');
    if (from > to) throw new Error('[PRIMARY] --from must be <= --to');
  }
  const erpPool = await connectM3();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'backfill');
  const misses = newMissTracker();
  const t0 = Date.now();
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();
    if (maps.warehouseMap.size === 0) throw new Error('No warehouses resolved — MITWHL load failed.');

    const dateWhere = from && to ? ` AND A.TRDT BETWEEN '${from}' AND '${to}'` : '';
    const scope = from && to ? `${from}..${to}` : 'FULL';

    // ── smoke test ──────────────────────────────────────────────────────────
    if (limit) {
      const n = parseInt(limit, 10);
      if (!(n > 0)) throw new Error('[PRIMARY] --limit must be a positive integer');
      logger.info(`[PRIMARY] SMOKE: TOP ${n} via staged upsert ${scope === 'FULL' ? '' : `(TRDT ${scope})`}`);
      const out = await pullMerge(pg, erpPool, maps, selectSql(dateWhere, n), `smoke TOP ${n}`, misses);
      await recordUnmapped(misses, 'backfill-smoke');
      // Deliberately NO high-water advance: a smoke test on an empty ledger must
      // not make a later --delta believe history is already loaded.
      const rolled = await refreshRollupFromDirty();
      logger.info(`[PRIMARY] ✅ SMOKE done: streamed ${fmtN(out.streamed)}, merged ${fmtN(out.merged)}, misses ${fmtN(misses.total)}, rollup rows ${fmtN(rolled)}`);
      return { mode: 'smoke', streamed: out.streamed, merged: out.merged, miss: misses.total, maxLmts: out.maxLmts, seconds: Number(secs(t0)) };
    }

    if (truncate) {
      await pg.query('TRUNCATE primary_sales_movements');
      await pg.query('TRUNCATE primary_backfill_progress, primary_rollup_dirty, primary_reconcile_state, primary_unmapped_items');
      await pg.query('DELETE FROM primary_sync_state WHERE feed = $1', [FEED]);
      logger.info('[PRIMARY] Truncated ledger + feed state (fresh load). The rollup stays live until the new one swaps in.');
    }
    const existing = (await pg.query('SELECT EXISTS (SELECT 1 FROM primary_sales_movements) AS e')).rows[0].e === true;
    const progress = await loadProgress(pg, scope);
    let mode;
    if (!existing) mode = 'bulk';
    else if (progress.size > 0) mode = 'bulk-resume';
    else if (from && to) mode = 'merge';
    else {
      throw new Error('[PRIMARY] primary_sales_movements already has rows and there is no resumable backfill in progress. ' +
        'Use --truncate for a fresh full load, --from/--to to (re)load a window via upsert, or --reconcile to heal gaps. ' +
        'Refusing to bulk-COPY into a populated ledger (it would create duplicates).');
    }
    logger.info(`[PRIMARY] BACKFILL mode=${mode} scope=${scope} warehouses=${maps.whlos.length}`);

    // ── merge mode: window re-load through the upsert, indexes live ─────────
    if (mode === 'merge') {
      let streamed = 0, merged = 0, maxLmts = null, i = 0;
      for (const whlo of maps.whlos) {
        i++;
        const out = await pullMerge(pg, erpPool, maps, selectSql(` AND A.WHLO = '${sqlStr(whlo)}'${dateWhere}`), `merge ${whlo}`, misses);
        streamed += out.streamed; merged += out.merged;
        if (out.maxLmts && (!maxLmts || out.maxLmts > maxLmts)) maxLmts = out.maxLmts;
        if (out.streamed) logger.info(`[PRIMARY] merge ${i}/${maps.whlos.length} WHLO ${whlo}: streamed ${fmtN(out.streamed)}, changed ${fmtN(out.merged)} (${secs(t0)}s elapsed)`);
      }
      await recordUnmapped(misses, `backfill-merge ${scope}`);
      await advanceHighWater(maxLmts, merged);
      const rolled = await refreshRollupFromDirty();
      logger.info(`[PRIMARY] ✅ WINDOW RELOAD done: streamed ${fmtN(streamed)}, changed ${fmtN(merged)}, misses ${fmtN(misses.total)}, rollup rows ${fmtN(rolled)}, ${secs(t0)}s`);
      return { mode, streamed, merged, miss: misses.total, maxLmts, seconds: Number(secs(t0)) };
    }

    // ── bulk / bulk-resume: index-light COPY, one WHLO at a time ────────────
    logger.info('[PRIMARY] Dropping ledger indexes for the bulk load…');
    for (const ix of LEDGER_INDEXES) await pg.query(`DROP INDEX IF EXISTS ${ix.name}`);
    await pg.query(`SET synchronous_commit = off`);

    let streamed = 0, maxLmts = null, done = 0, skipped = 0;
    for (const whlo of maps.whlos) {
      const p = progress.get(whlo);
      if (p && p.status === 'done') {
        streamed += Number(p.rows_loaded || 0);
        if (p.max_lmts && (!maxLmts || p.max_lmts > maxLmts)) maxLmts = p.max_lmts;
        done++; skipped++;
        continue;
      }
      if (p && p.status === 'running') {
        // Interrupted mid-stream. COPY is atomic per statement, so a dropped
        // connection normally leaves nothing behind — but with no unique index
        // live we do not gamble: wipe anything from the chunk before re-streaming
        // (a one-off seq scan, resume-only cost).
        const params = [whlo]; let where = 'whlo = $1';
        if (from && to) { params.push(from, to); where += ' AND trdt BETWEEN $2::date AND $3::date'; }
        const del = await pg.query(`DELETE FROM primary_sales_movements WHERE ${where}`, params);
        logger.warn(`[PRIMARY] Resuming WHLO ${whlo}: removed ${fmtN(del.rowCount)} partial rows from the interrupted chunk`);
      }
      await setProgress(pg, scope, whlo, 'running');
      const tc = Date.now();
      // Per-chunk miss tracker, persisted with the chunk: a crash later in the
      // run must not lose the tallies of the chunks that did finish.
      const chunkMisses = newMissTracker();
      const out = await streamInto(pg, erpPool, maps, selectSql(` AND A.WHLO = '${sqlStr(whlo)}'${dateWhere}`),
        'primary_sales_movements', `backfill ${whlo}`, chunkMisses);
      await setProgress(pg, scope, whlo, 'done', out.streamed, out.maxLmts);
      await recordUnmapped(chunkMisses, `backfill ${scope} ${whlo}`);
      misses.total += chunkMisses.total;
      streamed += out.streamed;
      if (out.maxLmts && (!maxLmts || out.maxLmts > maxLmts)) maxLmts = out.maxLmts;
      done++;
      logger.info(`[PRIMARY] backfill ${done}/${maps.whlos.length} WHLO ${whlo}: ${fmtN(out.streamed)} rows in ${secs(tc)}s · total ${fmtN(streamed)} · ${secs(t0)}s elapsed`);
    }
    if (skipped) logger.info(`[PRIMARY] resumed: ${skipped} WHLO chunk(s) were already complete and were not re-streamed`);

    logger.info(`[PRIMARY] Loaded ${fmtN(streamed)} rows (${fmtN(misses.total)} unmappable this run). Building indexes…`);
    await buildLedgerIndexes();
    await pg.query('ANALYZE primary_sales_movements');
    await advanceHighWater(maxLmts, streamed);
    logger.info('[PRIMARY] Rebuilding rollup (off-lock, swapped in when ready)…');
    await rebuildRollup();
    logger.info(`[PRIMARY] ✅ BACKFILL done: ${fmtN(streamed)} rows, ${fmtN(misses.total)} unmappable, ${secs(t0)}s, high-water=${maxLmts ? maxLmts.toISOString() : 'n/a'}`);
    return { mode, streamed, merged: streamed, miss: misses.total, maxLmts, seconds: Number(secs(t0)) };
  } finally {
    await resetSession(pg);
    pg.release();
    try { await erpPool.close(); } catch (_) { /* ignore */ }
  }
}

// ─── Public: reconcile — the deterministic self-heal / audit ─────────────────
// Count-matches M3 vs Postgres per TRDT day over [from,to] and re-pulls the
// days where source > target. Fixes vs the previous version:
//   • Default window = the last PRIMARY_RECONCILE_DAYS (45) days, not the whole
//     multi-year span (TRDT is unindexed on M3: the count query is one full
//     pass whatever the window, but the re-pulls scale with short days).
//   • Days that are short ONLY because of unmappable ITNOs are remembered in
//     primary_reconcile_state and skipped while their source count is unchanged
//     — they used to be re-pulled on every run, forever, one M3 pass each.
//   • Short days are re-pulled in batches of RECONCILE_BATCH_DATES per M3 pass
//     instead of one pass per day.
//   • Rollup refresh via the dirty table (covers amended rows, not just new ones).
//   • The high-water is NOT advanced here: a re-pulled day may carry an LMTS
//     newer than rows on other days the delta hasn't seen yet.
async function reconcile({ from = null, to = null } = {}) {
  const t0 = Date.now();
  if (!from || !to) {
    const days = Math.max(1, parseInt(process.env.PRIMARY_RECONCILE_DAYS, 10) || 45);
    const r = (await query(`SELECT (CURRENT_DATE - $1::int)::text AS lo, CURRENT_DATE::text AS hi`, [days])).rows[0];
    from = from || r.lo; to = to || r.hi;
  }
  assertDate(from, 'from'); assertDate(to, 'to');
  if (from > to) throw new Error('[PRIMARY] reconcile: from must be <= to');

  const erpPool = await connectM3();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'reconcile');
  const misses = newMissTracker();
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();
    logger.info(`[PRIMARY] RECONCILE window ${from} → ${to}`);

    // Source per-day counts (one M3 pass).
    const srcRows = (await erpPool.request().query(`
      SELECT CONVERT(varchar(10), A.TRDT, 120) AS d, COUNT_BIG(*) AS c
      ${BASE_JOIN}
      ${BASE_WHERE} AND A.TRDT BETWEEN '${from}' AND '${to}'
      GROUP BY CONVERT(varchar(10), A.TRDT, 120)`)).recordset;
    // Target per-day counts + what we knew last time.
    const tgt = new Map((await pg.query(
      `SELECT trdt::text AS d, count(*)::bigint AS c FROM primary_sales_movements WHERE trdt BETWEEN $1::date AND $2::date GROUP BY trdt`,
      [from, to])).rows.map((r) => [r.d, Number(r.c)]));
    const prev = new Map((await pg.query(
      `SELECT trdt::text AS d, src_count, tgt_count FROM primary_reconcile_state WHERE trdt BETWEEN $1::date AND $2::date`,
      [from, to])).rows.map((r) => [r.d, { src: Number(r.src_count), tgt: Number(r.tgt_count) }]));

    const short = [];           // days to re-pull
    let knownResidual = 0, knownDays = 0, equalDays = 0;
    const stateRows = [];       // [d, src, tgt] to remember
    for (const r of srcRows) {
      const d = String(r.d); if (!DATE_RE.test(d)) continue;
      const src = Number(r.c), pgc = tgt.get(d) || 0;
      if (src <= pgc) { equalDays++; stateRows.push([d, src, pgc]); continue; }
      const k = prev.get(d);
      if (k && k.src === src && k.tgt === pgc) {
        // Same shortfall as last time we healed it → unmappable residue. Skip.
        knownDays++; knownResidual += src - pgc; stateRows.push([d, src, pgc]); continue;
      }
      short.push({ d, src, pg: pgc });
    }
    short.sort((a, b) => (b.src - b.pg) - (a.src - a.pg));
    logger.info(`[PRIMARY] RECONCILE: ${srcRows.length} source days · ${equalDays} in sync · ${knownDays} known-residual (skipped, ≈${fmtN(knownResidual)} unmappable rows) · ${short.length} to re-pull`);

    let repulled = 0, changed = 0;
    // Batched re-pulls: one M3 pass per RECONCILE_BATCH_DATES days.
    for (const batch of chunk(short.map((s) => s.d).sort(), RECONCILE_BATCH_DATES)) {
      const inList = batch.map((d) => `'${d}'`).join(',');
      const out = await pullMerge(pg, erpPool, maps, selectSql(` AND A.TRDT IN (${inList})`),
        `reconcile ${batch[0]}..${batch[batch.length - 1]}`, misses);
      repulled += out.streamed; changed += out.merged;
      logger.info(`[PRIMARY] RECONCILE batch ${batch[0]}..${batch[batch.length - 1]} (${batch.length} days): streamed ${fmtN(out.streamed)}, changed ${fmtN(out.merged)}`);
    }

    // Re-count the healed days, remember every checked day.
    let healed = 0, residual = 0;
    if (short.length) {
      const after = new Map((await pg.query(
        `SELECT trdt::text AS d, count(*)::bigint AS c FROM primary_sales_movements WHERE trdt = ANY($1::date[]) GROUP BY trdt`,
        [short.map((s) => s.d)])).rows.map((r) => [r.d, Number(r.c)]));
      for (const s of short) {
        const now = after.get(s.d) || 0;
        healed += now - s.pg;
        residual += Math.max(0, s.src - now);
        stateRows.push([s.d, s.src, now]);
      }
    }
    for (const part of chunk(stateRows, 5000)) {
      await pg.query(`
        INSERT INTO primary_reconcile_state (trdt, src_count, tgt_count, checked_at)
        SELECT d, s, t, NOW() FROM unnest($1::date[], $2::bigint[], $3::bigint[]) AS u(d, s, t)
        ON CONFLICT (trdt) DO UPDATE SET src_count = EXCLUDED.src_count, tgt_count = EXCLUDED.tgt_count, checked_at = NOW()
      `, [part.map((x) => x[0]), part.map((x) => x[1]), part.map((x) => x[2])]);
    }
    await recordUnmapped(misses, `reconcile ${from}..${to}`);
    const rolled = await refreshRollupFromDirty();
    logger.info(`[PRIMARY] ✅ RECONCILE done in ${secs(t0)}s: re-pulled ${short.length} day(s) / ${fmtN(repulled)} rows, changed ${fmtN(changed)}, healed +${fmtN(healed)}, ` +
      `new unmappable residual ≈ ${fmtN(residual)} (+${fmtN(knownResidual)} known), rollup rows ${fmtN(rolled)}`);
    return { window: [from, to], checkedDays: srcRows.length, shortDays: short.length, knownDays, healed, changed, residual, knownResidual, seconds: Number(secs(t0)) };
  } finally {
    pg.release();
    try { await erpPool.close(); } catch (_) { /* ignore */ }
  }
}

// ─── Public: remap — heal rows that became mappable after a SKU-master change ─
// Rows skipped as unmappable are never seen again by the LMTS delta (their LMTS
// did not move) and the reconcile deliberately remembers such days as "known
// residual". So when the SKU master gains an item code, the ONLY way its
// history gets in is this: pull exactly those item codes from M3 (a seek on
// MITTRA's clustered key (CONO, WHLO, ITNO, …) — both lists are given), upsert,
// forget them in primary_unmapped_items, and let the dirty-date mechanism
// refresh the rollups. Never advances the high-water. Cheap no-op when nothing
// became mappable, so the sync runs it every time.
async function remap({ batchSize = 150 } = {}) {
  const t0 = Date.now();
  const cands = (await query(`
    SELECT u.itno FROM primary_unmapped_items u
     WHERE u.itno NOT LIKE 'WH:%'
       AND EXISTS (SELECT 1 FROM skus s
                    WHERE upper(s.infor_item_code) = upper(u.itno)
                       OR upper(s.style_variant)   = upper(u.itno)
                       OR upper(s.external_id)     = upper(u.itno))
     ORDER BY u.itno`)).rows.map((r) => r.itno);
  if (!cands.length) { logger.info('[PRIMARY] REMAP: no previously-unmappable item is mappable now — nothing to heal'); return { items: 0, streamed: 0, merged: 0, dates: 0, seconds: 0 }; }
  logger.info(`[PRIMARY] REMAP: ${cands.length} item code(s) became mappable — pulling their history from M3…`);

  const erpPool = await connectM3();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'remap');
  const misses = newMissTracker();
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();
    const whList = maps.whlos.map((w) => `'${sqlStr(w)}'`).join(',');
    let streamed = 0, merged = 0; const dates = new Set();
    for (const batch of chunk(cands, batchSize)) {
      const inList = batch.map((i) => `'${sqlStr(i)}'`).join(',');
      const out = await pullMerge(pg, erpPool, maps, selectSql(` AND A.WHLO IN (${whList}) AND A.ITNO IN (${inList})`), `remap ${batch.length} items`, misses);
      streamed += out.streamed; merged += out.merged; out.dates.forEach((d) => dates.add(d));
      await pg.query(`DELETE FROM primary_unmapped_items WHERE itno = ANY($1::text[])`, [batch]);
      // Those days' remembered shortfall is stale now → let the next reconcile re-evaluate them.
      if (out.dates.length) await pg.query(`DELETE FROM primary_reconcile_state WHERE trdt = ANY($1::date[])`, [out.dates]);
      logger.info(`[PRIMARY] REMAP batch: ${batch.length} items → streamed ${fmtN(out.streamed)}, loaded ${fmtN(out.merged)} (${secs(t0)}s elapsed)`);
    }
    await recordUnmapped(misses, 'remap');
    const rolled = await refreshRollupFromDirty();
    logger.info(`[PRIMARY] ✅ REMAP done in ${secs(t0)}s: ${cands.length} items, loaded ${fmtN(merged)} rows over ${dates.size} date(s), rollup rows ${fmtN(rolled)}`);
    return { items: cands.length, streamed, merged, dates: dates.size, seconds: Number(secs(t0)) };
  } finally {
    pg.release();
    try { await erpPool.close(); } catch (_) { /* ignore */ }
  }
}

// ─── Public: delta — LMTS datetime2 high-water incremental ───────────────────
async function runDelta({ force = false } = {}) {
  // Bootstrap guard BEFORE touching M3: with no high-water there is nothing to
  // be incremental about. `--force` used to stream all ~110M rows through a
  // TEMP table + row-by-row upsert; now it delegates to the chunked, resumable
  // bulk backfill, which is the only sane way to load the full ledger.
  const lastLmts = await getHighWater();
  if (!lastLmts) {
    if (!force) {
      logger.warn('[PRIMARY] DELTA skipped — no high-water yet (no backfill). Run `npm run primary:backfill` first, ' +
        'or bootstrap with `node src/database/load_primary_sales.js --delta --force`.');
      return { merged: 0, streamed: 0, miss: 0, maxLmts: null, skipped: true };
    }
    const existing = (await query('SELECT EXISTS (SELECT 1 FROM primary_sales_movements) AS e')).rows[0].e === true;
    if (existing) {
      throw new Error('[PRIMARY] no high-water mark but the ledger already has rows — run `--backfill --truncate` for a clean load, ' +
        'or `--reconcile --from --to` to heal the loaded window (which does not need a high-water).');
    }
    logger.warn('[PRIMARY] DELTA --force with an empty ledger → delegating to the chunked, resumable BACKFILL.');
    const r = await runBackfill({});
    return { merged: r.streamed, streamed: r.streamed, miss: r.miss, maxLmts: r.maxLmts, bootstrapped: true };
  }

  const erpPool = await connectM3();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'delta');
  const misses = newMissTracker();
  const t0 = Date.now();
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();
    if (maps.warehouseMap.size === 0) throw new Error('No warehouses resolved — MITWHL load failed.');

    // LOSSLESS OVERLAP: re-pull rows whose LMTS is within an overlap window
    // BELOW the high-water, not just strictly above it. This covers clock skew /
    // commit-lag on the M3 side. The unique-key UPSERT collapses re-pulls to
    // no-ops (and the UPDATE's WHERE skips unchanged rows entirely), so Postgres
    // NEVER holds a duplicate. Tune with PRIMARY_DELTA_OVERLAP_SECONDS (1h).
    const overlapSec = parseInt(process.env.PRIMARY_DELTA_OVERLAP_SECONDS) || 3600;
    const lowerBound = new Date(lastLmts.getTime() - overlapSec * 1000);
    logger.info(`[PRIMARY] DELTA pulling MITTRA WHERE LMTS > ${lowerBound.toISOString()} (high-water ${lastLmts.toISOString()}, overlap ${overlapSec}s)`);

    const out = await pullMerge(pg, erpPool, maps, selectSql(` AND A.LMTS > '${sqlDatetimeLiteral(lowerBound)}'`), 'delta', misses);
    await recordUnmapped(misses, 'delta');
    // The ledger merge + dirty marks are durable; advance the mark now. The
    // rollup refresh below drains this batch AND any leftovers from a run that
    // failed after its merge — nothing depends on this run finishing cleanly.
    if (out.maxLmts) await advanceHighWater(out.maxLmts, out.merged);
    const rolled = await refreshRollupFromDirty();
    logger.info(`[PRIMARY] ✅ DELTA: streamed ${fmtN(out.streamed)}, changed ${fmtN(out.merged)} over ${out.dates.length} date(s), ${fmtN(misses.total)} unmappable, rollup rows ${fmtN(rolled)}, ${secs(t0)}s`);
    return { merged: out.merged, streamed: out.streamed, miss: misses.total, maxLmts: out.maxLmts, dates: out.dates };
  } finally {
    pg.release();
    try { await erpPool.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  runWarehouses, runBackfill, runDelta, reconcile, remap,
  rebuildRollup, rebuildRollupForDates, refreshRollupFromDirty,
  buildLookupMaps, FEED,
  _internal: {   // for the offline verification harness (no M3)
    mergeStaged, rollupSelect, whRollupSelect, selectSql,
    setM3Connect(fn) { connectM3 = fn || m3Connect; },
  },
};
