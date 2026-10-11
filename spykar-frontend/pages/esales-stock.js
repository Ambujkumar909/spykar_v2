// ─── /esales-stock — ESales partner stock (month-end partner stock files) ────
// Stock on hand at the e-commerce partners (Flipkart, Myntra, Reliance, …),
// read from the "E-Sales <month>.xlsx" workbooks. Same shell and visual
// language as /primary-sales, with the Network page's channel / partner /
// colour / size / stock-health blocks. The feed is SNAPSHOTS, not movements —
// one stock file per month — so there is no Today / WTD / MTD here: the page
// is driven by an AS-ON date (one of the stock-file dates, latest by default)
// and a compare period (1M / 3M / 6M / 1Y / FY / LFY / All) that sets the opening
// snapshot and how far back the trends go. Units come from the files;
// value = units × MRP.

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import Pagination from '../components/ui/Pagination';
import { useTheme } from '../lib/useTheme';
import { useFilters } from '../lib/useFilters';
import { FiltersProvider } from '../lib/FiltersContext';
import { esalesStockService } from '../lib/services';
import { notifyApiError } from '../lib/notifyApiError';
import { formatFull, kpiFit } from '../lib/v2/format';
import LoadError from '../components/ui/LoadError';
import {
  Store, Package, IndianRupee, TrendingUp, ArrowLeftRight, Tag, Palette, Ruler, Shirt,
  Download, Activity, Layers, ArrowDownRight, ArrowUpRight, Gauge, Sparkles, Users, ShoppingBag,
  CalendarRange, BarChart2, PieChart, ShieldAlert, XCircle, PackageMinus, AlertCircle, ScanBarcode, Search, Hourglass,
} from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const VIEW_BY = [
  { key: 'partner',     label: 'Partner',     Icon: Store },
  { key: 'channel',     label: 'Channel',     Icon: ShoppingBag },
  { key: 'category',    label: 'Category',    Icon: Tag },
  { key: 'gender',      label: 'Gender',      Icon: Users },
  { key: 'product',     label: 'Product',     Icon: Shirt },
  { key: 'sub_product', label: 'Sub-product', Icon: Layers },
  { key: 'colour',      label: 'Colour',      Icon: Palette },
  { key: 'size',        label: 'Size',        Icon: Ruler },
  { key: 'season',      label: 'Season',      Icon: CalendarRange },
];
const MEASURE_OPTIONS = [
  { value: 'units', label: 'Units' },
  { value: 'value', label: 'Value (₹ MRP)' },
];
// Sidebar "Lens" dims relevant to ESales stock → display labels (for on-page chips).
const LENS_LABELS = {
  channel: 'Channel', partner_name: 'Partner', gender_name: 'Gender', category: 'Category', product: 'Product', sub_product: 'Sub-product',
  size: 'Size', color: 'Colour', season: 'Season',
};

// Compare periods for a monthly snapshot feed.
const PERIODS = [
  { key: '1m', label: '1M', months: 1 }, { key: '3m', label: '3M', months: 3 }, { key: '6m', label: '6M', months: 6 },
  { key: '12m', label: '1Y', months: 12 }, { key: 'fy', label: 'FY' }, { key: 'lfy', label: 'LFY' }, { key: 'all', label: 'All' },
];
// Date window for an as-on date + period. The closing snapshot is the latest
// one on or before `to`; the opening snapshot the latest one BEFORE `from` —
// so "3M" as on 30 Sep runs 1 Jul → 30 Sep and opens on 30 Jun. LFY is the
// whole previous financial year (Indian FY, 1 Apr – 31 Mar) of the as-on date:
// it closes on that year's 31 March, not on the as-on date.
// KEEP IN STEP with esalesWindows() in spykar-backend/src/services/cacheWarmup.js
// (it pre-warms exactly these windows).
function periodWindow(asOn, key, dataFrom) {
  const y = Number(asOn.slice(0, 4)); const m = Number(asOn.slice(5, 7));
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const fy = m >= 4 ? y : y - 1;                                   // the year this FY started in
  if (key === 'all') return { from: dataFrom || asOn, to: asOn };
  if (key === 'fy') return { from: first(fy, 4), to: asOn };
  if (key === 'lfy') return { from: first(fy - 1, 4), to: `${fy}-03-31` };
  const idx = y * 12 + (m - 1) - PERIODS.find((p) => p.key === key).months + 1;
  return { from: first(Math.floor(idx / 12), (idx % 12) + 1), to: asOn };
}
const SHOW_OPTS = [5, 10, 15, 20, 25, 30, 50, 'All'];
const ITEM_SORTS = [
  { value: 'units', label: 'Units' }, { value: 'value', label: 'Value' },
  { value: 'mrp', label: 'MRP' }, { value: 'partners', label: 'Partners' },
];

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
// KPI figures (hero + KPI strip) are shown in full — never K / L / Cr.
const fullRs = (n) => formatFull(n, { rupee: true });

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

