const express = require('express');
const { body } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const ctrl = require('../controllers/license.controller');

const router = express.Router();
router.get('/', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), ctrl.getLicense);
router.post('/apply', authenticate, authorize('SUPER_ADMIN', 'ADMIN'),
  [body('key').isString().isLength({ min: 20, max: 4000 }).withMessage('Paste the licence key')], validate, ctrl.applyKey);
module.exports = router;
