// ─── Primary Sales routes — /api/v1/primary-sales ────────────────────────────
// Read-only warehouse-level primary-sales (MITTRA) endpoints. JWT-gated like
// /stock-availability. Validators mirror those conventions.
const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const ctrl = require('../controllers/primarySales.controller');

router.use(authenticate);

const GROUP_BY = ['warehouse', 'type', 'category', 'colour', 'color', 'size', 'product'];
const MEASURE = ['units', 'gross', 'cost'];
const PERIOD = ['Today', 'WTD', 'MTD', 'QTD', 'YTD', 'custom',
                'today', 'wtd', 'mtd', 'qtd', 'ytd'];

const scopeRules = [
  query('period').optional().isIn(PERIOD),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
  query('measure').optional().isIn(MEASURE),
  query('warehouse').optional().isString().trim(),
  query('type').optional().isString().trim(),
  query('category').optional().isString().trim(),
  query('colour').optional().isString().trim(),
  query('color').optional().isString().trim(),
  query('size').optional().isString().trim(),
  query('product').optional().isString().trim(),
  query('sub_product').optional().isString().trim(),
  query('gender').optional().isString().trim(),
  query('season').optional().isString().trim(),
];

// A) Summary KPIs over a date window.
router.get('/summary', scopeRules, validate, ctrl.getSummary);

// G) Overview — full briefing dataset in one round-trip (powers the page).
router.get('/overview', scopeRules, validate, ctrl.getOverview);

// H) Data range — min/max TRDT with data (defaults the Custom date picker).
router.get('/range', ctrl.getRange);

// B) Multi-line daily trend per top-N dimension member.
router.get('/trend', [
  ...scopeRules,
  query('group_by').optional().isIn(GROUP_BY),
  query('top').optional().isInt({ min: 1, max: 20 }).toInt(),
], validate, ctrl.getTrend);

// C) Pivot table by dimension (qty, value, txns, avg price, delta).
router.get('/pivot', [
  ...scopeRules,
  query('group_by').optional().isIn(GROUP_BY),
], validate, ctrl.getPivot);

// F) CSV export — same filters as /pivot. (Declared before any param routes.)
router.get('/export.csv', [
  ...scopeRules,
  query('group_by').optional().isIn(GROUP_BY),
], validate, ctrl.exportCsv);

// D) Transaction-type list (filter dropdown).
router.get('/types', ctrl.getTypes);

// E) Warehouse list (filter dropdown).
router.get('/warehouses', ctrl.getWarehouses);

module.exports = router;
