// ─── SidebarFilterPanel — luxury filter cluster slotted into the sidebar ───
// Renders at the BOTTOM of the left navigation rail (below "User
// Management"), only on /network and /sales, and only when the rail is
// in its hovered/expanded state.  Mode (Active/Inactive/All) lives on
// each page — the panel is purely dimensional filters.
//
// Why mount-on-hover (not always-on-hidden):
//   • 13 MultiSelect instances are heavy.  Keeping them mounted-but-hidden
//     bleeds memory and triggers reflows on every render.
//   • When the cursor leaves the sidebar, any open MultiSelect popover
//     (portaled to <body>) would otherwise float disconnected.  Unmounting
//     the panel with the rail collapses every popover for free.
//   • The mount cost is ~5–10 ms on a CEO laptop because options are
//     pre-warmed in the module-level cache (prefetchOptions fires the
//     unfiltered bundle the moment the provider mounts the page).
//
// Aesthetic notes:
//   • Champagne-gold "LENS" wordmark, brand-red gradient text-fill
//   • Each filter group is a chevron-collapsible section
//   • Spring-eased opening (320 ms cubic-bezier)
//   • Theme-symmetric — dark mode swaps to deep-navy automatically

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

// Module-level prefetch — fires the unfiltered options bundle into cache the
// moment a filter-aware page mounts.  Single in-flight promise, never refetched
// in the same tab.  By the time the user hovers the sidebar, the cache is hot.
let _prefetched = null;
export function prefetchFilterOptions() {
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
    .catch(() => null);
  return _prefetched;
}

export default function PremiumFilterBar({ isOpen = false }) {
  const router = useRouter();
  const api = useSharedFilters();
  const visible = api && FILTER_ROUTES.has(router.pathname);

  // Kick the prefetch as soon as the panel is mountable, even before the
  // user hovers.  This is the secret to "0-latency" hover.
  useEffect(() => {
    if (visible) prefetchFilterOptions();
  }, [visible]);

  if (!visible) return null;

  // Mount-on-hover: when the sidebar is collapsed we render only the
  // outer wrapper (so the layout reserves no extra space) and skip all
  // MultiSelect children entirely.  Open popovers are torn down with
  // the panel — they can't get stranded outside the rail.
  return (
    <div className={`px-side${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
      {isOpen && <Panel api={api} />}
      <style jsx>{`
        .px-side {
          display: grid;
          grid-template-rows: 0fr;
          opacity: 0;
          transition:
            grid-template-rows 320ms cubic-bezier(0.16,1,0.3,1),
            opacity 220ms cubic-bezier(0.4,0,0.2,1);
          margin: 6px 0 0;
          pointer-events: none;
        }
        .px-side.is-open {
          grid-template-rows: 1fr;
          opacity: 1;
          pointer-events: auto;
        }
      `}</style>
    </div>
  );
}

function Panel({ api }) {
  const { filters, setFilter, clearAll, activeCount } = api;

  // Synchronous read from the prefetched cache so first paint is already
  // populated — no spinners, no first-hover stall.
  const [optionsByDim, setOptionsByDim] = useState(() => {
    const c = getCached(filterOptionsCacheKey({}));
    return c || {};
  });
  const [loading, setLoading] = useState(() => {
    const c = getCached(filterOptionsCacheKey({}));
    return !c || Object.keys(c).length === 0;
  });
  const debounceRef  = useRef(null);
  const requestId    = useRef(0);
  const activeKeyRef = useRef('');

  const fetchOptions = async (params, cacheKey) => {
    const myId = ++requestId.current;
    try {
      const r = await filterService.getAllOptions(params);
      if (myId !== requestId.current) return;
      const opts = r.data?.options || {};
      setCached(cacheKey, opts);
      if (activeKeyRef.current === cacheKey) {
        setOptionsByDim(opts);
        setLoading(false);
      }
    } catch (e) {
      if (myId === requestId.current && activeKeyRef.current === cacheKey) setLoading(false);
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

  return (
    <div className="px-side__inner">
      {/* ─── Header — gold "LENS" wordmark + active count + reset ─── */}
      <div className="px-side__head">
        <div className="px-side__brand">
          <Sparkles size={12} className="px-side__brand-icon" />
          <span className="px-side__brand-text">Lens</span>
        </div>
        {activeCount > 0 && <span className="px-side__count">{activeCount}</span>}
        {activeCount > 0 && (
          <button
            type="button"
            className="px-side__reset"
            onClick={clearAll}
            title="Clear every filter"
          >
            <RotateCcw size={10} strokeWidth={2.4} />
            <span>Reset</span>
          </button>
        )}
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

      <style jsx>{`
        .px-side__inner {
          min-height: 0;
          overflow: hidden;
          padding: 4px 6px 0;
          border-top: 1px solid var(--border-subtle);
          margin-top: 6px;
        }
        .px-side__head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 4px 10px;
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
          background: linear-gradient(135deg, var(--text-secondary) 0%, var(--accent-primary) 130%);
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
        .px-side__groups {
          padding: 2px 0 8px;
          max-height: calc(100vh - 320px);
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
