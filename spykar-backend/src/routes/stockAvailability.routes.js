// ─── Stock Availability routes — /api/v1/stock-availability ──────────────────
// Read-only "stock over time" endpoints. JWT-gated like /analytics. Validators
// mirror analytics.routes.js conventions (express-validator + validate).
const express = require('express');
const router = express.Router();
const { query, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const ctrl = require('../controllers/stockAvailability.controller');

router.use(authenticate);

const GROUP_BY = ['state', 'city', 'channel', 'store', 'category', 'colour', 'color', 'size'];
const MEASURE = ['units', 'gross', 'cost'];
const STATUS = ['active', 'inactive', 'all'];
const PERIOD = ['Today', 'WTD', 'MTD', 'QTD', 'YTD', 'custom',
                'today', 'wtd', 'mtd', 'qtd', 'ytd'];

// A) Summary KPIs at a point in time.
router.get('/summary', [
  query('as_of').optional().isISO8601(),
  query('status').optional().isIn(STATUS),
  query('measure').optional().isIn(MEASURE),
], validate, ctrl.getSummary);

// B) Multi-line stock-on-hand trend per top-N dimension member.
router.get('/trend', [
  query('group_by').optional().isIn(GROUP_BY),
  query('period').optional().isIn(PERIOD),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
  query('measure').optional().isIn(MEASURE),
  query('status').optional().isIn(STATUS),
  query('top').optional().isInt({ min: 1, max: 20 }).toInt(),
], validate, ctrl.getTrend);

// C) Pivot table by dimension (stock now, 30d avg, delta, cover days).
router.get('/pivot', [
  query('group_by').optional().isIn(GROUP_BY),
  query('as_of').optional().isISO8601(),
  query('measure').optional().isIn(MEASURE),
  query('status').optional().isIn(STATUS),
], validate, ctrl.getPivot);

// E) CSV export — same filters as /pivot. (Declared before the param route.)
router.get('/export.csv', [
  query('group_by').optional().isIn(GROUP_BY),
  query('as_of').optional().isISO8601(),
  query('measure').optional().isIn(MEASURE),
  query('status').optional().isIn(STATUS),
], validate, ctrl.exportCsv);

// D) Single-store day-wise stock vs sales.
router.get('/store/:locationId/trend', [
  param('locationId').isUUID(),
  query('period').optional().isIn(PERIOD),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
], validate, ctrl.getStoreTrend);

module.exports = router;
