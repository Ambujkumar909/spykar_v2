// ─── /primary-sales — Spykar Primary Sales (Infor M3 MITTRA) ─────────────────
// Ultra-premium, DETAILED warehouse-movement intelligence. Denim-indigo identity
// (Spykar is a denim house; DENIM is the #1 category). One /overview round-trip
// powers the hero + KPIs + daily throughput + flow + monthly + leaderboards +
// txn structure; /pivot + /trend power the detailed explorer. Everything filters
// on TRDT (transaction date). "Throughput" = Σ|qty×price| (direction-agnostic, so
// the headline never reads negative); "Net" keeps the sign (stock value added).

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import TimeRangeControl from '../components/dashboard-v2/TimeRangeControl';
import { useTimeRange } from '../lib/v2/useTimeRange';
import { useTheme } from '../lib/useTheme';
import { useFilters } from '../lib/useFilters';
import { FiltersProvider } from '../lib/FiltersContext';
import { primarySalesService } from '../lib/services';
import { notifyApiError } from '../lib/notifyApiError';
import {
  Boxes, Warehouse, Package, IndianRupee, TrendingUp, TrendingDown, Receipt,
  ArrowLeftRight, Tag, Palette, Ruler, Shirt, Download, Activity, Layers,
  ArrowDownRight, ArrowUpRight, Gauge, Sparkles,
} from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

