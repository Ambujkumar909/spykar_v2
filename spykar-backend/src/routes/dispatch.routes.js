const express = require('express');
const router = express.Router();
const { query, param, body } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, paginationRules } = require('../middleware/validate');
const dispatchController = require('../controllers/dispatch.controller');

router.use(authenticate);

// GET /api/v1/dispatch
router.get('/', [
  ...paginationRules,
  query('status').optional().isIn(['PENDING','DISPATCHED','IN_TRANSIT','DELIVERED','CANCELLED','PARTIAL']),
  query('from_location_id').optional().isUUID(),
  query('to_location_id').optional().isUUID(),
  query('date_from').optional().isDate(),
  query('date_to').optional().isDate(),
  query('search').optional().trim(),
  query('courier').optional().trim(),
], validate, dispatchController.list);

// GET /api/v1/dispatch/in-transit
router.get('/in-transit', dispatchController.getInTransit);

// GET /api/v1/dispatch/summary
router.get('/summary', dispatchController.getSummary);

// GET /api/v1/dispatch/couriers
router.get('/couriers', dispatchController.getCouriers);

// GET /api/v1/dispatch/:id
router.get('/:id', [param('id').isUUID()], validate, dispatchController.getById);

// GET /api/v1/dispatch/:id/line-items
router.get('/:id/line-items', [param('id').isUUID()], validate, dispatchController.getLineItems);

// POST /api/v1/dispatch (Admin+)
router.post('/', authorize('SUPER_ADMIN', 'ADMIN', 'MANAGER'), [
  body('from_location_id').isUUID(),
  body('to_location_id').isUUID(),
  body('items').isArray({ min: 1 }),
  body('items.*.sku_id').isUUID(),
  body('items.*.qty_ordered').isInt({ min: 1 }),
  body('expected_at').optional().isISO8601(),
  body('notes').optional().trim(),
], validate, dispatchController.create);

// PATCH /api/v1/dispatch/:id/status
router.patch('/:id/status', authorize('SUPER_ADMIN', 'ADMIN', 'MANAGER'), [
  param('id').isUUID(),
  body('status').isIn(['DISPATCHED','IN_TRANSIT','DELIVERED','CANCELLED']),
  body('tracking_no').optional().trim(),
  body('courier_name').optional().trim(),
], validate, dispatchController.updateStatus);

module.exports = router;
