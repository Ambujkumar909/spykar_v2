const logger = require('./logger');

// ─── In-process cache (replaces Redis) ────────────────────────────────────────
// One Node process per API server, so a plain Map with per-key TTL is all we
// need — no external service, no Docker.
//
// IMPORTANT — cross-process invalidation:
//   This cache lives in the API server's heap only. The ETL sync runs in a
//   SEPARATE, detached process (scripts/run-sync.js), so any invalidatePattern()
//   it calls clears its OWN (empty) cache, not the live server's. The API
//   server keeps itself fresh via jobs/cacheInvalidator.js, which polls
//   sync_logs and flushes + re-warms this cache when a sync completes.
//   Within a single process (e.g. in-process cache warm-up), invalidation and
//   reads behave exactly as you'd expect.

const store = new Map();    // key -> { value, expiresAt }  (expiresAt 0 = never)
const inFlight = new Map(); // key -> Promise  (single-flight de-dupe)

function readKey(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeKey(key, value, ttlSec) {
  store.set(key, { value, expiresAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
}

// Convert a Redis-style glob ('inventory:*') to an anchored RegExp.
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                         .replace(/\*/g, '.*')
                         .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// True always — the in-process cache is available as soon as the module loads.
// Kept for API parity with the old Redis layer / health checks.
function isReady() {
  return true;
}

async function checkCache() {
  return true;
}

/**
 * Flush the entire cache. Returns the number of entries cleared.
 * Used by the post-sync invalidator.
 */
function clear() {
  const n = store.size;
  store.clear();
  return n;
}

/**
 * Get cached value, if miss: execute fn, cache result, return.
 * Concurrent misses on the same key share a single in-flight promise.
 * @param {string} key - Cache key
 * @param {Function} fn - Async function to call on cache miss
 * @param {number} ttl - TTL in seconds (default 5 min)
 */
async function getOrSet(key, fn, ttl = 300) {
  const cached = readKey(key);
  if (cached !== undefined) {
    logger.debug(`Cache HIT: ${key}`);
    return cached;
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
      writeKey(key, result, ttl);
      return result;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
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
  const cached = readKey(key);
  if (cached !== undefined) {
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
        // exceeds it. Fall back to a truncated, still-valid JSON response so
        // the request doesn't 500.
        logger.error(`Cache stringify failed for ${key} (${stringifyErr.message}); returning truncated payload`);
        const safe = {
          success: true,
          data: [],
          count: 0,
          error: 'Response exceeded server max payload size; please apply a tighter filter.',
          _truncated: true,
        };
        if (result && typeof result === 'object' && 'summary' in result) safe.summary = result.summary;
        str = JSON.stringify(safe);
        writeKey(key, str, ttl);
        return str;
      }
      writeKey(key, str, ttl);
      return str;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/**
 * Delete cache keys matching a Redis-style glob pattern, e.g. 'inventory:*'.
 */
async function invalidatePattern(pattern) {
  const re = globToRegExp(pattern);
  let count = 0;
  for (const key of store.keys()) {
    if (re.test(key)) {
      store.delete(key);
      count++;
    }
  }
  if (count > 0) logger.debug(`Invalidated ${count} cache keys matching: ${pattern}`);
}

/**
 * Set a single key with TTL.
 */
async function set(key, value, ttl = 300) {
  writeKey(key, value, ttl);
}

/**
 * Get a single key. Returns null on miss.
 */
async function get(key) {
  const val = readKey(key);
  return val === undefined ? null : val;
}

/**
 * Delete a single key.
 */
async function del(key) {
  store.delete(key);
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
  // The Spykar ERP feed is a once-a-day batch.  Data DOES NOT change between
  // syncs — so any cache entry built from that data is valid for the rest of
  // the day.  TTLs below reflect that reality: long enough that a CEO
  // toggling filters or revisiting yesterday's view never pays a cold scan,
  // short enough that the next-day sync wipes them within an hour.
  SALES_ANALYTICS: 86400,       // 24h — ERP feed is once-daily; once a date range is computed it stays valid until next sync
  STOCK_AGEING: 86400,          // 24h
  STOCK_ALERTS: 86400,          // 24h
  NETWORK_OVERVIEW: 86400,      // 24h
  FILL_RATE: 86400,             // 24h
  FILTER_OPTIONS: 14400,        // 4 hours — distinct values are practically static between syncs
};

module.exports = {
  isReady,
  checkCache,
  clear,
  getOrSet,
  getOrSetRawJson,
  invalidatePattern,
  set,
  get,
  del,
  TTL,
};
