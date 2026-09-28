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

// ─── Inventory warmers ───────────────────────────────────────────────────────
// These used to carry hand-copied copies of the controllers' SQL and write the
// cache keys themselves. They drifted: one wrote a key nothing reads, the
// alerts-summary copy kept the old key after the controller moved on, and the
// executive-summary copy cached a payload WITHOUT criticalAlerts under the
// controller's own key. Invoking the controller keeps key and payload exact.
const MODES = ['active', 'inactive', 'all'];
const inventoryCtrl = () => require('../controllers/inventory.controller');
async function warmOne(label, fn) {
  const start = Date.now();
  try { await fn(); logger.info(`🔥 ${label} warmed in ${Date.now() - start}ms`); }
  catch (err) { logger.warn(`Cache warm-up (${label}) failed: ${err.message}`); }
}
const warmExecutiveSummary    = (mode) => warmOne(`executive-summary[${mode}]`, () => invokeController(inventoryCtrl().getExecutiveSummary, { mode }));
const warmAlertsByMode        = (mode) => warmOne(`alerts[${mode}]`,            () => invokeController(inventoryCtrl().getAlerts, { mode }));
const warmAlertsSummaryByMode = (mode) => warmOne(`alerts-summary[${mode}]`,    () => invokeController(inventoryCtrl().getAlertsSummary, { mode }));
const warmAgeingByMode        = (mode) => warmOne(`ageing[${mode}]`,            () => invokeController(inventoryCtrl().getAgeing, { mode }));
// Kept as no-ops for export compatibility (older callers).
async function warmStockAlerts() {}
async function warmStockAlertsSummary() {}

async function warmModeVariants() {
  const tasks = [];
  for (const mode of MODES) {
    tasks.push(warmExecutiveSummary(mode));
    tasks.push(warmAlertsByMode(mode));        // the Network page's alert panel + header strip
    tasks.push(warmAlertsSummaryByMode(mode));
    tasks.push(warmAgeingByMode(mode));
  }
  await Promise.allSettled(tasks);
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
    // LOCAL dates exactly like the browser's useTimeRange (toISOString() was
    // UTC, so before 05:30 IST the warmed key never matched), and the MTD
    // window the page opens on as well as the current FY (was a hardcoded
    // 2025-04-01 that stopped matching the FY on 2026-04-01).
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const to = fmt(today);
    const mtd = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    const fy  = fmt(new Date(today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1, 3, 1));
    await invokeController(getSalesAnalytics, { date_from: mtd, date_to: to, mode });
    await invokeController(getSalesAnalytics, { date_from: fy, date_to: to, mode });
    logger.info(`🔥 analytics/sales[${mode}] warmed in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`analytics/sales[${mode}] warmup skipped: ${err.message}`);
  }
}
async function warmSalesAnalyticsAllModes() {
  for (const m of ['active', 'inactive', 'all']) await warmSalesAnalytics(m);
}

/**
 * Warm the Primary Sales page for the window it actually opens on (MTD — see
 * pages/primary-sales.js) and then the FY window (the YTD pill). Pre-populates
 * /overview, the by-dimension pivots (so switching View-by is instant), the
 * default trend, and the tiny filter lists. Dates are formatted as LOCAL
 * calendar dates exactly like the frontend's useTimeRange, so the cache keys
 * match what the browser requests. (The previous version warmed only the FY
 * window with a UTC date — the page's real default stayed cold, and after
 * 18:30 UTC the key didn't even match the browser's.)
 */
async function warmPrimarySales() {
  const start = Date.now();
  try {
    const ctrl = require('../controllers/primarySales.controller');
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const to = fmt(today);
    const mtd = { from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), to };
    const fy  = { from: fmt(new Date(today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1, 3, 1)), to };

    const forWindow = (win) => {
      const tasks = [
        invokeController(ctrl.getOverview, { ...win }),
        invokeController(ctrl.getSkuCount, { ...win }),
        invokeController(ctrl.getTrend, { group_by: 'warehouse', ...win, top: 6, measure: 'gross' }),
      ];
      for (const dim of ['warehouse', 'type', 'category', 'colour', 'size', 'product']) {
        tasks.push(invokeController(ctrl.getPivot, { group_by: dim, ...win }));
      }
      return tasks;
    };
    await Promise.allSettled([
      invokeController(ctrl.getTypes, {}),
      invokeController(ctrl.getWarehouses, {}),
      invokeController(ctrl.getRange, {}),
      ...forWindow(mtd),          // the page default — must be hot first
    ]);
    await Promise.allSettled(forWindow(fy));   // YTD, one click away
    logger.info(`🔥 Cache warmed: primary-sales (MTD + FY: overview + 6 pivots + trend each) in ${Date.now() - start}ms`);
  } catch (err) {
    logger.warn(`Cache warm-up (primary-sales) failed: ${err.message}`);
  }
}

async function warmCaches() {
  logger.info('🔥 Starting background cache warm-up…');
  await Promise.allSettled([
    // warmStockAlerts() removed — was warming orphaned v8 cache key the
    // controller no longer reads; payload exceeded V8's 512 MB string cap
    // and the truncated fallback isn't cached, so it re-ran every 4 min
    // for nothing. See the deprecation comment on warmStockAlerts above.
    warmModeVariants(),          // Active / Inactive / All for exec-summary, alerts-summary v2, ageing
    warmFilterOptionsDefault(),  // /filters/options default key — front-page entry path
    warmNetworkPulseAllModes(),  // /locations/network-pulse — 13 s cold; warm all 3 modes
    warmSalesAnalyticsAllModes(),// /analytics/sales — 8 s cold; warm all 3 modes for FY default
    warmPrimarySales(),          // /primary-sales — overview + all pivots for FY default
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
  warmModeVariants,
  warmNetworkPulse, warmNetworkPulseAllModes,
  warmSalesAnalytics, warmSalesAnalyticsAllModes,
  warmFilterOptionsDefault, warmPrimarySales,
  startPeriodicRewarm,
};
