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

/**
 * Get cached value, if miss: execute fn, cache result, return
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

    logger.debug(`Cache MISS: ${key}`);
    const result = await fn();
    await redisClient.setEx(key, ttl, JSON.stringify(result));
    return result;
  } catch (err) {
    logger.error(`Cache error for key ${key}:`, err.message);
    // On Redis failure, fall through to DB
    return fn();
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
  SALES_ANALYTICS: 600,         // 10 min — heavy aggregation, read-only
  STOCK_AGEING: 600,            // 10 min — ageing buckets, static per sync
  STOCK_ALERTS: 300,            // 5 min — alerts can change after restocks
  NETWORK_OVERVIEW: 300,        // 5 min — network KPIs
  FILL_RATE: 600,               // 10 min — fill rate analytics
};

module.exports = {
  get redisClient() { return redisClient; },
  connectRedis,
  checkRedis,
  getOrSet,
  invalidatePattern,
  set,
  get,
  del,
  TTL,
};
