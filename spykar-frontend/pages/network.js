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
import { useAlerts } from '../lib/useAlerts';
import { getCached, setCached, isFresh } from '../lib/dashboardCache';
import toast from 'react-hot-toast';
import { notifyApiError } from '../lib/notifyApiError';
import {
  Globe, Package, MapPin, PieChart, BarChart2, IndianRupee,
  RefreshCw, TrendingUp, Layers, Activity, Skull, AlertTriangle, Zap, Target,
  Building2, Calendar, Sparkles, XCircle, PackageMinus, ShieldAlert,
  ChevronRight, AlertCircle, Heart,
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
          fontSize: 12.5, fontWeight: 800, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: T.secondary,
        }}>{label}</span>
      </div>
      {loading
        ? <div className="sx-shimmer" style={{ height: 36, width: '70%', marginBottom: 10, borderRadius: 6 }} />
        : <div className="sx-hero-num" title={rawTooltip}
            style={{ marginBottom: 8, fontSize: 32, cursor: 'help' }}>{value}</div>
      }
      {sub  && <div style={{ fontSize: 13, fontWeight: 600, color: T.secondary, letterSpacing: '0.005em', lineHeight: 1.45 }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 12.5, fontWeight: 600, color: T.secondary, marginTop: 2, letterSpacing: '0.005em' }}>{sub2}</div>}
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
  // SWR: only show shimmer rows on the cold load (no prior data). On
  // subsequent refetches keep the populated rows visible — a subtle
  // dim signals "refreshing" without the chart blanking and snapping back.
  const isCold = loading && rows.length === 0;
  const isRefreshing = loading && rows.length > 0;

  const totalStock = rows.reduce((s, r) => s + Number(r.stock || 0), 0);
  const maxStock   = rows[0] ? Number(rows[0].stock || 0) : 1;

  return (
    <div className="sx-card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <PieChart size={13} color={T.primary} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 800, color: T.primary, letterSpacing: '0.10em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Channel Breakdown</span>
          {rows.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#EF4444', borderRadius: 100, padding: '2px 7px' }}>{rows.length}</span>}
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>Sorted by highest stock</span>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: 420, opacity: isRefreshing ? 0.6 : 1, transition: 'opacity 200ms ease' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              {['#','Channel / Group','Billing','Distribution','Locations','Total Stock','Share %'].map(h => (
                <th key={h} style={{ padding: '9px 14px', textAlign: ['Locations','Total Stock','Share %'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isCold
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

      {rows.length > 0 && (
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

  // (Billing Model donut removed — chart deleted from the Network page.)

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
      {/* Charts row: Stock by Channel + Top 10 Stores side by side */}
      <div className="sx-mobile-two-grid network-mobile-chart-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        {/* Chart 1: Stock by Channel */}
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

        {/* Chart 2: Top 10 Stores */}
        <div className={chartCardClass} style={chartCardStyle}>
          <div style={chartHeaderStyle}>
            <Activity size={13} color={T.primary} strokeWidth={2.5} />
            <span style={chartTitleStyle}>Top 10 Stores — By Stock (Current Filter)</span>
          </div>
          <div style={{ padding: '16px 18px 8px' }}>
            {loading
              ? <div style={{ height: 280, background: T.bg, borderRadius: 8 }} />
              : <Chart options={topStoresChart.options} series={topStoresChart.series} type="bar" height={280} />
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

  // Data — hydrate from module cache so re-mount / re-visit paints synchronously.
  const [colorData, setColorData] = useState(() => getCached('net:bd:color') ?? []);
  const [sizeData,  setSizeData]  = useState(() => getCached('net:bd:size')  ?? []);
  // `loading` is the COLD-load flag: only true when there is no prior data
  // to show. Subsequent refetches keep the existing chart on screen (SWR) so
  // the user never sees the chart blank out and snap back. A subtle
  // `refreshing` flag drives an opacity dim only.
  const [loading,    setLoading]    = useState(() => !getCached('net:bd:color'));
  const [refreshing, setRefreshing] = useState(false);
  // AbortController + activeKey ref — supersede stale fetches.
  const abortRef    = useRef(null);
  const activeKeyRef = useRef('');

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
    const params = {
      state:    state    || csv(v2Filters.state) || undefined,
      city:     city     || csv(v2Filters.city)  || undefined,
      category: category || csv(v2Filters.category) || undefined,
      ...v2,
    };
    // Stable cache key per filter combo — re-visiting a previously seen
    // combo paints synchronously from cache and we skip the network call.
    const key = `net:bd:v2:${JSON.stringify(params)}`;
    activeKeyRef.current = key;

    const cached = getCached(key);
    if (cached) {
      setColorData(cached.color);
      setSizeData(cached.size);
      setCityOpts(cached.cities);
      setLoading(false);
      if (isFresh(key)) return; // fresh hit → no refetch
      // stale cached entry → background revalidate, KEEP UI populated
    }

    // SWR: don't blank to skeleton if we already have prior data on screen.
    if (!cached && colorData.length === 0) setLoading(true);
    setRefreshing(true);

    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      // locationService.list doesn't understand category — strip it for city opts
      const locParams = { state: params.state, city: params.city, limit: 1 };
      const [colorRes, sizeRes, locRes] = await Promise.all([
        analyticsService.getColorDistribution(params, { signal: ac.signal }),
        analyticsService.getSizeDistribution(params,  { signal: ac.signal }),
        locationService.list(locParams,               { signal: ac.signal }),
      ]);
      // Race-guard: bail if a newer filter combo has been requested since.
      if (activeKeyRef.current !== key) return;
      const color  = colorRes.data.data || [];
      const size   = sizeRes.data.data  || [];
      const cities = locRes.data.cities || [];
      setColorData(color);
      setSizeData(size);
      setCityOpts(cities);
      // Persist for instant repaint on next mount / filter revisit.
      setCached(key, { color, size, cities });
      setCached('net:bd:color', color);
      setCached('net:bd:size',  size);
    } catch (err) {
      // Aborts are first-class — superseded by a newer fetch, not a real failure.
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || err?.message === 'canceled') return;
      /* silent on real errors — keep prior data on screen */
    } finally {
      if (activeKeyRef.current === key) {
        setLoading(false);
        setRefreshing(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(v2Filters), colorData.length]);

  // 250ms debounce — rapid multi-select clicks coalesce into ONE fetch.
  // Without this a user clicking 4 chips in a second fires 4 mega-CTE
  // scans; only the last response is used (race-guard) but the server
  // pays for all four and the final response lands queued behind them.
  useEffect(() => {
    const t = setTimeout(() => fetchBreakdown(filterState, filterCity, filterCategory, v2Params), 250);
    return () => clearTimeout(t);
  }, [filterState, filterCity, filterCategory, v2Params, fetchBreakdown]);

  // Cancel any in-flight request when this section unmounts.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

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
    <div style={{ marginBottom: 28 }}>
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
      <div className="sx-mobile-two-grid network-mobile-breakdown-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Colour chart */}
        <div className={cardClass} style={cardStyle}>
          <div className="network-breakdown-card__header" style={hdrStyle}>
            <PieChart size={13} color='#2563EB' strokeWidth={2.5} />
            <span style={ttlStyle}>Stock by Colour</span>
            {colorData.length > 0 &&
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
          <div className="network-breakdown-card__body" style={{ padding: '12px 16px 8px', position: 'relative' }}>
            {/* Cold load (no data yet) → skeleton. Subsequent refetches keep
                the existing chart visible with a subtle dim so the user
                never sees the chart disappear and snap back. */}
            {loading && colorRows.length === 0
              ? <div style={{ height: Math.max(180, skeletonH), background: T.bg, borderRadius: 8 }} />
              : colorRows.length === 0
                ? <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No colour data</div>
                : <div style={{ opacity: refreshing ? 0.55 : 1, transition: 'opacity 200ms ease' }}>
                    <Chart options={colorChart.options} series={colorChart.series} type="bar" height={colorH} />
                  </div>
            }
          </div>
        </div>

        {/* Size chart */}
        <div className={cardClass} style={cardStyle}>
          <div className="network-breakdown-card__header" style={hdrStyle}>
            <Activity size={13} color='#059669' strokeWidth={2.5} />
            <span style={ttlStyle}>Stock by Size</span>
            {sizeData.length > 0 &&
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
          <div className="network-breakdown-card__body" style={{ padding: '12px 16px 8px', position: 'relative' }}>
            {loading && sizeRows.length === 0
              ? <div style={{ height: Math.max(180, skeletonH), background: T.bg, borderRadius: 8 }} />
              : sizeRows.length === 0
                ? <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No size data</div>
                : <div style={{ opacity: refreshing ? 0.55 : 1, transition: 'opacity 200ms ease' }}>
                    <Chart options={sizeChart.options} series={sizeChart.series} type="bar" height={sizeH} />
                  </div>
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

      {/* Table — SWR: existing rows stay visible during refetch with a
          subtle dim. Skeleton only on cold load (no rows yet). */}
      <div style={{ overflowX: 'auto', opacity: loading && locations.length > 0 ? 0.6 : 1, transition: 'opacity 200ms ease' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg-card-hover)' }}>
              {['#','Location Name','Channel / Group','Billing','State','City','Total Stock','Total Value'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: ['Total Stock','Total Value','#'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 800, color: T.muted, letterSpacing: '0.10em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && locations.length === 0
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

      {/* Pagination footer — keep visible during refetch (SWR) so the user
          doesn't watch the page chrome jitter on every filter click. */}
      {totalRecords > 0 && (
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
  // AbortController per in-flight table fetch — same rationale as /sales:
  // a fast filter sequence shouldn't queue 4 redundant /locations scans.
  const tableFetchRef = useRef(null);

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
    if (tableFetchRef.current) tableFetchRef.current.abort();
    const ac = new AbortController();
    tableFetchRef.current = ac;
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
      const res = await locationService.list(params, { signal: ac.signal });
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
      // Aborts are first-class — caller superseded us, not a real failure.
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || err?.message === 'canceled') {
        return;
      }
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
    // 250 ms debounce so a CEO clicking through four filter pills in a
    // second only fires the LAST scan, not all four.  fetchTableData has
    // its own AbortController; combined, the server pays for at most one
    // request per "settled" filter state.
    const t = setTimeout(() => fetchTableData(merged), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2FiltersJson]);

  // Abort any in-flight table request on unmount.
  useEffect(() => () => { tableFetchRef.current?.abort(); }, []);

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
      <div className="sx-mobile-control-row network-mobile-control-row" style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
        padding: '8px 24px 6px',
      }}>
        <div style={{ flex: 1 }} />
        <ModePill
          mode={v2Filters.mode || 'active'}
          onChange={(m) => setV2('mode', m)}
        />
      </div>
      <div className="sx-mobile-chip-strip" style={{ marginTop: 28 }}>
        <FilterChips
          filters={v2Filters}
          setFilter={setV2}
          clearAll={clearV2}
        />
      </div>

      {/* ── Network Pulse — god-tier hero section ──
          Hero KPI strip with current-status splits · Pareto reveal ·
          Top stores · Top states · Channel mix · Action panel.
          One round-trip, all 13 v2 filters narrow every widget. ─────────────*/}
      <NetworkPulse filters={v2Filters} onParetoPick={handleParetoPick} />

      {/* ── Legacy KPI mini-row (unfiltered, retained for back-compat) ──
          Fully hidden AND zero-margin so it contributes no layout space (was
          leaking a phantom 28px gap below NetworkPulse). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, opacity: 0, height: 0, margin: 0, overflow: 'hidden' }}>
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
      <div style={{ marginBottom: 28 }}>
        <SectionTitle icon={PieChart} label="Channel Breakdown — All Groups" />
        <ChannelBreakdownSection groups={groupSummary} loading={summaryLoading} />
      </div>

      {/* ── Network Charts ── (title hugs its charts at the same 18px gap the
          other section titles use — no extra wrapper margin) */}
      <SectionTitle icon={BarChart2} label="Network Analytics — Stock Distribution" />
      <NetworkChartsSection groups={groupSummary} filteredGroups={filteredGroups} locations={locations} loading={summaryLoading} />

      {/* ── Colour & Size Stock Distribution — narrows with v2 filter bar ── */}
      <StockBreakdownSection stateOptions={stateOptions} v2Filters={v2Filters} />

      {/* Stock Health (Out-of-Stock / Reorder / Low) + Most Critical SKUs
          section removed from the Network page. */}

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

// ─── NetworkStockHealth — out-of-stock / reorder / low-stock panel ───────────
// Latency: zero extra network calls. Reuses useAlerts() (module-level cache,
// 60s TTL, single in-flight request shared across consumers — see
// lib/useAlerts.js). v2Filters narrow the alerts client-side via useMemo, so
// changing a filter never refetches.
function NetworkStockHealth({ v2Filters = {} }) {
  // Top-N picker for the critical drill list. Pure client-side slicing on the
  // already-loaded alerts array — no extra fetch, no DB hit, sub-millisecond
  // re-render even at N=200. Persisted so leadership doesn't lose the choice.
  const [topN, setTopN] = useState(() => {
    if (typeof window === 'undefined') return 10;
    const saved = parseInt(localStorage.getItem('networkStockHealthTopN'), 10);
    return [10, 20, 50, 200].includes(saved) ? saved : 10;
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('networkStockHealthTopN', String(topN));
  }, [topN]);

  // Mode (Active / Inactive / All) is wired to the page-level ModePill at the
  // top right of the page (drives v2Filters.mode). One source of truth — when
  // the user flips the pill there, this panel re-keys useAlerts() and either
  // hits the per-mode Redis cache (sub-50ms response) or fires a fresh fetch.
  // No localStorage / no in-panel toggle / no double state.
  const mode = ['active', 'inactive', 'all'].includes(v2Filters.mode) ? v2Filters.mode : 'active';

  const { alerts, summary, loading } = useAlerts({ mode });

  // Normalise filter values to lowercase sets for cheap matching.
  const filterSet = useMemo(() => {
    const toSet = (v) => {
      if (!v) return null;
      const arr = Array.isArray(v) ? v : String(v).split(',');
      const trimmed = arr.map(x => String(x).trim().toLowerCase()).filter(Boolean);
      return trimmed.length ? new Set(trimmed) : null;
    };
    return {
      state:      toSet(v2Filters.state),
      city:       toSet(v2Filters.city),
      group_name: toSet(v2Filters.group_name),
      color:      toSet(v2Filters.color),
      size:       toSet(v2Filters.size),
    };
  }, [v2Filters]);

  const hasActiveFilter = !!(filterSet.state || filterSet.city || filterSet.group_name || filterSet.color || filterSet.size);

  // Two passes:
  //   • headline counts → use TRUE network summary when no filter is active
  //     (authoritative, not capped by detail-row LIMIT)
  //   • drill-list + filtered counts → derive from `alerts` rows because
  //     summary is unfiltered. When filters narrow the scope, the cards
  //     show the filtered-row count and a hint that we're looking at a
  //     sample.
  // Bucketize once per (alerts × filterSet). Slicing to topN happens in a
  // separate memo so changing the Top-N picker is O(N), not O(alerts.length).
  const filteredBuckets = useMemo(() => {
    const oosArr = [], reorderArr = [], lowArr = [];
    for (const a of alerts) {
      if (filterSet.state      && !filterSet.state.has((a.state || '').toLowerCase()))           continue;
      if (filterSet.city       && !filterSet.city.has((a.city || '').toLowerCase()))             continue;
      if (filterSet.group_name && !filterSet.group_name.has((a.location_type || '').toLowerCase())) continue;
      if (filterSet.color      && !filterSet.color.has((a.color_name || '').toLowerCase()))      continue;
      if (filterSet.size       && !filterSet.size.has(String(a.size || '').toLowerCase()))       continue;
      if (a.alert_level === 'OUT_OF_STOCK')      oosArr.push(a);
      else if (a.alert_level === 'REORDER_NOW')  reorderArr.push(a);
      else                                        lowArr.push(a);
    }
    // Pre-rank the critical pool (OOS first, then reorder by shortfall %)
    // ONCE here. Slicing the head is then constant-time per topN change.
    const ranked = [...oosArr, ...reorderArr].sort((x, y) => {
      const sx = x.alert_level === 'OUT_OF_STOCK' ? 1e9 : (x.shortfall_pct || 0);
      const sy = y.alert_level === 'OUT_OF_STOCK' ? 1e9 : (y.shortfall_pct || 0);
      return sy - sx;
    });
    return { oosArr, reorderArr, lowArr, ranked };
  }, [alerts, filterSet]);

  // True authoritative counts (no row cap) when no filter is active;
  // filtered counts otherwise.
  const oos     = hasActiveFilter ? filteredBuckets.oosArr.length     : (summary?.out_of_stock || 0);
  const reorder = hasActiveFilter ? filteredBuckets.reorderArr.length : (summary?.reorder_now  || 0);
  const low     = hasActiveFilter ? filteredBuckets.lowArr.length     : (summary?.low_stock    || 0);
  const totalFiltered = oos + reorder + low;
  // O(topN) slice of the pre-ranked pool — constant time on Top-N change.
  const criticalSample = useMemo(
    () => filteredBuckets.ranked.slice(0, topN),
    [filteredBuckets, topN]
  );
  const criticalAvailable = filteredBuckets.ranked.length;

  const overallSev = oos > 0 ? 'critical' : reorder > 0 ? 'warn' : low > 0 ? 'info' : 'ok';
  const sevTint = {
    critical: { fg: '#DC2626', bg: 'rgba(220,38,38,0.10)', ring: 'rgba(220,38,38,0.45)' },
    warn:     { fg: '#D97706', bg: 'rgba(217,119,6,0.10)', ring: 'rgba(217,119,6,0.45)' },
    info:     { fg: '#2563EB', bg: 'rgba(37,99,235,0.10)', ring: 'rgba(37,99,235,0.40)' },
    ok:       { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)', ring: 'rgba(22,163,74,0.40)' },
  }[overallSev];

  const Card = ({ icon: Icon, title, count, total, fg, bg, subtitle }) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return (
      <div style={{
        position: 'relative', padding: 18, borderRadius: 14,
        background: 'var(--bg-elevated)', border: `1px solid ${T.border}`,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'transform 180ms ease, box-shadow 180ms ease',
        cursor: 'default', overflow: 'hidden',
      }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)';   e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)'; }}
      >
        {/* severity rail */}
        <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 4, background: fg, borderTopLeftRadius: 14, borderBottomLeftRadius: 14 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon size={18} strokeWidth={2.4} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }}>{title}</div>
          </div>
          {count > 0 && (
            <span style={{ padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 800 }}>{pct}%</span>
          )}
        </div>
        <div style={{ fontSize: 32, fontWeight: 900, color: T.primary, lineHeight: 1, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
          {loading ? '…' : fmtNum(count)}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.secondary, marginTop: 6 }}>{subtitle}</div>
      </div>
    );
  };

  // Mode label for the live pill — shows which scope is currently in effect
  // so the panel makes it obvious that the page-level toggle is steering it.
  const modeLabel = { active: 'Active', inactive: 'Inactive', all: 'All' }[mode];

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Section header — title · live status pill (mode is wired to the
          page-level ModePill at the top right; no separate toggle here). */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <SectionTitle icon={ShieldAlert} label="Stock Health — Out of Stock · Reorder · Low" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderRadius: 999, background: sevTint.bg, border: `1px solid ${sevTint.ring}` }}>
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%', background: sevTint.fg,
              boxShadow: `0 0 0 0 ${sevTint.fg}`,
              animation: totalFiltered > 0 ? 'nshPulse 1.8s ease-in-out infinite' : 'none',
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 800, color: sevTint.fg, letterSpacing: '0.02em' }}>
            {loading ? 'Loading…' : totalFiltered === 0 ? 'All clear' : `${fmtNum(totalFiltered)} alerts · ${modeLabel}${hasActiveFilter ? ' · filtered' : ''}`}
          </span>
        </div>
      </div>

      {/* 3 KPI cards — Out of Stock / Reorder Now / Low Stock
          Headline numbers come from the backend SUMMARY (true network total,
          NOT capped by detail-row LIMIT) when no filter is active; from the
          filtered row sample when filters are applied. */}
      <div className="sx-mobile-three-grid network-mobile-health-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 10 }}>
        <Card icon={XCircle}      title="Out of Stock"  count={oos}     total={totalFiltered} fg="#DC2626" bg="rgba(220,38,38,0.10)"  subtitle="Zero on-hand · revenue at risk" />
        <Card icon={PackageMinus} title="Reorder Now"   count={reorder} total={totalFiltered} fg="#D97706" bg="rgba(217,119,6,0.10)"  subtitle="Below reorder point · raise PO" />
        <Card icon={AlertCircle}  title="Low Stock"     count={low}     total={totalFiltered} fg="#2563EB" bg="rgba(37,99,235,0.10)"  subtitle="Below safety stock · monitor" />
      </div>

      {/* Data-provenance footnote */}
      <div style={{ marginBottom: 16, fontSize: 11, fontWeight: 600, color: T.muted, letterSpacing: '0.02em' }}>
        {hasActiveFilter
          ? <>Counts derived from the filtered detail rows (top {fmtNum(alerts?.length || 0)} most critical SKU-locations cached). Clear filters above to see the full network total.</>
          : <>Counts reflect the full active-network scan ({mode === 'active' ? 'active locations & SKUs only' : mode === 'inactive' ? 'inactive only' : 'all locations & SKUs'}). Detail list below shows the {fmtNum(alerts?.length || 0)} most critical for fast drill-down.</>
        }
      </div>

      {/* Critical drill-list — Top N picker (10 / 20 / 50 / 200) */}
      <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${T.border}`, borderRadius: 14, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Zap size={14} style={{ color: '#DC2626' }} strokeWidth={2.6} />
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.primary }}>Most Critical SKUs</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>· showing {fmtNum(criticalSample.length)} of {fmtNum(criticalAvailable)} ranked by severity</span>
          </div>
          {/* Top N segmented picker — pure client-side slice, sub-ms. */}
          <div style={{ display: 'inline-flex', alignItems: 'center', padding: 3, borderRadius: 999, background: 'var(--bg-canvas)', border: `1px solid ${T.border}`, gap: 2 }}>
            {[10, 20, 50, 200].map(n => (
              <button key={n} onClick={() => setTopN(n)}
                style={{
                  padding: '5px 12px', borderRadius: 999, border: 'none',
                  fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
                  cursor: 'pointer', transition: 'all 140ms ease',
                  background: topN === n ? T.accent : 'transparent',
                  color:      topN === n ? '#fff'   : T.muted,
                }}>
                Top {n}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="sx-mobile-two-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {[0,1,2,3,4,5].map(i => <div key={i} style={{ height: 56, borderRadius: 10, background: T.border, opacity: 0.5 }} />)}
          </div>
        ) : criticalSample.length === 0 ? (
          <div style={{ padding: '24px 8px', textAlign: 'center' }}>
            <Heart size={28} style={{ color: '#16A34A', marginBottom: 8 }} />
            <div style={{ fontSize: 13, fontWeight: 800, color: T.primary }}>All clear in current scope</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>No SKUs below safety stock for the selected filters</div>
          </div>
        ) : (
          <div className="ai-scroll network-critical-grid" style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 8,
            // Cap height when N is large so the panel never dominates the page.
            // 4 rows of cards is a comfortable window; the rest is scrollable.
            maxHeight: topN >= 50 ? 320 : 'none',
            overflowY: topN >= 50 ? 'auto' : 'visible',
            paddingRight: topN >= 50 ? 4 : 0,
          }}>
            {criticalSample.map((a, i) => {
              const isOOS = a.alert_level === 'OUT_OF_STOCK';
              const sev = isOOS ? sevTint : { fg: '#D97706', bg: 'rgba(217,119,6,0.10)', ring: 'rgba(217,119,6,0.45)' };
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  borderRadius: 10, background: 'var(--bg-canvas)', border: `1px solid ${T.border}`,
                  borderLeft: `3px solid ${sev.fg}`,
                }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: sev.bg, color: sev.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {isOOS ? <XCircle size={15} strokeWidth={2.5} /> : <PackageMinus size={15} strokeWidth={2.5} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: T.primary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.sku_code} · {(a.color_name || '').toUpperCase()} · {a.size}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.location_name} · {a.city}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 900, color: sev.fg, fontVariantNumeric: 'tabular-nums' }}>
                      {isOOS ? '0' : fmtNum(a.qty_on_hand)}
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                      {isOOS ? 'on hand' : `of ${fmtNum(a.safety_stock)}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        @keyframes nshPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.45); }
          50%      { box-shadow: 0 0 0 6px rgba(220,38,38,0); }
        }
      `}</style>
    </div>
  );
}