// ── formatters (Indian) ──────────────────────────────────────────────────────
function fmtCr(n, withRupee = true) {
  if (n == null) return '—';
  n = Number(n); const neg = n < 0; const a = Math.abs(n); let s;
  if (a >= 1e7) s = (a / 1e7).toFixed(a >= 1e9 ? 0 : 2) + ' Cr';
  else if (a >= 1e5) s = (a / 1e5).toFixed(2) + ' L';
  else s = Math.round(a).toLocaleString('en-IN');
  return (neg ? '−' : '') + (withRupee ? '₹' : '') + s;
}
function cnt(n) {
  if (n == null) return '0'; n = Number(n);
  if (n >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}
const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN'));

// TTYP direction from the signed qty (M3 codes; exact labels live in M3 config).
const ttypRole = (qty) => (qty > 0 ? 'Inbound' : qty < 0 ? 'Outbound' : 'Neutral');

const VIEW_BY = [
  { key: 'warehouse', label: 'Warehouse', Icon: Warehouse },
  { key: 'type',      label: 'Txn type',  Icon: ArrowLeftRight },
  { key: 'category',  label: 'Category',  Icon: Tag },
  { key: 'colour',    label: 'Colour',    Icon: Palette },
  { key: 'size',      label: 'Size',      Icon: Ruler },
  { key: 'product',   label: 'Product',   Icon: Shirt },
];
const MEASURE_OPTIONS = [
  { value: 'value', label: 'Value (₹)' },
  { value: 'units', label: 'Units' },
];
// Sidebar "Lens" dims relevant to Primary Sales → display labels (for on-page chips).
const LENS_LABELS = {
  gender_name: 'Gender', category: 'Category', product: 'Product',
  sub_product: 'Sub-product', size: 'Size', color: 'Colour', season: 'Season',
};

// ── small presentational bits ────────────────────────────────────────────────
function HeaderField({ label, value, onChange, options, minWidth = 120, title }) {
  return (
    <label title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 34,
      padding: '0 6px 0 12px', borderRadius: 10, background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
        color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select value={value} onChange={(e) => onChange?.(e.target.value)} style={{ height: 28, padding: '0 22px 0 4px',
          background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)',
          cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', outline: 'none', minWidth }}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <svg style={{ position: 'absolute', right: 4, pointerEvents: 'none', opacity: 0.5 }} width={11} height={11}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><polyline points="6 9 12 15 18 9" /></svg>
      </div>
    </label>
  );
}

function Card({ children, style, className = '' }) {
  return <div className={`ps-card ${className}`} style={style}>{children}</div>;
}
function SecTitle({ icon: Icon, label, cap, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
      {Icon && <span className="ps-secicon"><Icon size={14} strokeWidth={2.2} /></span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>{label}</div>
        {cap && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{cap}</div>}
      </div>
      {right}
    </div>
  );
}
function Shim({ h = 14, w = '100%' }) { return <div className="ps-shim" style={{ height: h, width: w, borderRadius: 6 }} />; }

// Horizontal bar list (magnitude). Sequential single hue OR per-row color fn.
function BarList({ rows, color, fmt, loading, cap = 10 }) {
  if (loading) return <div style={{ display: 'grid', gap: 12 }}>{Array.from({ length: 6 }).map((_, i) => <Shim key={i} h={20} />)}</div>;
  if (!rows?.length) return <Empty label="No data in this window" small />;
  const max = Math.max(...rows.map((r) => Math.abs(r.v)), 1);
  return (
    <div>
      {rows.slice(0, cap).map((r, i) => (
        <div key={r.key || i} className="ps-bar">
          <div className="ps-bar-name" title={r.name}>
            {r.code && <span className="ps-bar-code">{r.code}</span>}{r.name}
          </div>
          <div className="ps-bar-track">
            <div className="ps-bar-fill" style={{ width: (Math.abs(r.v) / max * 100).toFixed(1) + '%',
              background: typeof color === 'function' ? color(r, i) : color }} />
          </div>
          <div className="ps-bar-amt tnum">{fmt(r.v)}{r.sub != null && <span className="ps-bar-sub">{r.sub}</span>}</div>
        </div>
      ))}
    </div>
  );
}

function Empty({ label, small }) {
  return (
    <div style={{ minHeight: small ? 120 : 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 10, color: 'var(--text-muted)' }}>
      <Gauge size={small ? 20 : 28} strokeWidth={1.6} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

export default function PrimarySalesPage() {
  const { preset, setPreset, setCustom, fromISO, toISO } = useTimeRange('ytd'); // open on the full FY
  const { isDark } = useTheme();
  const [measure, setMeasure]     = useState('value');
  const [viewBy, setViewBy]       = useState('warehouse');
  const [warehouse, setWarehouse] = useState('');
  const [txnType, setTxnType]     = useState('');
  const [sortBy, setSortBy]       = useState('value');
  // Row-click drill: filter the whole page to one member of the current View-by.
  const [drill, setDrill]         = useState(null); // { dim, value, label } | null

  const [warehouses, setWarehouses] = useState([]);
  const [types, setTypes] = useState([]);
  const [dataRange, setDataRange] = useState(null); // { from, to } of available data

  // Sidebar "Lens" filters (SKU attributes), shared via FiltersContext so the
  // PremiumFilterBar in the rail drives this page. Only the dims relevant to
  // Primary Sales are shown there (see PremiumFilterBar ROUTE_DIMS).
  const filtersApi = useFilters({ defaults: {} });
  const lens = filtersApi.filters;
  const clearLens = filtersApi.clearFilter;
  // Active sidebar-filter dims (to render as removable chips on the page).
  const activeLensDims = useMemo(
    () => Object.keys(LENS_LABELS).filter((d) => { const v = lens[d]; return Array.isArray(v) ? v.length > 0 : Boolean(v); }),
    [lens]
  );
  const lensScope = useMemo(() => {
    const p = {};
    const put = (k, v) => { if (v && v.length) p[k] = Array.isArray(v) ? v.join(',') : v; };
    put('gender', lens.gender_name); put('category', lens.category); put('product', lens.product);
    put('sub_product', lens.sub_product); put('size', lens.size); put('color', lens.color); put('season', lens.season);
    return p;
  }, [lens]);
  const lensKey = useMemo(() => JSON.stringify(lensScope), [lensScope]);

  // Measure-aware value + formatter (Value ₹ vs Units). Declared early — the
  // chart useMemos below reference it (avoids a temporal-dead-zone error).
  const isUnits = measure === 'units';
  const mfmt = useCallback((n) => (isUnits ? fmtNum(n) : fmtCr(n)), [isUnits]);

  const scope = useMemo(() => {
    const p = { ...lensScope }; // sidebar Lens (category/gender/size/…)
    if (warehouse) p.warehouse = warehouse; if (txnType) p.type = txnType;
    if (drill) p[drill.dim] = drill.value; // drill filters the whole page to one member
    return p;
  }, [warehouse, txnType, drill, lensKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);

  // Time pills: "Custom" defaults its from/to to the available data range.
  const onTimeChange = useCallback((p) => {
    if (p === 'custom' && dataRange?.from) setCustom(dataRange.from, dataRange.to);
    else setPreset(p);
  }, [dataRange, setCustom, setPreset]);

  // Switching View-by clears any active drill (re-slicing from scratch).
  const changeViewBy = useCallback((k) => { setViewBy(k); setDrill(null); }, []);
  // Click any row → drill to that member (toggle off if already active).
  const onRowDrill = useCallback((r) => {
    setDrill((d) => (d && d.value === r.key ? null : { dim: viewBy, value: r.key, label: r.label }));
  }, [viewBy]);

  const [ov, setOv] = useState(null);
  const [ovLoading, setOvLoading] = useState(true);
  const [pivot, setPivot] = useState(null);
  const [pivotLoading, setPivotLoading] = useState(true);
  const [trend, setTrend] = useState(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // filter option lists (once)
  useEffect(() => {
    let a = true;
    primarySalesService.getWarehouses().then((r) => { if (a) setWarehouses(r.data?.data || []); }).catch(() => {});
    primarySalesService.getTypes().then((r) => { if (a) setTypes(r.data?.data || []); }).catch(() => {});
    primarySalesService.getRange().then((r) => { if (a) setDataRange(r.data?.data || null); }).catch(() => {});
    return () => { a = false; };
  }, []);

  // overview
  useEffect(() => {
    let a = true; setOvLoading(true);
    primarySalesService.getOverview({ from: fromISO, to: toISO, ...scope })
      .then((r) => { if (a) setOv(r.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load primary sales'); })
      .finally(() => { if (a) setOvLoading(false); });
    return () => { a = false; };
  }, [scopeKey, fromISO, toISO]); // eslint-disable-line react-hooks/exhaustive-deps

  // detailed pivot
  useEffect(() => {
    let a = true; setPivotLoading(true);
    primarySalesService.getPivot({ group_by: viewBy, from: fromISO, to: toISO, ...scope })
      .then((r) => { if (a) setPivot(r.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load breakdown'); })
      .finally(() => { if (a) setPivotLoading(false); });
    return () => { a = false; };
  }, [scopeKey, viewBy, fromISO, toISO]); // eslint-disable-line react-hooks/exhaustive-deps

  // explorer trend
  useEffect(() => {
    let a = true; setTrendLoading(true);
    primarySalesService.getTrend({ group_by: viewBy, from: fromISO, to: toISO, top: 6, measure: measure === 'units' ? 'units' : 'gross', ...scope })
      .then((r) => { if (a) setTrend(r.data?.data || null); })
      .catch(() => {})
      .finally(() => { if (a) setTrendLoading(false); });
    return () => { a = false; };
  }, [scopeKey, viewBy, measure, fromISO, toISO]); // eslint-disable-line react-hooks/exhaustive-deps

  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const res = await primarySalesService.exportCsv({ group_by: viewBy, from: fromISO, to: toISO, measure: measure === 'units' ? 'units' : 'gross', ...scope });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `primary-sales-${viewBy}-${fromISO}_${toISO}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
    } catch (e) { notifyApiError(e, 'Export failed'); } finally { setExporting(false); }
  }, [viewBy, fromISO, toISO, measure, scope]);

  const k = ov?.kpis;
  const inTx = ov?.flow?.find((f) => f.dir === 'Inbound')?.txns || 0;
  const outTx = ov?.flow?.find((f) => f.dir === 'Outbound')?.txns || 0;
  const inShare = (inTx + outTx) ? Math.round(inTx / (inTx + outTx) * 100) : 0;

  // ── palette (validated categorical + denim accent) ──
  const DENIM = isDark ? '#7B92FF' : '#3D5AF1';
  const SEQ = isDark ? '#3987e5' : '#2a78d6';
  const IN = isDark ? '#3987e5' : '#2a78d6';
  const OUT = isDark ? '#e66767' : '#e34948';
  const SERIES = isDark
    ? ['#3987e5', '#199e70', '#c98500', '#3ba33b', '#9085e9', '#e66767', '#d55181', '#d95926']
    : ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
  const axis = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.55)';
  const grid = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';

  // ── daily throughput area ──
  const dailyOpts = useMemo(() => ({
    chart: { type: 'area', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: true, speed: 600 }, background: 'transparent' },
    colors: [SEQ], stroke: { width: 2, curve: 'smooth', lineCap: 'round' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.28, opacityTo: 0, stops: [0, 100] } },
    dataLabels: { enabled: false }, markers: { size: 0, hover: { size: 5 } },
    grid: { borderColor: grid, strokeDashArray: 0, padding: { left: 8, right: 12 } },
    xaxis: { type: 'category', categories: (ov?.daily || []).map((d) => d.d), tickAmount: 8,
      labels: { style: { colors: axis, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true,
        formatter: (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '') },
      axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { colors: axis, fontSize: '11px' }, formatter: (v) => (isUnits ? cnt(v) : fmtCr(v)) } },
    tooltip: { theme: isDark ? 'dark' : 'light', x: { formatter: (_, o) => { const d = (ov?.daily || [])[o?.dataPointIndex]; return d ? new Date(d.d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; } }, y: { formatter: (v) => (isUnits ? fmtNum(v) : fmtCr(v)), title: { formatter: () => 'Throughput' } } },
  }), [ov, isDark, isUnits]); // eslint-disable-line react-hooks/exhaustive-deps
  const dailySeries = useMemo(() => [{ name: 'Throughput', data: (ov?.daily || []).map((d) => (isUnits ? d.u : d.g)) }], [ov, isUnits]);

  // ── explorer trend (multi-line) ──
  const trendOpts = useMemo(() => ({
    chart: { type: 'line', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent' },
    colors: drill ? [DENIM] : SERIES, stroke: { width: drill ? 3 : 2.5, curve: 'smooth' },
    markers: { size: (trend?.dates?.length || 0) <= 2 ? 5 : 0, hover: { size: 6 } }, dataLabels: { enabled: false },
    legend: { show: !drill, position: 'bottom', fontSize: '12px', labels: { colors: axis }, markers: { width: 10, height: 3, radius: 2 } },
    grid: { borderColor: grid, padding: { left: 6, right: 12 } },
    xaxis: { type: 'category', categories: trend?.dates || [], labels: { style: { colors: axis, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true, formatter: (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '') }, axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { colors: axis, fontSize: '11px' }, formatter: (v) => (measure === 'units' ? cnt(v) : fmtCr(v)) } },
    tooltip: { theme: isDark ? 'dark' : 'light', y: { formatter: (v) => (measure === 'units' ? fmtNum(v) : fmtCr(v)) } },
  }), [trend, measure, isDark, drill]); // eslint-disable-line react-hooks/exhaustive-deps
  const trendSeries = useMemo(() => (trend?.series || []).map((s) => ({ name: s.label, data: s.points.map((p) => p.value) })), [trend]);

  // ── detailed pivot rows (sorted) — show ALL rows (safety cap only for a
  //    pathological dimension so the DOM can't melt). ──
  const ROW_CAP = 5000;
  const pivotRows = useMemo(() => {
    const rows = [...(pivot?.rows || [])];
    const val = (r) => (measure === 'units' ? Math.abs(r.qty) : Math.abs(r.value_gross));
    const cmp = { value: (a, b) => val(b) - val(a), txns: (a, b) => b.txns - a.txns,
      delta: (a, b) => (b.delta_qty_vs_prev_pct ?? -1e9) - (a.delta_qty_vs_prev_pct ?? -1e9) }[sortBy] || (() => 0);
    return rows.sort(cmp).slice(0, ROW_CAP);
  }, [pivot, measure, sortBy]);
  const dimLabel = VIEW_BY.find((v) => v.key === viewBy)?.label || viewBy;

  // ── leaderboard rows (switch metric with the Measure toggle) ──
  const whRows = (ov?.top_wh || []).map((w) => ({ code: w.code, name: w.name, v: isUnits ? w.u : w.g }));
  const catRows = (ov?.top_cat || []).map((c) => ({ name: c.name, v: isUnits ? c.u : c.g }));
  const ttypRows = (ov?.ttyp || []).map((t) => ({ code: 'T' + t.code, name: t.label || ttypRole(t.qty), v: t.net, dir: t.qty }));

  const wOpts = useMemo(() => ([{ value: '', label: 'All warehouses' },
    ...warehouses.map((w) => ({ value: w.whlo, label: `${w.whlo} · ${w.whnm || ''}`.trim() }))]), [warehouses]);
  const tOpts = useMemo(() => ([{ value: '', label: 'All types' },
    ...types.map((t) => ({ value: t.ttyp, label: `${t.ttyp}${t.trtp ? ' / ' + t.trtp : ''}` }))]), [types]);

  // Header stays slim — just the time pills (like /sales) so the clock + theme
  // toggle never get pushed off-screen. All other controls live in the page
  // toolbar below.
  const headerSlot = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <TimeRangeControl preset={preset} onChange={onTimeChange} />
    </div>
  );

  // ── Page toolbar (below header, above the hero) — INLINE styles (styled-jsx
  // doesn't reach JSX built in a const, so we style inline like HeaderField).
  // colorScheme follows the app theme so the native date field + its calendar
  // icon flip correctly: light → white field / dark icon, dark → dark field /
  // white icon.
  const capsuleSty = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' };
  // NOTE: no inline colorScheme — the app's root color-scheme (html /
  // html.theme-light in globals.css) drives the field + calendar popup so they
  // align with the theme (which itself follows the browser on first load). The
  // icon glyph is forced deterministically by the .ps-date rule below.
  const dateInputSty = { border: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', outline: 'none', cursor: 'pointer', padding: 0 };
  const capLblSty = { fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-muted)' };
  const chipSty = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 30, maxWidth: 300, padding: '0 4px 0 12px', borderRadius: 999, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', fontSize: 12, color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' };
  const pageToolbar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <HeaderField label="Measure" value={measure} onChange={setMeasure} options={MEASURE_OPTIONS} minWidth={92} />
        <HeaderField label="Warehouse" value={warehouse} onChange={setWarehouse} options={wOpts} minWidth={130} />
        <HeaderField label="Type" value={txnType} onChange={setTxnType} options={tOpts} minWidth={88} />
        {preset === 'custom' && (
          <span style={capsuleSty}>
            <span style={capLblSty}>Custom</span>
            <input type="date" className="ps-date" value={fromISO} min={dataRange?.from} max={toISO} style={dateInputSty}
              onChange={(e) => e.target.value && setCustom(e.target.value, toISO)} aria-label="From date" />
            <span style={{ color: 'var(--text-muted)', fontWeight: 800 }}>→</span>
            <input type="date" className="ps-date" value={toISO} min={fromISO} max={dataRange?.to} style={dateInputSty}
              onChange={(e) => e.target.value && setCustom(fromISO, e.target.value)} aria-label="To date" />
          </span>
        )}
      </div>
      {activeLensDims.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ ...capLblSty, fontSize: 10, marginRight: 2 }}>Filters</span>
          {activeLensDims.map((dim) => {
            const v = lens[dim]; const vals = Array.isArray(v) ? v : [v];
            return (
              <span key={dim} style={chipSty}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: DENIM, flexShrink: 0 }}>{LENS_LABELS[dim]}</span>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={vals.join(', ')}>{vals.join(', ')}</span>
                <button type="button" onClick={() => clearLens(dim)} aria-label={`Clear ${LENS_LABELS[dim]}`}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, border: 'none', borderRadius: '50%', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1, flexShrink: 0 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = DENIM; e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}>✕</button>
              </span>
            );
          })}
          {activeLensDims.length > 1 && (
            <button type="button" onClick={() => activeLensDims.forEach((d) => clearLens(d))}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: '4px 6px' }}>Clear all</button>
          )}
        </div>
      )}
    </div>
  );

  const emptyAll = !ovLoading && ov?.empty;

  return (
    <FiltersProvider value={filtersApi}>
    <DashboardLayout title="Primary Sales"
      subtitle="Warehouse movement intelligence from the Infor M3 ledger — receipts, issues & transfers by transaction date"
      headerSlot={headerSlot} hideSync={true}>
      <div className="ps-root">
        {pageToolbar}
        {/* ── HERO ── */}
        <div className="ps-hero">
          <div className="ps-hero-glow" />
          <div className="ps-hero-inner">
            <div className="ps-eyebrow"><Sparkles size={12} /> {isUnits ? 'Units moved' : 'Gross value moved'} · {ov?.from || fromISO} → {ov?.to || toISO}</div>
            {ovLoading ? <Shim h={64} w="60%" /> : (
              <div className="ps-hero-num tnum">
                {!isUnits && <span className="cur">₹</span>}{isUnits ? cnt(k?.throughput_units) : fmtCr(k?.throughput, false)}
                {isUnits && <span className="ps-hero-suffix">units</span>}
                {k?.throughput_delta_pct != null && (
                  <span className={`ps-delta ${k.throughput_delta_pct >= 0 ? 'up' : 'down'}`}>
                    {k.throughput_delta_pct >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
                    {Math.abs(k.throughput_delta_pct)}%
                  </span>
                )}
              </div>
            )}
            <div className="ps-hero-sub">
              <span><b className="tnum">{cnt(k?.txns || 0)}</b> transactions</span>
              <span><b className="tnum">{k?.warehouse_count || 0}</b> warehouses</span>
              <span><b className="tnum">{cnt(k?.sku_count || 0)}</b> SKUs</span>
              <span className="ps-chip"><i style={{ background: IN }} />Inbound <b>{inShare}%</b></span>
              <span className="ps-chip"><i style={{ background: OUT }} />Outbound <b>{100 - inShare}%</b></span>
            </div>
          </div>
        </div>

        {emptyAll ? <Card style={{ marginTop: 16 }}><Empty label="No primary-sales movements in this date range" /></Card> : (
        <>
        {/* ── KPI strip ── */}
        <div className="ps-kpis">
          {[
            { lab: 'Transactions', val: cnt(k?.txns || 0), foot: 'movement lines', Icon: Receipt, c: DENIM },
            { lab: 'Net value flow', val: (k?.net_value >= 0 ? '+' : '') + fmtCr(k?.net_value), foot: 'stock value added', Icon: IndianRupee, c: SERIES[1] },
            { lab: 'Warehouses', val: fmtNum(k?.warehouse_count), foot: 'with activity', Icon: Warehouse, c: SERIES[0] },
            { lab: 'Distinct SKUs', val: cnt(k?.sku_count || 0), foot: 'items moved', Icon: Package, c: SERIES[4] },
            { lab: 'Txn types', val: fmtNum(k?.ttyp_count), foot: 'receipt · issue · transfer', Icon: ArrowLeftRight, c: SERIES[2] },
            { lab: 'Net units', val: fmtNum(k?.net_qty), foot: 'signed quantity', Icon: Boxes, c: SERIES[7] },
          ].map((t, i) => (
            <div key={i} className="ps-kpi">
              <div className="ps-kpi-bar" style={{ background: t.c }} />
              <div className="ps-kpi-head"><span className="ps-kpi-ic" style={{ background: t.c + '1c', color: t.c }}><t.Icon size={13} strokeWidth={2.2} /></span>
                <span className="ps-kpi-lab">{t.lab}</span></div>
              {ovLoading ? <Shim h={26} w="70%" /> : <div className="ps-kpi-val tnum">{t.val}</div>}
              <div className="ps-kpi-foot">{t.foot}</div>
            </div>
          ))}
        </div>

        {/* Price-basis note — between KPIs and the trend */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '12px 2px 0' }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
            title="Value = quantity × transaction price (TRPR); Cost = quantity × purchase price (PUPR)">
            Value = qty × TRPR (transaction price)
          </span>
        </div>

        {/* ── Daily throughput ── */}
        <Card style={{ marginTop: 8 }}>
          <SecTitle icon={Activity} label="Daily throughput" cap={`${isUnits ? 'Units' : 'Gross value'} moved per day — every receipt, issue & transfer leg`}
            right={<span className="ps-unit">{isUnits ? 'units / day' : '₹ / day'}</span>} />
          {ovLoading ? <Shim h={300} /> : ov?.daily?.length
            ? <Chart options={dailyOpts} series={dailySeries} type="area" height={300} />
            : <Empty label="No daily data" small />}
        </Card>

        {/* ── Flow + Monthly ── */}
        <div className="ps-two">
          <Card>
            <SecTitle icon={ArrowLeftRight} label="Inbound vs outbound" cap="A near-balanced flow — mostly warehouse transfers" />
            <FlowBars flow={ov?.flow} loading={ovLoading} IN={IN} OUT={OUT} isUnits={isUnits} mfmt={mfmt} />
          </Card>
          <Card>
            <SecTitle icon={TrendingUp} label={isUnits ? 'Net units by month' : 'Net value by month'} cap={`Signed — stock ${isUnits ? 'units' : 'value'} added (+) or drawn down (−)`} right={<span className="ps-unit">{isUnits ? 'units net' : '₹ net'}</span>} />
            <MonthCols monthly={ov?.monthly} loading={ovLoading} IN={IN} OUT={OUT} axis={axis} grid={grid} isUnits={isUnits} mfmt={mfmt} />
          </Card>
        </div>

        {/* ── Leaderboards ── */}
        <div className="ps-two">
          <Card>
            <SecTitle icon={Warehouse} label="Top warehouses" cap={`Where primary movement concentrates · ${isUnits ? 'units' : 'gross value'}`} right={<span className="ps-unit">Top 10</span>} />
            <BarList rows={whRows} color={SEQ} fmt={mfmt} loading={ovLoading} />
          </Card>
          <Card>
            <SecTitle icon={Tag} label="Category mix" cap={`${isUnits ? 'Units' : 'Gross value'} moved · denim leads, as expected`} />
            <BarList rows={catRows} color={(r, i) => SERIES[i % SERIES.length]} fmt={mfmt} loading={ovLoading} cap={8} />
          </Card>
        </div>

        {/* ── Transaction structure ── */}
        <Card style={{ marginTop: 16 }}>
          <SecTitle icon={Layers} label="Transaction structure" cap="Top transaction types by value — inbound and outbound legs mirror each other" />
          <div className="ps-two-tight">
            <BarList rows={ttypRows} color={(r) => (r.dir < 0 ? OUT : IN)} fmt={fmtCr} loading={ovLoading} cap={8} />
            <div className="ps-tt-table">
              <table><thead><tr><th>Transaction type</th><th>Flow</th><th style={{ textAlign: 'right' }}>Txns</th><th style={{ textAlign: 'right' }}>Net units</th><th style={{ textAlign: 'right' }}>Net value</th></tr></thead>
                <tbody>
                  {ovLoading ? Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={5}><Shim /></td></tr>)
                    : (ov?.ttyp || []).map((t) => (
                      <tr key={t.code}>
                        <td className="strong">{t.label || ('Type ' + t.code)} <span className="mono" style={{ color: 'var(--text-muted)', fontWeight: 700 }}>T{t.code}</span></td>
                        <td><span className={`ps-tag ${ttypRole(t.qty).toLowerCase()}`}>{ttypRole(t.qty)}</span></td>
                        <td className="tnum r">{fmtNum(t.txns)}</td>
                        <td className="tnum r">{fmtNum(t.qty)}</td>
                        <td className="tnum r strong">{fmtCr(t.net)}</td>
                      </tr>))}
                </tbody></table>
            </div>
          </div>
        </Card>

        {/* ── DETAILED EXPLORER ── */}
        <div className="ps-explorer">
          <div className="ps-exp-head">
            <div className="ps-viewby">
              {VIEW_BY.map(({ key, label, Icon }) => (
                <button key={key} className={`ps-vb ${viewBy === key ? 'on' : ''}`} onClick={() => changeViewBy(key)}>
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
            {drill && (
              <button className="ps-drillchip" onClick={() => setDrill(null)} title="Clear drill filter">
                {VIEW_BY.find((v) => v.key === drill.dim)?.label}: <b>{drill.label}</b> <span aria-hidden>✕</span>
              </button>
            )}
          </div>

          {/* by-dimension trend */}
          <Card style={{ marginTop: 14 }}>
            <SecTitle icon={Activity}
              label={drill ? `Trend · ${drill.label}` : `Trend by ${dimLabel.toLowerCase()}`}
              cap={drill ? `Drilled to one ${VIEW_BY.find((v) => v.key === drill.dim)?.label.toLowerCase()} · ${measure === 'units' ? 'units' : 'value'} over time`
                         : `Top 6 ${dimLabel.toLowerCase()}s over time · ${measure === 'units' ? 'units' : 'value'}`}
              right={drill ? <button className="ps-drillchip" onClick={() => setDrill(null)}>Clear <span aria-hidden>✕</span></button> : null} />
            {trendLoading ? <Shim h={300} /> : trendSeries.length && trend?.dates?.length
              ? <Chart options={trendOpts} series={trendSeries} type="line" height={300} />
              : <Empty label="No trend data" small />}
          </Card>

          {/* detailed table */}
          <Card style={{ marginTop: 14, overflow: 'hidden', padding: 0 }}>
            <div className="ps-tbl-head">
              <span className="ps-unit" style={{ color: DENIM }}>By {dimLabel}</span>
              {!pivotLoading && pivot?.rows && <span className="ps-count">{fmtNum(pivot.rows.length)}</span>}
              {!pivotLoading && (pivot?.rows?.length || 0) > ROW_CAP && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>top {ROW_CAP} · export for all</span>}
              <div style={{ flex: 1 }} />
              <HeaderField label="Sort" value={sortBy} onChange={setSortBy} minWidth={90}
                options={[{ value: 'value', label: measure === 'units' ? 'Units' : 'Value' }, { value: 'txns', label: 'Transactions' }, { value: 'delta', label: 'Δ vs prev' }]} />
              <button className="ps-export" onClick={onExport} disabled={exporting || !pivot?.rows?.length}>
                <Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
            <div className="ps-tbl-wrap">
              <table className="ps-tbl">
                <thead><tr>
                  <th className="l">{dimLabel}</th><th>Net units</th><th>Value (₹)</th><th>Cost (₹)</th><th>Txns</th><th>Avg price</th><th>Δ vs prev</th>
                </tr></thead>
                <tbody>
                  {pivotLoading ? Array.from({ length: 12 }).map((_, i) => <tr key={i}><td colSpan={7}><Shim /></td></tr>)
                    : pivotRows.length ? pivotRows.map((r, i) => (
                      <tr key={r.key || i} className={`clk ${drill && drill.value === r.key ? 'on' : ''}`}
                        onClick={() => onRowDrill(r)}>
                        <td className="l strong">{r.label || '—'}</td>
                        <td className="tnum">{fmtNum(r.qty)}</td>
                        <td className="tnum strong">{fmtCr(r.value_gross)}</td>
                        <td className="tnum">{fmtCr(r.value_cost)}</td>
                        <td className="tnum">{fmtNum(r.txns)}</td>
                        <td className="tnum">{r.avg_price == null ? '—' : fmtCr(r.avg_price)}</td>
                        <td className={`tnum ${r.delta_qty_vs_prev_pct == null ? '' : r.delta_qty_vs_prev_pct >= 0 ? 'pos' : 'neg'}`}>
                          {r.delta_qty_vs_prev_pct == null ? '—' : `${r.delta_qty_vs_prev_pct > 0 ? '+' : ''}${r.delta_qty_vs_prev_pct}%`}
                        </td>
                      </tr>)) : <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>No data for this selection</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        </>)}
      </div>

      {/* Global (unscoped) so it reaches the const-built date inputs, and with
          enough specificity to beat globals.css's own indicator rule. The icon
          glyph is forced deterministically: brightness(0) collapses it to black
          regardless of color-scheme; dark theme then inverts it to white. The
          field + popup follow the app's root color-scheme (browser-aligned).
          Dark = :root default (white icon), Light = html.theme-light (black). */}
      <style jsx global>{`
        input.ps-date[type='date']::-webkit-calendar-picker-indicator { filter: brightness(0) invert(1); opacity: 0.8; cursor: pointer; }
        html.theme-light input.ps-date[type='date']::-webkit-calendar-picker-indicator { filter: brightness(0); opacity: 0.6; }
      `}</style>

      <style jsx>{`
        .ps-root { padding-bottom: 40px; }
        .tnum { font-variant-numeric: tabular-nums; }
        /* hero */
        .ps-hero { position: relative; border-radius: 22px; overflow: hidden; margin-bottom: 18px;
          background: linear-gradient(135deg, var(--bg-surface), var(--bg-elevated));
          border: 1px solid var(--border-subtle); }
        .ps-hero-glow { position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(680px 300px at 88% -30%, ${DENIM}2e, transparent 60%); }
        .ps-hero-inner { position: relative; padding: 30px 32px; }
        .ps-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 800;
          letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 12px; }
        .ps-hero-num { font-size: clamp(44px, 7vw, 74px); font-weight: 850; letter-spacing: -0.03em; line-height: 1;
          color: var(--text-primary); display: flex; align-items: baseline; gap: 4px; }
        .ps-hero-num .cur { font-size: 0.42em; font-weight: 800; color: var(--text-muted); }
        .ps-hero-suffix { font-size: 0.32em; font-weight: 700; color: var(--text-muted); margin-left: 0.28em; align-self: center; }
        .ps-delta { font-size: 15px; font-weight: 800; display: inline-flex; align-items: center; gap: 2px;
          padding: 4px 10px; border-radius: 999px; margin-left: 12px; align-self: center; }
        .ps-delta.up { color: #0a7f4f; background: rgba(16,163,74,0.14); }
        .ps-delta.down { color: ${OUT}; background: ${OUT}22; }
        .ps-hero-sub { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 18px; font-size: 14px; color: var(--text-secondary); }
        .ps-hero-sub b { color: var(--text-primary); font-weight: 800; }
        .ps-chip { display: inline-flex; align-items: center; gap: 7px; }
        .ps-chip i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
        /* cards */
        :global(.ps-card) { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 18px;
          padding: 20px 22px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 10px 34px rgba(2,6,23,0.05); }
        :global(.ps-secicon) { width: 28px; height: 28px; border-radius: 9px; flex-shrink: 0; display: inline-flex;
          align-items: center; justify-content: center; background: var(--bg-elevated); color: var(--text-primary); }
        .ps-unit { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
        :global(.ps-shim) { background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-card-hover, rgba(148,163,184,0.12)) 37%, var(--bg-elevated) 63%);
          background-size: 400% 100%; animation: pssh 1.3s ease infinite; }
        @keyframes pssh { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
        /* kpis */
        .ps-kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; }
        .ps-kpi { position: relative; background: var(--bg-surface); border: 1px solid var(--border-subtle);
          border-radius: 16px; padding: 16px 16px 14px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
        .ps-kpi-bar { position: absolute; top: 0; left: 14px; right: 14px; height: 2px; border-radius: 2px; opacity: 0.9; }
        .ps-kpi-head { display: flex; align-items: center; gap: 9px; margin: 4px 0 10px; }
        .ps-kpi-ic { width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .ps-kpi-lab { font-size: 10.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
        .ps-kpi-val { font-size: 25px; font-weight: 850; letter-spacing: -0.02em; color: var(--text-primary); }
        .ps-kpi-foot { font-size: 11.5px; color: var(--text-muted); margin-top: 4px; }
        /* two-column */
        .ps-two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
        .ps-two-tight { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
        /* bars */
        :global(.ps-bar) { display: flex; align-items: center; gap: 12px; margin: 9px 0; }
        :global(.ps-bar-name) { width: 168px; flex: 0 0 168px; font-size: 13px; font-weight: 600; color: var(--text-primary);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        :global(.ps-bar-code) { color: var(--text-muted); font-weight: 800; font-size: 11px; margin-right: 6px; }
        :global(.ps-bar-track) { flex: 1; height: 20px; }
        :global(.ps-bar-fill) { height: 100%; border-radius: 5px 6px 6px 5px; min-width: 2px; transition: width 0.9s cubic-bezier(0.16,1,0.3,1); }
        :global(.ps-bar-amt) { width: 92px; flex: 0 0 92px; text-align: right; font-size: 13px; font-weight: 800; color: var(--text-primary); }
        :global(.ps-bar-sub) { display: block; font-size: 11px; font-weight: 600; color: var(--text-muted); }
        /* ttyp table */
        .ps-tt-table table, .ps-tbl { width: 100%; border-collapse: collapse; }
        .ps-tt-table th, .ps-tt-table td { padding: 8px 10px; font-size: 12.5px; border-bottom: 1px solid var(--border-subtle); }
        .ps-tt-table th { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); text-align: left; }
        .ps-tt-table td.r, .ps-tt-table th[style] { text-align: right; }
        .ps-tt-table .mono { font-variant-numeric: tabular-nums; font-weight: 800; color: var(--text-primary); }
        .ps-tt-table .strong { font-weight: 800; color: var(--text-primary); }
        .ps-tag { font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 999px; letter-spacing: 0.04em; }
        .ps-tag.inbound { color: ${IN}; background: ${IN}1e; }
        .ps-tag.outbound { color: ${OUT}; background: ${OUT}1e; }
        .ps-tag.neutral { color: var(--text-muted); background: var(--bg-elevated); }
        /* explorer */
        .ps-explorer { margin-top: 22px; }
        .ps-exp-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .ps-viewby { display: inline-flex; flex-wrap: wrap; gap: 5px; padding: 4px; background: var(--bg-elevated);
          border: 1px solid var(--border-subtle); border-radius: 12px; }
        .ps-vb { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 8px; border: none;
          cursor: pointer; font-size: 12px; font-weight: 700; background: transparent; color: var(--text-secondary); transition: all 0.15s; }
        .ps-vb.on { background: ${DENIM}; color: #fff; box-shadow: 0 4px 12px ${DENIM}55; }
        .ps-export { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 10px;
          border: 1px solid var(--border-subtle); background: var(--bg-elevated); cursor: pointer; color: var(--text-primary);
          font-size: 12px; font-weight: 700; }
        .ps-export:disabled { opacity: 0.5; cursor: default; }
        .ps-tbl-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap; }
        .ps-count { font-size: 10px; font-weight: 800; color: #fff; background: ${DENIM}; border-radius: 100px; padding: 2px 8px; }
        .ps-tbl-wrap { overflow-x: auto; }
        .ps-tbl th, .ps-tbl td { padding: 10px 14px; font-size: 13px; white-space: nowrap; border-bottom: 1px solid var(--border-subtle); }
        .ps-tbl th { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); text-align: right; }
        .ps-tbl th.l, .ps-tbl td.l { text-align: left; }
        .ps-tbl td { text-align: right; color: var(--text-secondary); font-weight: 600; }
        .ps-tbl td.strong { color: var(--text-primary); font-weight: 800; }
        .ps-tbl tr.clk { cursor: pointer; }
        .ps-tbl tbody tr:hover { background: var(--bg-card-hover, rgba(148,163,184,0.06)); }
        .ps-tbl tbody tr.clk.on { background: ${DENIM}1c; box-shadow: inset 3px 0 0 ${DENIM}; }
        .ps-drillchip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 999px;
          border: 1px solid ${DENIM}55; background: ${DENIM}18; color: var(--text-primary); font-size: 12px; font-weight: 700;
          cursor: pointer; transition: background 0.15s; }
        .ps-drillchip:hover { background: ${DENIM}2c; }
        .ps-drillchip b { font-weight: 800; }
        .ps-drillchip span { color: var(--text-muted); font-weight: 800; margin-left: 2px; }
        /* toolbar / date-picker / chips are styled inline (see pageToolbar) —
           styled-jsx scoping doesn't reach JSX built in a const. */
        .ps-tbl td.pos { color: #0a7f4f; font-weight: 800; }
        .ps-tbl td.neg { color: ${OUT}; font-weight: 800; }
        @media (max-width: 1100px) { .ps-kpis { grid-template-columns: repeat(3, 1fr); } .ps-two, .ps-two-tight { grid-template-columns: 1fr; } }
        @media (max-width: 560px) { .ps-kpis { grid-template-columns: repeat(2, 1fr); } :global(.ps-bar-name) { width: 116px; flex-basis: 116px; } }
      `}</style>
    </DashboardLayout>
    </FiltersProvider>
  );
}

// ── Inbound/Outbound bars ──
function FlowBars({ flow, loading, IN, OUT, isUnits, mfmt }) {
  if (loading) return <div style={{ display: 'grid', gap: 14 }}><Shim h={44} /><Shim h={44} /></div>;
  const rows = (flow || []).filter((f) => f.dir !== 'Neutral');
  if (!rows.length) return <Empty label="No flow data" small />;
  const val = (r) => (isUnits ? r.u : r.g);
  const max = Math.max(...rows.map(val), 1);
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 6 }}>
      {rows.map((r) => (
        <div key={r.dir}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-secondary)' }}>{r.dir}</span>
            <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
              {mfmt(val(r))} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>· {cnt(r.txns)} txns</span>
            </span>
          </div>
          <div style={{ height: 26, background: 'var(--bg-elevated)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: (val(r) / max * 100).toFixed(1) + '%', borderRadius: 8,
              background: r.dir === 'Inbound' ? IN : OUT, transition: 'width 0.9s cubic-bezier(0.16,1,0.3,1)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Monthly signed columns (SVG) ──
function MonthCols({ monthly, loading, IN, OUT, axis, grid, isUnits, mfmt }) {
  if (loading) return <Shim h={190} />;
  const m = (monthly || []).map((d) => ({ mon: d.mon, net: isUnits ? d.net_u : d.net }));
  if (!m.length) return <Empty label="No monthly data" small />;
  const fmtV = mfmt || fmtCr;
  const W = 440, H = 200, P = { t: 16, r: 12, b: 26, l: 60 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const vals = m.map((d) => d.net); const max = Math.max(...vals, 0); const min = Math.min(...vals, 0);
  const span = (max - min) || 1;
  const y = (v) => P.t + ih - ((v - min) / span) * ih;
  const zero = y(0); const bw = Math.min(48, iw / m.length * 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      {[max, (max + min) / 2, min].map((gv, i) => (
        <g key={i}>
          <line x1={P.l} x2={W - P.r} y1={y(gv)} y2={y(gv)} stroke={grid} strokeWidth={1} />
          <text x={P.l - 8} y={y(gv) + 4} textAnchor="end" fill={axis} fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtV(gv)}</text>
        </g>
      ))}
      {m.map((d, i) => {
        const cx = P.l + iw * (i + 0.5) / m.length; const pos = d.net >= 0;
        const h = Math.max(Math.abs(y(d.net) - zero), 2);
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={pos ? y(d.net) : zero} width={bw} height={h} rx={5} fill={pos ? IN : OUT}>
              <title>{d.mon}: {(pos ? '+' : '') + fmtV(d.net)}</title>
            </rect>
            <text x={cx} y={H - 8} textAnchor="middle" fill={axis} fontSize={11}>{d.mon}</text>
          </g>
        );
      })}
    </svg>
  );
}
