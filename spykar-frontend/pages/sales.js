import { useState, useEffect, useCallback, useMemo, useRef, startTransition, useDeferredValue } from 'react'; // v2
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import FilterChips from '../components/filters/FilterChips';
import ModePill from '../components/filters/ModePill';
import { FiltersProvider } from '../lib/FiltersContext';
import SalesPulse, { SalesPulseTables } from '../components/sales/SalesPulse';
import SkuPerformance from '../components/sales/SkuPerformance';
import DistributionDonuts from '../components/sales/DistributionDonuts';
import DrilldownDrawer from '../components/sales/DrilldownDrawer';
import { useFilters } from '../lib/useFilters';
import { useRouter } from 'next/router';
import { useTimeRange, PRESETS } from '../lib/v2/useTimeRange';
import TimeRangeControl from '../components/dashboard-v2/TimeRangeControl';
import { analyticsService, syncService } from '../lib/services';
import { getCached, setCached, isFresh, clearCached } from '../lib/dashboardCache';
import toast from 'react-hot-toast';
import { notifyApiError } from '../lib/notifyApiError';
import {
  TrendingUp, TrendingDown, ShoppingBag, RotateCcw,
  Package, Store, Calendar, Filter, RefreshCw, ChevronDown,
  Award, Zap, BarChart2, PieChart, Activity,
} from 'lucide-react';

// ── Date-range presets — Stripe / Linear-grade UX ────────────────────────────
// Click one chip and the date range jumps to that window. Custom-range stays
// usable for irregular periods (e.g., a marketing campaign window).
function rangeForPreset(preset) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  const start = new Date(today); start.setHours(0,0,0,0);
  switch (preset) {
    case 'today':   return { from: fmt(today), to: fmt(today) };
    case 'last_7':  { const d = new Date(start); d.setDate(d.getDate()-6); return { from: fmt(d), to: fmt(today) }; }
    case 'last_30': { const d = new Date(start); d.setDate(d.getDate()-29); return { from: fmt(d), to: fmt(today) }; }
    case 'last_90': { const d = new Date(start); d.setDate(d.getDate()-89); return { from: fmt(d), to: fmt(today) }; }
    case 'mtd':     { return { from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), to: fmt(today) }; }
    case 'qtd':     { const q = Math.floor(today.getMonth() / 3) * 3; return { from: fmt(new Date(today.getFullYear(), q, 1)), to: fmt(today) }; }
    case 'ytd':     { return { from: fmt(new Date(today.getFullYear(), 0, 1)), to: fmt(today) }; }
    case 'cy':      return { from: '2025-01-01', to: fmt(today) };  // calendar year → today
    case 'fy':      return { from: '2025-04-01', to: fmt(today) };  // Indian FY 2025-26 → today
    default:        return null;
  }
}
const DATE_PRESETS = [
  { key: 'today',   label: 'Today' },
  { key: 'last_7',  label: 'Last 7 d' },
  { key: 'last_30', label: 'Last 30 d' },
  { key: 'last_90', label: 'Last 90 d' },
  { key: 'mtd',     label: 'MTD' },
  { key: 'qtd',     label: 'QTD' },
  { key: 'ytd',     label: 'YTD' },
  { key: 'fy',      label: 'FY 2025-26' },
];

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

// Category filter options — must match backend CATEGORY_PATTERNS keys
const CATEGORY_OPTIONS = [
  { value: '',            label: 'All Categories' },
  { value: 'denim',       label: 'Denim' },
  { value: 'shirt',       label: 'Shirt' },
  { value: 't-shirt',     label: 'T-Shirt' },
  { value: 'trouser',     label: 'Trouser' },
  { value: 'innerwear',   label: 'Innerwear' },
  { value: 'sweatshirt',  label: 'Sweatshirt' },
  { value: 'jacket',      label: 'Jacket' },
  { value: 'accessories', label: 'Accessories' },
  { value: 'socks',       label: 'Socks' },
  { value: 'fragrance',   label: 'Fragrance' },
];

// ── Typography constants — refined to consume design-system tokens ─────────
// All colour values flow from styles/globals.css custom properties so the
// page automatically inherits global theme refinements. Only fall through to
// hex values when a token doesn't exist (e.g. reds/greens used inline below).
// Theme tokens — read from CSS variables so /sales follows the portal
// light/dark toggle automatically.  Hex fallbacks are the dark defaults.
const T = {
  primary:   'var(--text-primary,   #F1F5F9)',
  secondary: 'var(--text-secondary, #CBD5E1)',
  muted:     'var(--text-muted,     #64748B)',
  border:    'var(--border-subtle,  rgba(255,255,255,0.07))',
  bg:        'var(--bg-canvas,      #070C18)',
  accent:    'var(--accent-primary, #EF4444)',
};

