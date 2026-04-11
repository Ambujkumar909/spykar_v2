const express = require('express');
const router = express.Router();
const { query, param } = require('express-validator');
const distributorController = require('../controllers/distributor.controller');
const { authenticate } = require('../middleware/auth');
const { validate, paginationRules } = require('../middleware/validate');

router.use(authenticate);

// GET /api/v1/distributors
router.get('/',
  [
    ...paginationRules,
    query('zone_id').optional().isInt().toInt(),
    query('state').optional().isString().trim(),
    query('search').optional().isString().trim(),
    query('sort_by').optional().isIn(['total_stock', 'stock_value', 'name', 'sku_count']),
    query('sort_order').optional().isIn(['ASC', 'DESC']),
  ],
  validate,
  distributorController.list
);

// GET /api/v1/distributors/top
// Top N distributors — filterable by size, color
router.get('/top',
  [
    query('n').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('size').optional().isString().trim(),
    query('color_code').optional().isString().trim(),
    query('zone_id').optional().isInt().toInt(),
    query('metric').optional().isIn(['qty_on_hand', 'qty_available', 'stock_value']),
  ],
  validate,
  distributorController.getTop
);

// GET /api/v1/distributors/comparison
// Side-by-side comparison of distributors
router.get('/comparison',
  [query('ids').notEmpty().withMessage('Comma-separated distributor IDs required')],
  validate,
  distributorController.compare
);

// GET /api/v1/distributors/:id
router.get('/:id',
  [param('id').isUUID()],
  validate,
  distributorController.getById
);

// GET /api/v1/distributors/:id/inventory
router.get('/:id/inventory',
  [
    param('id').isUUID(),
    query('size').optional().isString(),
    query('color_code').optional().isString(),
    ...paginationRules,
  ],
  validate,
  distributorController.getInventory
);

// GET /api/v1/distributors/:id/movements
router.get('/:id/movements',
  [param('id').isUUID(), ...paginationRules],
  validate,
  distributorController.getMovements
);

// GET /api/v1/distributors/:id/ageing
router.get('/:id/ageing',
  [param('id').isUUID()],
  validate,
  distributorController.getAgeing
);

module.exports = router;
