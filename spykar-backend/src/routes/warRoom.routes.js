// ─── War Room routes — /api/v1/war-room ──────────────────────────────────────
// JWT-gated. Anyone signed in reads the board and writes ASM notes. Every
// input is validated; the only parameters reaching SQL are bound values.
const express = require('express');
const router = express.Router();
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const ctrl = require('../controllers/warRoom.controller');

router.use(authenticate);

const scope = [
  query('as_on').optional().isISO8601({ strict: true }).isLength({ min: 10, max: 10 }),
  ...['gender', 'category', 'product', 'sub_product', 'size', 'color', 'season'].map((k) => query(k).optional().isString().trim().isLength({ max: 2000 })),
];

router.get('/meta', ctrl.getMeta);
router.get('/board', scope, validate, ctrl.getBoard);
router.get('/filter-options', [query('as_on').optional().isISO8601({ strict: true }),
  ...['wr_channel', 'wr_region', 'wr_type', 'wr_asm', 'state', 'city', 'store_code', 'gender', 'category', 'product', 'sub_product', 'size', 'color', 'season']
    .map((k) => query(k).optional().isString().isLength({ max: 4000 }))], validate, ctrl.getFilterOptions);
router.get('/export.xlsx', scope, validate, ctrl.exportXlsx);
router.get('/notes', [query('week_start').isISO8601({ strict: true })], validate, ctrl.getNotes);
router.put('/notes', [
  body('week_start').isISO8601({ strict: true }),
  body('external_id').isString().trim().matches(/^[A-Za-z0-9_-]{1,40}$/),
  body('asm').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  ...['reason', 'action'].map((k) => body(k).optional({ nullable: true }).isString().trim().isLength({ max: 2000 })),
], validate, ctrl.saveNote);

module.exports = router;
