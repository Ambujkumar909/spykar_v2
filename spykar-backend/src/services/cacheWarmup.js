// ─── Cache Warm-up ────────────────────────────────────────────────────────────
// Pre-populates the in-process cache (config/cache.js) with heavy /
// frequently-requested endpoints right after server startup, so the first real
// user request returns instantly instead of paying the full DB query cost.
//
// Runs in background via setImmediate — never blocks `app.listen`.
// Failures are logged and swallowed; user traffic always serves correctly even
// if warm-up skips.

const logger = require('../config/logger');

/**
 * Invoke an Express controller without an HTTP server.  We hand it a minimal
 * req/res with just enough surface (req.query, res.json, res.status, next)
 * and resolve when it has either responded or errored.  Used by the warmers
 * below so we don't have to copy SQL out of the controllers — the cache key
 * stays in sync automatically.
 */
function invokeController(controllerFn, query = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (label) => {
      if (resolved) return;
      resolved = true;
      resolve(label);
    };
    const req = { query, params: {}, headers: {}, body: {} };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json()       { settle('ok'); return this; },
      send()       { settle('ok'); return this; },
      end()        { settle('ok'); return this; },
    };
    Promise.resolve()
      .then(() => controllerFn(req, res, (err) => settle(err ? 'err' : 'ok')))
      .catch(() => settle('err'));
    // Safety net — if a controller hangs, free the warmup queue after 60 s.
    setTimeout(() => settle('timeout'), 60_000).unref?.();
  });
}

/**
 * DEPRECATED — kept as a no-op for export compatibility.
 *
 * Previously warmed `inventory:alerts:v8`, an UNCAPPED CROSS JOIN of every
 * alert row × the summary. The controller has since migrated to
 * `inventory:alerts:v12:${mode}`, which is two split queries:
 *   (1) summary  — full-network counts (cards stay honest at any scale)
 *   (2) detail   — same alerts_base, ORDER BY severity, LIMIT 5000
 *
 * The legacy v8 warmer was orphaned: no controller path reads that key, the
 * payload blows past V8's ~512 MB string cap (RangeError "Invalid string
 * length"), the truncated fallback is intentionally NOT cached (see
 * getOrSetRawJson in config/cache.js), and the warmer therefore re-ran the
 * 55-second aggregation every 4 minutes producing nothing usable.
 *
 * Per-mode summary cards are kept warm by `warmStockAlertsSummary` (v1) and
 * `warmAlertsSummaryByMode` (v2) — both lightweight COUNT-only queries
 * (~10 ms each). The 5 000-row detail list is left to lazy population on
 * first user click; caching every mode's 5 000-row payload at boot would
 * burn ~150 ms cold and provides no first-paint benefit (the drill view is
 * not a landing page).
 */
async function warmStockAlerts() { /* intentionally empty — see comment above */ }

/**
 * Warm the tiny stock-alerts summary cache (just the 4 counts). This is the
 * endpoint the Overview page KPI cards call on first paint — keeping it warm
 * makes tab-switching to Overview effectively instant.
 */
