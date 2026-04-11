import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import DashboardLayout from '../components/layout/DashboardLayout';
import { analyticsService } from '../lib/services';
import toast from 'react-hot-toast';
import {
  TrendingUp, TrendingDown, ShoppingBag, RotateCcw,
  Package, Store, Calendar, Filter, RefreshCw, ChevronDown,
  Award, Zap, BarChart2, PieChart, Activity,
} from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

// ── Typography constants — bold black everywhere ───────────────────────────
const T = {
  primary:   '#0f172a',
  secondary: '#1e293b',
  muted:     '#334155',   // darkest allowed "muted" — still bold/readable
  border:    '#e2e8f0',
  bg:        '#f8fafc',
  accent:    '#0f172a',
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

// ── KPI Card ──────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, sub2, accent = '#0f172a', loading }) {
  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${T.border}`,
      borderRadius: 16,
      padding: '22px 24px',
      display: 'flex', flexDirection: 'column', gap: 8,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Accent bar top */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent, borderRadius: '16px 16px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: accent + '14',
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
        ? <div style={{ height: 38, background: '#f1f5f9', borderRadius: 8, animation: 'pulse 1.5s infinite' }} />
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <Icon size={16} color={T.primary} strokeWidth={2.5} />
      <span style={{ fontSize: 13, fontWeight: 900, color: T.primary, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </span>
    </div>
  );
}

// ── Shared mini filter bar style ─────────────────────────────────────────
const filterInput = { border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 10px 6px 30px', fontSize: 12, fontWeight: 700, color: T.primary, outline: 'none', background: T.bg };
const filterSelect = { border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 28px 6px 10px', fontSize: 12, fontWeight: 700, color: T.primary, outline: 'none', background: T.bg, appearance: 'none', cursor: 'pointer' };
const SearchIcon = () => <svg style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', opacity: 0.45 }} width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.5}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const ChevronIcon = () => <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth={2.5}><polyline points="6 9 12 15 18 9"/></svg>;

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
function ColourBreakdownSection({ data, loading }) {
  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState('units_sold');
  const [pageSize, setPageSize] = useState(50);

  const allRows = useMemo(() => {
    let r = data?.by_color || [];
    if (search) r = r.filter(x => x.color_name?.toLowerCase().includes(search.toLowerCase()));
    return [...r].sort((a, b) => Number(b[sort]) - Number(a[sort]));
  }, [data?.by_color, search, sort]);

  const rows = useMemo(() =>
    pageSize === 'All' ? allRows : allRows.slice(0, pageSize),
  [allRows, pageSize]);

  const total = data?.by_color?.length || 0;

  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <PieChart size={13} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Colour Breakdown</span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: T.primary, borderRadius: 100, padding: '2px 7px', letterSpacing: '0.04em' }}>
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
        {/* Sort */}
        <div style={{ position: 'relative' }}>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...filterSelect, minWidth: 120 }}>
            <option value="units_sold">Sort: Units</option>
            <option value="sales_value">Sort: Revenue</option>
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
            <tr style={{ background: T.bg }}>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>#</th>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Colour</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Units</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Revenue</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}`, whiteSpace: 'nowrap' }}>Avg Price</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={5} style={{ padding: '9px 14px' }}><div style={{ height: 13, background: T.bg, borderRadius: 4 }} /></td></tr>
                ))
              : rows.map((r, i) => (
                  <tr key={i}
                    style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? '#fff' : '#fafafe' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f0f4ff'}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafe'}
                  >
                    <td style={{ padding: '9px 14px', fontSize: 11, fontWeight: 700, color: T.muted, width: 36 }}>{i + 1}</td>
                    <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 800, color: T.primary }}>{r.color_name}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(r.units_sold)}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: '#059669' }}>{fmtCr(r.sales_value)}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>₹{fmtNum(r.avg_price)}</td>
                  </tr>
                ))
            }
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '32px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>No results</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: showing X of Y */}
      {!loading && allRows.length > 0 && (
        <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.bg }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{rows.length}</strong> of <strong style={{ color: T.primary }}>{allRows.length}</strong> colours
          </span>
          {pageSize !== 'All' && allRows.length > rows.length && (
            <button onClick={() => setPageSize('All')} style={{ border: `1.5px solid ${T.primary}`, borderRadius: 8, padding: '4px 12px', fontSize: 11, fontWeight: 800, color: T.primary, background: '#fff', cursor: 'pointer', letterSpacing: '0.03em' }}>
              Show All
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Size Breakdown Section ────────────────────────────────────────────────
function SizeBreakdownSection({ data, loading }) {
  const [sort,     setSort]     = useState('units_sold');
  const [pageSize, setPageSize] = useState(30);

  const allRows = useMemo(() => {
    const r = data?.by_size || [];
    if (sort === 'size_asc')  return [...r].sort((a, b) => { const na = parseInt(a.size) || 9999, nb = parseInt(b.size) || 9999; return na - nb || (a.size||'').localeCompare(b.size||''); });
    if (sort === 'size_desc') return [...r].sort((a, b) => { const na = parseInt(a.size) || 9999, nb = parseInt(b.size) || 9999; return nb - na || (b.size||'').localeCompare(a.size||''); });
    return [...r].sort((a, b) => Number(b[sort]) - Number(a[sort]));
  }, [data?.by_size, sort]);

  const rows    = useMemo(() => pageSize === 'All' ? allRows : allRows.slice(0, pageSize), [allRows, pageSize]);
  const maxUnits = allRows[0] ? Number(allRows[0].units_sold) : 1;
  const total    = data?.by_size?.length || 0;

  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <BarChart2 size={13} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Size Breakdown</span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: T.primary, borderRadius: 100, padding: '2px 7px', letterSpacing: '0.04em' }}>
              {total}
            </span>
          )}
        </div>
        {/* Sort */}
        <div style={{ position: 'relative' }}>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...filterSelect, minWidth: 130 }}>
            <option value="units_sold">Sort: Units Sold</option>
            <option value="sales_value">Sort: Revenue</option>
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
            <tr style={{ background: T.bg }}>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>#</th>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Size</th>
              <th style={{ padding: '9px 14px', textAlign: 'left',  fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Distribution</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Units</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}` }}>Revenue</th>
              <th style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1.5px solid ${T.border}`, whiteSpace: 'nowrap' }}>Avg Price</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{ padding: '9px 14px' }}><div style={{ height: 13, background: T.bg, borderRadius: 4 }} /></td></tr>
                ))
              : rows.map((r, i) => {
                  const pct = Math.round((Number(r.units_sold) / maxUnits) * 100);
                  return (
                    <tr key={i}
                      style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? '#fff' : '#fafafe' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f0f4ff'}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafe'}
                    >
                      <td style={{ padding: '9px 14px', fontSize: 11, fontWeight: 700, color: T.muted, width: 36 }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px', fontSize: 15, fontWeight: 900, color: T.primary, width: 70, letterSpacing: '-0.01em' }}>{r.size}</td>
                      <td style={{ padding: '9px 14px', width: 110 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 100, height: 6, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#2563EB,#6366F1)', borderRadius: 100, transition: 'width 0.6s ease' }} />
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: T.muted, minWidth: 28, textAlign: 'right' }}>{pct}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(r.units_sold)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: '#059669' }}>{fmtCr(r.sales_value)}</td>
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
        <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.bg }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{rows.length}</strong> of <strong style={{ color: T.primary }}>{allRows.length}</strong> sizes
          </span>
          {pageSize !== 'All' && allRows.length > rows.length && (
            <button onClick={() => setPageSize('All')} style={{ border: `1.5px solid ${T.primary}`, borderRadius: 8, padding: '4px 12px', fontSize: 11, fontWeight: 800, color: T.primary, background: '#fff', cursor: 'pointer', letterSpacing: '0.03em' }}>
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

function AllStoresTable({ data, loading }) {
  const [search,  setSearch]  = useState('');
  const [city,    setCity]    = useState('');
  const [state,   setState]   = useState('');
  const [channel, setChannel] = useState('');
  const [sortBy,  setSortBy]  = useState('sales_value');
  const [page,    setPage]    = useState(1);

  const allStores = data?.all_stores || [];

  const states   = useMemo(() => [...new Set(allStores.map(r => r.state).filter(Boolean))].sort(),   [allStores]);
  const channels = useMemo(() => [...new Set(allStores.map(r => r.channel).filter(Boolean))].sort(), [allStores]);
  const cities   = useMemo(() => {
    const base = state ? allStores.filter(r => r.state === state) : allStores;
    return [...new Set(base.map(r => r.city).filter(Boolean))].sort();
  }, [allStores, state]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let r = allStores;
    if (q)       r = r.filter(x => x.location_name?.toLowerCase().includes(q) || x.city?.toLowerCase().includes(q) || x.state?.toLowerCase().includes(q));
    if (state)   r = r.filter(x => x.state   === state);
    if (city)    r = r.filter(x => x.city    === city);
    if (channel) r = r.filter(x => x.channel === channel);
    return [...r].sort((a, b) => Number(b[sortBy]) - Number(a[sortBy]));
  }, [allStores, search, state, city, channel, sortBy]);

  // Reset to page 1 whenever filters change
  const resetPage = (fn) => (...args) => { fn(...args); setPage(1); };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE_STORES));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE_STORES, safePage * PAGE_SIZE_STORES);
  const maxRevenue = filtered[0]?.sales_value ? Number(filtered[0].sales_value) : 1;
  const hasFilter  = search || state || city || channel;

  const clearAll = () => { setSearch(''); setState(''); setCity(''); setChannel(''); setPage(1); };

  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>

      {/* ── Filter bar ── */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Store size={13} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 11, fontWeight: 900, color: T.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>All Stores</span>
          {!loading && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: T.primary, borderRadius: 100, padding: '2px 7px' }}>
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
          <select value={sortBy} onChange={e => { setSortBy(e.target.value); setPage(1); }} style={{ ...filterSelect, minWidth: 140 }}>
            <option value="sales_value">Sort: Revenue</option>
            <option value="units_sold">Sort: Units Sold</option>
            <option value="return_qty">Sort: Returns</option>
            <option value="transactions">Sort: Transactions</option>
          </select>
          <ChevronIcon />
        </div>

        {hasFilter && (
          <button onClick={clearAll} style={{ border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 800, color: T.primary, background: '#fff', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              {['#', 'Store Name', 'Channel', 'State', 'City', 'Revenue Bar', 'Revenue', 'Units Sold', 'Returns', 'Txns'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: ['Revenue','Units Sold','Returns','Txns','#'].includes(h) ? 'right' : 'left', fontSize: 10, fontWeight: 900, color: T.primary, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `2px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: PAGE_SIZE_STORES }).map((_, i) => (
                  <tr key={i}><td colSpan={10} style={{ padding: '10px 14px' }}><div style={{ height: 13, background: T.bg, borderRadius: 4 }} /></td></tr>
                ))
              : pageRows.map((r, i) => {
                  const globalIdx = (safePage - 1) * PAGE_SIZE_STORES + i;
                  const revPct    = Math.round((Number(r.sales_value) / maxRevenue) * 100);
                  const isTop3    = globalIdx < 3 && !hasFilter;
                  return (
                    <tr key={r.location_id || globalIdx}
                      style={{ borderBottom: `1px solid ${T.border}`, background: isTop3 ? '#fafaf7' : globalIdx % 2 === 0 ? '#fff' : '#fafafa' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f1f5f9'}
                      onMouseLeave={e => e.currentTarget.style.background = isTop3 ? '#fafaf7' : globalIdx % 2 === 0 ? '#fff' : '#fafafa'}
                    >
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 900, color: T.muted, width: 36 }}>
                        {isTop3 ? ['🥇','🥈','🥉'][globalIdx] : globalIdx + 1}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 800, color: T.primary, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.location_name}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <span style={{ background: '#e2e8f0', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 800, color: T.primary }}>{r.channel || '—'}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.state || '—'}</td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.muted, whiteSpace: 'nowrap' }}>{r.city || '—'}</td>
                      <td style={{ padding: '10px 20px 10px 14px', width: 110 }}>
                        <div style={{ background: '#f1f5f9', borderRadius: 4, height: 5 }}>
                          <div style={{ width: `${revPct}%`, height: '100%', background: 'linear-gradient(90deg,#1D4ED8,#6366F1)', borderRadius: 4 }} />
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 900, color: T.primary, whiteSpace: 'nowrap' }}>{fmtCr(r.sales_value)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>{fmtNum(r.units_sold)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#F43F5E' }}>{fmtNum(r.return_qty)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>{fmtNum(r.transactions)}</td>
                    </tr>
                  );
                })
            }
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={10} style={{ padding: '40px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: T.muted }}>No stores match your filters</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination footer ── */}
      {!loading && filtered.length > 0 && (
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.bg, flexWrap: 'wrap', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{(safePage - 1) * PAGE_SIZE_STORES + 1}–{Math.min(safePage * PAGE_SIZE_STORES, filtered.length)}</strong> of <strong style={{ color: T.primary }}>{filtered.length}</strong> stores
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setPage(1)} disabled={safePage === 1}
              style={{ border: `1.5px solid ${T.border}`, borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: '#fff', cursor: safePage === 1 ? 'default' : 'pointer' }}>«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
              style={{ border: `1.5px solid ${T.border}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 800, color: safePage === 1 ? T.border : T.primary, background: '#fff', cursor: safePage === 1 ? 'default' : 'pointer' }}>‹ Prev</button>
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
                    style={{ border: `1.5px solid ${p === safePage ? T.primary : T.border}`, borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: p === safePage ? 900 : 700, color: p === safePage ? '#fff' : T.primary, background: p === safePage ? T.primary : '#fff', cursor: 'pointer', minWidth: 30 }}>{p}</button>
              )
            }
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

export default function SalesAnalyticsPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [dateFrom, setDateFrom]     = useState('2025-01-01');
  const [dateTo, setDateTo]         = useState('2026-01-31');
  const [colorName, setColorName]   = useState('');
  const [size, setSize]             = useState('');
  const [locationId, setLocationId] = useState('');

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await analyticsService.getSalesAnalytics({
        date_from:   dateFrom    || undefined,
        date_to:     dateTo      || undefined,
        color_name:  colorName   || undefined,
        size:        size        || undefined,
        location_id: locationId  || undefined,
      });
      setData(res.data.data);
    } catch { toast.error('Failed to load sales analytics'); }
    finally  { setLoading(false); }
  }, [dateFrom, dateTo, colorName, size, locationId]);

  useEffect(() => { fetch(); }, [fetch]);

  const s   = data?.summary || {};
  const ss  = data?.stock_snapshot || {};
  const opts = data?.filter_options || { colors: [], sizes: [], stores: [] };

  // ── Daily chart — premium 3-series with dedicated Y-axes ─────────────────
  const dailyChartData = useMemo(() => {
    const rows = data?.daily || [];
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
        grid: { borderColor: '#f1f5f9', strokeDashArray: 4, xaxis: { lines: { show: false } } },
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
  }, [data?.daily]);

  // ── Monthly bar+line combo chart (bar=sales, line=returns on dual axis) ──
  const monthlyChartData = useMemo(() => {
    const rows = data?.by_month || [];
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
        grid: { borderColor: '#f1f5f9', strokeDashArray: 4 },
        legend: { fontWeight: 700, fontSize: '12px', labels: { colors: T.primary } },
        tooltip: { shared: true, intersect: false, style: { fontSize: '12px', fontWeight: 700 } },
      },
      series: [
        { name: 'Units Sold',     type: 'bar',  data: rows.map(r => Number(r.sales_qty)) },
        { name: 'Units Returned', type: 'line', data: rows.map(r => Number(r.return_qty)) },
      ],
    };
  }, [data?.by_month]);

  // ── Colour chart ─────────────────────────────────────────────────────────
  // ── Revenue monthly area ─────────────────────────────────────────────────
  const revenueChartData = useMemo(() => {
    const rows = data?.by_month || [];
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
        grid: { borderColor: '#f1f5f9', strokeDashArray: 4 },
        tooltip: { style: { fontSize: '12px', fontWeight: 700 }, y: { formatter: v => fmtCr(v) } },
      },
      series: [{ name: 'Monthly Revenue', data: rows.map(r => Number(r.sales_value)) }],
    };
  }, [data?.by_month]);

  const hasFilters = colorName || size || locationId || dateFrom !== '2025-01-01' || dateTo !== '2026-01-31';

  return (
    <DashboardLayout title="Sales & Returns Analytics" subtitle="Day-basis sales intelligence — units, revenue, colour, size, store">

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <div style={{
        background: '#fff', border: `1px solid ${T.border}`, borderRadius: 14,
        padding: '14px 20px', marginBottom: 24,
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Filter size={14} color={T.primary} strokeWidth={2.5} />
          <span style={{ fontSize: 12, fontWeight: 800, color: T.primary, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Filters</span>
        </div>

        {/* Date range */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Calendar size={13} color={T.muted} />
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '7px 11px', fontSize: 13, fontWeight: 700, color: T.primary, outline: 'none', background: '#fff' }} />
          <span style={{ fontWeight: 800, color: T.muted, fontSize: 13 }}>→</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '7px 11px', fontSize: 13, fontWeight: 700, color: T.primary, outline: 'none', background: '#fff' }} />
        </div>

        {hasFilters && (
          <button onClick={() => { setColorName(''); setSize(''); setLocationId(''); setDateFrom('2025-01-01'); setDateTo('2026-01-31'); }}
            style={{ border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 800, color: T.primary, background: '#fff', cursor: 'pointer', letterSpacing: '0.03em' }}>
            Clear
          </button>
        )}

        <button onClick={fetch}
          style={{ marginLeft: 'auto', border: `1.5px solid ${T.border}`, borderRadius: 8, padding: '7px 11px', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
          <RefreshCw size={13} color={T.primary} strokeWidth={2.5} />
        </button>

        {/* Data window notice */}
        <span style={{ fontSize: 11, fontWeight: 700, color: T.muted, borderLeft: `2px solid ${T.border}`, paddingLeft: 12 }}>
          ERP data: Apr 2024 – Jan 2026 · Stock: 1 Feb 2026
        </span>
      </div>

      {/* ── KPI Cards — Row 1: Sales ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        <KpiCard icon={ShoppingBag} label="Sales Transactions" accent="#2563EB"
          value={loading ? '…' : fmtL(s.sales_txns)}
          sub={loading ? '' : `${fmtNum(s.active_days)} active days · ${fmtNum(s.stores_with_sales)} stores`}
          sub2={loading ? '' : `Avg ${fmtL(s.sales_txns && s.active_days ? Math.round(s.sales_txns / s.active_days) : 0)} txns/day`}
          loading={loading} />
        <KpiCard icon={TrendingUp} label="Units Sold" accent="#4F46E5"
          value={loading ? '…' : fmtL(s.units_sold)}
          sub={loading ? '' : `Net ${fmtL(s.net_units)} after returns`}
          sub2={loading ? '' : `${fmtL(s.unique_skus_sold)} unique SKUs moved`}
          loading={loading} />
        <KpiCard icon={Zap} label="Net Revenue" accent="#059669"
          value={loading ? '…' : fmtCr(s.net_value)}
          sub={loading ? '' : `Gross ${fmtCr(s.sales_value)}`}
          sub2={loading ? '' : `Avg ₹${fmtNum(s.avg_price)} per unit`}
          loading={loading} />
      </div>

      {/* ── KPI Cards — Row 2: Returns + Stock ───────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
        <KpiCard icon={RotateCcw} label="Returns" accent="#F43F5E"
          value={loading ? '…' : fmtL(s.return_units)}
          sub={loading ? '' : `${fmtL(s.return_txns)} transactions · ${fmtCr(s.return_value)}`}
          sub2={loading ? '' : `${s.return_rate_pct ?? 0}% return rate vs units sold`}
          loading={loading} />
        <KpiCard icon={Package} label="Stock on 1 Feb 2026" accent="#C0392B"
          value={loading ? '…' : fmtL(ss.total_units)}
          sub={loading ? '' : `MRP value: ${fmtCr(ss.total_mrp_value)}`}
          sub2={loading ? '' : `${fmtNum(ss.locations)} locations · ${fmtL(ss.unique_skus)} SKUs`}
          loading={loading} />
        <KpiCard icon={Award} label="Best Day" accent="#D97706"
          value={loading || !data?.daily?.length ? '—' : (() => {
            const best = [...(data.daily)].sort((a, b) => Number(b.sales_qty) - Number(a.sales_qty))[0];
            return best ? fmtL(best.sales_qty) : '—';
          })()}
          sub={loading || !data?.daily?.length ? '' : (() => {
            const best = [...(data.daily)].sort((a, b) => Number(b.sales_qty) - Number(a.sales_qty))[0];
            return best ? new Date(best.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
          })()}
          sub2={loading || !data?.daily?.length ? '' : (() => {
            const best = [...(data.daily)].sort((a, b) => Number(b.sales_value) - Number(a.sales_value))[0];
            return best ? `Peak revenue: ${fmtCr(best.sales_value)}` : '';
          })()}
          loading={loading} />
      </div>

      {/* ── Chart 1: Daily Sales Trend (full width) ───────────────────────── */}
      <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, padding: '22px 24px', marginBottom: 20 }}>
        <SectionTitle icon={Activity} label="Daily Sales Trend — Units · Revenue · Returns" />
        {loading
          ? <div style={{ height: 320, background: T.bg, borderRadius: 10 }} />
          : data?.daily?.length
            ? <Chart options={dailyChartData.options} series={dailyChartData.series} type="area" height={320} />
            : <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontWeight: 700 }}>No data for selected filters</div>
        }
      </div>

      {/* ── Charts Row: Monthly bars + Monthly revenue ────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, padding: '22px 24px' }}>
          <SectionTitle icon={BarChart2} label="Monthly — Sales vs Returns (Units)" />
          {loading
            ? <div style={{ height: 260, background: T.bg, borderRadius: 10 }} />
            : <Chart options={monthlyChartData.options} series={monthlyChartData.series} type="bar" height={260} />
          }
        </div>
        <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16, padding: '22px 24px' }}>
          <SectionTitle icon={TrendingUp} label="Monthly Revenue (₹)" />
          {loading
            ? <div style={{ height: 260, background: T.bg, borderRadius: 10 }} />
            : <Chart options={revenueChartData.options} series={revenueChartData.series} type="area" height={260} />
          }
        </div>
      </div>

      {/* ── Colour + Size sections with dedicated filters ─────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <ColourBreakdownSection data={data} loading={loading} />
        <SizeBreakdownSection data={data} loading={loading} />
      </div>

      {/* ── All Stores Full Table with city / channel / sort filters ──────── */}
      <AllStoresTable data={data} loading={loading} />

    </DashboardLayout>
  );
}

SalesAnalyticsPage.getLayout = (page) => page;
