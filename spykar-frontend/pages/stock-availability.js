// ─── /stock-availability — the 4th portal page: STOCK OVER TIME ─────────────
// The other three pages show CURRENT positions and sales. This page is the
// only one that reads inventory_daily_snapshot to show how stock-on-hand
// MOVES day by day, pivotable by State / City / Channel / Store / Category /
// Colour / Size, drillable to a single store's stock-vs-sales.
//
// Built on the Network/Sales design system (DashboardLayout + headerSlot +
// sx-card + react-apexcharts) for visual parity with those pages. The state
// choropleth REUSES the dashboard-v2 IndiaHeatmap (wrapped in a scoped v2-app
// so its --v2-* tokens resolve), with a backward-compatible onStateClick for
// in-page drill.
//
// EXCLUSIONS (deliberate, matching the portal): no ageing / dead-stock, and no
// "region" dimension (locations.zone_id is NULL for every row — revisit once
// the sync populates it).

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import TimeRangeControl from '../components/dashboard-v2/TimeRangeControl';
import IndiaHeatmap from '../components/dashboard-v2/IndiaHeatmap';
import { useTimeRange } from '../lib/v2/useTimeRange';
import { useTheme } from '../lib/useTheme';
import { stockAvailabilityService } from '../lib/services';
import { notifyApiError } from '../lib/notifyApiError';
import {
  Boxes, Layers, Store, Package, IndianRupee, TrendingUp, TrendingDown,
  Map as MapIcon, Building2, Tag, Palette, Ruler, Download, ChevronRight,
  ArrowLeft, Activity, Clock, BarChart2,
} from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

// ── Theme tokens (mirror network.js/sales.js) ───────────────────────────────
const T = {
  primary:   'var(--text-primary,   #F1F5F9)',
  secondary: 'var(--text-secondary, #CBD5E1)',
  muted:     'var(--text-muted,     #64748B)',
  border:    'var(--border-subtle,  rgba(255,255,255,0.07))',
  bg:        'var(--bg-canvas,      #070C18)',
  accent:    'var(--accent-primary, #EF4444)',
};

// ── Formatters (identical conventions to the other pages) ───────────────────
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
  return '₹' + Number(n).toLocaleString('en-IN');
}
function fmtNum(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('en-IN');
}

// ── Controls ────────────────────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active Stores' },
  { value: 'inactive', label: 'Inactive Stores' },
  { value: 'all',      label: 'All Stores' },
];
const MEASURE_OPTIONS = [
  { value: 'units', label: 'Units' },
  { value: 'gross', label: 'Gross (MRP)' },
  { value: 'cost',  label: 'Cost' },
];
const VIEW_BY = [
  { key: 'state',    label: 'State',    Icon: MapIcon },
  { key: 'city',     label: 'City',     Icon: Building2 },
  { key: 'channel',  label: 'Channel',  Icon: Layers },
  { key: 'store',    label: 'Store',    Icon: Store },
  { key: 'category', label: 'Category', Icon: Tag },
  { key: 'colour',   label: 'Colour',   Icon: Palette },
  { key: 'size',     label: 'Size',     Icon: Ruler },
];

// Per-measure value accessor + formatter so one toggle re-skins every figure.
function measureValue(row, measure) {
  if (measure === 'gross') return Number(row.value_gross || 0);
  if (measure === 'cost')  return Number(row.value_cost || 0);
  return Number(row.stock_units || 0);
}
const measureFmt = (n, measure) => (measure === 'units' ? fmtNum(n) : fmtCr(n));
const measureLabel = (measure) => (measure === 'units' ? 'Units' : measure === 'gross' ? 'Gross value' : 'Cost value');

// ── HeaderField — one clean capsule (copied from sales.js for parity) ────────
function HeaderField({ label, value, onChange, options, minWidth = 120, title }) {
  return (
    <label
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 9, height: 34,
        padding: '0 6px 0 12px', borderRadius: 10,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        cursor: 'pointer', transition: 'border-color 180ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
    >
      <span style={{
        fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
        color: 'var(--text-muted)', fontFamily: 'var(--font-display)', whiteSpace: 'nowrap',
      }}>{label}</span>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          style={{
            height: 28, padding: '0 24px 0 6px', background: 'transparent', border: 'none',
            fontFamily: 'var(--font-body)', fontSize: 12.5, fontWeight: 700,
            color: 'var(--text-primary)', cursor: 'pointer', appearance: 'none',
            WebkitAppearance: 'none', MozAppearance: 'none', outline: 'none', minWidth,
          }}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <svg style={{ position: 'absolute', right: 6, pointerEvents: 'none', opacity: 0.5 }}
          width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </label>
  );
}

