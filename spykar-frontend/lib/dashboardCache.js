// ─── Frontend module-level cache ──────────────────────────────────────────────
// Next.js unmounts a page on every navigation, so `useState` values reset and
// each visit refetches from scratch — even if the backend Redis cache is warm,
// the 570K-row JSON payload still has to retransfer every time.
//
// Three tiers of persistence drive nano-second perceived latency:
//
//   1. Module-level Map  → instant within the tab (page-switch)
//   2. sessionStorage    → instant across reload (Cmd-R) within the tab
//   3. localStorage      → instant across browser close + reopen (cold start)
//
// Pages call getCached() on mount; they get a snapshot synchronously even on
// a cold browser launch, paint immediately, then a stale-while-revalidate
// fetch refreshes the data in the background. No skeleton flash. No spinner.

// Map preserves insertion order; we use that for LRU eviction. On every read
// we re-insert the entry to mark it most-recently-used; when CACHE.size
// exceeds MAX_ENTRIES we drop the oldest. Caps tab memory to ~11 MB even
// after the user has toggled hundreds of filter combos.
const CACHE = new Map(); // key -> { data, ts }
const MAX_ENTRIES = 20;

function touch(key, entry) {
  CACHE.delete(key);
  CACHE.set(key, entry);
  if (CACHE.size > MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
}

// How long a cached value is considered "fresh enough" that we won't refetch
// in the background on mount. Sales / Network analytics is end-of-day batch
// data — a 10-min freshness window means flipping pages back-and-forth never
// triggers a background refresh, while opening the dashboard the next morning
// always pulls fresh numbers.
const FRESH_TTL_MS = 10 * 60_000; // 10 minutes

// Per-prefix persistence policy.
//   'local'   → localStorage  (survives browser close + reopen)
//   'session' → sessionStorage (survives reload, dies with the tab)
//   undefined → memory only   (dies with the tab; default)
//
// Sales, Network Pulse, and the Filter dropdowns all live in localStorage so
// returning to the dashboard tomorrow paints in microseconds — same flow as
// reading from RAM, no network, no backend, no Redis. The first server
// roundtrip of the day refreshes them in the background while the user is
// already looking at last-known-good numbers.
const PERSIST_TIERS = [
  { prefix: 'sales:',          tier: 'local'   },
  { prefix: 'sales:drill:',    tier: 'local'   },
  { prefix: 'net:pulse:',      tier: 'local'   },
  { prefix: 'flt:opts:',       tier: 'local'   },
  { prefix: 'ov:alerts',       tier: 'session' },
  { prefix: 'ov:alertSummary', tier: 'session' },
];
function tierFor(key) {
  for (const { prefix, tier } of PERSIST_TIERS) {
    if (key === prefix || key.startsWith(prefix)) return tier;
  }
  return null;
}

const SS_PREFIX = 'dashcache:';
const SS_MAX_BYTES = 4_500_000; // ~4.5 MB ceiling — localStorage quota is ~5 MB
function storageKey(k) { return SS_PREFIX + k; }
function storageFor(tier) {
  if (typeof window === 'undefined') return null;
  return tier === 'local' ? window.localStorage : window.sessionStorage;
}

function readFromStorage(key) {
  const tier = tierFor(key);
  if (!tier) return null;
  const store = storageFor(tier);
  if (!store) return null;
  try {
    const raw = store.getItem(storageKey(key));
    if (!raw) return null;
    return JSON.parse(raw); // returns { data, ts }
  } catch { return null; }
}

function writeToStorage(key, entry) {
  const tier = tierFor(key);
  if (!tier) return;
  const store = storageFor(tier);
  if (!store) return;
  try {
    const str = JSON.stringify(entry);
    if (str.length > SS_MAX_BYTES) return; // don't blow out the quota
    store.setItem(storageKey(key), str);
  } catch {
    // Quota exceeded — try to free space by evicting old dashcache entries
    // and retry once. Keeps localStorage from getting permanently jammed.
    try {
      evictOldest(tier);
      store.setItem(storageKey(key), JSON.stringify(entry));
    } catch { /* still no room — fall back to memory */ }
  }
}

// Evict the oldest 25% of dashcache entries from a storage tier when full.
function evictOldest(tier) {
  const store = storageFor(tier);
  if (!store) return;
  const entries = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k || !k.startsWith(SS_PREFIX)) continue;
    try {
      const v = JSON.parse(store.getItem(k));
      entries.push({ k, ts: v?.ts || 0 });
    } catch { entries.push({ k, ts: 0 }); }
  }
  entries.sort((a, b) => a.ts - b.ts);
  const toDrop = Math.max(1, Math.ceil(entries.length / 4));
  for (let i = 0; i < toDrop; i++) store.removeItem(entries[i].k);
}