// ── Number formatters ──────────────────────────────────────────────────────
function fmtL(n) {
  if (!n && n !== 0) return '—';
  n = Number(n);
  if (n >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return (n / 100000).toFixed(2) + 'L';
  if (n >= 1000)     return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}
function fmtCr(n) {
  if (!n && n !== 0) return '—';
  n = Number(n);
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(1) + 'L';
  return '₹' + n.toLocaleString('en-IN');
}
function fmtNum(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('en-IN');
}

// ── Chart theme (black, bold) ─────────────────────────────────────────────
const chartBase = {
  fontFamily: 'Inter, system-ui, sans-serif',
  toolbar: { show: false },
  zoom: { enabled: false },
  animations: { enabled: true, speed: 600 },
};

// ── Header field — ONE clean capsule: inline eyebrow label + seamless select ─
// Replaces the old "pill-inside-a-pill" header controls (a rounded 999 capsule
// wrapping a separately-bordered <select>) that read as cluttered. Here the
// label and the borderless select share a single hairline border, so the whole
// header bar speaks one visual language.
const SALE_MODE_OPTIONS = [
  { value: 'sale',   label: 'Gross Sale' },
  { value: 'return', label: 'Returns'    },
  { value: 'net',    label: 'Net Sales'  },
];
const VALUATION_OPTIONS = [
  { value: 'gross',    label: 'Gross (with GST)'  },
  { value: 'ex_gst',   label: 'Ex-GST (revenue)'  },
  { value: 'gst',      label: 'GST collected'     },
  { value: 'mrp',      label: 'At MRP'            },
  { value: 'discount', label: 'Discount given'    },
];

function HeaderField({ label, value, onChange, options, minWidth = 110, title }) {
  return (
    <label
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 9, height: 34,
        padding: '0 6px 0 12px', borderRadius: 10,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        cursor: 'pointer',
        transition: 'border-color 180ms ease, background 180ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
    >
      <span style={{
        fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em',
        textTransform: 'uppercase', color: 'var(--text-muted)',
        fontFamily: 'var(--font-display)', whiteSpace: 'nowrap',
      }}>{label}</span>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          style={{
            height: 28, padding: '0 24px 0 6px',
            background: 'transparent', border: 'none',
            fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700,
            color: 'var(--text-primary)', cursor: 'pointer',
            appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
            outline: 'none', minWidth,
          }}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronIcon />
      </div>
    </label>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, sub2, accent = 'var(--text-primary)', loading }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: `1px solid ${T.border}`,
      borderRadius: 16,
      padding: '22px 24px',
      display: 'flex', flexDirection: 'column', gap: 8,
      position: 'relative', overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
    }}>
      {/* Accent bar top */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent, borderRadius: '16px 16px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: accent + '22',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={14} color={accent} strokeWidth={2.5} />
        </div>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: T.secondary, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          {label}
        </span>
      </div>
      {loading
        ? <div style={{ height: 38, background: 'var(--bg-elevated)', borderRadius: 8, animation: 'pulse 1.5s infinite' }} />
        : <div style={{ fontSize: 32, fontWeight: 900, color: T.primary, letterSpacing: '-0.03em', lineHeight: 1 }}>
            {value}
          </div>
      }
      {sub && <div style={{ fontSize: 13, fontWeight: 600, color: T.secondary }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 12.5, fontWeight: 600, color: T.secondary, marginTop: -4 }}>{sub2}</div>}
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────
function SectionTitle({ icon: Icon, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
      <span style={{
        width: 26, height: 26, borderRadius: 8,
        background: 'var(--bg-elevated)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={13} color={T.primary} strokeWidth={2.4} />
      </span>
      <span style={{
        fontFamily: 'var(--font-display)',
        fontSize: 13, fontWeight: 800, color: T.primary,
        letterSpacing: '-0.005em',
      }}>
        {label}
      </span>
    </div>
  );
}

// ── Shared mini filter bar style — refined hairline + tabular figures ────
const filterInput = { border: '1px solid var(--border-default)', borderRadius: 9, padding: '7px 12px 7px 32px', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', outline: 'none', background: 'var(--bg-elevated)', height: 32, fontFamily: 'var(--font-body)', transition: 'border-color 200ms ease' };
const filterSelect = { border: '1px solid var(--border-default)', borderRadius: 9, padding: '7px 30px 7px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', outline: 'none', background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer', height: 32, fontFamily: 'var(--font-body)', transition: 'border-color 200ms ease' };
const SearchIcon = () => <svg style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', opacity: 0.40 }} width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.2}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const ChevronIcon = () => <svg style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.45 }} width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.4}><polyline points="6 9 12 15 18 9"/></svg>;

// ── Shared page-size dropdown ─────────────────────────────────────────────
const PAGE_SIZES_COLOR = [15, 30, 50, 100, 200, 'All'];
const PAGE_SIZES_SIZE  = [15, 30, 50, 'All'];

function ShowSelect({ sizes, value, onChange }) {
  return (
    <div style={{ position: 'relative' }}>
      <select value={value} onChange={e => onChange(e.target.value === 'All' ? 'All' : Number(e.target.value))}
        style={{ ...filterSelect, minWidth: 90, paddingLeft: 8 }}>
        {sizes.map(s => <option key={s} value={s}>Show {s}</option>)}
      </select>
      <ChevronIcon />
    </div>
  );
}

// ── Colour Breakdown Section ──────────────────────────────────────────────
function ColourBreakdownSection({ data, loading, lensMode = 'net', valuation = 'gross' }) {
  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState('_units');
  const [pageSize, setPageSize] = useState(50);

  // Rows arrive pre-enriched with _saleVal / _returnVal / _val (lens-active)
  // / _saleUnits / _returnUnits / _units (lens-active). Sort keys reference
  // the lens-active fields so flipping Show: Sale/Return/Net reranks.
  const allRows = useMemo(() => {
    let r = data?.by_color || [];
    if (search) r = r.filter(x => x.color_name?.toLowerCase().includes(search.toLowerCase()));
    return [...r].sort((a, b) => Number(b?.[sort] || 0) - Number(a?.[sort] || 0));
  }, [data?.by_color, search, sort]);

  const rows = useMemo(() =>
    pageSize === 'All' ? allRows : allRows.slice(0, pageSize),
  [allRows, pageSize]);

  const total = data?.by_color?.length || 0;
  const lensLabel = lensMode === 'sale' ? 'Sales' : lensMode === 'return' ? 'Returns' : 'Net';
  const lensColor = lensMode === 'sale' ? '#2563EB' : lensMode === 'return' ? '#F43F5E' : '#059669';
  const valuationLabel = valuation === 'gross' ? 'Gross' : valuation === 'ex_gst' ? 'Ex-GST' : valuation === 'gst' ? 'GST' : valuation === 'mrp' ? 'MRP' : valuation === 'discount' ? 'Discount' : valuation;

  return (
      <div className="sx-card sales-breakdown-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div className="sales-breakdown-card__header" style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <PieChart size={13} color={T.primary} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 800, color: T.primary, letterSpacing: '0.10em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Colour Breakdown</span>
          {/* Lens chip — tells the user which Sale/Return/Net + Valuation
              the numbers are showing right now. Color matches the page Show
              pill (blue=Sale, rose=Return, green=Net). */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 8px', background: `${lensColor}14`,
            border: `1px solid ${lensColor}33`, color: lensColor,
            borderRadius: 999, fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: lensColor }} />
            {lensLabel} · {valuationLabel}
          </span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#EF4444', borderRadius: 100, padding: '2px 7px', letterSpacing: '0.04em' }}>
              {search ? `${allRows.length} / ${total}` : total}
            </span>
          )}
        </div>
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPageSize(50); }} placeholder="Search colour…" style={{ ...filterInput, width: 140 }} />
          <SearchIcon />
          {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontWeight: 900, fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>}
        </div>
        {/* Sort — sort keys reference lens-active fields so reranking flips
            with Show: Sale/Return/Net automatically. */}
        <div style={{ position: 'relative' }}>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...filterSelect, minWidth: 130 }}>
            <option value="_units">Sort: {lensLabel} Units</option>
            <option value="_val">Sort: {lensLabel} Value</option>
            <option value="return_qty">Sort: Returns</option>
            <option value="avg_price">Sort: Avg Price</option>
          </select>
          <ChevronIcon />
        </div>
        {/* Show dropdown */}
        <ShowSelect sizes={PAGE_SIZES_COLOR} value={pageSize} onChange={setPageSize} />
      </div>

      {/* Table */}
      <div className="sales-breakdown-card__table" style={{ overflowY: 'auto', maxHeight: 480 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>#</th>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>Colour</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{lensLabel} Units</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{lensLabel} {valuationLabel}</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>Returns</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>Avg Price</th>
            </tr>
          </thead>
          <tbody>
            {/* Skeleton ONLY on cold load (no rows yet). During refetch on
                a filter/mode toggle we keep the previous rows visible so the
                screen never flashes empty. */}
            {loading && rows.length === 0
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{ padding: '9px 14px' }}><div className="sx-shimmer" style={{ height: 13, borderRadius: 4 }} /></td></tr>
                ))
              : rows.map((r, i) => {
                  const units    = Number(r._units    ?? r.units_sold  ?? 0);
                  const value    = Number(r._val      ?? r.sales_value ?? 0);
                  const retQty   = Number(r.return_qty   || 0);
                  const retValue = Number(r._returnVal   || 0);
                  const retPct   = Number(r._saleUnits || r.units_sold) > 0
                    ? (retQty / Number(r._saleUnits || r.units_sold)) * 100 : 0;
                  return (
                    <tr key={i}
                      style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--row-stripe)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--row-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--row-stripe)'}
                    >
                      <td style={{ padding: '9px 14px', fontSize: 11, fontWeight: 700, color: T.muted, width: 36 }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 800, color: T.primary }}>{r.color_name}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(units)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: lensColor }}>{fmtCr(value)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: retPct >= 5 ? '#DC2626' : T.muted, whiteSpace: 'nowrap' }}>
                        {fmtNum(retQty)}
                        {retValue > 0 && (
                          <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, marginTop: 1 }}>{fmtCr(retValue)}</div>
                        )}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>₹{fmtNum(r.avg_price)}</td>
                    </tr>
                  );
                })
            }
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No results</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: showing X of Y */}
      {!loading && allRows.length > 0 && (
        <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-card-hover)' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{rows.length}</strong> of <strong style={{ color: T.primary }}>{allRows.length}</strong> colours
          </span>
          {pageSize !== 'All' && allRows.length > rows.length && (
            <button onClick={() => setPageSize('All')} style={{ border: '1px solid rgba(239,68,68,0.40)', borderRadius: 999, padding: '5px 14px', fontSize: 11, fontWeight: 800, color: '#EF4444', background: 'transparent', cursor: 'pointer', letterSpacing: '0.03em', transition: 'background 200ms ease' }} onMouseEnter={e => e.currentTarget.style.background='rgba(239,68,68,0.08)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              Show All
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Size Breakdown Section ────────────────────────────────────────────────
function SizeBreakdownSection({ data, loading, lensMode = 'net', valuation = 'gross' }) {
  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState('_units');
  const [pageSize, setPageSize] = useState(30);

  // Sort references lens-active fields (_units / _val) so flipping
  // Sale/Return/Net automatically reranks. Search filters by size string
  // (case-insensitive substring) so picking "32" / "L" / "XL" works.
  const allRows = useMemo(() => {
    let r = data?.by_size || [];
    if (search) r = r.filter(x => String(x.size || '').toLowerCase().includes(search.toLowerCase()));
    if (sort === 'size_asc')  return [...r].sort((a, b) => { const na = parseInt(a.size) || 9999, nb = parseInt(b.size) || 9999; return na - nb || (a.size||'').localeCompare(b.size||''); });
    if (sort === 'size_desc') return [...r].sort((a, b) => { const na = parseInt(a.size) || 9999, nb = parseInt(b.size) || 9999; return nb - na || (b.size||'').localeCompare(a.size||''); });
    return [...r].sort((a, b) => Number(b?.[sort] || 0) - Number(a?.[sort] || 0));
  }, [data?.by_size, search, sort]);

  const rows    = useMemo(() => pageSize === 'All' ? allRows : allRows.slice(0, pageSize), [allRows, pageSize]);
  // Distribution-bar reference = sum of the lens-active units across all
  // sizes. So in Return view, bar widths reflect each size's share of total
  // returned units; in Net view, share of net (sale - return) units.
  const totalUnits = useMemo(() => {
    const summed = (data?.by_size || []).reduce((a, r) => a + Math.max(0, Number(r._units || 0)), 0);
    return Math.max(1, summed);
  }, [data?.by_size]);
  const total    = data?.by_size?.length || 0;
  const lensLabel = lensMode === 'sale' ? 'Sales' : lensMode === 'return' ? 'Returns' : 'Net';
  const lensColor = lensMode === 'sale' ? '#2563EB' : lensMode === 'return' ? '#F43F5E' : '#059669';
  const valuationLabel = valuation === 'gross' ? 'Gross' : valuation === 'ex_gst' ? 'Ex-GST' : valuation === 'gst' ? 'GST' : valuation === 'mrp' ? 'MRP' : valuation === 'discount' ? 'Discount' : valuation;

  return (
      <div className="sx-card sales-breakdown-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div className="sales-breakdown-card__header" style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <BarChart2 size={13} color={T.primary} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 800, color: T.primary, letterSpacing: '0.10em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Size Breakdown</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 8px', background: `${lensColor}14`,
            border: `1px solid ${lensColor}33`, color: lensColor,
            borderRadius: 999, fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: lensColor }} />
            {lensLabel} · {valuationLabel}
          </span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#EF4444', borderRadius: 100, padding: '2px 7px', letterSpacing: '0.04em' }}>
              {search ? `${allRows.length} / ${total}` : total}
            </span>
          )}
        </div>
        {/* Search — by size value (e.g. "32", "L", "XL") */}
        <div style={{ position: 'relative' }}>
          <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPageSize(30); }}
            placeholder="Search size…"
            style={{ ...filterInput, width: 130 }} />
          <SearchIcon />
          {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontWeight: 900, fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>}
        </div>
        {/* Sort — lens-aware sort keys flip with Show pill. */}
        <div style={{ position: 'relative' }}>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...filterSelect, minWidth: 140 }}>
            <option value="_units">Sort: {lensLabel} Units</option>
            <option value="_val">Sort: {lensLabel} Value</option>
            <option value="return_qty">Sort: Returns</option>
            <option value="avg_price">Sort: Avg Price</option>
            <option value="size_asc">Sort: Size ↑</option>
            <option value="size_desc">Sort: Size ↓</option>
          </select>
          <ChevronIcon />
        </div>
        {/* Show dropdown */}
        <ShowSelect sizes={PAGE_SIZES_SIZE} value={pageSize} onChange={setPageSize} />
      </div>

      {/* Table */}
      <div className="sales-breakdown-card__table" style={{ overflowY: 'auto', maxHeight: 480 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>#</th>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>Size</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{lensLabel} Units</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{lensLabel} {valuationLabel}</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>Returns</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>Avg Price</th>
            </tr>
          </thead>
          <tbody>
            {/* Skeleton ONLY on cold load. Refetch keeps prior rows visible. */}
            {loading && rows.length === 0
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{ padding: '9px 14px' }}><div className="sx-shimmer" style={{ height: 13, borderRadius: 4 }} /></td></tr>
                ))
              : rows.map((r, i) => {
                  const units    = Math.max(0, Number(r._units    ?? r.units_sold  ?? 0));
                  const value    = Number(r._val      ?? r.sales_value ?? 0);
                  const retQty   = Number(r.return_qty || 0);
                  const retValue = Number(r._returnVal || 0);
                  // Bar = lens-active share of total. So Return view shows
                  // each size's share of total returns, etc.
                  const rawPct = (units / totalUnits) * 100;
                  const pct    = Math.min(100, Math.round(rawPct * 10) / 10);
                  return (
                    <tr key={i}
                      style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--row-stripe)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--row-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--row-stripe)'}
                    >
                      <td style={{ padding: '9px 14px', fontSize: 11, fontWeight: 700, color: T.muted, width: 36 }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px', fontSize: 15, fontWeight: 900, color: T.primary, width: 70, letterSpacing: '-0.01em' }}>{r.size}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(units)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: lensColor }}>{fmtCr(value)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>
                        {fmtNum(retQty)}
                        {retValue > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, marginTop: 1 }}>{fmtCr(retValue)}</div>}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>₹{fmtNum(r.avg_price)}</td>
                    </tr>
                  );
                })
            }
          </tbody>
        </table>
      </div>

      {/* Footer */}
      {!loading && allRows.length > 0 && (
        <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-card-hover)' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{rows.length}</strong> of <strong style={{ color: T.primary }}>{allRows.length}</strong> sizes
          </span>
          {pageSize !== 'All' && allRows.length > rows.length && (
            <button onClick={() => setPageSize('All')} style={{ border: '1px solid rgba(239,68,68,0.40)', borderRadius: 999, padding: '5px 14px', fontSize: 11, fontWeight: 800, color: '#EF4444', background: 'transparent', cursor: 'pointer', letterSpacing: '0.03em', transition: 'background 200ms ease' }} onMouseEnter={e => e.currentTarget.style.background='rgba(239,68,68,0.08)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              Show All
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── All Stores Full Table component ──────────────────────────────────────
const PAGE_SIZE_STORES = 25;

function AllStoresTable({ data, loading, lensMode = 'net', valuation = 'gross', onStoreClick }) {
  const [search,  setSearch]  = useState('');
  const [city,    setCity]    = useState('');
  const [state,   setState]   = useState('');
  const [channel, setChannel] = useState('');
  const [sortBy,  setSortBy]  = useState('_val');
  const [page,    setPage]    = useState(1);

  const allStores = data?.all_stores || [];

  const states   = useMemo(() => [...new Set(allStores.map(r => r.state).filter(Boolean))].sort(),   [allStores]);
  const channels = useMemo(() => [...new Set(allStores.map(r => r.channel).filter(Boolean))].sort(), [allStores]);
  const cities   = useMemo(() => {
    const base = state ? allStores.filter(r => r.state === state) : allStores;
    return [...new Set(base.map(r => r.city).filter(Boolean))].sort();
  }, [allStores, state]);

  // Sort key references lens-active fields (_val / _units) so flipping
  // Show: Sale/Return/Net automatically reranks the whole store list.
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let r = allStores;
    if (q)       r = r.filter(x => x.location_name?.toLowerCase().includes(q) || x.external_id?.toLowerCase().includes(q) || x.location_code?.toLowerCase().includes(q) || x.city?.toLowerCase().includes(q) || x.state?.toLowerCase().includes(q));
    if (state)   r = r.filter(x => x.state   === state);
    if (city)    r = r.filter(x => x.city    === city);
    if (channel) r = r.filter(x => x.channel === channel);
    return [...r].sort((a, b) => Number(b?.[sortBy] || 0) - Number(a?.[sortBy] || 0));
  }, [allStores, search, state, city, channel, sortBy]);

  // Reset to page 1 whenever filters change
  const resetPage = (fn) => (...args) => { fn(...args); setPage(1); };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE_STORES));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE_STORES, safePage * PAGE_SIZE_STORES);
  // Bar reference = sum of LENS-ACTIVE values across all stores so each
  // bar = share of network total in the active lens (e.g. Return view → bar
  // is "X% of total returned revenue"). Falls back to summary's sales_value.
  const totalRevenue = useMemo(() => {
    const summed = (allStores || []).reduce((a, r) => a + Math.max(0, Number(r._val || 0)), 0);
    return Math.max(1, summed);
  }, [allStores]);
  const hasFilter  = search || state || city || channel;
  const lensLabel = lensMode === 'sale' ? 'Sales' : lensMode === 'return' ? 'Returns' : 'Net';
  const lensColor = lensMode === 'sale' ? '#2563EB' : lensMode === 'return' ? '#F43F5E' : '#059669';
  const valuationLabel = valuation === 'gross' ? 'Gross' : valuation === 'ex_gst' ? 'Ex-GST' : valuation === 'gst' ? 'GST' : valuation === 'mrp' ? 'MRP' : valuation === 'discount' ? 'Discount' : valuation;

  const clearAll = () => { setSearch(''); setState(''); setCity(''); setChannel(''); setPage(1); };

  return (
    <div className="sx-card" style={{ overflow: 'hidden', marginBottom: 24 }}>

      {/* ── Filter bar ── */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Store size={13} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>All Stores</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 8px', background: `${lensColor}14`,
            border: `1px solid ${lensColor}33`, color: lensColor,
            borderRadius: 999, fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: lensColor }} />
            {lensLabel} · {valuationLabel}
          </span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#EF4444', borderRadius: 100, padding: '2px 7px' }}>
              {filtered.length}{filtered.length !== allStores.length ? ` / ${allStores.length}` : ''}
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search store / city / state…" style={{ ...filterInput, width: 200 }} />
          <SearchIcon />
          {search && <button onClick={() => { setSearch(''); setPage(1); }} style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontWeight: 900, fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>}
        </div>

        {/* State */}
        <div style={{ position: 'relative' }}>
          <select value={state} onChange={e => { setState(e.target.value); setCity(''); setPage(1); }} style={{ ...filterSelect, minWidth: 140 }}>
            <option value="">All States</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronIcon />
        </div>

        {/* City — filtered by selected state */}
        <div style={{ position: 'relative' }}>
          <select value={city} onChange={e => { setCity(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 130 }}>
            <option value="">All Cities</option>
            {cities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <ChevronIcon />
        </div>

        {/* Channel */}
        <div style={{ position: 'relative' }}>
          <select value={channel} onChange={e => { setChannel(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 130 }}>
            <option value="">All Channels</option>
            {channels.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <ChevronIcon />
        </div>

        {/* Sort */}
        <div style={{ position: 'relative' }}>
          <select value={sortBy} onChange={e => { setSortBy(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 150 }}>
            <option value="_val">Sort: {lensLabel} Value</option>
            <option value="_units">Sort: {lensLabel} Units</option>
            <option value="return_qty">Sort: Returns Qty</option>
            <option value="_returnVal">Sort: Returns Value</option>
            <option value="transactions">Sort: Transactions</option>
          </select>
          <ChevronIcon />
        </div>

        {hasFilter && (
          <button onClick={clearAll} className="sx-chip" style={{ height: 32 }}>
            Clear
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              {['#', 'Store Name', 'Channel', 'State', 'City', 'Share', `${lensLabel} ${valuationLabel}`, `${lensLabel} Units`, 'Returns ₹', 'Returns Qty', 'Txns'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: ['#'].includes(h) || /^(Returns|Txns|.*\sUnits|.*Gross|.*Ex-GST|.*GST|.*MRP|.*Discount|.*Value|.*Net|.*Sales|Share)/.test(h) ? 'right' : 'left', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Skeleton ONLY on cold load. Refetch keeps prior rows visible. */}
            {loading && pageRows.length === 0
              ? Array.from({ length: PAGE_SIZE_STORES }).map((_, i) => (
                  <tr key={i}><td colSpan={11} style={{ padding: '10px 14px' }}><div className="sx-shimmer" style={{ height: 13, borderRadius: 4 }} /></td></tr>
                ))
              : pageRows.map((r, i) => {
                  const globalIdx = (safePage - 1) * PAGE_SIZE_STORES + i;
                  const value    = Number(r._val      ?? r.sales_value ?? 0);
                  const units    = Math.max(0, Number(r._units ?? r.units_sold ?? 0));
                  const retQty   = Number(r.return_qty || 0);
                  const retValue = Number(r._returnVal || 0);
                  // Share = lens-active value / lens-active network total.
                  const rawPct = (Math.abs(value) / totalRevenue) * 100;
                  const revPct = Math.min(100, Math.round(rawPct * 10) / 10);
                  const isTop3 = globalIdx < 3 && !hasFilter;
                  return (
                    <tr key={r.location_id || globalIdx}
                      onClick={() => onStoreClick?.(r.location_id)}
                      style={{
                        borderBottom: `1px solid ${T.border}`,
                        // Dark-theme backgrounds: top-3 highlighted rows get a
                        // subtle brand glow; alternating rows use transparency
                        // tiers over the dark canvas so text stays legible.
                        background: isTop3
                          ? 'rgba(239,68,68,0.06)'
                          : globalIdx % 2 === 0 ? 'transparent' : 'var(--row-stripe)',
                        cursor: onStoreClick ? 'pointer' : 'default',
                      }}
                      title={onStoreClick ? `View store breakdown — ${r.location_name}` : undefined}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--row-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = isTop3
                        ? 'rgba(239,68,68,0.06)'
                        : globalIdx % 2 === 0 ? 'transparent' : 'var(--row-stripe)'}
                    >
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 900, color: T.muted, width: 36 }}>
                        {isTop3 ? ['🥇','🥈','🥉'][globalIdx] : globalIdx + 1}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 800, color: T.primary, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.location_name}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <span style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 800, color: T.primary }}>{r.channel || '—'}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.state || '—'}</td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.city || '—'}</td>
                      <td style={{ padding: '10px 20px 10px 14px', width: 110 }}
                        title={`${revPct}% of total ${lensLabel.toLowerCase()} ${valuationLabel.toLowerCase()}`}>
                        <div style={{ background: 'var(--border-default)', borderRadius: 4, height: 5 }}>
                          <div style={{ width: `${Math.max(0.5, revPct)}%`, height: '100%', background: `linear-gradient(90deg,${lensColor},${lensColor}cc)`, borderRadius: 4 }} />
                        </div>
                        <div style={{ fontSize: 9.5, fontWeight: 700, color: T.muted, textAlign: 'right', marginTop: 3 }}>
                          {revPct < 0.1 ? '<0.1%' : `${revPct}%`}
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 900, color: lensColor, whiteSpace: 'nowrap' }}>{fmtCr(value)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(units)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#F43F5E', whiteSpace: 'nowrap' }}>{retValue > 0 ? fmtCr(retValue) : '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#F43F5E' }}>{fmtNum(retQty)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>{fmtNum(r.transactions)}</td>
                    </tr>
                  );
                })
            }
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={11} style={{ padding: '40px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: T.muted }}>No stores match your filters</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination footer ── */}
      {!loading && filtered.length > 0 && (
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-card-hover)', flexWrap: 'wrap', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{(safePage - 1) * PAGE_SIZE_STORES + 1}–{Math.min(safePage * PAGE_SIZE_STORES, filtered.length)}</strong> of <strong style={{ color: T.primary }}>{filtered.length}</strong> stores
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setPage(1)} disabled={safePage === 1}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: 'transparent', cursor: safePage === 1 ? 'default' : 'pointer' }}>«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 11px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: 'transparent', cursor: safePage === 1 ? 'default' : 'pointer' }}>‹ Prev</button>
            {/* Page number pills — show up to 5 around current */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
              .reduce((acc, p, idx, arr) => {
                if (idx > 0 && p - arr[idx - 1] > 1) acc.push('…');
                acc.push(p);
                return acc;
              }, [])
              .map((p, idx) => p === '…'
                ? <span key={`ellipsis-${idx}`} style={{ fontSize: 12, color: T.muted, padding: '0 2px' }}>…</span>
                : <button key={p} onClick={() => setPage(p)}
                    style={{ border: `1.5px solid ${p === safePage ? T.primary : T.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: p === safePage ? 900 : 700, color: p === safePage ? '#EF4444' : T.primary, background: p === safePage ? 'rgba(239,68,68,0.20)' : 'transparent', cursor: 'pointer', minWidth: 30 }}>{p}</button>
              )
            }
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 11px', fontSize: 11, fontWeight: 800, color: safePage === totalPages ? T.border : T.primary, background: 'transparent', cursor: safePage === totalPages ? 'default' : 'pointer' }}>Next ›</button>
            <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: 800, color: safePage === totalPages ? T.border : T.primary, background: 'transparent', cursor: safePage === totalPages ? 'default' : 'pointer' }}>»</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SalesAnalyticsPage() {
  // ── v2 universal filter bar — same 15 dimensions as the Network page ──
  // (gender, sub_product, product, category, style, shade, color, size,
  // season, state, city, party, store) plus the Active/Inactive/All mode pill
  // and a Sale/Return/Net lens specific to this page.
  const v2FilterApi =
    useFilters({
      defaults: { mode: 'active', sale_mode: 'net', valuation: 'gross' },
      persist:  ['mode', 'sale_mode', 'valuation'],
    });
  const { filters: v2Filters, setFilter: setV2, clearAll: clearV2, activeCount: v2Active } = v2FilterApi;

  // Time range — dashboard-grade segmented pill (Today/WTD/MTD/QTD/YTD/Custom).
  // `useTimeRange` is the SAME hook the Overview page uses, so the two pages
  // share semantics: "today" anchors to the last sync date, MTD/QTD/YTD compute
  // off that anchor, and the custom date inputs activate only when the user
  // picks Custom. Single source of truth for every "what window am I looking
  // at?" question across the app.
  const { preset, setPreset, setCustom, fromISO, toISO } = useTimeRange('mtd');
  const dateFrom = fromISO;
  const dateTo   = toISO;
  // Wrappers that flip the preset to 'custom' the moment the user types into
  // a date input — matches the Overview behaviour exactly.
  const setDateFrom = useCallback((v) => setCustom(v, toISO), [setCustom, toISO]);
  const setDateTo   = useCallback((v) => setCustom(fromISO, v), [setCustom, fromISO]);

  // ── Carry the date range over from the Dashboard ──────────────────────────
  // When the user clicks a state on the dashboard's India map, we route here
  // with ?state=...&preset=...&date_from=...&date_to=... so the Sales page
  // opens on the SAME window the dashboard was showing (not the default MTD).
  // Both pages share useTimeRange, so applying the same preset reproduces the
  // identical range; for a custom dashboard range we apply the explicit dates.
  // Runs once after the router is ready (router.query is empty on first SSR pass).
  const salesRouter = useRouter();
  const dateInitRef = useRef(false);
  useEffect(() => {
    if (dateInitRef.current || !salesRouter.isReady) return;
    dateInitRef.current = true;
    const { preset: qPreset, date_from: qFrom, date_to: qTo } = salesRouter.query;
    if (qPreset && qPreset !== 'custom' && PRESETS.includes(String(qPreset))) {
      setPreset(String(qPreset));
    } else if (qFrom && qTo) {
      setCustom(String(qFrom), String(qTo));
    }
  }, [salesRouter.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Legacy local filters retained for back-compat with the in-page filter
  // toolbar (color/size/store dropdowns). v2 multi-select takes precedence
  // when both are set; v1 acts as a quick single-select shortcut.
  const [colorName, setColorName]   = useState('');
  const [size, setSize]             = useState('');
  const [locationId, setLocationId] = useState('');

  // ── Drilldown drawer — clicked store/SKU opens a side panel with the
  // entity's full breakdown (top SKUs / colours / sizes for stores; top
  // stores + return-heavy stores for SKUs). Cached per (pivot, id, filters)
  // so reopening is instant (<80μs Map hit).
  const [drillTarget, setDrillTarget] = useState(null); // { pivot, id } | null
  const openStore = useCallback((id) => id && setDrillTarget({ pivot: 'store', id }), []);
  const openSku   = useCallback((id) => id && setDrillTarget({ pivot: 'sku',   id }), []);
  const closeDrill = useCallback(() => setDrillTarget(null), []);
  const category = v2Filters.category && v2Filters.category[0] || '';

  // Build v2 query slug for the cache key (so each filter combo has its own
  // memoised slot across mounts).
  const v2Slug = useMemo(() => {
    const csv = (v) => Array.isArray(v) ? v.slice().sort().join(',') : (v || '');
    return [
      `g${csv(v2Filters.gender_name)}`, `sp${csv(v2Filters.sub_product)}`,
      `pr${csv(v2Filters.product)}`,    `c${csv(v2Filters.category)}`,
      `sty${csv(v2Filters.style)}`,     `sh${csv(v2Filters.shade)}`,
      `cl${csv(v2Filters.color)}`,      `sz${csv(v2Filters.size)}`,
      `se${csv(v2Filters.season)}`,
      `st${csv(v2Filters.state)}`,      `ct${csv(v2Filters.city)}`,
      `gn${csv(v2Filters.group_name)}`, `sc${csv(v2Filters.store_code)}`,
      // sale_mode + valuation are NOT part of the cache key — the backend
      // mega-CTE returns sale + return + net for every valuation lens in
      // ONE payload (lines 522-541 of analytics.controller.js). Toggling
      // Sale/Return/Net or Gross/Ex-GST/MRP is pure client-side enrichment
      // (see lines 949-1061 below), so we must not invalidate the cache or
      // refetch on those flips. Tab toggles become instant.
      `m${v2Filters.mode||'active'}`,
    ].join('|');
  }, [v2Filters]);

  // Cache key is filter-dependent so each unique combination remembers its own
  // response. Navigating away and back with identical filters renders instantly
  // from the module-level cache instead of remounting empty.
  // v7: bumped after the backend Category filter migrated from a hardcoded
  // 10-entry pattern map (silently dropped UNDERJEANS / KNITS / NON DENIM /
  // GROOMING / ALBERT EINSTEIN / CHARLIE CHAPLIN — 5 of 9 categories) to a
  // direct `s.category_norm` match. Old cache slots held "all-data" responses
  // for those categories — bumping the version forces a refetch under the
  // new (correctly filtered) backend.
  // v9: bumped with the backend rollup-reader off-by-one fix (the final day of
  // every window — i.e. "today" — was dropped, so the Today preset showed zero).
  // Old v8 slots cached those zero responses; bump forces a clean refetch.
  const cacheKey = `sales:v9:${dateFrom}|${dateTo}|${colorName}|${size}|${locationId}|${v2Slug}`;

  // ── State model — IDENTICAL to network's StockBreakdownSection ──────────
  //   data        — the rendered payload. Hydrated synchronously from the
  //                 module cache so re-mounts paint without a flash.
  //   loading     — COLD-load flag. True only when we have NOTHING to show.
  //   refreshing  — true on every re-fetch even when prior `data` is on
  //                 screen. Drives the opacity dim — same UX cue as network.
  //   activeKeyRef — race-guard so a late response for a stale cacheKey
  //                  cannot clobber the screen.
  //   inFlightRef  — AbortController so superseded fetches stop paying for
  //                  themselves on the server (mega-CTE is expensive).
  const [data, setData]             = useState(() => getCached(cacheKey) ?? null);
  const [loading, setLoading]       = useState(() => !getCached(cacheKey));
  const [refreshing, setRefreshing] = useState(false);
  // Mirror `data` into a ref so `fetch` can read it WITHOUT listing `data` as a
  // dependency. Listing `data` made `fetch` change identity on every data
  // update → re-ran the trigger effect → restarted the in-flight request. That
  // abort/restart cascade was the "earthquake" buffering (and prolonged loads).
  const dataRef = useRef(data);
  dataRef.current = data;
  const activeKeyRef = useRef(cacheKey);
  useEffect(() => { activeKeyRef.current = cacheKey; }, [cacheKey]);
  const inFlightRef = useRef(null);

  const fetch = useCallback(async () => {
    const issuedFor = cacheKey;
    setRefreshing(true);
    if (!dataRef.current && !getCached(issuedFor)) setLoading(true);

    if (inFlightRef.current) inFlightRef.current.abort();
    const ac = new AbortController();
    inFlightRef.current = ac;

    const csv = (v) => Array.isArray(v) ? v.join(',') : (v || undefined);
    const heavyParams = {
      date_from:   dateFrom    || undefined,
      date_to:     dateTo      || undefined,
      color_name:  colorName   || undefined,
      size:        size        || undefined,
      location_id: locationId  || undefined,
      gender:      csv(v2Filters.gender_name) || undefined,
      sub_product: csv(v2Filters.sub_product) || undefined,
      product:     csv(v2Filters.product)     || undefined,
      category:    csv(v2Filters.category)    || undefined,
      style:       csv(v2Filters.style)       || undefined,
      shade:       csv(v2Filters.shade)       || undefined,
      color:       csv(v2Filters.color)       || undefined,
      ...(size ? {} : { size: csv(v2Filters.size) || undefined }),
      season:      csv(v2Filters.season)      || undefined,
      state:       csv(v2Filters.state)       || undefined,
      city:        csv(v2Filters.city)        || undefined,
      group_name:  csv(v2Filters.group_name)  || undefined,
      store_code:  csv(v2Filters.store_code)  || undefined,
      mode:        v2Filters.mode             || 'active',
    };

    // ── Dual-fetch: slim endpoint runs 3 aggregates instead of 8, so it
    // returns ~3× faster on cold cache. We surface its data ASAP so the
    // KPI strip + daily chart + channel mix paint quickly while the heavy
    // mega-CTE keeps loading. When the heavy result lands it overrides
    // (richer payload — by_color/by_size/by_store/all_stores/by_sku/etc.).
    //
    // ── Slim is ONLY safe when no non-date filter is active. ────────────
    // The slim endpoint accepts only date_from/date_to/mode — every other
    // dimension (state, city, category, gender, color, etc.) is ignored
    // server-side. So with any filter applied, slim returns the
    // UNFILTERED date-range totals — which then briefly paint into the
    // KPI cards (the "main value" flash) before heavy lands and corrects
    // them. Suppress the slim call whenever any non-date filter is set so
    // the user never sees a number that doesn't reflect their selection.
    const hasNonDateFilter = !!(
      heavyParams.color_name  || heavyParams.size       || heavyParams.location_id ||
      heavyParams.gender      || heavyParams.sub_product|| heavyParams.product     ||
      heavyParams.category    || heavyParams.style      || heavyParams.shade       ||
      heavyParams.color       || heavyParams.season     || heavyParams.state       ||
      heavyParams.city        || heavyParams.group_name || heavyParams.store_code
    );

    let heavyDone = false;
    if (!hasNonDateFilter) {
      analyticsService.getSalesSummary({
        date_from: heavyParams.date_from,
        date_to:   heavyParams.date_to,
        mode:      heavyParams.mode,
      }, { signal: ac.signal })
        .then(slimRes => {
          if (heavyDone) return;                              // heavy already arrived — skip
          if (activeKeyRef.current !== issuedFor) return;      // superseded
          const slim = slimRes?.data?.data;
          if (!slim) return;
          // Field-name reconciliation. The slim SQL exposes the gross-lens net
          // total as `net_value`; SalesPulse reads `net_gross_value` (heavy's
          // field name). Map the aliases so KPI cards render correctly from
          // slim alone.
          const ss = slim.summary || {};
          const summary = {
            ...ss,
            net_gross_value:    ss.net_gross_value    ?? ss.net_value,
            sales_gross_value:  ss.sales_gross_value  ?? ss.sales_value,
            return_gross_value: ss.return_gross_value ?? ss.return_value,
          };
          // ONLY merge summary. The slim endpoint's `daily` rows have a
          // different shape than heavy's (missing mrp_value / gst_collected /
          // ex_gst_value / transactions columns). If we merged it, the
          // daily-trend chart would remount with rows lacking those fields →
          // ApexCharts throws "parser Error" on the inconsistent datetime
          // series. Charts and channel mix wait for heavy; KPIs render
          // immediately from slim. Best of both worlds.
          setData(prev => ({
            ...(prev || {}),
            summary,
          }));
          setLoading(false);
        })
        .catch(() => { /* slim is best-effort — heavy is the source of truth */ });
    }

    try {
      const res = await analyticsService.getSalesAnalytics(heavyParams, { signal: ac.signal });
      heavyDone = true;
      if (activeKeyRef.current !== issuedFor) return;
      const v = res.data.data;
      setCached(issuedFor, v);
      setData(v);
      setLoading(false);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || err?.message === 'canceled') return;
      if (activeKeyRef.current === issuedFor) setLoading(false);
      notifyApiError(err, 'Failed to load sales analytics');
    } finally {
      if (activeKeyRef.current === issuedFor) setRefreshing(false);
    }
  }, [dateFrom, dateTo, colorName, size, locationId, v2Slug, cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter-change effect — mirrors network's pattern exactly:
  //   1. Cache HIT + fresh → paint synchronously, NO fetch, no dim.
  //   2. Cache HIT + stale → paint synchronously, background re-validate.
  //   3. Cache MISS         → keep prior data visible, debounce 80 ms, fetch.
  // The 80 ms debounce still coalesces rapid multi-select clicks (humans
  // can't fire two selects faster than ~100 ms) but is short enough that
  // a single deliberate filter change feels instantaneous. Previously
  // 250 ms — felt sluggish on every solo click.
  useEffect(() => {
    const cached = getCached(cacheKey);
    if (cached) {
      setData(cached);
      setLoading(false);
      if (isFresh(cacheKey)) return; // fresh hit → no refetch, no dim
    }
    const t = setTimeout(() => { fetch(); }, 80);
    return () => clearTimeout(t);
  }, [fetch, cacheKey]);

  // Abort any in-flight request when the page unmounts.
  useEffect(() => () => { inFlightRef.current?.abort(); }, []);

  // Defensive dim-clear — guarantees `refreshing` flips OFF the moment
  // a fresh `data` lands for the active cacheKey, regardless of any race
  // path the fetch's `finally` could miss (e.g. AbortError thrown after
  // a setState batch already committed setData). The user-visible symptom
  // we are pinning down is "data updated but the page stays faded" — this
  // makes that impossible by construction. Pairs `data` with the active
  // cacheKey via a ref so we don't accidentally clear during a still-stale
  // payload window.
  useEffect(() => {
    if (data) setRefreshing(false);
  }, [data]);

  // Mode-toggle prefetch removed (cold-load fix #A).  Eagerly fetching the
  // other two modes via requestIdleCallback after the visible call landed
  // was firing two more cold 8 s mega-CTE scans on every page entry, pinning
  // the connection pool and bloating Redis with unused entries.  Mode toggles
  // now fetch lazily on click — slight one-time wait the first time the user
  // flips Active/Inactive/All, but the page entry is dramatically faster.

  const s   = data?.summary || {};
  const ss  = data?.stock_snapshot || {};
  const opts = data?.filter_options || { colors: [], sizes: [], stores: [] };

  // ── Lens × valuation enrichment ────────────────────────────────────────
  // Every breakdown row (by_color / by_size / by_store / all_stores) gets
  // pre-computed Sale + Return + Net values for the active valuation lens.
  // Tables below pick the right one based on parent's lensMode so toggling
  // Show: Sale/Return/Net flips every ₹ + units on the page together.
  const valuation = v2Filters.valuation || 'gross';
  const lensMode  = v2Filters.sale_mode || 'net';
  // Defer the expensive enrichRows re-computation so the pill button
  // animates immediately while the data updates in a background pass.
  const deferredLensMode = useDeferredValue(lensMode);

  // Sale-side ₹ for the chosen valuation
  const saleVal = (r) => {
    switch (valuation) {
      case 'ex_gst':   return Number(r?.ex_gst_value || 0);
      case 'gst':      return Number(r?.gst_collected || 0);
      case 'mrp':      return Number(r?.mrp_value || 0);
      case 'discount': return Math.max(0, Number(r?.mrp_value || 0) - Number(r?.sales_value || 0));
      case 'gross':
      default:         return Number(r?.sales_value || 0);
    }
  };
  // Return-side ₹ for the chosen valuation. The backend ships
  // return_value, return_mrp_value, return_gst_collected, return_ex_gst_value
  // on every breakdown row; we pick the matching one.
  const returnVal = (r) => {
    switch (valuation) {
      case 'ex_gst':   return Number(r?.return_ex_gst_value || 0);
      case 'gst':      return Number(r?.return_gst_collected || 0);
      case 'mrp':      return Number(r?.return_mrp_value || 0);
      case 'discount': return Math.max(0, Number(r?.return_mrp_value || 0) - Number(r?.return_value || 0));
      case 'gross':
      default:         return Number(r?.return_value || 0);
    }
  };
  // Pick the lens-active value for the row based on Sale/Return/Net.
  const lensVal = (r, lm = deferredLensMode) => {
    const sv = saleVal(r), rv = returnVal(r);
    if (lm === 'sale')   return sv;
    if (lm === 'return') return rv;
    return sv - rv; // 'net'
  };
  const lensUnits = (r, lm = deferredLensMode) => {
    const u = Number(r?.units_sold || 0);
    const ru = Number(r?.return_qty || 0);
    if (lm === 'sale')   return u;
    if (lm === 'return') return ru;
    return u - ru; // 'net'
  };
  // Enrich every breakdown row with the four primitives the tables need:
  //   _saleVal / _returnVal — for showing the matching ₹ and Net = sale-return
  //   _val                  — the active lens ₹ (used by sort + bars)
  //   _saleUnits / _returnUnits / _units — corresponding units
  // Also OVERWRITE sales_value with the lens-active ₹ so legacy renders that
  // still read sales_value automatically pick the right number. This is what
  // makes Top Stores / Charts switch lens without touching their JSX.
  const enrichRows = (rows, lm = deferredLensMode) => (rows || []).map(r => {
    const sv = saleVal(r), rv = returnVal(r);
    const su = Number(r?.units_sold || 0);
    const ru = Number(r?.return_qty || 0);
    const lv = lm === 'sale' ? sv : lm === 'return' ? rv : sv - rv;
    const lu = lm === 'sale' ? su : lm === 'return' ? ru : su - ru;
    return {
      ...r,
      _saleVal: sv, _returnVal: rv, _val: lv, _displayValue: lv,
      _saleUnits: su, _returnUnits: ru, _units: lu,
      // Legacy sales_value field flips with lens so old code paths stay correct
      sales_value: lv,
      units_sold:  lu,
    };
  });
  // Backwards-compat shim — older code referenced pickRowVal directly.
  const pickRowVal = (r) => saleVal(r);
  void pickRowVal;
  // Filter payload reused by the drilldown drawer so the drilled view
  // narrows by the same window/filters the user is currently viewing.
  // Memoised on JSON deps so the drawer's cache key is stable across
  // unrelated re-renders.
  const drillFilters = useMemo(() => {
    const csvJ = (v) => Array.isArray(v) ? v.join(',') : (v || undefined);
    return {
      date_from:   dateFrom    || undefined,
      date_to:     dateTo      || undefined,
      gender:      csvJ(v2Filters.gender_name),
      sub_product: csvJ(v2Filters.sub_product),
      product:     csvJ(v2Filters.product),
      category:    csvJ(v2Filters.category),
      style:       csvJ(v2Filters.style),
      shade:       csvJ(v2Filters.shade),
      color:       csvJ(v2Filters.color),
      size:        size || csvJ(v2Filters.size),
      season:      csvJ(v2Filters.season),
      state:       csvJ(v2Filters.state),
      city:        csvJ(v2Filters.city),
      group_name:  csvJ(v2Filters.group_name),
      store_code:  csvJ(v2Filters.store_code),
      mode:        v2Filters.mode || 'active',
      sale_mode:   v2Filters.sale_mode || 'net',
      valuation:   v2Filters.valuation || 'gross',
    };
  }, [dateFrom, dateTo, size, v2Slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Valuation-only enrichment — daily/by_month flip only when valuation changes,
  // NOT when lensMode changes. Kept separate so chart memos don't recompute on
  // every Sale/Return/Net toggle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dataVal = useMemo(() => {
    if (!data) return data;
    return {
      daily:    (data.daily    || []).map(r => ({ ...r, sales_value: saleVal(r) })),
      by_month: (data.by_month || []).map(r => ({ ...r, sales_value: saleVal(r) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, valuation]);

  const dataLens = useMemo(() => {
    if (!data) return data;
    return {
      ...data,
      by_color:   enrichRows(data.by_color),
      by_size:    enrichRows(data.by_size),
      by_store:   enrichRows(data.by_store),
      all_stores: enrichRows(data.all_stores),
      daily:      dataVal?.daily    || [],
      by_month:   dataVal?.by_month || [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dataVal, deferredLensMode]);

  // ── Daily chart — premium 3-series with dedicated Y-axes ─────────────────
  // ApexCharts' xaxis parser throws "parser Error" if ANY datetime value is
  // NaN. That happened on every preset switch (Today/MTD/YTD/…) because the
  // payload occasionally carried a row whose `date` was null/undefined while
  // the response was mid-swap, and `new Date(undefined).getTime() → NaN`
  // poisoned the categories array. We now pre-sanitise the rows: drop any
  // entry whose timestamp doesn't parse, sort ascending, and feed the
  // already-numeric ts into both x-categories AND series points.
  const dailyChartData = useMemo(() => {
    const raw = dataLens?.daily || [];
    const rows = raw
      .map(r => {
        const ts = r?.date ? new Date(r.date).getTime() : NaN;
        return Number.isFinite(ts) ? { ...r, _ts: ts } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a._ts - b._ts);
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'area', id: 'daily' },
        xaxis: {
          type: 'datetime',
          categories: rows.map(r => r._ts),
          labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '11px' }, datetimeUTC: false },
          axisBorder: { show: false }, axisTicks: { show: false },
        },
        yaxis: [
          {
            seriesName: 'Units Sold',
            title: { text: 'Units', style: { color: T.primary, fontWeight: 800, fontSize: '11px' } },
            labels: { style: { colors: T.primary, fontWeight: 700 }, formatter: v => fmtL(v) },
          },
          {
            seriesName: 'Revenue (₹)',
            opposite: true,
            title: { text: 'Revenue', style: { color: '#059669', fontWeight: 800, fontSize: '11px' } },
            labels: { style: { colors: '#059669', fontWeight: 700 }, formatter: v => fmtCr(v) },
          },
          {
            seriesName: 'Returns',
            opposite: true,
            show: false,
          },
        ],
        colors: ['#2563EB', '#059669', '#F43F5E'],
        fill: {
          type: 'gradient',
          gradient: { shade: 'light', type: 'vertical', opacityFrom: 0.18, opacityTo: 0 },
        },
        stroke: { curve: 'smooth', width: [2.5, 2.5, 2] },
        dataLabels: { enabled: false },
        grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4, xaxis: { lines: { show: false } } },
        tooltip: {
          shared: true, intersect: false,
          x: { format: 'dd MMM yyyy' },
          style: { fontSize: '12px', fontWeight: 700 },
        },
        legend: {
          fontWeight: 700, fontSize: '12px',
          labels: { colors: T.primary },
          markers: { radius: 4 },
        },
      },
      series: [
        { name: 'Units Sold',  data: rows.map(r => ({ x: r._ts, y: Number(r.sales_qty)   || 0 })) },
        { name: 'Revenue (₹)', data: rows.map(r => ({ x: r._ts, y: Number(r.sales_value) || 0 })), yAxisIndex: 1 },
        { name: 'Returns',     data: rows.map(r => ({ x: r._ts, y: Number(r.return_qty)  || 0 })), yAxisIndex: 2 },
      ],
    };
  }, [dataLens?.daily]);

  // Stable per-shape key — ApexCharts cannot safely re-parse a datetime axis
  // when the categories array's length changes (Today=1 row → YTD=300+ rows).
  // Using a key derived from row count + first/last timestamp forces React
  // to unmount and remount the chart on a true shape change, side-stepping
  // ApexCharts' internal mutable state and the "parser Error" crash that
  // surfaced when switching MTD → YTD → Today rapidly.
  const dailyChartKey = useMemo(() => {
    const rows = dataLens?.daily || [];
    if (!rows.length) return 'daily:empty';
    return `daily:${rows.length}:${rows[0]?.date || ''}:${rows[rows.length - 1]?.date || ''}`;
  }, [dataLens?.daily]);

  // ── Monthly bar+line combo chart (bar=sales, line=returns on dual axis) ──
  const monthlyChartData = useMemo(() => {
    const rows = dataLens?.by_month || [];
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'line', stacked: false },
        xaxis: {
          categories: rows.map(r => r.month_label),
          labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '11px' }, rotate: -35 },
          axisBorder: { show: false }, axisTicks: { show: false },
        },
        yaxis: [
          {
            seriesName: 'Units Sold',
            labels: { style: { colors: T.primary, fontWeight: 700 }, formatter: v => fmtL(v) },
            title: { text: 'Units Sold', style: { color: T.primary, fontWeight: 800, fontSize: '11px' } },
          },
          {
            seriesName: 'Units Returned',
            opposite: true,
            labels: { style: { colors: '#F43F5E', fontWeight: 700 }, formatter: v => fmtL(v) },
            title: { text: 'Returns', style: { color: '#F43F5E', fontWeight: 800, fontSize: '11px' } },
          },
        ],
        colors: ['#2563EB', '#F43F5E'],
        plotOptions: { bar: { borderRadius: 4, columnWidth: '55%' } },
        stroke: { width: [0, 3], curve: 'smooth' },
        markers: { size: [0, 5], strokeWidth: 2, hover: { size: 7 } },
        dataLabels: { enabled: false },
        grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4 },
        legend: { fontWeight: 700, fontSize: '12px', labels: { colors: T.primary } },
        tooltip: { shared: true, intersect: false, style: { fontSize: '12px', fontWeight: 700 } },
      },
      series: [
        { name: 'Units Sold',     type: 'bar',  data: rows.map(r => Number(r.sales_qty)  || 0) },
        { name: 'Units Returned', type: 'line', data: rows.map(r => Number(r.return_qty) || 0) },
      ],
    };
  }, [dataLens?.by_month]);

  // Same remount-on-shape-change guard for the two monthly charts. They
  // share the same source array (`by_month`) so a single key serves both.
  const monthlyChartKey = useMemo(() => {
    const rows = dataLens?.by_month || [];
    if (!rows.length) return 'monthly:empty';
    return `monthly:${rows.length}:${rows[0]?.month_label || ''}:${rows[rows.length - 1]?.month_label || ''}`;
  }, [dataLens?.by_month]);

  // ── Colour chart ─────────────────────────────────────────────────────────
  // ── Revenue monthly area ─────────────────────────────────────────────────
  const revenueChartData = useMemo(() => {
    const rows = dataLens?.by_month || [];
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'area' },
        xaxis: {
          categories: rows.map(r => r.month_label),
          labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '11px' }, rotate: -35 },
          axisBorder: { show: false }, axisTicks: { show: false },
        },
        yaxis: { labels: { style: { colors: T.muted, fontWeight: 700 }, formatter: v => fmtCr(v) } },
        colors: ['#059669'],
        fill: {
          type: 'gradient',
          gradient: { shade: 'light', type: 'vertical', opacityFrom: 0.22, opacityTo: 0 },
        },
        stroke: { curve: 'smooth', width: 2.5 },
        dataLabels: { enabled: false },
        grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4 },
        tooltip: { style: { fontSize: '12px', fontWeight: 700 }, y: { formatter: v => fmtCr(v) } },
      },
      series: [{ name: 'Monthly Revenue', data: rows.map(r => Number(r.sales_value)) }],
    };
  }, [data?.by_month]);

  const hasFilters = colorName || size || locationId || category || preset !== 'mtd' || v2Active > 0;

  return (
    <FiltersProvider value={v2FilterApi}>
    <DashboardLayout
      title="Sales & Returns Analytics"
      subtitle="Day-basis sales intelligence — units, revenue, colour, size, store"
      headerSlot={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Time range */}
          <TimeRangeControl preset={preset} onChange={(p) => startTransition(() => setPreset(p))} />

          <div style={{ width: 1, height: 18, background: 'var(--border-subtle)' }} />

          {/* Lens + valuation — unified single-border fields */}
          <HeaderField
            label="Show"
            value={v2Filters.sale_mode || 'net'}
            onChange={(m) => setV2('sale_mode', m)}
            options={SALE_MODE_OPTIONS}
            minWidth={92}
            title="Sale / Return / Net lens applied to every figure on the page"
          />
          <HeaderField
            label="Valuation"
            value={v2Filters.valuation || 'gross'}
            onChange={(v) => setV2('valuation', v)}
            options={VALUATION_OPTIONS}
            minWidth={138}
            title="Pick the ₹ basis for every revenue figure on the page"
          />
        </div>
      }
      hideSync={true}
    >
      {/* Premium skin layer — activates the .sx-* design tokens defined in
          styles/globals.css. Wraps every child in the page so cards, tables,
          chips, and numbers all share the refined visual language. */}
      <div className="sx-page sx-fade">

      {preset === 'custom' && (
        <div className="sx-mobile-control-row sales-mobile-control-row" style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 24px',
          background: 'rgba(255, 255, 255, 0.02)',
          borderBottom: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
          marginBottom: 12,
        }}>
          <Calendar size={14} color={T.muted} strokeWidth={2.2} />
          <input type="date" value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="sales-date-input"
            style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '6px 10px', fontSize: 12, fontWeight: 600, color: T.primary, outline: 'none', background: 'var(--bg-elevated)', height: 30, fontFamily: 'var(--font-body)', colorScheme: 'light dark' }} />
          <span style={{ fontWeight: 700, color: T.muted, fontSize: 14 }}>→</span>
          <input type="date" value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="sales-date-input"
            style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '6px 10px', fontSize: 12, fontWeight: 600, color: T.primary, outline: 'none', background: 'var(--bg-elevated)', height: 30, fontFamily: 'var(--font-body)', colorScheme: 'light dark' }} />
          {hasFilters && (
            <button
              onClick={() => { setColorName(''); setSize(''); setLocationId(''); clearV2(); setPreset('mtd'); }}
              className="sx-chip" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>
              Reset
            </button>
          )}
          <button onClick={fetch} className="sx-chip"
            title="Refresh data"
            style={{ height: 28, padding: '0 10px' }}>
            <RefreshCw size={12} color={T.primary} strokeWidth={2.2} />
            <span style={{ fontSize: 11, fontWeight: 700 }}>Refresh</span>
          </button>

          <style jsx>{`
            :global(.sales-date-input::-webkit-calendar-picker-indicator) {
              opacity: 1;
              cursor: pointer;
              width: 16px;
              height: 16px;
              background-position: center;
              background-repeat: no-repeat;
              background-size: 14px 14px;
              background-image: url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23E2E8F0%27%20stroke-width%3D%272.4%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Crect%20x%3D%273%27%20y%3D%274%27%20width%3D%2718%27%20height%3D%2718%27%20rx%3D%272%27%2F%3E%3Cline%20x1%3D%2716%27%20y1%3D%272%27%20x2%3D%2716%27%20y2%3D%276%27%2F%3E%3Cline%20x1%3D%278%27%20y1%3D%272%27%20x2%3D%278%27%20y2%3D%276%27%2F%3E%3Cline%20x1%3D%273%27%20y1%3D%2710%27%20x2%3D%2721%27%20y2%3D%2710%27%2F%3E%3C%2Fsvg%3E");
            }
            :global(html.theme-light .sales-date-input::-webkit-calendar-picker-indicator) {
              background-image: url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23334155%27%20stroke-width%3D%272.4%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Crect%20x%3D%273%27%20y%3D%274%27%20width%3D%2718%27%20height%3D%2718%27%20rx%3D%272%27%2F%3E%3Cline%20x1%3D%2716%27%20y1%3D%272%27%20x2%3D%2716%27%20y2%3D%276%27%2F%3E%3Cline%20x1%3D%278%27%20y1%3D%272%27%20x2%3D%278%27%20y2%3D%276%27%2F%3E%3Cline%20x1%3D%273%27%20y1%3D%2710%27%20x2%3D%2721%27%20y2%3D%2710%27%2F%3E%3C%2Fsvg%3E");
            }
            :global(.sales-date-input::-webkit-calendar-picker-indicator:hover) {
              background-color: rgba(255,255,255,0.08);
              border-radius: 4px;
            }
          `}</style>
        </div>
      )}

      {v2Active > 0 && (
        <div className="sx-mobile-chip-strip" style={{ marginTop: 0, marginBottom: 18 }}>
          <FilterChips
            filters={v2Filters}
            setFilter={setV2}
            clearAll={clearV2}
          />
        </div>
      )}

      <div style={{
        opacity: refreshing && data ? 0.55 : 1,
        transition: 'opacity 200ms ease',
        pointerEvents: refreshing && data ? 'none' : 'auto',
        paddingTop: 0,
      }}>
      {/* Lens row (Sale/Return/Net + Valuation + Return-rate pill) was moved
          to the top control row above, on the same line as the ModePill. */}

      {/* ── Sales Pulse — KPI strip (lens-aware, count-up animated) ─── */}
      <SalesPulse
        data={dataLens}
        loading={loading}
        lensMode={v2Filters.sale_mode || 'net'}
        valuation={v2Filters.valuation || 'gross'}
        dateFrom={dateFrom}
        dateTo={dateTo}
      />

      {/* The legacy 6-card KPI grid (Sales/Units/Net Revenue + Returns/Stock/
          Best Day) was merged into the SalesPulse hero strip above — single
          source of KPI truth, no duplicates. ──────────────────────────── */}

      {/* ── Top Stores / Top Shades / Channels — sit right below the merged
          KPI strip. Same `data` prop = filters narrow it too. ─────────── */}
      {/* SalesPulseTables receives RAW `data` (not dataLens). It does its own
          lens-aware row enrichment using both sale-side AND return-side
          columns, so applying dataLens first (which only picks sale-side
          values into `sales_value`) would double-transform and make Net
          collapse onto Sale. */}
      <SalesPulseTables data={data} loading={loading} lensMode={v2Filters.sale_mode || 'net'} valuation={v2Filters.valuation || 'gross'} onStoreClick={openStore} />

      {/* ── Chart 1: Daily Sales Trend (full width) ───────────────────────── */}
      {/* Show skeleton ONLY when there's nothing to display yet (cold load).
          During a mode/filter toggle we keep the previous chart rendered while
          the new data fetches in the background — no flash to gray. */}
      <div className="sx-card" style={{ padding: '24px 26px', marginBottom: 20 }}>
        <SectionTitle icon={Activity} label="Daily Sales Trend — Units · Revenue · Returns" />
        {loading && !data?.daily?.length
          ? <div className="sx-shimmer" style={{ height: 320, borderRadius: 12 }} />
          : data?.daily?.length
            ? <Chart key={dailyChartKey} options={dailyChartData.options} series={dailyChartData.series} type="area" height={320} />
            : <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontWeight: 700, fontSize: 13, letterSpacing: '0.01em' }}>No data for selected filters</div>
        }
      </div>

      {/* ── Charts Row: Monthly bars + Monthly revenue ────────────────────── */}
      <div className="sx-mobile-two-grid sales-mobile-chart-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="sx-card" style={{ padding: '24px 26px' }}>
          <SectionTitle icon={BarChart2} label="Monthly — Sales vs Returns (Units)" />
          {loading && !data?.by_month?.length
            ? <div className="sx-shimmer" style={{ height: 260, borderRadius: 12 }} />
            : <Chart key={monthlyChartKey} options={monthlyChartData.options} series={monthlyChartData.series} type="bar" height={260} />
          }
        </div>
        <div className="sx-card" style={{ padding: '24px 26px' }}>
          <SectionTitle icon={TrendingUp} label="Monthly Revenue (₹)" />
          {loading && !data?.by_month?.length
            ? <div className="sx-shimmer" style={{ height: 260, borderRadius: 12 }} />
            : <Chart key={`rev-${monthlyChartKey}`} options={revenueChartData.options} series={revenueChartData.series} type="area" height={260} />
          }
        </div>
      </div>

      {/* ── Distribution donuts — Colour + Size pies (lens × valuation aware).
          Reads from the same dataLens by_color / by_size arrays as the
          breakdown tables below, so there is NO additional API call and the
          backend's 10-min Redis TTL is shared. Series + options memoised
          inside the component so toggling unrelated UI doesn't recompute. */}
      <DistributionDonuts
        data={dataLens}
        loading={loading}
        lensMode={v2Filters.sale_mode || 'net'}
        valuation={v2Filters.valuation || 'gross'}
      />

      {/* ── Colour + Size sections with dedicated filters ─────────────────── */}
      <div className="sx-mobile-two-grid sales-mobile-breakdown-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <ColourBreakdownSection data={dataLens} loading={loading}
          lensMode={v2Filters.sale_mode || 'net'}
          valuation={v2Filters.valuation || 'gross'} />
        <SizeBreakdownSection data={dataLens} loading={loading}
          lensMode={v2Filters.sale_mode || 'net'}
          valuation={v2Filters.valuation || 'gross'} />
      </div>

      {/* ── SKU Performance — best sellers / slow movers, lens-aware ──────── */}
      <SkuPerformance data={data} loading={loading} valuation={v2Filters.valuation || 'gross'} onSkuClick={openSku} />

      {/* ── All Stores Full Table with city / channel / sort filters ──────── */}
      <AllStoresTable data={dataLens} loading={loading}
        lensMode={v2Filters.sale_mode || 'net'}
        valuation={v2Filters.valuation || 'gross'}
        onStoreClick={openStore} />

      {/* ── Drilldown drawer — opens on store/SKU row click. Stale-while-
          revalidate cached per (pivot,id,filters); singleflight via
          dedupedFetch prevents thundering herd on rapid open/close. ─── */}
      <DrilldownDrawer
        open={!!drillTarget}
        pivot={drillTarget?.pivot}
        id={drillTarget?.id}
        filters={drillFilters}
        valuation={v2Filters.valuation || 'gross'}
        lensMode={v2Filters.sale_mode || 'net'}
        onClose={closeDrill}
      />

      </div>{/* /.refreshing-scope */}
      </div>{/* /.sx-page */}
    </DashboardLayout>
    </FiltersProvider>
  );
}

SalesAnalyticsPage.getLayout = (page) => page;
