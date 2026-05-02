import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import {
  Package, DollarSign, IndianRupee, AlertTriangle, Truck, RefreshCw,
  TrendingUp, TrendingDown, Layers, BarChart3, MapPin,
  CheckCircle, XCircle, AlertCircle, Info, Search, Bell,
  Building2, ShoppingBag, Award, RotateCcw, Calendar, Sparkles, Target,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import {
  inventoryService, analyticsService, syncService,
  skuService, dispatchService,
} from '../lib/services';
import { formatNumber, formatCurrency, timeAgo } from '../lib/utils';
import { getCached, setCached, isFresh } from '../lib/dashboardCache';
import { useFilters } from '../lib/useFilters';
import FilterBar from '../components/filters/FilterBar';
import FilterChips from '../components/filters/FilterChips';
import PremiumKpi from '../components/ui/PremiumKpi';
import CrossPivotTables from '../components/overview/CrossPivotTables';
import DrilldownDrawer from '../components/sales/DrilldownDrawer';
import toast from 'react-hot-toast';
import { notifyApiError } from '../lib/notifyApiError';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const PALETTE = ['#C0392B', '#0284C7', '#059669', '#D97706', '#DC2626', '#0D9488', '#E74C3C', '#EA580C'];

// ─── Section header with optional hint line ──────────────────────────────────
// ── Sale-mode pill (Sale / Return / Net) — same shape as the one used on
// the Sales page so the executive sees one consistent control language.
function ExecModePill({ mode, onChange }) {
  const OPTS = [
    { key: 'sale',   label: 'Sale',   color: '#2563EB' },
    { key: 'return', label: 'Return', color: '#F43F5E' },
    { key: 'net',    label: 'Net',    color: '#059669' },
  ];
  const idx     = Math.max(0, OPTS.findIndex(o => o.key === mode));
  const segPct  = 100 / OPTS.length;
  const accent  = OPTS[idx]?.color || '#0B1220';
  return (
    <div style={{
      display: 'inline-flex', position: 'relative',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: 999, padding: 3, height: 32,
    }}>
      <span style={{
        position: 'absolute', top: 3, bottom: 3,
        left:  `calc(${idx * segPct}% + 3px)`,
        width: `calc(${segPct}% - 6px)`,
        background: 'rgba(255,255,255,0.10)',
        borderRadius: 999,
        boxShadow: `0 1px 4px rgba(0,0,0,0.30), 0 0 0 1px ${accent}50`,
        transition: 'left 220ms cubic-bezier(0.16,1,0.3,1), width 220ms, box-shadow 200ms',
      }} />
      {OPTS.map(o => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)}
          style={{
            position: 'relative', zIndex: 1,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0 14px',
            fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.02em',
            color: mode === o.key ? o.color : 'var(--text-muted)',
            transition: 'color 200ms',
          }}>{o.label}</button>
      ))}
    </div>
  );
}

function Section({ title, hint, icon: Icon, color = '#C0392B', children, mb = 28 }) {
  return (
    <div style={{ marginBottom: mb }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: hint ? 6 : 16 }}>
        {Icon && <Icon size={15} color={color} strokeWidth={2} />}
        <span style={{
          fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)',
        }}>
          {title}
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--bg-elevated)' }} />
      </div>
      {hint && (
        <p style={{
          fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16,
          fontFamily: 'var(--font-body)', lineHeight: 1.6,
          display: 'flex', alignItems: 'flex-start', gap: 6,
        }}>
          <Info size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--text-muted)' }} />
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

// ─── Simple KPI card used on this page ──────────────────────────────────────
function KpiBox({ label, value, sub, icon: Icon, color, loading }) {
  return (
    <div className="kpi-card">
      <div className="kpi-icon" style={{ background: `${color}15`, color }}>
        <Icon size={19} strokeWidth={2} />
      </div>
      <div className="kpi-label">{label}</div>
      {loading
        ? <div className="skeleton" style={{ height: 36, width: '65%', marginBottom: 10 }} />
        : <div className="kpi-value">{value}</div>
      }
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ─── One row in the "Store type" breakdown ───────────────────────────────────
function StoreTypeBar({ name, stock, total, color, count }) {
  const pct = total > 0 ? Math.round((stock / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{name}</span>
          <span style={{
            fontSize: 12, color: 'var(--text-muted)',
            background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 100,
          }}>
            {formatNumber(count)} locations
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color, fontFamily: 'var(--font-display)' }}>
            {formatNumber(stock)} units
          </span>
          <span style={{
            fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
            background: 'var(--bg-elevated)', padding: '2px 8px',
            borderRadius: 100, minWidth: 44, textAlign: 'center',
          }}>
            {pct}%
          </span>
        </div>
      </div>
      <div style={{ height: 9, background: 'var(--bg-elevated)', borderRadius: 100, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color,
          borderRadius: 100, transition: 'width 1.2s ease',
        }} />
      </div>
    </div>
  );
}

// ─── One alert type row ───────────────────────────────────────────────────────
function AlertBox({ icon: Icon, color, title, description, count }) {
  const compact = count >= 1000 ? formatNumber(count) : count;
  const exact   = count.toLocaleString('en-IN');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '13px 16px', borderRadius: 12,
      background: count > 0 ? `${color}08` : '#F0FDF4',
      border: `1px solid ${count > 0 ? color + '25' : '#BBF7D0'}`,
      marginBottom: 10,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: count > 0 ? `${color}15` : '#DCFCE7',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={18} color={count > 0 ? color : '#059669'} strokeWidth={2} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {count > 0 ? description : 'No issues detected ✓'}
        </div>
      </div>
      <div
        title={count > 0 ? `Exact count: ${exact}` : undefined}
        style={{
          fontSize: 26, fontWeight: 800,
          color: count > 0 ? color : '#059669',
          fontFamily: 'var(--font-display)', lineHeight: 1,
          minWidth: 40, textAlign: 'right',
          cursor: count > 0 ? 'help' : 'default',
        }}
      >
        {compact}
      </div>
    </div>
  );
}

// ─── One aging bucket row ─────────────────────────────────────────────────────
function AgingRow({ label, hint, qty, total, color, emoji }) {
  const pct = total > 0 ? Math.round((qty / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: 'var(--font-display)' }}>
            {formatNumber(qty)} units
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pct}% of total</div>
        </div>
      </div>
      <div style={{ height: 8, background: 'var(--bg-elevated)', borderRadius: 100, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color,
          borderRadius: 100, transition: 'width 1.2s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Sales Rankings Section ───────────────────────────────────────────────────
const COLOR_TOP_OPTIONS = [5, 10, 15, 20, 50, 100, 200];

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

// Client-side category matcher — mirrors backend CATEGORY_PATTERNS exactly.
// Used by sections that filter pre-loaded rows (e.g. Stock Alerts) without
// re-hitting the API. Substring match is case-insensitive via toLowerCase().
const CATEGORY_KEYWORDS = {
  denim:       { include: ['denim', 'jean'],                                                 exclude: [] },
  shirt:       { include: ['shirt'],                                                         exclude: ['t-shirt', 'tshirt', 't shirt', 'sweatshirt', 'sweat shirt'] },
  't-shirt':   { include: ['t-shirt', 'tshirt', 't shirt'],                                  exclude: [] },
  trouser:     { include: ['trouser', 'chino', 'cargo', 'pant'],                             exclude: ['innerwear', 'jogger'] },
  innerwear:   { include: ['boxer', 'brief', 'trunk', 'innerwear', 'vest'],                  exclude: [] },
  sweatshirt:  { include: ['sweatshirt', 'sweat shirt', 'hoodie', 'hooded', 'sweater', 'pullover'], exclude: [] },
  jacket:      { include: ['jacket', 'blazer', 'coat'],                                      exclude: [] },
  accessories: { include: ['belt', 'wallet', 'cap', 'bag', 'scarf', 'tie', 'glove'],         exclude: [] },
  socks:       { include: ['sock'],                                                          exclude: [] },
  fragrance:   { include: ['perfume', 'deo', 'fragrance', 'cologne'],                        exclude: [] },
};
function matchesCategory(productName, category) {
  if (!category) return true;
  const def = CATEGORY_KEYWORDS[category];
  if (!def) return true;
  const p = (productName || '').toLowerCase();
  if (!p) return false;
  if (def.exclude.some(k => p.includes(k))) return false;
  return def.include.some(k => p.includes(k));
}

function SalesRankingsSection({ salesTop: initialData, loading: initialLoading }) {
  const [colorTopN,   setColorTopN]  = useState(15);
  const [sizeTopN,    setSizeTopN]   = useState(15);
  const [storeTopN,   setStoreTopN]  = useState(15);
  const [dateFrom,    setDateFrom]   = useState('2025-01-01');
  const [dateTo,      setDateTo]     = useState('2026-01-31');
  const [selState,    setSelState]   = useState('');
  const [selCity,     setSelCity]    = useState('');
  const [selCategory, setSelCategory] = useState('');
  const [rankData,    setRankData]   = useState(initialData);
  const [rankLoading, setRankLoading] = useState(false);

  // Sync initial data when parent finishes loading
  useEffect(() => { if (initialData) setRankData(initialData); }, [initialData]);

  // Derive state/city lists from all_stores (same as sales page)
  const allStores = rankData?.all_stores || [];
  const stateList = useMemo(() => [...new Set(allStores.map(r => r.state).filter(Boolean))].sort(), [allStores]);
  const cityList  = useMemo(() => {
    const base = selState ? allStores.filter(r => r.state === selState) : allStores;
    return [...new Set(base.map(r => r.city).filter(Boolean))].sort();
  }, [allStores, selState]);

  const fetchRankings = useCallback(async () => {
    setRankLoading(true);
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      if (selState)    params.state    = selState;
      if (selCity)     params.city     = selCity;
      if (selCategory) params.category = selCategory;
      const res = await analyticsService.getSalesAnalytics(params);
      setRankData(res.data.data);
    } catch (_) {}
    setRankLoading(false);
  }, [dateFrom, dateTo, selState, selCity, selCategory]);

  const data    = rankData;
  const loading = initialLoading || rankLoading;

  const fmtV   = v => v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
  const fmtRev = v => v >= 10000000 ? '₹' + (v / 10000000).toFixed(1) + 'Cr'
                    : v >= 100000    ? '₹' + (v / 100000).toFixed(1) + 'L'
                    : '₹' + v.toLocaleString('en-IN');
  const colorBarH   = n => n <= 10 ? '55%' : n <= 20 ? '62%' : n <= 50 ? '70%' : '78%';
  const colorChartH = n => Math.max(320, n * (n <= 20 ? 28 : n <= 50 ? 20 : 14));

  const inputStyle  = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)' };
  const selectStyle = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer', minWidth: 120 };

  return (
    <Section title="Sales Rankings" icon={BarChart3} color="#2563EB" mb={32}>
      {/* ── Filter bar: date + state + city ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Date Range</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
        <span style={{ fontSize: 13, fontWeight: 800, color: '#94a3b8' }}>→</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />

        <div style={{ width: 1, height: 22, background: '#e2e8f0', margin: '0 2px' }} />

        {/* State */}
        <div style={{ position: 'relative' }}>
          <select value={selState} onChange={e => { setSelState(e.target.value); setSelCity(''); }} style={selectStyle}>
            <option value="">All States</option>
            {stateList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>

        {/* Category — ILIKE-powered, beside State */}
        <div style={{ position: 'relative' }}>
          <select value={selCategory} onChange={e => setSelCategory(e.target.value)} style={selectStyle} title="Filter by product category (matched on product name)">
            {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>

        {/* City — filtered by state */}
        <div style={{ position: 'relative' }}>
          <select value={selCity} onChange={e => setSelCity(e.target.value)} style={selectStyle}>
            <option value="">All Cities</option>
            {cityList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>

        <button onClick={fetchRankings} style={{ padding: '5px 16px', borderRadius: 8, fontSize: 12, fontWeight: 800, background: '#2563EB', color: '#fff', border: 'none', cursor: 'pointer' }}>
          Apply
        </button>
        <button onClick={() => { setDateFrom('2025-01-01'); setDateTo('2026-01-31'); setSelState(''); setSelCity(''); setSelCategory(''); setTimeout(fetchRankings, 0); }} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>
          Reset
        </button>
      </div>

      <div style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 16 }}>
      {/* ── Colour chart — pastel green + Top N dropdown in header ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">Top {colorTopN} Colours by Units Sold</span>
          {/* Top-N dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
            <select
              value={colorTopN}
              onChange={e => setColorTopN(Number(e.target.value))}
              style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
            >
              {COLOR_TOP_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </div>
        </div>
        <div className="card-body" style={{ padding: '12px 0 0' }}>
          {loading || !data
            ? <div className="skeleton" style={{ height: colorChartH(colorTopN), margin: '0 16px 16px' }} />
            : <Chart type="bar" height={colorChartH(colorTopN)}
                options={{
                  chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false } },
                  plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: colorBarH(colorTopN), dataLabels: { position: 'right' } } },
                  colors: ['#6EE7B7'],
                  fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#34D399'], stops: [0, 100] } },
                  xaxis: { labels: { style: { colors: '#64748B', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                  yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                  dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtV },
                  grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 3 },
                  tooltip: { theme: 'dark', style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
                }}
                series={[{ name: 'Units Sold', data: (data?.by_color || []).slice(0, colorTopN).map(r => ({ x: r.color_name, y: Number(r.units_sold) })) }]}
              />
          }
        </div>
      </div>

      {/* ── Size + Store — original unchanged ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Top {sizeTopN} Sizes by Units Sold</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select
                value={sizeTopN}
                onChange={e => setSizeTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {[5, 10, 15, 20, 50].map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 0 0' }}>
            {loading || !data
              ? <div className="skeleton" style={{ height: Math.max(320, sizeTopN * 28), margin: '0 16px 16px' }} />
              : <Chart type="bar" height={Math.max(320, sizeTopN * 28)}
                  options={{
                    chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false } },
                    plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: sizeTopN <= 10 ? '55%' : sizeTopN <= 20 ? '62%' : '70%', dataLabels: { position: 'right' } } },
                    colors: ['#7DD3FC'],
                    fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#38BDF8'], stops: [0, 100] } },
                    xaxis: { labels: { style: { colors: '#64748B', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 700, fontSize: '12px' }, maxWidth: 80 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtV },
                    grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 3 },
                    tooltip: { theme: 'dark', style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
                  }}
                  series={[{ name: 'Units Sold', data: (data?.by_size || []).slice(0, sizeTopN).map(r => ({ x: r.size, y: Number(r.units_sold) })) }]}
                />
            }
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Top {storeTopN} Stores by Revenue</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select
                value={storeTopN}
                onChange={e => setStoreTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {COLOR_TOP_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 0 0' }}>
            {loading || !data
              ? <div className="skeleton" style={{ height: Math.max(300, storeTopN * 28), margin: '0 16px 16px' }} />
              : <Chart type="bar" height={Math.max(300, storeTopN * 28)}
                  options={{
                    chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false } },
                    plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: storeTopN <= 10 ? '55%' : storeTopN <= 20 ? '62%' : '70%', dataLabels: { position: 'right' } } },
                    colors: ['#FCA5A5'],
                    fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#F87171'], stops: [0, 100] } },
                    xaxis: { labels: { style: { colors: '#64748B', fontWeight: 600, fontSize: '11px' }, formatter: fmtRev }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtRev },
                    grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 3 },
                    tooltip: { theme: 'dark', style: { fontSize: '12px' }, y: { formatter: v => '₹' + v.toLocaleString('en-IN') } },
                  }}
                  series={[{ name: 'Revenue', data: (data?.by_store || []).slice(0, storeTopN).map(r => ({ x: r.location_name, y: Number(r.sales_value) })) }]}
                />
            }
          </div>
        </div>
      </div>
      </div>
    </Section>
  );
}

// ─── Returns Rankings Section ────────────────────────────────────────────────
function ReturnsRankingsSection({ salesTop: initialSalesData }) {
  const [colorTopN,    setColorTopN]   = useState(15);
  const [sizeTopN,     setSizeTopN]    = useState(15);
  const [storeTopN,    setStoreTopN]   = useState(15);
  const [dateFrom,     setDateFrom]    = useState('2025-01-01');
  const [dateTo,       setDateTo]      = useState('2026-01-31');
  const [selState,     setSelState]    = useState('');
  const [selCity,      setSelCity]     = useState('');
  const [selCategory,  setSelCategory] = useState('');
  const [data,         setData]        = useState(null);
  const [loading,      setLoading]     = useState(true);

  const allStores = initialSalesData?.all_stores || [];
  const stateList = useMemo(() => [...new Set(allStores.map(r => r.state).filter(Boolean))].sort(), [allStores]);
  const cityList  = useMemo(() => {
    const base = selState ? allStores.filter(r => r.state === selState) : allStores;
    return [...new Set(base.map(r => r.city).filter(Boolean))].sort();
  }, [allStores, selState]);

  const doFetch = useCallback(async (params) => {
    setLoading(true);
    try {
      const res = await analyticsService.getReturnsAnalytics(params);
      setData(res.data.data);
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { doFetch({ date_from: '2025-01-01', date_to: '2026-01-31' }); }, [doFetch]);

  const fmtV   = v => v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
  const fmtRev = v => v >= 10000000 ? '₹' + (v / 10000000).toFixed(1) + 'Cr'
                    : v >= 100000    ? '₹' + (v / 100000).toFixed(1) + 'L'
                    : '₹' + v.toLocaleString('en-IN');
  const barH   = n => n <= 10 ? '55%' : n <= 20 ? '62%' : n <= 50 ? '70%' : '78%';
  const chartH = n => Math.max(320, n * (n <= 20 ? 28 : n <= 50 ? 20 : 14));

  const inputStyle  = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)' };
  const selectStyle = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer', minWidth: 120 };

  return (
    <Section title="Return Rankings" icon={TrendingDown} color="#EA580C" mb={32}>
      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Date Range</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
        <span style={{ fontSize: 13, fontWeight: 800, color: '#94a3b8' }}>→</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
        <div style={{ width: 1, height: 22, background: '#e2e8f0', margin: '0 2px' }} />
        <div style={{ position: 'relative' }}>
          <select value={selState} onChange={e => { setSelState(e.target.value); setSelCity(''); }} style={selectStyle}>
            <option value="">All States</option>
            {stateList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div style={{ position: 'relative' }}>
          <select value={selCategory} onChange={e => setSelCategory(e.target.value)} style={selectStyle} title="Filter by product category (matched on product name)">
            {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div style={{ position: 'relative' }}>
          <select value={selCity} onChange={e => setSelCity(e.target.value)} style={selectStyle}>
            <option value="">All Cities</option>
            {cityList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button onClick={() => doFetch({ date_from: dateFrom, date_to: dateTo, ...(selState && { state: selState }), ...(selCity && { city: selCity }), ...(selCategory && { category: selCategory }) })}
          style={{ padding: '5px 16px', borderRadius: 8, fontSize: 12, fontWeight: 800, background: '#EA580C', color: '#fff', border: 'none', cursor: 'pointer' }}>Apply</button>
        <button onClick={() => { setDateFrom('2025-01-01'); setDateTo('2026-01-31'); setSelState(''); setSelCity(''); setSelCategory(''); doFetch({ date_from: '2025-01-01', date_to: '2026-01-31' }); }}
          style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>Reset</button>
      </div>

      <div style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 16 }}>
      {/* Colour chart — orange tones */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">Top {colorTopN} Colours by Units Returned</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
            <select value={colorTopN} onChange={e => setColorTopN(Number(e.target.value))}
              style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}>
              {COLOR_TOP_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </div>
        </div>
        <div className="card-body" style={{ padding: '12px 0 0' }}>
          {loading || !data
            ? <div className="skeleton" style={{ height: chartH(colorTopN), margin: '0 16px 16px' }} />
            : <Chart key={`ret-color-${colorTopN}`} type="bar" height={chartH(colorTopN)}
                options={{
                  chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false } },
                  plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: barH(colorTopN), dataLabels: { position: 'right' } } },
                  colors: ['#FDBA74'],
                  fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#F97316'], stops: [0, 100] } },
                  xaxis: { labels: { style: { colors: '#64748B', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                  yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                  dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtV },
                  grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 3 },
                  tooltip: { theme: 'dark', style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
                }}
                series={[{ name: 'Units Returned', data: (data?.by_color || []).slice(0, colorTopN).map(r => ({ x: r.color_name, y: Number(r.return_units) })) }]}
              />
          }
        </div>
      </div>

      {/* Size + Store */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Top {sizeTopN} Sizes by Units Returned</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select value={sizeTopN} onChange={e => setSizeTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}>
                {[5, 10, 15, 20, 50].map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 0 0' }}>
            {loading || !data
              ? <div className="skeleton" style={{ height: Math.max(320, sizeTopN * 28), margin: '0 16px 16px' }} />
              : <Chart key={`ret-size-${sizeTopN}`} type="bar" height={Math.max(320, sizeTopN * 28)}
                  options={{
                    chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false } },
                    plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: barH(sizeTopN), dataLabels: { position: 'right' } } },
                    colors: ['#FCA5A5'],
                    fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#C0392B'], stops: [0, 100] } },
                    xaxis: { labels: { style: { colors: '#64748B', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 700, fontSize: '12px' }, maxWidth: 80 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtV },
                    grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 3 },
                    tooltip: { theme: 'dark', style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
                  }}
                  series={[{ name: 'Units Returned', data: (data?.by_size || []).slice(0, sizeTopN).map(r => ({ x: r.size, y: Number(r.return_units) })) }]}
                />
            }
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Top {storeTopN} Stores by Units Returned</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select value={storeTopN} onChange={e => setStoreTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}>
                {COLOR_TOP_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 0 0' }}>
            {loading || !data
              ? <div className="skeleton" style={{ height: Math.max(300, storeTopN * 28), margin: '0 16px 16px' }} />
              : <Chart key={`ret-store-${storeTopN}`} type="bar" height={Math.max(300, storeTopN * 28)}
                  options={{
                    chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false } },
                    plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: barH(storeTopN), dataLabels: { position: 'right' } } },
                    colors: ['#F9A8D4'],
                    fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#EC4899'], stops: [0, 100] } },
                    xaxis: { labels: { style: { colors: '#64748B', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtV },
                    grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 3 },
                    tooltip: { theme: 'dark', style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
                  }}
                  series={[{ name: 'Units Returned', data: (data?.by_store || []).slice(0, storeTopN).map(r => ({ x: r.location_name, y: Number(r.return_units) })) }]}
                />
            }
          </div>
        </div>
      </div>
      </div>
    </Section>
  );
}

