import { useState, useEffect, useCallback, useMemo } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import {
  Package, DollarSign, IndianRupee, AlertTriangle, Truck, RefreshCw,
  TrendingUp, TrendingDown, Layers, BarChart3, MapPin,
  CheckCircle, XCircle, AlertCircle, Info, Search, Bell,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import {
  inventoryService, analyticsService, syncService,
  skuService, dispatchService,
} from '../lib/services';
import { formatNumber, formatCurrency, timeAgo } from '../lib/utils';
import toast from 'react-hot-toast';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const PALETTE = ['#C0392B', '#0284C7', '#059669', '#D97706', '#DC2626', '#0D9488', '#E74C3C', '#EA580C'];

// ─── Section header with optional hint line ──────────────────────────────────
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
        <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
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

function SalesRankingsSection({ salesTop: initialData, loading: initialLoading }) {
  const [colorTopN,   setColorTopN]  = useState(15);
  const [sizeTopN,    setSizeTopN]   = useState(15);
  const [storeTopN,   setStoreTopN]  = useState(15);
  const [dateFrom,    setDateFrom]   = useState('2025-01-01');
  const [dateTo,      setDateTo]     = useState('2026-01-31');
  const [selState,    setSelState]   = useState('');
  const [selCity,     setSelCity]    = useState('');
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
      if (selState) params.state = selState;
      if (selCity)  params.city  = selCity;
      const res = await analyticsService.getSalesAnalytics(params);
      setRankData(res.data.data);
    } catch (_) {}
    setRankLoading(false);
  }, [dateFrom, dateTo, selState, selCity]);

  const data    = rankData;
  const loading = initialLoading || rankLoading;

  const fmtV   = v => v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
  const fmtRev = v => v >= 10000000 ? '₹' + (v / 10000000).toFixed(1) + 'Cr'
                    : v >= 100000    ? '₹' + (v / 100000).toFixed(1) + 'L'
                    : '₹' + v.toLocaleString('en-IN');
  const colorBarH   = n => n <= 10 ? '55%' : n <= 20 ? '62%' : n <= 50 ? '70%' : '78%';
  const colorChartH = n => Math.max(320, n * (n <= 20 ? 28 : n <= 50 ? 20 : 14));

  const inputStyle  = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff' };
  const selectStyle = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer', minWidth: 120 };

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
        <button onClick={() => { setDateFrom('2025-01-01'); setDateTo('2026-01-31'); setSelState(''); setSelCity(''); setTimeout(fetchRankings, 0); }} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>
          Reset
        </button>
      </div>

      <div style={{ background: '#f8fafc', border: '1px solid #e8edf2', borderRadius: 14, padding: 16 }}>
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
              style={{ border: '1.5px solid #d1fae5', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#065f46', background: '#f0fdf4', outline: 'none', cursor: 'pointer' }}
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
                  xaxis: { labels: { style: { colors: '#475569', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                  yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                  dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#064e3b'] }, formatter: fmtV },
                  grid: { borderColor: '#f0fdf4', strokeDashArray: 3 },
                  tooltip: { style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
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
                style={{ border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', background: '#fff', outline: 'none', cursor: 'pointer' }}
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
                    xaxis: { labels: { style: { colors: '#475569', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 700, fontSize: '12px' }, maxWidth: 80 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#0c4a6e'] }, formatter: fmtV },
                    grid: { borderColor: '#f0f9ff', strokeDashArray: 3 },
                    tooltip: { style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
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
                style={{ border: '1.5px solid #fecaca', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#991b1b', background: '#fff5f5', outline: 'none', cursor: 'pointer' }}
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
                    xaxis: { labels: { style: { colors: '#475569', fontWeight: 600, fontSize: '11px' }, formatter: fmtRev }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#7f1d1d'] }, formatter: fmtRev },
                    grid: { borderColor: '#fff1f2', strokeDashArray: 3 },
                    tooltip: { style: { fontSize: '12px' }, y: { formatter: v => '₹' + v.toLocaleString('en-IN') } },
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

  const inputStyle  = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff' };
  const selectStyle = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer', minWidth: 120 };

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
          <select value={selCity} onChange={e => setSelCity(e.target.value)} style={selectStyle}>
            <option value="">All Cities</option>
            {cityList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button onClick={() => doFetch({ date_from: dateFrom, date_to: dateTo, ...(selState && { state: selState }), ...(selCity && { city: selCity }) })}
          style={{ padding: '5px 16px', borderRadius: 8, fontSize: 12, fontWeight: 800, background: '#EA580C', color: '#fff', border: 'none', cursor: 'pointer' }}>Apply</button>
        <button onClick={() => { setDateFrom('2025-01-01'); setDateTo('2026-01-31'); setSelState(''); setSelCity(''); doFetch({ date_from: '2025-01-01', date_to: '2026-01-31' }); }}
          style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: '#475569', border: '1.5px solid #e2e8f0', cursor: 'pointer' }}>Reset</button>
      </div>

      <div style={{ background: '#f8fafc', border: '1px solid #e8edf2', borderRadius: 14, padding: 16 }}>
      {/* Colour chart — orange tones */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">Top {colorTopN} Colours by Units Returned</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Show</span>
            <select value={colorTopN} onChange={e => setColorTopN(Number(e.target.value))}
              style={{ border: '1.5px solid #fed7aa', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#7c2d12', background: '#fff7ed', outline: 'none', cursor: 'pointer' }}>
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
                  xaxis: { labels: { style: { colors: '#475569', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                  yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                  dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#7c2d12'] }, formatter: fmtV },
                  grid: { borderColor: '#fff7ed', strokeDashArray: 3 },
                  tooltip: { style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
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
                style={{ border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', background: '#fff', outline: 'none', cursor: 'pointer' }}>
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
                    xaxis: { labels: { style: { colors: '#475569', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 700, fontSize: '12px' }, maxWidth: 80 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#4C1D95'] }, formatter: fmtV },
                    grid: { borderColor: '#fff5f4', strokeDashArray: 3 },
                    tooltip: { style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
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
                style={{ border: '1.5px solid #fed7aa', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#7c2d12', background: '#fff7ed', outline: 'none', cursor: 'pointer' }}>
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
                    xaxis: { labels: { style: { colors: '#475569', fontWeight: 600, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                    yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 700, fontSize: '12px' }, maxWidth: 130 } },
                    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#831843'] }, formatter: fmtV },
                    grid: { borderColor: '#fdf2f8', strokeDashArray: 3 },
                    tooltip: { style: { fontSize: '12px' }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
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
  const [sizeTopN,   setSizeTopN]   = useState(10);
  const [colorTopN,  setColorTopN]  = useState(10);
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [selState,   setSelState]   = useState('');
  const [selCity,    setSelCity]    = useState('');
  const [sizesData,  setSizesData]  = useState(initialSizes  || []);
  const [colorsData, setColorsData] = useState(initialColors || []);
  const [scLoading,  setScLoading]  = useState(false);

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
    if (dateFrom) p.date_from = dateFrom;
    if (dateTo)   p.date_to   = dateTo;
    if (selState) p.state     = selState;
    if (selCity)  p.city      = selCity;
    doFetchSC(p);
  }, [dateFrom, dateTo, selState, selCity, doFetchSC]);

  const resetSC = useCallback(() => {
    setDateFrom(''); setDateTo(''); setSelState(''); setSelCity('');
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

  const inputStyle  = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff' };
  const selectStyle = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer', minWidth: 120 };

  const legendStyle = {
    position: 'bottom', fontSize: '12px', fontWeight: 700,
    fontFamily: "'Inter', sans-serif",
    labels: { colors: '#0f172a' },
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

      <div style={{ background: '#f8fafc', border: '1px solid #e8edf2', borderRadius: 14, padding: 16 }}>
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
                style={{ border: '1.5px solid #bae6fd', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#0369a1', background: '#f0f9ff', outline: 'none', cursor: 'pointer' }}
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
                style={{ border: '1.5px solid #d1fae5', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#065f46', background: '#f0fdf4', outline: 'none', cursor: 'pointer' }}
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
                      xaxis: { labels: { style: { colors: '#475569', fontWeight: 700, fontSize: '11px' }, formatter: fmtV }, axisBorder: { show: false }, axisTicks: { show: false } },
                      yaxis: { labels: { style: { colors: '#0f172a', fontWeight: 800, fontSize: '12px' }, maxWidth: 160 } },
                      dataLabels: { enabled: true, textAnchor: 'start', offsetX: 6, style: { fontSize: '12px', fontWeight: 900, colors: ['#4C1D95'] }, formatter: fmtV },
                      grid: { strokeDashArray: 3, borderColor: '#f3f4f6' },
                      tooltip: { style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" }, y: { formatter: v => v.toLocaleString('en-IN') + ' units' } },
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
    if (selState) { topParams.state = selState; slowParams.state = selState; }
    if (selCity)  { topParams.city  = selCity;  slowParams.city  = selCity;  }
    doFetch(topParams, slowParams);
  }, [topN, slowDays, dateFrom, dateTo, selState, selCity, doFetch]);

  const resetFilters = useCallback(() => {
    setDateFrom('2025-01-01');
    setDateTo('2026-01-31');
    setSelState('');
    setSelCity('');
    doFetch(
      { n: topN, date_from: '2025-01-01', date_to: '2026-01-31' },
      { days: slowDays }
    );
  }, [topN, slowDays, doFetch]);

  const loading    = pageLoading || skuLoading;
  const topMoving  = topMovingData  || [];
  const slowMoving = slowMovingData || [];

  const inputStyle  = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff' };
  const selectStyle = { border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '5px 28px 5px 10px', fontSize: 12, fontWeight: 700, color: '#0f172a', outline: 'none', background: '#fff', appearance: 'none', cursor: 'pointer', minWidth: 120 };

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

      <div style={{ background: '#f8fafc', border: '1px solid #e8edf2', borderRadius: 14, padding: 16 }}>
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
                    { n, date_from: dateFrom, date_to: dateTo, ...(selState && { state: selState }), ...(selCity && { city: selCity }) },
                    { days: slowDays, ...(selState && { state: selState }), ...(selCity && { city: selCity }) }
                  );
                }}
                style={{ border: '1.5px solid #fecaca', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#5b21b6', background: '#fff5f4', outline: 'none', cursor: 'pointer' }}
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
                style={{ border: '1.5px solid #fecaca', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#991b1b', background: '#fff5f5', outline: 'none', cursor: 'pointer' }}
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
                    { n: topN, date_from: dateFrom, date_to: dateTo, ...(selState && { state: selState }), ...(selCity && { city: selCity }) },
                    { days, ...(selState && { state: selState }), ...(selCity && { city: selCity }) }
                  );
                }}
                style={{ border: '1.5px solid #fecaca', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#991b1b', background: '#fff5f5', outline: 'none', cursor: 'pointer' }}
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
  const [search,    setSearch]    = useState('');
  const [selState,  setSelState]  = useState('');
  const [selCity,   setSelCity]   = useState('');
  const [levelTab,  setLevelTab]  = useState('ALL');
  const [pageSize,  setPageSize]  = useState(30);
  const [page,      setPage]      = useState(1);

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
  }, [alerts, search, selState, selCity, levelTab]);

  // ── Reset page when filters change ──
  useEffect(() => { setPage(1); }, [search, selState, selCity, levelTab, pageSize]);

  // ── Reset city when state changes ──
  useEffect(() => { setSelCity(''); }, [selState]);

  // ── Pagination math ──
  const totalRows  = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage   = Math.min(page, totalPages);
  const offset     = (safePage - 1) * pageSize;
  const pageRows   = filtered.slice(offset, offset + pageSize);

  const hasFilter = !!(search || selState || selCity || levelTab !== 'ALL');
  const clearAll = () => { setSearch(''); setSelState(''); setSelCity(''); setLevelTab('ALL'); setPage(1); };

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

      {/* ── Table ── */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: '#f8fafc' }}>
                {['#','Alert','Store','State / City','Channel','SKU','Product','Colour','Size','On Hand','Safety','Reorder','Shortfall'].map(h => (
                  <th key={h} style={{
                    padding: '10px 12px',
                    textAlign: ['#','On Hand','Safety','Reorder','Shortfall'].includes(h) ? 'right' : 'left',
                    fontSize: 10, fontWeight: 900, color: '#0f172a', letterSpacing: '0.07em', textTransform: 'uppercase',
                    borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageLoading
                ? Array.from({ length: Math.min(pageSize, 10) }).map((_, i) => (
                    <tr key={i}><td colSpan={13} style={{ padding: '10px 12px' }}><div style={{ height: 14, background: '#f1f5f9', borderRadius: 4 }} /></td></tr>
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
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 800, color: '#94a3b8', width: 42 }}>{rowNum}</td>
                          <td style={{ padding: '9px 12px' }}>
                            <span style={{
                              background: lvl.bg, color: lvl.color, border: `1px solid ${lvl.border}`,
                              borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap', letterSpacing: '0.02em',
                            }}>{lvl.label}</span>
                          </td>
                          <td style={{ padding: '9px 12px', fontSize: 12, fontWeight: 800, color: '#0f172a', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.location_name || '—'}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>{r.state || '—'}{r.city ? ` · ${r.city}` : ''}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: '#64748b', whiteSpace: 'nowrap' }}>{r.location_type || '—'}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, fontWeight: 800, color: '#1d4ed8', whiteSpace: 'nowrap' }}>{r.sku_code || '—'}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: '#475569', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.product_name || '—'}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>{r.color_name || '—'}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>{r.size || '—'}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontSize: 12, fontWeight: 900, color: r.qty_on_hand === 0 ? '#DC2626' : '#0f172a', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(Number(r.qty_on_hand || 0))}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(Number(r.safety_stock || 0))}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(Number(r.reorder_point || 0))}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 800, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>{shortfall}</td>
                        </tr>
                      );
                    })
              }
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {!pageLoading && totalRows > 0 && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f8fafc', flexWrap: 'wrap', gap: 10 }}>
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
      </div>
    </Section>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Overview() {
  const [summary, setSummary]       = useState(null);
  const [sizes, setSizes]           = useState([]);
  const [colors, setColors]         = useState([]);
  const [salesTop, setSalesTop]     = useState(null);
  const [topMoving, setTopMoving]   = useState([]);
  const [slowMoving, setSlowMoving] = useState([]);
  const [alerts, setAlerts]         = useState([]);
  const [alertSummary, setAlertSummary] = useState({ out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 });
  const [ageing, setAgeing]         = useState([]);
  const [lastSync, setLastSync]     = useState(null);
  const [inTransit, setInTransit]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [syncLabel, setSyncLabel]   = useState('—');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, sizeRes, colorRes, topRes, slowRes, alertRes, syncRes, transitRes, ageRes, salesTopRes] =
        await Promise.allSettled([
          inventoryService.getExecutiveSummary(),
          analyticsService.getSizeDistribution(),
          analyticsService.getColorDistribution(),
          skuService.getTopMoving({ n: 12, days: 30 }),
          skuService.getSlowMoving({ days: 90 }),
          inventoryService.getAlerts(),
          syncService.getStatus(),
          dispatchService.getInTransit(),
          inventoryService.getAgeing(),
          analyticsService.getSalesAnalytics({ date_from: '2025-01-01', date_to: '2026-01-31' }),
        ]);
      if (sumRes.status      === 'fulfilled') setSummary(sumRes.value.data.data);
      if (sizeRes.status     === 'fulfilled') setSizes(sizeRes.value.data.data || []);
      if (colorRes.status    === 'fulfilled') setColors(colorRes.value.data.data || []);
      if (topRes.status      === 'fulfilled') setTopMoving(topRes.value.data.data || []);
      if (slowRes.status     === 'fulfilled') setSlowMoving(slowRes.value.data.data || []);
      if (alertRes.status    === 'fulfilled') {
        setAlerts(alertRes.value.data.data || []);
        setAlertSummary(alertRes.value.data.summary || { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 });
      }
      if (syncRes.status     === 'fulfilled') setLastSync(syncRes.value.data.data);
      if (transitRes.status  === 'fulfilled') setInTransit(transitRes.value.data.data || []);
      if (ageRes.status      === 'fulfilled') setAgeing(ageRes.value.data.data || []);
      if (salesTopRes.status === 'fulfilled') setSalesTop(salesTopRes.value.data.data);
    } catch { toast.error('Failed to load dashboard'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

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
    colors: ['#2563EB'],
    fill: {
      type: 'gradient',
      gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#6366F1'], stops: [0, 100] },
    },
    xaxis: {
      categories: sizesSorted.map(s => s.size),
      labels: {
        style: { colors: '#334155', fontSize: '11px', fontFamily: "'Inter', sans-serif", fontWeight: 700 },
        formatter: v => formatNumber(v),
      },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: {
      labels: {
        style: { colors: '#0f172a', fontSize: '12px', fontFamily: "'Inter', sans-serif", fontWeight: 800 },
        maxWidth: 140,
      },
    },
    grid: { borderColor: '#f1f5f9', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
    dataLabels: {
      enabled: true,
      textAnchor: 'start',
      offsetX: 6,
      style: { fontSize: '11px', fontFamily: "'Inter', sans-serif", fontWeight: 700, colors: ['#0f172a'] },
      formatter: v => formatNumber(v),
    },
    legend: { show: false },
    tooltip: {
      theme: 'light',
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
      labels: { colors: '#0f172a' },
      fontSize: '12px', fontWeight: 700,
      fontFamily: "'Inter', sans-serif",
      markers: { radius: 4 },
    },
    dataLabels: { enabled: false },
    plotOptions: { pie: { donut: { size: '62%', labels: {
      show: true,
      name: { show: true, fontSize: '12px', fontFamily: "'Inter', sans-serif", fontWeight: 800, color: '#0f172a' },
      value: { show: true, fontSize: '22px', fontFamily: "'Inter', sans-serif", fontWeight: 900, color: '#0f172a', formatter: v => formatNumber(v) },
      total: { show: true, label: 'Total Colours', color: '#334155', fontSize: '11px', fontWeight: 800, fontFamily: "'Inter', sans-serif", formatter: () => colors.length },
    }}}},
    stroke: { width: 3, colors: ['#fff'] },
    tooltip: {
      theme: 'light',
      style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" },
      y: { formatter: v => formatNumber(v) + ' units' },
    },
  };

  return (
    <DashboardLayout
      title="Overview"
      subtitle="Executive overview — inventory position, ageing, velocity &amp; alerts"
    >

      {/* ── Top bar: last sync + refresh ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 28, padding: '12px 18px',
        background: '#FFFFFF', borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-card)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#059669', boxShadow: '0 0 6px #059669' }} />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
            Last ERP Sync ·{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{syncLabel}</strong>
          </span>
        </div>
        <button className="btn btn-ghost" style={{ padding: '7px 14px', fontSize: 13 }} onClick={fetchAll}>
          <RefreshCw size={13} /> Refresh All
        </button>
      </div>

      {/* ══════════════════════════════════════════════
          SECTION 1 — OVERALL NUMBERS
      ══════════════════════════════════════════════ */}
      <Section title="Stock Overview" icon={Package} mb={32}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <KpiBox
            label="Total Stock"
            value={loading ? '—' : formatNumber(totalStock)}
            icon={Package}
            color="#C0392B"
            sub="Total units across network"
            loading={loading}
          />
          <KpiBox
            label="Inventory Valuation"
            value={loading ? '—' : formatCurrency(totalValue)}
            icon={IndianRupee}
            color="#059669"
            sub="Retail value of stock on hand"
            loading={loading}
          />
          <KpiBox
            label="Active Locations"
            value={loading ? '—' : formatNumber(byType.reduce((s, t) => s + Number(t.location_count || 0), 0))}
            icon={MapPin}
            color="#0284C7"
            sub="Locations with active inventory"
            loading={loading}
          />
          <KpiBox
            label="Stock Alerts"
            value={loading ? '—' : totalAlerts}
            icon={AlertTriangle}
            color={totalAlerts > 0 ? '#DC2626' : '#059669'}
            sub={totalAlerts > 0 ? `${outOfStock} zero-stock SKUs` : 'All locations stocked ✓'}
            loading={loading}
          />
        </div>
      </Section>

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
        pageLoading={loading}
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

    </DashboardLayout>
  );
}

Overview.getLayout = (page) => page;
