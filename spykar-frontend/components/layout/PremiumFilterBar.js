// ─── SidebarFilterPanel — luxury filter cluster slotted INTO the sidebar ───
// Renders BELOW the active nav item ("Sales & Returns" or "Network") inside
// the existing left navigation rail.  Visible only when the sidebar is in
// its expanded (hovered) state — labels and dropdowns need ~240 px to read
// well, and the user wants the panel to reveal on hover, not eat space when
// the rail is collapsed to 64 px.
//
// Aesthetic notes:
//   • Continuous with the sidebar — same gradient surface, same hairlines
//   • Champagne-gold "LENS" wordmark to mark this as the luxury control
//   • Smooth 320 ms cubic-bezier reveal (no janky height transitions)
//   • Each filter group is a quietly-collapsible section with a chevron
//     that rotates on open
//   • All MultiSelects compact + 100 % column width
//
// Latency:
//   • Options are prefetched the moment the FiltersProvider mounts the page
//     (module-level promise + dashboardCache), so by the time a CEO hovers
//     the rail every dropdown is already populated from memory — 0 wait.
//
// The panel is exported as the default; the file keeps the original name
// (PremiumFilterBar) for import-path compatibility.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Sparkles, RotateCcw, ChevronDown } from 'lucide-react';
import MultiSelect from '../filters/MultiSelect';
import { filterService } from '../../lib/services';
import { getCached, setCached, isFresh } from '../../lib/dashboardCache';
import { useSharedFilters } from '../../lib/FiltersContext';

const FILTER_ROUTES = new Set(['/network', '/sales']);

const FILTER_GROUPS = [
  {
    name: 'Product',
    dims: [
      { key: 'gender_name', label: 'Gender',      apiKey: 'gender'      },
      { key: 'category',    label: 'Category',    apiKey: 'category'    },
      { key: 'product',     label: 'Product',     apiKey: 'product'     },
      { key: 'sub_product', label: 'Sub-product', apiKey: 'sub_product' },
    ],
  },
  {
    name: 'Attributes',
    dims: [
      { key: 'size',  label: 'Size',   apiKey: 'size'  },
      { key: 'color', label: 'Colour', apiKey: 'color' },
      { key: 'shade', label: 'Shade',  apiKey: 'shade' },
      { key: 'style', label: 'Style',  apiKey: 'style' },
    ],
  },
  {
    name: 'Location',
    dims: [
      { key: 'state',      label: 'State', apiKey: 'state'      },
      { key: 'city',       label: 'City',  apiKey: 'city'       },
      { key: 'store_code', label: 'Store', apiKey: 'store_code' },
    ],
  },
  {
    name: 'Business',
    dims: [
      { key: 'season',     label: 'Season', apiKey: 'season'     },
      { key: 'group_name', label: 'Party',  apiKey: 'group_name' },
    ],
  },
];

const STATE_TO_API_KEY = { gender_name: 'gender' };
const toApiKey = (k) => STATE_TO_API_KEY[k] || k;

function filterOptionsCacheKey(params) {
  const norm = {};
  Object.keys(params || {}).sort().forEach(k => {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    norm[k] = String(v);
  });
  return `flt:opts:${JSON.stringify(norm)}`;
}

// ── Module-level prefetch — fire the unfiltered options bundle into cache
// the moment a filter-aware page mounts the provider, so by the time the
// user hovers the sidebar every dropdown paints from memory.  De-duped via
// a single in-flight promise.
let _prefetched = null;
function prefetchOptions() {
  if (_prefetched) return _prefetched;
  const cacheKey = filterOptionsCacheKey({});
  if (getCached(cacheKey) && isFresh(cacheKey)) {
    _prefetched = Promise.resolve(getCached(cacheKey));
    return _prefetched;
  }
  _prefetched = filterService.getAllOptions({})
    .then(r => {
      const opts = r?.data?.options || {};
      setCached(cacheKey, opts);
      return opts;
    })
    .catch(() => null)
    .finally(() => { /* keep _prefetched so we don't refetch */ });
  return _prefetched;
}

// Public component — sidebar mounts <PremiumFilterBar isOpen={expanded} />
// to render the panel inline.  When `isOpen` is false the panel collapses
// to 0 height with smooth animation; when true it expands.  Renders nothing
// at all on routes outside FILTER_ROUTES, so other pages aren't affected.
export default function PremiumFilterBar({ isOpen = false }) {
  const router = useRouter();
  const api = useSharedFilters();
  const visible = api && FILTER_ROUTES.has(router.pathname);

  // Kick prefetch as soon as the panel mounts.  Even if the user never hovers
  // the rail, this only costs one HTTP round-trip and warms cache for the
  // FilterChips bar in-page.
  useEffect(() => {
    if (visible) prefetchOptions();
  }, [visible]);

  if (!visible) return null;
  return <Panel api={api} isOpen={isOpen} />;
}

