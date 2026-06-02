require('dotenv').config();
// API-process-only per-query cap. Set BEFORE config/database creates the pool
// (lazy, on first connect at connectDatabase below). 40 s sits just under the
// 45 s HTTP timeout in app.js so a pathological query is killed at the DB —
// returning a clean error and freeing its pool connection — rather than the
// socket abandoning a query that keeps running and pinning the connection.
// The detached sync (run-sync.js / run_full_sync.js) forces this to 0, so its
// multi-minute COPY/merges are never affected. Measured-safe: export = 705 ms,
// 1-yr sales ≈ 18 s; only full multi-year ranges (already >45 s) get capped.
if (process.env.PG_STATEMENT_TIMEOUT === undefined) {
  process.env.PG_STATEMENT_TIMEOUT = '40000';
}
const app = require('./app');
const logger = require('./config/logger');
const { connectDatabase } = require('./config/database');
const { startScheduler } = require('./jobs/syncScheduler');
const { startCacheInvalidator } = require('./jobs/cacheInvalidator');

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  try {
    logger.info('🚀 Spykar Inventory API starting...');

    // Connect to PostgreSQL
    await connectDatabase();
    logger.info('✅ PostgreSQL connected');

    // ─── Boot-time stale sync reaper ──────────────────────────────────────
    // Since manual syncs now run in DETACHED child processes (see
    // scripts/run-sync.js + controllers/sync.controller.js#triggerSync),
    // an API server restart does NOT mean the sync is dead. A child started
    // before this restart can still be streaming COPY rows into Postgres
    // right now. Blindly flipping every RUNNING row to FAILED here — as
    // the original code did — would falsely report a healthy sync as
    // crashed and confuse the dashboard.
    //
    // The honest signal is wall-clock age: a sync running > 30 min is
    // either truly orphaned OR is a FULL sync taking unusually long. The
    // runtime orphan reaper in getStatus uses the same 30-min threshold;
    // we mirror it here so boot doesn't kill anything younger.
    const { pool: dbPool } = require('./config/database');
    const { SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID } = require('./services/syncEngine');
    const dbClient = await dbPool.connect();
    try {
      // Two-tier reap on boot:
      //   1. Lock-based — if no process holds the sync advisory lock, any
      //      RUNNING row is from a dead child. Reap immediately.
      //   2. Wall-clock safety net — anything > 30 min in RUNNING state
      //      regardless of lock state (handles network-partition edge case).
      const livenessReap = await dbClient.query(
        `WITH live AS (
           SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE locktype='advisory' AND classid=$1 AND objid=$2 AND granted=true
           ) AS held
         )
         UPDATE sync_logs
         SET status = 'FAILED', completed_at = NOW(),
             error_message = 'Process died — advisory lock released on boot reap'
         WHERE status = 'RUNNING'
           AND (SELECT NOT held FROM live)
         RETURNING id`,
        [SYNC_LOCK_CLASSID, SYNC_LOCK_OBJID]
      );
      if (livenessReap.rowCount > 0) {
        logger.warn(`Reaped ${livenessReap.rowCount} dead RUNNING sync log(s) (advisory lock not held)`);
      }

      const stale = await dbClient.query(
        `UPDATE sync_logs SET status = 'FAILED', completed_at = NOW(),
         error_message = 'Process interrupted (server restart + sync exceeded 30 min)'
         WHERE status = 'RUNNING'
           AND started_at < NOW() - INTERVAL '30 minutes'
         RETURNING id`
      );
      if (stale.rowCount > 0) {
        logger.warn(`Reaped ${stale.rowCount} truly orphaned RUNNING sync log(s) (> 30 min old)`);
      }
    } finally {
      dbClient.release();
    }

    // Run migrations asynchronously (skips files already applied)
    const { migrate } = require('./database/migrate');
    try {
      await migrate();
      logger.info('✅ Migrations applied');
      // Verify unique constraints exist.
      // CRITICAL: these statements take AccessExclusiveLock. If a stale
      // backend or an "idle in transaction" session is holding the table,
      // they will wait forever and block server boot. Set lock_timeout so
      // we fail fast and continue starting — the constraints are
      // idempotent and will be retried on the next clean boot.
      const { pool } = require('./config/database');
      const client = await pool.connect();
      try {
        // NOTE: must be session-level SET (not SET LOCAL). node-pg runs
        // each query in autocommit, so SET LOCAL would be discarded
        // immediately and the next statement would run with no timeout.
        // We release this client right after, so the session-level
        // setting never leaks back into the pool's regular traffic.
        await client.query(`SET lock_timeout = '5s'`);
        await client.query(`SET statement_timeout = '15s'`);
        await client.query(`
          DO $$ BEGIN
            BEGIN ALTER TABLE locations       ADD CONSTRAINT uq_locations_external_id UNIQUE (external_id); EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END;
            BEGIN ALTER TABLE skus            ADD CONSTRAINT uq_skus_external_id      UNIQUE (external_id); EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END;
            BEGIN ALTER TABLE dispatch_orders ADD CONSTRAINT uq_dispatch_external_id  UNIQUE (external_id); EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END;
          END $$;
        `);
        // NOTE: the old uq_inv_movements_notes UNIQUE index on
        // inventory_movements(notes) was REMOVED. Migration 011 drops it
        // because nothing queries the free-text `notes` column (idx_scan=0)
        // and it forced an extra unique-index probe on every one of the
        // millions of rows a sync inserts. Recreating it here on every boot
        // silently undid migration 011 and re-added that per-row write
        // overhead. The dispatch sync's ON CONFLICT uses the
        // (location_id, sku_id, movement_type, reference_no, moved_at) key,
        // never `notes`, so this index was pure dead weight. Do not re-add it.
        logger.info('✅ Constraints verified');
      } catch (lockErr) {
        // 55P03 = lock_not_available, 57014 = query_canceled (statement_timeout)
        if (lockErr.code === '55P03' || lockErr.code === '57014') {
          logger.warn(`Constraint verification skipped — table locked by another session (${lockErr.code}). Boot continues; will retry next start.`);
        } else {
          logger.warn('Constraint verification warning:', lockErr.message);
        }
      } finally {
        // RESET the session-level timeouts before returning this client to
        // the pool, otherwise long-running app queries (cache warm-up,
        // dashboards, alerts) would inherit the 15s cap and get cancelled.
        try { await client.query(`RESET lock_timeout`); } catch (_) {}
        try { await client.query(`RESET statement_timeout`); } catch (_) {}
        client.release();
      }
    } catch (e) {
      logger.warn('Startup migration warning:', e.message);
    }

    // In-process cache (config/cache.js) — no external service. The sync runs
    // in a detached process, so a watcher flushes + re-warms this cache when a
    // sync completes (keeps the dashboard fresh without a shared cache server).
    startCacheInvalidator();

    // Start ETL sync scheduler
    if (process.env.ENABLE_SCHEDULER === 'true') {
      startScheduler();
      logger.info('✅ ETL Scheduler started');
    }

    // Start HTTP server
    const server = app.listen(PORT, HOST, () => {
      logger.info(`✅ Server running at http://${HOST}:${PORT}`);
      logger.info(`✅ Environment: ${process.env.NODE_ENV}`);

      // ─── Cache warm-up: pre-populate heavy endpoints in the background ──────
      // Fires after server is listening so it never blocks readiness.
      // Any warm-up failure is logged and swallowed — user traffic still serves cold.
      setImmediate(async () => {
        try {
          const { warmCaches, startPeriodicRewarm } = require('./services/cacheWarmup');
          await warmCaches();
          // Keep the heavy endpoints (network-pulse, analytics/sales) warm
          // every 4 min so business-hour cold paths never reach a real user.
          startPeriodicRewarm();
        } catch (e) {
          logger.warn('Cache warm-up skipped:', e.message);
        }
      });
    });

    // ─── Graceful Shutdown ──────────────────────────────────────────────────────
    const gracefulShutdown = async (signal) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);

      server.close(async () => {
        try {
          const { pool } = require('./config/database');
          await pool.end();
          logger.info('All connections closed. Goodbye! 👋');
          process.exit(0);
        } catch (err) {
          logger.error('Error during shutdown:', err);
          process.exit(1);
        }
      });

      // Force shutdown after 30s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled Promise Rejection:', reason);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