async function warmStockAlertsSummary() {
  const start = Date.now();
  try {
    const { getOrSet, TTL } = require('../config/cache');
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
 * Mode-lens warmers — pre-populate Active / Inactive / All variants for the
 * three Overview-page inventory endpoints so flipping the pill is instant
 * (Redis hit, ~1ms) instead of a cold 2-3s Postgres aggregation.
 *
 * Cache keys mirror the controllers exactly:
 *   inventory:executive-summary:v2:{mode}
 *   inventory:alerts:summary:v2:{mode}
 *   inventory:ageing:v2:{mode}:all:all
 */
const MODES = ['active', 'inactive', 'all'];
const modeClause = (m) =>
  m === 'active'   ? 'AND l.shop_closed = false' :
  m === 'inactive' ? 'AND l.shop_closed = true'  :
  '';

async function warmExecutiveSummary(mode) {
  const start = Date.now();
  try {
    const { getOrSet, TTL } = require('../config/cache');
    const { query } = require('../config/database');
    const mc = modeClause(mode);

    await getOrSet(`inventory:executive-summary:v2:${mode}`, async () => {
      const typeBreakdown = await query(`
        WITH vel AS (
          SELECT location_id, sku_id,
            GREATEST(1, ROUND(SUM(ABS(qty_change))::numeric /
              GREATEST(1, EXTRACT(EPOCH FROM (MAX(moved_at)-MIN(moved_at)))/86400), 2)) AS adv
          FROM inventory_movements
          WHERE movement_type = 'SALE'
            AND moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY location_id, sku_id
        )
        SELECT
          COALESCE(l.group_name, l.type::TEXT) AS location_type,
          COUNT(DISTINCT l.id)::int AS location_count,
          COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
          COALESCE(SUM(i.qty_available), 0)::int AS available_stock,
          COALESCE(SUM(i.qty_in_transit), 0)::int AS in_transit,
          COALESCE(SUM(i.qty_on_hand * s.mrp), 0)::numeric AS stock_value,
          COUNT(i.location_id) FILTER (WHERE
            i.qty_on_hand = 0 OR
            i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
          )::int AS low_stock_alerts,
          CASE
            WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- rt'      THEN 'OUTRIGHT'
            ELSE 'SOR'
          END AS billing_model
        FROM locations l
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id
        LEFT JOIN skus s ON s.id = i.sku_id AND s.is_active = true
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        WHERE l.is_active = true
          ${mc}
          AND l.type != 'WAREHOUSE'
          AND NULLIF(TRIM(COALESCE(l.group_name, '')), '') IS NOT NULL
        GROUP BY
          COALESCE(l.group_name, l.type::TEXT),
          CASE
            WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- rt'      THEN 'OUTRIGHT'
            ELSE 'SOR'
          END
        ORDER BY total_stock DESC NULLS LAST
      `);

      const totals = await query(`
        WITH vel AS (
          SELECT location_id, sku_id,
            GREATEST(1, ROUND(SUM(ABS(qty_change))::numeric /
              GREATEST(1, EXTRACT(EPOCH FROM (MAX(moved_at)-MIN(moved_at)))/86400), 2)) AS adv
          FROM inventory_movements
          WHERE movement_type = 'SALE'
            AND moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY location_id, sku_id
        )
        SELECT
          COALESCE(SUM(i.qty_on_hand), 0)::int           AS total_stock,
          COALESCE(SUM(i.qty_available), 0)::int         AS available_stock,
          COALESCE(SUM(i.qty_in_transit), 0)::int        AS in_transit,
          COALESCE(SUM(i.qty_on_hand * s.mrp), 0)::numeric AS total_stock_value,
          COUNT(DISTINCT l.id)::int                      AS active_locations,
          COUNT(DISTINCT i.sku_id)::int                  AS active_skus,
          COUNT(*) FILTER (WHERE
            i.qty_on_hand = 0 OR
            i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
          )::int AS total_alerts
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        WHERE l.is_active = true AND s.is_active = true
          ${mc}
      `);

      const lastSync = await query(`
        SELECT started_at, completed_at, status, records_updated
        FROM sync_logs WHERE status = 'SUCCESS'
        ORDER BY completed_at DESC LIMIT 1
      `);

      return {
        totals: totals.rows[0],
        byLocationType: typeBreakdown.rows,
        criticalAlerts: [],
        lastSync: lastSync.rows[0] || null,
        generatedAt: new Date().toISOString(),
      };
    }, TTL.EXECUTIVE_SUMMARY);

    logger.info(`🔥 Cache warmed: executive-summary [${mode}] in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (exec summary ${mode}) failed: ${err.message}`);
  }
}

async function warmAlertsSummaryByMode(mode) {
  const start = Date.now();
  try {
    const { getOrSet, TTL } = require('../config/cache');
    const { query } = require('../config/database');
    const mc = modeClause(mode);

    await getOrSet(`inventory:alerts:summary:v2:${mode}`, async () => {
      const result = await query(`
        WITH velocity AS (
          SELECT m.location_id, m.sku_id,
            GREATEST(1, ROUND(SUM(ABS(m.qty_change))::numeric /
              GREATEST(1, EXTRACT(EPOCH FROM (MAX(m.moved_at)-MIN(m.moved_at)))/86400), 2)) AS avg_daily_sales
          FROM inventory_movements m
          WHERE m.movement_type = 'SALE'
            AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY m.location_id, m.sku_id
        ),
        thresholds AS (
          SELECT i.location_id, i.sku_id, i.qty_on_hand,
            CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                 ELSE GREATEST(5, ROUND(COALESCE(v.avg_daily_sales,1)*7)) END AS effective_safety,
            CASE WHEN i.reorder_point > 0 THEN i.reorder_point
                 ELSE GREATEST(2, ROUND(COALESCE(v.avg_daily_sales,1)*3)) END AS effective_reorder
          FROM inventory_snapshot i
          LEFT JOIN velocity v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
          JOIN locations l ON l.id = i.location_id AND l.is_active = true
          JOIN skus s ON s.id = i.sku_id AND s.is_active = true
          WHERE 1=1 ${mc}
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

    logger.info(`🔥 Cache warmed: alerts:summary [${mode}] in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (alerts summary ${mode}) failed: ${err.message}`);
  }
}

async function warmAgeingByMode(mode) {
  const start = Date.now();
  try {
    const { getOrSet, TTL } = require('../config/cache');
    const { query } = require('../config/database');

    const conditions = ['l.is_active = true'];
    if (mode === 'active')   conditions.push('l.shop_closed = false');
    if (mode === 'inactive') conditions.push('l.shop_closed = true');

    await getOrSet(`inventory:ageing:v2:${mode}:all:all`, async () => {
      const r = await query(`
        SELECT
          l.id          AS location_id,
          l.name        AS location_name,
          l.type        AS location_type,
          COALESCE(l.group_name, l.type::text) AS channel,
          l.city,
          SUM(a.qty_0_30)::int     AS qty_0_30,
          SUM(a.qty_31_60)::int    AS qty_31_60,
          SUM(a.qty_61_90)::int    AS qty_61_90,
          SUM(a.qty_91_180)::int   AS qty_91_180,
          SUM(a.qty_180_plus)::int AS qty_180_plus,
          (SUM(a.qty_0_30)+SUM(a.qty_31_60)+SUM(a.qty_61_90)+SUM(a.qty_91_180)+SUM(a.qty_180_plus))::int AS total_qty,
          ROUND(SUM(a.qty_180_plus)::numeric /
            NULLIF(SUM(a.qty_0_30+a.qty_31_60+a.qty_61_90+a.qty_91_180+a.qty_180_plus), 0) * 100, 1) AS dead_stock_pct
        FROM stock_ageing a
        JOIN locations l ON l.id = a.location_id
        WHERE ${conditions.join(' AND ')}
          AND a.ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
        GROUP BY l.id, l.name, l.type, l.group_name, l.city
        ORDER BY dead_stock_pct DESC NULLS LAST
      `);
      return r.rows;
    }, TTL.STOCK_AGEING);

    logger.info(`🔥 Cache warmed: ageing [${mode}] in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (ageing ${mode}) failed: ${err.message}`);
  }
}

/**
 * Warm all 3 mode variants of the Overview-page inventory endpoints.
 * Fires concurrently — total wall time ~= slowest single query.
 */
async function warmModeVariants() {
  const tasks = [];
  for (const mode of MODES) {
    tasks.push(warmExecutiveSummary(mode));
    tasks.push(warmAlertsSummaryByMode(mode));
    tasks.push(warmAgeingByMode(mode));
  }
  await Promise.allSettled(tasks);
}

// ─── Overview cross-pivot warmer ─────────────────────────────────────
// Heavy join (best-sellers + stock + busy-stores OOS, 5000-row CTE).
// Cold cost is 7-15s per mode; warming all 3 at boot means every Overview
// load and pill flip reads from Redis instead. Hash-key matches what the
// controller computes so we hit the same slot on first user request.
async function warmCrossPivot(mode) {
  const start = Date.now();
  try {
    const axiosLike = require('http');
    const port = process.env.PORT || 4000;
    const todayISO = new Date().toISOString().slice(0, 10);
    const path = `/api/v1/analytics/overview/cross-pivot?mode=${mode}&date_from=2025-01-01&date_to=${todayISO}`;
    // We don't have a token; instead, directly invoke the controller's
    // cache-population path by hitting the same code through getOrSet.
    // But the controller is the single source of SQL truth, so we go via
    // localhost HTTP using a service token minted from JWT_SECRET.
    const jwt = require('jsonwebtoken');
    const { query } = require('../config/database');
    const u = await query(
      `SELECT id FROM users WHERE role IN ('SUPER_ADMIN','ADMIN') AND is_active = true ORDER BY created_at LIMIT 1`
    );
    if (!u.rows.length) { logger.warn(`Cache warm-up (cross-pivot ${mode}) skipped: no admin user to mint service token`); return; }
    const token = jwt.sign(
      { userId: u.rows[0].id, role: 'SUPER_ADMIN', service: 'cacheWarmup' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    await new Promise((resolve, reject) => {
      const req = axiosLike.request({
        method: 'GET', hostname: '127.0.0.1', port,
        path, headers: { Authorization: `Bearer ${token}` },
        timeout: 60_000,
      }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error',   reject);
      req.on('timeout', () => req.destroy(new Error('cross-pivot warm-up timeout')));
      req.end();
    });
    logger.info(`🔥 Cache warmed: cross-pivot [${mode}] in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (cross-pivot ${mode}) failed: ${err.message}`);
  }
}

async function warmCrossPivotAllModes() {
  // Sequential — these queries are heavy enough that running 3 in parallel
  // doubles each one's wall-time via lock contention. Sequential is faster
  // total wall time.
  for (const mode of MODES) await warmCrossPivot(mode);
}

/**
 * Top-level warm-up orchestrator. Add more warmers here as new hot endpoints
 * are identified. Each warmer is independent — one failure does not block others.
 */
async function warmFilterOptionsDefault() {
  const start = Date.now();
  try {
    const { warmAllOptionsDefault } = require('../controllers/filters.controller');
    await warmAllOptionsDefault();
    logger.info(`🔥 filters/options (default) warmed in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Filter-options warmup skipped: ${err.message}`);
  }
}

/**
 * Warm /locations/network-pulse for one mode.  Same cache key the controller
 * computes for an empty-filters request, so the first real visit is a hit.
 */
async function warmNetworkPulse(mode) {
  const start = Date.now();
  try {
    const { getNetworkPulse } = require('../controllers/networkPulse.controller');
    await invokeController(getNetworkPulse, { mode });
    logger.info(`🔥 network-pulse[${mode}] warmed in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`network-pulse[${mode}] warmup skipped: ${err.message}`);
  }
}
async function warmNetworkPulseAllModes() {
  for (const m of ['active', 'inactive', 'all']) await warmNetworkPulse(m);
}

/**
 * Warm /analytics/sales for one mode using the FY default date range
 * (2025-04-01 → today).  This is the range the existing /sales page
 * lands on by default — filtered drilldowns aren't pre-warmed (their cache
 * keys are per-filter-combo, exponential to enumerate).
 */
async function warmSalesAnalytics(mode) {
  const start = Date.now();
  try {
    const { getSalesAnalytics } = require('../controllers/analytics.controller');
    await invokeController(getSalesAnalytics, {
      date_from: '2025-04-01',
      date_to:   new Date().toISOString().slice(0, 10),
      mode,
    });
    logger.info(`🔥 analytics/sales[${mode}] warmed in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`analytics/sales[${mode}] warmup skipped: ${err.message}`);
  }
}
async function warmSalesAnalyticsAllModes() {
  for (const m of ['active', 'inactive', 'all']) await warmSalesAnalytics(m);
}

async function warmCaches() {
  logger.info('🔥 Starting background cache warm-up…');
  await Promise.allSettled([
    warmStockAlertsSummary(),    // legacy v1 — kept for /alerts:summary:v1 compatibility
    // warmStockAlerts() removed — was warming orphaned v8 cache key the
    // controller no longer reads; payload exceeded V8's 512 MB string cap
    // and the truncated fallback isn't cached, so it re-ran every 4 min
    // for nothing. See the deprecation comment on warmStockAlerts above.
    warmModeVariants(),          // Active / Inactive / All for exec-summary, alerts-summary v2, ageing
    warmCrossPivotAllModes(),    // cross-pivot tables (heavy CTE, all 3 modes sequential)
    warmFilterOptionsDefault(),  // /filters/options default key — front-page entry path
    warmNetworkPulseAllModes(),  // /locations/network-pulse — 13 s cold; warm all 3 modes
    warmSalesAnalyticsAllModes(),// /analytics/sales — 8 s cold; warm all 3 modes for FY default
  ]);
  logger.info('🔥 Cache warm-up complete — Overview hot for every lens');
}

/**
 * Schedule a periodic re-warm so caches never go cold during business hours.
 * Re-warms every REWARM_MS — pick a value strictly less than the cache TTLs
 * the controllers use so a real user request finds the key still present.
 *
 * Idempotent: if the warmer is still running from the previous tick, the
 * next tick's getOrSet calls just become read-throughs.
 */
const REWARM_MS = 4 * 60_000;
let rewarmTimer = null;
function startPeriodicRewarm() {
  if (rewarmTimer) return; // guard against double-start
  rewarmTimer = setInterval(async () => {
    // CRITICAL: never re-warm while a sync is RUNNING. A sync (in the detached
    // child) is mid-merge — the movements/snapshot tables are in flux. If we
    // read them now and cache the result with the 24h analytics TTL, we'd pin
    // PARTIAL, stale data for a full day, and the sync's end-of-run cache
    // invalidation can't help because our write lands after it. Skipping the
    // tick is safe: once the sync finishes it invalidates the cache, and the
    // NEXT rewarm tick (or the first user request) repopulates fresh from the
    // now-committed data.
    try {
      const { query } = require('../config/database');
      const r = await query(
        `SELECT 1 FROM sync_logs WHERE status='RUNNING' AND started_at > NOW() - INTERVAL '30 minutes' LIMIT 1`
      );
      if (r.rows.length > 0) {
        logger.info('🔁 Skipping cache re-warm — a sync is in progress (will re-warm after it completes)');
        return;
      }
    } catch (_) { /* if the check fails, fall through and warm anyway */ }
    Promise.resolve(warmCaches()).catch(() => {});
  }, REWARM_MS);
  // unref so a process exit during shutdown doesn't hang on the timer.
  if (rewarmTimer.unref) rewarmTimer.unref();
  logger.info(`🔁 Periodic cache re-warm scheduled every ${REWARM_MS / 1000}s (skips while sync running)`);
}

module.exports = {
  warmCaches, warmStockAlerts, warmStockAlertsSummary,
  warmModeVariants, warmCrossPivotAllModes,
  warmNetworkPulse, warmNetworkPulseAllModes,
  warmSalesAnalytics, warmSalesAnalyticsAllModes,
  warmFilterOptionsDefault,
  startPeriodicRewarm,
};
