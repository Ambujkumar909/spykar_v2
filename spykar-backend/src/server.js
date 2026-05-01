require('dotenv').config();
const app = require('./app');
const logger = require('./config/logger');
const { connectDatabase } = require('./config/database');
const { connectRedis } = require('./config/redis');
const { startScheduler } = require('./jobs/syncScheduler');

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  try {
    logger.info('🚀 Spykar Inventory API starting...');

    // Connect to PostgreSQL
    await connectDatabase();
    logger.info('✅ PostgreSQL connected');

    // Clean up any sync_logs stuck in RUNNING state from a previous crash/restart
    const { pool: dbPool } = require('./config/database');
    const dbClient = await dbPool.connect();
    try {
      const stale = await dbClient.query(
        `UPDATE sync_logs SET status = 'FAILED', completed_at = NOW(),
         error_message = 'Process interrupted (server restarted while sync was running)'
         WHERE status = 'RUNNING'
         RETURNING id`
      );
      if (stale.rowCount > 0) {
        logger.warn(`Cleaned up ${stale.rowCount} stale RUNNING sync log(s) from previous crash`);
      }
    } finally {
      dbClient.release();
    }

    // Run migrations asynchronously (skips files already applied)
    const { migrate } = require('./database/migrate');
    try {
      await migrate();
      logger.info('✅ Migrations applied');
      // Verify unique constraints exist
      const { pool } = require('./config/database');
      const client = await pool.connect();
      try {
        await client.query(`
          DO $$ BEGIN
            BEGIN ALTER TABLE locations ADD CONSTRAINT uq_locations_external_id UNIQUE (external_id); EXCEPTION WHEN duplicate_table THEN NULL; END;
            BEGIN ALTER TABLE skus ADD CONSTRAINT uq_skus_external_id UNIQUE (external_id); EXCEPTION WHEN duplicate_table THEN NULL; END;
            BEGIN ALTER TABLE dispatch_orders ADD CONSTRAINT uq_dispatch_external_id UNIQUE (external_id); EXCEPTION WHEN duplicate_table THEN NULL; END;
          END $$;
        `);
        // Unique partial index on notes — required by dispatch sync ON CONFLICT (notes) clause
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_movements_notes
          ON inventory_movements(notes)
          WHERE notes IS NOT NULL
        `);
        logger.info('✅ Constraints verified');
      } finally {
        client.release();
      }
    } catch (e) {
      logger.warn('Startup migration warning:', e.message);
    }

    // Connect to Redis
    await connectRedis();
    logger.info('✅ Redis connected');

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
          const { redisClient } = require('./config/redis');
          await pool.end();
          await redisClient.quit();
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