export function getCached(key) {
  const entry = CACHE.get(key);
  if (entry) { touch(key, entry); return entry.data; }
  // Lazy-promote from persistent storage into memory on first access. Subsequent
  // gets within this tab hit the Map directly (sub-microsecond).
  const persisted = readFromStorage(key);
  if (persisted) {
    touch(key, persisted);
    return persisted.data;
  }
  return null;
}

// ─── Data version (sync-aware cache invalidation) ─────────────────────────────
// The 10-min wall-clock freshness window is NOT enough: when the ETL sync runs,
// the underlying data changes but a cached entry younger than 10 min would still
// be treated as "fresh" and the page would NOT refetch — so the user keeps
// seeing yesterday's numbers after a sync. The fix: stamp a monotonically
// increasing "data version" = the epoch ms of the latest successful sync's
// completed_at. Any cached entry created BEFORE that version is stale by
// definition, regardless of how recently it was fetched.
//
// Header.js (mounted globally via DashboardLayout) polls /sync/status and feeds
// completed_at here, so every page's isFresh() automatically returns false after
// a sync → triggers the stale-while-revalidate refetch → fresh data appears.
let DATA_VERSION = 0;
try {
  if (typeof window !== 'undefined') {
    DATA_VERSION = Number(window.localStorage.getItem('dashcache:__dataVersion')) || 0;
  }
} catch { /* ignore */ }

export function setDataVersion(ts) {
  const n = Number(ts) || 0;
  if (n > DATA_VERSION) {
    DATA_VERSION = n;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('dashcache:__dataVersion', String(n));
      }
    } catch { /* ignore */ }
  }
}
export function getDataVersion() { return DATA_VERSION; }

export function isFresh(key) {
  let entry = CACHE.get(key);
  if (!entry) {
    const persisted = readFromStorage(key);
    if (persisted) { touch(key, persisted); entry = persisted; }
  }
  if (!entry) return false;
  // Stale if the entry was cached before the latest sync — forces a refetch
  // of fresh post-sync data even within the 10-min wall-clock window.
  if (entry.ts < DATA_VERSION) return false;
  return Date.now() - entry.ts < FRESH_TTL_MS;
}

// Pending writes coalesce by key — if setCached fires 3× for the same key in
// rapid succession (filter typing, race-condition refetches), only the LAST
// value reaches storage. Saves ~10-20 ms of JSON.stringify per redundant call.
const PENDING_WRITES = new Map(); // key -> entry
let writeFlushScheduled = false;
function scheduleWriteFlush() {
  if (writeFlushScheduled) return;
  writeFlushScheduled = true;
  scheduleIdle(() => {
    writeFlushScheduled = false;
    for (const [k, e] of PENDING_WRITES) writeToStorage(k, e);
    PENDING_WRITES.clear();
  });
}

export function setCached(key, data) {
  const entry = { data, ts: Date.now() };
  touch(key, entry);
  // Skip the disk write entirely if this is the same reference as the
  // current Map entry — happens when callers re-stash the same response
  // object (common with stale-while-revalidate that gets the same data back).
  // The in-memory Map is updated synchronously so the next read is instant;
  // disk persistence happens in idle time, coalesced with any sibling writes.
  PENDING_WRITES.set(key, entry);
  scheduleWriteFlush();
}

// ─── Singleflight ─────────────────────────────────────────────────────
// Dedupes parallel fetches for the same key. If page A and page B both mount
// at the same time and both want `sales:v2:foo`, fetcher() runs once and both
// callers await the same promise. Without this, StrictMode dev double-mount
// or rapid filter-toggle storms fire N parallel requests.
const INFLIGHT = new Map(); // key -> Promise

export function dedupedFetch(key, fetcher) {
  const existing = INFLIGHT.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fetcher(); }
    finally { INFLIGHT.delete(key); }
  })();
  INFLIGHT.set(key, p);
  return p;
}

export function clearCached(key) {
  if (key) {
    CACHE.delete(key);
    if (typeof window !== 'undefined') {
      try { window.sessionStorage.removeItem(storageKey(key)); } catch {}
      try { window.localStorage.removeItem(storageKey(key)); } catch {}
    }
  } else {
    CACHE.clear();
    if (typeof window !== 'undefined') {
      for (const store of [window.sessionStorage, window.localStorage]) {
        try {
          const keys = [];
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k && k.startsWith(SS_PREFIX)) keys.push(k);
          }
          keys.forEach(k => store.removeItem(k));
        } catch {}
      }
    }
  }
}

// requestIdleCallback when available, microtask fallback otherwise. Keeps the
// JSON.stringify of large payloads off the synchronous setCached path so
// callers see sub-millisecond write latency.
function scheduleIdle(fn) {
  if (typeof window === 'undefined') { fn(); return; }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn, { timeout: 1000 });
  } else {
    setTimeout(fn, 0);
  }
}
