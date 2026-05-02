// ─── SidebarFilterPanel — luxury LENS cluster (rich edition) ────────────────
// Sits at the bottom of the left navigation rail, mounts on hover, only on
// /network and /sales.  Every dimension has its own icon, every pill is
// embossed with a deep cushion shadow, the LENS chip glows softly behind
// itself, and the dropdown popover is fully re-skinned via a className we
// thread through MultiSelect (popoverClassName="lux-pop").
//
// Design cues borrowed from:
//   • Hermès Faubourg digital catalogue — deep felt-black surfaces, gold
//     accent hairlines, italic display eyebrows
//   • Bloomberg Terminal v2 boxes — tight typographic rhythm, tabular nums
//   • Linear / Things 3 — staggered reveal, spring easings
//   • Apple Pro Display Settings — pillows + pressed-in pills

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import {
  Sparkles, RotateCcw, ChevronDown,
  Users, Tag, Shirt, Layers,
  Ruler, Palette, Droplets, Brush,
  MapPin, Building2, Store,
  CalendarRange, Briefcase,
} from 'lucide-react';
import MultiSelect from '../filters/MultiSelect';
import { filterService } from '../../lib/services';
import { getCached, setCached, isFresh } from '../../lib/dashboardCache';
import { useSharedFilters } from '../../lib/FiltersContext';

const FILTER_ROUTES = new Set(['/network', '/sales']);

