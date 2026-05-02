import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import { FiltersProvider } from '../lib/FiltersContext';
import ModePill from '../components/filters/ModePill';
import FilterChips from '../components/filters/FilterChips';
import PremiumKpi from '../components/ui/PremiumKpi';
import NetworkPulse from '../components/network/NetworkPulse';
import { useFilters } from '../lib/useFilters';
import { locationService, analyticsService } from '../lib/services';
import { getCached, setCached, isFresh } from '../lib/dashboardCache';
import toast from 'react-hot-toast';
import { notifyApiError } from '../lib/notifyApiError';
import {
  Globe, Package, MapPin, PieChart, BarChart2, IndianRupee,
  RefreshCw, TrendingUp, Layers, Activity, Skull, AlertTriangle, Zap, Target,
  Building2, Calendar, Sparkles,
} from 'lucide-react';

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

// ── Typography — identical to sales page ───────────────────────────────────
// ── Typography constants — refined to consume design-system tokens ─────────
// Mirrors pages/sales.js so both pages share the same visual language.
// Theme tokens — read from CSS variables so /network follows the portal
// light/dark toggle automatically.  Hex fallbacks are the dark defaults.
const T = {
  primary:   'var(--text-primary,   #F1F5F9)',
  secondary: 'var(--text-secondary, #CBD5E1)',
  muted:     'var(--text-muted,     #64748B)',
  border:    'var(--border-subtle,  rgba(255,255,255,0.07))',
  bg:        'var(--bg-canvas,      #070C18)',
  accent:    'var(--accent-primary, #EF4444)',
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

// ── Shared filter styles — refined hairline + tabular figures ────────────
const filterInput  = { border: '1px solid var(--border-default)', borderRadius: 9, padding: '7px 12px 7px 32px', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', outline: 'none', background: 'var(--bg-elevated)', height: 32, fontFamily: 'var(--font-body)', transition: 'border-color 200ms ease' };
const filterSelect = { border: '1px solid var(--border-default)', borderRadius: 9, padding: '7px 30px 7px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', outline: 'none', background: 'var(--bg-elevated)', appearance: 'none', cursor: 'pointer', height: 32, fontFamily: 'var(--font-body)', transition: 'border-color 200ms ease' };
const SearchIcon   = () => <svg style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', opacity: 0.40 }} width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.2}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const ChevronIcon  = () => <svg style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.45 }} width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.4}><polyline points="6 9 12 15 18 9"/></svg>;

// ── KPI Card — premium hero (mirrors SalesPulse KpiHero) ─────────────────
function KpiCard({ icon: Icon, label, value, sub, sub2, accent = '#0B1220', loading }) {
  // Hover tooltip — reveal the raw number below the abbreviated K/L/Cr value.
  const rawTooltip = typeof value === 'string' ? value : (value != null ? String(value) : '');
  return (
    <div className="sx-card" style={{
      padding: '20px 22px 18px',
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Whisper-thin accent rail at the top edge */}
      <div style={{ position: 'absolute', top: 0, left: 14, right: 14, height: 2,
        background: `linear-gradient(90deg, ${accent}, ${accent}cc)`,
        borderRadius: '2px', opacity: 0.85 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, marginTop: 4 }}>
        <div style={{ width: 30, height: 30, borderRadius: 9,
          background: `${accent}10`, color: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon size={15} strokeWidth={2} />
        </div>
        <span style={{
          fontFamily: 'var(--font-body)',
          fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: T.muted,
        }}>{label}</span>
      </div>
      {loading
        ? <div className="sx-shimmer" style={{ height: 36, width: '70%', marginBottom: 10, borderRadius: 6 }} />
        : <div className="sx-hero-num" title={rawTooltip}
            style={{ marginBottom: 8, fontSize: 32, cursor: 'help' }}>{value}</div>
      }
      {sub  && <div style={{ fontSize: 11.5, fontWeight: 500, color: T.muted, letterSpacing: '0.005em', lineHeight: 1.45 }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 11, fontWeight: 500, color: T.muted, marginTop: 2, letterSpacing: '0.005em' }}>{sub2}</div>}
    </div>
  );
}

// ── Section Title — premium icon chip + Plus Jakarta title ───────────────
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
      }}>{label}</span>
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
    <div className="sx-card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <PieChart size={13} color={T.primary} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 800, color: T.primary, letterSpacing: '0.10em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Channel Breakdown</span>
          {!loading && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#EF4444', borderRadius: 100, padding: '2px 7px' }}>{rows.length}</span>}
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>Sorted by highest stock</span>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: 420 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              {['#','Channel / Group','Billing','Distribution','Locations','Total Stock','Share %'].map(h => (
                <th key={h} style={{ padding: '9px 14px', textAlign: ['Locations','Total Stock','Share %'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} style={{ padding: '9px 14px' }}><div className="sx-shimmer" style={{ height: 13, borderRadius: 4 }} /></td></tr>
                ))
              : rows.map((r, i) => {
                  // Bar reads as share-of-total (so the top channel might be
                  // 73% if it dominates) — NOT share-of-max which always
                  // pinned the leader at 100%. Same number as Share % column.
                  const shareNum = totalStock > 0 ? (Number(r.stock || 0) / totalStock) * 100 : 0;
                  const pct      = Math.min(100, Math.round(shareNum * 10) / 10);
                  const share    = shareNum.toFixed(1);
                  return (
                    <tr key={i}
                      style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--row-stripe)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--row-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--row-stripe)'}
                    >
                      <td style={{ padding: '9px 14px', fontSize: 11, fontWeight: 700, color: T.muted, width: 36 }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 800, color: T.primary }}>{r.group_name || '—'}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ background: r.billing_model === 'OUTRIGHT' ? '#FEF3C7' : '#DBEAFE', color: r.billing_model === 'OUTRIGHT' ? '#92400E' : '#1D4ED8', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 800 }}>
                          {r.billing_model || 'SOR'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px', width: 130 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}
                          title={`${pct}% of total stock`}>
                          <div style={{ flex: 1, background: 'var(--border-default)', borderRadius: 100, height: 6, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(1, pct)}%`, height: '100%', background: 'linear-gradient(90deg,#2563EB,#6366F1)', borderRadius: 100, transition: 'width 0.6s ease' }} />
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: T.muted, minWidth: 38, textAlign: 'right' }}>{pct < 0.1 ? '<0.1%' : `${pct}%`}</span>
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
        <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, background: 'var(--bg-card-hover)' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            <strong style={{ color: T.primary }}>{rows.length}</strong> channels · Total stock: <strong style={{ color: T.primary }}>{fmtL(totalStock)}</strong> units
          </span>
        </div>
      )}
    </div>
  );
}

// ── Network Charts — 3-chart section like sales page ─────────────────────
function NetworkChartsSection({ groups, filteredGroups, locations, loading }) {
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
        grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
        tooltip: { y: { formatter: v => fmtNum(v) + ' units' }, style: { fontSize: '12px', fontWeight: 700 } },
        legend: { show: false },
      },
      series: [{ name: 'Total Stock', data: rows.map(r => Number(r.stock || 0)) }],
    };
  }, [groups]);

  // Chart 2: Billing Model Donut — uses filteredGroups so it reflects table filters
  const billingDonutChart = useMemo(() => {
    const src = filteredGroups?.length ? filteredGroups : (groups || []);
    const sor           = src.filter(g => g.billing_model !== 'OUTRIGHT').reduce((s, g) => s + Number(g.stock || 0), 0);
    const outright      = src.filter(g => g.billing_model === 'OUTRIGHT').reduce((s, g) => s + Number(g.stock || 0), 0);
    const sorCount      = src.filter(g => g.billing_model !== 'OUTRIGHT').reduce((s, g) => s + Number(g.count || 0), 0);
    const outrightCount = src.filter(g => g.billing_model === 'OUTRIGHT').reduce((s, g) => s + Number(g.count || 0), 0);
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
        stroke: { width: 2, colors: ['#111827'] },
      },
      series: [sor, outright],
    };
  }, [filteredGroups, groups]);

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
        grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4 },
        tooltip: {
          y: { formatter: (v, { dataPointIndex }) => `${rows[dataPointIndex]?.name || ''}: ${fmtNum(v)} units` },
          style: { fontSize: '12px', fontWeight: 700 },
        },
        legend: { show: false },
      },
      series: [{ name: 'Total Stock', data: rows.map(r => Number(r.total_stock || 0)) }],
    };
  }, [locations]);

  // Chart card surface — uses .sx-card for consistent shadow + hover lift.
  // Inline overflow:hidden on the wrapper because charts have their own
  // toolbar/tooltip absolute positioning that we don't want clipped.
  const chartCardStyle = { overflow: 'hidden' };
  const chartCardClass = 'sx-card';
  const chartHeaderStyle = {
    padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10,
  };
  const chartTitleStyle = {
    fontFamily: 'var(--font-display)',
    fontSize: 13, fontWeight: 800, color: T.primary,
    letterSpacing: '-0.005em',
  };

  return (
    <>
      {/* Chart 1: Stock by Channel — full width horizontal bar */}
      <div style={{ marginBottom: 24 }}>
        <div className={chartCardClass} style={chartCardStyle}>
          <div style={chartHeaderStyle}>
            <BarChart2 size={13} color={T.primary} strokeWidth={2.2} />
            <span style={chartTitleStyle}>Stock by Channel</span>
          </div>
          <div style={{ padding: '16px 18px 8px' }}>
            {loading
              ? <div className="sx-shimmer" style={{ height: 280, borderRadius: 12 }} />
              : <Chart options={channelStockChart.options} series={channelStockChart.series} type="bar" height={280} />
            }
          </div>
        </div>
      </div>

      {/* Charts Row: Billing model donut + Top stores bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 20, marginBottom: 24 }}>
        {/* Chart 2: Billing Split Donut */}
        <div className={chartCardClass} style={chartCardStyle}>
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
        <div className={chartCardClass} style={chartCardStyle}>
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
// Now also respects the v2 universal filter bar via the `v2Filters` prop —
// every dropdown pick re-fetches both charts so the entire page narrows to
// one consistent slice of the data.
function StockBreakdownSection({ stateOptions, v2Filters = {} }) {
  // Common filters for both charts (local — kept for backward compat with the
  // section's own state/city/category dropdowns)
  const [filterState,    setFilterState]    = useState('');
  const [filterCity,     setFilterCity]     = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [cityOpts,       setCityOpts]       = useState([]);

  // Independent Show per chart
  const [showColor, setShowColor] = useState(10);
  const [showSize,  setShowSize]  = useState(10);

  // Data
  const [colorData, setColorData] = useState([]);
  const [sizeData,  setSizeData]  = useState([]);
  const [loading,   setLoading]   = useState(false);

  // Build v2 query params from the universal filter bar — these are AND-ed
  // with the section's own dropdowns so picking "Mens" globally + "Pune"
  // locally narrows to Mens × Pune, exactly as the user expects.
  const csv = (v) => Array.isArray(v) ? v.join(',') : (v || '');
  const v2Params = useMemo(() => ({
    gender:      csv(v2Filters.gender_name) || undefined,
    sub_product: csv(v2Filters.sub_product) || undefined,
    product:     csv(v2Filters.product)     || undefined,
    style:       csv(v2Filters.style)       || undefined,
    shade:       csv(v2Filters.shade)       || undefined,
    color:       csv(v2Filters.color)       || undefined,
    size:        csv(v2Filters.size)        || undefined,
    season:      csv(v2Filters.season)      || undefined,
    group_name:  csv(v2Filters.group_name)  || undefined,
    store_code:  csv(v2Filters.store_code)  || undefined,
    mode:        v2Filters.mode             || 'active',
  }), [JSON.stringify(v2Filters)]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBreakdown = useCallback(async (state, city, category, v2) => {
    setLoading(true);
    try {
      const params = {
        state:    state    || csv(v2Filters.state) || undefined,
        city:     city     || csv(v2Filters.city)  || undefined,
        category: category || csv(v2Filters.category) || undefined,
        ...v2,
      };
      // locationService.list doesn't understand category — strip it for city opts
      const locParams = { state: params.state, city: params.city, limit: 1 };
      const [colorRes, sizeRes, locRes] = await Promise.all([
        analyticsService.getColorDistribution(params),
        analyticsService.getSizeDistribution(params),
        locationService.list(locParams), // just for city options
      ]);
      setColorData(colorRes.data.data || []);
      setSizeData(sizeRes.data.data   || []);
      setCityOpts(locRes.data.cities  || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(v2Filters)]);

  useEffect(() => { fetchBreakdown(filterState, filterCity, filterCategory, v2Params); }, [filterState, filterCity, filterCategory, v2Params, fetchBreakdown]);

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
      colors: ['#7C3AED'],
      fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#C4B5FD'], opacityFrom: 1, opacityTo: 0.85 } },
      dataLabels: { enabled: true, formatter: v => fmtL(v), style: { fontSize: '10px', fontWeight: 800, colors: ['#fff'] }, dropShadow: { enabled: false } },
      grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
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
      colors: ['#DC2626'],
      fill: { type: 'gradient', gradient: { shade: 'light', type: 'horizontal', gradientToColors: ['#F87171'], opacityFrom: 1, opacityTo: 0.8 } },
      dataLabels: { enabled: true, formatter: v => fmtL(v), style: { fontSize: '10px', fontWeight: 800, colors: ['#fff'] }, dropShadow: { enabled: false } },
      grid: { borderColor: 'var(--chart-grid)', strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
      tooltip: { y: { formatter: (v, { dataPointIndex }) => `Size ${sizeRows[dataPointIndex]?.size || ''}: ${fmtNum(v)} units (${sizeRows[dataPointIndex]?.pct_of_total || 0}%)` }, style: { fontSize: '12px', fontWeight: 700 } },
      legend: { show: false },
    },
    series: [{ name: 'Stock', data: sizeRows.map(r => Number(r.total_stock || 0)) }],
  }), [sizeRows]);

  const cardStyle   = { overflow: 'hidden' };
  const cardClass   = 'sx-card';
  const hdrStyle    = { padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 };
  const ttlStyle    = { fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 800, color: T.primary, letterSpacing: '-0.005em' };
  const skeletonH   = (showColor === 'All' ? colorData.length : Number(showColor)) * 28 + 40;

  // Dynamic height: 28px per bar + padding
  const colorH = Math.max(180, (showColor === 'All' ? colorData.length : Number(showColor)) * 32 + 40);
  const sizeH  = Math.max(180, (showSize  === 'All' ? sizeData.length  : Number(showSize))  * 32 + 40);

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Common filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{
          width: 26, height: 26, borderRadius: 8,
          background: 'rgba(15,23,42,0.04)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <BarChart2 size={13} color={T.primary} strokeWidth={2.2} />
        </span>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontSize: 13, fontWeight: 800, color: T.primary,
          letterSpacing: '-0.005em',
        }}>
          Colour &amp; Size Stock Distribution
        </span>
        <div style={{ flex: 1 }} />
        {/* Local State / City / Category dropdowns removed — the v2 FilterBar
            at the top of the page is the single source of truth for those
            dimensions. State/city/category narrow this section automatically
            via the `v2Filters` prop above. */}
      </div>

      {/* Two charts side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Colour chart */}
        <div className={cardClass} style={cardStyle}>
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
        <div className={cardClass} style={cardStyle}>
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
  paretoPick = null,           // { tier: 50|80|90, n: <count> } | null
  onClearParetoPick = null,
}) {
  // State/City/Channel are owned by the v2 FilterBar at the top of the
  // page — no local UI for them here. They still exist as empty-string
  // local state so the existing onFilterChange contract stays intact;
  // the parent's handleFilterChange merges in the live v2 values.
  const [search,   setSearch]   = useState('');
  const [state]                 = useState('');
  const [city]                  = useState('');
  const [channel]               = useState('');
  const [category, setCategory] = useState('');
  const [sortBy,   setSortBy]   = useState('total_stock');
  const [page,     setPage]     = useState(1);
  // Suppress lint for unused-but-needed-by-payload setters.
  void stateOptions; void cityOptions; void groups;

  // availableChannels was used by the local Channel dropdown which is
  // now retired in favour of the v2 FilterBar's Party multi-select.

  // Notify parent to re-fetch whenever filters / page / sort change
  useEffect(() => {
    onFilterChange({ search, state, city, group_name: channel, category, page, sort_by: sortBy });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, state, city, channel, category, page, sortBy]);

  // ── Pareto highlight robustness ────────────────────────────────────────
  // The highlight only makes sense when the table is sorted by total_stock
  // DESC (which IS the default) AND no extra filter has narrowed the
  // dataset. If the user changes any of those, auto-clear so the rail
  // never points at the wrong rows. Pure client-side; no fetch.
  const hasFilter = !!(search || state || city || channel || category);
  const sortIsStockDesc = sortBy === 'total_stock';
  useEffect(() => {
    if (paretoPick && (!sortIsStockDesc || hasFilter)) onClearParetoPick?.();
  }, [paretoPick, sortIsStockDesc, hasFilter, onClearParetoPick]);

  // Snap to page 1 when a Pareto highlight is requested — top N rows live
  // on the first pages of a stock-DESC sort.
  useEffect(() => { if (paretoPick) setPage(1); }, [paretoPick]);

  const totalRecords = Number(pagination?.total || 0);
  const totalPages   = Number(pagination?.totalPages || 1);
  const safePage     = Math.min(page, totalPages);

  // (`hasFilter` is declared above next to the Pareto-clear effect.)

  const clearAll = () => {
    setSearch(''); setState(''); setCity(''); setChannel(''); setCategory(''); setPage(1);
  };

  const globalOffset = (safePage - 1) * PAGE_SIZE_LOCS;

  return (
    <div className="sx-card" style={{ overflow: 'hidden', marginBottom: 24 }}>

      {/* Filter bar */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Globe size={13} color={T.primary} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 800, color: T.primary, letterSpacing: '0.10em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>All Locations</span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#EF4444', borderRadius: 100, padding: '2px 7px' }}>
              {fmtNum(totalRecords)}
            </span>
          )}
          {/* Pareto highlight chip — visible only when a tier was clicked.
              Crimson fill so it reads as an active concentration callout;
              click × to clear. */}
          {paretoPick && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 4px 3px 10px',
              background: 'rgba(192,57,43,0.07)',
              border: '1px solid rgba(192,57,43,0.20)',
              color: '#C0392B',
              borderRadius: 999,
              fontSize: 10.5, fontWeight: 800, letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#C0392B' }} />
              Concentration · top {paretoPick.n} · {paretoPick.tier}% of stock
              <button onClick={() => onClearParetoPick?.()}
                title="Clear concentration filter"
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: '#C0392B', fontWeight: 900, fontSize: 13,
                  padding: '0 6px', lineHeight: 1,
                }}>×</button>
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

        {/* Local State / City / Channel dropdowns removed — the v2 FilterBar
            at the top of the page owns those dimensions. The current
            selection narrows this table automatically via the parent's
            handleFilterChange merge. */}

        {/* Legacy Category dropdown removed — covered by v2 FilterBar. */}

        {/* Sort */}
        <div style={{ position: 'relative' }}>
          <select value={sortBy} onChange={e => { setSortBy(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 150 }}>
            <option value="total_stock">Sort: Total Stock</option>
            <option value="total_value">Sort: Total Value</option>
            <option value="name">Sort: Name A–Z</option>
          </select>
          <ChevronIcon />
        </div>

        {hasFilter && (
          <button onClick={clearAll} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 800, color: T.primary, background: 'transparent', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              {['#','Location Name','Channel / Group','Billing','State','City','Total Stock','Total Value'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: ['Total Stock','Total Value','#'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i}><td colSpan={8} style={{ padding: '10px 14px' }}><div style={{ height: 14, background: T.bg, borderRadius: 4 }} /></td></tr>
                ))
              : locations.map((r, i) => {
                  const globalIdx = globalOffset + i;
                  const isTop3    = globalIdx < 3 && !hasFilter && sortBy === 'total_stock';
                  // True if this row is one of the "top N stores" the user
                  // selected from the Pareto Reveal. Highlight is applied
                  // ONLY when sort is total_stock DESC + no extra filter
                  // (the parent auto-clears paretoPick otherwise so this
                  // condition is mostly defensive).
                  const inPareto  = !!paretoPick && globalIdx < paretoPick.n && sortIsStockDesc && !hasFilter;
                  const baseBg    = inPareto
                    ? 'linear-gradient(90deg, rgba(192,57,43,0.06), rgba(192,57,43,0.02) 60%)'
                    : isTop3 ? 'rgba(239,68,68,0.06)' : i % 2 === 0 ? 'transparent' : 'var(--row-stripe)';
                  return (
                    <tr key={r.id || i}
                      style={{
                        borderBottom: `1px solid ${T.border}`,
                        background: baseBg,
                        // 3px crimson accent rail on the inside of the row's
                        // left edge — the visual signal that this row belongs
                        // to the selected Pareto tier. Uses inset box-shadow
                        // so it doesn't shift any cell padding.
                        boxShadow: inPareto ? 'inset 3px 0 0 0 #C0392B' : 'none',
                        transition: 'background 200ms ease',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--row-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = baseBg}
                    >
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 900, color: inPareto ? '#C0392B' : T.muted, width: 40 }}>
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
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 900, color: '#059669', whiteSpace: 'nowrap' }}>₹{fmtL(r.total_value)}</td>
                    </tr>
                  );
                })
            }
            {!loading && locations.length === 0 && (
              <tr><td colSpan={8} style={{ padding: '40px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: T.muted }}>No locations match your filters</td></tr>
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
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: 'transparent', cursor: safePage === 1 ? 'default' : 'pointer' }}>«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 11px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: 'transparent', cursor: safePage === 1 ? 'default' : 'pointer' }}>‹ Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
              .reduce((acc, p, idx, arr) => { if (idx > 0 && p - arr[idx-1] > 1) acc.push('…'); acc.push(p); return acc; }, [])
              .map((p, idx) => p === '…'
                ? <span key={`e${idx}`} style={{ fontSize: 12, color: T.muted, padding: '0 2px' }}>…</span>
                : <button key={p} onClick={() => setPage(p)}
                    style={{ border: `1.5px solid ${p === safePage ? T.primary : T.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: p === safePage ? 900 : 700, color: p === safePage ? '#EF4444' : T.primary, background: p === safePage ? 'rgba(239,68,68,0.20)' : 'transparent', cursor: 'pointer', minWidth: 30 }}>{p}</button>
              )}
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

// ── Main Page ─────────────────────────────────────────────────────────────
export default function NetworkPage() {
  // ── v2 universal filter bar — URL-synced, drives the All Locations table ──
  // Multi-select on every dimension. Active mode (default) hides the 350
  // closed stores; All mode includes them. Location-side filters (state/city/
  // group_name/store_code) are piped to locationService.list directly. SKU
  // dimensions (gender/sub_product/style/...) flow through too but only
  // narrow the per-location stock total — the table still shows every
  // location matching the location-side filters with total_stock = 0 when
  // no SKUs match.
  const v2FilterApi =
    useFilters({ defaults: { mode: 'active' }, persist: ['mode'] });
  const { filters: v2Filters, setFilter: setV2, clearAll: clearV2, activeCount: v2Active } = v2FilterApi;

  // ── Table state (affected by filters) ─────────────────────────────────────
  // Initialized from module-level cache so tab-switches don't refetch / flash.
  const [locations,     setLocations]     = useState(() => getCached('net:table:locations') ?? []);
  const [pagination,    setPagination]    = useState(() => getCached('net:table:pagination') ?? null);
  const [cityOptions,   setCityOptions]   = useState(() => getCached('net:table:cities')    ?? []);
  const [filteredGroups,setFilteredGroups]= useState(() => getCached('net:table:groups')    ?? []);
  const [tableLoading,  setTableLoading]  = useState(() => !getCached('net:table:locations'));

  // ── Summary state (always unfiltered — KPIs + Channel Breakdown) ──────────
  const [groupSummary,   setGroupSummary]   = useState(() => getCached('net:sum:groups')   ?? []);
  const [networkSummary, setNetworkSummary] = useState(() => getCached('net:sum:summary')  ?? null);
  const [stateOptions,   setStateOptions]   = useState(() => getCached('net:sum:states')   ?? []);
  const [summaryLoading, setSummaryLoading] = useState(() => !getCached('net:sum:summary'));

  // Server-side filters — driven by AllLocationsTable
  const [tableFilters, setTableFilters] = useState({ sort_by: 'total_stock', page: 1 });

  // Pareto drill-down — set when user clicks a tier in the Concentration
  // Reveal. Holds { tier: 50|80|90, n: <store-count> }. The All Locations
  // table reads this to highlight the first N rows (sorted by total_stock
  // DESC, which it already is by default). Clears automatically when the
  // user changes filters / sort / mode so the rail never lies. Pure client
  // state — no API call, no cache key change, no extra latency.
  const [paretoPick, setParetoPick] = useState(null);
  const allLocationsRef = useRef(null);
  const handleParetoPick = useCallback(({ tier, n }) => {
    if (!n) return;
    setParetoPick({ tier, n });
    // Smooth-scroll to the table on the next paint so the highlight is
    // already rendering when scroll lands. requestAnimationFrame ensures
    // we don't fight React's batched render.
    requestAnimationFrame(() => {
      allLocationsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);
  const clearParetoPick = useCallback(() => setParetoPick(null), []);

  // Fetch summary + groupSummary (drives ChannelBreakdownSection +
  // NetworkChartsSection + StockBreakdownSection state list).
  // Now accepts the full v2 filter set so the legacy chart sections also
  // narrow with every dropdown pick — the WHOLE page speaks one filter.
  const fetchSummaryData = useCallback(async (filters = {}) => {
    if (!getCached('net:sum:summary')) setSummaryLoading(true);
    try {
      const res = await locationService.list({
        page: 1, limit: PAGE_SIZE_LOCS, sort_by: 'total_stock',
        mode:        filters.mode        || 'active',
        state:       filters.state       || undefined,
        city:        filters.city        || undefined,
        group_name:  filters.group_name  || undefined,
        store_code:  filters.store_code  || undefined,
        gender:      filters.gender      || undefined,
        sub_product: filters.sub_product || undefined,
        product:     filters.product     || undefined,
        style:       filters.style       || undefined,
        shade:       filters.shade       || undefined,
        color:       filters.color       || undefined,
        size:        filters.size        || undefined,
        season:      filters.season      || undefined,
        category:    filters.category    || undefined,
      });
      const groups  = res.data.groups    || [];
      const summary = res.data.summary   || null;
      const states  = res.data.states    || [];
      setGroupSummary(groups);     setCached('net:sum:groups',  groups);
      setNetworkSummary(summary);  setCached('net:sum:summary', summary);
      setStateOptions(states);     setCached('net:sum:states',  states);
    } catch (err) {
      notifyApiError(err, 'Failed to load network summary');
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  // Fetch table rows AND piggy-back the summary/groups/states from the same
  // /locations response. Eliminates the redundant fetchSummaryData call that
  // was firing in parallel on every filter change (it hit the same endpoint
  // with slightly different params, doubling backend load and adding ~1.5s
  // of cold latency to every filter switch).
  const fetchTableData = useCallback(async (filters = {}) => {
    const tableKey = `net:table:v4:${filters.sort_by || 'total_stock'}|${filters.page || 1}|m${filters.mode||'active'}|gn${filters.group_name||''}|st${filters.state||''}|ct${filters.city||''}|sc${filters.store_code||''}|q${filters.search||''}|cat${filters.category||''}|g${filters.gender||''}|sp${filters.sub_product||''}|pr${filters.product||''}|sty${filters.style||''}|sh${filters.shade||''}|cl${filters.color||''}|sz${filters.size||''}|se${filters.season||''}`;
    const cached = getCached(tableKey);
    if (cached) {
      setLocations(cached.data);
      setPagination(cached.pagination);
      setCityOptions(cached.cities);
      setFilteredGroups(cached.groups);
      // Hydrate summary too — these came from the same /locations response.
      if (cached.groups)   setGroupSummary(cached.groups);
      if (cached.summary)  setNetworkSummary(cached.summary);
      if (cached.states?.length) setStateOptions(cached.states);
      setSummaryLoading(false);
      setCached('net:table:locations', cached.data);
      setCached('net:table:pagination', cached.pagination);
      setCached('net:table:cities',     cached.cities);
      setCached('net:table:groups',     cached.groups);
      if (isFresh(tableKey)) { setTableLoading(false); return; }
    } else {
      setTableLoading(true);
    }
    try {
      const params = {
        page:        filters.page        || 1,
        limit:       PAGE_SIZE_LOCS,
        group_name:  filters.group_name  || undefined,
        state:       filters.state       || undefined,
        city:        filters.city        || undefined,
        search:      filters.search      || undefined,
        category:    filters.category    || undefined,
        sort_by:     filters.sort_by     || 'total_stock',
        // ── v2 SKU + lifecycle filters threaded through ──
        gender:      filters.gender      || undefined,
        sub_product: filters.sub_product || undefined,
        product:     filters.product     || undefined,
        style:       filters.style       || undefined,
        shade:       filters.shade       || undefined,
        color:       filters.color       || undefined,
        size:        filters.size        || undefined,
        season:      filters.season      || undefined,
        store_code:  filters.store_code  || undefined,
        mode:        filters.mode        || 'active',
      };
      const res = await locationService.list(params);
      const data       = res.data.data        || [];
      const pag        = res.data.pagination  || null;
      const cities     = res.data.cities      || [];
      const groupsR    = res.data.groups      || [];
      const summaryR   = res.data.summary     || null;
      const statesR    = res.data.states      || [];
      setLocations(data);        setCached('net:table:locations',  data);
      setPagination(pag);        setCached('net:table:pagination', pag);
      setCityOptions(cities);    setCached('net:table:cities',     cities);
      setFilteredGroups(groupsR);setCached('net:table:groups',     groupsR);
      // Piggy-back the summary block from the SAME response so we don't fire
      // a second /locations call (fetchSummaryData) on every filter change.
      // Eliminates the duplicate ~1.5s cold call that was driving the 2-3s lag.
      setGroupSummary(groupsR);    setCached('net:sum:groups',  groupsR);
      if (summaryR) setNetworkSummary(summaryR), setCached('net:sum:summary', summaryR);
      if (statesR.length) setStateOptions(statesR), setCached('net:sum:states', statesR);
      setSummaryLoading(false);
      setCached(tableKey, { data, pagination: pag, cities, groups: groupsR, summary: summaryR, states: statesR });
    } catch (err) {
      notifyApiError(err, 'Failed to load locations');
    } finally {
      setTableLoading(false);
    }
  }, []);

  // Initial load — both in parallel, skipped if cache is fresh
  useEffect(() => {
    if (isFresh('net:sum:summary')) {
      setSummaryLoading(false);
    } else {
      fetchSummaryData();
    }
    fetchTableData({ sort_by: 'total_stock' });
  }, [fetchSummaryData, fetchTableData]);

  // ── v2 FilterBar → re-fetch EVERYTHING on the page ──────────────────────
  // When the universal filter bar changes, refetch BOTH summary (KPIs +
  // ChannelBreakdown + NetworkCharts) AND table — so the entire page speaks
  // one consistent filter. Pulse component re-fetches independently via its
  // own effect on `filters` prop. Multi-select arrays joined as CSV strings
  // — backend's location.controller accepts CSV for every dimension.
  const v2FiltersJson = JSON.stringify(v2Filters); // deps key
  // Any v2 filter change invalidates the Pareto highlight — the underlying
  // dataset just changed, so "top 100 stores" might mean different stores
  // now. Cheap state reset; no fetch implications.
  useEffect(() => { setParetoPick(null); }, [v2FiltersJson]);
  useEffect(() => {
    const csv = (v) => Array.isArray(v) ? v.join(',') : (v || '');
    const merged = {
      ...tableFilters,
      page:        1,
      state:       csv(v2Filters.state)       || undefined,
      city:        csv(v2Filters.city)        || undefined,
      group_name:  csv(v2Filters.group_name)  || undefined,
      gender:      csv(v2Filters.gender_name) || undefined,
      sub_product: csv(v2Filters.sub_product) || undefined,
      product:     csv(v2Filters.product)     || undefined,
      style:       csv(v2Filters.style)       || undefined,
      shade:       csv(v2Filters.shade)       || undefined,
      color:       csv(v2Filters.color)       || undefined,
      size:        csv(v2Filters.size)        || undefined,
      season:      csv(v2Filters.season)      || undefined,
      category:    csv(v2Filters.category)    || undefined,
      store_code:  csv(v2Filters.store_code)  || undefined,
      mode:        v2Filters.mode             || 'active',
    };
    setTableFilters(prev => ({ ...prev, ...merged }));
    // ONE call to /locations: returns rows + groups + summary + states + cities.
    // fetchSummaryData no longer fires on filter change (it duplicated the
    // backend work; that's now piggy-backed onto fetchTableData's response).
    fetchTableData(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2FiltersJson]);

  // Table filter changes → only re-fetch table, never touch summary.
  // Critical: re-apply the v2 FilterBar values on top so a sort/page click
  // inside the table can't clobber the user's "Bihar" / "EBO-SOR" / mode
  // pick from the universal filter bar above. The local table dropdowns
  // (search / state / city / channel) are an INTERSECTION of v2 — they
  // can NARROW further but never widen back to all rows.
  const handleFilterChange = useCallback((filters) => {
    const csv = (v) => Array.isArray(v) ? v.join(',') : (v || '');
    // v2 wins for every dimension it has a value on; the local table input
    // wins only when v2 is empty for that dim (so user can still type a
    // city locally if they haven't picked one in the v2 bar).
    const v2State      = csv(v2Filters.state);
    const v2City       = csv(v2Filters.city);
    const v2Group      = csv(v2Filters.group_name);
    const v2StoreCode  = csv(v2Filters.store_code);
    const merged = {
      ...filters,
      state:       v2State     || filters.state     || undefined,
      city:        v2City      || filters.city      || undefined,
      group_name:  v2Group     || filters.group_name|| undefined,
      store_code:  v2StoreCode || undefined,
      // SKU-side dims live ONLY in the v2 bar — table has no UI for them
      gender:      csv(v2Filters.gender_name) || undefined,
      sub_product: csv(v2Filters.sub_product) || undefined,
      product:     csv(v2Filters.product)     || undefined,
      style:       csv(v2Filters.style)       || undefined,
      shade:       csv(v2Filters.shade)       || undefined,
      color:       csv(v2Filters.color)       || undefined,
      size:        csv(v2Filters.size)        || undefined,
      season:      csv(v2Filters.season)      || undefined,
      category:    csv(v2Filters.category)    || undefined,
      mode:        v2Filters.mode             || 'active',
    };
    setTableFilters(merged);
    fetchTableData(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchTableData, v2FiltersJson]);

  // ── KPI source values ─────────────────────────────────────────────────────
  // Backend now returns Active/Closed splits inline (one query, no extra
  // round-trip), so users always see the full picture and the active share.
  const totalLocations  = Number(networkSummary?.total_locations  || 0);
  const activeLocations = Number(networkSummary?.active_locations || 0);
  const closedLocations = Number(networkSummary?.closed_locations || 0);
  const totalStock      = Number(networkSummary?.total_stock      || 0);
  const activeStock     = Number(networkSummary?.active_stock     || 0);
  const closedStock     = Number(networkSummary?.closed_stock     || 0);
  const uniqueSkus      = Number(networkSummary?.unique_skus      || 0);
  const totalGroups     = groupSummary.length;
  const totalStates     = stateOptions.length;

  // Top group by stock
  const topGroup = useMemo(() => {
    if (!groupSummary.length) return null;
    return [...groupSummary].sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0))[0];
  }, [groupSummary]);

  return (
    <FiltersProvider value={v2FilterApi}>
    <DashboardLayout title="Network" subtitle="Retail network — inventory positions across all locations and channels">
      {/* Premium skin layer — same .sx-page tokens as the Sales page so
          both pages share one visual language. Cards, tables, chips, and
          numbers all inherit the refined hairlines + Plus Jakarta numbers. */}
      <div className="sx-page sx-fade">

      {/* Mode + chips strip — dimensional filters live in the sidebar
          (LENS cluster).  Mode (Active/Inactive/All) stays on-page so it's
          one click away regardless of sidebar state. */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
        padding: '14px 24px 0',
      }}>
        <ModePill
          mode={v2Filters.mode || 'active'}
          onChange={(m) => setV2('mode', m)}
        />
      </div>
      <FilterChips
        filters={v2Filters}
        setFilter={setV2}
        clearAll={clearV2}
      />

      {/* ── Network Pulse — god-tier hero section ──
          Hero KPI strip with current-status splits · Pareto reveal ·
          Top stores · Top states · Channel mix · Action panel.
          One round-trip, all 13 v2 filters narrow every widget. ─────────────*/}
      <NetworkPulse filters={v2Filters} onParetoPick={handleParetoPick} />

      {/* ── Legacy KPI mini-row (unfiltered, retained for back-compat) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 28, opacity: 0 /* hidden — replaced by NetworkPulse above */, height: 0, overflow: 'hidden' }}>
        <KpiCard icon={Globe}      label="Total Locations" value={fmtNum(totalLocations)} sub={`${totalStates} states covered`}                                                       accent="#0f172a" loading={summaryLoading} />
      </div>

      {/* ── Refresh — refreshes both summary and table ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
        <button onClick={() => { fetchSummaryData(); fetchTableData(tableFilters); }} disabled={summaryLoading || tableLoading}
          style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 800, color: T.primary, background: 'var(--bg-elevated)', cursor: (summaryLoading || tableLoading) ? 'default' : 'pointer', opacity: (summaryLoading || tableLoading) ? 0.6 : 1 }}>
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
      <NetworkChartsSection groups={groupSummary} filteredGroups={filteredGroups} locations={locations} loading={summaryLoading} />

      {/* ── Colour & Size Stock Distribution — narrows with v2 filter bar ── */}
      <StockBreakdownSection stateOptions={stateOptions} v2Filters={v2Filters} />

      {/* ── All Locations Table ── */}
      {/* Anchor lives on a wrapping div so the smooth-scroll target is
          stable even if the table conditionally renders during refetch. */}
      <div ref={allLocationsRef} style={{ scrollMarginTop: 16 }}>
        <SectionTitle icon={Globe} label="All Locations — Full Network" />
        <AllLocationsTable
          locations={locations}
          pagination={pagination}
          groups={groupSummary}
          stateOptions={stateOptions}
          cityOptions={cityOptions}
          loading={tableLoading}
          onFilterChange={handleFilterChange}
          paretoPick={paretoPick}
          onClearParetoPick={clearParetoPick}
        />
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      </div>{/* /.sx-page */}
    </DashboardLayout>
    </FiltersProvider>
  );
}
