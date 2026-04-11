const { runDeltaSync } = require('../services/syncEngine');
const { query } = require('../config/database');
const logger = require('../config/logger');

let activeSyncPromise = null;

async function getStatus(req, res, next) {
  try {
    // Auto-fix: if a sync_log is stuck RUNNING but no sync is actually running, mark it FAILED
    if (!activeSyncPromise) {
      await query(`
        UPDATE sync_logs
        SET status = 'FAILED', completed_at = NOW(),
            error_message = 'Process interrupted (server restarted while sync was running)'
        WHERE status = 'RUNNING'
      `);
    }

    const result = await query(`
      SELECT id, sync_type, status, source, records_fetched, records_inserted,
             records_updated, records_failed, error_message, started_at, completed_at, duration_ms
      FROM sync_logs
      ORDER BY started_at DESC
      LIMIT 1
    `);
    res.json({ success: true, data: result.rows[0] || null, isRunning: activeSyncPromise !== null });
  } catch (err) {
    next(err);
  }
}

async function getLogs(req, res, next) {
  try {
    const result = await query(`
      SELECT id, sync_type, status, source, records_fetched, records_inserted, records_updated, records_failed,
             error_message, started_at, completed_at, duration_ms
      FROM sync_logs
      ORDER BY started_at DESC
      LIMIT 50
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

async function triggerSync(req, res, next) {
  try {
    if (activeSyncPromise) {
      return res.status(409).json({ success: false, message: 'A sync is already in progress.' });
    }

    logger.info(`Manual sync triggered by ${req.user.email}`);

    const syncType = req.body?.type === 'FULL' ? 'FULL' : 'MANUAL';
    activeSyncPromise = runDeltaSync(syncType)
      .catch(err => logger.error('Manual sync error:', err.message))
      .finally(() => { activeSyncPromise = null; });

    res.json({ success: true, message: 'Sync started. Check /sync/status for progress.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, getLogs, triggerSync };
