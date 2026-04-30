// location.routes.js
const express = require('express');
const router = express.Router();
const { query, param, body } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, paginationRules } = require('../middleware/validate');
const locationController = require('../controllers/location.controller');
const { getNetworkPulse } = require('../controllers/networkPulse.controller');

router.use(authenticate);

router.get('/zones', locationController.listZones);

// Network pulse — god-tier overview: hero KPIs, dead capital, top stores/
// states, channels, Pareto reveal, stock ageing, action lists. Same v2
// filter set as locations.list so every widget narrows together.
router.get('/network-pulse', getNetworkPulse);

router.get('/', [
  ...paginationRules,
  query('type').optional().isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  query('zone_id').optional().isInt().toInt(),
  query('city').optional().isString().trim(),
  query('state').optional().isString().trim(),
  query('group_name').optional().isString().trim(),
  query('search').optional().isString().trim(),
], validate, locationController.list);

router.get('/:id', [param('id').isUUID()], validate, locationController.getById);
router.get('/:id/summary', [param('id').isUUID()], validate, locationController.getSummary);

router.post('/', authorize('SUPER_ADMIN', 'ADMIN'), [
  body('code').notEmpty().trim(),
  body('name').notEmpty().trim(),
  body('type').isIn(['WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO']),
  body('zone_id').optional().isInt(),
  body('city').optional().trim(),
  body('state').optional().trim(),
], validate, locationController.create);

router.patch('/:id', authorize('SUPER_ADMIN', 'ADMIN'),
  [param('id').isUUID()], validate, locationController.update);

module.exports = router;
