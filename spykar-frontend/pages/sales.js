import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import FilterBar from '../components/filters/FilterBar';
import FilterChips from '../components/filters/FilterChips';
import SalesPulse, { SalesPulseTables } from '../components/sales/SalesPulse';
import SkuPerformance from '../components/sales/SkuPerformance';
import DistributionDonuts from '../components/sales/DistributionDonuts';
import DrilldownDrawer from '../components/sales/DrilldownDrawer';
import { useFilters } from '../lib/useFilters';
import { analyticsService } from '../lib/services';
import { getCached, setCached, isFresh } from '../lib/dashboardCache';
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
    case 'cy':      return { from: '2025-01-01', to: '2026-01-31' };  // calendar year of available ERP data
    case 'fy':      return { from: '2025-04-01', to: '2026-01-31' };  // Indian FY 2025-26 (so far)
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

// ── 3-segment Sale/Return/Net lens pill (matches FilterBar mode-pill UX) ───
function SaleModePill({ mode, onChange }) {
  const OPTS = [
    { key: 'sale',   label: 'Sale',   color: '#2563EB', title: 'Gross sales only (no returns deducted)' },
    { key: 'return', label: 'Return', color: '#F43F5E', title: 'Returns only — quality & fit feedback' },
    { key: 'net',    label: 'Net',    color: '#059669', title: 'Sales minus returns — the truer revenue figure' },
  ];
  const idx = Math.max(0, OPTS.findIndex(o => o.key === mode));
  const seg = 100 / OPTS.length;
  return (
    <div style={{
      display: 'inline-flex', position: 'relative',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: 999, padding: 3, height: 32,
    }}>
      <span style={{
        position: 'absolute', top: 3, bottom: 3,
        left: `calc(${idx * seg}% + 3px)`,
        width: `calc(${seg}% - 6px)`,
        background: 'rgba(255,255,255,0.14)',
        borderRadius: 999,
        boxShadow: '0 1px 4px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.12)',
        transition: 'left 220ms cubic-bezier(0.16,1,0.3,1), width 220ms',
      }} />
      {OPTS.map(opt => (
        <button
          key={opt.key}
          type="button"
          title={opt.title}
          onClick={() => onChange(opt.key)}
          style={{
            position: 'relative', zIndex: 1,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0 14px',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 12, fontWeight: 700, letterSpacing: '0.02em',
            color: mode === opt.key ? opt.color : '#64748b',
            transition: 'color 200ms',
          }}
        >{opt.label}</button>
      ))}
    </div>
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
        <span style={{ fontSize: 11, fontWeight: 800, color: T.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {label}
        </span>
      </div>
      {loading
        ? <div style={{ height: 38, background: 'var(--bg-elevated)', borderRadius: 8, animation: 'pulse 1.5s infinite' }} />
        : <div style={{ fontSize: 32, fontWeight: 900, color: T.primary, letterSpacing: '-0.03em', lineHeight: 1 }}>
            {value}
          </div>
      }
      {sub && <div style={{ fontSize: 12, fontWeight: 700, color: T.muted }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, marginTop: -4 }}>{sub2}</div>}
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
    <div className="sx-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
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
      <div style={{ overflowY: 'auto', maxHeight: 480 }}>
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
    <div className="sx-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
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
      <div style={{ overflowY: 'auto', maxHeight: 480 }}>
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
  const { filters: v2Filters, setFilter: setV2, clearAll: clearV2, activeCount: v2Active } =
    useFilters({
      defaults: { mode: 'active', sale_mode: 'net', valuation: 'gross' },
      persist:  ['mode', 'sale_mode', 'valuation'],
    });

  // Date range stays local (sales-specific UX with presets). Default = full
  // ERP window; user picks tighter ranges via the preset chips below.
  const [dateFrom, setDateFrom]     = useState('2025-01-01');
  const [dateTo, setDateTo]         = useState('2026-01-31');
  const [activePreset, setActivePreset] = useState('');

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
      `m${v2Filters.mode||'active'}`,   `lm${v2Filters.sale_mode||'net'}`,
    ].join('|');
  }, [v2Filters]);

  // Cache key is filter-dependent so each unique combination remembers its own
  // response. Navigating away and back with identical filters renders instantly
  // from the module-level cache instead of remounting empty.
  const cacheKey = `sales:v6:${dateFrom}|${dateTo}|${colorName}|${size}|${locationId}|${v2Slug}`;
  const [data, setData]       = useState(() => getCached(cacheKey) ?? null);
  const [loading, setLoading] = useState(() => !getCached(cacheKey));

  // Track the currently-active cacheKey so stale in-flight fetches (from a
  // previous category) can detect they've been superseded and skip writing
  // their response into `data`. Without this, switching Denim → Jacket → Denim
  // rapidly can let the pending Jacket response land after we're already
  // viewing Denim, "warming" the screen with the wrong category's payload.
  const activeKeyRef = useRef(cacheKey);
  useEffect(() => { activeKeyRef.current = cacheKey; }, [cacheKey]);

  const fetch = useCallback(async () => {
    const issuedFor = cacheKey;
    if (!getCached(issuedFor)) setLoading(true);
    try {
      const csv = (v) => Array.isArray(v) ? v.join(',') : (v || undefined);
      const res = await analyticsService.getSalesAnalytics({
        date_from:   dateFrom    || undefined,
        date_to:     dateTo      || undefined,
        color_name:  colorName   || undefined,  // legacy single-value
        size:        size        || undefined,  // legacy single-value (overrides v2 multi)
        location_id: locationId  || undefined,
        // v2 multi-select set — every filter narrows together
        gender:      csv(v2Filters.gender_name) || undefined,
        sub_product: csv(v2Filters.sub_product) || undefined,
        product:     csv(v2Filters.product)     || undefined,
        category:    csv(v2Filters.category)    || undefined,
        style:       csv(v2Filters.style)       || undefined,
        shade:       csv(v2Filters.shade)       || undefined,
        color:       csv(v2Filters.color)       || undefined,
        // v2 size only when no legacy size is set
        ...(size ? {} : { size: csv(v2Filters.size) || undefined }),
        season:      csv(v2Filters.season)      || undefined,
        state:       csv(v2Filters.state)       || undefined,
        city:        csv(v2Filters.city)        || undefined,
        group_name:  csv(v2Filters.group_name)  || undefined,
        store_code:  csv(v2Filters.store_code)  || undefined,
        mode:        v2Filters.mode             || 'active',
      });
      const v = res.data.data;
      // Always cache under the key this fetch was issued for, so future
      // returns to that category are instant. But only repaint `data` if the
      // user is still viewing that same category — otherwise we'd clobber
      // whatever is now on screen with stale foreign data.
      setCached(issuedFor, v);
      if (activeKeyRef.current === issuedFor) {
        setData(v);
        setLoading(false);
      }
    } catch (err) {
      if (activeKeyRef.current === issuedFor) setLoading(false);
      notifyApiError(err, 'Failed to load sales analytics');
    }
  }, [dateFrom, dateTo, colorName, size, locationId, v2Slug, cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Stale-while-revalidate. Three cases on filter/mode change:
    //   ① cache hit + fresh   → swap in instantly, no fetch
    //   ② cache hit + stale   → swap in instantly, refetch in background
    //   ③ cache miss          → KEEP previous data on screen (don't blank to
    //     zeros) and show a loading overlay; new data swaps in when ready.
    //
    // Previously this effect did `setData(cached ?? null)` unconditionally,
    // which made every Active↔Inactive toggle paint a zero-filled hero for
    // 2-5 s (Redis miss for the new mode = full Postgres mega-CTE scan).
    // Holding the old payload while refetching keeps the page populated and
    // lets the activeKeyRef race-guard ensure only the right response wins.
    const cached = getCached(cacheKey);
    if (cached) {
      setData(cached);
      if (isFresh(cacheKey)) { setLoading(false); return; }
      setLoading(false);   // stale-but-displayable; fetch in background
    } else {
      setLoading(true);    // keep prior `data` visible under a loading flag
    }
    fetch();
  }, [fetch, cacheKey]);

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
  const lensVal = (r, lm = lensMode) => {
    const sv = saleVal(r), rv = returnVal(r);
    if (lm === 'sale')   return sv;
    if (lm === 'return') return rv;
    return sv - rv; // 'net'
  };
  const lensUnits = (r, lm = lensMode) => {
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
  const enrichRows = (rows) => (rows || []).map(r => {
    const sv = saleVal(r), rv = returnVal(r);
    const su = Number(r?.units_sold || 0);
    const ru = Number(r?.return_qty || 0);
    const lv = lensMode === 'sale' ? sv : lensMode === 'return' ? rv : sv - rv;
    const lu = lensMode === 'sale' ? su : lensMode === 'return' ? ru : su - ru;
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
    };
  }, [dateFrom, dateTo, size, v2Slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const dataLens = useMemo(() => {
    if (!data) return data;
    return {
      ...data,
      by_color:   enrichRows(data.by_color),
      by_size:    enrichRows(data.by_size),
      by_store:   enrichRows(data.by_store),
      all_stores: enrichRows(data.all_stores),
      // Daily / monthly charts: flip the revenue line with valuation.
      daily:      (data.daily   || []).map(r => ({ ...r, sales_value: saleVal(r) })),
      by_month:   (data.by_month || []).map(r => ({ ...r, sales_value: saleVal(r) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, valuation, lensMode]);

  // ── Daily chart — premium 3-series with dedicated Y-axes ─────────────────
  const dailyChartData = useMemo(() => {
    const rows = dataLens?.daily || [];
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'area', id: 'daily' },
        xaxis: {
          type: 'datetime',
          categories: rows.map(r => new Date(r.date).getTime()),
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
        { name: 'Units Sold',  data: rows.map(r => ({ x: new Date(r.date).getTime(), y: Number(r.sales_qty)   })) },
        { name: 'Revenue (₹)', data: rows.map(r => ({ x: new Date(r.date).getTime(), y: Number(r.sales_value) })), yAxisIndex: 1 },
        { name: 'Returns',     data: rows.map(r => ({ x: new Date(r.date).getTime(), y: Number(r.return_qty)  })), yAxisIndex: 2 },
      ],
    };
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
        { name: 'Units Sold',     type: 'bar',  data: rows.map(r => Number(r.sales_qty)) },
        { name: 'Units Returned', type: 'line', data: rows.map(r => Number(r.return_qty)) },
      ],
    };
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

  const hasFilters = colorName || size || locationId || category || dateFrom !== '2025-01-01' || dateTo !== '2026-01-31' || v2Active > 0;

  return (
    <DashboardLayout title="Sales & Returns Analytics" subtitle="Day-basis sales intelligence — units, revenue, colour, size, store">
      {/* Premium skin layer — activates the .sx-* design tokens defined in
          styles/globals.css. Wraps every child in the page so cards, tables,
          chips, and numbers all share the refined visual language. */}
      <div className="sx-page sx-fade">

      {/* ── v2 Universal FilterBar — same 15 dimensions + Active/Inactive/All
          mode pill that drive every other page. URL-synced, multi-select,
          dependency-narrowing dropdowns. ────────────────────────────────── */}
      <FilterBar
        filters={v2Filters}
        setFilter={setV2}
        clearAll={clearV2}
        activeCount={v2Active}
      />
      <FilterChips
        filters={v2Filters}
        setFilter={setV2}
        clearAll={clearV2}
      />

      {/* ── Date-window dropdown — single control, lives right under the
          FilterBar so there's only ONE filter section on the page. The
          legacy filter row (date inputs / category select / refresh / ERP
          notice) is gone — every dimension is in the FilterBar above. ── */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        padding: '12px 24px 14px',
        background: 'rgba(255,255,255,0.66)',
        backdropFilter: 'blur(18px) saturate(180%)',
        WebkitBackdropFilter: 'blur(18px) saturate(180%)',
        borderBottom: `1px solid ${T.border}`,
        marginBottom: 22,
      }}>
        <Calendar size={13} color={T.muted} strokeWidth={2.2} />
        <span className="sx-eyebrow">Window</span>
        <div style={{ position: 'relative' }}>
          <select
            value={activePreset || 'custom'}
            onChange={e => {
              const v = e.target.value;
              if (v === 'custom') { setActivePreset(''); return; }
              const r = rangeForPreset(v);
              if (r) { setDateFrom(r.from); setDateTo(r.to); setActivePreset(v); }
            }}
            style={{ ...filterSelect, minWidth: 184 }}
          >
            <option value="custom">Custom range</option>
            <option value="today">Today</option>
            <option value="last_7">Last 7 days</option>
            <option value="last_30">Last 30 days</option>
            <option value="last_90">Last 90 days</option>
            <option value="mtd">Month to Date</option>
            <option value="qtd">Quarter to Date</option>
            <option value="ytd">Year to Date</option>
            <option value="fy">FY 2025-26</option>
            <option value="cy">Calendar 2025</option>
          </select>
          <ChevronIcon />
        </div>
        {/* Inline date inputs — visible always so user can fine-tune the
            window manually even after picking a preset. */}
        <input type="date" value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setActivePreset(''); }}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '7px 11px', fontSize: 12, fontWeight: 600, color: T.primary, outline: 'none', background: 'var(--bg-elevated)', height: 32, fontFamily: 'var(--font-body)' }} />
        <span style={{ fontWeight: 700, color: T.muted, fontSize: 13, padding: '0 2px' }}>→</span>
        <input type="date" value={dateTo}
          onChange={e => { setDateTo(e.target.value); setActivePreset(''); }}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '7px 11px', fontSize: 12, fontWeight: 600, color: T.primary, outline: 'none', background: 'var(--bg-elevated)', height: 32, fontFamily: 'var(--font-body)' }} />
        {hasFilters && (
          <button
            onClick={() => { setColorName(''); setSize(''); setLocationId(''); clearV2(); setDateFrom('2025-01-01'); setDateTo('2026-01-31'); setActivePreset(''); }}
            className="sx-chip" style={{ height: 32 }}>
            Reset all
          </button>
        )}
        <button onClick={fetch} className="sx-chip"
          title="Refresh data"
          style={{ marginLeft: 'auto', height: 32, padding: '0 12px' }}>
          <RefreshCw size={12} color={T.primary} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 700 }}>Refresh</span>
        </button>
        <span style={{
          fontSize: 10.5, fontWeight: 700, color: T.muted,
          borderLeft: `1px solid ${T.border}`, paddingLeft: 12,
          letterSpacing: '0.02em',
        }}>
          ERP: Apr 2024 – Jan 2026 · Stock: 1 Feb 2026
        </span>
      </div>

      {/* ── Lens pill (Sale/Return/Net) + Valuation dropdown
          (Gross / Ex-GST / GST / MRP / Discount / COGS / Margin / Margin%).
          Sits BELOW the Window strip and ABOVE the KPI cards. The two
          lenses are orthogonal: Sale-mode picks WHICH movement-type figure
          to show; Valuation picks the ₹ BASIS of that figure (gross with
          GST vs. ex-GST vs. MRP-equivalent vs. cost vs. margin). ───────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <span className="sx-eyebrow">Show</span>
        <SaleModePill
          mode={v2Filters.sale_mode || 'net'}
          onChange={(m) => setV2('sale_mode', m)}
        />
        <span className="sx-eyebrow" style={{ marginLeft: 14 }}>
          Valuation
        </span>
        <div style={{ position: 'relative' }}>
          <select
            value={v2Filters.valuation || 'gross'}
            onChange={e => setV2('valuation', e.target.value)}
            title="Pick the ₹ basis for every revenue figure on the page"
            style={{ ...filterSelect, minWidth: 178 }}
          >
            <option value="gross">Gross (with GST)</option>
            <option value="ex_gst">Ex-GST (revenue)</option>
            <option value="gst">GST collected</option>
            <option value="mrp">At MRP</option>
            <option value="discount">Discount given</option>
          </select>
          <ChevronIcon />
        </div>
        {Number(s.return_rate_pct) > 0 && (
          <span className="sx-pill" style={{
            marginLeft: 'auto',
            background: Number(s.return_rate_pct) >= 5 ? 'rgba(220,38,38,0.06)' : 'rgba(217,119,6,0.06)',
            border: `1px solid ${Number(s.return_rate_pct) >= 5 ? 'rgba(220,38,38,0.18)' : 'rgba(217,119,6,0.18)'}`,
            color: Number(s.return_rate_pct) >= 5 ? '#B91C1C' : '#B45309',
          }}>
            <RotateCcw size={11} strokeWidth={2.2} />
            Return rate · {s.return_rate_pct}%
          </span>
        )}
      </div>

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
            ? <Chart options={dailyChartData.options} series={dailyChartData.series} type="area" height={320} />
            : <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontWeight: 700, fontSize: 13, letterSpacing: '0.01em' }}>No data for selected filters</div>
        }
      </div>

      {/* ── Charts Row: Monthly bars + Monthly revenue ────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="sx-card" style={{ padding: '24px 26px' }}>
          <SectionTitle icon={BarChart2} label="Monthly — Sales vs Returns (Units)" />
          {loading && !data?.by_month?.length
            ? <div className="sx-shimmer" style={{ height: 260, borderRadius: 12 }} />
            : <Chart options={monthlyChartData.options} series={monthlyChartData.series} type="bar" height={260} />
          }
        </div>
        <div className="sx-card" style={{ padding: '24px 26px' }}>
          <SectionTitle icon={TrendingUp} label="Monthly Revenue (₹)" />
          {loading && !data?.by_month?.length
            ? <div className="sx-shimmer" style={{ height: 260, borderRadius: 12 }} />
            : <Chart options={revenueChartData.options} series={revenueChartData.series} type="area" height={260} />
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
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

      </div>{/* /.sx-page */}
    </DashboardLayout>
  );
}

SalesAnalyticsPage.getLayout = (page) => page;
