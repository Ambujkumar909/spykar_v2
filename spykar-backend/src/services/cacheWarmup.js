// ─── Cache Warm-up ────────────────────────────────────────────────────────────
// Pre-populates Redis with heavy / frequently-requested endpoints right after
// server startup, so the first real user request returns instantly instead of
// paying the full DB query cost.
//
// Runs in background via setImmediate — never blocks `app.listen`.
// Failures are logged and swallowed; user traffic always serves correctly even
// if warm-up skips.

const logger = require('../config/logger');

/**
 * Warm the stock alerts cache by calling the controller's cached path directly.
 * Re-uses the exact same raw-JSON cache key (`inventory:alerts:v8`) the HTTP
 * handler uses, so the first HTTP request is guaranteed to be a cache HIT and
 * can stream the pre-serialized response body straight to the client.
 */
async function warmStockAlerts() {
  const start = Date.now();
  try {
    // Lazy-require to avoid circular deps during module load
    const { getOrSetRawJson, TTL } = require('../config/redis');
    const { query } = require('../config/database');

    await getOrSetRawJson('inventory:alerts:v8', async () => {
      const result = await query(`
        WITH velocity AS (
          SELECT
            m.location_id, m.sku_id,
            GREATEST(1,
              ROUND(
                SUM(ABS(m.qty_change))::numeric /
                GREATEST(1, EXTRACT(EPOCH FROM (MAX(m.moved_at) - MIN(m.moved_at))) / 86400),
                2
              )
            ) AS avg_daily_sales
          FROM inventory_movements m
          WHERE m.movement_type = 'SALE'
            AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY m.location_id, m.sku_id
        ),
        thresholds AS (
          SELECT
            i.location_id, i.sku_id,
            CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                 ELSE GREATEST(5, ROUND(COALESCE(v.avg_daily_sales,1) * 7))
            END AS effective_safety,
            CASE WHEN i.reorder_point > 0 THEN i.reorder_point
                 ELSE GREATEST(2, ROUND(COALESCE(v.avg_daily_sales,1) * 3))
            END AS effective_reorder
          FROM inventory_snapshot i
          LEFT JOIN velocity v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        ),
        alerts_base AS (
          SELECT
            l.name AS location_name, COALESCE(l.group_name, l.type::text) AS location_type, l.city, l.state,
            s.sku_code, s.product_name, s.color_name, s.size,
            i.qty_on_hand,
            t.effective_safety  AS safety_stock,
            t.effective_reorder AS reorder_point,
            ROUND(((t.effective_safety - i.qty_on_hand)::numeric / NULLIF(t.effective_safety,0)) * 100, 1) AS shortfall_pct,
            CASE
              WHEN i.qty_on_hand = 0                    THEN 'OUT_OF_STOCK'
              WHEN i.qty_on_hand <= t.effective_reorder THEN 'REORDER_NOW'
              ELSE                                           'LOW_STOCK'
            END AS alert_level
          FROM inventory_snapshot i
          JOIN thresholds t ON t.location_id = i.location_id AND t.sku_id = i.sku_id
          JOIN locations l ON l.id = i.location_id
          JOIN skus s ON s.id = i.sku_id
          WHERE (
            i.qty_on_hand = 0
            OR i.qty_on_hand <= t.effective_safety
          )
            AND l.is_active = true AND s.is_active = true
        ),
        summary AS (
          SELECT
            COUNT(*) FILTER (WHERE alert_level = 'OUT_OF_STOCK')::int AS out_of_stock,
            COUNT(*) FILTER (WHERE alert_level = 'REORDER_NOW')::int  AS reorder_now,
            COUNT(*) FILTER (WHERE alert_level = 'LOW_STOCK')::int    AS low_stock,
            COUNT(*)::int                                              AS total
          FROM alerts_base
        )
        SELECT
          a.*,
          s.out_of_stock, s.reorder_now, s.low_stock, s.total
        FROM alerts_base a
        CROSS JOIN summary s
        ORDER BY
          CASE a.alert_level
            WHEN 'OUT_OF_STOCK' THEN 0
            WHEN 'REORDER_NOW'  THEN 1
            ELSE                     2
          END,
          a.shortfall_pct DESC NULLS LAST
      `);

      const first = result.rows[0];
      const summary = first
        ? { out_of_stock: first.out_of_stock, reorder_now: first.reorder_now,
            low_stock: first.low_stock, total: first.total }
        : { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 };

      const data = result.rows.map(({ out_of_stock, reorder_now, low_stock, total, ...row }) => row);
      // Warm the full response body so the handler can stream it untouched.
      return { success: true, data, summary, count: summary.total };
    }, TTL.STOCK_ALERTS);

    logger.info(`🔥 Cache warmed: stock alerts in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (stock alerts) failed: ${err.message}`);
  }
}

