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
router.get('/returns', analyticsController.getReturnsAnalytics);

module.exports = router;
