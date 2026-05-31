/**
 * Standalone Ageing Recompute Script
 * Re-runs ONLY the stock_ageing bucket calculation — no ERP sync required.
 * Safe to run any time after movements are loaded.
 *
 * Usage: node src/scripts/run_ageing_update.js
 */
'use strict';

require('dotenv').config();
const { query }             = require('../config/database');
const { invalidatePattern } = require('../config/cache');
const logger                = require('../config/logger');

async function main() {
  logger.info('════════════════════════════════════════');
  logger.info('  SPYKAR — Ageing Recompute (standalone)');
  logger.info('════════════════════════════════════════\n');

  // Check reference date before running
  const refRow = await query(`
    SELECT
      MAX(moved_at)::date AS max_sale_date,
      MIN(moved_at)::date AS min_sale_date,
      COUNT(*)::int       AS total_sales
    FROM inventory_movements WHERE movement_type = 'SALE'
  `);
  const { max_sale_date, min_sale_date, total_sales } = refRow.rows[0];
  logger.info(`Sale data window: ${min_sale_date} → ${max_sale_date} (${total_sales?.toLocaleString()} records)`);
  logger.info(`Ageing reference date will be: ${max_sale_date}\n`);

  // Delete today's stale ageing rows first so we get a clean recompute
  const del = await query(`DELETE FROM stock_ageing WHERE ageing_date = CURRENT_DATE`);
  logger.info(`Cleared ${del.rowCount} existing ageing rows for today`);

  // Run the corrected ageing computation
  await query(`
    WITH ref AS (
      SELECT COALESCE(MAX(moved_at), CURRENT_TIMESTAMP) AS ref_date
      FROM   inventory_movements
      WHERE  movement_type = 'SALE'
    ),
    last_sale AS (
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
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '30 days'
           THEN i.qty_on_hand ELSE 0 END,
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '60 days'
                AND ls.last_sold_at <  ref.ref_date - INTERVAL '30 days'
           THEN i.qty_on_hand ELSE 0 END,
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '90 days'
                AND ls.last_sold_at <  ref.ref_date - INTERVAL '60 days'
           THEN i.qty_on_hand ELSE 0 END,
      CASE WHEN ls.last_sold_at >= ref.ref_date - INTERVAL '180 days'
                AND ls.last_sold_at <  ref.ref_date - INTERVAL '90 days'
           THEN i.qty_on_hand ELSE 0 END,
      CASE WHEN ls.last_sold_at IS NULL
                OR ls.last_sold_at < ref.ref_date - INTERVAL '180 days'
           THEN i.qty_on_hand ELSE 0 END,
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

  // Verify bucket distribution
  const dist = await query(`
    SELECT
      SUM(qty_0_30)::int     AS fresh_0_30,
      SUM(qty_31_60)::int    AS healthy_31_60,
      SUM(qty_61_90)::int    AS slow_61_90,
      SUM(qty_91_180)::int   AS at_risk_91_180,
      SUM(qty_180_plus)::int AS dead_180_plus,
      (SUM(qty_0_30)+SUM(qty_31_60)+SUM(qty_61_90)+SUM(qty_91_180)+SUM(qty_180_plus))::int AS total_units,
      COUNT(*)::int AS sku_location_pairs
    FROM stock_ageing
    WHERE ageing_date = CURRENT_DATE
  `);
  const d = dist.rows[0];
  logger.info('\nAgeing bucket distribution:');
  logger.info(`  0–30  days  (Fresh):    ${d.fresh_0_30?.toLocaleString()} units`);
  logger.info(`  31–60 days  (Healthy):  ${d.healthy_31_60?.toLocaleString()} units`);
  logger.info(`  61–90 days  (Slow):     ${d.slow_61_90?.toLocaleString()} units`);
  logger.info(`  91–180 days (At Risk):  ${d.at_risk_91_180?.toLocaleString()} units`);
  logger.info(`  180+  days  (Dead):     ${d.dead_180_plus?.toLocaleString()} units`);
  logger.info(`  ─────────────────────────────────────`);
  logger.info(`  Total tracked:          ${d.total_units?.toLocaleString()} units across ${d.sku_location_pairs?.toLocaleString()} SKU×location pairs`);

  // Flush Redis so fresh ageing data is served immediately
  await Promise.all([
    invalidatePattern('inventory:*'),
    invalidatePattern('analytics:*'),
    invalidatePattern('sku:*'),
  ]);
  logger.info('\n✅ Redis cache invalidated — fresh data will be served on next request\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error('Ageing recompute failed:', err.message);
    process.exit(1);
  });