// Each dimension carries a tiny lucide glyph rendered to the LEFT of the
// MultiSelect trigger.  Adds richness without clutter — a CEO scans icons
// faster than text labels.
const FILTER_GROUPS = [
  {
    name: 'Product',
    eyebrow: 'What it is',
    dims: [
      { key: 'gender_name', label: 'Gender',      apiKey: 'gender',      Icon: Users  },
      { key: 'category',    label: 'Category',    apiKey: 'category',    Icon: Tag    },
      { key: 'product',     label: 'Product',     apiKey: 'product',     Icon: Shirt  },
      { key: 'sub_product', label: 'Sub-product', apiKey: 'sub_product', Icon: Layers },
    ],
  },
  {
    name: 'Attributes',
    eyebrow: 'How it looks',
    dims: [
      { key: 'size',  label: 'Size',   apiKey: 'size',  Icon: Ruler    },
      { key: 'color', label: 'Colour', apiKey: 'color', Icon: Palette  },
      { key: 'shade', label: 'Shade',  apiKey: 'shade', Icon: Droplets },
      { key: 'style', label: 'Style',  apiKey: 'style', Icon: Brush    },
    ],
  },
  {
    name: 'Location',
    eyebrow: 'Where it lives',
    dims: [
      { key: 'state',      label: 'State', apiKey: 'state',      Icon: MapPin     },
      { key: 'city',       label: 'City',  apiKey: 'city',       Icon: Building2  },
      { key: 'store_code', label: 'Store', apiKey: 'store_code', Icon: Store      },
    ],
  },
  {
    name: 'Business',
    eyebrow: 'Who & when',
    dims: [
      { key: 'season',     label: 'Season', apiKey: 'season',     Icon: CalendarRange },
      { key: 'group_name', label: 'Party',  apiKey: 'group_name', Icon: Briefcase     },
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
      <LuxPopoverStyles />
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
      {/* ─── Crown — wordmark + ambient glow + count + reset ─── */}
      <div className="lux__crown">
        <span className="lux__halo" aria-hidden />
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
          position: relative;
          min-height: 0;
          overflow: hidden;
          padding: 6px 4px 8px;
          margin-top: 8px;
          /* Subtle vertical gradient sheen — almost imperceptible but lifts
             the panel off the sidebar background and gives it presence. */
          background: linear-gradient(
            180deg,
            rgba(225,29,46,0.04) 0%,
            rgba(225,29,46,0.00) 22%,
            rgba(255,255,255,0.00) 80%,
            rgba(225,29,46,0.02) 100%);
        }
        /* Top hairline that fades through accent red */
        .lux__inner::before {
          content: '';
          position: absolute;
          left: 12px; right: 12px; top: 0;
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(225,29,46,0.34) 50%,
            transparent 100%);
        }

        /* ─── Crown ─── */
        .lux__crown {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 16px 6px 14px;
        }
        /* Soft red halo behind the LENS chip — STATIC.  An animated radial
           blur was repainting 14px of pixels every frame and chewing scroll
           perf; the static version reads identically and costs nothing. */
        .lux__halo {
          position: absolute;
          top: -8px;
          left: -8px;
          width: 110px;
          height: 56px;
          background: radial-gradient(
            ellipse at center,
            rgba(225,29,46,0.28) 0%,
            rgba(225,29,46,0.06) 38%,
            transparent 72%);
          filter: blur(12px);
          pointer-events: none;
          opacity: 0.80;
          contain: paint;
        }

        .lux__mark {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          height: 24px;
          padding: 0 11px 0 9px;
          border-radius: 999px;
          background: linear-gradient(
            135deg,
            rgba(225,29,46,0.16) 0%,
            rgba(225,29,46,0.04) 100%);
          border: 1px solid rgba(225,29,46,0.40);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.10),
            inset 0 -1px 0 rgba(0,0,0,0.20),
            0 1px 6px rgba(225,29,46,0.28);
          overflow: hidden;
        }
        .lux__mark-icon {
          color: var(--accent-primary);
          filter: drop-shadow(0 0 6px rgba(225,29,46,0.70));
        }
        .lux__mark-text {
          font-family: var(--font-display);
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.26em;
          text-transform: uppercase;
          color: #FFFFFF;
          text-shadow: 0 1px 2px rgba(225,29,46,0.40);
        }
        .lux__shimmer {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            105deg,
            transparent 30%,
            rgba(255,255,255,0.22) 50%,
            transparent 70%);
          transform: translateX(-100%);
          animation: luxShimmer 5.5s cubic-bezier(0.4,0,0.2,1) infinite;
          pointer-events: none;
        }
        @keyframes luxShimmer {
          0%   { transform: translateX(-100%); }
          55%  { transform: translateX(140%); }
          100% { transform: translateX(140%); }
        }

        .lux__count {
          min-width: 22px;
          height: 22px;
          padding: 0 7px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--accent-primary) 0%, #B91020 100%);
          color: #fff;
          font-family: var(--font-body);
          font-size: 10.5px;
          font-weight: 800;
          line-height: 1;
          font-variant-numeric: tabular-nums;
          box-shadow:
            0 2px 6px rgba(225,29,46,0.50),
            inset 0 1px 0 rgba(255,255,255,0.30),
            inset 0 -1px 0 rgba(0,0,0,0.16);
        }
        .lux__reset {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 24px;
          padding: 0 10px;
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 999px;
          color: var(--text-muted);
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          cursor: pointer;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
          transition:
            color 200ms cubic-bezier(0.4,0,0.2,1),
            border-color 200ms cubic-bezier(0.4,0,0.2,1),
            background 200ms cubic-bezier(0.4,0,0.2,1),
            transform 240ms cubic-bezier(0.16,1,0.3,1);
        }
        .lux__reset:hover {
          color: var(--accent-primary);
          border-color: rgba(225,29,46,0.45);
          background: linear-gradient(180deg, rgba(225,29,46,0.14), rgba(225,29,46,0.04));
          transform: translateY(-1px);
        }

        /* ─── Groups list ────────────────────────────────────────────────
           No inner scroll container.  The sidebar's <nav> is ALREADY a
           scroll region; nesting a second one inside it makes the wheel
           hand off awkwardly between the two and feels janky.  Letting
           the groups grow naturally and scrolling the whole nav gives one
           smooth surface — and removes the need for a custom scrollbar
           inside the panel entirely. */
        .lux__groups {
          padding: 2px 0 8px;
        }
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
            const Icon = d.Icon;
            return (
              <div
                key={d.key}
                className={`pill${hasValue ? ' is-active' : ''}`}
                style={{ '--stagger': `${i * 18}ms` }}
              >
                <span className="pill__icon" aria-hidden>
                  <Icon size={12} strokeWidth={2} />
                </span>
                <MultiSelect
                  label={d.label}
                  options={optionsByDim[d.apiKey] || []}
                  value={filters[d.key] || []}
                  onChange={(v) => setFilter(d.key, v)}
                  loading={loading && !optionsByDim[d.apiKey]}
                  placeholder="—"
                  compact
                  popoverClassName="lux-pop"
                />
              </div>
            );
          })}
        </div>
      </div>

      <style jsx>{`
        .grp { padding: 2px 0; position: relative; }
        .grp:not(:last-child)::after {
          content: '';
          position: absolute;
          left: 14px; right: 14px; bottom: 0;
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(225,29,46,0.18) 28%,
            rgba(255,255,255,0.06) 50%,
            rgba(225,29,46,0.18) 72%,
            transparent 100%);
        }

        .grp__head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 14px 6px 12px;
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
          gap: 3px;
          min-width: 0;
        }
        .grp__title {
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.22em;
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
          min-width: 18px;
          height: 18px;
          padding: 0 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, rgba(225,29,46,0.18), rgba(225,29,46,0.06));
          color: var(--accent-primary);
          border: 1px solid rgba(225,29,46,0.45);
          border-radius: 999px;
          font-size: 9.5px;
          font-weight: 800;
          line-height: 1;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.04),
            0 1px 3px rgba(225,29,46,0.20);
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

        .grp__body {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 320ms cubic-bezier(0.16,1,0.3,1);
        }
        .grp__body.is-open { grid-template-rows: 1fr; }
        .grp__body-inner {
          min-height: 0;
          overflow: hidden;
          padding-bottom: 12px;
        }

        /* ─── Pill: row that wraps the trigger button + the dimension icon ── */
        .pill {
          position: relative;
          display: flex;
          align-items: center;
          gap: 0;
          padding: 4px 4px 7px;
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
        /* Left accent bar — only when the dimension has a value */
        .pill::before {
          content: '';
          position: absolute;
          left: -2px;
          top: 11px; bottom: 14px;
          width: 2px;
          border-radius: 0 2px 2px 0;
          background: linear-gradient(180deg, var(--accent-primary), #B91020);
          box-shadow:
            0 0 10px rgba(225,29,46,0.55),
            0 0 2px rgba(225,29,46,0.85);
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

        /* Dimension icon — sits in a small embossed circle to the left of
           the trigger.  Brightens when the pill is active, the same way the
           accent bar lights up. */
        .pill__icon {
          flex-shrink: 0;
          width: 22px; height: 22px;
          margin-right: 7px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--text-disabled);
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 7px;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.04),
            0 1px 2px rgba(0,0,0,0.30);
          transition:
            color 220ms cubic-bezier(0.4,0,0.2,1),
            border-color 220ms cubic-bezier(0.4,0,0.2,1),
            box-shadow 220ms cubic-bezier(0.4,0,0.2,1);
        }
        .pill.is-active .pill__icon {
          color: var(--accent-primary);
          border-color: rgba(225,29,46,0.40);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 1px 2px rgba(0,0,0,0.30),
            0 0 10px rgba(225,29,46,0.30);
        }
        .pill:hover .pill__icon {
          color: var(--text-secondary);
          border-color: rgba(255,255,255,0.10);
        }

        /* ─── Embossed MultiSelect button — overrides MultiSelect's inline
             styles via :global + !important.  Deeper cushion shadow than v1
             so it really reads as a pressed-in pill. ─────────────────── */
        .pill :global(button) {
          flex: 1;
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
          height: 38px !important;
          padding: 0 12px !important;
          background: linear-gradient(
            180deg,
            rgba(255,255,255,0.05) 0%,
            rgba(255,255,255,0.01) 60%,
            rgba(0,0,0,0.10) 100%) !important;
          border: 1px solid rgba(255,255,255,0.07) !important;
          border-radius: 11px !important;
          /* Steady-state shadow is a SINGLE light layer so scroll-frame
             paints stay cheap.  Hover/active states upgrade to multi-layer
             cushions because they only animate on intent — no scroll cost. */
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 1px 2px rgba(0,0,0,0.30) !important;
          transition:
            transform 220ms cubic-bezier(0.16,1,0.3,1),
            border-color 220ms cubic-bezier(0.4,0,0.2,1),
            box-shadow 220ms cubic-bezier(0.4,0,0.2,1) !important;
          contain: layout paint;
          will-change: transform;
        }
        .pill :global(button:hover) {
          transform: translateY(-1px) !important;
          border-color: rgba(225,29,46,0.36) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.10),
            inset 0 -1px 0 rgba(0,0,0,0.16),
            0 6px 18px rgba(0,0,0,0.46),
            0 0 0 1px rgba(225,29,46,0.14),
            0 0 24px rgba(225,29,46,0.08) !important;
        }
        .pill.is-active :global(button) {
          background: linear-gradient(
            180deg,
            rgba(225,29,46,0.14) 0%,
            rgba(225,29,46,0.04) 70%,
            rgba(0,0,0,0.10) 100%) !important;
          border-color: rgba(225,29,46,0.32) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 1px 2px rgba(0,0,0,0.30),
            0 0 0 1px rgba(225,29,46,0.14) !important;
        }
        .pill.is-active :global(button:hover) {
          border-color: rgba(225,29,46,0.50) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.10),
            inset 0 -1px 0 rgba(0,0,0,0.16),
            0 6px 18px rgba(225,29,46,0.26),
            0 0 0 1px rgba(225,29,46,0.22),
            0 0 28px rgba(225,29,46,0.18) !important;
        }

        /* Light-mode parity */
        :global(html.theme-light) .pill :global(button) {
          background: linear-gradient(
            180deg,
            rgba(255,255,255,1) 0%,
            rgba(248,250,252,0.86) 100%) !important;
          border: 1px solid rgba(15,23,42,0.10) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.92),
            0 1px 2px rgba(15,23,42,0.06),
            0 2px 6px rgba(15,23,42,0.04) !important;
        }
        :global(html.theme-light) .pill :global(button:hover) {
          border-color: rgba(225,29,46,0.32) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,1),
            0 6px 18px rgba(15,23,42,0.12),
            0 0 0 1px rgba(225,29,46,0.12) !important;
        }
        :global(html.theme-light) .pill.is-active :global(button) {
          background: linear-gradient(
            180deg,
            rgba(255,255,255,1) 0%,
            rgba(254,242,243,0.96) 100%) !important;
          border-color: rgba(225,29,46,0.40) !important;
        }
        :global(html.theme-light) .pill__icon {
          background: linear-gradient(180deg, rgba(255,255,255,1), rgba(248,250,252,0.92));
          border: 1px solid rgba(15,23,42,0.10);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.92),
            0 1px 2px rgba(15,23,42,0.06);
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}

// ─── Luxury popover styles — applied globally via the lux-pop class threaded
// through MultiSelect's popoverClassName prop.  Kept in a sibling component
// so the rules stay loaded even between mounts of the panel. ────────────────
function LuxPopoverStyles() {
  return (
    <style jsx global>{`
      /* ─── Sidebar <nav> smoothness ─────────────────────────────────────
         The whole sidebar nav scrolls (sidebar item list + filter panel).
         Make it premium: smooth scroll, momentum-style scrollbar,
         contained so the page behind never gets bumped, and a hairline
         silver thumb in light mode / a hairline white thumb in dark mode.
         No bright-red gradient — that was reading as a giant artery
         pinned to the rail. */
      aside > nav {
        scroll-behavior: smooth;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: rgba(15,23,42,0.18) transparent;
      }
      html:not(.theme-light) aside > nav {
        scrollbar-color: rgba(255,255,255,0.14) transparent;
      }
      aside > nav::-webkit-scrollbar { width: 5px; }
      aside > nav::-webkit-scrollbar-track { background: transparent; }
      aside > nav::-webkit-scrollbar-thumb {
        background: rgba(15,23,42,0.18);
        border-radius: 999px;
        transition: background 200ms;
      }
      aside > nav::-webkit-scrollbar-thumb:hover {
        background: rgba(225,29,46,0.55);
      }
      html:not(.theme-light) aside > nav::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.14);
      }
      html:not(.theme-light) aside > nav::-webkit-scrollbar-thumb:hover {
        background: rgba(225,29,46,0.65);
      }


      .lux-pop {
        background:
          radial-gradient(
            ellipse at top right,
            rgba(225,29,46,0.10) 0%,
            transparent 55%),
          linear-gradient(
            180deg,
            rgba(18,22,36,0.96) 0%,
            rgba(11,16,32,0.94) 100%) !important;
        border: 1px solid rgba(225,29,46,0.22) !important;
        border-radius: 14px !important;
        box-shadow:
          0 24px 64px rgba(0,0,0,0.64),
          0 0 0 1px rgba(0,0,0,0.30),
          inset 0 1px 0 rgba(255,255,255,0.04),
          0 0 32px rgba(225,29,46,0.12) !important;
        padding: 10px !important;
      }
      html.theme-light .lux-pop {
        background:
          radial-gradient(
            ellipse at top right,
            rgba(225,29,46,0.06) 0%,
            transparent 55%),
          linear-gradient(
            180deg,
            rgba(255,255,255,0.98) 0%,
            rgba(250,250,253,0.96) 100%) !important;
        border: 1px solid rgba(225,29,46,0.20) !important;
        box-shadow:
          0 24px 64px rgba(15,23,42,0.18),
          0 0 0 1px rgba(15,23,42,0.04),
          inset 0 1px 0 rgba(255,255,255,1),
          0 0 32px rgba(225,29,46,0.08) !important;
      }

      /* Search input — pearl-bezel with focus ring */
      .lux-pop input[type="text"],
      .lux-pop input:not([type]) {
        background: rgba(255,255,255,0.04) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        border-radius: 9px !important;
        color: var(--text-primary) !important;
        font-family: var(--font-body) !important;
        font-size: 12px !important;
        font-weight: 500 !important;
        letter-spacing: 0.01em !important;
        box-shadow: inset 0 1px 0 rgba(0,0,0,0.20) !important;
        transition: border-color 200ms, box-shadow 200ms !important;
      }
      .lux-pop input:focus {
        outline: none !important;
        border-color: rgba(225,29,46,0.45) !important;
        box-shadow:
          inset 0 1px 0 rgba(0,0,0,0.20),
          0 0 0 3px rgba(225,29,46,0.18) !important;
      }
      html.theme-light .lux-pop input[type="text"],
      html.theme-light .lux-pop input:not([type]) {
        background: rgba(15,23,42,0.04) !important;
        border-color: rgba(15,23,42,0.10) !important;
        box-shadow: inset 0 1px 0 rgba(15,23,42,0.04) !important;
      }
      html.theme-light .lux-pop input:focus {
        border-color: rgba(225,29,46,0.50) !important;
        box-shadow:
          inset 0 1px 0 rgba(15,23,42,0.04),
          0 0 0 3px rgba(225,29,46,0.16) !important;
      }

      /* Branded checkboxes — replace MultiSelect's plain circles with
         pill-radius squares that fill with brand-red gradient when checked.
         MultiSelect renders them as inline-styled <span> elements, so we
         target them with attribute / structural selectors. */
      .lux-pop [role="option"] > span:first-child,
      .lux-pop label > span:first-child {
        border-radius: 6px !important;
        border: 1.5px solid rgba(255,255,255,0.18) !important;
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.04)) !important;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.04),
          0 1px 2px rgba(0,0,0,0.30) !important;
        transition:
          background 200ms cubic-bezier(0.4,0,0.2,1),
          border-color 200ms cubic-bezier(0.4,0,0.2,1),
          box-shadow 200ms cubic-bezier(0.4,0,0.2,1) !important;
      }
      /* Checked state — selected option has aria-selected="true" or has a
         fill colour set inline by MultiSelect. */
      .lux-pop [aria-selected="true"] > span:first-child,
      .lux-pop [role="option"][data-selected="true"] > span:first-child {
        background: linear-gradient(135deg, var(--accent-primary), #B91020) !important;
        border-color: rgba(225,29,46,0.95) !important;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.30),
          0 0 0 2px rgba(225,29,46,0.18),
          0 2px 6px rgba(225,29,46,0.45) !important;
      }
      html.theme-light .lux-pop [role="option"] > span:first-child,
      html.theme-light .lux-pop label > span:first-child {
        border-color: rgba(15,23,42,0.20) !important;
        background: rgba(255,255,255,1) !important;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,1),
          0 1px 2px rgba(15,23,42,0.06) !important;
      }

      /* Option rows — gentle hover wash + selected accent tint */
      .lux-pop [role="option"]:hover,
      .lux-pop label:hover {
        background: rgba(225,29,46,0.08) !important;
        border-radius: 8px !important;
      }
      .lux-pop [aria-selected="true"] {
        background: linear-gradient(
          90deg,
          rgba(225,29,46,0.12) 0%,
          rgba(225,29,46,0.04) 100%) !important;
        border-radius: 8px !important;
      }

      /* "All" / "Select all" toggle at the top — re-skin to a luxury chip */
      .lux-pop button[type="button"] {
        background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)) !important;
        border: 1px solid rgba(255,255,255,0.10) !important;
        border-radius: 9px !important;
        font-family: var(--font-body) !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        letter-spacing: 0.04em !important;
        text-transform: uppercase !important;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.06) !important;
      }
      .lux-pop button[type="button"]:hover {
        border-color: rgba(225,29,46,0.40) !important;
        background: linear-gradient(180deg, rgba(225,29,46,0.16), rgba(225,29,46,0.04)) !important;
        color: var(--accent-primary) !important;
      }
      html.theme-light .lux-pop button[type="button"] {
        background: rgba(255,255,255,1) !important;
        border-color: rgba(15,23,42,0.10) !important;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,1),
          0 1px 2px rgba(15,23,42,0.06) !important;
      }

      /* Custom scrollbar inside the popover list */
      .lux-pop ::-webkit-scrollbar { width: 5px; height: 5px; }
      .lux-pop ::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg, rgba(225,29,46,0.40), rgba(225,29,46,0.16));
        border-radius: 6px;
      }
      .lux-pop ::-webkit-scrollbar-track { background: transparent; }
    `}</style>
  );
}
