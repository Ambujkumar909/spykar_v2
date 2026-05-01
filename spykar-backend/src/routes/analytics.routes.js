// analytics.routes.js
const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const analyticsController = require('../controllers/analytics.controller');

router.use(authenticate);

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

router.get('/sales', analyticsController.getSalesAnalytics);
// Sales drilldown — store-level OR sku-level pivot (`?type=store|sku&id=…`).
// Same v2 filter set composes; same 10-min Redis TTL via getOrSet.
router.get('/sales/drilldown', analyticsController.getSalesDrilldown);
router.get('/returns', analyticsController.getReturnsAnalytics);

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
