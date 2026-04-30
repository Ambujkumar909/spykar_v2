// ─── Frontend module-level cache ──────────────────────────────────────────────
// Next.js unmounts a page on every navigation, so `useState` values reset and
// each visit refetches from scratch — even if the backend Redis cache is warm,
// the 570K-row JSON payload still has to retransfer every time.
//
// This module keeps the last fetched response in a plain `Map` that lives for
// the lifetime of the tab (module scope). Pages read from here on mount for
// instant paint, then kick off a background refresh to keep data fresh.
//
// Scope is deliberately narrow: plain JS Map, no deps, no subscriptions. Each
// page owns its own keys. A fresh browser reload clears everything.

const CACHE = new Map(); // key -> { data, ts }

// How long a cached value is considered "fresh enough" that we won't immediately
// refetch on mount. Background refresh still runs on every mount to keep data
// current — this just controls whether we show a skeleton on return.
const FRESH_TTL_MS = 60_000; // 1 minute

// Keys that should ALSO persist to sessionStorage so a page reload (or a new
// tab via duplicate) starts with data immediately instead of refetching 570K
// rows from scratch. SessionStorage is cleared when the browser tab closes.
// PERSIST_KEYS use prefix matching — anything starting with one of these
// substrings persists to sessionStorage so the next page-load is instant.
// Network Pulse caches per-filter combo (`net:pulse:m=active|...`) so toggling
// Active ↔ Inactive within the same tab feels nano-second after the first visit.
const PERSIST_PREFIXES = ['ov:alerts', 'ov:alertSummary', 'net:pulse:', 'flt:opts:'];
const PERSIST_KEYS = {
  has(k) { return PERSIST_PREFIXES.some(p => k === p || k.startsWith(p)); },
};
const SS_PREFIX = 'dashcache:';
const SS_MAX_BYTES = 30_000_000; // ~30 MB soft ceiling; skip persist above this

function ssKey(k) { return SS_PREFIX + k; }

function readFromSession(key) {
  if (typeof window === 'undefined' || !PERSIST_KEYS.has(key)) return null;
  try {
    const raw = window.sessionStorage.getItem(ssKey(key));
    if (!raw) return null;
    return JSON.parse(raw); // returns { data, ts }
  } catch { return null; }
}

function writeToSession(key, entry) {
  if (typeof window === 'undefined' || !PERSIST_KEYS.has(key)) return;
  try {
    const str = JSON.stringify(entry);
    if (str.length > SS_MAX_BYTES) return; // don't blow out the quota
    window.sessionStorage.setItem(ssKey(key), str);
  } catch { /* quota exceeded / serialization failed — fall back to memory */ }
}

export function getCached(key) {
  const entry = CACHE.get(key);
  if (entry) return entry.data;
  // Lazy-promote from sessionStorage into memory on first access
  const persisted = readFromSession(key);
  if (persisted) {
    CACHE.set(key, persisted);
    return persisted.data;
  }
  return null;
}

export function isFresh(key) {
  let entry = CACHE.get(key);
  if (!entry) {
    const persisted = readFromSession(key);
    if (persisted) { CACHE.set(key, persisted); entry = persisted; }
  }
  if (!entry) return false;
  return Date.now() - entry.ts < FRESH_TTL_MS;
}

export function setCached(key, data) {
  const entry = { data, ts: Date.now() };
  CACHE.set(key, entry);
  writeToSession(key, entry);
}

export function clearCached(key) {
  if (key) {
    CACHE.delete(key);
    if (typeof window !== 'undefined') {
      try { window.sessionStorage.removeItem(ssKey(key)); } catch {}
    }
  } else {
    CACHE.clear();
    if (typeof window !== 'undefined') {
      try {
        const keys = [];
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (k && k.startsWith(SS_PREFIX)) keys.push(k);
        }
        keys.forEach(k => window.sessionStorage.removeItem(k));
      } catch {}
    }
  }
}
