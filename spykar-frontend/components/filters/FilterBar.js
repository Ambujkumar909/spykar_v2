// ─── FilterBar — the universal v2 dashboard filter strip ─────────────────────
//
// Renders 11 dimensions of multi-select filters + Active/All mode toggle in a
// single sticky bar. Drives every analytics endpoint via the shared
// useFilters() URL-sync hook + the /filters/options API for dependency
// narrowing.
//
// Visual identity:
//   • Pearl-light glass surface, sticky on scroll, backdrop-blur for depth
//   • Dimensions grouped in three rows on narrow screens, one row on wide
//   • Active filter count badge top-left, "Clear all" link top-right
//   • Mode toggle (Active/All) on the far right — emphasised, switch-style
//
// Performance:
//   • Single bulk fetch on mount fills every dropdown — 1 request, not 11
//   • On filter change, options are re-fetched in the background under the
//     new cross-filter state (300ms debounced) — dropdowns re-narrow without
//     blocking interactions
//   • Stale-while-revalidate: old options stay visible during refetch
//
// Accessibility:
//   • All controls keyboard-reachable; "/" focuses the first dropdown
//   • Each dropdown handles Escape, click-outside, and focus trap
//   • Reduced-motion users get instant transitions (respects prefers-reduced-motion)

import { useEffect, useMemo, useRef, useState } from 'react';
import { filterService } from '../../lib/services';
import { getCached, setCached, isFresh } from '../../lib/dashboardCache';
import MultiSelect from './MultiSelect';

// Stable per-filter-combo cache key for the dropdown options bundle.
function filterOptionsCacheKey(params) {
  const norm = {};
  Object.keys(params || {}).sort().forEach(k => {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    norm[k] = String(v);
  });
  return `flt:opts:${JSON.stringify(norm)}`;
}

// Dimension catalog — controls render order, label text, and which key is
// bound to which API filter. Keys here MUST match useFilters.ARRAY_DIMS.
const DIMS = [
  { key: 'gender_name', label: 'Gender',      apiKey: 'gender' },
  { key: 'sub_product', label: 'Sub-product', apiKey: 'sub_product' },
  { key: 'product',     label: 'Product',     apiKey: 'product' },
  { key: 'category',    label: 'Category',    apiKey: 'category' },
  { key: 'style',       label: 'Style',       apiKey: 'style' },
  { key: 'shade',       label: 'Shade',       apiKey: 'shade' },
  { key: 'color',       label: 'Colour',      apiKey: 'color' },
  { key: 'size',        label: 'Size',        apiKey: 'size' },
  { key: 'season',      label: 'Season',      apiKey: 'season' },
  { key: 'state',       label: 'State',       apiKey: 'state' },
  { key: 'city',        label: 'City',        apiKey: 'city' },
  { key: 'group_name',  label: 'Party',       apiKey: 'group_name' },
  { key: 'store_code',  label: 'Store',       apiKey: 'store_code' },
];

