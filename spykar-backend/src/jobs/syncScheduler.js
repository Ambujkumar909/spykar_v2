const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const cron = require('node-cron');
const { query } = require('../config/database');
const logger = require('../config/logger');

// Same log target the manual trigger uses — one place to tail for both.
const SYNC_CHILD_LOG = path.join(process.cwd(), 'logs', 'sync-child.log');

// ─── Scheduled sync — runs in a DETACHED child, same as manual trigger ───────
//
// Why detached: a deploy / nodemon restart / OS update / crash between
// 11 PM and ~11:15 PM would otherwise kill the in-process sync and leave a
// RUNNING row in sync_logs that the orphan reaper would later flip to
// FAILED. The morning dashboard would show a red FAILED banner even though
// nothing was wrong with the data — the sync just got murdered by its
// parent's lifecycle.
//
// By spawning the same scripts/run-sync.js that the manual button uses,
// the scheduled sync becomes immune to parent restarts. The child writes
// its own sync_logs row and runs to completion regardless of what happens
// to this API process.
//
// Concurrency: we replace the in-memory `isRunning` flag with a DB query
// (any RUNNING row younger than 30 min means a sync is in flight). The
// flag-in-memory version was useless across restarts anyway; the DB check
// is the only honest signal.

function startScheduler() {
  cron.schedule(process.env.SYNC_CRON || '0 23 * * *', async () => {
    try {
      // Cross-process concurrency guard. If a manual sync (or yesterday's
      // wedged scheduled sync) is still in flight inside the 30-min
      // window, skip this tick. After 30 min the reaper has cleared it.
      const inFlight = await query(
        `SELECT id FROM sync_logs
         WHERE status = 'RUNNING' AND started_at > NOW() - INTERVAL '30 minutes'
         LIMIT 1`
      );
      if (inFlight.rows.length > 0) {
        logger.warn('Scheduled sync skipped — another sync is already in flight');
        return;
      }

      const scriptPath  = path.join(__dirname, '..', 'scripts', 'run-sync.js');
      const projectRoot = path.join(__dirname, '..', '..');

      // Mirror the manual-trigger fd-redirect so the 11 PM sync's stdout
      // also lands in logs/sync-child.log. Anyone tailing that file can
      // watch the nightly sync stream live.
      fs.mkdirSync(path.dirname(SYNC_CHILD_LOG), { recursive: true });
      const childOut = fs.openSync(SYNC_CHILD_LOG, 'a');
      const childErr = fs.openSync(SYNC_CHILD_LOG, 'a');

      const child = spawn(process.execPath, [scriptPath, 'DELTA'], {
        detached: true,
        stdio: ['ignore', childOut, childErr],
        cwd: projectRoot,
        env: process.env,
        windowsHide: true,
      });

      fs.closeSync(childOut);
      fs.closeSync(childErr);
      child.unref();

      logger.info(`⏰ Scheduled delta sync spawned (detached child pid ${child.pid}) — output → logs/sync-child.log`);
    } catch (err) {
      // The spawn itself failing is the only thing we can catch here —
      // the child's own success/failure is recorded in sync_logs.
      logger.error('Scheduled sync spawn failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  logger.info('📅 Sync scheduler initialized (runs 11:00 PM IST daily, detached child)');
}

module.exports = { startScheduler };
