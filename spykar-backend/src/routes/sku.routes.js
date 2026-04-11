const express = require('express');
const router = express.Router();
const { query, param } = require('express-validator');
const skuController = require('../controllers/sku.controller');
const { authenticate } = require('../middleware/auth');
const { validate, paginationRules } = require('../middleware/validate');

router.use(authenticate);

// GET /api/v1/skus
router.get('/',
  [
    ...paginationRules,
    query('search').optional().isString().trim(),
    query('size').optional().isString().trim(),
    query('color_code').optional().isString().trim(),
    query('fit_type').optional().isString().trim(),
    query('is_active').optional().isBoolean().toBoolean(),
  ],
  validate,
  skuController.list
);

// GET /api/v1/skus/matrix
// Size × Color stock matrix heatmap data
router.get('/matrix',
  [
    query('location_id').optional().isUUID(),
    query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
    query('zone_id').optional().isInt().toInt(),
  ],
  validate,
  skuController.getSizeColorMatrix
);

// GET /api/v1/skus/sizes
// All available sizes with total stock
router.get('/sizes', skuController.getSizes);

// GET /api/v1/skus/colors
// All available colors with total stock
router.get('/colors', skuController.getColors);

// GET /api/v1/skus/top-moving
// Top N fastest moving SKUs
router.get('/top-moving',
  [
    query('n').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
    query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  ],
  validate,
  skuController.getTopMoving
);

// GET /api/v1/skus/slow-moving
// Dead or slow-moving stock
router.get('/slow-moving',
  [
    query('days').optional().isInt({ min: 30, max: 365 }).toInt(),
    query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  ],
  validate,
  skuController.getSlowMoving
);

// GET /api/v1/skus/:id
router.get('/:id',
  [param('id').isUUID()],
  validate,
  skuController.getById
);

// GET /api/v1/skus/:id/inventory-by-location
router.get('/:id/inventory-by-location',
  [
    param('id').isUUID(),
    query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  ],
  validate,
  skuController.getInventoryByLocation
);

module.exports = router;