export default function FilterBar({ filters, setFilter, clearAll, activeCount }) {
  // Module-cached options bundle — toggling Active/Inactive/All (or picking
  // any filter combo previously seen) paints all 13 dropdowns instantly
  // from memory. The "Loading…" placeholder only appears on the very first
  // visit to a never-seen combo. Cache survives the page tab; sessionStorage
  // persistence is wired in dashboardCache for keys with the `flt:opts:` prefix.
  const [optionsByDim, setOptionsByDim] = useState({});
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef(null);
  const requestId   = useRef(0);
  const activeKeyRef = useRef('');

  // Map FilterBar React-state key → backend API key. Most filters use the
  // same key on both sides; gender is the lone exception (state key
  // `gender_name`, API key `gender`). The mapping is centralised here so
  // every filter request uses the API-canonical key — the backend can then
  // reliably strip the "self filter" when populating each dimension's
  // dropdown, which is the keystone of dynamic dependency narrowing.
  const STATE_TO_API_KEY = { gender_name: 'gender' };
  const toApiKey = (k) => STATE_TO_API_KEY[k] || k;

  // ── Stale-while-revalidate fetch with module cache ────────────────────
  // 1. Build cacheKey from current filters.
  // 2. Synchronously paint cached dropdown bundle if any (no Loading flash).
  // 3. If fresh (<60 s) → done.
  // 4. Else background fetch; only swap in if user is still on this combo
  //    when response lands (race-guard via activeKeyRef).
  const fetchOptions = async (params, cacheKey) => {
    const myId    = ++requestId.current;
    const issuedFor = cacheKey;
    try {
      const r = await filterService.getAllOptions(params);
      if (myId !== requestId.current) return;
      const opts = r.data?.options || {};
      setCached(issuedFor, opts);
      if (activeKeyRef.current === issuedFor) {
        setOptionsByDim(opts);
        setLoading(false);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('FilterBar: options fetch failed', e?.message);
      if (myId === requestId.current && activeKeyRef.current === issuedFor) setLoading(false);
    }
  };

  // Re-fetch on every filter change. Debounce reduced to 100 ms (was 300):
  // we now paint cached options instantly, so the debounce only needs to
  // coalesce rapid multi-clicks against the network — 100 ms is enough.
  useEffect(() => {
    // Build params and cache key
    const params = {};
    Object.entries(filters).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v) && v.length === 0) return;
      params[toApiKey(k)] = Array.isArray(v) ? v.join(',') : v;
    });
    const key = filterOptionsCacheKey(params);
    activeKeyRef.current = key;

    // Instant paint from cache if available
    const cached = getCached(key);
    if (cached) {
      setOptionsByDim(cached);
      setLoading(false);
      // If fresh, skip the background fetch entirely
      if (isFresh(key)) return;
    } else {
      // Cache miss — keep current options visible (don't blank out dropdowns)
      setLoading(prev => Object.keys(optionsByDim).length === 0);
    }

    // Background revalidate (debounced)
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchOptions(params, key), 100);
    return () => { clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  // ── "/" keyboard shortcut to focus first dropdown ────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        const first = document.querySelector('[data-filterbar-trigger]');
        first?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Mode toggle (Active vs All) ──────────────────────────────────────────
  const mode = filters.mode || 'active';
  const isActive = mode === 'active';

  // Closed-store count is exposed by the options API as a separate value;
  // for now we just visually communicate the toggle's intent.
  return (
    <div
      className="v2-filterbar"
      style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'rgba(7,12,24,0.92)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        padding: '10px 24px',
        marginBottom: 16,
        boxShadow: '0 1px 0 rgba(255,255,255,0.04)',
      }}
    >
      {/* Top row — header + active count + clear all */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
      }}>
        <div style={{
          fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}>Filters</div>
        {activeCount > 0 && (
          <div style={{
            background: 'var(--accent-primary)', color: '#fff',
            padding: '2px 8px', borderRadius: 999,
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
          }}>{activeCount} ACTIVE</div>
        )}

        <div style={{ flex: 1 }} />

        {/* Mode toggle — premium pill switch */}
        <ModePill
          mode={mode}
          onChange={(m) => setFilter('mode', m)}
        />

        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--accent-primary)',
              fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700,
              cursor: 'pointer', padding: '4px 8px', borderRadius: 6,
              transition: 'background 140ms',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-glow)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >Clear all</button>
        )}
      </div>

      {/* Filter row — horizontally scrollable on narrow screens */}
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 8,
        }}
      >
        {DIMS.map(d => (
          <div key={d.key} data-filterbar-trigger-wrap>
            <MultiSelect
              label={d.label}
              options={optionsByDim[d.apiKey] || []}
              value={filters[d.key] || []}
              onChange={(v) => setFilter(d.key, v)}
              loading={loading && !optionsByDim[d.apiKey]}
              placeholder="All"
              compact
            />
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (prefers-reduced-motion: reduce) {
          .v2-filterbar * { transition: none !important; animation: none !important; }
        }
      `}</style>
    </div>
  );
}

// 3-segment Active / Inactive / All toggle. Drives every KPI and table on
// the page, so the user picks the lens once and the whole dashboard speaks
// that lens. Sliding white indicator with a smooth cubic-bezier ease feels
// elite (think iOS settings toggles, Linear status pills).
function ModePill({ mode, onChange }) {
  const OPTS = [
    { key: 'active',   label: 'Active',   title: 'Currently-open stores only' },
    { key: 'inactive', label: 'Inactive', title: 'Currently-closed stores only' },
    { key: 'all',      label: 'All',      title: 'Every store regardless of status' },
  ];
  const idx = Math.max(0, OPTS.findIndex(o => o.key === mode));
  const segPct = 100 / OPTS.length;
  return (
    <div
      style={{
        display: 'inline-flex', position: 'relative',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 999,
        padding: 3,
        height: 32,
      }}
    >
      {/* Sliding indicator */}
      <span
        style={{
          position: 'absolute',
          top: 3, bottom: 3,
          left:  `calc(${idx * segPct}% + 3px)`,
          width: `calc(${segPct}% - 6px)`,
          background: 'rgba(255,255,255,0.14)',
          borderRadius: 999,
          boxShadow: '0 1px 4px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.12)',
          transition: 'left 220ms cubic-bezier(0.16,1,0.3,1), width 220ms',
        }}
      />
      {OPTS.map(opt => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          title={opt.title}
          style={{
            position: 'relative', zIndex: 1,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0 14px',
            fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.02em',
            color: mode === opt.key ? '#F1F5F9' : '#64748B',
            transition: 'color 200ms',
          }}
        >{opt.label}</button>
      ))}
    </div>
  );
}
