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
      max:      parseInt(process.env.PG_POOL_MAX) || 20,         // max connections in pool
      idleTimeoutMillis:    30000,                                // close idle connections after 30s
      connectionTimeoutMillis: 5000,                              // fail if can't connect in 5s
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
