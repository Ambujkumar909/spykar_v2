// ─── /stock-availability — AS-ON-DATE stock history (Zoho/Cliq-style) ────────
// Pick ONE date on a full calendar → see exactly what stock was on hand that day
// across the network, pivotable by state/city/channel/store/category/colour/size,
// drillable to a single store, with a recent-history sparkline for context.
// Point-in-time, NOT a range. Reads inventory_daily_snapshot via resolveAsOf
// (snaps to the newest snapshot on/before the chosen date).

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import { useTheme } from '../lib/useTheme';
import { useFilters } from '../lib/useFilters';
import { FiltersProvider } from '../lib/FiltersContext';
import { stockAvailabilityService } from '../lib/services';
import { notifyApiError } from '../lib/notifyApiError';
import {
  Boxes, Layers, Store, Package, IndianRupee, TrendingUp, TrendingDown, CalendarDays,
  Map as MapIcon, Building2, Tag, Palette, Ruler, Download, ChevronRight, ArrowLeft,
  Activity, Clock, BarChart2, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN'));
function fmtCr(n) {
  if (n == null) return '—'; n = Number(n); const neg = n < 0; const a = Math.abs(n); let s;
  if (a >= 1e7) s = '₹' + (a / 1e7).toFixed(2) + ' Cr';
  else if (a >= 1e5) s = '₹' + (a / 1e5).toFixed(2) + 'L';
  else s = '₹' + Math.round(a).toLocaleString('en-IN');
  return (neg ? '−' : '') + s;
}
function cnt(n) {
  if (n == null) return '0'; n = Number(n);
  if (n >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}
const prettyDate = (iso) => (iso ? new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const STATUS_OPTIONS = [{ value: 'active', label: 'Active stores' }, { value: 'inactive', label: 'Inactive stores' }, { value: 'all', label: 'All stores' }];
const MEASURE_OPTIONS = [{ value: 'units', label: 'Units' }, { value: 'gross', label: 'Value (MRP)' }, { value: 'cost', label: 'Cost' }];
const VIEW_BY = [
  { key: 'state', label: 'State', Icon: MapIcon }, { key: 'city', label: 'City', Icon: Building2 },
  { key: 'channel', label: 'Channel', Icon: Layers }, { key: 'store', label: 'Store', Icon: Store },
  { key: 'category', label: 'Category', Icon: Tag }, { key: 'colour', label: 'Colour', Icon: Palette },
  { key: 'size', label: 'Size', Icon: Ruler },
];
// Sidebar "Lens" dims → on-page chip labels (all dims applicable to store-level stock).
const LENS_LABELS = {
  state: 'State', city: 'City', store_code: 'Store', group_name: 'Channel',
  category: 'Category', product: 'Product', sub_product: 'Sub-product',
  gender_name: 'Gender', size: 'Size', color: 'Colour', season: 'Season',
};
// View-by dimension → the Lens filter key a row-click drills into.
const VIEWBY_LENS = { state: 'state', city: 'city', channel: 'group_name',
  category: 'category', colour: 'color', size: 'size' };

const measureVal = (r, m) => (m === 'gross' ? Number(r.value_gross || 0) : m === 'cost' ? Number(r.value_cost || 0) : Number(r.stock_units || 0));
const measureFmt = (n, m) => (m === 'units' ? fmtNum(n) : fmtCr(n));
const measureLabel = (m) => (m === 'units' ? 'Units' : m === 'gross' ? 'Value' : 'Cost');

function HeaderField({ label, value, onChange, options, minWidth = 120 }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 34, padding: '0 6px 0 12px',
      borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
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

export default function StockAvailabilityPage() {
  const { isDark } = useTheme();
  const CYAN = isDark ? '#38BDF8' : '#0EA5E9';
  const SEQ = isDark ? '#38BDF8' : '#0284C7';
  const SERIES = isDark
    ? ['#38BDF8', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181', '#d95926', '#3ba33b']
    : ['#0284C7', '#1baf7a', '#eda100', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834', '#008300'];
  const axis = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.55)';
  const grid = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';

  const [range, setRange] = useState(null);       // { from, to } — calendar bounds
  const [history, setHistory] = useState(null);   // [{d,u}] recent-history sparkline (lazy)
  const [asOf, setAsOf] = useState(todayISO());
  const [measure, setMeasure] = useState('units');
  const [viewBy, setViewBy] = useState('state');
  const [sortBy, setSortBy] = useState('measure');

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [pivot, setPivot] = useState(null);
  const [pivotLoading, setPivotLoading] = useState(true);
  const [storeSel, setStoreSel] = useState(null);
  const [storeData, setStoreData] = useState(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ── Sales vs Stock feature state ──
  const [svsWindow, setSvsWindow] = useState(90);  // trailing days ending at asOf
  const [svs, setSvs] = useState(null);
  const [svsLoading, setSvsLoading] = useState(false);
  const svsRef = useRef(null);                     // for smooth-scroll on drill

  // ── Sidebar "Lens" filters — shared via FiltersContext so the PremiumFilterBar
  // in the rail drives this page. Row-clicks in the pivot ALSO write here, so a
  // single scope object powers the KPIs, the breakdown, and Sales-vs-Stock. ──
  const filtersApi = useFilters({ defaults: { mode: 'active' }, persist: ['mode'] });
  const lens = filtersApi.filters;
  const setLens = filtersApi.setFilter;
  const clearLens = filtersApi.clearFilter;
  const status = lens.mode || 'active';

  const activeLensDims = useMemo(
    () => Object.keys(LENS_LABELS).filter((d) => { const v = lens[d]; return Array.isArray(v) ? v.length > 0 : Boolean(v); }),
    [lens]
  );
  const lensScope = useMemo(() => {
    const p = {};
    const put = (k, v) => { if (v && v.length) p[k] = Array.isArray(v) ? v.join(',') : v; };
    put('state', lens.state); put('city', lens.city); put('channel', lens.group_name);
    put('store', lens.store_code); put('category', lens.category); put('color', lens.color);
    put('size', lens.size); put('product', lens.product); put('gender', lens.gender_name);
    put('sub_product', lens.sub_product); put('season', lens.season);
    return p;
  }, [lens]);

  const scope = useMemo(() => ({ status, ...lensScope }), [status, lensScope]);
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);

  // Available date range → default the calendar to the newest snapshot. This is
  // the critical path (it sets the as-on date that summary/pivot depend on), and
  // it's an instant MIN/MAX lookup — no aggregation.
  useEffect(() => {
    let a = true;
    stockAvailabilityService.getRange().then((r) => {
      if (!a) return; const d = r.data?.data || null; setRange(d);
      if (d?.to) setAsOf(d.to);
    }).catch(() => {});
    return () => { a = false; };
  }, []);

  // Recent-history sparkline — fetched separately/lazily so its (bounded) sum
  // never blocks first paint. Loads once; independent of the selected date.
  useEffect(() => {
    let a = true;
    stockAvailabilityService.getHistory()
      .then((r) => { if (a) setHistory(r.data?.data?.dates || []); })
      .catch(() => { if (a) setHistory([]); });
    return () => { a = false; };
  }, []);

  useEffect(() => {
    let a = true; setSummaryLoading(true);
    stockAvailabilityService.getSummary({ as_of: asOf, ...scope })
      .then((s) => { if (a) setSummary(s.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load stock summary'); })
      .finally(() => { if (a) setSummaryLoading(false); });
    return () => { a = false; };
  }, [asOf, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let a = true; setPivotLoading(true);
    stockAvailabilityService.getPivot({ group_by: viewBy, as_of: asOf, ...scope })
      .then((p) => { if (a) setPivot(p.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load breakdown'); })
      .finally(() => { if (a) setPivotLoading(false); });
    return () => { a = false; };
  }, [viewBy, asOf, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!storeSel) { setStoreData(null); return; }
    let a = true; setStoreLoading(true);
    const from = new Date(asOf); from.setDate(from.getDate() - 30);
    stockAvailabilityService.getStoreTrend(storeSel.id, { from: from.toISOString().slice(0, 10), to: asOf })
      .then((r) => { if (a) setStoreData(r.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load store detail'); })
      .finally(() => { if (a) setStoreLoading(false); });
    return () => { a = false; };
  }, [storeSel, asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sales vs Stock — trailing window ending at asOf, driven by the SAME unified
  // scope (Lens + row-click drills) as the rest of the page.
  useEffect(() => {
    let a = true; setSvsLoading(true);
    const from = new Date(asOf); from.setDate(from.getDate() - (svsWindow - 1));
    stockAvailabilityService.getSalesVsStock({ from: from.toISOString().slice(0, 10), to: asOf, ...scope })
      .then((r) => { if (a) setSvs(r.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load sales vs stock'); })
      .finally(() => { if (a) setSvsLoading(false); });
    return () => { a = false; };
  }, [asOf, svsWindow, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onViewBy = useCallback((k) => { setViewBy(k); setStoreSel(null); }, []);
  const dimLabel = VIEW_BY.find((v) => v.key === viewBy)?.label || viewBy;

  // Every row is clickable. Store rows open the rich per-store panel; every other
  // dimension drills by writing the corresponding Lens filter (toggle) — which
  // re-scopes the KPIs, the breakdown, AND the Sales-vs-Stock card in one move.
  const lensKeyFor = VIEWBY_LENS[viewBy];
  const onRowClick = useCallback((r) => {
    if (viewBy === 'store') { setStoreSel({ id: r.key, label: r.label }); return; }
    if (!lensKeyFor) return;
    const cur = lens[lensKeyFor];
    const already = Array.isArray(cur) ? (cur.length === 1 && cur[0] === r.key) : cur === r.key;
    setLens(lensKeyFor, already ? undefined : [r.key]);
    if (!already && svsRef.current) svsRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [viewBy, lensKeyFor, lens, setLens]);

  const ROW_CAP = 200;
  const totalRows = pivot?.rows?.length || 0;
  const sortedRows = useMemo(() => {
    const rows = [...(pivot?.rows || [])];
    const cmp = { measure: (a, b) => measureVal(b, measure) - measureVal(a, measure),
      stores: (a, b) => (b.store_count || 0) - (a.store_count || 0),
      delta: (a, b) => (b.delta_vs_30d_pct ?? -1e9) - (a.delta_vs_30d_pct ?? -1e9) }[sortBy] || (() => 0);
    return rows.sort(cmp).slice(0, ROW_CAP);
  }, [pivot, measure, sortBy]);

  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const res = await stockAvailabilityService.exportCsv({ group_by: viewBy, as_of: asOf, measure, ...scope });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `stock-as-on-${viewBy}-${asOf}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
    } catch (e) { notifyApiError(e, 'Export failed'); } finally { setExporting(false); }
  }, [viewBy, asOf, measure, scope]);

  // ── recent-history sparkline (units per snapshot date, selected day marked) ──
  // Category-axis date formatter (v = 'YYYY-MM-DD' category value). Guarded so a
  // stray numeric index (ApexCharts quirk) never renders "Invalid Date"/1970.
  const catDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v))
    ? new Date(v + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

  const spark = useMemo(() => (history || []).slice(-30), [history]);
  const sparkCats = useMemo(() => spark.map((p) => p.d), [spark]);
  const selDay = summary?.as_of || asOf;
  const sparkOpts = useMemo(() => ({
    chart: { type: 'area', sparkline: { enabled: false }, fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent', animations: { enabled: false } },
    colors: [SEQ], stroke: { width: 2, curve: 'smooth' },
    fill: { type: 'gradient', gradient: { opacityFrom: 0.25, opacityTo: 0, stops: [0, 100] } },
    dataLabels: { enabled: false },
    markers: { size: 0, colors: [CYAN], strokeColors: isDark ? '#0B1220' : '#fff', strokeWidth: 2, hover: { size: 6 } },
    // Highlight the selected day with a vertical annotation line (category-safe).
    annotations: { xaxis: sparkCats.includes(selDay) ? [{ x: selDay, borderColor: CYAN, strokeDashArray: 3, opacity: 0.7 }] : [] },
    grid: { borderColor: grid, padding: { left: 6, right: 8 } },
    xaxis: { type: 'category', categories: sparkCats, tickPlacement: 'on', labels: { style: { colors: axis, fontSize: '10px' }, rotate: -30, hideOverlappingLabels: true, formatter: catDay }, axisBorder: { show: false }, axisTicks: { show: false }, crosshairs: { show: true } },
    yaxis: { labels: { style: { colors: axis, fontSize: '10px' }, formatter: (v) => cnt(v) } },
    tooltip: { theme: isDark ? 'dark' : 'light', x: { formatter: (v, o) => prettyDate(sparkCats[o?.dataPointIndex] ?? v) }, y: { formatter: (v) => fmtNum(v) + ' units', title: { formatter: () => 'On hand' } } },
  }), [sparkCats, selDay, isDark]); // eslint-disable-line react-hooks/exhaustive-deps
  const sparkSeries = useMemo(() => [{ name: 'On hand', data: spark.map((p) => p.u) }], [spark]);

  // store dual chart — shared category axis so line + columns align, hover is 1:1
  const storeSorted = useMemo(() => [...(storeData?.series || [])].sort((a, b) => (a.date < b.date ? -1 : 1)), [storeData]);
  const storeCats = useMemo(() => storeSorted.map((s) => s.date), [storeSorted]);
  const storeOpts = useMemo(() => ({
    chart: { type: 'line', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent', animations: { enabled: false } },
    colors: [SEQ, '#e34948'], stroke: { width: [3, 0], curve: 'smooth' }, markers: { size: 0, hover: { size: 5 } }, plotOptions: { bar: { columnWidth: '55%', borderRadius: 2 } },
    dataLabels: { enabled: false }, legend: { show: true, position: 'bottom', labels: { colors: axis } },
    grid: { borderColor: grid }, xaxis: { type: 'category', categories: storeCats, tickPlacement: 'on', labels: { style: { colors: axis, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true, formatter: catDay }, axisBorder: { show: false }, axisTicks: { show: false }, crosshairs: { show: true } },
    yaxis: [{ labels: { style: { colors: axis }, formatter: (v) => fmtNum(Math.round(v)) } }, { opposite: true, labels: { style: { colors: axis }, formatter: (v) => fmtNum(Math.round(v)) } }],
    tooltip: { theme: isDark ? 'dark' : 'light', shared: true, x: { formatter: (v, o) => prettyDate(storeCats[o?.dataPointIndex] ?? v) } },
  }), [storeCats, isDark]); // eslint-disable-line react-hooks/exhaustive-deps
  const storeSeries = useMemo(() => ([
    { name: 'Stock on hand', type: 'line', data: storeSorted.map((s) => s.stock_on_hand) },
    { name: 'Units sold', type: 'column', data: storeSorted.map((s) => s.units_sold) },
  ]), [storeSorted]);

  // ── Sales vs Stock chart — shared daily category axis (crosshair snaps 1:1) ──
  const svsSorted = useMemo(() => [...(svs?.series || [])].sort((a, b) => (a.date < b.date ? -1 : 1)), [svs]);
  const svsCats = useMemo(() => svsSorted.map((s) => s.date), [svsSorted]);
  const svsOpts = useMemo(() => ({
    chart: { type: 'line', fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, stacked: false, background: 'transparent', animations: { enabled: false } },
    colors: [SEQ, '#e34948'], stroke: { width: [3, 0], curve: 'smooth' }, markers: { size: 0, hover: { size: 5 } }, plotOptions: { bar: { columnWidth: '52%', borderRadius: 2 } },
    fill: { type: ['gradient', 'solid'], gradient: { opacityFrom: 0.22, opacityTo: 0, stops: [0, 100] } },
    dataLabels: { enabled: false }, legend: { show: true, position: 'bottom', fontSize: '12px', labels: { colors: axis }, markers: { width: 10, height: 10, radius: 3 } },
    grid: { borderColor: grid, padding: { left: 6, right: 8 } },
    xaxis: { type: 'category', categories: svsCats, tickPlacement: 'on', labels: { style: { colors: axis, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true, formatter: catDay }, axisBorder: { show: false }, axisTicks: { show: false }, crosshairs: { show: true } },
    yaxis: [
      { seriesName: 'Stock on hand', labels: { style: { colors: axis, fontSize: '11px' }, formatter: (v) => cnt(Math.round(v)) }, title: { text: 'Stock on hand', style: { color: axis, fontWeight: 600 } } },
      { opposite: true, seriesName: 'Units sold', labels: { style: { colors: axis, fontSize: '11px' }, formatter: (v) => fmtNum(Math.round(v)) }, title: { text: 'Units sold / day', style: { color: axis, fontWeight: 600 } } },
    ],
    tooltip: { theme: isDark ? 'dark' : 'light', shared: true, intersect: false, x: { formatter: (v, o) => prettyDate(svsCats[o?.dataPointIndex] ?? v) } },
  }), [svsCats, isDark]); // eslint-disable-line react-hooks/exhaustive-deps
  const svsSeries = useMemo(() => ([
    { name: 'Stock on hand', type: 'area', data: svsSorted.map((s) => s.stock_on_hand) },
    { name: 'Units sold', type: 'column', data: svsSorted.map((s) => s.units_sold) },
  ]), [svsSorted]);

  const snapped = summary?.as_of && summary.as_of !== asOf;
  const heroVal = measure === 'units' ? cnt(summary?.stock_units) : fmtCr(measure === 'cost' ? summary?.value_cost : summary?.value_gross);
  const delta = summary?.delta_units_vs_30d_pct;

  return (
    <FiltersProvider value={filtersApi}>
    <DashboardLayout title="Stock Availability"
      subtitle="As-on-date stock history — pick any day and see exactly what was on hand across the network">
      <div className="sa-page">
        {/* ── AS-ON toolbar ── */}
        <div className="sa-toolbar">
          <div className="sa-dateblock">
            <CalendarDays size={18} style={{ color: CYAN, flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="sa-date-lbl">Stock as on</span>
              <input type="date" className="sa-date" value={asOf} min={range?.from || undefined} max={range?.to || todayISO()}
                onChange={(e) => e.target.value && setAsOf(e.target.value)} aria-label="Stock as-on date" />
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <HeaderField label="Measure" value={measure} onChange={setMeasure} options={MEASURE_OPTIONS} minWidth={96} />
          <HeaderField label="Status" value={status} onChange={(v) => setLens('mode', v)} options={STATUS_OPTIONS} minWidth={104} />
        </div>

        {/* ── Active Lens filters (sidebar + row-click drills) as removable chips ── */}
        {activeLensDims.length > 0 && (
          <div className="sa-chips">
            <span className="sa-unit" style={{ color: CYAN, marginRight: 2 }}>Filtered by</span>
            {activeLensDims.map((dim) => {
              const v = lens[dim]; const vals = Array.isArray(v) ? v : [v];
              return (
                <span key={dim} className="sa-chip">
                  <span className="sa-chip-k">{LENS_LABELS[dim]}</span>
                  <span className="sa-chip-v" title={vals.join(', ')}>{vals.join(', ')}</span>
                  <button type="button" onClick={() => clearLens(dim)} aria-label={`Clear ${LENS_LABELS[dim]}`} className="sa-chip-x">✕</button>
                </span>
              );
            })}
            {activeLensDims.length > 1 && (
              <button type="button" className="sa-chip-clear" onClick={() => activeLensDims.forEach((d) => clearLens(d))}>Clear all</button>
            )}
          </div>
        )}

        {/* ── HERO ── */}
        <div className="sa-hero">
          <div className="sa-hero-glow" />
          <div style={{ position: 'relative' }}>
            <div className="sa-eyebrow"><Boxes size={12} /> Stock on hand · {prettyDate(summary?.as_of || asOf)}</div>
            {summaryLoading ? <div className="sx-shimmer" style={{ height: 60, width: '55%', borderRadius: 10 }} /> : (
              <div className="sa-hero-num">
                {heroVal}
                {delta != null && (
                  <span className={`sa-delta ${delta >= 0 ? 'up' : 'down'}`}>
                    {delta >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{Math.abs(delta)}% <span style={{ opacity: 0.7, fontWeight: 600 }}>vs ~30d</span>
                  </span>
                )}
              </div>
            )}
            <div className="sa-hero-sub">
              <span><b>{fmtNum(summary?.store_count)}</b> stores</span>
              <span><b>{cnt(summary?.sku_count)}</b> SKUs</span>
              <span><b>{fmtNum(summary?.avg_per_store)}</b> units/store</span>
              {snapped && <span className="sa-snap">nearest snapshot · {prettyDate(summary.as_of)}</span>}
            </div>
          </div>
        </div>

        {/* ── KPI + recent history ── */}
        <div className="sa-grid2">
          <div className="sx-card" style={{ padding: 18 }}>
            <div className="sa-kpis">
              <Kpi icon={Boxes} label="Units" accent={CYAN} loading={summaryLoading} value={fmtNum(summary?.stock_units)} sub="on hand" />
              <Kpi icon={IndianRupee} label={measure === 'cost' ? 'Cost' : 'Value'} accent="#10B981" loading={summaryLoading} value={fmtCr(measure === 'cost' ? summary?.value_cost : summary?.value_gross)} sub={measure === 'cost' ? 'qty×cost' : 'qty×MRP'} />
              <Kpi icon={Store} label="Stores" accent="#F59E0B" loading={summaryLoading} value={fmtNum(summary?.store_count)} sub="with stock" />
              <Kpi icon={Package} label="SKUs" accent="#A855F7" loading={summaryLoading} value={cnt(summary?.sku_count)} sub="distinct" />
            </div>
          </div>
          <div className="sx-card" style={{ padding: 18 }}>
            <SecTitle icon={Activity} label="Recent history" right={<span className="sa-unit">last {spark.length} snapshots</span>} />
            {history == null ? <div className="sx-shimmer" style={{ height: 120, borderRadius: 8 }} />
              : spark.length ? <Chart options={sparkOpts} series={sparkSeries} type="area" height={130} />
              : <Empty label="No snapshots yet" small />}
          </div>
        </div>

        {/* ── store panel OR breakdown ── */}
        {storeSel ? (
          <div className="sx-card" style={{ padding: 20, marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <button onClick={() => setStoreSel(null)} className="sa-back"><ArrowLeft size={13} /> Back</button>
              <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text-primary)' }}>
                {storeData?.store ? `${storeData.store.code} · ${storeData.store.name}` : storeSel.label}
              </div>
              {storeData?.store && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{storeData.store.city}, {storeData.store.state} · {storeData.store.channel}</span>}
            </div>
            {storeLoading ? <div className="sx-shimmer" style={{ height: 300, borderRadius: 10 }} /> : storeData ? (
              <>
                <div className="sa-statgrid">
                  <Stat icon={Boxes} label="Stock now" value={fmtNum(storeData.summary.stock_now)} accent={CYAN} />
                  <Stat icon={BarChart2} label="Avg stock" value={fmtNum(storeData.summary.avg_stock)} accent="#A855F7" />
                  <Stat icon={Activity} label="Avg sale/day" value={fmtNum(storeData.summary.avg_sale_per_day)} accent="#e34948" />
                  <Stat icon={Clock} label="Cover days" value={storeData.summary.cover_days == null ? '—' : `${storeData.summary.cover_days}d`} accent="#10B981" />
                </div>
                {storeData.series?.length ? <Chart options={storeOpts} series={storeSeries} type="line" height={300} /> : <Empty label="No history for this store in the window" small />}
                {storeData.recommendation && <div className="sa-reco"><strong style={{ color: 'var(--text-primary)' }}>Recommendation · </strong>{storeData.recommendation}</div>}
              </>
            ) : <Empty label="No data" small />}
          </div>
        ) : (
          <>
            {/* view-by + export */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '18px 0 12px' }}>
              <div className="sa-viewby">
                {VIEW_BY.map(({ key, label, Icon }) => (
                  <button key={key} className={`sa-vb ${viewBy === key ? 'on' : ''}`} onClick={() => onViewBy(key)}><Icon size={13} /> {label}</button>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              <button className="sa-export" onClick={onExport} disabled={exporting || !pivot?.rows?.length}>
                <Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>

            <div className="sx-card" style={{ overflow: 'hidden' }}>
              <div className="sa-tblhead">
                <span className="sa-unit" style={{ color: CYAN }}>By {dimLabel} · as on {prettyDate(summary?.as_of || asOf)}</span>
                {!pivotLoading && pivot?.rows && <span className="sa-count">{fmtNum(totalRows)}</span>}
                {!pivotLoading && totalRows > ROW_CAP && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>top {ROW_CAP} · export for all</span>}
                <div style={{ flex: 1 }} />
                <HeaderField label="Sort" value={sortBy} onChange={setSortBy} minWidth={92}
                  options={[{ value: 'measure', label: measureLabel(measure) }, { value: 'stores', label: 'Stores' }, { value: 'delta', label: 'Δ vs 30d' }]} />
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="sa-tbl">
                  <thead><tr>
                    <th className="l">{dimLabel}</th><th>Stores</th><th>Stock (u)</th>{measure !== 'units' && <th>{measureLabel(measure)}</th>}<th>Δ vs 30d</th>
                  </tr></thead>
                  <tbody>
                    {pivotLoading ? Array.from({ length: 10 }).map((_, i) => <tr key={i}><td colSpan={7}><div className="sx-shimmer" style={{ height: 14, borderRadius: 4 }} /></td></tr>)
                      : sortedRows.length ? sortedRows.map((r, i) => {
                        const clickable = viewBy === 'store' || !!lensKeyFor;
                        const active = lensKeyFor && (Array.isArray(lens[lensKeyFor]) ? lens[lensKeyFor].includes(r.key) : lens[lensKeyFor] === r.key);
                        return (
                        <tr key={r.key || i} className={`${clickable ? 'clk' : ''}${active ? ' on' : ''}`} onClick={() => clickable && onRowClick(r)}>
                          <td className="l strong">{r.label || '—'} {clickable && <ChevronRight size={12} style={{ color: active ? CYAN : 'var(--text-muted)', verticalAlign: 'middle' }} />}</td>
                          <td>{fmtNum(r.store_count)}</td>
                          <td className="strong">{fmtNum(r.stock_units)}</td>
                          {measure !== 'units' && <td style={{ color: '#10B981', fontWeight: 700 }}>{fmtCr(measure === 'cost' ? r.value_cost : r.value_gross)}</td>}
                          <td className={r.delta_vs_30d_pct == null ? '' : r.delta_vs_30d_pct >= 0 ? 'pos' : 'neg'}>{r.delta_vs_30d_pct == null ? '—' : `${r.delta_vs_30d_pct > 0 ? '+' : ''}${r.delta_vs_30d_pct}%`}</td>
                        </tr>); }) : <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>No stock on this date for this selection</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ── SALES vs STOCK ── */}
        <div className="sx-card" ref={svsRef} style={{ padding: 20, marginTop: 16 }}>
          <div className="sa-svs-head">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--bg-elevated)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Activity size={13} color={CYAN} /></span>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>Sales vs Stock</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                Daily on-hand vs units sold — {activeLensDims.length
                  ? <>scoped to <b style={{ color: CYAN }}>{activeLensDims.map((d) => LENS_LABELS[d]).join(' · ')}</b> (click any row above, or use the Lens, to re-scope)</>
                  : <>whole network · click any row above or use the <b style={{ color: CYAN }}>Lens</b> to scope to a state, store, category, colour or size</>}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <HeaderField label="Window" value={String(svsWindow)} onChange={(v) => setSvsWindow(Number(v))} minWidth={78}
              options={[{ value: '30', label: '30 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }]} />
          </div>

          {svsLoading ? <div className="sx-shimmer" style={{ height: 300, borderRadius: 10, marginTop: 14 }} /> : svs ? (
            <>
              <div className="sa-svs-kpis">
                <Stat icon={Boxes} label="Stock now" value={fmtNum(svs.summary.stock_now)} accent={CYAN} />
                <Stat icon={Activity} label="Avg sold/day" value={fmtNum(svs.summary.avg_sale_per_day)} accent="#e34948" />
                <Stat icon={TrendingUp} label="Total sold" value={fmtNum(svs.summary.total_sold)} accent="#F59E0B" />
                <Stat icon={Clock} label="Cover days" value={svs.summary.cover_days == null ? '—' : `${svs.summary.cover_days}d`} accent="#10B981" />
                <Stat icon={Layers} label="Sell-through" value={svs.summary.sell_through_pct == null ? '—' : `${svs.summary.sell_through_pct}%`} accent="#A855F7" />
              </div>
              {svs.series?.length ? <Chart options={svsOpts} series={svsSeries} type="line" height={320} /> : <Empty label="No stock/sales in this window for this scope" small />}
            </>
          ) : <Empty label="No data" small />}
        </div>
      </div>

      <style jsx global>{`
        input.sa-date::-webkit-calendar-picker-indicator { filter: brightness(0) invert(1); opacity: 0.85; cursor: pointer; }
        html.theme-light input.sa-date::-webkit-calendar-picker-indicator { filter: brightness(0); opacity: 0.6; }
        /* Crosshair + tooltip trail the cursor because ApexCharts eases them with
           a CSS transition — kill it so they SNAP to the point under the mouse. */
        .apexcharts-xcrosshairs, .apexcharts-ycrosshairs { transition: none !important; }
        .apexcharts-tooltip { transition: none !important; }
        .apexcharts-marker { transition: none !important; }
      `}</style>
      <style jsx>{`
        .sa-page { padding-bottom: 40px; }
        .sa-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
        .sa-dateblock { display: inline-flex; align-items: center; gap: 12px; padding: 8px 16px; border-radius: 14px;
          background: var(--bg-surface); border: 1px solid ${CYAN}44; box-shadow: 0 0 0 3px ${CYAN}10, 0 2px 10px rgba(2,6,23,0.06); }
        .sa-date-lbl { font-size: 9.5px; font-weight: 800; letter-spacing: 0.10em; text-transform: uppercase; color: var(--text-muted); }
        .sa-date { border: none; background: transparent; color: var(--text-primary); font-size: 17px; font-weight: 800;
          font-family: inherit; outline: none; cursor: pointer; padding: 0; letter-spacing: -0.01em; }
        .sa-hero { position: relative; overflow: hidden; border-radius: 20px; padding: 26px 28px; margin-bottom: 16px;
          background: linear-gradient(135deg, var(--bg-surface), var(--bg-elevated)); border: 1px solid var(--border-subtle); }
        .sa-hero-glow { position: absolute; inset: 0; background: radial-gradient(600px 260px at 85% -30%, ${CYAN}26, transparent 60%); }
        .sa-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px; }
        .sa-hero-num { font-size: clamp(40px, 6.5vw, 66px); font-weight: 850; letter-spacing: -0.03em; line-height: 1; color: var(--text-primary); display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .sa-delta { font-size: 14px; font-weight: 800; display: inline-flex; align-items: center; gap: 3px; padding: 4px 10px; border-radius: 999px; }
        .sa-delta.up { color: #0a7f4f; background: rgba(16,163,74,0.14); } .sa-delta.down { color: #e34948; background: rgba(227,73,72,0.14); }
        .sa-hero-sub { display: flex; gap: 8px 22px; flex-wrap: wrap; margin-top: 16px; font-size: 14px; color: var(--text-secondary); }
        .sa-hero-sub b { color: var(--text-primary); font-weight: 800; }
        .sa-snap { color: ${CYAN}; font-weight: 700; }
        .sa-grid2 { display: grid; grid-template-columns: 1fr 1.1fr; gap: 16px; }
        .sa-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; height: 100%; }
        .sa-unit { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
        .sa-viewby { display: inline-flex; flex-wrap: wrap; gap: 5px; padding: 4px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 12px; }
        .sa-vb { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; background: transparent; color: var(--text-secondary); transition: all 0.15s; }
        .sa-vb.on { background: ${CYAN}; color: #062634; box-shadow: 0 4px 12px ${CYAN}55; }
        .sa-export { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-elevated); cursor: pointer; color: var(--text-primary); font-size: 12px; font-weight: 700; }
        .sa-export:disabled { opacity: 0.5; }
        .sa-tblhead { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap; }
        .sa-count { font-size: 10px; font-weight: 800; color: #062634; background: ${CYAN}; border-radius: 100px; padding: 2px 8px; }
        .sa-tbl { width: 100%; border-collapse: collapse; }
        .sa-tbl th, .sa-tbl td { padding: 10px 14px; font-size: 13px; white-space: nowrap; border-bottom: 1px solid var(--border-subtle); text-align: right; }
        .sa-tbl th { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
        .sa-tbl th.l, .sa-tbl td.l { text-align: left; }
        .sa-tbl td { color: var(--text-secondary); font-weight: 600; font-variant-numeric: tabular-nums; }
        .sa-tbl td.strong { color: var(--text-primary); font-weight: 800; }
        .sa-tbl tr.clk { cursor: pointer; } .sa-tbl tbody tr:hover { background: var(--bg-card-hover, rgba(148,163,184,0.06)); }
        .sa-tbl td.pos { color: #0a7f4f; font-weight: 800; } .sa-tbl td.neg { color: #e34948; font-weight: 800; }
        .sa-back { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 6px 10px; cursor: pointer; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
        .sa-statgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
        .sa-reco { margin-top: 14px; padding: 12px 14px; border-radius: 10px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); font-size: 13px; font-weight: 600; color: var(--text-secondary); line-height: 1.5; }
        .sa-svs-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
        .sa-svs-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 14px; margin-bottom: 6px; border-bottom: 1px solid var(--border-subtle); }
        .sa-svs-clear { border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-weight: 700; cursor: pointer; padding: 4px 6px; }
        .sa-svs-clear:hover { color: var(--text-primary); }
        .sa-svs-kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin: 14px 0 16px; }
        /* ── active-filter chips ── */
        .sa-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: -4px 0 16px; padding: 10px 14px;
          border-radius: 12px; background: ${CYAN}0d; border: 1px solid ${CYAN}33; }
        .sa-chip { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 4px 0 11px; border-radius: 999px;
          background: var(--bg-surface); border: 1px solid var(--border-subtle); box-shadow: 0 1px 3px rgba(2,6,23,0.06); max-width: 320px; }
        .sa-chip-k { font-size: 9px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: ${CYAN}; flex-shrink: 0; }
        .sa-chip-v { font-size: 12.5px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sa-chip-x { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: none; border-radius: 50%;
          background: transparent; color: var(--text-muted); cursor: pointer; font-size: 11px; line-height: 1; flex-shrink: 0; transition: all 0.15s; }
        .sa-chip-x:hover { background: ${CYAN}; color: #062634; }
        .sa-chip-clear { border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-weight: 700; cursor: pointer; padding: 4px 6px; }
        .sa-chip-clear:hover { color: var(--text-primary); }
        .sa-tbl tr.on { background: ${CYAN}14; }
        .sa-tbl tr.on td.l.strong { color: ${CYAN}; }
        @media (max-width: 900px) { .sa-svs-kpis { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 1000px) { .sa-grid2 { grid-template-columns: 1fr; } .sa-statgrid { grid-template-columns: repeat(2, 1fr); } }
      `}</style>
    </DashboardLayout>
    </FiltersProvider>
  );
}

function Kpi({ icon: Icon, label, value, sub, accent, loading }) {
  return (
    <div style={{ borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 24, height: 24, borderRadius: 7, background: accent + '1e', color: accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={13} /></span>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</span>
      </div>
      {loading ? <div className="sx-shimmer" style={{ height: 24, width: '70%', borderRadius: 6 }} /> : <div style={{ fontSize: 23, fontWeight: 850, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{value}</div>}
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>{sub}</div>
    </div>
  );
}
function SecTitle({ icon: Icon, label, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <span style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--bg-elevated)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={13} color="var(--text-primary)" /></span>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>{label}</span>
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}
function Stat({ icon: Icon, label, value, accent }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><Icon size={13} color={accent} /><span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</span></div>
      <div style={{ fontSize: 22, fontWeight: 850, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
function Empty({ label, small }) {
  return <div style={{ minHeight: small ? 120 : 200, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text-muted)' }}><Boxes size={small ? 20 : 28} strokeWidth={1.6} /><span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span></div>;
}
