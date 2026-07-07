/**
 * load_inventory_ageing.js — precompute TRUE inventory ageing
 * ─────────────────────────────────────────────────────────────────────────────
 * Populates `inventory_ageing` (migration 019) with two independent engines:
 *
 *   WAREHOUSE (source='warehouse') — real FIFO on the M3 MITTRA ledger
 *     (primary_sales_movements). On-hand per (warehouse,sku) = Σtrqt; under FIFO
 *     the units still in stock are the NEWEST receipts, so a reverse-cumulative
 *     window over positive movements dates every in-stock unit. Age = as_of −
 *     receipt date. This is genuine receipt-based ageing.
 *
 *   STORE (source='store') — continuous-on-hand on inventory_daily_snapshot.
 *     Units that never left across the whole trailing D-day window are ≥D days
 *     old → min(on-hand) over the window. Buckets are only credited where the
 *     snapshot history actually COVERS the window; the floor beyond coverage is
 *     parked in bucket 9 ('undetermined') until history deepens. (No store
 *     receipt feed exists — MITTRA is warehouse-only — so this snapshot method
 *     is the only correct route to store ageing.)
 *
 * Buckets: 0:0–30 1:31–60 2:61–90 3:91–180 4:181–365 5:365+  9:undetermined
 * Idempotent: each engine DELETEs its source slice, then re-inserts. Value =
 * units × skus.mrp / cost_price (same valuation as every other page).
 *
 *   node src/database/load_inventory_ageing.js            (both engines)
 *   node src/database/load_inventory_ageing.js --warehouse
 *   node src/database/load_inventory_ageing.js --store
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/database');
const { invalidatePattern } = require('../config/cache');
const logger = require('../config/logger');

const ARGS = process.argv.slice(2);
const ONLY = ARGS.includes('--warehouse') ? 'warehouse'
           : ARGS.includes('--store')     ? 'store' : null;

const BUCKET_LABELS = {
  0: '0–30 days', 1: '31–60 days', 2: '61–90 days',
  3: '91–180 days', 4: '181–365 days', 5: '365+ days', 9: 'Undetermined',
};

// Ensure the table exists (safe to run before `db:migrate` has been applied).
async function ensureSchema() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'migrations', '019_inventory_ageing.sql'), 'utf8');
  await query(sql);
}

// ── WAREHOUSE: FIFO over MITTRA ──────────────────────────────────────────────
async function loadWarehouse() {
  const r = await query(`SELECT MAX(trdt)::text hi, MIN(trdt)::text lo FROM primary_sales_movements`);
  const asOf = r.rows[0]?.hi;
  if (!asOf) { logger.warn('[AGEING/warehouse] no MITTRA movements — skipped'); return; }
  const covered = Math.round((new Date(asOf) - new Date(r.rows[0].lo)) / 86400000);

  logger.info(`[AGEING/warehouse] FIFO as of ${asOf} (history covers ~${covered}d)…`);
  await query(`DELETE FROM inventory_ageing WHERE source = 'warehouse'`);

  const ins = await query(
    `WITH mv AS (
        SELECT warehouse_id, sku_id, trdt, trqt
          FROM primary_sales_movements WHERE trdt <= $1::date
     ),
     bal AS (
        SELECT warehouse_id, sku_id, SUM(trqt) AS b
          FROM mv GROUP BY 1,2 HAVING SUM(trqt) > 0
     ),
     rec AS (   -- positive (receipt) movements, reverse-cumulative newest-first
        SELECT m.warehouse_id, m.sku_id, m.trdt, m.trqt,
               SUM(m.trqt) OVER (PARTITION BY m.warehouse_id, m.sku_id
                                 ORDER BY m.trdt DESC
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS csum
          FROM mv m WHERE m.trqt > 0
     ),
     layers AS (   -- clamp each receipt layer to the portion still in stock
        SELECT r.warehouse_id, r.sku_id,
               LEAST(r.trqt, b.b - (r.csum - r.trqt)) AS qty,
               ($1::date - r.trdt) AS age_days
          FROM rec r JOIN bal b USING (warehouse_id, sku_id)
         WHERE (r.csum - r.trqt) < b.b
     )
     INSERT INTO inventory_ageing
        (as_of_date, source, ref_id, sku_id, age_bucket, units, value_gross, value_cost)
     SELECT $1::date, 'warehouse', l.warehouse_id, l.sku_id,
            CASE WHEN l.age_days <= 30  THEN 0
                 WHEN l.age_days <= 60  THEN 1
                 WHEN l.age_days <= 90  THEN 2
                 WHEN l.age_days <= 180 THEN 3
                 WHEN l.age_days <= 365 THEN 4
                 ELSE 5 END AS age_bucket,
            SUM(l.qty)::numeric AS units,
            (SUM(l.qty) * COALESCE(sk.mrp,0))::numeric AS value_gross,
            (SUM(l.qty) * COALESCE(sk.cost_price,0))::numeric AS value_cost
       FROM layers l
       JOIN skus sk ON sk.id = l.sku_id
      WHERE l.qty > 0
      GROUP BY l.warehouse_id, l.sku_id, age_bucket, sk.mrp, sk.cost_price`,
    [asOf]
  );
  await recordMeta('warehouse', asOf, covered, ins.rowCount);
  await report('warehouse', asOf);
}

// ── STORE: continuous-on-hand over daily snapshots (coverage-gated) ──────────
async function loadStore() {
  const r = await query(`SELECT MAX(snapshot_date)::text hi, MIN(snapshot_date)::text lo
                           FROM inventory_daily_snapshot`);
  const asOf = r.rows[0]?.hi;
  if (!asOf) { logger.warn('[AGEING/store] no snapshots — skipped'); return; }
  const cov = Math.round((new Date(asOf) - new Date(r.rows[0].lo)) / 86400000);

  logger.info(`[AGEING/store] continuous-on-hand as of ${asOf} (history covers ${cov}d)…`);
  await query(`DELETE FROM inventory_ageing WHERE source = 'store'`);

  // mD = units present across the ENTIRE last-D-day window (= min on-hand). Only
  // trustworthy when cov >= D; otherwise that boundary is unproven. `bnd(D)`
  // returns the provable floor for D, or NULL when the window isn't covered.
  const ins = await query(
    `WITH s AS (
        SELECT location_id, sku_id, snapshot_date, qty_on_hand
          FROM inventory_daily_snapshot WHERE snapshot_date <= $1::date
     ),
     agg AS (
        SELECT location_id, sku_id,
               (array_agg(qty_on_hand ORDER BY snapshot_date DESC))[1]              AS cur,
               MIN(qty_on_hand)                                                     AS floor_all,
               MIN(qty_on_hand) FILTER (WHERE snapshot_date > $1::date - 30)        AS m30,
               MIN(qty_on_hand) FILTER (WHERE snapshot_date > $1::date - 60)        AS m60,
               MIN(qty_on_hand) FILTER (WHERE snapshot_date > $1::date - 90)        AS m90,
               MIN(qty_on_hand) FILTER (WHERE snapshot_date > $1::date - 180)       AS m180,
               MIN(qty_on_hand) FILTER (WHERE snapshot_date > $1::date - 365)       AS m365
          FROM s GROUP BY 1,2
     ),
     g AS (   -- provable floors: NULL where the window exceeds coverage ($2)
        SELECT location_id, sku_id, cur, floor_all,
               CASE WHEN $2 >= 30  THEN m30  END AS g30,
               CASE WHEN $2 >= 60  THEN m60  END AS g60,
               CASE WHEN $2 >= 90  THEN m90  END AS g90,
               CASE WHEN $2 >= 180 THEN m180 END AS g180,
               CASE WHEN $2 >= 365 THEN m365 END AS g365
          FROM agg WHERE cur > 0
     )
     INSERT INTO inventory_ageing
        (as_of_date, source, ref_id, sku_id, age_bucket, units, value_gross, value_cost)
     SELECT $1::date, 'store', g.location_id, g.sku_id, b.idx,
            b.units::numeric,
            (b.units * COALESCE(sk.mrp,0))::numeric,
            (b.units * COALESCE(sk.cost_price,0))::numeric
       FROM g
       JOIN skus sk ON sk.id = g.sku_id
       CROSS JOIN LATERAL (VALUES
            (0, g.cur - COALESCE(g.g30, g.floor_all)),                       -- 0–30 (proven fresh)
            (1, CASE WHEN g.g30  IS NOT NULL THEN g.g30  - COALESCE(g.g60, g.g30)  ELSE 0 END),
            (2, CASE WHEN g.g60  IS NOT NULL THEN g.g60  - COALESCE(g.g90, g.g60)  ELSE 0 END),
            (3, CASE WHEN g.g90  IS NOT NULL THEN g.g90  - COALESCE(g.g180,g.g90)  ELSE 0 END),
            (4, CASE WHEN g.g180 IS NOT NULL THEN g.g180 - COALESCE(g.g365,g.g180) ELSE 0 END),
            (5, CASE WHEN g.g365 IS NOT NULL THEN g.g365 ELSE 0 END),
            -- floor beyond the deepest PROVEN window → age unknown (≥ covered days)
            (9, CASE WHEN g.g365 IS NOT NULL THEN 0 ELSE COALESCE(g.g30,g.g60,g.g90,g.g180,g.floor_all) END)
       ) AS b(idx, units)
      WHERE b.units > 0`,
    [asOf, cov]
  );
  await recordMeta('store', asOf, cov, ins.rowCount);
  await report('store', asOf);
}

async function recordMeta(source, asOf, covered, rows) {
  await query(
    `INSERT INTO inventory_ageing_meta (source, as_of_date, covered_days, rows_written, computed_at)
     VALUES ($1,$2::date,$3,$4, now())
     ON CONFLICT (source) DO UPDATE SET as_of_date=EXCLUDED.as_of_date,
        covered_days=EXCLUDED.covered_days, rows_written=EXCLUDED.rows_written, computed_at=now()`,
    [source, asOf, covered, rows]
  );
}

async function report(source, asOf) {
  const d = await query(
    `SELECT age_bucket, SUM(units)::bigint u, SUM(value_gross)::bigint v
       FROM inventory_ageing WHERE source=$1 AND as_of_date=$2::date
      GROUP BY 1 ORDER BY 1`, [source, asOf]);
  logger.info(`[AGEING/${source}] bucket distribution:`);
  for (const row of d.rows) {
    logger.info(`   ${BUCKET_LABELS[row.age_bucket].padEnd(14)} ${Number(row.u).toLocaleString('en-IN').padStart(12)} units  ₹${Number(row.v).toLocaleString('en-IN')}`);
  }
}

// Rebuild both engines (or one). Importable by syncEngine — does NOT touch the
// pool lifecycle or flush caches (the caller owns those).
async function rebuildAll(only = null) {
  await ensureSchema();
  if (only !== 'store')     await loadWarehouse();
  if (only !== 'warehouse') await loadStore();
}

async function main() {
  logger.info('═'.repeat(60));
  logger.info('  SPYKAR — Inventory Ageing precompute (true FIFO + continuous-on-hand)');
  logger.info('═'.repeat(60));
  await rebuildAll(ONLY);
  await Promise.all([
    invalidatePattern('ageing:*'),
    invalidatePattern('inventory:*'),
  ]);
  logger.info('✅ Ageing precompute complete — cache flushed.');
}

module.exports = { rebuildAll, loadWarehouse, loadStore, ensureSchema };

// Only run as a CLI when invoked directly (so `require()` from syncEngine is safe).
if (require.main === module) {
  main().then(() => pool.end()).then(() => process.exit(0))
    .catch((e) => { logger.error('Ageing precompute failed:', e.message); logger.error(e.stack); process.exit(1); });
}
