// ─── SidebarFilterPanel — premium luxury filter cluster ─────────────────────
// Lives at the bottom of the left navigation rail, mounts on hover, only on
// /network and /sales.  This is the version after the "make it actually
// premium" pass — every pill is embossed, every selection lights a left-edge
// accent bar, the LENS wordmark sits in a gold-bordered chip with a shimmer
// that sweeps every six seconds, sections are separated by a fading gold
// hairline, and group expand cascades each child pill in with a tiny stagger.
//
// Reference: Hermès digital catalogue, Bloomberg Terminal v2 boxes, Apple
// Pro Display Settings sliders.  The goal is "this software costs more than
// the laptop it runs on" — without leaving Spykar's brand red.

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
    eyebrow: 'What it is',
    dims: [
      { key: 'gender_name', label: 'Gender',      apiKey: 'gender'      },
      { key: 'category',    label: 'Category',    apiKey: 'category'    },
      { key: 'product',     label: 'Product',     apiKey: 'product'     },
      { key: 'sub_product', label: 'Sub-product', apiKey: 'sub_product' },
    ],
  },
  {
    name: 'Attributes',
    eyebrow: 'How it looks',
    dims: [
      { key: 'size',  label: 'Size',   apiKey: 'size'  },
      { key: 'color', label: 'Colour', apiKey: 'color' },
      { key: 'shade', label: 'Shade',  apiKey: 'shade' },
      { key: 'style', label: 'Style',  apiKey: 'style' },
    ],
  },
  {
    name: 'Location',
    eyebrow: 'Where it lives',
    dims: [
      { key: 'state',      label: 'State', apiKey: 'state'      },
      { key: 'city',       label: 'City',  apiKey: 'city'       },
      { key: 'store_code', label: 'Store', apiKey: 'store_code' },
    ],
  },
  {
    name: 'Business',
    eyebrow: 'Who & when',
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

  useEffect(() => {
    if (visible) prefetchFilterOptions();
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={`lux${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
      {isOpen && <Panel api={api} />}
      <style jsx>{`
        .lux {
          display: grid;
          grid-template-rows: 0fr;
          opacity: 0;
          transition:
            grid-template-rows 320ms cubic-bezier(0.16,1,0.3,1),
            opacity 220ms cubic-bezier(0.4,0,0.2,1);
          margin: 6px 0 0;
          pointer-events: none;
        }
        .lux.is-open {
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
    <div className="lux__inner">
      {/* ─── Wordmark — sits in a gold-bordered chip with a slow shimmer ─── */}
      <div className="lux__crown">
        <div className="lux__mark">
          <Sparkles size={11} className="lux__mark-icon" />
          <span className="lux__mark-text">Lens</span>
          <span className="lux__shimmer" aria-hidden />
        </div>
        {activeCount > 0 && <span className="lux__count">{activeCount}</span>}
        {activeCount > 0 && (
          <button
            type="button"
            className="lux__reset"
            onClick={clearAll}
            title="Clear every filter"
          >
            <RotateCcw size={10} strokeWidth={2.4} />
            <span>Reset</span>
          </button>
        )}
      </div>

      {/* ─── Filter groups ─── */}
      <div className="lux__groups">
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
        .lux__inner {
          min-height: 0;
          overflow: hidden;
          padding: 4px 4px 8px;
          /* Top hairline that fades in from accent → transparent so the
             panel reads as a continuation of the rail above. */
          margin-top: 8px;
          position: relative;
        }
        .lux__inner::before {
          content: '';
          position: absolute;
          left: 12px; right: 12px; top: 0;
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(225,29,46,0.30) 50%,
            transparent 100%);
          opacity: 0.7;
        }

        /* ─── Crown (wordmark + count + reset) ─── */
        .lux__crown {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 14px 6px 12px;
        }
        .lux__mark {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 22px;
          padding: 0 10px 0 8px;
          border-radius: 999px;
          background: linear-gradient(
            135deg,
            rgba(225,29,46,0.10) 0%,
            rgba(225,29,46,0.02) 100%);
          border: 1px solid rgba(225,29,46,0.32);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 1px 4px rgba(225,29,46,0.18);
          overflow: hidden;
        }
        .lux__mark-icon {
          color: var(--accent-primary);
          filter: drop-shadow(0 0 4px rgba(225,29,46,0.50));
        }
        .lux__mark-text {
          font-family: var(--font-display);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.24em;
          text-transform: uppercase;
          color: var(--accent-primary);
          /* No gradient text-fill on dark surfaces — washes out.  The chip
             frame already establishes the brand, the text just needs to
             read clearly. */
        }
        /* Slow shimmer that sweeps across the chip every 6s — barely there
           but unmistakably "alive". */
        .lux__shimmer {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            105deg,
            transparent 30%,
            rgba(255,255,255,0.18) 50%,
            transparent 70%);
          transform: translateX(-100%);
          animation: luxShimmer 6s cubic-bezier(0.4,0,0.2,1) infinite;
          pointer-events: none;
        }
        @keyframes luxShimmer {
          0%   { transform: translateX(-100%); }
          60%  { transform: translateX(100%); }
          100% { transform: translateX(100%); }
        }

        .lux__count {
          min-width: 20px;
          height: 20px;
          padding: 0 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--accent-primary) 0%, #B91020 100%);
          color: #fff;
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
          font-variant-numeric: tabular-nums;
          box-shadow:
            0 1px 4px rgba(225,29,46,0.45),
            inset 0 1px 0 rgba(255,255,255,0.30);
        }
        .lux__reset {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 24px;
          padding: 0 10px;
          background: transparent;
          border: 1px solid var(--border-default);
          border-radius: 999px;
          color: var(--text-muted);
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          cursor: pointer;
          transition:
            color 200ms cubic-bezier(0.4,0,0.2,1),
            border-color 200ms cubic-bezier(0.4,0,0.2,1),
            background 200ms cubic-bezier(0.4,0,0.2,1),
            transform 240ms cubic-bezier(0.16,1,0.3,1);
        }
        .lux__reset:hover {
          color: var(--accent-primary);
          border-color: var(--accent-border);
          background: var(--accent-glow);
          transform: translateY(-1px);
        }

        /* ─── Groups list ─── */
        .lux__groups {
          padding: 2px 0 8px;
          max-height: calc(100vh - 280px);
          overflow-y: auto;
          overflow-x: hidden;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.10) transparent;
        }
        .lux__groups::-webkit-scrollbar { width: 4px; }
        .lux__groups::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.10);
          border-radius: 6px;
        }
        .lux__groups::-webkit-scrollbar-track { background: transparent; }
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
    <div className="grp">
      <button
        type="button"
        className={`grp__head${open ? ' is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="grp__title-wrap">
          <span className="grp__title">{group.name}</span>
          <span className="grp__eyebrow">{group.eyebrow}</span>
        </div>
        {groupActive > 0 && <span className="grp__badge">{groupActive}</span>}
        <span className="grp__caret"><ChevronDown size={12} strokeWidth={2.2} /></span>
      </button>

      <div className={`grp__body${open ? ' is-open' : ''}`}>
        <div className="grp__body-inner">
          {group.dims.map((d, i) => {
            const value = filters[d.key];
            const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
            return (
              <div
                key={d.key}
                className={`pill${hasValue ? ' is-active' : ''}`}
                style={{ '--stagger': `${i * 28}ms` }}
              >
                <MultiSelect
                  label={d.label}
                  options={optionsByDim[d.apiKey] || []}
                  value={filters[d.key] || []}
                  onChange={(v) => setFilter(d.key, v)}
                  loading={loading && !optionsByDim[d.apiKey]}
                  placeholder="—"
                  compact
                />
              </div>
            );
          })}
        </div>
      </div>

      <style jsx>{`
        /* ─── Group container ─── */
        .grp {
          padding: 2px 0;
          position: relative;
        }
        /* Fading gold hairline between sections instead of a solid border */
        .grp:not(:last-child)::after {
          content: '';
          position: absolute;
          left: 12px; right: 12px; bottom: 0;
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(225,29,46,0.16) 22%,
            rgba(255,255,255,0.04) 50%,
            rgba(225,29,46,0.16) 78%,
            transparent 100%);
        }

        /* ─── Section header ─── */
        .grp__head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 6px 10px;
          background: transparent;
          border: none;
          cursor: pointer;
          color: var(--text-muted);
          transition: color 200ms cubic-bezier(0.4,0,0.2,1);
        }
        .grp__head:hover { color: var(--text-primary); }
        .grp__head.is-open { color: var(--text-secondary); }
        .grp__title-wrap {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 2px;
          min-width: 0;
        }
        .grp__title {
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          line-height: 1;
        }
        .grp__eyebrow {
          font-family: var(--font-display);
          font-style: italic;
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.01em;
          color: var(--text-disabled);
          line-height: 1;
        }
        .grp__badge {
          margin-left: auto;
          min-width: 16px;
          height: 16px;
          padding: 0 5px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--accent-glow);
          color: var(--accent-primary);
          border: 1px solid var(--accent-border);
          border-radius: 999px;
          font-size: 9px;
          font-weight: 800;
          line-height: 1;
        }
        .grp__caret {
          margin-left: ${groupActive > 0 ? '6px' : 'auto'};
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--text-disabled);
          transition:
            transform 280ms cubic-bezier(0.16,1,0.3,1),
            color 200ms cubic-bezier(0.4,0,0.2,1);
        }
        .grp__head:hover .grp__caret { color: var(--text-secondary); }
        .grp__head.is-open .grp__caret {
          transform: rotate(180deg);
          color: var(--accent-primary);
        }

        /* ─── Group body — collapsible ─── */
        .grp__body {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 320ms cubic-bezier(0.16,1,0.3,1);
        }
        .grp__body.is-open { grid-template-rows: 1fr; }
        .grp__body-inner {
          min-height: 0;
          overflow: hidden;
          padding-bottom: 10px;
        }

        /* ─── Pill (each MultiSelect) ─── */
        .pill {
          position: relative;
          padding: 3px 4px 6px;
          opacity: 0;
          transform: translateY(-4px);
          transition:
            opacity 320ms cubic-bezier(0.16,1,0.3,1) var(--stagger),
            transform 360ms cubic-bezier(0.16,1,0.3,1) var(--stagger);
        }
        .grp__body.is-open .pill {
          opacity: 1;
          transform: translateY(0);
        }
        /* Left accent bar — only when this dimension has a value */
        .pill::before {
          content: '';
          position: absolute;
          left: 0;
          top: 9px; bottom: 12px;
          width: 2px;
          border-radius: 2px;
          background: linear-gradient(180deg, var(--accent-primary), #B91020);
          box-shadow: 0 0 8px rgba(225,29,46,0.45);
          opacity: 0;
          transform: scaleY(0.4);
          transform-origin: center;
          transition:
            opacity 220ms cubic-bezier(0.4,0,0.2,1),
            transform 320ms cubic-bezier(0.16,1,0.3,1);
        }
        .pill.is-active::before {
          opacity: 1;
          transform: scaleY(1);
        }

        /* ─── Embossed MultiSelect button — overrides MultiSelect's inline
             styles via :global + !important ───────────────────────────── */
        .pill :global(button) {
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
          height: 36px !important;
          padding: 0 12px !important;
          background: linear-gradient(
            180deg,
            rgba(255,255,255,0.04) 0%,
            rgba(255,255,255,0.015) 100%) !important;
          border: 1px solid rgba(255,255,255,0.06) !important;
          border-radius: 10px !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.04),
            0 1px 2px rgba(0,0,0,0.30) !important;
          transition:
            transform 220ms cubic-bezier(0.16,1,0.3,1),
            border-color 220ms cubic-bezier(0.4,0,0.2,1),
            box-shadow 220ms cubic-bezier(0.4,0,0.2,1) !important;
        }
        .pill :global(button:hover) {
          transform: translateY(-1px) !important;
          border-color: rgba(225,29,46,0.32) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 4px 14px rgba(0,0,0,0.45),
            0 0 0 1px rgba(225,29,46,0.10) !important;
        }
        .pill.is-active :global(button) {
          background: linear-gradient(
            180deg,
            rgba(225,29,46,0.10) 0%,
            rgba(225,29,46,0.03) 100%) !important;
          border-color: rgba(225,29,46,0.28) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 1px 2px rgba(0,0,0,0.30),
            0 0 0 1px rgba(225,29,46,0.10) !important;
        }
        .pill.is-active :global(button:hover) {
          border-color: rgba(225,29,46,0.45) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 4px 14px rgba(225,29,46,0.20),
            0 0 0 1px rgba(225,29,46,0.18) !important;
        }

        /* Light-mode override — flip surface + shadows */
        :global(html.theme-light) .pill :global(button) {
          background: linear-gradient(
            180deg,
            rgba(255,255,255,0.92) 0%,
            rgba(248,250,252,0.78) 100%) !important;
          border: 1px solid rgba(15,23,42,0.08) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.80),
            0 1px 2px rgba(15,23,42,0.06) !important;
        }
        :global(html.theme-light) .pill :global(button:hover) {
          border-color: rgba(225,29,46,0.30) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.90),
            0 4px 14px rgba(15,23,42,0.10),
            0 0 0 1px rgba(225,29,46,0.10) !important;
        }
        :global(html.theme-light) .pill.is-active :global(button) {
          background: linear-gradient(
            180deg,
            rgba(255,255,255,1) 0%,
            rgba(254,242,243,0.96) 100%) !important;
          border-color: rgba(225,29,46,0.35) !important;
        }
      `}</style>
    </div>
  );
}
