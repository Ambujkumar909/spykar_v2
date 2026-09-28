// analytics.routes.js
const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const analyticsController = require('../controllers/analytics.controller');

router.use(authenticate);

// Shared validators: a malformed date/uuid used to reach Postgres and come back
// as a 500. strict ISO rejects impossible dates like 2026-02-30.
const dateRange = [
  query('date_from').optional().isISO8601({ strict: true }),
  query('date_to').optional().isISO8601({ strict: true }),
  query('mode').optional().isIn(['active', 'inactive', 'all']),
  query('location_id').optional().isUUID(),
];

router.get('/network-overview', analyticsController.getNetworkOverview);

router.get('/stock-trend', [
  query('days').optional().isInt({ min: 7, max: 365 }).toInt(),
  query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
], validate, analyticsController.getStockTrend);

router.get('/size-distribution', [
  query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  query('zone_id').optional().isInt().toInt(),
], validate, analyticsController.getSizeDistribution);

router.get('/color-distribution', [
  query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
], validate, analyticsController.getColorDistribution);

router.get('/zone-heatmap', analyticsController.getZoneHeatmap);

router.get('/fill-rate', [
  query('days').optional().isInt({ min: 7, max: 90 }).toInt(),
], validate, analyticsController.getFillRate);

router.get('/sales', dateRange, validate, analyticsController.getSalesAnalytics);
// v2 dashboard — slim sales endpoint (summary + daily + by_channel only).
// ~125 ms cold vs 8 s for /analytics/sales.  Used by useDashboardMetrics.
router.get('/sales/summary', [
  query('date_from').optional().isISO8601(),
  query('date_to').optional().isISO8601(),
  query('mode').optional().isIn(['active', 'inactive', 'all']),
  query('ttl_override').optional().isInt({ min: 60, max: 86400 }).toInt(),
], validate, analyticsController.getSalesSummary);
// Sales drilldown — store-level OR sku-level pivot (`?type=store|sku&id=…`).
// Same v2 filter set composes; same 10-min Redis TTL via getOrSet.
router.get('/sales/drilldown', [
  ...dateRange,
  query('type').isIn(['store', 'sku']),
  query('id').isUUID(),
], validate, analyticsController.getSalesDrilldown);
router.get('/returns', dateRange, validate, analyticsController.getReturnsAnalytics);

// Overview cross-pivot — joins sales (movement) and inventory (snapshot)
// at the SKU+store grain in a single round-trip. Powers the Overview
// page's hero cross-page tables: best-sellers with network stock
// position, top stores with their SKU mix, and OOS-at-busy-stores
// transfer candidates. Cached 5 min per (mode + filter hash).
router.get('/overview/cross-pivot', analyticsController.getOverviewCrossPivot);

// v2 — sales aggregated to state level for the India heatmap.  Same date
// range + mode params as /sales so the map and the KPI cards stay in sync.
router.get('/state-heatmap', [
  query('date_from').optional().isISO8601(),
  query('date_to').optional().isISO8601(),
  query('mode').optional().isIn(['active', 'inactive', 'all']),
], validate, analyticsController.getStateHeatmap);

module.exports = router;
