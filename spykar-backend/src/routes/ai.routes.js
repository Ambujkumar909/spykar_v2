const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const aiController = require('../controllers/ai.controller');

router.use(authenticate);

// POST /api/v1/ai/query
// Natural language inventory query
router.post('/query', [
  body('question').notEmpty().isString().isLength({ min: 5, max: 500 })
    .withMessage('Question must be 5-500 characters'),
  body('context').optional().isObject(),
], validate, aiController.queryInventory);

// GET /api/v1/ai/history
// Query history for current user
router.get('/history', aiController.getHistory);

// GET /api/v1/ai/suggested-queries
// Pre-built useful queries
router.get('/suggested-queries', aiController.getSuggestedQueries);

module.exports = router;
