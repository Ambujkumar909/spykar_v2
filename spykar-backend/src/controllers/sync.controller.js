const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { query } = require('../config/database');
const { SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID } = require('../services/syncEngine');
const logger = require('../config/logger');

// ─── Where the detached sync child's stdout/stderr lands ─────────────────────
// We can't pipe to the parent's terminal — pipes break when nodemon
// SIGTERMs the parent, which would kill the detached child too. Files
// survive parent restart cleanly.
//
// Tail this from another terminal during a sync:
//    powershell> Get-Content logs\sync-child.log -Wait -Tail 50
//    bash>       tail -f logs/sync-child.log
//
// Winston's own combined.log still captures every logger.info call too —
// this file just gives a focused, sync-only view.
const SYNC_CHILD_LOG = path.join(process.cwd(), 'logs', 'sync-child.log');

// ─── Why this controller no longer holds an `activeSyncPromise` in memory ────
//
// Manual syncs now run in a DETACHED child process (see scripts/run-sync.js).
// The reason: a nodemon restart of this API server must not kill an in-flight
// sync. A detached child has its own pid, its own DB/MSSQL/Redis connections,
// and survives parent restarts.
//
// Consequence: "is a sync running?" is no longer answerable from JS memory —
// the API process might have restarted while the child kept going, or the
// sync might be running in a completely different process (k8s, cron, etc.).
// The only honest answer is the database: `sync_logs` is the single source
// of truth. Every read below queries it directly.

