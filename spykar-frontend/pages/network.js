import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import { locationService, analyticsService } from '../lib/services';
import toast from 'react-hot-toast';
import {
  Globe, Package, MapPin, PieChart, BarChart2,
  RefreshCw, TrendingUp, Layers, Activity,
} from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

// ── Typography — identical to sales page ───────────────────────────────────
const T = {
  primary:   '#0f172a',
  secondary: '#1e293b',
  muted:     '#334155',
  border:    '#e2e8f0',
  bg:        '#f8fafc',
  accent:    '#0f172a',
};

// ── Chart base theme — identical to sales page ────────────────────────────
const chartBase = {
  fontFamily: 'Inter, system-ui, sans-serif',
  toolbar: { show: false },
  zoom: { enabled: false },
  animations: { enabled: true, speed: 600 },
};

// ── Formatters — identical to sales page ──────────────────────────────────
function fmtL(n) {
  if (!n && n !== 0) return '—';
  n = Number(n);
  if (n >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return (n / 100000).toFixed(2) + 'L';
  if (n >= 1000)     return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}
function fmtNum(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('en-IN');
}

// ── Shared filter styles — identical to sales page ─────────────────────────
const filterInput  = { border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 10px 6px 30px', fontSize: 12, fontWeight: 700, color: T.primary, outline: 'none', background: T.bg };
const filterSelect = { border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 28px 6px 10px', fontSize: 12, fontWeight: 700, color: T.primary, outline: 'none', background: T.bg, appearance: 'none', cursor: 'pointer' };
const SearchIcon   = () => <svg style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', opacity: 0.45 }} width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.5}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const ChevronIcon  = () => <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>;

// ── KPI Card — identical to sales page ────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, sub2, accent = '#0f172a', loading }) {
  return (
    <div style={{
      background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16,
      padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 8,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent, borderRadius: '16px 16px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: accent + '14', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={14} color={accent} strokeWidth={2.5} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, color: T.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
      </div>
      {loading
        ? <div style={{ height: 38, background: '#f1f5f9', borderRadius: 8 }} />
        : <div style={{ fontSize: 32, fontWeight: 900, color: T.primary, letterSpacing: '-0.03em', lineHeight: 1 }}>{value}</div>
      }
      {sub  && <div style={{ fontSize: 12, fontWeight: 700, color: T.muted }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, marginTop: -4 }}>{sub2}</div>}
    </div>
  );
}

// ── Section Title — identical to sales page ───────────────────────────────
function SectionTitle({ icon: Icon, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <Icon size={16} color={T.primary} strokeWidth={2.5} />
      <span style={{ fontSize: 13, fontWeight: 900, color: T.primary, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
    </div>
  );
}

// ── Channel Breakdown — robust, always sorted by stock ────────────────────
function ChannelBreakdownSection({ groups, loading }) {
  // Always sorted by stock descending — most meaningful view
  const rows = useMemo(() => {
    return [...(groups || [])].sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0));
  }, [groups]);

  const totalStock = rows.reduce((s, r) => s + Number(r.stock || 0), 0);
  const maxStock   = rows[0] ? Number(rows[0].stock || 0) : 1;

  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <PieChart size={13} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Channel Breakdown</span>
          {!loading && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: T.primary, borderRadius: 100, padding: '2px 7px' }}>{rows.length}</span>}
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>Sorted by highest stock</span>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: 420 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr style={{ background: T.bg }}>
              {['#','Channel / Group','Billing','Distribution','Locations','Total Stock','Share %'].map(h => (
                <th key={h} style={{ padding: '9px 14px', textAlign: ['Locations','Total Stock','Share %'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} style={{ padding: '9px 14px' }}><div style={{ height: 13, background: T.bg, borderRadius: 4 }} /></td></tr>
                ))
              : rows.map((r, i) => {
                  const pct   = maxStock > 0 ? Math.round((Number(r.stock || 0) / maxStock) * 100) : 0;
                  const share = totalStock > 0 ? ((Number(r.stock || 0) / totalStock) * 100).toFixed(1) : '0.0';
                  return (
                    <tr key={i}
                      style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? '#fff' : '#fafafe' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f0f4ff'}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafe'}
                    >
                      <td style={{ padding: '9px 14px', fontSize: 11, fontWeight: 700, color: T.muted, width: 36 }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 800, color: T.primary }}>{r.group_name || '—'}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ background: r.billing_model === 'OUTRIGHT' ? '#FEF3C7' : '#DBEAFE', color: r.billing_model === 'OUTRIGHT' ? '#92400E' : '#1D4ED8', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 800 }}>
                          {r.billing_model || 'SOR'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px', width: 130 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 100, height: 6, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#2563EB,#6366F1)', borderRadius: 100, transition: 'width 0.6s ease' }} />
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: T.muted, minWidth: 30, textAlign: 'right' }}>{pct}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(r.count)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: '#059669' }}>{fmtL(r.stock)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>{share}%</td>
                    </tr>
                  );
                })
            }
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No channel data</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, background: T.bg }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            <strong style={{ color: T.primary }}>{rows.length}</strong> channels · Total stock: <strong style={{ color: T.primary }}>{fmtL(totalStock)}</strong> units
          </span>
        </div>
      )}
    </div>
  );
}

