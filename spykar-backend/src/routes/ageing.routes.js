// ─── Inventory Ageing routes — /api/v1/ageing ────────────────────────────────
// Reads the precomputed inventory_ageing table (warehouse FIFO + store
// continuous-on-hand). JWT-gated. Lens-filterable scope validated in-controller
// against a strict column whitelist.
const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const ctrl = require('../controllers/ageing.controller');

router.use(authenticate);

const SOURCE = ['warehouse', 'store'];
const MEASURE = ['units', 'gross', 'cost'];
const GROUP_BY = ['warehouse', 'state', 'city', 'channel', 'store',
                  'category', 'colour', 'color', 'size', 'product', 'gender', 'season'];
const STATUS = ['active', 'inactive', 'all'];
const SCOPE = ['state', 'city', 'channel', 'group_name', 'store', 'store_code', 'warehouse',
               'category', 'colour', 'color', 'size', 'product', 'gender', 'sub_product', 'season']
  .map((k) => query(k).optional().isString().trim());

router.get('/summary', [
  query('source').optional().isIn(SOURCE),
  query('status').optional().isIn(STATUS),
  ...SCOPE,
], validate, ctrl.getSummary);

router.get('/pivot', [
  query('source').optional().isIn(SOURCE),
  query('group_by').optional().isIn(GROUP_BY),
  query('measure').optional().isIn(MEASURE),
  query('status').optional().isIn(STATUS),
  ...SCOPE,
], validate, ctrl.getPivot);

router.get('/export.csv', [
  query('source').optional().isIn(SOURCE),
  query('group_by').optional().isIn(GROUP_BY),
  query('measure').optional().isIn(MEASURE),
  query('status').optional().isIn(STATUS),
  ...SCOPE,
], validate, ctrl.exportCsv);

module.exports = router;
