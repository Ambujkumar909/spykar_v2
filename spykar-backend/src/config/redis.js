const { createClient } = require('redis');
const logger = require('./logger');

let redisClient;

async function connectRedis() {
  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD || undefined,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.error('Redis: max reconnect attempts reached');
          return new Error('Max reconnect attempts reached');
        }
        return Math.min(retries * 100, 3000);
      },
      connectTimeout: 5000,
    },
  });

  redisClient.on('error', (err) => logger.error('Redis client error:', err));
  redisClient.on('connect', () => logger.debug('Redis client connected'));
  redisClient.on('reconnecting', () => logger.warn('Redis client reconnecting...'));

  await redisClient.connect();
  return redisClient;
}

async function checkRedis() {
  const pong = await redisClient.ping();
  return pong === 'PONG';
}

// ─── Cache Helpers ────────────────────────────────────────────────────────────

// In-process single-flight map — dedupes concurrent regenerations of the same
// key so a cache expiry on a heavy query (e.g. the 570K-row alerts payload)
// doesn't hammer the database N times when N requests race the miss.
const inFlight = new Map();

/**
 * Get cached value, if miss: execute fn, cache result, return.
 * Concurrent misses on the same key share a single in-flight promise.
 * @param {string} key - Cache key
 * @param {Function} fn - Async function to call on cache miss
 * @param {number} ttl - TTL in seconds (default 5 min)
 */
async function getOrSet(key, fn, ttl = 300) {
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      logger.debug(`Cache HIT: ${key}`);
      return JSON.parse(cached);
    }

    // Single-flight: if another request is already regenerating this key,
    // await its promise instead of running fn() a second time.
    if (inFlight.has(key)) {
      logger.debug(`Cache COALESCED: ${key}`);
      return inFlight.get(key);
    }

    logger.debug(`Cache MISS: ${key}`);
    const promise = (async () => {
      try {
        const result = await fn();
        try {
          await redisClient.setEx(key, ttl, JSON.stringify(result));
        } catch (writeErr) {
          logger.warn(`Cache write failed for ${key}: ${writeErr.message}`);
        }
        return result;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  } catch (err) {
    logger.error(`Cache error for key ${key}:`, err.message);
    // On Redis failure, fall through to DB — still honor single-flight so a
    // Redis outage doesn't amplify concurrent DB load either.
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      try { return await fn(); }
      finally { inFlight.delete(key); }
    })();
    inFlight.set(key, promise);
    return promise;
  }
}

/**
 * Like `getOrSet`, but caches the already-serialized JSON string of the
 * builder's result. On cache hit returns the raw string — callers can stream
 * it straight to the HTTP response without a JSON.parse + re-stringify cycle.
 * Huge win for heavy payloads (e.g. the 570K-row stock-alerts response).
 *
 * @param {string} key - Cache key
 * @param {Function} buildFn - Async function that returns the response object
 * @param {number} ttl - TTL in seconds
 * @returns {Promise<string>} - Serialized JSON string ready for `res.send(...)`
 */
async function getOrSetRawJson(key, buildFn, ttl = 300) {
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      logger.debug(`Cache HIT (raw): ${key}`);
      return cached;
    }

    if (inFlight.has(key)) {
      logger.debug(`Cache COALESCED (raw): ${key}`);
      return inFlight.get(key);
    }

    logger.debug(`Cache MISS (raw): ${key}`);
    const promise = (async () => {
      try {
        const result = await buildFn();
        let str;
        try {
          str = JSON.stringify(result);
        } catch (stringifyErr) {
          // V8 caps string length at ~512 MB. JSON.stringify throws
          // RangeError("Invalid string length") if the serialized payload
          // exceeds it. Fall back to a truncated, still-valid JSON
          // response so the request doesn't 500. The controller is the
          // right place to fix the underlying size — but here we just
          // make sure the user sees a graceful answer instead of a crash.
          logger.error(`Cache stringify failed for ${key} (${stringifyErr.message}); returning truncated payload`);
          const safe = {
            success: true,
            data: [],
            count: 0,
            error: 'Response exceeded server max payload size; please apply a tighter filter.',
            _truncated: true,
          };
          // Try to preserve summary if the builder produced one
          if (result && typeof result === 'object' && 'summary' in result) safe.summary = result.summary;
          return JSON.stringify(safe);
        }
        try {
          await redisClient.setEx(key, ttl, str);
        } catch (writeErr) {
          logger.warn(`Cache write failed for ${key}: ${writeErr.message}`);
        }
        return str;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  } catch (err) {
    logger.error(`Cache error for key ${key}:`, err.message);
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      try {
        const result = await buildFn();
        try { return JSON.stringify(result); }
        catch (stringifyErr) {
          logger.error(`Stringify fallback failed for ${key}: ${stringifyErr.message}`);
          return JSON.stringify({ success: false, error: 'Response too large', _truncated: true });
        }
      } finally { inFlight.delete(key); }
    })();
    inFlight.set(key, promise);
    return promise;
  }
}

/**
 * Delete cache keys matching a pattern
 * @param {string} pattern - Key pattern e.g. 'inventory:*'
 */
async function invalidatePattern(pattern) {
  try {
    if (!redisClient || !redisClient.isReady) return; // skip if not connected
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      logger.debug(`Invalidated ${keys.length} cache keys matching: ${pattern}`);
    }
  } catch (err) {
    logger.error(`Cache invalidation error for pattern ${pattern}:`, err.message);
  }
}

/**
 * Set a single key with TTL
 */
async function set(key, value, ttl = 300) {
  await redisClient.setEx(key, ttl, JSON.stringify(value));
}

/**
 * Get a single key
 */
async function get(key) {
  const val = await redisClient.get(key);
  return val ? JSON.parse(val) : null;
}

/**
 * Delete a single key
 */
async function del(key) {
  await redisClient.del(key);
}

// ─── Cache TTL Constants ──────────────────────────────────────────────────────
const TTL = {
  EXECUTIVE_SUMMARY: 300,       // 5 min — top-level KPIs
  DISTRIBUTOR_LIST: 600,        // 10 min
  INVENTORY_SNAPSHOT: 180,      // 3 min — stock levels
  SKU_ANALYTICS: 600,           // 10 min
  DISPATCH_STATUS: 120,         // 2 min — frequently changing
  LOCATION_MASTER: 3600,        // 1 hour — rarely changes
  AUTH_TOKEN_BLACKLIST: 86400,  // 24 hours
  SALES_ANALYTICS: 1800,        // 30 min — heavy mega-CTE; data refreshes only at daily sync, so 30 min is safe and well within the 4-min re-warm cycle
  STOCK_AGEING: 1800,           // 30 min — ageing buckets, static per sync; matches re-warm cycle
  STOCK_ALERTS: 1800,           // 30 min — heavy 570K-row payload, low change rate within sync window
  NETWORK_OVERVIEW: 1800,       // 30 min — network KPIs; data refreshes at sync only
  FILL_RATE: 1800,              // 30 min — same daily-sync refresh model
  FILTER_OPTIONS: 1800,         // 30 min — distinct values barely change within a day
};

module.exports = {
  get redisClient() { return redisClient; },
  connectRedis,
  checkRedis,
  getOrSet,
  getOrSetRawJson,
  invalidatePattern,
  set,
  get,
  del,
  TTL,
};