function Panel({ api, isOpen }) {
  const { filters, setFilter, clearAll, activeCount } = api;

  const [optionsByDim, setOptionsByDim] = useState(() => {
    const c = getCached(filterOptionsCacheKey({}));
    return c || {};
  });
  const [loading, setLoading] = useState(() => Object.keys(getCached(filterOptionsCacheKey({})) || {}).length === 0);
  const debounceRef = useRef(null);
  const requestId   = useRef(0);
  const activeKeyRef = useRef('');

  const fetchOptions = async (params, cacheKey) => {
    const myId      = ++requestId.current;
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
      if (myId === requestId.current && activeKeyRef.current === issuedFor) setLoading(false);
    }
  };

  useEffect(() => {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v) && v.length === 0) return;
      params[toApiKey(k)] = Array.isArray(v) ? v.join(',') : v;
    });
    const key = filterOptionsCacheKey(params);
    activeKeyRef.current = key;

    const cached = getCached(key);
    if (cached) {
      setOptionsByDim(cached);
      setLoading(false);
      if (isFresh(key)) return;
    } else {
      setLoading(prev => Object.keys(optionsByDim).length === 0);
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchOptions(params, key), 100);
    return () => { clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  const mode = filters.mode || 'active';

  return (
    <div className={`px-side${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
      <div className="px-side__inner">
        {/* ─── Header — gold "LENS" wordmark + active count + reset ─── */}
        <div className="px-side__head">
          <div className="px-side__brand">
            <Sparkles size={12} className="px-side__brand-icon" />
            <span className="px-side__brand-text">Lens</span>
          </div>
          {activeCount > 0 && <span className="px-side__count">{activeCount}</span>}
          {activeCount > 0 && (
            <button type="button" className="px-side__reset" onClick={clearAll} title="Clear every filter except mode">
              <RotateCcw size={10} strokeWidth={2.4} />
              <span>Reset</span>
            </button>
          )}
        </div>

        {/* ─── Mode pill ─── */}
        <div className="px-side__mode-wrap">
          <ModePill mode={mode} onChange={(m) => setFilter('mode', m)} />
        </div>

        {/* ─── Filter groups ─── */}
        <div className="px-side__groups">
          {FILTER_GROUPS.map((group) => (
            <FilterGroup
              key={group.name}
              group={group}
              filters={filters}
              setFilter={setFilter}
              optionsByDim={optionsByDim}
              loading={loading}
            />
          ))}
        </div>
      </div>

      <style jsx>{`
        .px-side {
          /* Sits inline within the sidebar's <nav>.  Animates open/closed
             via grid-template-rows so we get smooth height transitions
             without measuring scrollHeight in JS. */
          display: grid;
          grid-template-rows: 0fr;
          opacity: 0;
          transition:
            grid-template-rows 320ms cubic-bezier(0.16,1,0.3,1),
            opacity 220ms cubic-bezier(0.4,0,0.2,1);
          margin: 4px 0 8px;
          pointer-events: none;
        }
        .px-side.is-open {
          grid-template-rows: 1fr;
          opacity: 1;
          pointer-events: auto;
        }
        .px-side__inner {
          min-height: 0;
          overflow: hidden;
        }

        .px-side__head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 6px 8px;
          border-top: 1px solid var(--border-subtle);
          margin-top: 4px;
        }
        .px-side__brand {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .px-side__brand-icon {
          color: var(--accent-primary);
          filter: drop-shadow(0 0 6px rgba(225,29,46,0.30));
        }
        .px-side__brand-text {
          font-family: var(--font-display);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          background: linear-gradient(
            135deg,
            var(--text-secondary) 0%,
            var(--accent-primary) 130%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .px-side__count {
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--accent-primary) 0%, #B91020 100%);
          color: #fff;
          font-family: var(--font-body);
          font-size: 9px;
          font-weight: 800;
          line-height: 1;
          font-variant-numeric: tabular-nums;
          box-shadow:
            0 1px 4px rgba(225,29,46,0.40),
            inset 0 1px 0 rgba(255,255,255,0.25);
        }
        .px-side__reset {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 22px;
          padding: 0 8px;
          background: transparent;
          border: 1px solid var(--border-default);
          border-radius: 999px;
          color: var(--text-muted);
          font-family: var(--font-body);
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.04em;
          cursor: pointer;
          transition:
            color 200ms cubic-bezier(0.4,0,0.2,1),
            border-color 200ms cubic-bezier(0.4,0,0.2,1),
            background 200ms cubic-bezier(0.4,0,0.2,1),
            transform 240ms cubic-bezier(0.16,1,0.3,1);
        }
        .px-side__reset:hover {
          color: var(--accent-primary);
          border-color: var(--accent-border);
          background: var(--accent-glow);
          transform: translateY(-1px);
        }

        .px-side__mode-wrap {
          padding: 0 4px 8px;
          border-bottom: 1px solid var(--border-subtle);
        }

        .px-side__groups {
          padding: 4px 0 0;
          max-height: calc(100vh - 420px);
          overflow-y: auto;
          overflow-x: hidden;
          scrollbar-width: thin;
          scrollbar-color: var(--border-default) transparent;
        }
        .px-side__groups::-webkit-scrollbar { width: 5px; }
        .px-side__groups::-webkit-scrollbar-thumb {
          background: var(--border-default);
          border-radius: 6px;
        }
        .px-side__groups::-webkit-scrollbar-track { background: transparent; }
      `}</style>
    </div>
  );
}

// ─── Filter group — chevron-collapsible vertical section ────────────────────
function FilterGroup({ group, filters, setFilter, optionsByDim, loading }) {
  const [open, setOpen] = useState(true);
  const groupActive = group.dims.reduce((n, d) => {
    const v = filters[d.key];
    return n + ((Array.isArray(v) ? v.length : (v ? 1 : 0)) > 0 ? 1 : 0);
  }, 0);

  return (
    <div className="px-grp">
      <button
        type="button"
        className={`px-grp__head${open ? ' is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="px-grp__title">{group.name}</span>
        {groupActive > 0 && <span className="px-grp__badge">{groupActive}</span>}
        <span className="px-grp__caret"><ChevronDown size={12} strokeWidth={2.2} /></span>
      </button>

      <div className={`px-grp__body${open ? ' is-open' : ''}`}>
        <div className="px-grp__body-inner">
          {group.dims.map(d => (
            <div key={d.key} className="px-grp__row">
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
      </div>

      <style jsx>{`
        .px-grp {
          padding: 2px 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .px-grp:last-child { border-bottom: none; }

        .px-grp__head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 4px;
          background: transparent;
          border: none;
          cursor: pointer;
          color: var(--text-muted);
          transition: color 200ms cubic-bezier(0.4,0,0.2,1);
        }
        .px-grp__head:hover { color: var(--text-primary); }
        .px-grp__head.is-open { color: var(--text-secondary); }

        .px-grp__title {
          font-family: var(--font-body);
          font-size: 9.5px;
          font-weight: 800;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .px-grp__badge {
          min-width: 14px;
          height: 14px;
          padding: 0 4px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--accent-glow);
          color: var(--accent-primary);
          border: 1px solid var(--accent-border);
          border-radius: 999px;
          font-size: 8.5px;
          font-weight: 800;
          line-height: 1;
        }
        .px-grp__caret {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          transition: transform 280ms cubic-bezier(0.16,1,0.3,1);
        }
        .px-grp__head.is-open .px-grp__caret {
          transform: rotate(180deg);
          color: var(--accent-primary);
        }

        .px-grp__body {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 320ms cubic-bezier(0.16,1,0.3,1);
        }
        .px-grp__body.is-open { grid-template-rows: 1fr; }
        .px-grp__body-inner {
          min-height: 0;
          overflow: hidden;
        }
        .px-grp__row {
          padding: 3px 0 6px;
        }
        .px-grp__row :global(button) {
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
        }
      `}</style>
    </div>
  );
}

// ─── ModePill — Active / Inactive / All sliding indicator ──────────────────
function ModePill({ mode, onChange }) {
  const OPTS = [
    { key: 'active',   label: 'Active'   },
    { key: 'inactive', label: 'Inactive' },
    { key: 'all',      label: 'All'      },
  ];
  const idx = Math.max(0, OPTS.findIndex(o => o.key === mode));
  const segPct = 100 / OPTS.length;

  return (
    <div className="px-mode">
      <span
        className="px-mode__indicator"
        style={{
          left:  `calc(${idx * segPct}% + 3px)`,
          width: `calc(${segPct}% - 6px)`,
        }}
      />
      {OPTS.map(opt => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={`px-mode__btn${mode === opt.key ? ' is-active' : ''}`}
        >
          {opt.label}
        </button>
      ))}

      <style jsx>{`
        .px-mode {
          position: relative;
          display: flex;
          align-items: center;
          width: 100%;
          height: 30px;
          padding: 3px;
          border-radius: 999px;
          background: var(--bg-elevated);
          border: 1px solid var(--border-default);
          box-shadow: inset 0 1px 2px rgba(15,23,42,0.06);
        }
        .px-mode__indicator {
          position: absolute;
          top: 3px;
          bottom: 3px;
          background: linear-gradient(135deg, var(--accent-primary) 0%, #B91020 100%);
          border-radius: 999px;
          box-shadow:
            0 2px 6px rgba(225,29,46,0.32),
            inset 0 1px 0 rgba(255,255,255,0.20);
          transition:
            left 320ms cubic-bezier(0.16,1,0.3,1),
            width 320ms cubic-bezier(0.16,1,0.3,1);
        }
        .px-mode__btn {
          position: relative;
          z-index: 1;
          flex: 1;
          background: transparent;
          border: none;
          cursor: pointer;
          height: 100%;
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted);
          transition: color 240ms cubic-bezier(0.4,0,0.2,1);
        }
        .px-mode__btn:hover { color: var(--text-primary); }
        .px-mode__btn.is-active {
          color: #ffffff;
          text-shadow: 0 1px 2px rgba(0,0,0,0.20);
        }
      `}</style>
    </div>
  );
}