// ── Network Charts — 3-chart section like sales page ─────────────────────
function NetworkChartsSection({ groups, locations, loading }) {
  // Chart 1: Stock by Channel — horizontal bar (full width)
  const channelStockChart = useMemo(() => {
    const rows = [...(groups || [])]
      .sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0))
      .slice(0, 10);
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'bar' },
        plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '62%' } },
        xaxis: {
          categories: rows.map(r => r.group_name || ''),
          labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '11px' }, formatter: v => fmtL(v) },
          axisBorder: { show: false }, axisTicks: { show: false },
        },
        yaxis: { labels: { style: { colors: T.primary, fontWeight: 800, fontSize: '12px' } } },
        colors: ['#2563EB'],
        fill: {
          type: 'gradient',
          gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#6366F1'], opacityFrom: 1, opacityTo: 0.85 },
        },
        dataLabels: {
          enabled: true,
          formatter: v => fmtL(v),
          style: { fontSize: '11px', fontWeight: 800, colors: ['#fff'] },
          dropShadow: { enabled: false },
        },
        grid: { borderColor: '#f1f5f9', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
        tooltip: { y: { formatter: v => fmtNum(v) + ' units' }, style: { fontSize: '12px', fontWeight: 700 } },
        legend: { show: false },
      },
      series: [{ name: 'Total Stock', data: rows.map(r => Number(r.stock || 0)) }],
    };
  }, [groups]);

  // Chart 2: Billing Model Donut — SOR vs OUTRIGHT
  const billingDonutChart = useMemo(() => {
    const sor      = (groups || []).filter(g => g.billing_model !== 'OUTRIGHT').reduce((s, g) => s + Number(g.stock || 0), 0);
    const outright = (groups || []).filter(g => g.billing_model === 'OUTRIGHT').reduce((s, g) => s + Number(g.stock || 0), 0);
    const sorCount      = (groups || []).filter(g => g.billing_model !== 'OUTRIGHT').reduce((s, g) => s + Number(g.count || 0), 0);
    const outrightCount = (groups || []).filter(g => g.billing_model === 'OUTRIGHT').reduce((s, g) => s + Number(g.count || 0), 0);
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'donut' },
        labels: [`SOR (${fmtNum(sorCount)} stores)`, `Outright (${fmtNum(outrightCount)} stores)`],
        colors: ['#2563EB', '#F59E0B'],
        plotOptions: {
          pie: {
            donut: {
              size: '68%',
              labels: {
                show: true,
                total: {
                  show: true,
                  label: 'Total Stock',
                  fontSize: '12px', fontWeight: 800, color: T.muted,
                  formatter: w => fmtL(w.globals.seriesTotals.reduce((a, b) => a + b, 0)),
                },
                value: { fontSize: '18px', fontWeight: 900, color: T.primary, formatter: v => fmtL(Number(v)) },
              },
            },
          },
        },
        dataLabels: { enabled: false },
        legend: { position: 'bottom', fontWeight: 700, fontSize: '12px', labels: { colors: T.primary } },
        tooltip: { y: { formatter: v => fmtNum(v) + ' units' }, style: { fontSize: '12px', fontWeight: 700 } },
        stroke: { width: 2, colors: ['#fff'] },
      },
      series: [sor, outright],
    };
  }, [groups]);

  // Chart 3: Top 10 Stores by Stock — vertical bar
  const topStoresChart = useMemo(() => {
    const rows = [...(locations || [])]
      .sort((a, b) => Number(b.total_stock || 0) - Number(a.total_stock || 0))
      .filter(r => Number(r.total_stock || 0) > 0)
      .slice(0, 10);
    return {
      options: {
        ...chartBase,
        chart: { ...chartBase, type: 'bar' },
        plotOptions: { bar: { borderRadius: 5, columnWidth: '60%' } },
        xaxis: {
          categories: rows.map(r => r.name?.length > 14 ? r.name.slice(0, 14) + '…' : (r.name || '')),
          labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '10px' }, rotate: -38 },
          axisBorder: { show: false }, axisTicks: { show: false },
        },
        yaxis: { labels: { style: { colors: T.primary, fontWeight: 700 }, formatter: v => fmtL(v) } },
        colors: ['#059669'],
        fill: {
          type: 'gradient',
          gradient: { shade: 'light', type: 'vertical', gradientToColors: ['#34D399'], opacityFrom: 1, opacityTo: 0.75 },
        },
        dataLabels: {
          enabled: true,
          formatter: v => fmtL(v),
          style: { fontSize: '10px', fontWeight: 800, colors: [T.primary] },
          offsetY: -6,
        },
        grid: { borderColor: '#f1f5f9', strokeDashArray: 4 },
        tooltip: {
          y: { formatter: (v, { dataPointIndex }) => `${rows[dataPointIndex]?.name || ''}: ${fmtNum(v)} units` },
          style: { fontSize: '12px', fontWeight: 700 },
        },
        legend: { show: false },
      },
      series: [{ name: 'Total Stock', data: rows.map(r => Number(r.total_stock || 0)) }],
    };
  }, [locations]);

  const chartCardStyle = {
    background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden',
  };
  const chartHeaderStyle = {
    padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8,
  };
  const chartTitleStyle = {
    fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase',
  };

  return (
    <>
      {/* Chart 1: Stock by Channel — full width horizontal bar */}
      <div style={{ marginBottom: 24 }}>
        <div style={chartCardStyle}>
          <div style={chartHeaderStyle}>
            <BarChart2 size={13} color={T.primary} strokeWidth={2.5} />
            <span style={chartTitleStyle}>Stock by Channel — Top 10 Groups</span>
          </div>
          <div style={{ padding: '16px 18px 8px' }}>
            {loading
              ? <div style={{ height: 280, background: T.bg, borderRadius: 8 }} />
              : <Chart options={channelStockChart.options} series={channelStockChart.series} type="bar" height={280} />
            }
          </div>
        </div>
      </div>

      {/* Charts Row: Billing model donut + Top stores bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 20, marginBottom: 24 }}>
        {/* Chart 2: Billing Split Donut */}
        <div style={chartCardStyle}>
          <div style={chartHeaderStyle}>
            <PieChart size={13} color={T.primary} strokeWidth={2.5} />
            <span style={chartTitleStyle}>Billing Model — SOR vs Outright</span>
          </div>
          <div style={{ padding: '16px 18px 8px', display: 'flex', justifyContent: 'center' }}>
            {loading
              ? <div style={{ height: 240, width: '100%', background: T.bg, borderRadius: 8 }} />
              : <Chart options={billingDonutChart.options} series={billingDonutChart.series} type="donut" height={240} width="100%" />
            }
          </div>
        </div>

        {/* Chart 3: Top 10 Stores */}
        <div style={chartCardStyle}>
          <div style={chartHeaderStyle}>
            <Activity size={13} color={T.primary} strokeWidth={2.5} />
            <span style={chartTitleStyle}>Top 10 Stores — By Stock (Current Filter)</span>
          </div>
          <div style={{ padding: '16px 18px 8px' }}>
            {loading
              ? <div style={{ height: 240, background: T.bg, borderRadius: 8 }} />
              : <Chart options={topStoresChart.options} series={topStoresChart.series} type="bar" height={240} />
            }
          </div>
        </div>
      </div>
    </>
  );
}

