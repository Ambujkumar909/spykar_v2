/**
 * primarySales.js  —  Primary sales (MITTRA) ETL engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared engine for the primary-sales feed. Used by BOTH the CLI wrapper
 * (src/database/load_primary_sales.js) and the syncEngine daily-delta stage.
 *
 * Source : Infor M3 reporting DB M3ReportdataPRD (SQL Server @ M3_HOST)
 *            MITTRA A ⋈ MITMAS B (CONO,ITNO) ⋈ MITWHL D (CONO,WHLO)
 *            WHERE A.CONO=92 AND B.STCD=1 AND D.DIVI='AAA'
 * Target : PostgreSQL  primary_warehouses + primary_sales_movements
 * SKU map: MITTRA.ITNO → skus.infor_item_code / style_variant / external_id
 *
 * DATA SHAPE (confirmed via Phase 0 against the live server — see migration 016):
 *   • TRDT, RGDT      → DATE          (mssql returns JS Date; format YYYY-MM-DD)
 *   • RGTM, TMSX, TTYP→ INT
 *   • LMTS            → DATETIME2      (the delta high-water; NOT a bigint)
 *   • REAL PK / dedup key = (CONO,WHLO,ITNO,RGDT,RGTM,TMSX)  — REPN is NOT unique
 *   • Full filtered size ≈ 110M rows → backfill is ONE ordered streaming pass
 *     (not date windows — TRDT is unindexed, so windows would re-scan the table).
 */

'use strict';

const sql      = require('mssql');
const copyFrom = require('pg-copy-streams').from;
const { pool: pgPool, query } = require('../config/database');
const logger   = require('../config/logger');

const FEED = 'mittra_primary_sales';

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

// Canonical destination column order — used by every COPY + INSERT.
const COPY_COLS = [
  'warehouse_id', 'sku_id', 'cono', 'whlo', 'itno', 'trdt', 'rgdt', 'rgtm', 'tmsx',
  'nstt', 'ttyp', 'trtp', 'whsl', 'trpr', 'pupr', 'trqt', 'repn', 'stas', 'lmts',
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

// DATETIME2 column → ISO for a PG timestamptz. Returns a JS Date | null so we can
// also track the max LMTS for the high-water mark.
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

function guardClientErrors(client, label) {
  client.on('error', (err) => logger.error(`[PRIMARY:${label}] client error: ${err.message}`));
}

// ─── Lookup maps ──────────────────────────────────────────────────────────────
async function buildLookupMaps() {
  const [skuRows, whRows] = await Promise.all([
    query(`SELECT id, external_id, style_variant, infor_item_code FROM skus WHERE is_active = true`),
    query(`SELECT id, whlo FROM primary_warehouses WHERE is_active = true`),
  ]);
  const skuByItno = new Map();
  const warehouseMap = new Map();
  for (const r of skuRows.rows) {
    for (const key of [r.infor_item_code, r.style_variant, r.external_id]) {
      if (key) { const k = String(key).toUpperCase().trim(); if (!skuByItno.has(k)) skuByItno.set(k, r.id); }
    }
  }
  for (const r of whRows.rows) if (r.whlo) warehouseMap.set(String(r.whlo).trim(), r.id);
  logger.info(`[PRIMARY] Lookup maps: ${warehouseMap.size} warehouses, ${skuByItno.size} item keys`);
  return { skuByItno, warehouseMap };
}

// Resolve one MITTRA row → CSV field values in COPY_COLS order, or null to skip.
// Also returns the row's LMTS Date so the caller can track the high-water.
function resolveRow(row, maps) {
  const whlo = String(col(row, 'WHLO') || '').trim();
  const itno = String(col(row, 'ITNO') || '').trim();
  const warehouseId = maps.warehouseMap.get(whlo);
  const skuId = maps.skuByItno.get(itno.toUpperCase());
  if (!warehouseId || !skuId) return null; // lookup miss — caller counts it

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
// Streams `SELECT … whereExtra` from M3 straight into a Postgres COPY target and
// returns row/miss counts + the max LMTS seen. `copyTarget` is the table the COPY
// writes to (the live table for backfill, a TEMP table for delta).
async function streamInto(pg, erpPool, maps, whereExtra, copyTarget, label) {
  let streamed = 0, miss = 0, maxLmts = null;

  const copyStream = pg.query(copyFrom(
    `COPY ${copyTarget} (${COPY_COLS.join(', ')}) FROM STDIN WITH (FORMAT csv)`
  ));
  const request = erpPool.request();
  request.stream = true;

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      request.removeAllListeners(); copyStream.removeAllListeners();
      try { copyStream.destroy(err); } catch (_) {}
      reject(err);
    };
    request.on('row', (row) => {
      const r = resolveRow(row, maps);
      if (!r) { miss++; return; }
      streamed++;
      if (r.lmts && (!maxLmts || r.lmts > maxLmts)) maxLmts = r.lmts;
      const line = r.fields.map(csvEscape).join(',') + '\n';
      if (!copyStream.write(line)) { request.pause(); copyStream.once('drain', () => request.resume()); }
      if (streamed % 250000 === 0) logger.info(`[PRIMARY] [${label}] streamed ${streamed.toLocaleString()}…`);
    });
    request.on('error', onError);
    copyStream.on('error', onError);
    request.on('done', () => copyStream.end());
    copyStream.on('finish', resolve);
    request.query(`SELECT ${SELECT_COLS} ${BASE_JOIN} ${BASE_WHERE} ${whereExtra}`);
  });

  return { streamed, miss, maxLmts };
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

