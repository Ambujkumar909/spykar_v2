// ─── useAlerts — module-deduped fetch of /inventory/alerts ──────────────────
// Header and ExceptionAlertStrip both render alert info on every page.
// Without dedup they each fire their own /inventory/alerts request — same
// payload, two callers, ×2 in dev under StrictMode = 4 requests.
//
// This hook coalesces them: the first caller fires the network request, every
// subsequent caller (within TTL_MS) attaches to the same in-flight Promise or
// reads the cached value.  All consumers receive the same array, so the strip
// and the bell badge stay in sync.
//
// Cache lifetime is short (60 s) — alerts are inventory health signals that
// the user expects to refresh when they navigate.  Pages that need a forced
// refresh can call invalidateAlerts() (e.g. after a manual sync).

import { useEffect, useState } from 'react';
import { inventoryService } from './services';

const TTL_MS = 60_000;
let cached = null;            // { data, expiresAt }
let inFlight = null;          // Promise<alerts[]> while a fetch is pending
const subscribers = new Set();

function fetchOnce() {
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.data);
  }
  if (inFlight) return inFlight;
  inFlight = inventoryService.getAlerts()
    .then(r => {
      const alerts = r.data?.data || [];
      cached = { data: alerts, expiresAt: Date.now() + TTL_MS };
      // Push to every other subscriber so a later mounter renders synchronously.
      subscribers.forEach(fn => fn(alerts));
      return alerts;
    })
    .catch(err => {
      // Don't poison cache on error — let the next caller retry.
      throw err;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function invalidateAlerts() {
  cached = null;
}

export function useAlerts() {
  const [alerts, setAlerts] = useState(() => cached?.data || []);
  const [loading, setLoading] = useState(() => !cached);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let alive = true;
    subscribers.add(setAlerts);
    fetchOnce()
      .then(a => { if (alive) { setAlerts(a); setLoading(false); } })
      .catch(e => { if (alive) { setError(e); setLoading(false); } });
    return () => {
      alive = false;
      subscribers.delete(setAlerts);
    };
  }, []);

  return { alerts, loading, error };
}