// ─── Size & Colour Distribution Section ──────────────────────────────────────
const SIZE_TOP_OPTIONS   = [5, 10, 15, 20, 30, 50, 100];
const COLOR_SIZE_OPTIONS = [5, 10, 20, 50, 100, 200];

function SizeColorSection({ initialSizes, initialColors, allStoresData, pageLoading }) {
  const [sizeTopN,    setSizeTopN]    = useState(10);
  const [colorTopN,   setColorTopN]   = useState(10);
  const [dateFrom,    setDateFrom]    = useState('');
  const [dateTo,      setDateTo]      = useState('');
  const [selState,    setSelState]    = useState('');
  const [selCity,     setSelCity]     = useState('');
  const [selCategory, setSelCategory] = useState('');
  const [sizesData,   setSizesData]   = useState(initialSizes  || []);
  const [colorsData,  setColorsData]  = useState(initialColors || []);
  const [scLoading,   setScLoading]   = useState(false);

  useEffect(() => { if (initialSizes?.length)  setSizesData(initialSizes);  }, [initialSizes]);
  useEffect(() => { if (initialColors?.length) setColorsData(initialColors); }, [initialColors]);

  const allStores = allStoresData?.all_stores || [];
  const stateList = useMemo(() => [...new Set(allStores.map(r => r.state).filter(Boolean))].sort(), [allStores]);
  const cityList  = useMemo(() => {
    const base = selState ? allStores.filter(r => r.state === selState) : allStores;
    return [...new Set(base.map(r => r.city).filter(Boolean))].sort();
  }, [allStores, selState]);

  const doFetchSC = useCallback(async (params) => {
    setScLoading(true);
    try {
      const [sizeRes, colorRes] = await Promise.allSettled([
        analyticsService.getSizeDistribution(params),
        analyticsService.getColorDistribution(params),
      ]);
      if (sizeRes.status  === 'fulfilled') setSizesData(sizeRes.value.data.data   || []);
      if (colorRes.status === 'fulfilled') setColorsData(colorRes.value.data.data || []);
    } catch (_) {}
    setScLoading(false);
  }, []);

  const fetchSC = useCallback(() => {
    const p = {};
    if (dateFrom)    p.date_from = dateFrom;
    if (dateTo)      p.date_to   = dateTo;
    if (selState)    p.state     = selState;
    if (selCity)     p.city      = selCity;
    if (selCategory) p.category  = selCategory;
    doFetchSC(p);
  }, [dateFrom, dateTo, selState, selCity, selCategory, doFetchSC]);

  const resetSC = useCallback(() => {
    setDateFrom(''); setDateTo(''); setSelState(''); setSelCity(''); setSelCategory('');
    doFetchSC({});
  }, [doFetchSC]);

  const loading     = pageLoading || scLoading;
  const sizes       = sizesData  || [];
  const colors      = colorsData || [];

  const fmtV       = v => formatNumber(v);
  const sizeSlice  = sizes.slice(0, sizeTopN);
  const colorSlice = colors.slice(0, colorTopN);

  // Rich 20-colour palette — cycles for large N
  const PIE_PALETTE = [
    '#C0392B','#2563EB','#059669','#D97706','#DC2626','#0284C7','#E74C3C','#EA580C',
    '#0D9488','#BE185D','#C0392B','#0891B2','#16A34A','#CA8A04','#B91C1C','#1D4ED8',
    '#7E22CE','#0F766E','#C2410C','#4338CA',
  ];
  const sizeColors  = sizeSlice.map((_, i)  => PIE_PALETTE[i % PIE_PALETTE.length]);
  const colorColors = colorSlice.map((_, i) => PIE_PALETTE[(i + 4) % PIE_PALETTE.length]);

  const inputStyle  = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)' };
  const selectStyle = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer', minWidth: 120 };

  const legendStyle = {
    position: 'bottom', fontSize: '12px', fontWeight: 700,
    fontFamily: "'Inter', sans-serif",
    labels: { colors: '#94A3B8' },
    markers: { radius: 4 },
    itemMargin: { horizontal: 8, vertical: 4 },
  };
  const tooltipStyle = { style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } };

  return (
    <Section title="Size & Colour Distribution" icon={Layers} mb={32}>
      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Date Range</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
        <span style={{ fontSize: 13, fontWeight: 800, color: '#94a3b8' }}>→</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
        <div style={{ width: 1, height: 22, background: '#e2e8f0', margin: '0 2px' }} />
        <div style={{ position: 'relative' }}>
          <select value={selState} onChange={e => { setSelState(e.target.value); setSelCity(''); }} style={selectStyle}>
            <option value="">All States</option>
            {stateList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div style={{ position: 'relative' }}>
          <select value={selCategory} onChange={e => setSelCategory(e.target.value)} style={selectStyle} title="Filter by product category (matched on product name)">
            {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div style={{ position: 'relative' }}>
          <select value={selCity} onChange={e => setSelCity(e.target.value)} style={selectStyle}>
            <option value="">All Cities</option>
            {cityList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button onClick={fetchSC} style={{ padding: '5px 16px', borderRadius: 8, fontSize: 12, fontWeight: 800, background: '#0284C7', color: '#fff', border: 'none', cursor: 'pointer' }}>
          Apply
        </button>
        <button onClick={resetSC} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>
          Reset
        </button>
      </div>

      <div style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* ── Size chart ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Units Available by Size</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>{sizes.length} sizes tracked</span>
              <div style={{ width: 1, height: 16, background: '#e2e8f0', margin: '0 4px' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select
                value={sizeTopN}
                onChange={e => setSizeTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {SIZE_TOP_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 0 4px' }}>
            {loading
              ? <div className="skeleton" style={{ height: Math.max(420, sizeTopN * 22), margin: '0 16px 16px' }} />
              : sizes.length > 0
                ? <Chart key={`size-treemap-${sizeTopN}-${sizes.length}`} type="treemap" height={Math.max(460, Math.ceil(sizeTopN / 5) * 92)}
                    options={{
                      chart: { toolbar: { show: false }, fontFamily: "'Inter', sans-serif", animations: { enabled: true, speed: 800, easing: 'easeinout' } },
                      colors: PIE_PALETTE,
                      plotOptions: {
                        treemap: {
                          distributed: true,
                          enableShades: false,
                          borderRadius: 10,
                        },
                      },
                      dataLabels: {
                        enabled: true,
                        style: { fontFamily: "'Inter', sans-serif", fontWeight: 900, colors: ['#fff'], fontSize: '13px' },
                        formatter: (text, op) => {
                          const actualStock = sizeSlice[op.dataPointIndex]?.total_stock;
                          return [text, actualStock != null ? formatNumber(Number(actualStock)) : ''];
                        },
                        dropShadow: { enabled: true, top: 2, left: 2, blur: 4, color: '#000', opacity: 0.6 },
                        offsetY: 0,
                      },
                      stroke: { width: 3, colors: ['#ffffff'] },
                      legend: { show: false },
                      tooltip: {
                        custom: ({ dataPointIndex }) => {
                          const item = sizeSlice[dataPointIndex];
                          return `<div style="padding:10px 14px;font-family:'Inter',sans-serif;font-size:13px;font-weight:700;background:#1e1b4b;color:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3)">
                            <span style="font-size:15px">Size ${item?.size ?? ''}</span><br/>
                            <span style="color:#fca5a5;font-weight:500">${formatNumber(Number(item?.total_stock ?? 0))} units in stock</span>
                          </div>`;
                        },
                      },
                    }}
                    series={[{ data: sizeSlice.map(s => ({ x: s.size, y: 1 })) }]}
                  />
                : <div className="empty-state" style={{ padding: 40 }}><Layers size={28} /><p>No size data available</p></div>
            }
          </div>
        </div>

        {/* ── Colour chart — horizontal bar ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Units Available by Colour</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select
                value={colorTopN}
                onChange={e => setColorTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {COLOR_SIZE_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 0 0' }}>
            {loading
              ? <div className="skeleton" style={{ height: Math.max(320, colorTopN * 32), margin: '0 16px 16px' }} />
              : colors.length > 0
                ? <Chart key={`color-bar-${colorTopN}-${colors.length}`} type="bar" height={Math.max(320, colorTopN * 32)}
                    options={{
                      chart: { toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false }, fontFamily: "'Inter', sans-serif" },
                      plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: colorTopN <= 10 ? '55%' : colorTopN <= 20 ? '62%' : colorTopN <= 50 ? '68%' : '74%', dataLabels: { position: 'right' } } },
                      colors: ['#C0392B'],
                      fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#E74C3C'], stops: [0, 100] } },
                      xaxis: { labels: { style: { colors: '#64748B', fontWeight: 700, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                      yaxis: { labels: { style: { colors: '#94A3B8', fontWeight: 800, fontSize: '12px' }, maxWidth: 160 } },
                      dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#CBD5E1'] }, formatter: fmtV },
                      grid: { strokeDashArray: 3, borderColor: 'var(--chart-grid)' },
                      tooltip: { theme: 'dark', style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
                    }}
                    series={[{ name: 'Units in Stock', data: colorSlice.map(c => ({ x: c.color_name, y: Number(c.total_stock) })) }]}
                  />
                : <div className="empty-state" style={{ padding: 40 }}><BarChart3 size={28} /><p>No colour data available</p></div>
            }
          </div>
        </div>
      </div>
      </div>
    </Section>
  );
}

// ─── SKU Performance Section ─────────────────────────────────────────────────
const SKU_TOP_OPTIONS  = [10, 15, 20, 50, 100];
const SKU_DAYS_OPTIONS = [{ label: '90 days', val: 90 }, { label: '180 days', val: 180 }, { label: '270 days', val: 270 }, { label: '365 days', val: 365 }];

function SkuPerformanceSection({ initialTopMoving, initialSlowMoving, allStoresData, pageLoading }) {
  const [topN,          setTopN]          = useState(10);
  const [slowTopN,      setSlowTopN]      = useState(10);
  const [slowDays,      setSlowDays]      = useState(90);
  const [dateFrom,      setDateFrom]      = useState('2025-01-01');
  const [dateTo,        setDateTo]        = useState('2026-01-31');
  const [selState,      setSelState]      = useState('');
  const [selCity,       setSelCity]       = useState('');
  const [selCategory,   setSelCategory]   = useState('');
  const [topMovingData, setTopMovingData] = useState(initialTopMoving || []);
  const [slowMovingData,setSlowMovingData]= useState(initialSlowMoving || []);
  const [skuLoading,    setSkuLoading]    = useState(false);

  useEffect(() => { if (initialTopMoving?.length)  setTopMovingData(initialTopMoving); },  [initialTopMoving]);
  useEffect(() => { if (initialSlowMoving?.length) setSlowMovingData(initialSlowMoving); }, [initialSlowMoving]);

  const allStores = allStoresData?.all_stores || [];
  const stateList = useMemo(() => [...new Set(allStores.map(r => r.state).filter(Boolean))].sort(), [allStores]);
  const cityList  = useMemo(() => {
    const base = selState ? allStores.filter(r => r.state === selState) : allStores;
    return [...new Set(base.map(r => r.city).filter(Boolean))].sort();
  }, [allStores, selState]);

  const doFetch = useCallback(async (topParams, slowParams) => {
    setSkuLoading(true);
    try {
      const [topRes, slowRes] = await Promise.allSettled([
        skuService.getTopMoving(topParams),
        skuService.getSlowMoving(slowParams),
      ]);
      if (topRes.status  === 'fulfilled') setTopMovingData(topRes.value.data.data || []);
      if (slowRes.status === 'fulfilled') setSlowMovingData(slowRes.value.data.data || []);
    } catch (_) {}
    setSkuLoading(false);
  }, []);

  const fetchSku = useCallback(() => {
    const topParams  = { n: topN, date_from: dateFrom, date_to: dateTo };
    const slowParams = { days: slowDays };
    if (selState)    { topParams.state    = selState;    slowParams.state    = selState;    }
    if (selCity)     { topParams.city     = selCity;     slowParams.city     = selCity;     }
    if (selCategory) { topParams.category = selCategory; slowParams.category = selCategory; }
    doFetch(topParams, slowParams);
  }, [topN, slowDays, dateFrom, dateTo, selState, selCity, selCategory, doFetch]);

  const resetFilters = useCallback(() => {
    setDateFrom('2025-01-01');
    setDateTo('2026-01-31');
    setSelState('');
    setSelCity('');
    setSelCategory('');
    doFetch(
      { n: topN, date_from: '2025-01-01', date_to: '2026-01-31' },
      { days: slowDays }
    );
  }, [topN, slowDays, doFetch]);

  const loading    = pageLoading || skuLoading;
  const topMoving  = topMovingData  || [];
  const slowMoving = slowMovingData || [];

  const inputStyle  = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)' };
  const selectStyle = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 600, color: '#CBD5E1', outline: 'none', background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer', minWidth: 120 };

  return (
    <Section title="SKU Performance" icon={TrendingUp} mb={32}>
      {/* ── Shared filter bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Date Range</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
        <span style={{ fontSize: 13, fontWeight: 800, color: '#94a3b8' }}>→</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
        <div style={{ width: 1, height: 22, background: '#e2e8f0', margin: '0 2px' }} />
        <div style={{ position: 'relative' }}>
          <select value={selState} onChange={e => { setSelState(e.target.value); setSelCity(''); }} style={selectStyle}>
            <option value="">All States</option>
            {stateList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div style={{ position: 'relative' }}>
          <select value={selCategory} onChange={e => setSelCategory(e.target.value)} style={selectStyle} title="Filter by product category (matched on product name)">
            {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div style={{ position: 'relative' }}>
          <select value={selCity} onChange={e => setSelCity(e.target.value)} style={selectStyle}>
            <option value="">All Cities</option>
            {cityList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button onClick={fetchSku} style={{ padding: '5px 16px', borderRadius: 8, fontSize: 12, fontWeight: 800, background: '#C0392B', color: '#fff', border: 'none', cursor: 'pointer' }}>
          Apply
        </button>
        <button onClick={resetFilters} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>
          Reset
        </button>
      </div>

      <div style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* ── Top Moving SKUs ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Top Moving SKUs</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select
                value={topN}
                onChange={e => {
                  const n = Number(e.target.value);
                  setTopN(n);
                  doFetch(
                    { n, date_from: dateFrom, date_to: dateTo, ...(selState && { state: selState }), ...(selCity && { city: selCity }), ...(selCategory && { category: selCategory }) },
                    { days: slowDays, ...(selState && { state: selState }), ...(selCity && { city: selCity }), ...(selCategory && { category: selCategory }) }
                  );
                }}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {SKU_TOP_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>SKU Code</th>
                  <th>Colour</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>Units Sold</th>
                  <th style={{ textAlign: 'right' }}>Locations</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 14, width: '80%' }} /></td>
                    ))}</tr>
                  ))
                  : topMoving.map((s, i) => (
                    <tr key={i}>
                      <td>
                        <div className={`rank-badge ${i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-n'}`}>
                          {i + 1}
                        </div>
                      </td>
                      <td><span style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700, letterSpacing: '0.02em', color: '#0f172a' }}>{s.sku_code}</span></td>
                      <td><span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>{s.color_name}</span></td>
                      <td><span style={{ fontWeight: 800, fontFamily: 'var(--font-display)', fontSize: 15, color: '#1e293b' }}>{s.size}</span></td>
                      <td style={{ textAlign: 'right' }}><span style={{ fontWeight: 800, color: '#C0392B', fontSize: 15, fontFamily: 'var(--font-display)' }}>{formatNumber(s.total_sold)}</span></td>
                      <td style={{ textAlign: 'right' }}><span style={{ fontSize: 13, fontWeight: 600, color: '#64748b' }}>{s.locations_sold_from || '—'}</span></td>
                    </tr>
                  ))
                }
                {!loading && !topMoving.length && (
                  <tr><td colSpan={6}>
                    <div className="empty-state" style={{ padding: 36 }}>
                      <TrendingUp size={30} /><p>No velocity data for selected period</p>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Slow / Dead Stock ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Slow / Dead Stock</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
              <select
                value={slowTopN}
                onChange={e => setSlowTopN(Number(e.target.value))}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {[5, 10, 20, 100, 200].map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Threshold</span>
              <select
                value={slowDays}
                onChange={e => {
                  const days = Number(e.target.value);
                  setSlowDays(days);
                  doFetch(
                    { n: topN, date_from: dateFrom, date_to: dateTo, ...(selState && { state: selState }), ...(selCity && { city: selCity }), ...(selCategory && { category: selCategory }) },
                    { days, ...(selState && { state: selState }), ...(selCity && { city: selCity }), ...(selCategory && { category: selCategory }) }
                  );
                }}
                style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#CBD5E1', background: 'var(--bg-elevated)', outline: 'none', cursor: 'pointer' }}
              >
                {SKU_DAYS_OPTIONS.map(o => <option key={o.val} value={o.val}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>SKU Code</th>
                  <th>Colour</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>Qty On Hand</th>
                  <th style={{ textAlign: 'right' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 14, width: '80%' }} /></td>
                    ))}</tr>
                  ))
                  : slowMoving.slice(0, slowTopN).map((s, i) => {
                      const statusMeta = {
                        NEVER_SOLD: { label: 'Never Sold',  cls: 'badge-danger',   days: '730+ days' },
                        DEAD:       { label: 'Dead Stock',  cls: 'badge-danger',   days: `${s.days_no_movement}d` },
                        AT_RISK:    { label: 'At Risk',     cls: 'badge-warning',  days: `${s.days_no_movement}d` },
                        SLOW:       { label: 'Slow Moving', cls: 'badge-secondary',days: `${s.days_no_movement}d` },
                      }[s.stock_status] || { label: `${s.days_no_movement}d`, cls: 'badge-warning', days: `${s.days_no_movement}d` };
                      return (
                        <tr key={i}>
                          <td><span title={s.location_name} style={{ fontSize: 13, fontWeight: 600, color: '#334155', maxWidth: 160, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}>{s.location_name}</span></td>
                          <td><span style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700, letterSpacing: '0.02em', color: '#0f172a' }}>{s.sku_code}</span></td>
                          <td><span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>{s.color_name}</span></td>
                          <td><span style={{ fontWeight: 800, fontFamily: 'var(--font-display)', fontSize: 15, color: '#1e293b' }}>{s.size}</span></td>
                          <td style={{ textAlign: 'right' }}><span style={{ fontWeight: 800, color: s.stock_status === 'DEAD' || s.stock_status === 'NEVER_SOLD' ? '#DC2626' : '#D97706', fontSize: 15, fontFamily: 'var(--font-display)' }}>{formatNumber(s.qty_on_hand)}</span></td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                              <span className={`badge ${statusMeta.cls}`} style={{ fontSize: 11, fontWeight: 700 }}>
                                {statusMeta.label}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                                {statusMeta.days}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                }
                {!loading && !slowMoving.length && (
                  <tr><td colSpan={6}>
                    <div className="empty-state" style={{ padding: 36 }}>
                      <CheckCircle size={30} style={{ opacity: 0.5 }} />
                      <p>No slow-moving inventory detected</p>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
    </Section>
  );
}

// ─── Stock Alerts Section — drill-down with filters, search, pagination ───────
function StockAlertsSection({ alerts, alertSummary, pageLoading }) {
  const [search,      setSearch]      = useState('');
  const [selState,    setSelState]    = useState('');
  const [selCity,     setSelCity]     = useState('');
  const [selCategory, setSelCategory] = useState('');
  const [levelTab,    setLevelTab]    = useState('ALL');
  const [pageSize,    setPageSize]    = useState(30);
  const [page,        setPage]        = useState(1);

  const inputStyle  = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff' };
  const selectStyle = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer', minWidth: 130 };

  // ── Derived option lists (null-safe) ──
  const stateList = useMemo(() =>
    [...new Set((alerts || []).map(r => r?.state).filter(Boolean))].sort(),
  [alerts]);

  const cityList = useMemo(() => {
    const base = selState ? alerts.filter(r => r?.state === selState) : alerts;
    return [...new Set(base.map(r => r?.city).filter(Boolean))].sort();
  }, [alerts, selState]);

  // ── Filter pipeline ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (alerts || []).filter(r => {
      if (!r) return false;
      if (levelTab !== 'ALL' && r.alert_level !== levelTab) return false;
      if (selState && r.state !== selState) return false;
      if (selCity  && r.city  !== selCity)  return false;
      if (selCategory && !matchesCategory(r.product_name, selCategory)) return false;
      if (!q) return true;
      return (
        (r.sku_code     || '').toLowerCase().includes(q) ||
        (r.product_name || '').toLowerCase().includes(q) ||
        (r.color_name   || '').toLowerCase().includes(q) ||
        (r.location_name|| '').toLowerCase().includes(q) ||
        (r.city         || '').toLowerCase().includes(q) ||
        (r.state        || '').toLowerCase().includes(q)
      );
    });
  }, [alerts, search, selState, selCity, selCategory, levelTab]);

  // ── Reset page when filters change ──
  useEffect(() => { setPage(1); }, [search, selState, selCity, selCategory, levelTab, pageSize]);

  // ── Reset city when state changes ──
  useEffect(() => { setSelCity(''); }, [selState]);

  // ── Pagination math ──
  const totalRows  = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage   = Math.min(page, totalPages);
  const offset     = (safePage - 1) * pageSize;
  const pageRows   = filtered.slice(offset, offset + pageSize);

  const hasFilter = !!(search || selState || selCity || selCategory || levelTab !== 'ALL');
  const clearAll = () => { setSearch(''); setSelState(''); setSelCity(''); setSelCategory(''); setLevelTab('ALL'); setPage(1); };

  // ── Alert level badge styling ──
  const levelStyle = (lvl) => {
    if (lvl === 'OUT_OF_STOCK') return { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5', label: 'Out of Stock' };
    if (lvl === 'REORDER_NOW')  return { bg: '#FED7AA', color: '#9A3412', border: '#FDBA74', label: 'Reorder Now' };
    return { bg: '#FEF3C7', color: '#92400E', border: '#FCD34D', label: 'Low Stock' };
  };

  // ── Tab buttons ──
  const tabs = [
    { key: 'ALL',          label: 'All',           count: alertSummary?.total        || 0, color: '#0f172a' },
    { key: 'OUT_OF_STOCK', label: 'Out of Stock',  count: alertSummary?.out_of_stock || 0, color: '#DC2626' },
    { key: 'REORDER_NOW',  label: 'Reorder Now',   count: alertSummary?.reorder_now  || 0, color: '#EA580C' },
    { key: 'LOW_STOCK',    label: 'Low Stock',     count: alertSummary?.low_stock    || 0, color: '#D97706' },
  ];

  const pageSizeOpts = [10, 30, 50, 100, 200];

  return (
    <Section title="Stock Alerts — Store × SKU" icon={Bell} color="#DC2626" mb={32}>
      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {tabs.map(t => {
          const active = levelTab === t.key;
          return (
            <button key={t.key} onClick={() => setLevelTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 14px', borderRadius: 20,
                border: `1.5px solid ${active ? t.color : '#e2e8f0'}`,
                background: active ? t.color : '#fff',
                color: active ? '#fff' : '#475569',
                fontSize: 12, fontWeight: 800, cursor: 'pointer',
                transition: 'all 0.15s',
              }}>
              {t.label}
              <span style={{
                fontSize: 10, fontWeight: 800,
                background: active ? 'rgba(255,255,255,0.25)' : '#f1f5f9',
                color: active ? '#fff' : t.color,
                padding: '1px 7px', borderRadius: 100, letterSpacing: '0.02em',
              }}>{t.count}</span>
            </button>
          );
        })}
      </div>

      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 380 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.45, pointerEvents: 'none' }} color="#475569" strokeWidth={2.5} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search SKU, product, store, city…"
            style={{ ...inputStyle, paddingLeft: 30, width: '100%' }}
          />
        </div>

        <div style={{ position: 'relative' }}>
          <select value={selState} onChange={e => setSelState(e.target.value)} style={selectStyle}>
            <option value="">All States</option>
            {stateList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>

        <div style={{ position: 'relative' }}>
          <select value={selCategory} onChange={e => setSelCategory(e.target.value)} style={selectStyle} title="Filter by product category (matched on product name)">
            {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>

        <div style={{ position: 'relative' }}>
          <select value={selCity} onChange={e => setSelCity(e.target.value)} style={selectStyle} disabled={cityList.length === 0}>
            <option value="">All Cities</option>
            {cityList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>

        {hasFilter && (
          <button onClick={clearAll} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>
            Clear
          </button>
        )}

        {/* Page size — top right */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Show</span>
          <div style={{ position: 'relative' }}>
            <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={{ ...selectStyle, minWidth: 90 }}>
              {pageSizeOpts.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
      </div>

      {/* ── Table — overflow:hidden constrains horizontal scroll ── */}
      <div style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: (!pageLoading && totalRows > 0) ? '14px 14px 0 0' : 14,
        overflow: 'hidden',
      }}>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: '#f8fafc' }}>
                {['#','Alert','Store','State / City','Channel','SKU','Product','Colour','Size','On Hand','Safety','Reorder','Shortfall'].map(h => (
                  <th key={h} style={{
                    padding: '11px 14px',
                    textAlign: ['#','On Hand','Safety','Reorder','Shortfall'].includes(h) ? 'right' : 'left',
                    fontSize: 11, fontWeight: 900, color: '#0f172a', letterSpacing: '0.06em', textTransform: 'uppercase',
                    borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageLoading
                ? Array.from({ length: Math.min(pageSize, 10) }).map((_, i) => (
                    <tr key={i}><td colSpan={13} style={{ padding: '10px 14px' }}><div style={{ height: 14, background: '#f1f5f9', borderRadius: 4 }} /></td></tr>
                  ))
                : pageRows.length === 0
                  ? (
                    <tr><td colSpan={13} style={{ padding: '40px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#64748b' }}>
                      {hasFilter ? 'No alerts match your filters' : 'No stock alerts — everything is healthy'}
                    </td></tr>
                  )
                  : pageRows.map((r, i) => {
                      const lvl = levelStyle(r.alert_level);
                      const rowNum = offset + i + 1;
                      const shortfall = r.shortfall_pct != null ? `${Number(r.shortfall_pct).toFixed(1)}%` : '—';
                      return (
                        <tr key={`${r.sku_code}-${r.location_name}-${i}`}
                          style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#f1f5f9'}
                          onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa'}>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>{rowNum}</td>
                          <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                            <span style={{
                              background: lvl.bg, color: lvl.color, border: `1px solid ${lvl.border}`,
                              borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', letterSpacing: '0.02em',
                            }}>{lvl.label}</span>
                          </td>
                          <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 800, color: '#0f172a', whiteSpace: 'nowrap' }}>{r.location_name || '—'}</td>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: '#334155', whiteSpace: 'nowrap' }}>{r.state || '—'}{r.city ? ` · ${r.city}` : ''}</td>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>{r.location_type || '—'}</td>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 800, color: '#1d4ed8', whiteSpace: 'nowrap' }}>{r.sku_code || '—'}</td>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: '#334155', whiteSpace: 'nowrap' }}>{r.product_name || '—'}</td>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: '#334155', whiteSpace: 'nowrap' }}>{r.color_name || '—'}</td>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#334155', whiteSpace: 'nowrap' }}>{r.size || '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 900, color: r.qty_on_hand === 0 ? '#DC2626' : '#0f172a', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatNumber(Number(r.qty_on_hand || 0))}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#475569', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatNumber(Number(r.safety_stock || 0))}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#475569', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatNumber(Number(r.reorder_point || 0))}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 800, color: '#DC2626', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{shortfall}</td>
                        </tr>
                      );
                    })
              }
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Pagination — sibling of table box, never clipped ── */}
      {!pageLoading && totalRows > 0 && (
        <div style={{ padding: '10px 16px', border: '1px solid #e2e8f0', borderTop: 'none', borderRadius: '0 0 14px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f8fafc', flexWrap: 'wrap', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>
            Showing <strong style={{ color: '#0f172a' }}>{offset + 1}–{Math.min(offset + pageRows.length, totalRows)}</strong> of <strong style={{ color: '#0f172a' }}>{formatNumber(totalRows)}</strong> alerts
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <button onClick={() => setPage(1)} disabled={safePage === 1}
              style={{ border: '1.5px solid #e2e8f0', borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? '#cbd5e1' : '#0f172a', background: '#fff', cursor: safePage === 1 ? 'default' : 'pointer' }}>«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
              style={{ border: '1.5px solid #e2e8f0', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? '#cbd5e1' : '#0f172a', background: '#fff', cursor: safePage === 1 ? 'default' : 'pointer' }}>‹ Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
              .reduce((acc, p, idx, arr) => { if (idx > 0 && p - arr[idx-1] > 1) acc.push('…'); acc.push(p); return acc; }, [])
              .map((p, idx) => p === '…'
                ? <span key={`e${idx}`} style={{ fontSize: 12, color: '#94a3b8', padding: '0 2px' }}>…</span>
                : <button key={p} onClick={() => setPage(p)}
                    style={{
                      border: `1.5px solid ${p === safePage ? '#DC2626' : '#e2e8f0'}`,
                      borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 800,
                      color: p === safePage ? '#fff' : '#0f172a',
                      background: p === safePage ? '#DC2626' : '#fff',
                      cursor: 'pointer', minWidth: 30,
                    }}>{p}</button>)
            }
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
              style={{ border: '1.5px solid #e2e8f0', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 800, color: safePage === totalPages ? '#cbd5e1' : '#0f172a', background: '#fff', cursor: safePage === totalPages ? 'default' : 'pointer' }}>Next ›</button>
            <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
              style={{ border: '1.5px solid #e2e8f0', borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 800, color: safePage === totalPages ? '#cbd5e1' : '#0f172a', background: '#fff', cursor: safePage === totalPages ? 'default' : 'pointer' }}>»</button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
// State initializes lazily from the module-level cache (lib/dashboardCache.js)
// so navigating away and back shows data instantly instead of remounting empty.
// A background refresh still runs on every mount to keep values up to date.
export default function Overview() {
  // ── v2 universal FilterBar — same 15 dimensions + Active/Inactive/All
  // mode pill driving sales/network. Adds Show pill (Sale/Return/Net) +
  // Valuation dropdown so the executive sees revenue at any lens.
  const { filters: v2Filters, setFilter: setV2, clearAll: clearV2, activeCount: v2Active } =
    useFilters({
      defaults: { mode: 'active', sale_mode: 'net', valuation: 'gross' },
      persist:  ['mode', 'sale_mode', 'valuation'],
    });

  // Mode-scoped cache keys — see fetchAll's `mk()` helper. The initial seed
  // reads the slot for the persisted mode so a page-reload paints instantly
  // without flashing a different lens's numbers.
  const _bootMode = (typeof v2Filters?.mode === 'string' ? v2Filters.mode : 'active');
  const _mk = (k) => `${k}:${_bootMode}`;

  const [summary, setSummary]       = useState(() => getCached(_mk('ov:summary'))       ?? null);
  const [sizes, setSizes]           = useState(() => getCached('ov:sizes')              ?? []);
  const [colors, setColors]         = useState(() => getCached('ov:colors')             ?? []);
  const [salesTop, setSalesTop]     = useState(() => getCached(_mk('ov:salesTop'))      ?? null);
  const [topMoving, setTopMoving]   = useState(() => getCached('ov:topMoving')          ?? []);
  const [slowMoving, setSlowMoving] = useState(() => getCached('ov:slowMoving')         ?? []);
  const [alerts, setAlerts]         = useState(() => getCached('ov:alerts')             ?? []);
  const [alertSummary, setAlertSummary] = useState(() =>
    getCached(_mk('ov:alertSummary')) ?? { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 });
  const [alertsLoading, setAlertsLoading] = useState(() => !getCached('ov:alerts'));
  const [ageing, setAgeing]         = useState(() => getCached(_mk('ov:ageing'))        ?? []);
  const [lastSync, setLastSync]     = useState(() => getCached('ov:lastSync')           ?? null);
  const [inTransit, setInTransit]   = useState(() => getCached('ov:inTransit')          ?? []);
  const [loading, setLoading]       = useState(() => !getCached(_mk('ov:summary')));
  const [syncLabel, setSyncLabel]   = useState('—');
  // Drill-down target — { type: 'sku'|'store', id, name, product? }.
  // Reuses the same DrilldownDrawer the Sales page uses, so any row
  // click on the cross-pivot tables opens the same elite drawer
  // experience (KPIs, top SKUs/stores, colour/size breakdown, etc.).
  const [drillTarget, setDrillTarget] = useState(null);

  // ──────────────────────────────────────────────────────────────────────
  //  TWO FETCH PATHS — designed for nano-second perceived latency:
  //
  //    fetchAll()       Initial cold load. Hits ALL 10 endpoints once.
  //                     Skeletons only when we have literally nothing.
  //
  //    fetchModeOnly()  Fires when only the Active/Inactive/All pill flips.
  //                     Touches just the 4 mode-dependent endpoints
  //                     (executive-summary, alerts-summary, ageing, sales).
  //                     Stale-while-revalidate: previous lens stays
  //                     on-screen while the new one loads, then atomically
  //                     swaps in. NEVER sets loading=true so no skeleton
  //                     flash. With server-side warmup pre-populating
  //                     Redis for all 3 modes, this is ~30ms typical.
  //
  //  Mode-scoped cache keys (`ov:<key>:<mode>`) ensure the previous lens
  //  paints from cache instantly while the network round-trip happens.
  // ──────────────────────────────────────────────────────────────────────

  // Helper that turns array-or-string filter values into the comma-joined
  // string the API expects, with empty arrays mapped to `undefined` so axios
  // omits the param entirely (instead of sending `?gender=` which can poison
  // some controller branches).
  const _csv = (v) =>
    Array.isArray(v) ? (v.length ? v.join(',') : undefined) : (v || undefined);

  const buildSalesParams = useCallback((mode) => ({
    date_from:   '2025-01-01',
    date_to:     '2026-01-31',
    mode,
    gender:      _csv(v2Filters.gender_name),
    sub_product: _csv(v2Filters.sub_product),
    product:     _csv(v2Filters.product),
    category:    _csv(v2Filters.category),
    style:       _csv(v2Filters.style),
    shade:       _csv(v2Filters.shade),
    color:       _csv(v2Filters.color),
    size:        _csv(v2Filters.size),
    season:      _csv(v2Filters.season),
    state:       _csv(v2Filters.state),
    city:        _csv(v2Filters.city),
    group_name:  _csv(v2Filters.group_name),
    store_code:  _csv(v2Filters.store_code),
  }), [
    // ONLY the dimensions the server cares about — explicitly NOT
    // `sale_mode` or `valuation` (frontend-only lens picks). This prevents
    // fetchAll's useCallback from re-creating on every Sale/Return/Net
    // tab toggle, which was the trigger of the zero-flash on switch.
    v2Filters.gender_name, v2Filters.sub_product, v2Filters.product,
    v2Filters.category, v2Filters.style, v2Filters.shade, v2Filters.color,
    v2Filters.size, v2Filters.season, v2Filters.state, v2Filters.city,
    v2Filters.group_name, v2Filters.store_code,
  ]);

  // ── In-flight singleflight map — if the user spam-clicks Active→Inactive
  // →Active in 200ms, we DON'T fire 6 parallel network calls. Each (mode,
  // endpoint) tuple coalesces to one promise; concurrent callers piggyback.
  const _inflight = useRef(new Map());
  const _singleflight = useCallback((key, fn) => {
    const m = _inflight.current;
    if (m.has(key)) return m.get(key);
    const p = fn().finally(() => { m.delete(key); });
    m.set(key, p);
    return p;
  }, []);

  // ── Active-mode race guard ────────────────────────────────────────────
  // Tracks which mode the page is CURRENTLY showing. When a user toggles
  // Active→Inactive→Active in 200ms, three fetchModeOnly calls fire in
  // parallel. Without a race guard, the slowest response could land last
  // and overwrite the correct one — leaving the pill on Active but the
  // numbers from Inactive (the bug from the user's screenshot). We
  // capture `activeMode` at fetch issue time and only paint if it still
  // matches the latest user-selected mode at response time.
  const activeModeRef = useRef(v2Filters.mode || 'active');

  const _markFresh = useCallback(() => {}, []); // kept for prefetch compatibility (no-op)

  // ── Mode-only refetch — Sales/Network style ───────────────────────────
  // Always fires the 4 mode-dependent endpoints, regardless of cache age,
  // because (a) server-side warming makes each call ~10ms and (b) the
  // freshness check was the cause of the screenshot bug — when the user
  // landed on a mode that had stale-but-cached partial data, we'd skip
  // the revalidate and leave the wrong numbers on screen.
  //
  // Race guard: each response is gated on activeModeRef.current === mode
  // at land time — stale responses from superseded mode flips silently
  // drop their payload, never overwriting the correct lens.
  const fetchModeOnly = useCallback(async (mode) => {
    const mk = (k) => `${k}:${mode}`;
    activeModeRef.current = mode;

    // 1. Optimistic paint — frame-1 swap from per-mode localStorage cache
    //    if we have ANY cached value for this mode. Don't gate on cache
    //    miss — keep previous values visible (with the swap rail) until
    //    the server response lands.
    const cachedSummary  = getCached(mk('ov:summary'));
    const cachedAlerts   = getCached(mk('ov:alertSummary'));
    const cachedAgeing   = getCached(mk('ov:ageing'));
    const cachedSalesTop = getCached(mk('ov:salesTop'));
    if (cachedSummary  && activeModeRef.current === mode) setSummary(cachedSummary);
    if (cachedAlerts   && activeModeRef.current === mode) setAlertSummary(cachedAlerts);
    if (cachedAgeing   && activeModeRef.current === mode) setAgeing(cachedAgeing);
    if (cachedSalesTop && activeModeRef.current === mode) setSalesTop(cachedSalesTop);

    // 2. Always-fetch revalidate — singleflight-coalesced so spam clicks
    //    don't fire duplicate network calls. Race-guarded so superseded
    //    responses drop silently.
    try {
      const [sumRes, alertSumRes, ageRes, salesTopRes] = await Promise.allSettled([
        _singleflight(`exec:${mode}`,  () => inventoryService.getExecutiveSummary({ mode })),
        _singleflight(`alert:${mode}`, () => inventoryService.getAlertsSummary({ mode })),
        _singleflight(`age:${mode}`,   () => inventoryService.getAgeing({ mode })),
        _singleflight(`sales:${mode}`, () => analyticsService.getSalesAnalytics(buildSalesParams(mode))),
      ]);
      // Race guard: if the user switched modes again while these were
      // in flight, drop the payload — the new mode's fetchModeOnly is
      // already on its way and will paint the correct numbers.
      if (activeModeRef.current !== mode) return;

      if (sumRes.status      === 'fulfilled') { const v = sumRes.value.data.data;          setSummary(v);      setCached(mk('ov:summary'),      v); }
      if (alertSumRes.status === 'fulfilled') {
        const v = alertSumRes.value.data.summary || { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 };
        setAlertSummary(v); setCached(mk('ov:alertSummary'), v);
      }
      if (ageRes.status      === 'fulfilled') { const v = ageRes.value.data.data || [];    setAgeing(v);       setCached(mk('ov:ageing'),       v); }
      if (salesTopRes.status === 'fulfilled') { const v = salesTopRes.value.data.data;     setSalesTop(v);     setCached(mk('ov:salesTop'),     v); }
    } catch { /* swallow — page already shows previous lens */ }
  }, [buildSalesParams, _singleflight]);

  // ── Initial fast fetch: everything (including non-mode-dependent calls).
  // Alert KPI counts come from the tiny /alerts/summary endpoint so the page
  // becomes interactive instantly. The full alerts drill-down is loaded in a
  // deferred useEffect below (no row is dropped — just loaded out-of-band).
  const fetchAll = useCallback(async () => {
    const _mode = v2Filters.mode || 'active';
    const mk = (k) => `${k}:${_mode}`;
    activeModeRef.current = _mode; // pin the race guard to this mode

    // Stale-while-revalidate: only show skeletons on a TRUE cold start —
    // i.e. no cached summary AND no in-memory summary state. If we have
    // either, the user keeps seeing the previous values during refresh.
    const haveAnything = !!getCached(mk('ov:summary')) || !!summary;
    if (!haveAnything) setLoading(true);
    try {
      const [sumRes, sizeRes, colorRes, topRes, slowRes, alertSumRes, syncRes, transitRes, ageRes, salesTopRes] =
        await Promise.allSettled([
          inventoryService.getExecutiveSummary({ mode: _mode }),
          analyticsService.getSizeDistribution(),
          analyticsService.getColorDistribution(),
          skuService.getTopMoving({ n: 12, days: 30 }),
          skuService.getSlowMoving({ days: 90 }),
          inventoryService.getAlertsSummary({ mode: _mode }),
          syncService.getStatus(),
          dispatchService.getInTransit(),
          inventoryService.getAgeing({ mode: _mode }),
          analyticsService.getSalesAnalytics(buildSalesParams(_mode)),
        ]);
      // Race guard for mode-dependent state: if user switched modes while
      // we were fetching, drop those payloads. Mode-INDEPENDENT data
      // (sizes/colors/topMoving/slowMoving/sync/transit) is always safe
      // to write since it doesn't depend on the lens.
      const stillCurrentMode = activeModeRef.current === _mode;

      if (sizeRes.status     === 'fulfilled') { const v = sizeRes.value.data.data || [];   setSizes(v);     setCached('ov:sizes',     v); }
      if (colorRes.status    === 'fulfilled') { const v = colorRes.value.data.data || [];  setColors(v);    setCached('ov:colors',    v); }
      if (topRes.status      === 'fulfilled') { const v = topRes.value.data.data || [];    setTopMoving(v); setCached('ov:topMoving', v); }
      if (slowRes.status     === 'fulfilled') { const v = slowRes.value.data.data || [];   setSlowMoving(v);setCached('ov:slowMoving',v); }
      if (syncRes.status     === 'fulfilled') { const v = syncRes.value.data.data;        setLastSync(v);  setCached('ov:lastSync',  v); }
      if (transitRes.status  === 'fulfilled') { const v = transitRes.value.data.data || []; setInTransit(v); setCached('ov:inTransit', v); }

      // Mode-dependent state — always cache, only paint if still on this mode.
      if (sumRes.status      === 'fulfilled') {
        const v = sumRes.value.data.data;
        setCached(mk('ov:summary'), v);
        if (stillCurrentMode) setSummary(v);
      }
      if (alertSumRes.status === 'fulfilled') {
        const v = alertSumRes.value.data.summary || { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 };
        setCached(mk('ov:alertSummary'), v);
        if (stillCurrentMode) setAlertSummary(v);
      }
      if (ageRes.status      === 'fulfilled') {
        const v = ageRes.value.data.data || [];
        setCached(mk('ov:ageing'), v);
        if (stillCurrentMode) setAgeing(v);
      }
      if (salesTopRes.status === 'fulfilled') {
        const v = salesTopRes.value.data.data;
        setCached(mk('ov:salesTop'), v);
        if (stillCurrentMode) setSalesTop(v);
      }
    } catch (err) { notifyApiError(err, 'Failed to load dashboard'); }
    finally { setLoading(false); }
    // Dep key EXCLUDES `mode`, `sale_mode`, and `valuation`:
    //   • mode      → handled by fetchModeOnly (dedicated fast path)
    //   • sale_mode → pure frontend lens pick (Sale/Return/Net) — same
    //                 server payload has all three values built-in.
    //                 Re-fetching here was the cause of the zero-flash
    //                 the user saw on tab switching.
    //   • valuation → pure frontend lens pick (Gross/Ex-GST/MRP/...) —
    //                 the server payload exposes every basis at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify({ ...(v2Filters || {}), mode: undefined, sale_mode: undefined, valuation: undefined }), buildSalesParams]);

  // ── Sales-only refetch — fires when ONLY a dimension filter changes ──
  // Inventory endpoints (executive-summary, alerts-summary, ageing) and
  // helper endpoints (sizes, colors, topMoving, slowMoving, sync, transit)
  // do NOT depend on the 13 dimension filters. So when user changes
  // gender/size/state/etc, we ONLY hit /analytics/sales and skip 9
  // pointless network calls. ~10× faster than the previous fetchAll on
  // every filter tweak.
  const fetchSalesOnly = useCallback(async () => {
    const _mode = v2Filters.mode || 'active';
    const mk = (k) => `${k}:${_mode}`;
    activeModeRef.current = _mode;
    try {
      const res = await _singleflight(
        `salesFilter:${_mode}:${JSON.stringify(buildSalesParams(_mode))}`,
        () => analyticsService.getSalesAnalytics(buildSalesParams(_mode))
      );
      if (activeModeRef.current !== _mode) return; // race-guard
      const v = res.data.data;
      setCached(mk('ov:salesTop'), v);
      setSalesTop(v);
    } catch { /* swallow — keep previous payload visible */ }
  }, [v2Filters.mode, buildSalesParams, _singleflight]);

  // ── Initial mount only ──────────────────────────────────────────────
  // The full 10-endpoint fan-out runs ONCE per page load. After that:
  //   • Dimension filter changes → fetchSalesOnly (1 call instead of 10)
  //   • Mode pill flips           → fetchModeOnly  (4 calls, race-guarded)
  // This is the single biggest latency win on Overview — filter tweaks
  // were redundantly re-pulling 9 unrelated endpoints on every keystroke.
  const _didInitialFetch = useRef(false);
  useEffect(() => {
    if (_didInitialFetch.current) return;
    _didInitialFetch.current = true;
    const key = `ov:summary:${v2Filters.mode || 'active'}`;
    if (isFresh(key)) { setLoading(false); return; }
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dimension-filter watcher ────────────────────────────────────────
  // After the initial fetch, any change to the 13 server-side dimensions
  // re-fetches ONLY the sales payload. Skips on first run since the
  // initial fetchAll already covers it.
  const _initialFilterSig = useRef(JSON.stringify(buildSalesParams('__init__')));
  useEffect(() => {
    const sig = JSON.stringify(buildSalesParams('__init__'));
    if (sig === _initialFilterSig.current) return;
    _initialFilterSig.current = sig;
    fetchSalesOnly();
  }, [buildSalesParams, fetchSalesOnly]);

  // ── Nano-second mode pill ─────────────────────────────────────────────
  // When ONLY the Active/Inactive/All mode flips, run fetchModeOnly which:
  //   1. Pins activeModeRef to the new mode (race guard — late-landing
  //      responses from the previous mode get dropped).
  //   2. Optimistically paints from per-mode localStorage cache (frame-1).
  //   3. Always fires the 4 mode-dependent endpoints in parallel.
  //   4. Atomically swaps fresh data in IF still on this mode at land time.
  //
  // Fires on every mode transition, including the very first mount: we
  // need to pin activeModeRef from the get-go so the prefetch's
  // background writes to other modes' cache slots don't race against
  // user clicks.
  const _prevMode = useRef(null);
  const [modeSwapping, setModeSwapping] = useState(false);
  useEffect(() => {
    const m = v2Filters.mode || 'active';
    if (_prevMode.current === m) return;
    const isInitial = _prevMode.current === null;
    _prevMode.current = m;
    // Always pin the race guard. First mount: no swap rail (fetchAll
    // covers it). Subsequent: pulse the rail so user sees the swap.
    activeModeRef.current = m;
    if (isInitial) return;
    setModeSwapping(true);
    fetchModeOnly(m).finally(() => setModeSwapping(false));
  }, [v2Filters.mode, fetchModeOnly]);

  // ── Aggressive 3-mode prefetch on mount (zero blocking) ─────────────
  // The moment the Overview lands, kick off background fetches for the two
  // mode variants the user is NOT currently looking at. The server-side
  // cache (Active/Inactive/All warmed at boot) returns each in ~10ms, and
  // we land them in this browser's localStorage so the FIRST pill flip is
  // a synchronous in-memory paint (literal nano-seconds, no network).
  //
  // Uses requestIdleCallback so the browser doesn't run prefetch until
  // it's done with first-paint and any user interaction. Falls back to
  // setTimeout for Safari (which still doesn't ship rIC).
  useEffect(() => {
    const current = v2Filters.mode || 'active';
    const others = ['active','inactive','all'].filter(m => m !== current);
    let cancelled = false;
    const schedule = (cb) =>
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? window.requestIdleCallback(cb, { timeout: 1500 })
        : setTimeout(cb, 200);
    const cancel = (h) =>
      typeof window !== 'undefined' && 'cancelIdleCallback' in window
        ? window.cancelIdleCallback(h)
        : clearTimeout(h);
    const handle = schedule(() => {
      if (cancelled) return;
      others.forEach((m) => {
        const mk = (k) => `${k}:${m}`;
        if (!isFresh(mk('ov:summary'))) {
          _singleflight(`exec:${m}`, () =>
            inventoryService.getExecutiveSummary({ mode: m })
              .then(r => { if (!cancelled) { setCached(mk('ov:summary'), r.data.data); _markFresh(mk('ov:summary')); } return r; })
              .catch(() => {})
          );
        }
        if (!isFresh(mk('ov:alertSummary'))) {
          _singleflight(`alert:${m}`, () =>
            inventoryService.getAlertsSummary({ mode: m })
              .then(r => { if (!cancelled) { setCached(mk('ov:alertSummary'), r.data.summary || {}); _markFresh(mk('ov:alertSummary')); } return r; })
              .catch(() => {})
          );
        }
        if (!isFresh(mk('ov:ageing'))) {
          _singleflight(`age:${m}`, () =>
            inventoryService.getAgeing({ mode: m })
              .then(r => { if (!cancelled) { setCached(mk('ov:ageing'), r.data.data || []); _markFresh(mk('ov:ageing')); } return r; })
              .catch(() => {})
          );
        }
        if (!isFresh(mk('ov:salesTop'))) {
          _singleflight(`sales:${m}`, () =>
            analyticsService.getSalesAnalytics(buildSalesParams(m))
              .then(r => { if (!cancelled) { setCached(mk('ov:salesTop'), r.data.data); _markFresh(mk('ov:salesTop')); } return r; })
              .catch(() => {})
          );
        }
      });
    });
    return () => { cancelled = true; cancel(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Deferred fetch for the full 570K-row alerts drill-down ──────────────────
  // Runs in parallel with the initial fetchAll so nothing is blocked waiting on
  // the heavy payload. Every row still loads — just out of the critical path.
  // Skipped entirely when cache is still fresh so rapid tab-switches don't
  // retransfer the 30-80MB JSON payload.
  useEffect(() => {
    if (isFresh('ov:alerts')) { setAlertsLoading(false); return; }
    let cancelled = false;
    if (!getCached('ov:alerts')) setAlertsLoading(true);
    inventoryService.getAlerts()
      .then(res => {
        if (cancelled) return;
        const data = res.data.data || [];
        setAlerts(data);
        setCached('ov:alerts', data);
        if (res.data.summary) {
          setAlertSummary(res.data.summary);
          setCached('ov:alertSummary', res.data.summary);
        }
      })
      .catch(() => { /* toast already handled in fetchAll for top-level errors */ })
      .finally(() => { if (!cancelled) setAlertsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Sync timer
  useEffect(() => {
    const ts = summary?.lastSync?.completed_at || lastSync?.lastSuccessfulSync || lastSync?.completed_at;
    if (!ts) { setSyncLabel('Never synced'); return; }
    const update = () => setSyncLabel(timeAgo(ts));
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, [summary, lastSync]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const totals      = summary?.totals || {};
  const byType      = summary?.byLocationType || [];
  const totalStock  = Number(totals.total_stock || 0);
  const totalValue  = Number(totals.total_stock_value || 0);
  const inTransitUnits = inTransit.reduce((s, d) => s + (Number(d.total_qty) || 0), 0);
  const channelTotal   = byType.reduce((s, t) => s + Number(t.total_stock || 0), 0) || totalStock;

  // True counts from backend summary (not filtered from the capped 2000-row array)
  const outOfStock  = alertSummary.out_of_stock;
  const reorderNow  = alertSummary.reorder_now;
  const lowStock    = alertSummary.low_stock;
  const totalAlerts = alertSummary.total;

  // ── Lens-aware sales picker — drives the executive hero KPIs ─────────────
  // Read salesTop.summary (from /analytics/sales) and switch ₹ basis based
  // on the page-level Show + Valuation pills. Same scheme used on the Sales
  // page so the executive sees one consistent set of figures across the app.
  const salesSummary = salesTop?.summary || {};
  const lensMode     = v2Filters.sale_mode || 'net';
  const valuation    = v2Filters.valuation || 'gross';
  const lensLabel    = lensMode === 'sale' ? 'Sales' : lensMode === 'return' ? 'Returns' : 'Net';
  const lensColor    = lensMode === 'sale' ? '#2563EB' : lensMode === 'return' ? '#F43F5E' : '#059669';
  const valuationLabel = valuation === 'gross' ? 'Gross' : valuation === 'ex_gst' ? 'Ex-GST' : valuation === 'gst' ? 'GST' : valuation === 'mrp' ? 'MRP' : valuation === 'discount' ? 'Discount' : valuation;
  const pickRev = (kind /* sale | return */) => {
    const prefix = kind === 'return' ? 'return_' : 'sales_';
    switch (valuation) {
      case 'ex_gst':   return Number(salesSummary[`${prefix}ex_gst_value`]   || 0);
      case 'gst':      return Number(salesSummary[`${prefix}gst_collected`]  || 0);
      case 'mrp':      return Number(salesSummary[`${prefix}mrp_value`]      || 0);
      case 'discount': return Math.max(0, Number(salesSummary[`${prefix}mrp_value`] || 0) - Number(salesSummary[kind === 'return' ? 'return_value' : 'sales_value'] || 0));
      case 'gross':
      default:         return Number(salesSummary[kind === 'return' ? 'return_value' : 'sales_value'] || 0);
    }
  };
  const saleRev   = pickRev('sale');
  const returnRev = pickRev('return');
  const netRev    = saleRev - returnRev;
  const lensRev   = lensMode === 'sale' ? saleRev : lensMode === 'return' ? returnRev : netRev;
  const saleUnits   = Number(salesSummary.units_sold || 0);
  const returnUnits = Number(salesSummary.return_units || 0);
  const netUnits    = saleUnits - returnUnits;
  const lensUnits   = lensMode === 'sale' ? saleUnits : lensMode === 'return' ? returnUnits : netUnits;

  // ── Aging bucket totals (sum across all locations + SKUs) ──────────────────
  const age0_30   = ageing.reduce((s, r) => s + Number(r.qty_0_30 || 0), 0);
  const age31_60  = ageing.reduce((s, r) => s + Number(r.qty_31_60 || 0), 0);
  const age61_90  = ageing.reduce((s, r) => s + Number(r.qty_61_90 || 0), 0);
  const age91_180 = ageing.reduce((s, r) => s + Number(r.qty_91_180 || 0), 0);
  const age180p   = ageing.reduce((s, r) => s + Number(r.qty_180_plus || 0), 0);
  const ageTotal  = age0_30 + age31_60 + age61_90 + age91_180 + age180p;

  // Dead stock from ageing (more accurate than slow moving)
  const deadUnits = age180p || slowMoving.filter(s => Number(s.days_no_movement) > 180).length;
  const atRiskUnits = age91_180 || slowMoving.filter(s => {
    const d = Number(s.days_no_movement); return d >= 90 && d <= 180;
  }).length;

  // ── Chart configs ───────────────────────────────────────────────────────────
  // Sort sizes by stock desc, show top 30 for readability
  const sizesSorted = [...sizes].sort((a, b) => Number(b.total_stock) - Number(a.total_stock)).slice(0, 30);

  const sizeChartOptions = {
    chart: {
      type: 'bar', background: 'transparent',
      toolbar: { show: false },
      fontFamily: "'Inter', sans-serif",
      animations: { enabled: true, speed: 500 },
    },
    plotOptions: { bar: { horizontal: true, borderRadius: 6, barHeight: '62%', distributed: false } },
    colors: ['#3B82F6'],
    fill: {
      type: 'gradient',
      gradient: { shade: 'dark', type: 'horizontal', gradientToColors: ['#6366F1'], stops: [0, 100] },
    },
    xaxis: {
      categories: sizesSorted.map(s => s.size),
      labels: {
        style: { colors: '#64748B', fontSize: '11px', fontFamily: "'Inter', sans-serif", fontWeight: 700 },
        formatter: v => formatNumber(v),
      },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: {
      labels: {
        style: { colors: '#94A3B8', fontSize: '12px', fontFamily: "'Inter', sans-serif", fontWeight: 700 },
        maxWidth: 140,
      },
    },
    grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
    dataLabels: {
      enabled: true,
      textAnchor: 'start',
      offsetX: 6,
      style: { fontSize: '11px', fontFamily: "'Inter', sans-serif", fontWeight: 700, colors: ['#CBD5E1'] },
      formatter: v => formatNumber(v),
    },
    legend: { show: false },
    tooltip: {
      theme: 'dark',
      style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" },
      y: { formatter: v => formatNumber(v) + ' units in stock' },
    },
  };

  const colorChartOptions = {
    chart: { type: 'donut', background: 'transparent', fontFamily: "'Inter', sans-serif" },
    labels: colors.map(c => c.color_name),
    colors: PALETTE,
    legend: {
      position: 'bottom',
      labels: { colors: '#94A3B8' },
      fontSize: '12px', fontWeight: 700,
      fontFamily: "'Inter', sans-serif",
      markers: { radius: 4 },
    },
    dataLabels: { enabled: false },
    plotOptions: { pie: { donut: { size: '62%', labels: {
      show: true,
      name: { show: true, fontSize: '12px', fontFamily: "'Inter', sans-serif", fontWeight: 800, color: '#94A3B8' },
      value: { show: true, fontSize: '22px', fontFamily: "'Inter', sans-serif", fontWeight: 900, color: 'var(--text-primary)', formatter: v => formatNumber(v) },
      total: { show: true, label: 'Total Colours', color: '#64748B', fontSize: '11px', fontWeight: 800, fontFamily: "'Inter', sans-serif", formatter: () => colors.length },
    }}}},
    stroke: { width: 3, colors: ['#070C18'] },
    tooltip: {
      theme: 'dark',
      style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" },
      y: { formatter: v => formatNumber(v) + ' units' },
    },
  };

  return (
    <DashboardLayout
      title="Overview"
      subtitle="Executive overview — sales velocity, inventory position &amp; ageing across the network"
    >
      {/* Premium .sx-page wrapper — same design tokens as Sales / Network so
          all three pages share one visual language (hairline borders,
          gradient table headers, Plus Jakarta tabular hero numbers, soft
          shadows, sx-shimmer skeletons, mount fade). */}
      <div className="sx-page sx-fade ov-root">

      {/* ── Elite mode-swap micro-progress bar (Overview-only) ─────────
          Sub-30ms cache-hit swaps don't really need a progress UI, but
          a 1.5px hairline that pulses across the top during the swap
          gives the user a confident "got it" signal without any layout
          shift or content blanking. Pure CSS, GPU-accelerated. */}
      <div className="ov-swap-rail" data-active={modeSwapping ? '1' : '0'} aria-hidden />
      {/* Number-morph: numbers gently fade-out then fade-in on lens flip
          rather than instant-jump, so the new value lands smooth. */}
      <style jsx global>{`
        .ov-root { position: relative; }
        .ov-swap-rail {
          position: absolute; top: 0; left: 0; right: 0; height: 2px;
          background: linear-gradient(90deg,
            transparent 0%,
            #3B82F6 20%,
            #10B981 50%,
            #3B82F6 80%,
            transparent 100%);
          background-size: 200% 100%;
          opacity: 0; pointer-events: none;
          transition: opacity 120ms ease-out;
          will-change: background-position, opacity;
        }
        .ov-swap-rail[data-active="1"] {
          opacity: 1;
          animation: ovSwapShimmer 600ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes ovSwapShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes ovSpin {
          to { transform: rotate(360deg); }
        }
        @keyframes ovSwapPulse {
          0%, 100% { opacity: 0.85; }
          50%      { opacity: 1; }
        }
        /* Smooth number morph — applied only to PremiumKpi values inside
           the Overview hero so the lens flip feels expensive-soft. */
        .ov-root .sx-hero-num,
        .ov-root .kpi-value {
          transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1),
                      transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
        }
      `}</style>

      {/* ── v2 Universal FilterBar — 15 dimensions + Active/Inactive/All
          mode pill driving every widget on this page. URL-synced,
          multi-select, dependency-narrowing dropdowns. ─────────────── */}
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

      {/* ── Show pill (Sale/Return/Net) + Valuation dropdown + sync chip
          + Refresh. The two lenses are orthogonal: Sale-mode picks WHICH
          movement-type figure to show; Valuation picks the ₹ basis. ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginBottom: 22,
      }}>
        <span className="sx-eyebrow">Show</span>
        <ExecModePill
          mode={v2Filters.sale_mode || 'net'}
          onChange={(m) => setV2('sale_mode', m)}
        />
        <span className="sx-eyebrow" style={{ marginLeft: 14 }}>Valuation</span>
        <div style={{ position: 'relative' }}>
          <select
            value={v2Filters.valuation || 'gross'}
            onChange={e => setV2('valuation', e.target.value)}
            title="Pick the ₹ basis for every revenue figure on the page"
            style={{
              border: '1px solid var(--border-default)',
              borderRadius: 9, padding: '7px 30px 7px 12px', height: 32,
              fontSize: 12, fontWeight: 600, color: '#CBD5E1',
              background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-body)', minWidth: 178,
            }}
          >
            <option value="gross">Gross (with GST)</option>
            <option value="ex_gst">Ex-GST (revenue)</option>
            <option value="gst">GST collected</option>
            <option value="mrp">At MRP</option>
            <option value="discount">Discount given</option>
          </select>
          <svg style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.45 }}
            width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="#0B1220" strokeWidth={2.4}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div style={{ flex: 1 }} />
        <span className="sx-pill" style={{
          background: 'rgba(5, 150, 105, 0.06)',
          border: '1px solid rgba(5, 150, 105, 0.18)',
          color: '#059669',
          fontWeight: 700, letterSpacing: '0.02em', textTransform: 'none', fontSize: 11,
        }}>
          <span className="sx-pill-dot" />
          Last sync · {syncLabel}
        </span>
        <button onClick={fetchAll} className="sx-chip" style={{ height: 32 }}>
          <RefreshCw size={12} strokeWidth={2.2} color="#0B1220" />
          <span style={{ fontSize: 11, fontWeight: 700 }}>Refresh</span>
        </button>
      </div>

      {/* ══════════════════════════════════════════════
          EXECUTIVE HERO — 8 KPIs the CEO/CFO scans first.
          Lens-aware revenue + stock + alerts + return rate, all driven by
          the v2 FilterBar above. Hover any number for the raw figure.
      ══════════════════════════════════════════════ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Sparkles size={13} strokeWidth={2} style={{ color: 'var(--accent-primary)' }} />
        <span className="sx-eyebrow">Executive Pulse</span>
        <span className="sx-pill" style={{
          background: `${lensColor}10`,
          border: `1px solid ${lensColor}26`,
          color: lensColor,
        }}>
          <span className="sx-pill-dot" />
          {lensLabel} · {valuationLabel}
        </span>
        {modeSwapping && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999, fontSize: 11,
            fontWeight: 700, letterSpacing: '0.02em', color: '#2563EB',
            background: 'rgba(37, 99, 235, 0.06)',
            border: '1px solid rgba(37, 99, 235, 0.18)',
            animation: 'ovSwapPulse 1.2s ease-in-out infinite',
          }}>
            <span style={{
              display: 'inline-block', width: 7, height: 7, borderRadius: 999,
              border: '1.5px solid #2563EB', borderTopColor: 'transparent',
              animation: 'ovSpin 0.7s linear infinite',
            }} />
            switching to {(v2Filters.mode || 'active').toUpperCase()}…
          </span>
        )}
      </div>
      {/* No opacity dimming during swap — keep numbers at full clarity.
          The 1px shimmer rail at top + the small "switching…" badge are
          the only visual swap cues. With server-warmed cache + race-
          guard, the data arrives in 10-30ms anyway, so any longer
          transition was making it FEEL slow without being slow. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(208px, 1fr))',
        gap: 16, marginBottom: 28,
      }}>
        <PremiumKpi
          label={`${lensLabel} ${valuationLabel}`}
          icon={IndianRupee}
          accent="emerald"
          size="hero"
          value={lensRev} format="indian" prefix="₹"
          loading={loading}
          context={`avg ₹${formatNumber(saleUnits ? Math.round(saleRev / saleUnits) : 0)} per sold unit`}
        />
        <PremiumKpi
          label={`${lensLabel} Units`}
          icon={ShoppingBag}
          accent="brand" highlight
          size="hero"
          value={lensUnits} format="indian"
          loading={loading}
          context={`${formatNumber(saleUnits)} sold · ${formatNumber(returnUnits)} returned`}
        />
        <PremiumKpi
          label="Total Stock on Hand"
          icon={Package}
          accent="sky"
          size="hero"
          value={totalStock} format="indian"
          loading={loading}
          context={`MRP ${formatCurrency(totalValue)} · ${formatNumber(byType.reduce((s, t) => s + Number(t.location_count || 0), 0))} locations`}
        />
        <PremiumKpi
          label="Inventory Value"
          icon={DollarSign}
          accent="violet"
          size="hero"
          value={totalValue} format="indian" prefix="₹"
          loading={loading}
          context="MRP × qty across network"
        />
        <PremiumKpi
          label="Return Rate"
          icon={RotateCcw}
          accent={Number(salesSummary.return_rate_pct) >= 5 ? 'brand' : 'amber'}
          size="hero"
          value={Number(salesSummary.return_rate_pct || 0)} format="indian" suffix="%"
          loading={loading}
          context={`${formatNumber(returnUnits)} returns · ${formatCurrency(returnRev)}`}
        />
        <PremiumKpi
          label="Active Stores"
          icon={Building2}
          accent="teal"
          size="hero"
          value={Number(salesSummary.eligible_store_count || byType.reduce((s, t) => s + Number(t.location_count || 0), 0))}
          format="indian"
          loading={loading}
          context={(() => {
            const elig = Number(salesSummary.eligible_store_count || 0);
            const sold = Number(salesSummary.stores_with_sales || 0);
            const silent = Math.max(0, elig - sold);
            if (!elig) return 'inventory positions';
            return `${formatNumber(sold)} sold · ${silent > 0 ? `${formatNumber(silent)} silent` : 'all active'}`;
          })()}
        />
        <PremiumKpi
          label="Stock Alerts"
          icon={AlertTriangle}
          accent={totalAlerts > 0 ? 'brand' : 'emerald'}
          size="hero"
          value={totalAlerts} format="indian"
          loading={loading}
          context={totalAlerts > 0 ? `${formatNumber(outOfStock)} OOS · ${formatNumber(reorderNow)} reorder · ${formatNumber(lowStock)} low` : 'All stocked ✓'}
        />
      </div>

      {/* ══════════════════════════════════════════════
          SALES × NETWORK CROSS-PIVOT TABLES
          ──────────────────────────────────────────
          Three CXO-grade tables that join sales (movement) and
          network (inventory) data in a single round-trip:
            • Best-sellers ↔ Stock position (where is the stock?)
            • Top stores ↔ Performance (revenue + stock parked)
            • Stock-out at busy stores (transfer candidates)
          Mode + filter aware, race-guarded, server-cached 5 min,
          frontend cached per filter hash. Click row → drill-down.
      ══════════════════════════════════════════════ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, marginTop: 8 }}>
        <Layers size={13} strokeWidth={2} style={{ color: 'var(--accent-primary)' }} />
        <span className="sx-eyebrow">Sales × Network · Cross-Pivot Intelligence</span>
        <span className="sx-pill" style={{
          background: 'rgba(124, 58, 237, 0.06)',
          border: '1px solid rgba(124, 58, 237, 0.18)',
          color: '#7C3AED',
        }}>
          <span className="sx-pill-dot" />
          Live · {(v2Filters.mode || 'active').toUpperCase()}
        </span>
      </div>
      <CrossPivotTables
        fetchFn={(p) => analyticsService.getOverviewCrossPivot(p).then(r => r.data.data)}
        filterParams={{
          date_from: '2025-01-01',
          date_to:   '2026-01-31',
          ...buildSalesParams(v2Filters.mode || 'active'),
        }}
        cacheGet={getCached}
        cacheSet={setCached}
        isCacheFresh={isFresh}
        lensMode={v2Filters.sale_mode || 'net'}
        onSkuClick={(sku) => setDrillTarget({ type: 'sku', id: sku.id, name: sku.name, product: sku.product })}
        onStoreClick={(store) => setDrillTarget({ type: 'store', id: store.id, name: store.name })}
      />

      {/* ══════════════════════════════════════════════
          SECTION 2 — STOCK BY STORE TYPE + ALERTS
      ══════════════════════════════════════════════ */}
      <Section title="Channel Breakdown & Alerts" icon={BarChart3} mb={32}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>

          {/* Left: store type bars */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Stock Distribution by Channel</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
                {formatNumber(totalStock)} units total
              </span>
            </div>
            <div className="card-body">
              {loading
                ? [1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 34, marginBottom: 16 }} />)
                : byType.length === 0
                  ? <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 32 }}>No data available</div>
                  : byType.map((t, i) => (
                    <StoreTypeBar
                      key={t.location_type || i}
                      name={t.location_type}
                      stock={Number(t.total_stock || 0)}
                      total={channelTotal}
                      count={Number(t.location_count || 0)}
                      color={PALETTE[i % PALETTE.length]}
                    />
                  ))
              }
            </div>
          </div>

          {/* Right: alerts */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Stock Alert Summary</span>
              <span style={{
                fontSize: 12, fontWeight: 700,
                color: totalAlerts > 0 ? '#DC2626' : '#059669',
              }}>
                <span title={totalAlerts > 0 ? `Exact: ${totalAlerts.toLocaleString('en-IN')} alerts` : undefined}>
                  {totalAlerts > 0 ? `${formatNumber(totalAlerts)} alerts active` : '✓ All Clear'}
                </span>
              </span>
            </div>
            <div className="card-body">
              <AlertBox
                icon={XCircle}
                color="#DC2626"
                title="Out of Stock"
                description={`${outOfStock} location-SKU combinations at zero inventory. Immediate replenishment required.`}
                count={outOfStock}
              />
              <AlertBox
                icon={AlertCircle}
                color="#D97706"
                title="Reorder Now"
                description={`${reorderNow} combinations critically below safety stock. Initiate replenishment.`}
                count={reorderNow}
              />
              <AlertBox
                icon={AlertTriangle}
                color="#0284C7"
                title="Low Stock"
                description={`${lowStock} combinations below minimum stock threshold. Monitor closely.`}
                count={lowStock}
              />

              {/* Dead & at-risk summary */}
              <div style={{
                marginTop: 16, padding: '14px 16px',
                borderRadius: 12, background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Non-Moving Inventory
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ textAlign: 'center', padding: '10px', background: '#FFF1F2', borderRadius: 10, border: '1px solid #FECDD3' }}>
                    <div style={{ fontSize: 26, fontWeight: 800, color: '#DC2626', fontFamily: 'var(--font-display)', lineHeight: 1 }}>{formatNumber(deadUnits)}</div>
                    <div style={{ fontSize: 12, color: '#9F1239', marginTop: 4, fontWeight: 500 }}>Dead Stock</div>
                    <div style={{ fontSize: 11, color: '#9F1239', opacity: 0.7 }}>Sitting 180+ days</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '10px', background: '#FFFBEB', borderRadius: 10, border: '1px solid #FDE68A' }}>
                    <div style={{ fontSize: 26, fontWeight: 800, color: '#D97706', fontFamily: 'var(--font-display)', lineHeight: 1 }}>{formatNumber(atRiskUnits)}</div>
                    <div style={{ fontSize: 12, color: '#92400E', marginTop: 4, fontWeight: 500 }}>At Risk</div>
                    <div style={{ fontSize: 11, color: '#92400E', opacity: 0.7 }}>Sitting 90–180 days</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ══════════════════════════════════════════════
          SECTION 3 — HOW FRESH IS YOUR STOCK?
      ══════════════════════════════════════════════ */}
      <Section title="Inventory Aging" icon={TrendingDown} color="#D97706" mb={32}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Inventory Ageing Analysis</span>
            {ageTotal > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
                {formatNumber(ageTotal)} units tracked
              </span>
            )}
          </div>
          <div className="card-body">
            {loading ? (
              [1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton" style={{ height: 38, marginBottom: 14 }} />)
            ) : ageTotal === 0 ? (
              <div style={{
                padding: '20px 24px', borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)', fontSize: 14, textAlign: 'center',
              }}>
                Stock age data not available yet. This is calculated during the nightly ERP sync.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
                <div>
                  <AgingRow label="0 – 30 Days" hint="Fresh — within normal replenishment cycle" qty={age0_30} total={ageTotal} color="#059669" emoji="●" />
                  <AgingRow label="31 – 60 Days" hint="Healthy — standard sell-through window" qty={age31_60} total={ageTotal} color="#0284C7" emoji="●" />
                  <AgingRow label="61 – 90 Days" hint="Slow-moving — review replenishment plan" qty={age61_90} total={ageTotal} color="#D97706" emoji="●" />
                  <AgingRow label="91 – 180 Days" hint="At risk — markdowns or reallocation advised" qty={age91_180} total={ageTotal} color="#EA580C" emoji="●" />
                  <AgingRow label="180+ Days" hint="Dead stock — immediate liquidation action" qty={age180p} total={ageTotal} color="#DC2626" emoji="●" />
                </div>

                {/* Visual stacked bar */}
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Visual Split
                  </div>
                  <div style={{ height: 300, borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--border-subtle)' }}>
                    {[
                      { qty: age0_30,   color: '#059669', label: '0–30 days' },
                      { qty: age31_60,  color: '#0284C7', label: '31–60 days' },
                      { qty: age61_90,  color: '#D97706', label: '61–90 days' },
                      { qty: age91_180, color: '#EA580C', label: '91–180 days' },
                      { qty: age180p,   color: '#DC2626', label: '180+ days' },
                    ].map((b, i) => {
                      const pct = ageTotal > 0 ? (b.qty / ageTotal) * 100 : 0;
                      if (pct < 0.5) return null;
                      return (
                        <div key={i} style={{
                          flex: pct, background: b.color,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'flex 1s ease', minHeight: pct > 3 ? 24 : 0,
                          position: 'relative', overflow: 'visible',
                        }}>
                          {pct >= 2 && (
                            <span style={{
                              color: '#fff',
                              fontSize: pct >= 8 ? 12 : pct >= 4 ? 10 : 9,
                              fontWeight: 700,
                              textShadow: '0 1px 3px rgba(0,0,0,0.4)',
                              whiteSpace: 'nowrap',
                              pointerEvents: 'none',
                            }}>
                              {b.label} · {Math.round(pct)}%
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {[
                      { color: '#059669', label: '0–30 days (Fresh)' },
                      { color: '#0284C7', label: '31–60 days (Good)' },
                      { color: '#D97706', label: '61–90 days (Slow)' },
                      { color: '#EA580C', label: '91–180 days (At Risk)' },
                      { color: '#DC2626', label: '180+ days (Dead)' },
                    ].map((l, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
                        <div style={{ width: 10, height: 10, borderRadius: 3, background: l.color, flexShrink: 0 }} />
                        {l.label}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* ══════════════════════════════════════════════
          SECTION 3.5 — STOCK ALERTS (Store × SKU drill-down)
      ══════════════════════════════════════════════ */}
      <StockAlertsSection
        alerts={alerts}
        alertSummary={alertSummary}
        pageLoading={alertsLoading}
      />

      {/* ══════════════════════════════════════════════
          SECTION 4 — SIZE & COLOUR
      ══════════════════════════════════════════════ */}
      <SizeColorSection
        initialSizes={sizes}
        initialColors={colors}
        allStoresData={salesTop}
        pageLoading={loading}
      />

      {/* ══════════════════════════════════════════════
          SECTION 5 — SKU PERFORMANCE
      ══════════════════════════════════════════════ */}
      <SkuPerformanceSection
        initialTopMoving={topMoving}
        initialSlowMoving={slowMoving}
        allStoresData={salesTop}
        pageLoading={loading}
      />

      {/* ══════════════════════════════════════════════
          SECTION 6 — URGENT: OUT OF STOCK
      ══════════════════════════════════════════════ */}
      {!loading && outOfStock > 0 && (
        <Section title="Zero Stock — Action Required" icon={XCircle} color="#DC2626" mb={0}>
          <div className="card" style={{ border: '1px solid #FECDD3' }}>
            <div className="card-header" style={{ background: '#FFF1F2', borderBottom: '1px solid #FECDD3' }}>
              <span className="card-title" style={{ color: '#9F1239' }}>
                🔴 Out of Stock — Immediate Replenishment Required
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#DC2626' }}>
                {outOfStock} location-SKU combinations at zero
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Channel</th>
                    <th>SKU Code</th>
                    <th>Colour</th>
                    <th>Size</th>
                    <th style={{ textAlign: 'right' }}>Qty On Hand</th>
                    <th style={{ textAlign: 'right' }}>Safety Stock</th>
                    <th style={{ textAlign: 'right' }}>Shortfall</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts
                    .filter(a => a.alert_level === 'OUT_OF_STOCK')
                    .slice(0, 20)
                    .map((a, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? 'rgba(220,38,38,0.02)' : '' }}>
                        <td style={{ fontWeight: 600 }}>{a.location_name}</td>
                        <td>
                          <span className="badge badge-neutral" style={{ fontSize: 11 }}>{a.location_type}</span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{a.sku_code}</td>
                        <td style={{ fontSize: 13 }}>{a.color_name}</td>
                        <td style={{ fontWeight: 700, fontFamily: 'var(--font-display)', fontSize: 15 }}>{a.size}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#DC2626', fontSize: 14 }}>0</td>
                        <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 13 }}>{a.safety_stock}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="badge badge-danger" style={{ fontSize: 12 }}>−{a.shortfall_pct}%</span>
                        </td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        </Section>
      )}

      {/* ══════════════════════════════════════════════
          SALES RANKINGS — dynamic Top N
      ══════════════════════════════════════════════ */}
      <SalesRankingsSection salesTop={salesTop} loading={loading} />
      <ReturnsRankingsSection salesTop={salesTop} />

      </div>{/* /.sx-page */}

      {/* ══════════════════════════════════════════════
          DrilldownDrawer — opens when a SKU or store row in
          ANY of the cross-pivot tables is clicked. Reuses the
          same elite slide-over drawer the Sales page uses
          (KPIs, top SKUs / stores, colour & size breakdowns,
          lens + valuation aware). One source of truth, both
          pages share the same drill experience.
      ══════════════════════════════════════════════ */}
      {drillTarget && (
        <DrilldownDrawer
          target={drillTarget}
          onClose={() => setDrillTarget(null)}
          filters={{
            date_from: '2025-01-01',
            date_to:   '2026-01-31',
            ...buildSalesParams(v2Filters.mode || 'active'),
          }}
          lensMode={v2Filters.sale_mode || 'net'}
          valuation={v2Filters.valuation || 'gross'}
        />
      )}
    </DashboardLayout>
  );
}

Overview.getLayout = (page) => page;
