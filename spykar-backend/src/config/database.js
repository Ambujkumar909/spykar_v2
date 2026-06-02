const { Pool } = require('pg');
const logger = require('./logger');

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = new Pool({
      // 127.0.0.1 (NOT 'localhost') — on Windows, 'localhost' resolves to
      // IPv6 ::1 first; if Postgres listens IPv4-only the connect attempt
      // wastes ~200ms failing IPv6 before falling back. Measured: localhost
      // connect = 211ms vs 127.0.0.1 = 1.3ms.
      host:     process.env.PG_HOST     || '127.0.0.1',
      port:     parseInt(process.env.PG_PORT) || 5432,
      database: process.env.PG_DATABASE || 'spykar_inventory',
      user:     process.env.PG_USER     || 'spykar_app',
      password: process.env.PG_PASSWORD,
      // Pool size. Measured ceiling on this box: each heavy analytics query
      // peaks ~470 MB (209 MB sort + ~220 MB materialized CTE + 38 MB hash).
      // worst-case RAM = max × 470 MB + shared_buffers (4 GB). On 23.7 GB:
      //   20 → 13.4 GB | 30 → 18.1 GB (✅ ~5.6 GB headroom) | 40 → 22.8 GB (OOM).
      // So 30 is the empirical sweet spot here; PROD with more RAM can raise
      // PG_POOL_MAX (safe_max ≈ (RAM_GB − shared_buffers_GB − 2) / 0.5).
      // Benchmarked: at max=20 a 30-request burst of 8 s queries drops 10 with
      // "timeout exceeded when trying to connect"; at max=30, zero failures.
      max:      parseInt(process.env.PG_POOL_MAX) || 30,         // max connections in pool
      idleTimeoutMillis:    30000,                                // close idle connections after 30s
      connectionTimeoutMillis: 5000,                              // fail if can't connect in 5s
      // Per-query hard cap — kills a runaway/leaked query and RETURNS the
      // connection to the pool healthy (benchmarked: killed at the cap, client
      // reusable=true). This is the real defense against pool exhaustion from
      // aborted-but-still-running queries (axios abort does NOT cancel the PG
      // query server-side). DEFAULT 0 (off) so the DETACHED SYNC process — which
      // imports this same pool and runs multi-minute COPY/merges — is NEVER
      // capped. server.js opts the API process in to 40 s (just under the 45 s
      // HTTP timeout, so the DB returns a clean error + frees the connection
      // instead of the socket abandoning a still-running query). run-sync.js
      // and run_full_sync.js force it back to 0.
      ...(parseInt(process.env.PG_STATEMENT_TIMEOUT) > 0
        ? { statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT) }
        : {}),
      maxUses:  7500,                                             // recycle connections after 7500 uses
      // Kill transactions left IDLE (BEGIN with no follow-up) after 60s so a
      // crashed request can't pin a connection + hold locks forever. This is
      // SAFE for the ETL sync: its COPY/merge statements are ACTIVE (not idle),
      // so multi-minute merges are never affected — only genuinely stuck,
      // idle-in-transaction sessions get reaped.
      idle_in_transaction_session_timeout: 60000,
      ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    _pool.on('connect', () => logger.debug('New DB client connected'));
    _pool.on('error',  (err) => logger.error('Unexpected DB pool error:', err));
  }
  return _pool;
}

async function connectDatabase() {
  const client = await getPool().connect();
  await client.query('SELECT 1');
  client.release();
  return true;
}

async function checkDatabase() {
  const client = await getPool().connect();
  const result = await client.query('SELECT NOW() as now, current_database() as db');
  client.release();
  return result.rows[0];
}

/**
 * Execute a query with automatic client management
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await getPool().query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`Slow query detected (${duration}ms): ${text.substring(0, 100)}`);
    }
    return result;
  } catch (err) {
    logger.error('Database query error:', { error: err.message, query: text });
    throw err;
  }
}

/**
 * Execute multiple queries in a transaction
 * @param {Function} callback - Receives client, returns result
 */
async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query,
  transaction,
  connectDatabase,
  checkDatabase,
  get pool() { return getPool(); },  // lazy getter — backward-compatible
};