export default function EsalesStockPage() {
  // As-on date ('' = the latest stock file) + compare period. Opens on the
  // latest snapshot vs six months back: six points on every trend.
  const [asOnSel, setAsOnSel] = useState('');
  const [period, setPeriod]   = useState('6m');
  const { isDark } = useTheme();
  // The workbooks hold quantities only, so Units is the native measure;
  // Value prices them at item-master MRP.
  const [measure, setMeasure]   = useState('units');
  const [viewBy, setViewBy]     = useState('partner');
  const [sortBy, setSortBy]     = useState('value');
  // Row-click drill: filter the whole page to one member of the current View-by.
  const [drill, setDrill]       = useState(null); // { dim, value, label } | null

  const [dataRange, setDataRange] = useState(null); // { from, to, snapshots }
  const asOn = asOnSel || dataRange?.to || '';        // '' until the snapshot list arrives → nothing is fetched yet
  const { from: fromISO, to: toISO } = useMemo(
    () => (asOn ? periodWindow(asOn, period, dataRange?.from) : { from: '', to: '' }), [asOn, period, dataRange]);

  // Sidebar "Lens" filters (channel / partner + SKU attributes), shared via
  // FiltersContext so the PremiumFilterBar in the rail drives this page (see
  // its ROUTE_DIMS / ROUTE_GROUPS) — every filter for this tab lives there.
  const filtersApi = useFilters({ defaults: {} });
  const lens = filtersApi.filters;
  const clearLens = filtersApi.clearFilter;
  const activeLensDims = useMemo(
    () => Object.keys(LENS_LABELS).filter((d) => { const v = lens[d]; return Array.isArray(v) ? v.length > 0 : Boolean(v); }),
    [lens]
  );
  const lensScope = useMemo(() => {
    const p = {};
    const put = (k, v) => { if (v && v.length) p[k] = Array.isArray(v) ? v.join(',') : v; };
    put('gender', lens.gender_name); put('category', lens.category); put('product', lens.product);
    put('sub_product', lens.sub_product); put('size', lens.size); put('color', lens.color); put('season', lens.season);
    put('channel', lens.channel);
    const names = [].concat(lens.partner_name || []);
    if (names.length) p.partner_name = names.join('|');   // names may hold a comma
    return p;
  }, [lens]);
  const lensKey = useMemo(() => JSON.stringify(lensScope), [lensScope]);

  const isUnits = measure === 'units';
  const mfmt = useCallback((n) => (isUnits ? fmtNum(n) : fmtCr(n)), [isUnits]);
  const mval = useCallback((r) => (isUnits ? r.u : r.g), [isUnits]);

  const scope = useMemo(() => {
    const p = { ...lensScope };
    if (drill) p[drill.dim] = drill.value; // drill filters the whole page to one member
    return p;
  }, [drill, lensKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);

  const changeViewBy = useCallback((k) => { setViewBy(k); setDrill(null); }, []);
  // A drill is applied LAST in `scope`, so any Lens change clears it.
  useEffect(() => { setDrill(null); }, [lensKey]);
  const onRowDrill = useCallback((r) => {
    setDrill((d) => (d && d.value === r.key ? null : { dim: viewBy, value: r.key, label: r.label }));
  }, [viewBy]);

  const [ov, setOv] = useState(null);
  const [ovLoading, setOvLoading] = useState(true);
  const [skuCount, setSkuCount] = useState(null);
  const [skuLoading, setSkuLoading] = useState(true);
  const [pivot, setPivot] = useState(null);
  const [pivotLoading, setPivotLoading] = useState(true);
  const [trend, setTrend] = useState(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [dist, setDist] = useState({ colour: null, size: null });
  const [distLoading, setDistLoading] = useState(true);
  const [showColor, setShowColor] = useState(10);
  const [showSize, setShowSize] = useState(10);
  const [items, setItems] = useState(null);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemSearch, setItemSearch] = useState('');
  const [itemQuery, setItemQuery] = useState('');     // debounced search
  const [itemSort, setItemSort] = useState('units');
  const [itemPage, setItemPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  // SKU detail panel (opened from a row of the SKU table)
  const [detailCode, setDetailCode] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailState, setDetailState] = useState('idle');   // idle | loading | ready | failed

  // available data range (once)
  useEffect(() => {
    let a = true;
    // No stock files at all (or the list failed) → nothing will be fetched, so stop the skeletons here.
    const idle = () => { setOvLoading(false); setSkuLoading(false); setPivotLoading(false); setTrendLoading(false); setDistLoading(false); setItemsLoading(false); };
    esalesStockService.getRange()
      .then((r) => { if (!a) return; const d = r.data?.data || { from: null, to: null, snapshots: [] }; setDataRange(d); if (!d.to) idle(); })
      .catch((e) => { if (a) { idle(); setOvFailed(true); notifyApiError(e, 'Failed to load ESales stock'); } });
    return () => { a = false; };
  }, []);

  const [ovFailed, setOvFailed] = useState(false);
  const [pivotFailed, setPivotFailed] = useState(false);
  const [retryN, setRetryN] = useState(0);
  const retry = useCallback(() => setRetryN((n) => n + 1), []);

  // overview
  useEffect(() => {
    if (!toISO) return undefined;
    let a = true; setOvLoading(true);
    esalesStockService.getOverview({ from: fromISO, to: toISO, ...scope })
      .then((r) => { if (a) { setOv(r.data?.data || null); setOvFailed(false); } })
      .catch((e) => { if (a) { setOv(null); setOvFailed(true); notifyApiError(e, 'Failed to load ESales stock'); } })
      .finally(() => { if (a) setOvLoading(false); });
    return () => { a = false; };
  }, [scopeKey, fromISO, toISO, retryN]); // eslint-disable-line react-hooks/exhaustive-deps

  // lazy distinct-SKU KPI
  useEffect(() => {
    if (!toISO) return undefined;
    let a = true; setSkuLoading(true);
    esalesStockService.getSkuCount({ from: fromISO, to: toISO, ...scope })
      .then((r) => { if (a) setSkuCount(r.data?.data?.sku_count ?? null); })
      .catch(() => { if (a) setSkuCount(null); })
      .finally(() => { if (a) setSkuLoading(false); });
    return () => { a = false; };
  }, [scopeKey, fromISO, toISO]); // eslint-disable-line react-hooks/exhaustive-deps

  // detailed pivot
  useEffect(() => {
    if (!toISO) return undefined;
    let a = true; setPivotLoading(true);
    esalesStockService.getPivot({ group_by: viewBy, measure, from: fromISO, to: toISO, ...scope })
      .then((r) => { if (a) { setPivot(r.data?.data || null); setPivotFailed(false); } })
      .catch((e) => { if (a) { setPivot(null); setPivotFailed(true); notifyApiError(e, 'Failed to load breakdown'); } })
      .finally(() => { if (a) setPivotLoading(false); });
    return () => { a = false; };
  }, [scopeKey, viewBy, measure, fromISO, toISO, retryN]); // eslint-disable-line react-hooks/exhaustive-deps

  // explorer trend
  useEffect(() => {
    if (!toISO) return undefined;
    let a = true; setTrendLoading(true);
    esalesStockService.getTrend({ group_by: viewBy, from: fromISO, to: toISO, top: 6, measure, ...scope })
      .then((r) => { if (a) setTrend(r.data?.data || null); })
      .catch(() => { if (a) setTrend(null); })      // never leave another selection's trend on screen
      .finally(() => { if (a) setTrendLoading(false); });
    return () => { a = false; };
  }, [scopeKey, viewBy, measure, fromISO, toISO]); // eslint-disable-line react-hooks/exhaustive-deps

  // colour + size distribution (closing snapshot)
  useEffect(() => {
    if (!toISO) return undefined;
    let a = true; setDistLoading(true);
    const q = { measure, from: fromISO, to: toISO, ...scope };
    Promise.all([esalesStockService.getPivot({ ...q, group_by: 'colour' }), esalesStockService.getPivot({ ...q, group_by: 'size' })])
      .then(([c, s]) => { if (a) setDist({ colour: c.data?.data || null, size: s.data?.data || null }); })
      .catch(() => { if (a) setDist({ colour: null, size: null }); })
      .finally(() => { if (a) setDistLoading(false); });
    return () => { a = false; };
  }, [scopeKey, measure, fromISO, toISO, retryN]); // eslint-disable-line react-hooks/exhaustive-deps

  // SKU table: debounce the search box, reset to page 1 when the slice changes
  useEffect(() => { const t = setTimeout(() => setItemQuery(itemSearch.trim()), 300); return () => clearTimeout(t); }, [itemSearch]);
  useEffect(() => { setItemPage(1); }, [scopeKey, fromISO, toISO, itemQuery, itemSort]);
  useEffect(() => {
    if (!toISO) return undefined;
    let a = true; setItemsLoading(true);
    esalesStockService.getItems({ from: fromISO, to: toISO, ...scope, page: itemPage, limit: 25, sort: itemSort, ...(itemQuery ? { search: itemQuery } : {}) })
      .then((r) => { if (a) setItems(r.data?.data || null); })
      .catch(() => { if (a) setItems(null); })
      .finally(() => { if (a) setItemsLoading(false); });
    return () => { a = false; };
  }, [scopeKey, fromISO, toISO, itemPage, itemQuery, itemSort, retryN]); // eslint-disable-line react-hooks/exhaustive-deps

  // SKU detail: whole-partner view of one barcode for the current as-on window
  useEffect(() => {
    if (detailCode == null || !toISO) return undefined;
    let a = true; setDetailState('loading');
    esalesStockService.getItem({ barcode: detailCode, from: fromISO, to: toISO })
      .then((r) => { if (a) { setDetail(r.data?.data || null); setDetailState('ready'); } })
      .catch(() => { if (a) { setDetail(null); setDetailState('failed'); } });
    return () => { a = false; };
  }, [detailCode, fromISO, toISO, retryN]);
  const closeDetail = useCallback(() => { setDetailCode(null); setDetail(null); setDetailState('idle'); }, []);
  useEffect(() => {
    if (detailCode == null) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeDetail(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailCode, closeDetail]);

  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const res = await esalesStockService.exportCsv({ group_by: viewBy, from: fromISO, to: toISO, measure, ...scope });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `esales-stock-${viewBy}-${ov?.stock?.as_of || toISO}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
    } catch (e) { notifyApiError(e, 'Export failed'); } finally { setExporting(false); }
  }, [viewBy, fromISO, toISO, measure, scope, ov]);

  const k = ov?.kpis;
  const st = ov?.stock; // closing / opening snapshot positions
  const hl = ov?.health;
  const fmtDay = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
  const fmtSnap = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '');
  const asOf = fmtDay(st?.as_of);
  const openingOf = fmtDay(st?.opening_as_of);
  const hasOpening = Boolean(st?.opening_as_of);
  const moved = st && st.opening_as_of !== st.as_of;      // a newer snapshot than the opening exists
  const asOfCap = asOf ? `as of ${asOf}` : '';
  const signed = (n, f) => (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n));
  const changePct = isUnits ? k?.change_pct_units : k?.change_pct_value;
  const pctTxt = (n) => (n == null ? '—' : `${n}%`);
  const yoy = st?.yoy;
  const yoyPct = isUnits ? yoy?.pct_units : yoy?.pct_value;
  const top1 = isUnits ? k?.top_partner_pct_units : k?.top_partner_pct_value;
  const top3 = isUnits ? k?.top3_partner_pct_units : k?.top3_partner_pct_value;
  const aged = isUnits ? k?.aged_pct_units : k?.aged_pct_value;
  const depth = skuCount ? ((k?.units || 0) - (st?.unmatched_units || 0)) / skuCount : null;
  // The "AI Insight" band: what the snapshot says, in the order a CEO asks.
  const insights = !k ? [] : [
    k.top_partner && top1 != null && { n: `${top1}%`, t: `of stock sits with ${k.top_partner}`, s: top3 != null ? `top 3 partners hold ${top3}%` : '', c: '#2563EB' },
    aged != null && { n: `${aged}%`, t: 'is from seasons two or more years old', s: 'by the season on the item master', c: aged >= 30 ? '#DC2626' : '#D97706' },
    k.thin_pct != null && { n: `${k.thin_pct}%`, t: 'of partner listings are down to 0–2 units', s: `${fmtNum(hl?.zero)} out of stock · ${fmtNum(hl?.low)} low`, c: '#D97706' },
    k.pareto_skus > 0 && { n: fmtNum(k.pareto_half_skus), t: `SKUs carry half of all units`, s: `out of ${fmtNum(k.pareto_skus)} in stock (${(k.pareto_half_skus / k.pareto_skus * 100).toFixed(1)}%)`, c: '#7C3AED' },
    yoy && yoyPct != null
      ? { n: `${yoyPct > 0 ? '+' : ''}${yoyPct}%`, t: `vs the same month last year`, s: `${fmtDay(yoy.as_of)}: ${isUnits ? fmtNum(yoy.units) + ' units' : fmtCr(yoy.value)}`, c: yoyPct >= 0 ? '#059669' : '#DC2626' }
      : (moved && changePct != null && { n: `${changePct > 0 ? '+' : ''}${changePct}%`, t: `vs opening on ${openingOf}`, s: 'no stock file for the same month last year', c: changePct >= 0 ? '#059669' : '#DC2626' }),
  ].filter(Boolean);

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
  const ink = isDark ? '#F1F5F9' : '#0F172A';

  // ── stock per snapshot (area) ──
  const dailyOpts = useMemo(() => ({
    chart: { type: 'area', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: true, speed: 600, dynamicAnimation: { enabled: false } }, background: 'transparent' },
    colors: [SEQ], stroke: { width: 2, curve: 'smooth', lineCap: 'round' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.28, opacityTo: 0, stops: [0, 100] } },
    dataLabels: { enabled: false }, markers: { size: (ov?.daily?.length || 0) <= 12 ? 4 : 0, hover: { size: 6 } },
    grid: { borderColor: grid, strokeDashArray: 0, padding: { left: 8, right: 12 } },
    xaxis: { type: 'category', categories: (ov?.daily || []).map((d) => d.d), tickAmount: 8,
      labels: { style: { colors: axis, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true, formatter: (v) => fmtSnap(v) },
      axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { colors: axis, fontSize: '11px' }, formatter: (v) => (isUnits ? cnt(v) : fmtCr(v)) } },
    tooltip: { theme: isDark ? 'dark' : 'light', x: { formatter: (_, o) => fmtDay((ov?.daily || [])[o?.dataPointIndex]?.d) || '' }, y: { formatter: (v) => (isUnits ? fmtNum(v) : fmtCr(v)), title: { formatter: () => 'Stock on hand' } } },
  }), [ov, isDark, isUnits]); // eslint-disable-line react-hooks/exhaustive-deps
  const dailySeries = useMemo(() => [{ name: 'Stock on hand', data: (ov?.daily || []).map((d) => (isUnits ? d.u : d.g)) }], [ov, isUnits]);

  // ── explorer trend (multi-line) ──
  const trendOpts = useMemo(() => ({
    chart: { type: 'line', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent', animations: { enabled: true, dynamicAnimation: { enabled: false } } },
    colors: drill ? [DENIM] : SERIES, stroke: { width: drill ? 3 : 2.5, curve: 'smooth' },
    markers: { size: (trend?.dates?.length || 0) <= 12 ? 4 : 0, hover: { size: 6 } }, dataLabels: { enabled: false },
    legend: { show: !drill, position: 'bottom', fontSize: '12px', labels: { colors: axis }, markers: { width: 10, height: 3, radius: 2 } },
    grid: { borderColor: grid, padding: { left: 6, right: 12 } },
    xaxis: { type: 'category', categories: trend?.dates || [], labels: { style: { colors: axis, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true, formatter: (v) => fmtSnap(v) }, axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { colors: axis, fontSize: '11px' }, formatter: (v) => (isUnits ? cnt(v) : fmtCr(v)) } },
    tooltip: { theme: isDark ? 'dark' : 'light', y: { formatter: (v) => (isUnits ? fmtNum(v) : fmtCr(v)) } },
  }), [trend, isUnits, isDark, drill]); // eslint-disable-line react-hooks/exhaustive-deps
  const trendSeries = useMemo(() => (trend?.series || []).map((s) => ({ name: s.label, data: s.points.map((p) => p.value) })), [trend]);

  // ── SKU detail: units on hand on every stock date ──
  const histOpts = useMemo(() => ({
    chart: { type: 'area', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, sparkline: { enabled: false }, background: 'transparent', animations: { enabled: true, speed: 400, dynamicAnimation: { enabled: false } } },
    colors: [DENIM], stroke: { width: 2, curve: 'straight' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.30, opacityTo: 0, stops: [0, 100] } },
    dataLabels: { enabled: false }, markers: { size: 0, hover: { size: 5 } },
    grid: { borderColor: grid, padding: { left: 4, right: 8, top: -10 } },
    xaxis: { type: 'category', categories: (detail?.history || []).map((h) => h.d), tickAmount: 6,
      labels: { style: { colors: axis, fontSize: '10px' }, rotate: 0, hideOverlappingLabels: true, formatter: (v) => (v ? new Date(v + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : '') },
      axisBorder: { show: false }, axisTicks: { show: false }, tooltip: { enabled: false } },
    yaxis: { labels: { style: { colors: axis, fontSize: '10px' }, formatter: (v) => cnt(v) } },
    tooltip: { theme: isDark ? 'dark' : 'light', x: { formatter: (_, o) => fmtDay((detail?.history || [])[o?.dataPointIndex]?.d) || '' }, y: { formatter: (v) => `${fmtNum(v)} units`, title: { formatter: () => '' } } },
  }), [detail, isDark]); // eslint-disable-line react-hooks/exhaustive-deps
  const histSeries = useMemo(() => [{ name: 'Units', data: (detail?.history || []).map((h) => h.u) }], [detail]);

  // ── network-style bar charts: one builder for horizontal + vertical ──
  const barOpts = useCallback((names, { horizontal, color, to, tip }) => ({
    chart: { type: 'bar', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent',
      // first draw animates; a data change redraws without the path morph (the one apexcharts path that threw in render tests)
      animations: { enabled: true, speed: 600, dynamicAnimation: { enabled: false } } },
    plotOptions: { bar: horizontal ? { horizontal: true, borderRadius: 4, barHeight: '64%' } : { borderRadius: 5, columnWidth: '58%' } },
    colors: [color],
    fill: { type: 'gradient', gradient: { shade: 'light', type: horizontal ? 'horizontal' : 'vertical', gradientToColors: [to], opacityFrom: 1, opacityTo: 0.82 } },
    dataLabels: { enabled: true, formatter: (v) => (isUnits ? cnt(v) : fmtCr(v)), offsetY: horizontal ? 0 : -6,
      style: { fontSize: '10px', fontWeight: 800, colors: [horizontal ? '#fff' : ink] }, dropShadow: { enabled: false } },
    grid: { borderColor: grid, strokeDashArray: 4, xaxis: { lines: { show: horizontal } }, yaxis: { lines: { show: !horizontal } } },
    xaxis: { categories: names,
      labels: horizontal
        ? { style: { colors: axis, fontWeight: 700, fontSize: '11px' }, formatter: (v) => (isUnits ? cnt(v) : fmtCr(v)) }
        : { style: { colors: axis, fontWeight: 700, fontSize: '10px' }, rotate: -38, trim: true, maxHeight: 90 },
      axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: horizontal
      ? { style: { colors: ink, fontWeight: 800, fontSize: '11px' }, maxWidth: 150 }
      : { style: { colors: axis, fontWeight: 700 }, formatter: (v) => (isUnits ? cnt(v) : fmtCr(v)) } },
    tooltip: { theme: isDark ? 'dark' : 'light', y: { formatter: tip || ((v) => (isUnits ? `${fmtNum(v)} units` : fmtCr(v))), title: { formatter: () => '' } } },
    legend: { show: false },
  }), [isUnits, isDark]); // eslint-disable-line react-hooks/exhaustive-deps

  const byMeasure = useCallback((rows) => [...(rows || [])].sort((a, b) => mval(b) - mval(a)), [mval]);
  const chanRows = useMemo(() => byMeasure(ov?.channels), [ov, byMeasure]);
  const chanTotal = chanRows.reduce((a, r) => a + mval(r), 0);
  const partnerRows = useMemo(() => byMeasure(ov?.top_partners).filter((r) => mval(r) > 0), [ov, byMeasure]);
  const short = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const chanChart = useMemo(() => {
    const rows = chanRows.filter((r) => mval(r) > 0).slice(0, 10);
    return { options: barOpts(rows.map((r) => r.name), { horizontal: true, color: '#2563EB', to: '#6366F1' }), series: [{ name: 'Stock', data: rows.map(mval) }], n: rows.length };
  }, [chanRows, barOpts, mval]);
  const partnerChart = useMemo(() => {
    const rows = partnerRows.slice(0, 10);
    return { options: barOpts(rows.map((r) => short(r.name, 16)), { horizontal: false, color: '#059669', to: '#34D399',
      tip: (v, { dataPointIndex }) => `${rows[dataPointIndex]?.name || ''}: ${isUnits ? `${fmtNum(v)} units` : fmtCr(v)}` }),
      series: [{ name: 'Stock', data: rows.map(mval) }], n: rows.length };
  }, [partnerRows, barOpts, mval, isUnits]);

  // colour / size distribution
  const distChart = useCallback((pv, show, color, to) => {
    const all = (pv?.rows || []).map((r) => ({ name: r.label, v: isUnits ? r.qty : r.value })).filter((r) => r.v > 0);
    const total = all.reduce((a, r) => a + r.v, 0);
    const rows = show === 'All' ? all : all.slice(0, Number(show));
    return { count: all.length, n: rows.length, height: Math.max(180, rows.length * 32 + 40),
      options: barOpts(rows.map((r) => r.name), { horizontal: true, color, to,
        tip: (v, { dataPointIndex }) => `${rows[dataPointIndex]?.name || ''}: ${isUnits ? `${fmtNum(v)} units` : fmtCr(v)} (${total ? (v / total * 100).toFixed(1) : 0}%)` }),
      series: [{ name: 'Stock', data: rows.map((r) => r.v) }] };
  }, [barOpts, isUnits]);
  const colorChart = useMemo(() => distChart(dist.colour, showColor, '#7C3AED', '#C4B5FD'), [dist, showColor, distChart]);
  const sizeChart = useMemo(() => distChart(dist.size, showSize, '#DC2626', '#F87171'), [dist, showSize, distChart]);

  // ── detailed pivot rows (sorted) ──
  const ROW_CAP = 5000;
  const pivotRows = useMemo(() => {
    const rows = [...(pivot?.rows || [])];
    const val = (r) => (isUnits ? Math.abs(r.qty) : Math.abs(r.value));
    const cmp = { value: (a, b) => val(b) - val(a), lines: (a, b) => b.lines - a.lines,
      delta: (a, b) => (b.delta_qty_vs_prev_pct ?? -1e9) - (a.delta_qty_vs_prev_pct ?? -1e9) }[sortBy] || (() => 0);
    return rows.sort(cmp).slice(0, ROW_CAP);
  }, [pivot, isUnits, sortBy]);
  const dimLabel = VIEW_BY.find((v) => v.key === viewBy)?.label || viewBy;

  const catRows = byMeasure(ov?.top_cat).map((c) => ({ name: c.name, v: mval(c) }));
  const genderRows = byMeasure(ov?.top_gender).map((c) => ({ name: c.name, v: mval(c) }));
  const seasonRows = byMeasure(ov?.top_season).map((c) => ({ name: c.name, v: mval(c) }));

  const asOnOpts = useMemo(() => [...(dataRange?.snapshots || [])].reverse().map((d) => ({ value: d, label: fmtDay(d) })), [dataRange]); // eslint-disable-line react-hooks/exhaustive-deps

  const headerSlot = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <PeriodPills value={period} onChange={setPeriod} />
    </div>
  );

  const capsuleSty = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' };
  const capLblSty = { fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-muted)' };
  const chipSty = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 30, maxWidth: 300, padding: '0 4px 0 12px', borderRadius: 999, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', fontSize: 12, color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' };
  const showSelSty = { height: 30, padding: '0 8px', borderRadius: 9, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 11, fontWeight: 700, cursor: 'pointer', outline: 'none' };
  const pageToolbar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <HeaderField label="As on" value={asOn} onChange={setAsOnSel} options={asOnOpts} minWidth={112}
          title="Stock-file date — the stock on hand as on this day" />
        <HeaderField label="Measure" value={measure} onChange={setMeasure} options={MEASURE_OPTIONS} minWidth={104} />
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

  const noFiles = Boolean(dataRange) && !dataRange.to;
  const emptyAll = !ovLoading && (ov?.empty || noFiles);
  // Stale-while-revalidate, like the Network page: skeletons only on the cold
  // load. A filter / pill / as-on change keeps the current numbers and charts
  // on screen (dimmed) until the new ones arrive — no flash, and the charts
  // update in place instead of being torn down and rebuilt.
  const ovCold = ovLoading && !ov;
  const refreshing = ovLoading && Boolean(ov);
  const noSnapInWindow = !ovLoading && ov && !ov.empty && !ov.daily?.length;
  const itemPages = items ? Math.max(1, Math.ceil(items.total / items.limit)) : 1;
  const healthCards = [
    { title: 'Out of stock', sub: 'Listed at a partner with zero units', n: hl?.zero, Icon: XCircle, fg: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
    { title: 'Low stock', sub: '1–2 units left at a partner', n: hl?.low, Icon: PackageMinus, fg: '#D97706', bg: 'rgba(217,119,6,0.10)' },
    { title: 'Negative stock', sub: hl?.negative ? `${fmtNum(hl.negative_units)} units below zero in the files` : 'Below zero in the partner files', n: hl?.negative, Icon: AlertCircle, fg: '#2563EB', bg: 'rgba(37,99,235,0.10)' },
  ];

  return (
    <FiltersProvider value={filtersApi}>
    <DashboardLayout title="ESales Stock"
      subtitle="Stock on hand at e-commerce partners — month-end partner stock files by snapshot date"
      headerSlot={headerSlot} hideSync={true}>
      <div className={`ps-root${refreshing ? ' is-refreshing' : ''}`}>
        {pageToolbar}
        {/* ── HERO ── */}
        <div className="ps-hero">
          <div className="ps-hero-glow" />
          <div className="ps-hero-inner kpi-fit-box">
            <div className="ps-eyebrow" title="Units from the partner stock files; value = units × MRP from the item master">
              <Sparkles size={12} /> {isUnits ? 'Closing stock' : 'Closing stock at MRP'}{asOf ? ` · as of ${asOf}` : ''}
            </div>
            {ovCold ? <Shim h={64} w="60%" /> : (
              <div className="ps-hero-num tnum kpi-fit" style={kpiFit(`${formatFull(isUnits ? st?.closing_units : st?.closing_value)}${isUnits ? ' un' : ''}`, 74)}>
                {!isUnits && <span className="cur">₹</span>}{formatFull(isUnits ? st?.closing_units : st?.closing_value)}
                {isUnits && <span className="ps-hero-suffix">units</span>}
              </div>
            )}
            <div className="ps-hero-sub">
              {isUnits
                ? <span><b className="tnum">{fullRs(st?.closing_value)}</b> at MRP</span>
                : <span><b className="tnum">{formatFull(st?.closing_units || 0)}</b> units</span>}
              {st && hasOpening && (
                <span title="Opening + change = closing">
                  Opening {openingOf} <b className="tnum">{isUnits ? formatFull(st.opening_units) : fullRs(st.opening_value)}</b>
                  {' · '}Change <b className="tnum" style={{ color: (isUnits ? st.change_units : st.change_value) >= 0 ? '#0a7f4f' : OUT }}>
                    {isUnits ? signed(st.change_units, formatFull) : signed(st.change_value, fullRs)}</b>
                  {moved && changePct != null && (
                    <span className={`ps-delta sm ${changePct >= 0 ? 'up' : 'down'}`}>
                      {changePct >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                      {Math.abs(changePct)}%
                    </span>
                  )}
                </span>
              )}
              {yoy && (
                <span title="Closing stock vs the stock file for the same month one year earlier">
                  Last year ({fmtDay(yoy.as_of)}) <b className="tnum">{isUnits ? formatFull(yoy.units) : fullRs(yoy.value)}</b>
                  {yoyPct != null && (
                    <span className={`ps-delta sm ${yoyPct >= 0 ? 'up' : 'down'}`}>
                      {yoyPct >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                      {Math.abs(yoyPct)}%
                    </span>
                  )}
                </span>
              )}
              {st?.unmatched_units !== 0 && st?.unmatched_units != null && (
                <span title="Barcodes in the partner files that the item master does not know — counted in units, no MRP">
                  incl. unmatched barcodes <b className="tnum">{formatFull(st.unmatched_units)}</b> units
                </span>
              )}
              {k?.snapshot_count > 0 && (
                <span title={`${ov?.from || fromISO} → ${ov?.to || toISO}`}>
                  <b className="tnum">{isUnits ? formatFull(st?.avg_units) : fullRs(st?.avg_value)}</b> average over the period ({k.snapshot_count} stock date{k.snapshot_count > 1 ? 's' : ''})
                </span>
              )}
              {noSnapInWindow && <span>No new snapshot in this period — stock carried forward</span>}
            </div>
          </div>
        </div>

        {ovFailed && !ovLoading ? <Card style={{ marginTop: 16 }}><LoadError label="Couldn't load ESales stock for this selection" onRetry={retry} minHeight={220} /></Card>
          : emptyAll ? <Card style={{ marginTop: 16 }}><Empty label={noFiles ? 'No ESales stock files loaded yet' : 'No ESales stock snapshot on or before this date'} /></Card> : (
        <>
        {/* ── AI Insight band (figures computed from the closing snapshot) ── */}
        {(ovCold || insights.length > 0) && (
          <div className="ps-insights">
            <div className="ps-insights-head"><Sparkles size={13} /> AI Insight{asOf ? ` · as of ${asOf}` : ''}</div>
            <div className="ps-insights-grid">
              {ovCold ? Array.from({ length: 5 }).map((_, i) => <Shim key={i} h={58} />)
                : insights.map((x, i) => (
                  <div key={i} className="ps-insight" style={{ borderLeftColor: x.c }}>
                    <div className="ps-insight-n tnum" style={{ color: x.c }}>{x.n}</div>
                    <div className="ps-insight-t">{x.t}</div>
                    {x.s && <div className="ps-insight-s">{x.s}</div>}
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* ── KPI strip ── */}
        <div className="ps-kpis">
          {[
            { lab: 'Stock change', val: st && hasOpening ? (isUnits ? signed(st.change_units, formatFull) : signed(st.change_value, fullRs)) : '—',
              foot: hasOpening ? `vs ${fmtSnap(st?.opening_as_of)}${moved && changePct != null ? ` · ${changePct > 0 ? '+' : ''}${changePct}%` : ''}` : 'no earlier stock file', Icon: TrendingUp, c: SERIES[1] },
            { lab: 'Top partner share', val: pctTxt(top1), foot: k?.top_partner ? `${short(k.top_partner, 24)} · top 3: ${pctTxt(top3)}` : 'no stock', Icon: Store, c: SERIES[0] },
            { lab: 'Aged stock', val: pctTxt(aged), foot: 'from seasons 2+ years old', Icon: Hourglass, c: SERIES[5] },
            { lab: 'SKUs in stock', val: skuLoading ? '…' : formatFull(skuCount || 0), foot: depth != null ? `${depth.toFixed(1)} units per SKU` : 'matched to the item master', Icon: Package, c: SERIES[4] },
            { lab: 'Low / out of stock', val: pctTxt(k?.thin_pct), foot: 'partner listings with 0–2 units', Icon: PackageMinus, c: SERIES[2] },
            { lab: 'Avg MRP / unit', val: k?.avg_mrp == null ? '—' : fullRs(k.avg_mrp), foot: `${fmtNum(k?.partner_count)} partners · ${fmtNum(k?.channel_count)} channels`, Icon: IndianRupee, c: SERIES[7] },
          ].map((t, i) => (
            <div key={i} className="ps-kpi kpi-fit-box">
              <div className="ps-kpi-bar" style={{ background: t.c }} />
              <div className="ps-kpi-head"><span className="ps-kpi-ic" style={{ background: t.c + '1c', color: t.c }}><t.Icon size={13} strokeWidth={2.2} /></span>
                <span className="ps-kpi-lab">{t.lab}</span></div>
              {ovCold ? <Shim h={26} w="70%" /> : <div className="ps-kpi-val tnum kpi-fit" style={kpiFit(t.val, 25)}>{t.val}</div>}
              <div className="ps-kpi-foot">{t.foot}</div>
            </div>
          ))}
        </div>

        {/* Basis note — between KPIs and the trend */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '12px 2px 0' }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
            title="Units are read from the partner stock files as written. Value = units × MRP from the item master (the files carry no prices).">
            Units from the partner files · Value = units × MRP
          </span>
        </div>

        {/* ── Stock per snapshot ── */}
        <Card style={{ marginTop: 8 }}>
          <SecTitle icon={Activity} label="Stock by snapshot" cap={`${isUnits ? 'Units' : 'Value at MRP'} on hand on each stock-file date in the period`}
            right={<span className="ps-unit">{isUnits ? 'units' : '₹ at MRP'}</span>} />
          {ovCold ? <Shim h={300} /> : ov?.daily?.length
            ? <Chart options={dailyOpts} series={dailySeries} type="area" height={300} />
            : <Empty label={`No stock file dated inside this period — latest is ${asOf || '—'}`} small />}
        </Card>

        {/* ── Flow + Monthly ── */}
        <div className="ps-two">
          <Card>
            <SecTitle icon={ArrowLeftRight} label="Stock added vs drawn down"
              cap={moved ? `Partner × barcode positions that grew or shrank · ${fmtSnap(st?.opening_as_of) || 'start'} → ${fmtSnap(st?.as_of)}` : 'Positions that grew or shrank between opening and closing'} />
            <FlowBars flow={ov?.flow} loading={ovCold} IN={IN} OUT={OUT} isUnits={isUnits} mfmt={mfmt} />
          </Card>
          <Card>
            <SecTitle icon={TrendingUp} label={isUnits ? 'Net units by snapshot' : 'Net value by snapshot'} cap={`Signed — stock ${isUnits ? 'units' : 'value'} added (+) or drawn down (−) vs the snapshot before`} right={<span className="ps-unit">{isUnits ? 'units net' : '₹ net'}</span>} />
            <MonthCols monthly={ov?.monthly} loading={ovCold} IN={IN} OUT={OUT} axis={axis} grid={grid} isUnits={isUnits} mfmt={mfmt} />
          </Card>
        </div>

        {/* ── Channel + partner charts (Network-style) ── */}
        <div className="ps-two">
          <Card>
            <SecTitle icon={BarChart2} label="Stock by channel" cap={`Marketplace groups · ${isUnits ? 'units' : 'value at MRP'} ${asOfCap}`} />
            {ovCold ? <Shim h={280} /> : chanChart.n
              ? <Chart options={chanChart.options} series={chanChart.series} type="bar" height={280} />
              : <Empty label="No channel data" small />}
          </Card>
          <Card>
            <SecTitle icon={Store} label="Top partners — by stock" cap={`Where ESales stock sits · ${isUnits ? 'units' : 'value at MRP'} ${asOfCap}`} right={<span className="ps-unit">Top 10</span>} />
            {ovCold ? <Shim h={280} /> : partnerChart.n
              ? <Chart options={partnerChart.options} series={partnerChart.series} type="bar" height={280} />
              : <Empty label="No partner data" small />}
          </Card>
        </div>

        {/* ── Channel breakdown table ── */}
        <Card style={{ marginTop: 16, overflow: 'hidden', padding: 0 }}>
          <div className="ps-tbl-head">
            <PieChart size={13} />
            <span className="ps-unit" style={{ color: DENIM }}>Channel breakdown</span>
            {!ovLoading && chanRows.length > 0 && <span className="ps-count">{chanRows.length}</span>}
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>Sorted by highest stock{asOf ? ` · as of ${asOf}` : ''}</span>
          </div>
          <div className="ps-tbl-wrap">
            <table className="ps-tbl">
              <thead><tr>
                <th className="l">#</th><th className="l">Channel</th><th>Partners</th><th className="l">Distribution</th><th>SKUs</th><th>Lines</th>
                <th>Units</th><th>Value (₹ MRP)</th><th>Share %</th><th>Δ units vs opening</th>
              </tr></thead>
              <tbody>
                {ovCold ? Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={10}><Shim /></td></tr>)
                  : chanRows.length ? chanRows.map((r, i) => {
                    const share = chanTotal > 0 ? mval(r) / chanTotal * 100 : 0;
                    return (
                      <tr key={r.name}>
                        <td className="l">{i + 1}</td>
                        <td className="l strong">{r.name}</td>
                        <td className="tnum">{fmtNum(r.partners)}</td>
                        <td className="l" style={{ width: 150 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }} title={`${share.toFixed(1)}% of total stock`}>
                            <div style={{ flex: 1, background: 'var(--border-default)', borderRadius: 100, height: 6, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.max(1, Math.min(100, share))}%`, height: '100%', background: 'linear-gradient(90deg,#2563EB,#6366F1)', borderRadius: 100, transition: 'width 0.6s ease' }} />
                            </div>
                          </div>
                        </td>
                        <td className="tnum">{fmtNum(r.skus)}</td>
                        <td className="tnum">{fmtNum(r.lines)}</td>
                        <td className="tnum strong">{fmtNum(r.u)}</td>
                        <td className="tnum">{fmtCr(r.g)}</td>
                        <td className="tnum">{share.toFixed(1)}%</td>
                        <td className={`tnum ${r.change_u == null ? '' : r.change_u >= 0 ? 'pos' : 'neg'}`}>{r.change_u == null ? '—' : signed(r.change_u, fmtNum)}</td>
                      </tr>
                    );
                  }) : <tr><td colSpan={10} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>No channel data</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ── Category · gender · season mix ── */}
        <div className="ps-three">
          <Card>
            <SecTitle icon={Tag} label="Category mix" cap={`${isUnits ? 'Units' : 'Value at MRP'} on hand ${asOfCap}`} />
            <BarList rows={catRows} color={(r, i) => SERIES[i % SERIES.length]} fmt={mfmt} loading={ovCold} cap={8} />
          </Card>
          <Card>
            <SecTitle icon={Users} label="Gender mix" cap={`${isUnits ? 'Units' : 'Value at MRP'} on hand ${asOfCap}`} />
            <BarList rows={genderRows} color={(r, i) => SERIES[(i + 4) % SERIES.length]} fmt={mfmt} loading={ovCold} cap={8} />
          </Card>
          <Card>
            <SecTitle icon={CalendarRange} label="Season mix" cap={`${isUnits ? 'Units' : 'Value at MRP'} on hand ${asOfCap}`} right={<span className="ps-unit">Top 8</span>} />
            <BarList rows={seasonRows} color={SEQ} fmt={mfmt} loading={ovCold} cap={8} />
          </Card>
        </div>

        {/* ── Colour & size distribution (Network-style) ── */}
        <div className="ps-two">
          <Card>
            <SecTitle icon={Palette} label="Stock by colour" cap={`${fmtNum(colorChart.count)} colours in stock ${asOfCap}`}
              right={<select value={showColor} onChange={(e) => setShowColor(e.target.value === 'All' ? 'All' : Number(e.target.value))} style={showSelSty} aria-label="Colours to show">
                {SHOW_OPTS.map((o) => <option key={o} value={o}>Show {o}</option>)}</select>} />
            {distLoading && !dist.colour ? <Shim h={320} /> : colorChart.n
              ? <div style={{ opacity: distLoading ? 0.55 : 1, transition: 'opacity 200ms ease' }}><Chart options={colorChart.options} series={colorChart.series} type="bar" height={colorChart.height} /></div>
              : <Empty label="No colour data" small />}
          </Card>
          <Card>
            <SecTitle icon={Ruler} label="Stock by size" cap={`${fmtNum(sizeChart.count)} sizes in stock ${asOfCap}`}
              right={<select value={showSize} onChange={(e) => setShowSize(e.target.value === 'All' ? 'All' : Number(e.target.value))} style={showSelSty} aria-label="Sizes to show">
                {SHOW_OPTS.map((o) => <option key={o} value={o}>Show {o}</option>)}</select>} />
            {distLoading && !dist.size ? <Shim h={320} /> : sizeChart.n
              ? <div style={{ opacity: distLoading ? 0.55 : 1, transition: 'opacity 200ms ease' }}><Chart options={sizeChart.options} series={sizeChart.series} type="bar" height={sizeChart.height} /></div>
              : <Empty label="No size data" small />}
          </Card>
        </div>

        {/* ── Stock health ── */}
        <Card style={{ marginTop: 16 }}>
          <SecTitle icon={ShieldAlert} label="Stock health — out of stock · low · negative"
            cap={`${fmtNum(hl?.positions)} partner × barcode positions ${asOfCap} · ${fmtNum(hl?.in_stock)} in stock`} />
          <div className="ps-health">
            {healthCards.map((h) => (
              <div key={h.title} className="ps-hcard" style={{ background: h.bg, borderColor: h.fg + '33' }}>
                <span className="ps-hcard-ic" style={{ color: h.fg, background: h.fg + '1f' }}><h.Icon size={16} strokeWidth={2.2} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="ps-hcard-t" style={{ color: h.fg }}>{h.title}</div>
                  {ovCold ? <Shim h={26} w={90} /> : <div className="ps-hcard-n tnum">{fmtNum(h.n)}</div>}
                  <div className="ps-hcard-s">{h.sub}{!ovLoading && hl?.positions ? ` · ${(h.n / hl.positions * 100).toFixed(1)}% of positions` : ''}</div>
                </div>
              </div>
            ))}
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
              cap={drill ? `Drilled to one ${VIEW_BY.find((v) => v.key === drill.dim)?.label.toLowerCase()} · ${isUnits ? 'units' : 'value'} on hand per snapshot`
                         : `Top 6 ${dimLabel.toLowerCase()}s · ${isUnits ? 'units' : 'value'} on hand per snapshot`}
              right={drill ? <button className="ps-drillchip" onClick={() => setDrill(null)}>Clear <span aria-hidden>✕</span></button> : null} />
            {trendLoading && !trend ? <Shim h={300} /> : trendSeries.length && trend?.dates?.length
              ? <Chart options={trendOpts} series={trendSeries} type="line" height={300} />
              : <Empty label="No stock file dated inside this period" small />}
          </Card>

          {/* detailed table */}
          <Card style={{ marginTop: 14, overflow: 'hidden', padding: 0 }}>
            <div className="ps-tbl-head">
              <span className="ps-unit" style={{ color: DENIM }}>By {dimLabel}</span>
              {!pivotLoading && pivot?.rows && <span className="ps-count">{fmtNum(pivot.rows.length)}</span>}
              {asOf && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>as of {asOf}</span>}
              {!pivotLoading && (pivot?.rows?.length || 0) > ROW_CAP && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>top {ROW_CAP} · export for all</span>}
              <div style={{ flex: 1 }} />
              <HeaderField label="Sort" value={sortBy} onChange={setSortBy} minWidth={90}
                options={[{ value: 'value', label: isUnits ? 'Units' : 'Value' }, { value: 'lines', label: 'Lines' }, { value: 'delta', label: 'Δ vs opening' }]} />
              <button className="ps-export" onClick={onExport} disabled={exporting || !pivot?.rows?.length}>
                <Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
            <div className="ps-tbl-wrap">
              <table className="ps-tbl">
                <thead><tr>
                  <th className="l">{dimLabel}</th><th>Units</th><th>Value (₹ MRP)</th><th>SKUs</th><th>Lines</th><th>Avg MRP</th>
                  <th title={moved ? `Units vs the opening snapshot (${openingOf})` : 'Units vs the opening snapshot'}>Δ vs opening</th>
                </tr></thead>
                <tbody>
                  {pivotLoading && !pivot ? Array.from({ length: 12 }).map((_, i) => <tr key={i}><td colSpan={7}><Shim /></td></tr>)
                    : pivotFailed ? <tr><td colSpan={7}><LoadError label="Couldn't load the breakdown" onRetry={retry} /></td></tr>
                    : pivotRows.length ? pivotRows.map((r, i) => (
                      <tr key={r.key || i} className={`clk ${drill && drill.value === r.key ? 'on' : ''}`}
                        onClick={() => onRowDrill(r)}>
                        <td className="l strong">{r.label || '—'}</td>
                        <td className="tnum strong">{fmtNum(r.qty)}</td>
                        <td className="tnum">{fmtCr(r.value)}</td>
                        <td className="tnum">{fmtNum(r.skus)}</td>
                        <td className="tnum">{fmtNum(r.lines)}</td>
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

        {/* ── All SKUs (the full list behind every number above) ── */}
        <Card style={{ marginTop: 22, overflow: 'hidden', padding: 0 }}>
          <div className="ps-tbl-head">
            <ScanBarcode size={13} />
            <span className="ps-unit" style={{ color: DENIM }}>All SKUs in stock files</span>
            {items && <span className="ps-count">{fmtNum(items.total)}</span>}
            {asOf && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>as of {asOf} · click a row for the full SKU picture</span>}
            <div style={{ flex: 1 }} />
            <label style={{ ...capsuleSty, cursor: 'text' }}>
              <Search size={13} style={{ color: 'var(--text-muted)' }} />
              <input type="search" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Barcode, style, product, colour"
                aria-label="Search SKUs" maxLength={60}
                style={{ border: 'none', background: 'transparent', outline: 'none', color: 'var(--text-primary)', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', width: 220 }} />
            </label>
            <HeaderField label="Sort" value={itemSort} onChange={setItemSort} options={ITEM_SORTS} minWidth={80} />
          </div>
          <div className="ps-tbl-wrap" style={{ opacity: itemsLoading && items ? 0.55 : 1, transition: 'opacity 200ms ease' }}>
            <table className="ps-tbl">
              <thead><tr>
                <th className="l">Barcode</th><th className="l">Style</th><th className="l">Product</th><th className="l">Category</th><th className="l">Gender</th>
                <th className="l">Colour</th><th className="l">Size</th><th className="l">Season</th><th>MRP</th><th>Units</th><th>Value (₹ MRP)</th><th>Partners</th>
              </tr></thead>
              <tbody>
                {itemsLoading && !items ? Array.from({ length: 10 }).map((_, i) => <tr key={i}><td colSpan={12}><Shim /></td></tr>)
                  : items?.rows?.length ? items.rows.map((r) => (
                    <tr key={r.barcode} className={`clk ${detailCode === r.barcode ? 'on' : ''}`} tabIndex={0} title="Open SKU detail"
                      onClick={() => setDetailCode(r.barcode)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailCode(r.barcode); } }}>
                      <td className="l strong tnum">{r.barcode || '(blank)'}</td>
                      <td className="l">{r.matched ? r.style || '—' : <span className="ps-tag neutral">Unmatched barcode</span>}</td>
                      <td className="l">{r.product || '—'}</td>
                      <td className="l">{r.category || '—'}</td>
                      <td className="l">{r.gender || '—'}</td>
                      <td className="l">{r.colour || '—'}</td>
                      <td className="l">{r.size || '—'}</td>
                      <td className="l">{r.season || '—'}</td>
                      <td className="tnum">{r.mrp == null ? '—' : fmtNum(r.mrp)}</td>
                      <td className="tnum strong">{fmtNum(r.units)}</td>
                      <td className="tnum">{r.matched ? fmtCr(r.value) : '—'}</td>
                      <td className="tnum">{fmtNum(r.partners)}</td>
                    </tr>)) : <tr><td colSpan={12} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>{itemQuery ? `No SKU matches “${itemQuery}”` : 'No SKUs for this selection'}</td></tr>}
              </tbody>
            </table>
          </div>
          {items && itemPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '12px 18px', borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
                {fmtNum((items.page - 1) * items.limit + 1)}–{fmtNum(Math.min(items.page * items.limit, items.total))} of {fmtNum(items.total)}
              </span>
              <Pagination page={itemPage} totalPages={itemPages} onPageChange={(p) => setItemPage(Math.min(Math.max(1, p), itemPages))} />
            </div>
          )}
        </Card>
        </>)}
      </div>

      {/* ── SKU detail panel ── */}
      {detailCode != null && (
        <>
          <div className="ps-dw-overlay" onClick={closeDetail} aria-hidden />
          <aside className="ps-dw" role="dialog" aria-modal="true" aria-label="SKU detail">
            <div className="ps-dw-head">
              <div style={{ minWidth: 0 }}>
                <div className="ps-eyebrow" style={{ marginBottom: 6 }}><ScanBarcode size={12} /> SKU detail{detail?.as_of ? ` · as of ${fmtDay(detail.as_of)}` : ''}</div>
                <div className="ps-dw-title">{detailState === 'ready' && detail ? (detail.item.matched ? detail.item.style || detail.item.product || detail.item.barcode : 'Unmatched barcode') : detailCode || '(blank)'}</div>
                {detailState === 'ready' && detail?.item.matched && (
                  <div className="ps-dw-sub">{[detail.item.product, detail.item.colour, detail.item.size && `Size ${detail.item.size}`].filter(Boolean).join(' · ')}</div>
                )}
              </div>
              <button type="button" className="ps-dw-close" onClick={closeDetail} aria-label="Close SKU detail" autoFocus>✕</button>
            </div>
            <div className="ps-dw-body">
              {detailState === 'loading' && <div style={{ display: 'grid', gap: 14 }}><Shim h={70} /><Shim h={180} /><Shim h={120} /><Shim h={80} /></div>}
              {detailState === 'failed' && <LoadError label="Couldn't load this SKU" onRetry={retry} minHeight={220} />}
              {detailState === 'ready' && detail && (
                <>
                  <div className="ps-dw-chips">
                    <span className="ps-dw-code tnum">{detail.item.barcode || '(blank)'}</span>
                    {detail.item.matched
                      ? [detail.item.category, detail.item.gender, detail.item.season, detail.item.sub_product].filter(Boolean).map((c) => <span key={c} className="ps-tag neutral">{c}</span>)
                      : <span className="ps-tag outbound">Not in the item master — units counted, no MRP or attributes</span>}
                  </div>
                  <div className="ps-dw-kpis">
                    {[
                      { lab: 'Units on hand', val: fmtNum(detail.units), foot: 'all partners' },
                      { lab: 'Value at MRP', val: detail.value == null ? '—' : fmtCr(detail.value), foot: detail.item.mrp == null ? 'no MRP' : `MRP ₹${fmtNum(detail.item.mrp)}` },
                      { lab: 'Partners holding', val: fmtNum(detail.partners.filter((x) => x.units > 0).length), foot: `of ${fmtNum(detail.partners.length)} listed` },
                      { lab: 'Change', val: detail.change_units == null ? '—' : signed(detail.change_units, fmtNum), foot: detail.opening_as_of ? `vs ${fmtSnap(detail.opening_as_of)} (${fmtNum(detail.opening_units)})` : 'no earlier stock date',
                        color: detail.change_units == null || detail.change_units === 0 ? undefined : detail.change_units > 0 ? '#0a7f4f' : OUT },
                    ].map((t) => (
                      <div key={t.lab} className="ps-dw-kpi">
                        <div className="ps-kpi-lab">{t.lab}</div>
                        <div className="ps-dw-kpi-val tnum" style={t.color ? { color: t.color } : undefined}>{t.val}</div>
                        <div className="ps-kpi-foot">{t.foot}</div>
                      </div>
                    ))}
                  </div>

                  <div className="ps-dw-sec">Stock over time <span>units on every stock date · peak {fmtNum(detail.peak.u)} on {fmtSnap(detail.peak.d)}</span></div>
                  <Chart options={histOpts} series={histSeries} type="area" height={190} />

                  <div className="ps-dw-sec">Where it sits <span>by partner, as of {fmtSnap(detail.as_of)}</span></div>
                  {detail.partners.length ? detail.partners.map((x) => {
                    const max = Math.max(...detail.partners.map((y) => Math.abs(y.units)), 1);
                    const d = detail.opening_as_of ? x.units - x.opening_units : null;
                    return (
                      <div key={x.name} className="ps-dw-row">
                        <div className="ps-dw-row-name" title={x.name}>{x.name}<span>{x.channel}</span></div>
                        <div className="ps-dw-row-track"><div style={{ width: `${Math.abs(x.units) / max * 100}%`, background: x.units < 0 ? OUT : SEQ }} /></div>
                        <div className="ps-dw-row-n tnum">{fmtNum(x.units)}
                          {d != null && d !== 0 && <span style={{ color: d > 0 ? '#0a7f4f' : OUT }}>{signed(d, fmtNum)}</span>}</div>
                      </div>
                    );
                  }) : <div className="ps-dw-none">Not in the stock file of {fmtDay(detail.as_of)} — last seen {fmtDay(detail.last_seen)}</div>}

                  {detail.sizes.length > 0 && (
                    <>
                      <div className="ps-dw-sec">Size run <span>{detail.item.style} · {detail.item.colour} · units as of {fmtSnap(detail.as_of)}</span></div>
                      <div className="ps-dw-sizes">
                        {detail.sizes.map((z) => (
                          <div key={z.size} className={`ps-dw-size ${z.size === detail.item.size ? 'on' : ''} ${z.units <= 0 ? 'out' : ''}`} title={`${fmtNum(z.partners)} partner${z.partners === 1 ? '' : 's'} holding`}>
                            <b>{z.size}</b><span className="tnum">{fmtNum(z.units)}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <div className="ps-dw-foot">In the stock files from {fmtDay(detail.first_seen)} to {fmtDay(detail.last_seen)} · filters on the page do not apply here — this is the SKU across every partner.</div>
                </>
              )}
            </div>
          </aside>
        </>
      )}

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
        .ps-hero-inner, .ps-kpi, .ps-insights, :global(.ps-card) { transition: opacity 160ms ease; }
        .ps-root.is-refreshing .ps-hero-inner, .ps-root.is-refreshing .ps-kpi, .ps-root.is-refreshing .ps-insights,
        .ps-root.is-refreshing :global(.ps-card) { opacity: 0.6; }
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
        .ps-delta.sm { font-size: 11.5px; padding: 2px 7px; margin-left: 6px; vertical-align: middle; }
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
        /* AI Insight band */
        .ps-insights { margin: 0 0 18px; padding: 16px 18px 18px; border-radius: 18px; background: var(--bg-surface);
          border: 1px solid var(--border-subtle); box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 10px 34px rgba(2,6,23,0.05); }
        .ps-insights-head { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 800; letter-spacing: 0.12em;
          text-transform: uppercase; color: var(--text-muted); margin-bottom: 12px; }
        .ps-insights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
        .ps-insight { padding: 4px 4px 4px 14px; border-left: 3px solid; min-width: 0; }
        .ps-insight-n { font-size: 24px; font-weight: 850; letter-spacing: -0.02em; line-height: 1.1; }
        .ps-insight-t { font-size: 12.5px; font-weight: 700; color: var(--text-primary); margin-top: 4px; }
        .ps-insight-s { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
        .ps-three { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 16px; }
        .ps-three :global(.ps-bar-name) { width: 120px; flex-basis: 120px; }
        @media (max-width: 1100px) { .ps-three { grid-template-columns: 1fr; } }
        /* SKU detail panel */
        .ps-dw-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.55); backdrop-filter: blur(3px); z-index: 1200; animation: psfade 160ms ease; }
        .ps-dw { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); z-index: 1201; display: flex; flex-direction: column;
          background: var(--bg-surface); border-left: 1px solid var(--border-subtle); box-shadow: -24px 0 60px rgba(2,6,23,0.35);
          animation: psslide 240ms cubic-bezier(0.16,1,0.3,1); }
        @keyframes psfade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes psslide { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .ps-dw, .ps-dw-overlay { animation: none; } }
        .ps-dw-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 22px 24px 18px;
          border-bottom: 1px solid var(--border-subtle); background: radial-gradient(520px 200px at 100% -40%, ${DENIM}2e, transparent 62%); }
        .ps-dw-title { font-size: 22px; font-weight: 850; letter-spacing: -0.02em; color: var(--text-primary); overflow-wrap: anywhere; }
        .ps-dw-sub { font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-top: 4px; }
        .ps-dw-close { width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-elevated);
          color: var(--text-primary); font-size: 14px; cursor: pointer; flex-shrink: 0; }
        .ps-dw-close:hover, .ps-dw-close:focus-visible { background: ${DENIM}; color: #fff; outline: none; }
        .ps-dw-body { padding: 18px 24px 28px; overflow-y: auto; flex: 1; }
        .ps-dw-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 16px; }
        .ps-dw-code { font-size: 12px; font-weight: 800; padding: 3px 9px; border-radius: 8px; background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-subtle); }
        .ps-dw-kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        .ps-dw-kpi { padding: 12px 14px; border-radius: 14px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); min-width: 0; }
        .ps-dw-kpi-val { font-size: 22px; font-weight: 850; letter-spacing: -0.02em; color: var(--text-primary); margin-top: 4px; }
        .ps-dw-sec { font-size: 13px; font-weight: 800; color: var(--text-primary); margin: 22px 0 10px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
        .ps-dw-sec span { font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
        .ps-dw-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
        .ps-dw-row-name { width: 210px; flex: 0 0 210px; font-size: 12.5px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ps-dw-row-name span { display: block; font-size: 10.5px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
        .ps-dw-row-track { flex: 1; height: 14px; background: var(--bg-elevated); border-radius: 5px; overflow: hidden; }
        .ps-dw-row-track div { height: 100%; min-width: 2px; border-radius: 5px; transition: width 0.7s cubic-bezier(0.16,1,0.3,1); }
        .ps-dw-row-n { width: 84px; flex: 0 0 84px; text-align: right; font-size: 13px; font-weight: 800; color: var(--text-primary); }
        .ps-dw-row-n span { display: block; font-size: 11px; font-weight: 800; }
        .ps-dw-none { padding: 16px; border-radius: 12px; background: var(--bg-elevated); font-size: 12.5px; font-weight: 600; color: var(--text-muted); }
        .ps-dw-sizes { display: flex; flex-wrap: wrap; gap: 8px; }
        .ps-dw-size { min-width: 54px; padding: 8px 10px; border-radius: 12px; text-align: center; background: var(--bg-elevated); border: 1px solid var(--border-subtle); }
        .ps-dw-size b { display: block; font-size: 12px; font-weight: 800; color: var(--text-secondary); }
        .ps-dw-size span { display: block; font-size: 15px; font-weight: 850; color: var(--text-primary); margin-top: 2px; }
        .ps-dw-size.on { border-color: ${DENIM}; box-shadow: inset 0 0 0 1px ${DENIM}; }
        .ps-dw-size.out span { color: ${OUT}; }
        .ps-dw-foot { margin-top: 22px; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
        @media (max-width: 560px) { .ps-dw-row-name { width: 130px; flex-basis: 130px; } }
        /* stock health */
        .ps-health { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
        .ps-hcard { display: flex; gap: 12px; align-items: flex-start; padding: 16px; border-radius: 14px; border: 1px solid; }
        .ps-hcard-ic { width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .ps-hcard-t { font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
        .ps-hcard-n { font-size: 26px; font-weight: 850; letter-spacing: -0.02em; color: var(--text-primary); margin: 2px 0; }
        .ps-hcard-s { font-size: 11.5px; color: var(--text-muted); }
        @media (max-width: 1100px) { .ps-health { grid-template-columns: 1fr; } }
        @media (max-width: 1100px) { .ps-kpis { grid-template-columns: repeat(3, 1fr); } .ps-two, .ps-two-tight { grid-template-columns: 1fr; } }
        @media (max-width: 560px) { .ps-kpis { grid-template-columns: repeat(2, 1fr); } :global(.ps-bar-name) { width: 116px; flex-basis: 116px; } }
      `}</style>
    </DashboardLayout>
    </FiltersProvider>
  );
}

// ── Compare-period pills — same look as the time pills on the other pages ──
function PeriodPills({ value, onChange }) {
  const idx = Math.max(0, PERIODS.findIndex((p) => p.key === value));
  const seg = 100 / PERIODS.length;
  return (
    <div className="time-range-control" role="tablist" aria-label="Compare period" title="How far back the opening stock and the trends go"
      style={{ display: 'inline-flex', position: 'relative', background: 'var(--v2-bg-elevated)', border: '1px solid var(--v2-border)', borderRadius: 999, padding: 3, height: 34 }}>
      <span aria-hidden style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${idx * seg}% + 2px)`, width: `calc(${seg}% - 4px)`,
        background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)', borderRadius: 999,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.30)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        transition: 'left 220ms var(--v2-ease), width 220ms var(--v2-ease)' }} />
      {PERIODS.map((p) => (
        <button key={p.key} role="tab" aria-selected={value === p.key} type="button" onClick={() => onChange(p.key)}
          style={{ position: 'relative', zIndex: 1, flex: 1, minWidth: 44, background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 12px',
            fontFamily: 'var(--v2-font-body)', fontSize: 12, fontWeight: 600, letterSpacing: '0.01em',
            color: value === p.key ? 'var(--v2-fg-primary)' : 'var(--v2-fg-tertiary)', transition: 'color 200ms' }}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Stock added / drawn down bars ──
const FLOW_LABEL = { Inbound: 'Stock added', Outbound: 'Stock drawn down' };
function FlowBars({ flow, loading, IN, OUT, isUnits, mfmt }) {
  if (loading) return <div style={{ display: 'grid', gap: 14 }}><Shim h={44} /><Shim h={44} /></div>;
  const rows = flow || [];
  if (!rows.length) return <Empty label="No newer snapshot than the opening one in this period" small />;
  const val = (r) => (isUnits ? r.u : r.g);
  const max = Math.max(...rows.map(val), 1);
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 6 }}>
      {rows.map((r) => (
        <div key={r.dir}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-secondary)' }}>{FLOW_LABEL[r.dir] || r.dir}</span>
            <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
              {mfmt(val(r))} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>· {cnt(r.txns)} positions</span>
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

// ── Signed columns per snapshot (SVG) ──
function MonthCols({ monthly, loading, IN, OUT, axis, grid, isUnits, mfmt }) {
  if (loading) return <Shim h={190} />;
  const m = (monthly || []).map((d) => ({ mon: d.mon, net: isUnits ? d.net_u : d.net }));
  if (!m.length) return <Empty label="No snapshot-to-snapshot change in this period" small />;
  const fmtV = mfmt || fmtCr;
  const W = 440, H = 200, P = { t: 16, r: 12, b: 26, l: 60 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const vals = m.map((d) => d.net); const max = Math.max(...vals, 0); const min = Math.min(...vals, 0);
  const span = (max - min) || 1;
  const y = (v) => P.t + ih - ((v - min) / span) * ih;
  const zero = y(0); const bw = Math.min(48, iw / m.length * 0.5);
  const every = Math.ceil(m.length / 12);   // thin the labels so a long window stays readable
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
            <rect x={cx - bw / 2} y={pos ? y(d.net) : zero} width={bw} height={h} rx={Math.min(5, bw / 2)} fill={pos ? IN : OUT}>
              <title>{d.mon}: {(pos ? '+' : '') + fmtV(d.net)}</title>
            </rect>
            {i % every === 0 && <text x={cx} y={H - 8} textAnchor="middle" fill={axis} fontSize={every > 1 ? 9 : 11}>{d.mon}</text>}
          </g>
        );
      })}
    </svg>
  );
}