// ─── Rollup rebuild — the dashboard's speed layer ────────────────────────────
// Aggregates primary_sales_movements → primary_sales_daily at grain
// (trdt, warehouse_id, sku_id, ttyp). Prices are resolved once here (trpr→mrp
// fallback, pupr→cost_price fallback) so the controller never joins the raw
// ledger. Full rebuild in one transaction (swap) — ~3.6M rows for the FY, fast.
async function rebuildRollup() {
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'rollup');
  const t0 = Date.now();
  try {
    await pg.query(`SET work_mem = '1GB'`);
    await pg.query('BEGIN');
    await pg.query('DROP TABLE IF EXISTS primary_sales_daily_next');
    await pg.query(`
      CREATE UNLOGGED TABLE primary_sales_daily_next AS
      SELECT m.trdt, m.warehouse_id, m.sku_id, m.ttyp,
             SUM(m.trqt)::numeric(20,3)                                              AS qty,
             SUM(m.trqt * COALESCE(NULLIF(m.trpr,0), s.mrp, 0))::numeric(22,2)       AS gross,
             SUM(ABS(m.trqt * COALESCE(NULLIF(m.trpr,0), s.mrp, 0)))::numeric(22,2)  AS gross_abs,
             SUM(m.trqt * COALESCE(NULLIF(m.pupr,0), s.cost_price, 0))::numeric(22,2) AS cost,
             COUNT(*)::int                                                            AS txns
      FROM primary_sales_movements m
      JOIN skus s ON s.id = m.sku_id
      GROUP BY m.trdt, m.warehouse_id, m.sku_id, m.ttyp
    `);
    await pg.query('TRUNCATE primary_sales_daily');
    const ins = await pg.query(`INSERT INTO primary_sales_daily SELECT * FROM primary_sales_daily_next`);
    await pg.query('DROP TABLE IF EXISTS primary_sales_daily_next');
    await pg.query('COMMIT');
    await pg.query('ANALYZE primary_sales_daily');
    logger.info(`[PRIMARY] ✅ Rollup rebuilt: ${(ins.rowCount || 0).toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return ins.rowCount || 0;
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    logger.error(`[PRIMARY] Rollup rebuild failed: ${err.message}`);
    throw err;
  } finally {
    try { await pg.query('RESET work_mem'); } catch (_) {}
    pg.release();
  }
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

const SECONDARY_INDEXES = [
  { name: 'idx_primary_mv_warehouse_date', ddl: `CREATE INDEX idx_primary_mv_warehouse_date ON primary_sales_movements(warehouse_id, trdt DESC)` },
  { name: 'idx_primary_mv_sku_date',       ddl: `CREATE INDEX idx_primary_mv_sku_date       ON primary_sales_movements(sku_id, trdt DESC)` },
  { name: 'idx_primary_mv_type_date',      ddl: `CREATE INDEX idx_primary_mv_type_date      ON primary_sales_movements(ttyp, trdt DESC)` },
  { name: 'idx_primary_mv_trdt',           ddl: `CREATE INDEX idx_primary_mv_trdt           ON primary_sales_movements(trdt)` },
  { name: 'idx_primary_mv_trdt_brin',      ddl: `CREATE INDEX idx_primary_mv_trdt_brin      ON primary_sales_movements USING BRIN (trdt) WITH (pages_per_range = 32)` },
  { name: 'uq_primary_movement',           ddl: `CREATE UNIQUE INDEX uq_primary_movement    ON primary_sales_movements(cono, whlo, itno, rgdt, rgtm, tmsx)` },
];

// ─── Public: warehouses ───────────────────────────────────────────────────────
async function runWarehouses() {
  const erpPool = await m3Connect();
  try { await preflight(erpPool); return await upsertWarehouses(erpPool); }
  finally { try { await erpPool.close(); } catch (_) {} }
}

// ─── Public: backfill — ONE ordered streaming pass, index-light ──────────────
// opts.limit → TOP N (validation/smoke test). opts.from/opts.to → optional TRDT
// date bound. No bound → the full ~110M-row ledger.
async function runBackfill({ from = null, to = null, limit = null, truncate = false } = {}) {
  const erpPool = await m3Connect();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'backfill');
  const t0 = Date.now();
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();
    if (maps.warehouseMap.size === 0) throw new Error('No warehouses resolved — MITWHL load failed.');

    let whereExtra = '';
    if (from && to) whereExtra += ` AND A.TRDT BETWEEN '${dOnly(from)}' AND '${dOnly(to)}'`;
    const top = limit ? `TOP ${parseInt(limit, 10)} ` : '';
    // Inject TOP right after SELECT.
    const selectWithTop = top
      ? `SELECT ${top}${SELECT_COLS} ${BASE_JOIN} ${BASE_WHERE} ${whereExtra}`
      : null;

    if (truncate) { await pg.query('TRUNCATE primary_sales_movements'); logger.info('[PRIMARY] Truncated primary_sales_movements'); }

    // Index-light: drop everything except the PK so the COPY is a pure sequential
    // write. Rebuild after. (Clustered-source rows carry the unique PK, so the
    // single pass cannot introduce dupes.)
    logger.info('[PRIMARY] Dropping secondary + unique indexes for bulk load…');
    for (const ix of SECONDARY_INDEXES) await pg.query(`DROP INDEX IF EXISTS ${ix.name}`);
    await pg.query(`SET maintenance_work_mem = '1GB'`);
    await pg.query(`SET synchronous_commit = off`);

    const scopeDesc = top ? '(' + top.trim() + ')'
      : (from && to) ? `(TRDT ${dOnly(from)} → ${dOnly(to)})`
      : 'FULL (~110M rows — this runs long)';
    logger.info(`[PRIMARY] BACKFILL streaming ${scopeDesc}…`);
    // streamInto uses BASE_WHERE + whereExtra; for TOP we need the TOP inside the
    // SELECT, so run a bespoke stream when limited.
    let streamed = 0, miss = 0, maxLmts = null;
    if (selectWithTop) {
      const out = await streamCustom(pg, erpPool, maps, selectWithTop, 'primary_sales_movements', 'backfill');
      ({ streamed, miss, maxLmts } = out);
    } else {
      const out = await streamInto(pg, erpPool, maps, whereExtra, 'primary_sales_movements', 'backfill');
      ({ streamed, miss, maxLmts } = out);
    }

    logger.info(`[PRIMARY] Loaded ${streamed.toLocaleString()} rows (${miss.toLocaleString()} lookup misses). Rebuilding indexes…`);
    for (const ix of SECONDARY_INDEXES) await pg.query(ix.ddl);
    await pg.query('ANALYZE primary_sales_movements');

    await advanceHighWater(maxLmts, streamed);
    logger.info('[PRIMARY] Rebuilding rollup (speed layer)…');
    await rebuildRollup();
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    logger.info(`[PRIMARY] ✅ BACKFILL done: ${streamed.toLocaleString()} rows, ${miss.toLocaleString()} misses, ${secs}s, high-water=${maxLmts ? maxLmts.toISOString() : 'n/a'}`);
    return { streamed, miss, maxLmts, seconds: Number(secs) };
  } finally {
    try { await pg.query('RESET maintenance_work_mem'); } catch (_) {}
    try { await pg.query('RESET synchronous_commit'); } catch (_) {}
    pg.release();
    try { await erpPool.close(); } catch (_) {}
  }
}

// Variant of streamInto that takes a fully-formed SELECT (used for TOP N).
async function streamCustom(pg, erpPool, maps, selectSql, copyTarget, label) {
  let streamed = 0, miss = 0, maxLmts = null;
  const copyStream = pg.query(copyFrom(`COPY ${copyTarget} (${COPY_COLS.join(', ')}) FROM STDIN WITH (FORMAT csv)`));
  const request = erpPool.request();
  request.stream = true;
  await new Promise((resolve, reject) => {
    const onError = (err) => { request.removeAllListeners(); copyStream.removeAllListeners(); try { copyStream.destroy(err); } catch (_) {} reject(err); };
    request.on('row', (row) => {
      const r = resolveRow(row, maps);
      if (!r) { miss++; return; }
      streamed++;
      if (r.lmts && (!maxLmts || r.lmts > maxLmts)) maxLmts = r.lmts;
      if (!copyStream.write(r.fields.map(csvEscape).join(',') + '\n')) { request.pause(); copyStream.once('drain', () => request.resume()); }
      if (streamed % 250000 === 0) logger.info(`[PRIMARY] [${label}] streamed ${streamed.toLocaleString()}…`);
    });
    request.on('error', onError); copyStream.on('error', onError);
    request.on('done', () => copyStream.end()); copyStream.on('finish', resolve);
    request.query(selectSql);
  });
  return { streamed, miss, maxLmts };
}

// Stream `SELECT … whereExtra` into a session TEMP table, then UPSERT into the
// live table on the real MITTRA key. Idempotent + dedup by construction.
async function pullMerge(pg, erpPool, maps, whereExtra, label) {
  await pg.query(`DROP TABLE IF EXISTS tmp_primary; CREATE TEMP TABLE tmp_primary (LIKE stg_primary_sales);`);
  const out = await streamInto(pg, erpPool, maps, whereExtra, 'tmp_primary', label);
  const merge = await pg.query(`
    INSERT INTO primary_sales_movements (${COPY_COLS.join(', ')}, synced_at)
    SELECT ${COPY_COLS.join(', ')}, NOW() FROM tmp_primary
    ON CONFLICT (cono, whlo, itno, rgdt, rgtm, tmsx) DO UPDATE SET
      trdt=EXCLUDED.trdt, nstt=EXCLUDED.nstt, ttyp=EXCLUDED.ttyp, trtp=EXCLUDED.trtp,
      whsl=EXCLUDED.whsl, trpr=EXCLUDED.trpr, pupr=EXCLUDED.pupr, trqt=EXCLUDED.trqt,
      repn=EXCLUDED.repn, stas=EXCLUDED.stas, lmts=EXCLUDED.lmts, synced_at=NOW()
  `);
  await pg.query('DROP TABLE IF EXISTS tmp_primary');
  return { merged: merge.rowCount || 0, streamed: out.streamed, miss: out.miss, maxLmts: out.maxLmts };
}

// ─── Public: reconcile — the deterministic self-heal / audit ─────────────────
// Count-matches M3 (source) vs Postgres per TRDT day over [from,to] and re-pulls
// (upsert) any day where source > target. This is the god-level guarantee: it
// closes ANY shortfall regardless of LMTS behaviour (back-dated edits, clock
// skew, missed rows). The persistent residual after a heal = rows whose ITNO
// isn't in the SKU master (unmappable) — those can never be loaded and are
// reported, not re-chased. Duplicates remain impossible (unique-key upsert).
async function reconcile({ from = null, to = null } = {}) {
  const erpPool = await m3Connect();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'reconcile');
  const t0 = Date.now();
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();

    // Default window = the span PG already covers.
    if (!from || !to) {
      const r = (await pg.query('SELECT min(trdt)::text lo, max(trdt)::text hi FROM primary_sales_daily')).rows[0];
      from = from || r.lo; to = to || r.hi;
    }
    if (!from || !to) { logger.warn('[PRIMARY] RECONCILE skipped — no data window.'); return { skipped: true }; }
    logger.info(`[PRIMARY] RECONCILE window ${from} → ${to}`);

    // Source per-day counts (one M3 scan).
    const srcRows = (await erpPool.request().query(`
      SELECT CONVERT(varchar(10),A.TRDT,120) AS d, COUNT_BIG(*) AS c
      FROM M3ReportdataPRD.dbo.MITTRA A
      JOIN M3ReportdataPRD.dbo.MITMAS B ON A.CONO=B.CONO AND A.ITNO=B.ITNO
      JOIN M3ReportdataPRD.dbo.MITWHL D ON D.CONO=A.CONO AND D.WHLO=A.WHLO
      WHERE A.CONO=92 AND B.STCD=1 AND D.DIVI='AAA' AND A.TRDT BETWEEN '${from}' AND '${to}'
      GROUP BY CONVERT(varchar(10),A.TRDT,120)`)).recordset;
    // Target per-day counts.
    const tgt = new Map((await pg.query(
      `SELECT trdt::text d, count(*)::int c FROM primary_sales_movements WHERE trdt BETWEEN $1 AND $2 GROUP BY trdt`,
      [from, to])).rows.map(r => [r.d, r.c]));

    const short = srcRows.map(r => ({ d: r.d, src: Number(r.c), pg: tgt.get(r.d) || 0 }))
      .filter(x => x.src > x.pg)
      .sort((a, b) => (b.src - b.pg) - (a.src - a.pg));
    logger.info(`[PRIMARY] RECONCILE: ${short.length} day(s) with source > target — re-pulling…`);

    let repulled = 0, healed = 0, residual = 0;
    for (const day of short) {
      const before = day.pg;
      const out = await pullMerge(pg, erpPool, maps, `AND A.TRDT = '${day.d}'`, `reconcile ${day.d}`);
      const after = (await pg.query(`SELECT count(*)::int c FROM primary_sales_movements WHERE trdt=$1`, [day.d])).rows[0].c;
      repulled += out.streamed;
      healed += (after - before);
      const rem = day.src - after;               // leftover = unmappable rows for that day
      residual += rem > 0 ? rem : 0;
      logger.info(`[PRIMARY] RECONCILE ${day.d}: src=${day.src} pg ${before}→${after} (+${after - before}) · unmappable≈${rem > 0 ? rem : 0}`);
    }
    if (healed > 0) { logger.info('[PRIMARY] Rebuilding rollup after reconcile…'); await rebuildRollup(); }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    logger.info(`[PRIMARY] ✅ RECONCILE done in ${secs}s: ${short.length} short days, healed ${healed.toLocaleString()} rows, unmappable residual ≈ ${residual.toLocaleString()}`);
    return { window: [from, to], shortDays: short.length, healed, residual, seconds: Number(secs) };
  } finally {
    pg.release();
    try { await erpPool.close(); } catch (_) {}
  }
}

// ─── Public: delta — LMTS datetime2 high-water incremental ───────────────────
async function runDelta({ force = false } = {}) {
  const erpPool = await m3Connect();
  const pg = await pgPool.connect();
  guardClientErrors(pg, 'delta');
  try {
    await preflight(erpPool);
    await upsertWarehouses(erpPool);
    const maps = await buildLookupMaps();
    if (maps.warehouseMap.size === 0) throw new Error('No warehouses resolved — MITWHL load failed.');

    const lastLmts = await getHighWater();
    if (!lastLmts && !force) {
      logger.warn('[PRIMARY] DELTA skipped — no high-water yet (no backfill). Run `npm run primary:backfill` first, ' +
        'or bootstrap with `node src/database/load_primary_sales.js --delta --force`.');
      return { merged: 0, miss: 0, maxLmts: null, skipped: true };
    }
    // LOSSLESS OVERLAP: re-pull rows whose LMTS is within an overlap window
    // BELOW the high-water, not just strictly above it. This covers clock skew /
    // commit-lag on the M3 side (a row whose LMTS predates our last mark but that
    // only became visible after we advanced past it would otherwise be missed).
    // The overlap re-pulls a small, bounded set; the unique-key UPSERT below
    // collapses those re-pulls to no-ops, so Postgres NEVER holds a duplicate.
    // Tune with PRIMARY_DELTA_OVERLAP_SECONDS (default 3600s = 1h; raising it is
    // free of duplicate risk — only re-reads a bit more each run).
    const overlapSec = parseInt(process.env.PRIMARY_DELTA_OVERLAP_SECONDS) || 3600;
    const lowerBound = lastLmts ? new Date(lastLmts.getTime() - overlapSec * 1000) : null;
    const whereExtra = lowerBound ? ` AND A.LMTS > '${sqlDatetimeLiteral(lowerBound)}'` : '';
    logger.info(`[PRIMARY] DELTA pulling MITTRA WHERE LMTS > ${lowerBound ? lowerBound.toISOString() : '(all)'} ` +
      `(high-water ${lastLmts ? lastLmts.toISOString() : 'n/a'}, overlap ${overlapSec}s)`);

    // Stream new/changed rows into a TEMP table and UPSERT on the real MITTRA
    // key so re-pulled/amended rows update in place — never a duplicate.
    const out = await pullMerge(pg, erpPool, maps, whereExtra, 'delta');

    if (out.maxLmts) await advanceHighWater(out.maxLmts, out.merged);
    if (out.merged > 0) { logger.info('[PRIMARY] Rebuilding rollup after delta…'); await rebuildRollup(); }
    logger.info(`[PRIMARY] ✅ DELTA merged ${out.merged.toLocaleString()}, streamed ${out.streamed.toLocaleString()}, ${out.miss.toLocaleString()} misses`);
    return { merged: out.merged, streamed: out.streamed, miss: out.miss, maxLmts: out.maxLmts };
  } finally {
    try { await pg.query('DROP TABLE IF EXISTS tmp_primary'); } catch (_) {}
    pg.release();
    try { await erpPool.close(); } catch (_) {}
  }
}

module.exports = { runWarehouses, runBackfill, runDelta, reconcile, rebuildRollup, buildLookupMaps, FEED };
