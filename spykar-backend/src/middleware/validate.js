const { validationResult, query, param, body } = require('express-validator');
const { AppError } = require('./errorHandler');

/**
 * Run validationResult and throw if errors found
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map(e => `${e.path}: ${e.msg}`).join(', ');
    return next(new AppError(`Validation failed: ${messages}`, 400));
  }
  next();
}

// ─── Common Validators ────────────────────────────────────────────────────────

const paginationRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100').toInt(),
];

const uuidParam = (name = 'id') => [
  param(name).isUUID().withMessage(`${name} must be a valid UUID`),
];

const inventoryFiltersRules = [
  query('location_type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  query('zone_id').optional().isInt(),
  query('size').optional().isString().trim(),
  query('color_code').optional().isString().trim(),
  query('sku_code').optional().isString().trim(),
  query('min_qty').optional().isInt({ min: 0 }).toInt(),
  query('max_qty').optional().isInt({ min: 0 }).toInt(),
  query('below_safety').optional().isBoolean().toBoolean(),
  query('date_from').optional().isDate(),
  query('date_to').optional().isDate(),
  query('sort_by').optional().isIn(['qty_on_hand', 'qty_available', 'stock_value', 'location_name']),
  query('sort_order').optional().isIn(['ASC', 'DESC']),
];

module.exports = { validate, paginationRules, uuidParam, inventoryFiltersRules };
