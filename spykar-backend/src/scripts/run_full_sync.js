/**
 * Standalone Full Sync Runner
 * Loads .env then triggers FULL pipeline (Jan 2024 → Jan 2026)
 * Usage: node src/scripts/run_full_sync.js
 */
'use strict';
require('dotenv').config();
const { runDeltaSync } = require('../services/syncEngine');

console.log('Starting FULL sync pipeline...\n');

runDeltaSync('FULL')
  .then(result => {
    console.log('\n✅ Pipeline complete:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Pipeline failed:', err.message);
    process.exit(1);
  });