async function getStatus(req, res, next) {
  try {
    // ─── Fast liveness reaper (advisory-lock based) ────────────────────────
    // The running sync child holds an advisory lock on a dedicated PG
    // client. If the child dies — crash, kill, console-close cascade —
    // the TCP connection drops and Postgres releases the lock. We can
    // detect that here by reading pg_locks (no acquisition, no race with
    // a starting sync). Any RUNNING row + no live lock = orphan, reap it.
    //
    // Detection latency: <1 poll cycle. The legacy 30-min wall-clock
    // reaper is kept below as a safety net for the unlikely case where
    // the lock somehow leaks (e.g., a network partition where the TCP
    // FIN never arrives but the Postgres connection's keepalive hasn't
    // tripped yet — typically <10 min).
    const liveness = await query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory'
           AND classid = $1 AND objid = $2 AND granted = true
       ) AS held`,
      [SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID]
    );
    if (!liveness.rows[0].held) {
      await query(`
        UPDATE sync_logs
        SET status = 'FAILED', completed_at = NOW(),
            error_message = 'Sync process died — advisory lock no longer held'
        WHERE status = 'RUNNING'
      `);
    }

    // Wall-clock safety net (kept for the rare case where the lock check
    // misclassifies — e.g., during DB restart, the lock briefly appears
    // gone but the child reconnects and re-acquires). 30 min is well
    // beyond any plausible real sync duration.
    await query(`
      UPDATE sync_logs
      SET status = 'FAILED', completed_at = NOW(),
          error_message = 'Sync exceeded maximum duration without completion (wall-clock reaper)'
      WHERE status = 'RUNNING'
        AND started_at < NOW() - INTERVAL '30 minutes'
    `);

    // ─── Prefer the RUNNING row, fall back to the latest terminal row ──────
    // Same logic as before: a RUNNING row is what the user wants to see.
    // Falling back to the latest by started_at would surface a stale
    // FAILED row when a fresh sync's INSERT hasn't quite landed yet.
    const runningRow = await query(`
      SELECT id, sync_type, status, source, records_fetched, records_inserted,
             records_updated, records_failed, error_message, started_at, completed_at, duration_ms
      FROM sync_logs
      WHERE status = 'RUNNING'
      ORDER BY started_at DESC
      LIMIT 1
    `);

    let data = runningRow.rows[0];
    if (!data) {
      const latest = await query(`
        SELECT id, sync_type, status, source, records_fetched, records_inserted,
               records_updated, records_failed, error_message, started_at, completed_at, duration_ms
        FROM sync_logs
        ORDER BY started_at DESC
        LIMIT 1
      `);
      data = latest.rows[0] || null;
    }

    // isRunning is now strictly a function of the DB. No in-memory flag.
    // The detached child writes the RUNNING row before any heavy work and
    // updates it to SUCCESS/FAILED on completion, so this is authoritative.
    const isRunning = !!(data && data.status === 'RUNNING');

    res.json({ success: true, data, isRunning });
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

// ─── Trigger a manual sync (detached child process) ───────────────────────────
//
// Key design points:
//
//   1. Concurrency guard reads sync_logs, not in-memory state. A second
//      Trigger Sync click while a child is still running returns 409.
//      We use a 30-min wall-clock window so a genuinely-orphaned RUNNING
//      row (from before the orphan reaper ran) doesn't permanently block
//      new triggers.
//
//   2. The child is spawned with detached:true + stdio:'ignore' and we
//      call child.unref(). This severs every tie to the parent's event
//      loop and stdio pipes — nodemon SIGTERMing the parent does NOT
//      cascade to the child.
//
//   3. The child runs scripts/run-sync.js, which simply calls
//      runDeltaSync(syncType). All the existing pipeline behaviour
//      (sync_logs INSERT, streaming COPY, merge, Redis invalidation,
//      sync_logs UPDATE to SUCCESS) happens inside the child unchanged.
//
//   4. We respond 202 (Accepted) instead of 200 — semantically clearer
//      that work is happening asynchronously elsewhere.
async function triggerSync(req, res, next) {
  try {
    // Concurrency guard — only 409 if the lock is genuinely held by a
    // live process. A RUNNING row whose holder has died is fair game
    // for re-trigger (and the lock-based reaper above will clean it up
    // when getStatus next polls).
    const liveLock = await query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
         WHERE locktype='advisory' AND classid=$1 AND objid=$2 AND granted=true
       ) AS held`,
      [SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID]
    );
    if (liveLock.rows[0].held) {
      const inFlight = await query(`
        SELECT id, started_at, sync_type FROM sync_logs
        WHERE status = 'RUNNING' ORDER BY started_at DESC LIMIT 1
      `);
      return res.status(409).json({
        success: false,
        message: 'A sync is already in progress.',
        runningSince: inFlight.rows[0]?.started_at,
        runningType: inFlight.rows[0]?.sync_type,
      });
    }

    const syncType = req.body?.type === 'FULL' ? 'FULL' : 'MANUAL';
    logger.info(`Manual sync triggered by ${req.user.email} (type=${syncType}) — spawning detached child`);

    // Resolve absolute paths so spawn isn't sensitive to where the API
    // server was started from.
    const scriptPath  = path.join(__dirname, '..', 'scripts', 'run-sync.js');
    const projectRoot = path.join(__dirname, '..', '..');

    // Open the child's log file in APPEND mode and hand the OS file
    // descriptors to spawn(). The child writes stdout/stderr straight to
    // disk — no Node IPC, no pipe to break when nodemon SIGTERMs us.
    // mkdir -p the logs directory in case it doesn't exist yet.
    fs.mkdirSync(path.dirname(SYNC_CHILD_LOG), { recursive: true });
    const childOut = fs.openSync(SYNC_CHILD_LOG, 'a');
    const childErr = fs.openSync(SYNC_CHILD_LOG, 'a');

    const child = spawn(process.execPath, [scriptPath, syncType], {
      detached: true,
      // stdio: [stdin, stdout, stderr] — stdin ignored, the other two go
      // to our log file. The fds are duplicated by the OS into the child,
      // so we can close them in the parent immediately after spawn.
      stdio: ['ignore', childOut, childErr],
      cwd: projectRoot,
      env: process.env,            // share .env / DB creds
      windowsHide: true,
    });

    // Release the parent's copies of the fds (the child has its own copies
    // from spawn dup'ing them). Without this, nodemon restart of the
    // parent could leave the file open and confuse log rotation.
    fs.closeSync(childOut);
    fs.closeSync(childErr);

    // unref() lets the parent event loop exit without waiting on the child.
    // Combined with detached:true and fd-redirect stdio, this fully severs
    // the child from the parent's lifecycle on Windows and POSIX.
    child.unref();

    logger.info(`Manual sync child spawned (pid ${child.pid}) — tail logs/sync-child.log to watch progress`);

    res.status(202).json({
      success: true,
      message: 'Sync started (detached). Check /sync/status for progress.',
      childPid: child.pid,
      syncType,
      tailCommand: 'tail -f logs/sync-child.log  (or: Get-Content logs\\sync-child.log -Wait -Tail 50)',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, getLogs, triggerSync };