// ── KPI card (sx-card hero, mirrors network.js) ─────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, accent = '#3B82F6', loading }) {
  return (
    <div className="sx-card" style={{ padding: '18px 20px 16px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 14, right: 14, height: 2,
        background: `linear-gradient(90deg, ${accent}, ${accent}cc)`, borderRadius: 2, opacity: 0.85 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, marginTop: 4 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: `${accent}14`, color: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={14} strokeWidth={2} />
        </div>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase', color: T.secondary }}>{label}</span>
      </div>
      {loading
        ? <div className="sx-shimmer" style={{ height: 30, width: '70%', borderRadius: 6 }} />
        : <div className="sx-hero-num" style={{ fontSize: 26, marginBottom: 6 }}>{value}</div>}
      {sub && <div style={{ fontSize: 12, fontWeight: 600, color: T.secondary, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

// ── Section title (mirrors network.js) ──────────────────────────────────────
function SectionTitle({ icon: Icon, label, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
      <span style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--bg-elevated)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={13} color={T.primary} strokeWidth={2.4} />
      </span>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 800,
        letterSpacing: '-0.01em', color: T.primary }}>{label}</span>
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}

// Line palette (brand-led, distinct hues for multi-line series)
const LINE_COLORS = ['#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6', '#F97316'];

export default function StockAvailabilityPage() {
  const { preset, setPreset, setCustom, fromISO, toISO } = useTimeRange('mtd');
  const { isDark } = useTheme();
  const [mode, setMode]       = useState('active');
  const [measure, setMeasure] = useState('units');
  const [viewBy, setViewBy]   = useState('state');

  // Geographic drill: state → city → store. Each entry narrows the scope.
  const [drill, setDrill] = useState([]); // [{ dim:'state', key, label }, ...]
  const [storeSel, setStoreSel] = useState(null); // { id, label } → opens panel

  // Effective table dimension = chosen viewBy, unless drilling overrides it.
  const effectiveGroupBy = useMemo(() => {
    if (drill.length === 0) return viewBy;
    const last = drill[drill.length - 1].dim;
    if (last === 'state') return 'city';
    if (last === 'city')  return 'store';
    return viewBy;
  }, [drill, viewBy]);

  // Filters derived from the drill path (state/city) sent to every endpoint.
  const drillFilters = useMemo(() => {
    const f = {};
    for (const d of drill) f[d.dim] = d.key;
    return f;
  }, [drill]);

  const baseParams = useMemo(() => ({
    status: mode, measure, ...drillFilters,
  }), [mode, measure, drillFilters]);

  // ── Data state ──────────────────────────────────────────────────────────
  const [summary, setSummary] = useState(null);
  const [trend, setTrend]     = useState(null);
  const [pivot, setPivot]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [storeData, setStoreData] = useState(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sortBy, setSortBy] = useState('measure'); // measure | cover | delta | stores

  // Reset drill + store panel whenever the base View-by changes.
  const onViewByChange = useCallback((k) => {
    setViewBy(k); setDrill([]); setStoreSel(null);
  }, []);

  // ── Fetch summary + trend + pivot on any control change ───────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const p = { ...baseParams };
    Promise.all([
      stockAvailabilityService.getSummary({ as_of: toISO, ...p }),
      stockAvailabilityService.getTrend({ group_by: effectiveGroupBy, from: fromISO, to: toISO, top: 8, ...p }),
      stockAvailabilityService.getPivot({ group_by: effectiveGroupBy, as_of: toISO, ...p }),
    ])
      .then(([s, t, pv]) => {
        if (!alive) return;
        setSummary(s.data?.data || null);
        setTrend(t.data?.data || null);
        setPivot(pv.data?.data || null);
      })
      .catch((err) => { if (alive) notifyApiError(err, 'Failed to load stock availability'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [baseParams, effectiveGroupBy, fromISO, toISO]);

  // ── Fetch per-store trend when a store is selected ────────────────────────
  useEffect(() => {
    if (!storeSel) { setStoreData(null); return; }
    let alive = true;
    setStoreLoading(true);
    stockAvailabilityService.getStoreTrend(storeSel.id, { from: fromISO, to: toISO })
      .then((r) => { if (alive) setStoreData(r.data?.data || null); })
      .catch((err) => { if (alive) notifyApiError(err, 'Failed to load store detail'); })
      .finally(() => { if (alive) setStoreLoading(false); });
    return () => { alive = false; };
  }, [storeSel, fromISO, toISO]);

  // ── Drill handlers ────────────────────────────────────────────────────────
  const drillInto = useCallback((row) => {
    if (effectiveGroupBy === 'store') {
      setStoreSel({ id: row.key, label: row.label });
      return;
    }
    if (effectiveGroupBy === 'state' || effectiveGroupBy === 'city') {
      setDrill((d) => [...d, { dim: effectiveGroupBy, key: row.label, label: row.label }]);
    }
    // channel/category/colour/size rows aren't drillable (no sub-level).
  }, [effectiveGroupBy]);

  const breadcrumbTo = useCallback((idx) => {
    setStoreSel(null);
    setDrill((d) => d.slice(0, idx));
  }, []);

  // Heatmap shows only at the State level (base or reset).
  const showHeatmap = effectiveGroupBy === 'state';
  const heatmapData = useMemo(() => {
    if (!showHeatmap || !pivot?.rows) return [];
    return pivot.rows.map((r) => ({
      state_name: r.label,
      net_value: measureValue(r, measure),
      units_sold: r.stock_units,
      store_count: r.store_count,
      units_returned: 0,
    }));
  }, [showHeatmap, pivot, measure]);

  // Sorted pivot rows for the table.
  const sortedRows = useMemo(() => {
    const rows = [...(pivot?.rows || [])];
    const cmp = {
      measure: (a, b) => measureValue(b, measure) - measureValue(a, measure),
      stores:  (a, b) => b.store_count - a.store_count,
      cover:   (a, b) => (b.cover_days ?? -1) - (a.cover_days ?? -1),
      delta:   (a, b) => (b.delta_vs_30d_pct ?? -1e9) - (a.delta_vs_30d_pct ?? -1e9),
    }[sortBy] || (() => 0);
    return rows.sort(cmp);
  }, [pivot, measure, sortBy]);

  const dimLabel = (VIEW_BY.find((v) => v.key === effectiveGroupBy)?.label) || effectiveGroupBy;
  const isDrillable = effectiveGroupBy === 'state' || effectiveGroupBy === 'city' || effectiveGroupBy === 'store';

  // ── Apexcharts: multi-line stock-on-hand trend ────────────────────────────
  const axisColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.55)';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';

  const trendOptions = useMemo(() => ({
    chart: { type: 'line', fontFamily: 'Inter, system-ui, sans-serif', toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: true, speed: 500 }, background: 'transparent' },
    colors: LINE_COLORS,
    stroke: { width: 2.5, curve: 'smooth' },
    markers: { size: (trend?.dates?.length || 0) <= 2 ? 5 : 0, hover: { size: 6 } },
    dataLabels: { enabled: false },
    legend: { show: true, position: 'bottom', fontSize: '12px', labels: { colors: axisColor }, markers: { width: 9, height: 9, radius: 9 } },
    grid: { borderColor: gridColor, strokeDashArray: 4, padding: { left: 6, right: 12 } },
    xaxis: {
      type: 'category', categories: trend?.dates || [],
      labels: { style: { colors: axisColor, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { colors: axisColor, fontSize: '11px' }, formatter: (v) => measureFmt(v, measure) } },
    tooltip: { theme: isDark ? 'dark' : 'light', y: { formatter: (v) => measureFmt(v, measure) } },
  }), [trend, measure, axisColor, gridColor, isDark]);

  const trendSeries = useMemo(
    () => (trend?.series || []).map((s) => ({ name: s.label, data: s.points.map((p) => p.value) })),
    [trend]
  );

  // ── Apexcharts: store dual-axis (stock line + sales bars) ─────────────────
  const storeOptions = useMemo(() => ({
    chart: { type: 'line', fontFamily: 'Inter, system-ui, sans-serif', toolbar: { show: false }, zoom: { enabled: false }, stacked: false, background: 'transparent' },
    colors: ['#3B82F6', '#EF4444'],
    stroke: { width: [3, 0], curve: 'smooth' },
    plotOptions: { bar: { columnWidth: '55%', borderRadius: 2 } },
    dataLabels: { enabled: false },
    legend: { show: true, position: 'bottom', labels: { colors: axisColor } },
    grid: { borderColor: gridColor, strokeDashArray: 4 },
    xaxis: {
      type: 'category', categories: (storeData?.series || []).map((s) => s.date),
      labels: { style: { colors: axisColor, fontSize: '11px' }, rotate: -30, hideOverlappingLabels: true },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: [
      { seriesName: 'Stock on hand', labels: { style: { colors: axisColor, fontSize: '11px' }, formatter: (v) => fmtNum(Math.round(v)) }, title: { text: 'Stock on hand', style: { color: axisColor } } },
      { opposite: true, seriesName: 'Units sold', labels: { style: { colors: axisColor, fontSize: '11px' }, formatter: (v) => fmtNum(Math.round(v)) }, title: { text: 'Units sold/day', style: { color: axisColor } } },
    ],
    tooltip: { theme: isDark ? 'dark' : 'light', shared: true },
  }), [storeData, axisColor, gridColor, isDark]);

  const storeSeries = useMemo(() => ([
    { name: 'Stock on hand', type: 'line',   data: (storeData?.series || []).map((s) => s.stock_on_hand) },
    { name: 'Units sold',    type: 'column', data: (storeData?.series || []).map((s) => s.units_sold) },
  ]), [storeData]);

  // ── CSV export ────────────────────────────────────────────────────────────
  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const res = await stockAvailabilityService.exportCsv({ group_by: effectiveGroupBy, as_of: toISO, ...baseParams });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = `stock-availability-${effectiveGroupBy}-${toISO}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) { notifyApiError(err, 'Export failed'); }
    finally { setExporting(false); }
  }, [effectiveGroupBy, toISO, baseParams]);

  // Granularity note for the hero chart (honest about month-end-only history).
  const granNote = trend?.granularity === 'monthly'
    ? 'Month-end snapshots only for this range'
    : trend?.granularity === 'mixed'
      ? 'Mixed daily + month-end snapshots'
      : null;

  // ── headerSlot: period pills + Status + Measure (Network/Sales idiom) ─────
  const headerSlot = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <TimeRangeControl preset={preset} onChange={setPreset} />
      <div style={{ width: 1, height: 22, background: 'var(--border-subtle)' }} />
      <HeaderField label="Status" value={mode} onChange={setMode} options={STATUS_OPTIONS} minWidth={104}
        title="Which subset of the network to count" />
      <HeaderField label="Measure" value={measure} onChange={setMeasure} options={MEASURE_OPTIONS} minWidth={96}
        title="Units, Gross (qty×MRP) or Cost (qty×cost price)" />
    </div>
  );

  return (
    <DashboardLayout
      title="Stock Availability"
      subtitle="Stock-on-hand over time — daily trends across state, city, channel, store, category, colour & size"
      headerSlot={headerSlot}
      hideSync={true}
    >
      <div className="sx-page sx-fade">
        {/* ── KPI strip ── */}
        <div className="sa-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0,1fr))', gap: 12, marginBottom: 18 }}>
          <KpiCard icon={Boxes} label="Stock Units" accent="#3B82F6" loading={loading}
            value={fmtNum(summary?.stock_units)} sub={summary?.as_of ? `as of ${summary.as_of}` : '—'} />
          <KpiCard icon={IndianRupee} label={measure === 'cost' ? 'Stock Cost' : 'Stock Value'} accent="#10B981" loading={loading}
            value={fmtCr(measure === 'cost' ? summary?.value_cost : summary?.value_gross)} sub={measure === 'cost' ? 'qty × cost' : 'qty × MRP'} />
          <KpiCard icon={Store} label="Stores" accent="#F59E0B" loading={loading}
            value={fmtNum(summary?.store_count)} sub="with stock on hand" />
          <KpiCard icon={Package} label="SKUs" accent="#A855F7" loading={loading}
            value={fmtNum(summary?.sku_count)} sub="distinct in stock" />
          <KpiCard icon={Layers} label="Avg / Store" accent="#EC4899" loading={loading}
            value={fmtNum(summary?.avg_per_store)} sub="units per store" />
          <KpiCard icon={summary?.delta_units_vs_30d_pct >= 0 ? TrendingUp : TrendingDown}
            label="Δ vs 30d" accent={summary?.delta_units_vs_30d_pct >= 0 ? '#10B981' : '#EF4444'} loading={loading}
            value={summary?.delta_units_vs_30d_pct == null ? '—' : `${summary.delta_units_vs_30d_pct > 0 ? '+' : ''}${summary.delta_units_vs_30d_pct}%`}
            sub="units vs ~30d ago" />
        </div>

        {/* ── HERO: store panel (if a store is open) OR the multi-line trend ── */}
        {storeSel ? (
          <div className="sx-card" style={{ padding: 20, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <button onClick={() => setStoreSel(null)} className="sa-back"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent',
                  border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
                  color: T.secondary, fontSize: 12, fontWeight: 700 }}>
                <ArrowLeft size={13} /> Back
              </button>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 800, color: T.primary }}>
                {storeData?.store ? `${storeData.store.code} · ${storeData.store.name}` : storeSel.label}
              </div>
              {storeData?.store && (
                <span style={{ fontSize: 12, fontWeight: 600, color: T.muted }}>
                  {storeData.store.city}, {storeData.store.state} · {storeData.store.channel}
                </span>
              )}
            </div>

            {storeLoading ? (
              <div className="sx-shimmer" style={{ height: 320, borderRadius: 10 }} />
            ) : storeData ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
                  <StatCard icon={Boxes}    label="Stock now"      value={fmtNum(storeData.summary.stock_now)} accent="#3B82F6" />
                  <StatCard icon={BarChart2} label="Avg stock"      value={fmtNum(storeData.summary.avg_stock)} accent="#A855F7" />
                  <StatCard icon={Activity}  label="Avg sale/day"   value={fmtNum(storeData.summary.avg_sale_per_day)} accent="#EF4444" />
                  <StatCard icon={Clock}     label="Cover days"     value={storeData.summary.cover_days == null ? '—' : `${storeData.summary.cover_days}d`} accent="#10B981" />
                </div>
                {storeData.series?.length ? (
                  <Chart options={storeOptions} series={storeSeries} type="line" height={320} />
                ) : <Empty label="No snapshots for this store in the selected range" />}
                {storeData.recommendation && (
                  <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10,
                    background: 'var(--bg-elevated)', border: `1px solid ${T.border}`,
                    fontSize: 13, fontWeight: 600, color: T.secondary, lineHeight: 1.5 }}>
                    <strong style={{ color: T.primary }}>Recommendation · </strong>{storeData.recommendation}
                  </div>
                )}
              </>
            ) : <Empty label="No data" />}
          </div>
        ) : (
          <div className="sx-card" style={{ padding: 20, marginBottom: 18 }}>
            <SectionTitle icon={TrendingUp} label={`Stock on hand over time · by ${dimLabel}`}
              right={granNote && <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>{granNote}</span>} />
            {loading ? (
              <div className="sx-shimmer" style={{ height: 340, borderRadius: 10 }} />
            ) : trendSeries.length && (trend?.dates?.length) ? (
              <Chart options={trendOptions} series={trendSeries} type="line" height={340} />
            ) : <Empty label="No stock snapshots in this date range" />}
          </div>
        )}

        {/* ── View-by switch + breadcrumb + export ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="sa-viewby" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, padding: 4,
            background: 'var(--bg-elevated)', border: `1px solid ${T.border}`, borderRadius: 12 }}>
            {VIEW_BY.map(({ key, label, Icon }) => {
              const active = viewBy === key;
              return (
                <button key={key} onClick={() => onViewByChange(key)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
                    border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-body)',
                    background: active ? T.accent : 'transparent', color: active ? '#fff' : T.secondary,
                    transition: 'all 150ms ease' }}>
                  <Icon size={13} /> {label}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onExport} disabled={exporting || !pivot?.rows?.length}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 9,
              border: `1px solid ${T.border}`, background: 'var(--bg-elevated)', cursor: exporting ? 'wait' : 'pointer',
              color: T.primary, fontSize: 12, fontWeight: 700, opacity: pivot?.rows?.length ? 1 : 0.5 }}>
            <Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>

        {/* Breadcrumb (drill path) */}
        {drill.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, flexWrap: 'wrap', fontSize: 13 }}>
            <button onClick={() => breadcrumbTo(0)} style={crumbBtn}>All</button>
            {drill.map((d, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ChevronRight size={13} color={T.muted} />
                <button onClick={() => breadcrumbTo(i + 1)}
                  style={{ ...crumbBtn, color: i === drill.length - 1 ? T.primary : T.secondary, fontWeight: i === drill.length - 1 ? 800 : 700 }}>
                  {d.label}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* ── State choropleth (reused IndiaHeatmap, scoped v2-app for tokens) ── */}
        {showHeatmap && !storeSel && (
          <div className={`v2-app${isDark ? ' theme-dark' : ''}`} style={{ marginBottom: 18, background: 'transparent' }}>
            <IndiaHeatmap
              data={heatmapData}
              loading={loading}
              title="India · Stock by State"
              metricLabel={measureLabel(measure)}
              valueFormatter={(v) => measureFmt(v, measure)}
              onStateClick={(s) => setDrill((d) => [...d, { dim: 'state', key: s, label: s }])}
            />
          </div>
        )}

        {/* ── Pivot table ── */}
        <div className="sx-card" style={{ overflow: 'hidden', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: T.accent, letterSpacing: '0.10em', textTransform: 'uppercase' }}>
              By {dimLabel}
            </span>
            {!loading && pivot?.rows && (
              <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: T.accent, borderRadius: 100, padding: '2px 8px' }}>
                {fmtNum(pivot.rows.length)}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <HeaderField label="Sort" value={sortBy} onChange={setSortBy} minWidth={92}
              options={[
                { value: 'measure', label: measureLabel(measure) },
                { value: 'stores',  label: 'Stores' },
                { value: 'cover',   label: 'Cover days' },
                { value: 'delta',   label: 'Δ vs 30d' },
              ]} />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-card-hover)' }}>
                  {[dimLabel, 'Stores', measure === 'units' ? 'Stock now' : 'Stock now (u)', measure !== 'units' ? measureLabel(measure) : null, '30d avg', 'Δ vs 30d', 'Cover days']
                    .filter(Boolean).map((h) => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: h === dimLabel ? 'left' : 'right', fontSize: 10, fontWeight: 800,
                      color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && !pivot ? (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i}><td colSpan={7} style={{ padding: '10px 14px' }}><div className="sx-shimmer" style={{ height: 14, borderRadius: 4 }} /></td></tr>
                  ))
                ) : sortedRows.length ? sortedRows.map((r, i) => (
                  <tr key={r.key || i}
                    onClick={() => isDrillable && drillInto(r)}
                    style={{ borderBottom: `1px solid ${T.border}`, cursor: isDrillable ? 'pointer' : 'default',
                      background: i % 2 === 0 ? 'transparent' : 'var(--row-stripe)' }}
                    onMouseEnter={(e) => { if (isDrillable) e.currentTarget.style.background = 'var(--row-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--row-stripe)'; }}>
                    <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 800, color: T.primary, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        {r.label || '—'}
                        {isDrillable && <ChevronRight size={13} color={T.muted} />}
                      </span>
                    </td>
                    <td style={{ ...td }}>{fmtNum(r.store_count)}</td>
                    <td style={{ ...td, fontWeight: 900, color: T.primary }}>{fmtNum(r.stock_units)}</td>
                    {measure !== 'units' && <td style={{ ...td, color: '#059669', fontWeight: 800 }}>{measure === 'cost' ? fmtCr(r.value_cost) : fmtCr(r.value_gross)}</td>}
                    <td style={{ ...td }}>{fmtNum(r.avg_30d)}</td>
                    <td style={{ ...td, color: r.delta_vs_30d_pct == null ? T.muted : r.delta_vs_30d_pct >= 0 ? '#059669' : '#DC2626', fontWeight: 800 }}>
                      {r.delta_vs_30d_pct == null ? '—' : `${r.delta_vs_30d_pct > 0 ? '+' : ''}${r.delta_vs_30d_pct}%`}
                    </td>
                    <td style={{ ...td }}>{r.cover_days == null ? '—' : `${r.cover_days}d`}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={7} style={{ padding: '40px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: T.muted }}>No data for this selection</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 1100px) { :global(.sa-kpis) { grid-template-columns: repeat(3, minmax(0,1fr)) !important; } }
        @media (max-width: 640px)  { :global(.sa-kpis) { grid-template-columns: repeat(2, minmax(0,1fr)) !important; } }
      `}</style>
    </DashboardLayout>
  );
}

const td = { padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: 'var(--text-secondary, #CBD5E1)', whiteSpace: 'nowrap' };
const crumbBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #CBD5E1)', fontSize: 13, fontWeight: 700, padding: '2px 4px', fontFamily: 'var(--font-body)' };

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: `1px solid ${T.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon size={13} color={accent} strokeWidth={2.2} />
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }}>{label}</span>
      </div>
      <div className="sx-hero-num" style={{ fontSize: 22 }}>{value}</div>
    </div>
  );
}

function Empty({ label }) {
  return (
    <div style={{ minHeight: 220, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 10, color: 'var(--text-muted)' }}>
      <Boxes size={28} strokeWidth={1.6} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
    </div>
  );
}
