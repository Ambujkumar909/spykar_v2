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
//
// `mode` (active | inactive | all) is now part of the cache key so the same
// hook can serve different scopes simultaneously without collision. Consumers
// also get `summary` (the TRUE network counts, NOT capped by detail-row LIMIT)
// alongside the detail rows.

import { useEffect, useState } from 'react';
import { inventoryService } from './services';

const TTL_MS = 60_000;
// Per-mode cache — 'active' / 'inactive' / 'all' each maintain their own
// payload + in-flight promise so flipping the toggle never crosses streams.
const cacheByMode  = new Map(); // mode → { data, summary, expiresAt }
const inFlightByMode = new Map(); // mode → Promise<{alerts, summary}>
const subscribersByMode = new Map(); // mode → Set<setter>

function emptyResult(mode) {
  return { alerts: [], summary: { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0, mode } };
}

function fetchOnce(mode = 'active') {
  const cached = cacheByMode.get(mode);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve({ alerts: cached.data, summary: cached.summary });
  }
  if (inFlightByMode.has(mode)) return inFlightByMode.get(mode);

  const promise = inventoryService.getAlerts({ mode })
    .then(r => {
      const body = r.data || {};
      const alerts = body.data || [];
      const summary = body.summary || emptyResult(mode).summary;
      cacheByMode.set(mode, { data: alerts, summary, expiresAt: Date.now() + TTL_MS });
      // Push to every other subscriber so a later mounter renders synchronously.
      const subs = subscribersByMode.get(mode);
      if (subs) subs.forEach(fn => fn({ alerts, summary }));
      return { alerts, summary };
    })
    .catch(err => {
      // Don't poison cache on error — let the next caller retry.
      throw err;
    })
    .finally(() => { inFlightByMode.delete(mode); });

  inFlightByMode.set(mode, promise);
  return promise;
}

export function invalidateAlerts(mode) {
  if (mode) cacheByMode.delete(mode);
  else cacheByMode.clear();
}

/**
 * @param {Object} [opts]
 * @param {'active'|'inactive'|'all'} [opts.mode='active']
 * @returns {{ alerts: any[], summary: { out_of_stock, reorder_now, low_stock, total, mode }, loading: boolean, error: any }}
 */
export function useAlerts(opts = {}) {
  const mode = opts.mode || 'active';
  const initial = cacheByMode.get(mode);
  const [state, setState] = useState(() => ({
    alerts:  initial?.data    || [],
    summary: initial?.summary || emptyResult(mode).summary,
  }));
  const [loading, setLoading] = useState(() => !initial);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let alive = true;
    if (!subscribersByMode.has(mode)) subscribersByMode.set(mode, new Set());
    const subs = subscribersByMode.get(mode);
    subs.add(setState);

    fetchOnce(mode)
      .then(({ alerts, summary }) => { if (alive) { setState({ alerts, summary }); setLoading(false); } })
      .catch(e => { if (alive) { setError(e); setLoading(false); } });

    return () => {
      alive = false;
      subs.delete(setState);
    };
  }, [mode]);

  return { alerts: state.alerts, summary: state.summary, loading, error };
}
