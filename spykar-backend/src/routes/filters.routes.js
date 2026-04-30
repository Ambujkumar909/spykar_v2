'use strict';
const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { getOptionsForDimension, getAllOptions } = require('../controllers/filters.controller');

// All filter endpoints require auth (same as the rest of the dashboard).
router.use(authenticate);

// Bulk fetch — every dimension in one round-trip (recommended for FilterBar mount)
router.get('/options',                getAllOptions);

// Per-dimension fetch — used when the user opens a single dropdown so we
// recompute that dimension's options under the latest cross-filter state.
router.get('/options/:dimension',     getOptionsForDimension);

module.exports = router;
