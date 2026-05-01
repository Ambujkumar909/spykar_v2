// ─── SkuPerformance — per-SKU drill-down for the Sales & Returns page ─────────
// Answers the questions every CFO/CPO actually has at the SKU level:
//   • Which SKU is my best seller? Worst seller?
//   • What's the velocity (units/day) of a specific SKU?
//   • How many stores carry it? When was its last sale?
//   • What's the revenue if I look at it Ex-GST / At MRP / Discount?
//
// Anatomy:
//   • Search by SKU code or product name (instant filter, debounced)
//   • Mode pill: Top Sellers (head) / Slow Movers (tail by velocity)
//   • Sort: Revenue / Units / Velocity / Returns
//   • Limit: 20 / 50 / 100 / 200
//   • Click a row to drill into the SKU detail drawer (TODO: V2)
//
// Lens-aware: every ₹ figure flips when the parent's `valuation` prop
// changes, just like the rest of the page.

import { useMemo, useState } from 'react';

const T = {
  primary: '#0B1220',                  // sx-ink
  muted:   '#475569',                  // sx-ink-muted
  border:  'rgba(15, 23, 42, 0.06)',   // sx-border (hairline)
  bg:      '#F7F8FB',                  // sx-canvas
  card:    '#FFFFFF',
  accent:  '#0B1220',
  velocity:'#0284C7',
  win:     '#059669',
  loss:    '#B91C1C',
};

