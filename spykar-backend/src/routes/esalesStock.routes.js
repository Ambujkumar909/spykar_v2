// ─── ESales Stock routes — /api/v1/esales-stock ──────────────────────────────
// Read-only partner stock snapshots (see esalesStock.controller.js). JWT-gated
// and validated like /primary-sales.
const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const ctrl = require('../controllers/esalesStock.controller');

router.use(authenticate);

const GROUP_BY = ['partner', 'channel', 'category', 'gender', 'product', 'sub_product', 'colour', 'color', 'size', 'season'];

const scopeRules = [
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
  query('measure').optional().isIn(['units', 'value', 'gross']),
  ...['partner', 'partner_name', 'channel', 'category', 'colour', 'color', 'size', 'product', 'sub_product', 'gender', 'season', 'shade', 'style']
    .map((k) => query(k).optional().isString().trim()),
];
const groupRule = query('group_by').optional().isIn(GROUP_BY);

router.get('/overview', scopeRules, validate, ctrl.getOverview);
router.get('/range', ctrl.getRange);
router.get('/sku-count', scopeRules, validate, ctrl.getSkuCount);
router.get('/trend', [...scopeRules, groupRule, query('top').optional().isInt({ min: 1, max: 20 }).toInt()], validate, ctrl.getTrend);
router.get('/pivot', [...scopeRules, groupRule], validate, ctrl.getPivot);
router.get('/export.csv', [...scopeRules, groupRule], validate, ctrl.exportCsv);
router.get('/items', [
  ...scopeRules,
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('sort').optional().isIn(['units', 'value', 'mrp', 'partners', 'barcode']),
  query('dir').optional().isIn(['asc', 'desc']),
  query('search').optional().isString().trim().isLength({ max: 60 }),
], validate, ctrl.getItems);
router.get('/item', [
  query('barcode').exists().isString().isLength({ max: 60 }),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
], validate, ctrl.getItem);
router.get('/filter-options', scopeRules, validate, ctrl.getFilterOptions);
router.get('/partners', ctrl.getPartners);
router.get('/channels', ctrl.getChannels);

module.exports = router;
