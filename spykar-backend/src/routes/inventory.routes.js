const express = require('express');
const router = express.Router();
const { query, param, body } = require('express-validator');
const inventoryController = require('../controllers/inventory.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, paginationRules, inventoryFiltersRules } = require('../middleware/validate');

// All routes require auth
router.use(authenticate);

// GET /api/v1/inventory/executive-summary
// Top-level KPIs across entire network
router.get('/executive-summary', inventoryController.getExecutiveSummary);

// GET /api/v1/inventory/snapshot
// Full inventory snapshot with filters & pagination
router.get('/snapshot',
  [...paginationRules, ...inventoryFiltersRules],
  validate,
  inventoryController.getSnapshot
);

// GET /api/v1/inventory/snapshot/export
// Export inventory to CSV
router.get('/snapshot/export',
  [...inventoryFiltersRules],
  validate,
  inventoryController.exportSnapshot
);

// GET /api/v1/inventory/location/:locationId
// Inventory at a specific location
router.get('/location/:locationId',
  [param('locationId').isUUID()],
  validate,
  inventoryController.getLocationInventory
);

// GET /api/v1/inventory/sku/:skuId
// Inventory for a specific SKU across all locations
router.get('/sku/:skuId',
  [param('skuId').isUUID()],
  validate,
  inventoryController.getSkuInventory
);

// GET /api/v1/inventory/alerts
// Low stock and critical alerts
router.get('/alerts', inventoryController.getAlerts);

// GET /api/v1/inventory/movements
// Movement ledger with filters
router.get('/movements',
  [
    ...paginationRules,
    query('location_id').optional().isUUID(),
    query('sku_id').optional().isUUID(),
    query('movement_type').optional().isIn(['SALE','DISPATCH','RECEIPT','RETURN','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT']),
    query('date_from').optional().isDate(),
    query('date_to').optional().isDate(),
  ],
  validate,
  inventoryController.getMovements
);

// GET /api/v1/inventory/ageing
// Stock ageing report
router.get('/ageing',
  [...inventoryFiltersRules],
  validate,
  inventoryController.getAgeing
);

// POST /api/v1/inventory/adjust (Admin only)
// Manual stock adjustment
router.post('/adjust',
  authorize('SUPER_ADMIN', 'ADMIN'),
  [
    body('location_id').isUUID(),
    body('sku_id').isUUID(),
    body('qty_change').isInt(),
    body('reason').notEmpty().trim(),
  ],
  validate,
  inventoryController.adjustStock
);

module.exports = router;