// Match the parent page's currency formatter so figures render consistently.
function fmtCr(n) {
  const v = Number(n || 0);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)} Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(2)} L`;
  if (v >= 1000)       return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-IN'); }
function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  } catch { return '—'; }
}
function daysSince(s) {
  if (!s) return null;
  const d = new Date(s);
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

// Lens-aware revenue picker. Mirrors the same switch the parent uses so
// charts/tables and this section show the same ₹ regardless of valuation.
function pickValue(row, valuation) {
  switch (valuation) {
    case 'ex_gst':   return Number(row?.ex_gst_value || 0);
    case 'gst':      return Number(row?.gst_collected || 0);
    case 'mrp':      return Number(row?.mrp_value || 0);
    case 'discount': return Math.max(0, Number(row?.mrp_value || 0) - Number(row?.sales_value || 0));
    case 'gross':
    default:         return Number(row?.sales_value || 0);
  }
}
const VALUATION_LABEL = {
  gross:    'Revenue',
  ex_gst:   'Ex-GST',
  gst:      'GST',
  mrp:      'MRP',
  discount: 'Discount',
};

export default function SkuPerformance({ data, loading, valuation = 'gross', onSkuClick }) {
  // Backend ships TWO lists from a single mega-CTE pass:
  //   • by_sku       — top 200 by sales_value DESC (best sellers)
  //   • by_sku_slow  — bottom 200 by sales_value ASC (slow movers from full
  //                    universe of ~48K SKUs in the filter window)
  // Plus sku_universe = total SKU count with ≥1 sale/return in the window.
  const topRows  = data?.by_sku       || [];
  const slowRows = data?.by_sku_slow  || [];
  const universe = Number(data?.sku_universe || 0);

  const [search, setSearch] = useState('');
  const [mode,   setMode]   = useState('top');     // 'top' | 'slow'
  const [sort,   setSort]   = useState('revenue'); // 'revenue' | 'units' | 'velocity' | 'returns'
  const [limit,  setLimit]  = useState(20);

  // Filter + sort — pulls from the correct list based on mode so "Slow Movers"
  // really shows the slowest of the universe, not the slowest of top 200.
  const ranked = useMemo(() => {
    const sourceRows = mode === 'slow' ? slowRows : topRows;
    const q = search.trim().toLowerCase();
    let pool = q
      ? sourceRows.filter(r =>
          String(r.sku_code || '').toLowerCase().includes(q) ||
          String(r.product_name || '').toLowerCase().includes(q) ||
          String(r.color_name || '').toLowerCase().includes(q))
      : sourceRows.slice();

    // Velocity = units / days_sold. Avoids divide-by-zero on first-day SKUs.
    const velocity = (r) => {
      const d = Number(r.days_sold || 0);
      return d > 0 ? Number(r.units_sold || 0) / d : Number(r.units_sold || 0);
    };

    const score = (r) => {
      switch (sort) {
        case 'units':    return Number(r.units_sold || 0);
        case 'velocity': return velocity(r);
        case 'returns':  return Number(r.return_qty || 0);
        case 'revenue':
        default:         return pickValue(r, valuation);
      }
    };

    // Top mode → sort DESC (highest first). Slow mode → sort ASC (lowest first).
    pool.sort((a, b) => mode === 'top' ? score(b) - score(a) : score(a) - score(b));
    return pool.slice(0, limit).map(r => ({
      ...r,
      _value:    pickValue(r, valuation),
      _velocity: velocity(r),
    }));
  }, [topRows, slowRows, search, mode, sort, limit, valuation]);

  // Total count for the footer — depends on whether we're showing top or slow
  const totalAvailable = mode === 'slow' ? slowRows.length : topRows.length;
  const universeLabel  = universe > 0 ? universe.toLocaleString('en-IN') : '—';

  // Detect stale-shape cache: data exists but the field for the current mode
  // is missing (older response from before by_sku_slow shipped). In that case
  // the background refetch is in flight; treat it as loading so the user sees
  // a skeleton instead of an "empty state" flash.
  const staleShape = !!data && (
    (mode === 'slow' && !Array.isArray(data.by_sku_slow)) ||
    (mode === 'top'  && !Array.isArray(data.by_sku))
  );
  const showSkeleton = (loading || staleShape) && ranked.length === 0;

  // Reference for the inline bars = LENS-AWARE TOTAL revenue across the
  // whole filtered universe, NOT the top row's value. This way each bar
  // reads as "share of total" — a Pareto/concentration view a CFO can
  // act on (top SKU drives 0.4% of total etc.). Falls back to the sum of
  // displayed rows if summary isn't on the response.
  const totalValue = useMemo(() => {
    const s = data?.summary || {};
    const fromSummary = pickValue({
      sales_value:    s.sales_value,
      ex_gst_value:   s.sales_ex_gst_value,
      gst_collected:  s.sales_gst_collected,
      mrp_value:      s.sales_mrp_value,
    }, valuation);
    if (fromSummary > 0) return fromSummary;
    // fallback: sum of currently displayed pool
    return Math.max(1, ranked.reduce((a, r) => a + Math.abs(r._value), 0));
  }, [data?.summary, valuation, ranked]);

  const valLabel = VALUATION_LABEL[valuation] || 'Revenue';

  return (
    <div className="sx-card" style={{ padding: '24px 26px', marginBottom: 20 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: `${T.accent}14`, color: T.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 4.5L8 1l6 3.5M2 4.5L8 8m-6-3.5v7L8 15m6-10.5L8 8m6-3.5v7L8 15M8 8v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: T.muted, letterSpacing: '0.07em', textTransform: 'uppercase' }}>SKU Performance</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.primary }}>
            {mode === 'top' ? 'Best sellers' : 'Slow movers'} — by {sort === 'revenue' ? valLabel : sort === 'velocity' ? 'units/day' : sort}
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Search by SKU code or product name */}
        <div style={{ position: 'relative' }}>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: T.muted,
          }}><circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3" fill="none"/><path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${totalAvailable} SKUs…`}
            style={{
              width: 220, height: 32,
              padding: '0 12px 0 28px',
              fontSize: 12, fontWeight: 600,
              background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 8, outline: 'none', color: T.primary,
            }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e => e.currentTarget.style.borderColor = T.border}
          />
        </div>

        {/* Mode pill (Top / Slow) */}
        <ModePill value={mode} onChange={setMode} />

        {/* Sort + Limit */}
        <SelectChip value={sort} onChange={setSort}
          options={[
            { value: 'revenue',  label: `Sort: ${valLabel}` },
            { value: 'units',    label: 'Sort: Units' },
            { value: 'velocity', label: 'Sort: Velocity' },
            { value: 'returns',  label: 'Sort: Returns' },
          ]} />
        <SelectChip value={String(limit)} onChange={v => setLimit(Number(v))}
          options={[20, 50, 100, 200].map(n => ({ value: String(n), label: `Top ${n}` }))} />
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: `1px solid ${T.border}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-body)' }}>
          <thead style={{ background: T.bg }}>
            <tr>
              {['#', 'SKU', 'Product', 'Variant', 'Units', valLabel, 'Velocity', 'Stores', 'Returns', 'Last sold'].map(h => (
                <th key={h} style={{
                  padding: '10px 14px',
                  textAlign: ['Units', valLabel, 'Velocity', 'Stores', 'Returns', '#'].includes(h) ? 'right' : 'left',
                  fontSize: 10, fontWeight: 900, color: T.primary,
                  letterSpacing: '0.07em', textTransform: 'uppercase',
                  borderBottom: `2px solid ${T.border}`, whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Skeleton on cold load OR when the cached response is missing
                the field for the current mode (stale shape during a v-bump
                refetch). Otherwise prior rows stay visible. */}
            {showSkeleton
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={10} style={{ padding: '10px 14px' }}>
                      <div style={{ height: 14, background: T.bg, borderRadius: 4 }} />
                    </td>
                  </tr>
                ))
              : ranked.map((r, i) => {
                  // Bar fill = this SKU's share of TOTAL revenue (capped at
                  // 100% for safety). Tells the user "this SKU drives X% of
                  // total sales" — Pareto/concentration lens.
                  const valPct  = Math.min(100, Math.round((Math.abs(r._value) / totalValue) * 1000) / 10);
                  const isPodium = mode === 'top' && i < 3;
                  const returnPct = Number(r.units_sold) > 0
                    ? (Number(r.return_qty || 0) / Number(r.units_sold)) * 100 : 0;
                  return (
                    <tr key={r.sku_id || r.sku_code}
                      onClick={() => onSkuClick?.(r.sku_id)}
                      title={onSkuClick ? `View SKU drilldown — ${r.product_name || r.sku_code}` : undefined}
                      style={{
                        borderBottom: `1px solid ${T.border}`,
                        background: i % 2 === 0 ? T.card : T.bg,
                        transition: 'background 120ms',
                        cursor: onSkuClick ? 'pointer' : 'default',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f0f4ff'}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? T.card : T.bg}
                    >
                      <td style={{ padding: '10px 14px', fontSize: 11, fontWeight: 800, color: isPodium ? T.accent : T.muted, width: 40 }}>
                        {isPodium ? ['🥇','🥈','🥉'][i] : i + 1}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: T.primary, fontFamily: 'monospace' }}>
                        {r.sku_code}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12.5, fontWeight: 700, color: T.primary, maxWidth: 280 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.product_name || '—'}
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 11.5, color: T.muted }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <ColorChip code={r.color_code || r.color_name} />
                          <span style={{ fontWeight: 600 }}>{r.color_name || '—'}</span>
                          <span style={{ color: T.border }}>•</span>
                          <span style={{ fontWeight: 700, color: T.primary }}>{r.size || '—'}</span>
                          {r.fit_type && (
                            <>
                              <span style={{ color: T.border }}>•</span>
                              <span style={{ fontWeight: 600 }}>{r.fit_type}</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.primary }}>
                        {fmtNum(r.units_sold)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 800, color: T.win, minWidth: 150 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          {/* Bar = share of total revenue (Pareto lens). Width
                              is the actual % so the user sees concentration
                              at a glance — top SKU might be 0.4%, dead SKU
                              <0.01%. */}
                          <div title={`${valPct}% of total ${valLabel.toLowerCase()}`}
                            style={{ flex: 1, maxWidth: 60, height: 4, background: T.bg, borderRadius: 99, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(1, valPct)}%`, height: '100%', background: 'linear-gradient(90deg,#10B981,#059669)' }} />
                          </div>
                          <span>{fmtCr(r._value)}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: T.muted, minWidth: 32, textAlign: 'right' }}>
                            {valPct < 0.1 ? '<0.1%' : `${valPct.toFixed(1)}%`}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.velocity }}>
                        {r._velocity > 0 ? `${r._velocity.toFixed(1)}/day` : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.muted }}>
                        {fmtNum(r.stores_count)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11.5, fontWeight: 700,
                        color: returnPct >= 5 ? T.loss : T.muted }}>
                        {fmtNum(r.return_qty)}
                        {returnPct >= 1 && <span style={{ fontSize: 10, marginLeft: 4 }}>({returnPct.toFixed(1)}%)</span>}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 11.5, color: T.muted, fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {fmtDate(r.last_sold_at)}
                        {r.last_sold_at && (() => {
                          const d = daysSince(r.last_sold_at);
                          return d !== null && d > 30
                            ? <div style={{ fontSize: 10, color: T.loss, fontWeight: 700 }}>{d}d ago</div>
                            : null;
                        })()}
                      </td>
                    </tr>
                  );
                })
            }
            {!showSkeleton && !loading && ranked.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: '32px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: T.muted }}>
                  {search ? `No SKUs matching "${search}"` : 'No SKU data for the selected filters'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer with summary */}
      {!loading && ranked.length > 0 && (
        <div style={{
          marginTop: 12, paddingTop: 12,
          borderTop: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 8,
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Showing <strong style={{ color: T.primary }}>{ranked.length}</strong> of <strong style={{ color: T.primary }}>{totalAvailable}</strong> {mode === 'slow' ? 'slowest' : 'top'} SKUs · universe <strong style={{ color: T.primary }}>{universeLabel}</strong>
            {search && <> · matching <strong style={{ color: T.primary }}>"{search}"</strong></>}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
            Top SKU revenue total: <strong style={{ color: T.win }}>
              {fmtCr(ranked.reduce((s, r) => s + r._value, 0))}
            </strong>
          </span>
        </div>
      )}
    </div>
  );
}

// Tiny accent pill toggle — Top/Slow
function ModePill({ value, onChange }) {
  const opts = [
    { key: 'top',  label: 'Top sellers' },
    { key: 'slow', label: 'Slow movers' },
  ];
  return (
    <div style={{
      display: 'inline-flex', position: 'relative',
      background: T.bg, border: `1px solid ${T.border}`,
      borderRadius: 99, padding: 3, height: 32,
    }}>
      <span style={{
        position: 'absolute', top: 3, bottom: 3,
        left: value === 'top' ? 3 : 'calc(50% + 0px)',
        width: 'calc(50% - 3px)',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 99,
        boxShadow: '0 1px 4px rgba(15,23,42,0.10)',
        transition: 'left 220ms cubic-bezier(0.16,1,0.3,1)',
      }} />
      {opts.map(o => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)}
          style={{
            position: 'relative', zIndex: 1,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0 12px',
            fontSize: 11.5, fontWeight: 700, letterSpacing: '0.02em',
            color: value === o.key ? T.primary : T.muted,
            transition: 'color 200ms',
          }}>{o.label}</button>
      ))}
    </div>
  );
}

// Reusable select chip — same look as ModePill but a real <select>.
function SelectChip({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        height: 32, padding: '0 28px 0 12px',
        background: T.bg, border: `1px solid ${T.border}`,
        borderRadius: 99,
        fontSize: 11.5, fontWeight: 700, letterSpacing: '0.02em',
        color: T.primary, cursor: 'pointer', appearance: 'none',
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%2364748b' stroke-width='1.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
      }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// Tiny color swatch — derives a stable hash colour from a code so the user
// has at-a-glance visual recognition of variants without a real palette
// lookup. Falls back to grey for unknown values.
function ColorChip({ code }) {
  const hue = useMemo(() => {
    if (!code) return 0;
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
    return h % 360;
  }, [code]);
  return (
    <span style={{
      width: 10, height: 10, borderRadius: '50%',
      background: code ? `hsl(${hue}, 55%, 55%)` : '#cbd5e1',
      border: `1px solid ${T.border}`,
      flexShrink: 0,
    }} />
  );
}
