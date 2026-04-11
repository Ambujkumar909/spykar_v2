const cron = require('node-cron');
const { runDeltaSync } = require('../services/syncEngine');
const logger = require('../config/logger');

let isRunning = false;

function startScheduler() {
  // Daily delta sync — every day at 9:30 PM (after evening SQL Server sync completes)
  cron.schedule(process.env.SYNC_CRON || '30 21 * * *', async () => {
    if (isRunning) {
      logger.warn('Sync already running, skipping scheduled run');
      return;
    }
    isRunning = true;
    try {
      logger.info('⏰ Scheduled delta sync starting...');
      await runDeltaSync('DELTA');
    } catch (err) {
      logger.error('Scheduled sync failed:', err.message);
    } finally {
      isRunning = false;
    }
  }, { timezone: 'Asia/Kolkata' });

  logger.info('📅 Sync scheduler initialized (runs 9:30 PM IST daily)');
}

module.exports = { startScheduler };
