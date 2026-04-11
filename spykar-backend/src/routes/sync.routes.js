const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const syncController = require('../controllers/sync.controller');

router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));

// GET /api/v1/sync/status
router.get('/status', syncController.getStatus);

// GET /api/v1/sync/logs
router.get('/logs', syncController.getLogs);

// POST /api/v1/sync/trigger
// Manually trigger a sync
router.post('/trigger', syncController.triggerSync);

module.exports = router;
