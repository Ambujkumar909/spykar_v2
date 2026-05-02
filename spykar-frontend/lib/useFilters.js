// ─── useFilters — URL-synced multi-select filter state ────────────────────────
// Single source of truth for the v2 dashboard's universal filter bar. Every
// filter dimension is reflected in the URL query string so every view is a
// permalink. Multi-select values are encoded as comma-separated lists.
//
// Reading the URL once on mount, writing back on every change. Uses Next.js
// shallow routing so the page never re-renders from the route change itself —
// React state is the source of UI updates, the URL is just persistence.
//
// Exposes a stable API used by every page:
//
//   const { filters, setFilter, clearFilter, clearAll, asQuery, hasAny } = useFilters({
//     defaults: { mode: 'active' },
//     persist:  ['mode', 'asOfDate'],   // keep these even when "clear all"
//   });
//
//   filters.gender_name      → ['Mens']     (always array — multi-select native)
//   setFilter('gender_name', ['Mens', 'Womens'])
//   asQuery()                → { gender: 'Mens,Womens', mode: 'active' }
//                             (server-friendly: arrays joined to comma strings)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';

const ARRAY_DIMS = new Set([
  'style', 'shade', 'color', 'gender_name', 'sub_product', 'season', 'product',
  'category', 'brand', 'fit', 'size',
  'state', 'city', 'group_name', 'store_code',
]);

const SCALAR_DIMS = new Set([
  'mode',          // 'active' | 'all'
  'asOfDate',      // YYYY-MM-DD (time-travel)
  'tax',           // 'mrp' | 'gross' | 'net'
  'sale',          // 'sale' | 'return' | 'net'
  'date_from', 'date_to',
  'sort_by', 'sort_dir',
  'page', 'limit',
  'search',
]);

function decode(qs) {
  const out = {};
  Object.keys(qs).forEach(k => {
    const v = qs[k];
    // Defensive: null/undefined/empty string are all treated as "not set"
    // so a stray null in router.query (rare but possible after manual
    // window.history mutations) doesn't get coerced into the literal
    // string "null" and saved as a value.
    if (v === undefined || v === null || v === '') return;
    if (ARRAY_DIMS.has(k)) {
      out[k] = String(v).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      out[k] = v;
    }
  });
  return out;
}

function encode(state) {
  const out = {};
  Object.keys(state).forEach(k => {
    const v = state[k];
    if (v === undefined || v === null || v === '' ) return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      out[k] = v.join(',');
    } else {
      out[k] = String(v);
    }
  });
  return out;
}

export function useFilters({ defaults = {}, persist = [] } = {}) {
  const router = useRouter();
  const initialised = useRef(false);
  const [filters, setFilters] = useState(() => ({ ...defaults }));

  // ── Hydrate from URL on first mount (SSR safe — router.query starts empty) ──
  useEffect(() => {
    if (initialised.current) return;
    if (!router.isReady) return;
    initialised.current = true;
    const fromUrl = decode(router.query);
    setFilters(prev => ({ ...defaults, ...prev, ...fromUrl }));
  }, [router.isReady, router.query, defaults]);

  // ── Push state → URL (shallow, replaceState so history doesn't bloat) ──────
  const syncToUrl = useCallback((next) => {
    if (!initialised.current) return; // wait for hydration
    const encoded = encode(next);
    router.replace({ pathname: router.pathname, query: encoded }, undefined, { shallow: true });
  }, [router]);

  const setFilter = useCallback((key, value) => {
    setFilters(prev => {
      const next = { ...prev, [key]: value };
      // Drop the key entirely when clearing — keeps the URL clean
      if (
        value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete next[key];
      }
      // Cascade narrowing: clearing State auto-clears City; etc.
      if (key === 'state')        delete next.city;
      if (key === 'gender_name')  { delete next.sub_product; delete next.style; }
      if (key === 'sub_product')  delete next.style;
      if (key === 'group_name')   delete next.store_code;
      syncToUrl(next);
      return next;
    });
  }, [syncToUrl]);

  const clearFilter = useCallback((key) => setFilter(key, undefined), [setFilter]);

  const clearAll = useCallback(() => {
    setFilters(prev => {
      const next = {};
      // Preserve persistent keys (mode, asOfDate, etc.) and apply defaults
      persist.forEach(k => { if (prev[k] !== undefined) next[k] = prev[k]; });
      Object.keys(defaults).forEach(k => { if (next[k] === undefined) next[k] = defaults[k]; });
      syncToUrl(next);
      return next;
    });
  }, [defaults, persist, syncToUrl]);

  // ── Derived: server-ready query object (arrays → comma strings) ────────────
  const asQuery = useCallback(() => encode(filters), [filters]);

  // ── Active-filter count (excludes mode/asOfDate which are persistent) ──────
  const activeCount = useMemo(() => {
    let n = 0;
    Object.keys(filters).forEach(k => {
      if (persist.includes(k)) return;
      if (k === 'mode' || k === 'asOfDate' || k === 'page' || k === 'limit' || k === 'sort_by' || k === 'sort_dir') return;
      const v = filters[k];
      if (Array.isArray(v) ? v.length > 0 : Boolean(v)) n++;
    });
    return n;
  }, [filters, persist]);

  return {
    filters,
    setFilter,
    clearFilter,
    clearAll,
    asQuery,
    activeCount,
    hasAny: activeCount > 0,
  };
}

// Helper: convert filters → backend query (handles all keys without manual mapping)
export function filtersToQuery(filters) { return encode(filters); }