// ── Show dropdown values ──────────────────────────────────────────────────
const SHOW_OPTS = [5, 10, 15, 20, 25, 30, 50, 'All'];

// ── Stock Breakdown by Colour & Size — with independent Show + common filter ─
function StockBreakdownSection({ stateOptions }) {
  // Common filters for both charts
  const [filterState, setFilterState] = useState('');
  const [filterCity,  setFilterCity]  = useState('');
  const [cityOpts,    setCityOpts]    = useState([]);

  // Independent Show per chart
  const [showColor, setShowColor] = useState(10);
  const [showSize,  setShowSize]  = useState(10);

  // Data
  const [colorData, setColorData] = useState([]);
  const [sizeData,  setSizeData]  = useState([]);
  const [loading,   setLoading]   = useState(false);

  const fetchBreakdown = useCallback(async (state, city) => {
    setLoading(true);
    try {
      const params = {
        state: state || undefined,
        city:  city  || undefined,
      };
      const [colorRes, sizeRes, locRes] = await Promise.all([
        analyticsService.getColorDistribution(params),
        analyticsService.getSizeDistribution(params),
        locationService.list({ ...params, limit: 1 }), // just for city options
      ]);
      setColorData(colorRes.data.data || []);
      setSizeData(sizeRes.data.data   || []);
      setCityOpts(locRes.data.cities  || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchBreakdown(filterState, filterCity); }, [filterState, filterCity, fetchBreakdown]);

  // Sliced rows for each chart
  const colorRows = useMemo(() =>
    showColor === 'All' ? colorData : colorData.slice(0, Number(showColor)),
  [colorData, showColor]);

  const sizeRows = useMemo(() =>
    showSize === 'All' ? sizeData : sizeData.slice(0, Number(showSize)),
  [sizeData, showSize]);

  // Colour chart — horizontal bar
  const colorChart = useMemo(() => ({
    options: {
      ...chartBase,
      chart: { ...chartBase, type: 'bar' },
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '65%' } },
      xaxis: {
        categories: colorRows.map(r => r.color_name || ''),
        labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '11px' }, formatter: v => fmtL(v) },
        axisBorder: { show: false }, axisTicks: { show: false },
      },
      yaxis: { labels: { style: { colors: T.primary, fontWeight: 800, fontSize: '11px' }, maxWidth: 120 } },
      colors: ['#2563EB'],
      fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#6366F1'], opacityFrom: 1, opacityTo: 0.8 } },
      dataLabels: { enabled: true, formatter: v => fmtL(v), style: { fontSize: '10px', fontWeight: 800, colors: ['#fff'] }, dropShadow: { enabled: false } },
      grid: { borderColor: '#f1f5f9', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
      tooltip: { y: { formatter: (v, { dataPointIndex }) => `${colorRows[dataPointIndex]?.color_name || ''}: ${fmtNum(v)} units (${colorRows[dataPointIndex]?.pct_of_total || 0}%)` }, style: { fontSize: '12px', fontWeight: 700 } },
      legend: { show: false },
    },
    series: [{ name: 'Stock', data: colorRows.map(r => Number(r.total_stock || 0)) }],
  }), [colorRows]);

  // Size chart — horizontal bar
  const sizeChart = useMemo(() => ({
    options: {
      ...chartBase,
      chart: { ...chartBase, type: 'bar' },
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '65%' } },
      xaxis: {
        categories: sizeRows.map(r => r.size || ''),
        labels: { style: { colors: T.muted, fontWeight: 700, fontSize: '11px' }, formatter: v => fmtL(v) },
        axisBorder: { show: false }, axisTicks: { show: false },
      },
      yaxis: { labels: { style: { colors: T.primary, fontWeight: 800, fontSize: '11px' }, maxWidth: 80 } },
      colors: ['#059669'],
      fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#34D399'], opacityFrom: 1, opacityTo: 0.8 } },
      dataLabels: { enabled: true, formatter: v => fmtL(v), style: { fontSize: '10px', fontWeight: 800, colors: ['#fff'] }, dropShadow: { enabled: false } },
      grid: { borderColor: '#f1f5f9', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
      tooltip: { y: { formatter: (v, { dataPointIndex }) => `Size ${sizeRows[dataPointIndex]?.size || ''}: ${fmtNum(v)} units (${sizeRows[dataPointIndex]?.pct_of_total || 0}%)` }, style: { fontSize: '12px', fontWeight: 700 } },
      legend: { show: false },
    },
    series: [{ name: 'Stock', data: sizeRows.map(r => Number(r.total_stock || 0)) }],
  }), [sizeRows]);

  const cardStyle   = { background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden' };
  const hdrStyle    = { padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 };
  const ttlStyle    = { fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' };
  const skeletonH   = (showColor === 'All' ? colorData.length : Number(showColor)) * 28 + 40;

  // Dynamic height: 28px per bar + padding
  const colorH = Math.max(180, (showColor === 'All' ? colorData.length : Number(showColor)) * 32 + 40);
  const sizeH  = Math.max(180, (showSize  === 'All' ? sizeData.length  : Number(showSize))  * 32 + 40);

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Common filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <BarChart2 size={15} color={T.primary} strokeWidth={2.5} />
        <span style={{ fontSize: 13, fontWeight: 900, color: T.primary, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Colour &amp; Size Stock Distribution
        </span>
        <div style={{ flex: 1 }} />
        {/* State */}
        <div style={{ position: 'relative' }}>
          <select value={filterState}
            onChange={e => { setFilterState(e.target.value); setFilterCity(''); }}
            style={{ ...filterSelect, minWidth: 140 }}>
            <option value="">All States</option>
            {(stateOptions || []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronIcon />
        </div>
        {/* City */}
        <div style={{ position: 'relative' }}>
          <select value={filterCity} onChange={e => setFilterCity(e.target.value)}
            style={{ ...filterSelect, minWidth: 130 }}>
            <option value="">All Cities</option>
            {cityOpts.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <ChevronIcon />
        </div>
        {(filterState || filterCity) && (
          <button onClick={() => { setFilterState(''); setFilterCity(''); }}
            style={{ border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 800, color: T.primary, background: '#fff', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>

      {/* Two charts side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Colour chart */}
        <div style={cardStyle}>
          <div style={hdrStyle}>
            <PieChart size={13} color='#2563EB' strokeWidth={2.5} />
            <span style={ttlStyle}>Stock by Colour</span>
            {!loading && colorData.length > 0 &&
              <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#2563EB', borderRadius: 100, padding: '2px 7px' }}>{colorData.length}</span>
            }
            <div style={{ flex: 1 }} />
            {/* Show dropdown */}
            <div style={{ position: 'relative' }}>
              <select value={showColor} onChange={e => setShowColor(e.target.value === 'All' ? 'All' : Number(e.target.value))}
                style={{ ...filterSelect, minWidth: 90, paddingLeft: 8, fontSize: 11 }}>
                {SHOW_OPTS.map(o => <option key={o} value={o}>Show {o}</option>)}
              </select>
              <ChevronIcon />
            </div>
          </div>
          <div style={{ padding: '12px 16px 8px' }}>
            {loading
              ? <div style={{ height: Math.max(180, skeletonH), background: T.bg, borderRadius: 8 }} />
              : colorRows.length === 0
                ? <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No colour data</div>
                : <Chart options={colorChart.options} series={colorChart.series} type="bar" height={colorH} />
            }
          </div>
        </div>

        {/* Size chart */}
        <div style={cardStyle}>
          <div style={hdrStyle}>
            <Activity size={13} color='#059669' strokeWidth={2.5} />
            <span style={ttlStyle}>Stock by Size</span>
            {!loading && sizeData.length > 0 &&
              <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#059669', borderRadius: 100, padding: '2px 7px' }}>{sizeData.length}</span>
            }
            <div style={{ flex: 1 }} />
            {/* Show dropdown */}
            <div style={{ position: 'relative' }}>
              <select value={showSize} onChange={e => setShowSize(e.target.value === 'All' ? 'All' : Number(e.target.value))}
                style={{ ...filterSelect, minWidth: 90, paddingLeft: 8, fontSize: 11 }}>
                {SHOW_OPTS.map(o => <option key={o} value={o}>Show {o}</option>)}
              </select>
              <ChevronIcon />
            </div>
          </div>
          <div style={{ padding: '12px 16px 8px' }}>
            {loading
              ? <div style={{ height: Math.max(180, skeletonH), background: T.bg, borderRadius: 8 }} />
              : sizeRows.length === 0
                ? <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No size data</div>
                : <Chart options={sizeChart.options} series={sizeChart.series} type="bar" height={sizeH} />
            }
          </div>
        </div>

      </div>
    </div>
  );
}

// ── All Locations Table — server-side pagination ───────────────────────────
const PAGE_SIZE_LOCS = 25;

function AllLocationsTable({
  locations, pagination, groups,
  stateOptions, cityOptions,
  loading,
  onFilterChange,
}) {
  const [search,  setSearch]  = useState('');
  const [state,   setState]   = useState('');
  const [city,    setCity]    = useState('');
  const [channel, setChannel] = useState('');
  const [sortBy,  setSortBy]  = useState('total_stock');
  const [page,    setPage]    = useState(1);

  const availableChannels = useMemo(() =>
    (groups || []).map(g => g.group_name).filter(Boolean).sort(),
  [groups]);

  // Notify parent to re-fetch whenever filters / page / sort change
  useEffect(() => {
    onFilterChange({ search, state, city, group_name: channel, page, sort_by: sortBy });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, state, city, channel, page, sortBy]);

  const totalRecords = Number(pagination?.total || 0);
  const totalPages   = Number(pagination?.totalPages || 1);
  const safePage     = Math.min(page, totalPages);

  const hasFilter = search || state || city || channel;

  const clearAll = () => {
    setSearch(''); setState(''); setCity(''); setChannel(''); setPage(1);
  };

  const globalOffset = (safePage - 1) * PAGE_SIZE_LOCS;

  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>

      {/* Filter bar */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Globe size={13} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>All Locations</span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: T.primary, borderRadius: 100, padding: '2px 7px' }}>
              {fmtNum(totalRecords)}
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <input type="text" value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search name, code, city…"
            style={{ ...filterInput, width: 200 }} />
          <SearchIcon />
          {search && <button onClick={() => { setSearch(''); setPage(1); }} style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontWeight: 900, fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>}
        </div>

        {/* State */}
        <div style={{ position: 'relative' }}>
          <select value={state} onChange={e => { setState(e.target.value); setCity(''); setPage(1); }} style={{ ...filterSelect, minWidth: 140 }}>
            <option value="">All States</option>
            {(stateOptions || []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronIcon />
        </div>

        {/* City */}
        <div style={{ position: 'relative' }}>
          <select value={city} onChange={e => { setCity(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 130 }}>
            <option value="">All Cities</option>
            {(cityOptions || []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <ChevronIcon />
        </div>

        {/* Channel — uses actual group_names from API */}
        <div style={{ position: 'relative' }}>
          <select value={channel} onChange={e => { setChannel(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 160 }}>
            <option value="">All Channels</option>
            {availableChannels.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <ChevronIcon />
        </div>

        {/* Sort */}
        <div style={{ position: 'relative' }}>
          <select value={sortBy} onChange={e => { setSortBy(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 150 }}>
            <option value="total_stock">Sort: Total Stock</option>
            <option value="name">Sort: Name A–Z</option>
          </select>
          <ChevronIcon />
        </div>

        {hasFilter && (
          <button onClick={clearAll} style={{ border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 800, color: T.primary, background: '#fff', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: T.bg }}>
              {['#','Location Name','Channel / Group','Billing','State','City','Total Stock'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: ['Total Stock','#'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `2px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} style={{ padding: '10px 14px' }}><div style={{ height: 14, background: T.bg, borderRadius: 4 }} /></td></tr>
                ))
              : locations.map((r, i) => {
                  const globalIdx = globalOffset + i;
                  const isTop3    = globalIdx < 3 && !hasFilter && sortBy === 'total_stock';
                  return (
                    <tr key={r.id || i}
                      style={{ borderBottom: `1px solid ${T.border}`, background: isTop3 ? '#fafaf7' : i % 2 === 0 ? '#fff' : '#fafafa' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f1f5f9'}
                      onMouseLeave={e => e.currentTarget.style.background = isTop3 ? '#fafaf7' : i % 2 === 0 ? '#fff' : '#fafafa'}
                    >
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 900, color: T.muted, width: 40 }}>
                        {isTop3 ? ['🥇','🥈','🥉'][globalIdx] : globalIdx + 1}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 800, color: T.primary, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.group_name || r.type || '—'}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <span style={{ background: r.billing_model === 'OUTRIGHT' ? '#FEF3C7' : '#DBEAFE', color: r.billing_model === 'OUTRIGHT' ? '#92400E' : '#1D4ED8', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 800 }}>
                          {r.billing_model || 'SOR'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.state || '—'}</td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.city || '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 900, color: T.primary, whiteSpace: 'nowrap' }}>{fmtNum(r.total_stock)}</td>
                    </tr>
                  );
                })
            }
            {!loading && locations.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '40px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: T.muted }}>No locations match your filters</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {!loading && totalRecords > 0 && (
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.bg, flexWrap: 'wrap', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{globalOffset + 1}–{Math.min(globalOffset + locations.length, totalRecords)}</strong> of <strong style={{ color: T.primary }}>{fmtNum(totalRecords)}</strong> locations
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setPage(1)} disabled={safePage === 1}
              style={{ border: `1.5px solid ${T.border}`, borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: '#fff', cursor: safePage === 1 ? 'default' : 'pointer' }}>«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
              style={{ border: `1.5px solid ${T.border}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: '#fff', cursor: safePage === 1 ? 'default' : 'pointer' }}>‹ Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
              .reduce((acc, p, idx, arr) => { if (idx > 0 && p - arr[idx-1] > 1) acc.push('…'); acc.push(p); return acc; }, [])
              .map((p, idx) => p === '…'
                ? <span key={`e${idx}`} style={{ fontSize: 12, color: T.muted, padding: '0 2px' }}>…</span>
                : <button key={p} onClick={() => setPage(p)}
                    style={{ border: `1.5px solid ${p === safePage ? T.primary : T.border}`, borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: p === safePage ? 900 : 700, color: p === safePage ? '#fff' : T.primary, background: p === safePage ? T.primary : '#fff', cursor: 'pointer', minWidth: 30 }}>{p}</button>
              )}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
              style={{ border: `1.5px solid ${T.border}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 800, color: safePage === totalPages ? T.border : T.primary, background: '#fff', cursor: safePage === totalPages ? 'default' : 'pointer' }}>Next ›</button>
            <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
              style={{ border: `1.5px solid ${T.border}`, borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 800, color: safePage === totalPages ? T.border : T.primary, background: '#fff', cursor: safePage === totalPages ? 'default' : 'pointer' }}>»</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function NetworkPage() {
  // ── Table state (affected by filters) ─────────────────────────────────────
  const [locations,   setLocations]   = useState([]);
  const [pagination,  setPagination]  = useState(null);
  const [cityOptions, setCityOptions] = useState([]);
  const [tableLoading,setTableLoading]= useState(true);

  // ── Summary state (always unfiltered — KPIs + Channel Breakdown) ──────────
  const [groupSummary,   setGroupSummary]   = useState([]);
  const [networkSummary, setNetworkSummary] = useState(null);
  const [stateOptions,   setStateOptions]   = useState([]);
  const [summaryLoading, setSummaryLoading] = useState(true);

  // Server-side filters — driven by AllLocationsTable
  const [tableFilters, setTableFilters] = useState({ sort_by: 'total_stock', page: 1 });

  // Fetch KPIs + Channel Breakdown — NO filters, always full network
  const fetchSummaryData = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await locationService.list({ page: 1, limit: PAGE_SIZE_LOCS, sort_by: 'total_stock' });
      setGroupSummary(res.data.groups    || []);
      setNetworkSummary(res.data.summary || null);
      setStateOptions(res.data.states    || []);
    } catch (err) {
      toast.error('Failed to load network summary');
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  // Fetch table rows only — passes all active filters, updates ONLY table state
  const fetchTableData = useCallback(async (filters = {}) => {
    setTableLoading(true);
    try {
      const params = {
        page:       filters.page       || 1,
        limit:      PAGE_SIZE_LOCS,
        group_name: filters.group_name || undefined,
        state:      filters.state      || undefined,
        city:       filters.city       || undefined,
        search:     filters.search     || undefined,
        sort_by:    filters.sort_by    || 'total_stock',
      };
      const res = await locationService.list(params);
      setLocations(res.data.data      || []);
      setPagination(res.data.pagination || null);
      setCityOptions(res.data.cities  || []);
    } catch (err) {
      toast.error('Failed to load locations');
    } finally {
      setTableLoading(false);
    }
  }, []);

  // Initial load — both in parallel
  useEffect(() => {
    fetchSummaryData();
    fetchTableData({ sort_by: 'total_stock' });
  }, [fetchSummaryData, fetchTableData]);

  // Table filter changes → only re-fetch table, never touch summary
  const handleFilterChange = useCallback((filters) => {
    setTableFilters(filters);
    fetchTableData(filters);
  }, [fetchTableData]);

  // Summary KPIs — always from unfiltered summary data
  const totalLocations = Number(networkSummary?.total_locations || 0);
  const totalStock     = Number(networkSummary?.total_stock     || 0);
  const totalGroups    = groupSummary.length;
  const totalStates    = stateOptions.length;

  // Top group by stock
  const topGroup = useMemo(() => {
    if (!groupSummary.length) return null;
    return [...groupSummary].sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0))[0];
  }, [groupSummary]);

  return (
    <DashboardLayout title="Network" subtitle="Retail network — inventory positions across all locations and channels">

      {/* ── KPI Cards — always unfiltered ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 28 }}>
        <KpiCard icon={Globe}      label="Total Locations" value={fmtNum(totalLocations)} sub={`${totalStates} states covered`}                                                       accent="#0f172a" loading={summaryLoading} />
        <KpiCard icon={Package}    label="Network Stock"   value={fmtL(totalStock)}        sub="total units on hand"                                                                   accent="#2563EB" loading={summaryLoading} />
        <KpiCard icon={Layers}     label="Channels"        value={fmtNum(totalGroups)}      sub="distinct channel groups"                                                              accent="#7C3AED" loading={summaryLoading} />
        <KpiCard icon={MapPin}     label="States"          value={fmtNum(totalStates)}      sub="geographic coverage"                                                                  accent="#059669" loading={summaryLoading} />
        <KpiCard icon={TrendingUp} label="Top Channel"     value={topGroup?.group_name || '—'} sub={topGroup ? `${fmtL(topGroup.stock)} units · ${fmtNum(topGroup.count)} stores` : 'loading…'} accent="#D97706" loading={summaryLoading} />
      </div>

      {/* ── Refresh — refreshes both summary and table ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
        <button onClick={() => { fetchSummaryData(); fetchTableData(tableFilters); }} disabled={summaryLoading || tableLoading}
          style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 800, color: T.primary, background: '#fff', cursor: (summaryLoading || tableLoading) ? 'default' : 'pointer', opacity: (summaryLoading || tableLoading) ? 0.6 : 1 }}>
          <RefreshCw size={13} style={{ animation: (summaryLoading || tableLoading) ? 'spin 1s linear infinite' : 'none' }} strokeWidth={2.5} />
          Refresh
        </button>
      </div>

      {/* ── Channel Breakdown — always unfiltered ── */}
      <div style={{ marginBottom: 24 }}>
        <SectionTitle icon={PieChart} label="Channel Breakdown — All Groups" />
        <ChannelBreakdownSection groups={groupSummary} loading={summaryLoading} />
      </div>

      {/* ── Network Charts ── */}
      <div style={{ marginBottom: 8 }}>
        <SectionTitle icon={BarChart2} label="Network Analytics — Stock Distribution" />
      </div>
      <NetworkChartsSection groups={groupSummary} locations={locations} loading={summaryLoading} />

      {/* ── Colour & Size Stock Distribution ── */}
      <StockBreakdownSection stateOptions={stateOptions} />

      {/* ── All Locations Table ── */}
      <SectionTitle icon={Globe} label="All Locations — Full Network" />
      <AllLocationsTable
        locations={locations}
        pagination={pagination}
        groups={groupSummary}
        stateOptions={stateOptions}
        cityOptions={cityOptions}
        loading={tableLoading}
        onFilterChange={handleFilterChange}
      />

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </DashboardLayout>
  );
}
