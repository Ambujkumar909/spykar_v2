// ─── Detached sync runner ─────────────────────────────────────────────────────
//
// Spawned by sync.controller.js → triggerSync as a fully detached child
// process. The point: a nodemon restart of the parent API server must NOT
// kill an in-flight sync.
//
// Lifecycle:
//   1. Parent spawns:  node src/scripts/run-sync.js <MANUAL|FULL>
//      with { detached: true, stdio: 'ignore' } and calls child.unref()
//   2. This script:
//      - loads .env via the same path the server uses
//      - calls runDeltaSync() — which INSERTs the sync_logs row, streams,
//        merges, UPDATEs sync_logs to SUCCESS
//      - exits 0 on success, 1 on failure
//   3. The parent has no handle to this process. The FE polls /sync/status
//      which reads sync_logs from Postgres — the single source of truth.
//
// Because the child has its own pid and its own DB / MSSQL connections,
// restarting the parent has zero effect on it.
//
// Cache invalidation: the parent API server's cache is an in-process Map
// (config/cache.js) that this child CANNOT reach. So we do NOT try to flush it
// here — instead the parent runs jobs/cacheInvalidator.js, which watches
// sync_logs and flushes + re-warms its own cache once this child writes the
// SUCCESS row. That keeps the dashboard fresh without any shared cache server.
//
// Argv:
//   process.argv[2] = 'MANUAL' (default) | 'FULL'

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const logger = require('../config/logger');
const { runDeltaSync } = require('../services/syncEngine');

const syncType = process.argv[2] === 'FULL' ? 'FULL' : 'MANUAL';

logger.info(`[DETACHED] Sync runner spawned (pid ${process.pid}, type ${syncType})`);

// ─── Cache invalidation is the PARENT's job ───────────────────────────────────
// This child can't touch the parent API server's in-process cache, so it does
// not connect to or warm any cache. runDeltaSync still calls invalidatePattern
// (harmless no-ops against this child's empty cache). Once the SUCCESS row
// lands in sync_logs, the parent's jobs/cacheInvalidator.js poller flushes and
// re-warms the live cache within its poll interval (~60s).
async function main() {
  try {
    const result = await runDeltaSync(syncType);
    logger.info(`[DETACHED] Sync runner complete: ${JSON.stringify({
      source: result.source,
      duration_ms: result.duration,
      ...result.stats,
    })}`);
  } catch (err) {
    logger.error(`[DETACHED] Sync runner failed: ${err.message}`);
    process.exitCode = 1;
  }

  // Give logger a beat to flush file writes, then exit.
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}

main();

// Safety: if something hangs forever (e.g., MSSQL request never responds),
// the watchdog kills us at 30 minutes so we don't leak a zombie.
// runDeltaSync's own logic should always terminate well before this.
setTimeout(() => {
  logger.error('[DETACHED] Sync runner watchdog tripped (30 min) — forcing exit');
  process.exit(2);
}, 30 * 60 * 1000).unref();