/**
 * Warm the tiny stock-alerts summary cache (just the 4 counts). This is the
 * endpoint the Overview page KPI cards call on first paint — keeping it warm
 * makes tab-switching to Overview effectively instant.
 */
async function warmStockAlertsSummary() {
  const start = Date.now();
  try {
    const { getOrSet, TTL } = require('../config/redis');
    const { query } = require('../config/database');

    await getOrSet('inventory:alerts:summary:v1', async () => {
      const result = await query(`
        WITH velocity AS (
          SELECT
            m.location_id, m.sku_id,
            GREATEST(1,
              ROUND(
                SUM(ABS(m.qty_change))::numeric /
                GREATEST(1, EXTRACT(EPOCH FROM (MAX(m.moved_at) - MIN(m.moved_at))) / 86400),
                2
              )
            ) AS avg_daily_sales
          FROM inventory_movements m
          WHERE m.movement_type = 'SALE'
            AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY m.location_id, m.sku_id
        ),
        thresholds AS (
          SELECT
            i.location_id, i.sku_id, i.qty_on_hand,
            CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                 ELSE GREATEST(5, ROUND(COALESCE(v.avg_daily_sales,1) * 7))
            END AS effective_safety,
            CASE WHEN i.reorder_point > 0 THEN i.reorder_point
                 ELSE GREATEST(2, ROUND(COALESCE(v.avg_daily_sales,1) * 3))
            END AS effective_reorder
          FROM inventory_snapshot i
          LEFT JOIN velocity v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
          JOIN locations l ON l.id = i.location_id AND l.is_active = true
          JOIN skus s ON s.id = i.sku_id AND s.is_active = true
        )
        SELECT
          COUNT(*) FILTER (WHERE qty_on_hand = 0)::int                                                 AS out_of_stock,
          COUNT(*) FILTER (WHERE qty_on_hand > 0 AND qty_on_hand <= effective_reorder)::int            AS reorder_now,
          COUNT(*) FILTER (WHERE qty_on_hand > effective_reorder AND qty_on_hand <= effective_safety)::int AS low_stock,
          COUNT(*) FILTER (WHERE qty_on_hand = 0 OR qty_on_hand <= effective_safety)::int              AS total
        FROM thresholds
      `);
      const r = result.rows[0] || { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 };
      return {
        out_of_stock: r.out_of_stock || 0,
        reorder_now:  r.reorder_now  || 0,
        low_stock:    r.low_stock    || 0,
        total:        r.total        || 0,
      };
    }, TTL.STOCK_ALERTS);

    logger.info(`🔥 Cache warmed: stock alerts summary in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (alerts summary) failed: ${err.message}`);
  }
}

/**
 * Top-level warm-up orchestrator. Add more warmers here as new hot endpoints
 * are identified. Each warmer is independent — one failure does not block others.
 */
async function warmCaches() {
  logger.info('🔥 Starting background cache warm-up…');
  await Promise.allSettled([
    warmStockAlertsSummary(), // tiny — warms first, unblocks Overview KPI cards
    warmStockAlerts(),        // heavy — warms the full drill-down in parallel
  ]);
  logger.info('🔥 Cache warm-up complete');
}

module.exports = { warmCaches, warmStockAlerts, warmStockAlertsSummary };
