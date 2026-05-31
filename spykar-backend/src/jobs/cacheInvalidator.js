const { query } = require('../config/database');
const cache = require('../config/cache');
const logger = require('../config/logger');

// ─── Post-sync cache invalidator ──────────────────────────────────────────────
// The in-process cache (config/cache.js) lives in the API server's heap. The
// ETL sync runs in a SEPARATE detached process (scripts/run-sync.js), so it
// cannot reach this heap to invalidate stale entries after refreshing the data.
//
// This watcher closes that gap WITHOUT any shared cache server (no Redis): it
// polls sync_logs for the latest successful sync and, whenever it sees a newer
// completion than last time, flushes the whole cache and re-warms the hot
// endpoints. Net effect mirrors the old Redis cross-process invalidation —
// the dashboard shows fresh numbers within one poll interval (~60s) of a sync.

const POLL_INTERVAL_MS = parseInt(process.env.CACHE_INVALIDATOR_INTERVAL_MS) || 60000;

let lastSeenCompletedAt = null; // ms epoch of the newest SUCCESS we've acted on

async function checkAndFlush() {
  const res = await query(
    `SELECT MAX(completed_at) AS last FROM sync_logs WHERE status = 'SUCCESS'`
  );
  const raw = res.rows[0] && res.rows[0].last;
  const last = raw ? new Date(raw).getTime() : null;
  if (!last) return;

  // First observation just seeds the baseline — don't flush a freshly-warmed
  // cache on boot for a sync that happened before we started.
  if (lastSeenCompletedAt === null) {
    lastSeenCompletedAt = last;
    return;
  }

  if (last > lastSeenCompletedAt) {
    lastSeenCompletedAt = last;
    const cleared = cache.clear();
    logger.info(`🧹 New sync detected — flushed ${cleared} cache entr${cleared === 1 ? 'y' : 'ies'}; re-warming`);
    try {
      const { warmCaches } = require('../services/cacheWarmup');
      const t0 = Date.now();
      await warmCaches();
      logger.info(`🔥 Post-sync cache re-warm complete in ${Date.now() - t0}ms`);
    } catch (e) {
      logger.warn(`Post-sync re-warm skipped (${e.message}) — cache will self-heal on first request`);
    }
  }
}

function startCacheInvalidator() {
  // Seed the baseline immediately so the first interval tick has something to
  // compare against (and so a sync that finished before boot isn't mistaken
  // for a new one).
  checkAndFlush().catch((e) => logger.warn(`Cache invalidator seed failed: ${e.message}`));

  const timer = setInterval(() => {
    checkAndFlush().catch((e) => logger.warn(`Cache invalidator tick failed: ${e.message}`));
  }, POLL_INTERVAL_MS);
  timer.unref(); // never keep the process alive just for this poller

  logger.info(`🧹 Cache invalidator started (polls sync_logs every ${Math.round(POLL_INTERVAL_MS / 1000)}s)`);
}

module.exports = { startCacheInvalidator };
