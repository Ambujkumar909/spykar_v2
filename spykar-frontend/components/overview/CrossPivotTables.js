// ─── CrossPivotTables.js ───────────────────────────────────────────────
// Three CXO-grade tables that join sales (movement) and network
// (inventory snapshot) data — answering questions that previously
// required cross-referencing two separate pages by hand.
//
//   1. Top Sellers ↔ Stock Position
//        Best-seller SKUs + where the stock is, OOS counts, top 5
//        stores carrying it. Click a row → DrilldownDrawer with the
//        full SKU-by-store breakdown.
//
//   2. Top Stores ↔ Performance
//        Top 50 stores by net revenue + their stock-on-hand position,
//        return rate, channel, geography. Click a row → drill into
//        the store's SKU mix.
//
//   3. OOS at Busy Stores
//        Best-seller SKUs that are 0-stock at high-revenue stores —
//        immediate transfer-action candidates with potential ₹ unlocked.
//
// All three:
//   • Mode + filter aware (drives off /analytics/overview/cross-pivot)
//   • Race-guarded (stale responses dropped, latest mode wins)
//   • Server-cached 5 min, frontend localStorage cached per filter hash
//   • Lens-aware ₹ display (Sale / Return / Net × valuation matrix)
//   • Sortable columns, click-row drill-down via existing DrilldownDrawer
//   • sx-* premium tokens for visual consistency with rest of Overview
import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Package, Store, AlertTriangle, ChevronRight, TrendingUp, TrendingDown, ArrowUpDown } from 'lucide-react';

// Indian-format helpers (already present elsewhere — local copy avoids
// cross-page import drift, keeps this file self-contained as requested).
const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (Math.abs(v) >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + ' K';
  return v.toLocaleString('en-IN');
};
const fmtIndianFull = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtRupee = (n) => '₹' + fmtNum(n);

// Column-header sort affordance
function SortHeader({ label, active, dir, onClick, align = 'left' }) {
  return (
    <th
      onClick={onClick}
      style={{
        textAlign: align,
        padding: '12px 14px',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: active ? '#0B1220' : '#64748B',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        background: 'linear-gradient(180deg, rgba(248,250,252,0.95) 0%, rgba(241,245,249,0.95) 100%)',
        borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
        position: 'sticky', top: 0, zIndex: 1,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <ArrowUpDown size={11} opacity={active ? 0.75 : 0.3}
          style={{
            transform: active && dir === 'asc' ? 'rotate(180deg)' : 'none',
            transition: 'transform 200ms cubic-bezier(0.16,1,0.3,1)',
          }} />
      </span>
    </th>
  );
}

// Mini horizontal bar — cell-level intensity indicator
function MiniBar({ value, max, color = '#2563EB' }) {
  const pct = max > 0 ? Math.min(100, (Number(value) / max) * 100) : 0;
  return (
    <div style={{
      width: 64, height: 5, borderRadius: 999,
      background: '#F1F5F9', overflow: 'hidden',
      display: 'inline-block', verticalAlign: 'middle', marginRight: 8,
    }}>
      <div style={{
        height: '100%', width: pct + '%',
        background: color, borderRadius: 999,
        transition: 'width 320ms cubic-bezier(0.16,1,0.3,1)',
      }} />
    </div>
  );
}

// Pill — small status / channel chip
function Pill({ children, color = '#0B1220', bg = '#F1F5F9' }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      borderRadius: 999, fontSize: 10, fontWeight: 700,
      letterSpacing: '0.04em', color, background: bg,
      border: `1px solid ${color}1A`,
    }}>{children}</span>
  );
}

// ── Reusable lens picker on top of /analytics/sales–style summary ──
const pickRev = (row, lens, valuation) => {
  // row uses the column names from the cross-pivot endpoint:
  // sales_value, return_value, net_value
  const sv = Number(row?.sales_value || 0);
  const rv = Number(row?.return_value || 0);
  const base = lens === 'sale' ? sv : lens === 'return' ? rv : (sv - rv);
  // Only gross is exposed by the cross-pivot for compactness; other
  // valuations require the full /analytics/sales payload to be lens-
  // computed. Default to gross at this granularity.
  return base;
};

// ── Top Sellers ↔ Stock Position table ─────────────────────────────
function TopSellersStockTable({ rows, loading, onSkuClick, lensMode = 'net' }) {
  const [sortBy, setSortBy] = useState('net_value');
  const [sortDir, setSortDir] = useState('desc');
  const sorted = useMemo(() => {
    const arr = [...(rows || [])];
    arr.sort((a, b) => {
      const va = sortBy === 'net_value'
        ? pickRev(a, lensMode)
        : Number(a[sortBy] || 0);
      const vb = sortBy === 'net_value'
        ? pickRev(b, lensMode)
        : Number(b[sortBy] || 0);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
    return arr;
  }, [rows, sortBy, sortDir, lensMode]);

  const onSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const maxRev   = Math.max(...sorted.map(r => pickRev(r, lensMode)), 1);
  const maxStock = Math.max(...sorted.map(r => Number(r.total_stock || 0)), 1);

  return (
    <div className="card sx-table-wrap" style={{ marginBottom: 24 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Package size={15} strokeWidth={2} color="#7C3AED" />
          <span className="card-title">Best Sellers ↔ Stock Position</span>
          <Pill color="#7C3AED" bg="rgba(124, 58, 237, 0.08)">
            {sorted.length} SKUs
          </Pill>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
          where is the stock for our top sellers?
        </span>
      </div>
      <div style={{ maxHeight: 540, overflow: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'separate', borderSpacing: 0,
          fontFamily: 'var(--font-body)', fontSize: 12,
        }}>
          <thead>
            <tr>
              <SortHeader label="SKU"             active={sortBy === 'sku_code'}        dir={sortDir} onClick={() => onSort('sku_code')} />
              <SortHeader label="Product"         active={false} dir={sortDir} onClick={() => {}} />
              <SortHeader label="Net Revenue"     active={sortBy === 'net_value'}       dir={sortDir} onClick={() => onSort('net_value')}     align="right" />
              <SortHeader label="Net Units"       active={sortBy === 'net_units'}       dir={sortDir} onClick={() => onSort('net_units')}     align="right" />
              <SortHeader label="Return %"        active={sortBy === 'return_rate_pct'} dir={sortDir} onClick={() => onSort('return_rate_pct')} align="right" />
              <SortHeader label="Stock"           active={sortBy === 'total_stock'}     dir={sortDir} onClick={() => onSort('total_stock')}   align="right" />
              <SortHeader label="In # Stores"     active={sortBy === 'stores_carrying'} dir={sortDir} onClick={() => onSort('stores_carrying')} align="right" />
              <SortHeader label="OOS @ # Stores"  active={sortBy === 'stores_oos'}      dir={sortDir} onClick={() => onSort('stores_oos')}    align="right" />
              <SortHeader label="Top Stores"      active={false} dir={sortDir} onClick={() => {}} />
              <th style={{ background: 'linear-gradient(180deg, rgba(248,250,252,0.95) 0%, rgba(241,245,249,0.95) 100%)', borderBottom: '1px solid rgba(15, 23, 42, 0.08)', position: 'sticky', top: 0, width: 24 }} />
            </tr>
          </thead>
          <tbody>
            {loading && !sorted.length ? (
              [...Array(8)].map((_, i) => (
                <tr key={i}>
                  <td colSpan={10} style={{ padding: 0 }}>
                    <div className="sx-shimmer" style={{ height: 38, borderRadius: 0 }} />
                  </td>
                </tr>
              ))
            ) : !sorted.length ? (
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                No data for this filter combination
              </td></tr>
            ) : sorted.map((r, i) => {
              const rev = pickRev(r, lensMode);
              const oos = Number(r.stores_oos || 0);
              const carry = Number(r.stores_carrying || 0);
              return (
                <tr key={r.sku_id || i}
                    onClick={() => onSkuClick && onSkuClick({ id: r.sku_id, name: r.sku_code, product: r.product_name })}
                    style={{
                      cursor: onSkuClick ? 'pointer' : 'default',
                      transition: 'background-color 140ms',
                    }}
                    onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(37, 99, 235, 0.04)'}
                    onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', fontWeight: 700, color: '#0B1220' }}>
                    {r.sku_code}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                      {r.color_name} · {r.size}
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.product_name}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <MiniBar value={rev} max={maxRev} color="#059669" />
                    <span style={{ fontWeight: 700 }} title={`Exact: ₹${fmtIndianFull(Math.round(rev))}`}>
                      {fmtRupee(rev)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {fmtNum(r.net_units)}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{
                      color: Number(r.return_rate_pct) >= 5 ? '#DC2626' : Number(r.return_rate_pct) >= 3 ? '#D97706' : '#059669',
                      fontWeight: 700,
                    }}>
                      {Number(r.return_rate_pct || 0).toFixed(1)}%
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <MiniBar value={r.total_stock} max={maxStock} color="#7C3AED" />
                    <span style={{ fontWeight: 600 }} title={`Exact: ${fmtIndianFull(r.total_stock)}`}>
                      {fmtNum(r.total_stock)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {carry}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {oos > 0 ? (
                      <Pill color="#DC2626" bg="rgba(220, 38, 38, 0.08)">{oos} OOS</Pill>
                    ) : (
                      <span style={{ color: '#059669', fontWeight: 600 }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(r.top_5_stores || []).slice(0, 3).map((s, j) => (
                      <span key={j} style={{
                        display: 'inline-block', marginRight: 6,
                        padding: '1px 6px', borderRadius: 4,
                        background: 'rgba(37, 99, 235, 0.06)',
                        border: '1px solid rgba(37, 99, 235, 0.12)',
                        color: '#1E40AF', fontSize: 10, fontWeight: 600,
                      }} title={`${s.location_name} · ${fmtIndianFull(s.qty_on_hand)} units`}>
                        {String(s.location_name || '').slice(0, 18)} ({s.qty_on_hand})
                      </span>
                    ))}
                  </td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right' }}>
                    <ChevronRight size={14} color="#94A3B8" strokeWidth={2.5} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Top Stores ↔ Performance table ─────────────────────────────────
function TopStoresPerformanceTable({ rows, loading, onStoreClick, lensMode = 'net' }) {
  const [sortBy, setSortBy] = useState('net_value');
  const [sortDir, setSortDir] = useState('desc');
  const sorted = useMemo(() => {
    const arr = [...(rows || [])];
    arr.sort((a, b) => {
      const va = sortBy === 'net_value' ? pickRev(a, lensMode) : Number(a[sortBy] || 0);
      const vb = sortBy === 'net_value' ? pickRev(b, lensMode) : Number(b[sortBy] || 0);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
    return arr;
  }, [rows, sortBy, sortDir, lensMode]);
  const onSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };
  const maxRev   = Math.max(...sorted.map(r => pickRev(r, lensMode)), 1);
  const maxStock = Math.max(...sorted.map(r => Number(r.stock_on_hand || 0)), 1);

  return (
    <div className="card sx-table-wrap" style={{ marginBottom: 24 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Store size={15} strokeWidth={2} color="#0284C7" />
          <span className="card-title">Top Stores ↔ Performance</span>
          <Pill color="#0284C7" bg="rgba(2, 132, 199, 0.08)">
            {sorted.length} stores
          </Pill>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
          revenue rank + stock parked at each location
        </span>
      </div>
      <div style={{ maxHeight: 540, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'var(--font-body)', fontSize: 12 }}>
          <thead>
            <tr>
              <SortHeader label="#" align="center" active={false} dir={sortDir} onClick={() => {}} />
              <SortHeader label="Store"        active={sortBy === 'location_name'} dir={sortDir} onClick={() => onSort('location_name')} />
              <SortHeader label="Channel"      active={false} dir={sortDir} onClick={() => {}} />
              <SortHeader label="City · State" active={false} dir={sortDir} onClick={() => {}} />
              <SortHeader label="Net Revenue"  active={sortBy === 'net_value'}    dir={sortDir} onClick={() => onSort('net_value')}     align="right" />
              <SortHeader label="Net Units"    active={sortBy === 'units_sold'}   dir={sortDir} onClick={() => onSort('units_sold')}    align="right" />
              <SortHeader label="Return %"     active={sortBy === 'return_rate_pct'} dir={sortDir} onClick={() => onSort('return_rate_pct')} align="right" />
              <SortHeader label="Stock OnHand" active={sortBy === 'stock_on_hand'} dir={sortDir} onClick={() => onSort('stock_on_hand')} align="right" />
              <th style={{ background: 'linear-gradient(180deg, rgba(248,250,252,0.95) 0%, rgba(241,245,249,0.95) 100%)', borderBottom: '1px solid rgba(15, 23, 42, 0.08)', position: 'sticky', top: 0, width: 24 }} />
            </tr>
          </thead>
          <tbody>
            {loading && !sorted.length ? (
              [...Array(8)].map((_, i) => (
                <tr key={i}><td colSpan={9} style={{ padding: 0 }}>
                  <div className="sx-shimmer" style={{ height: 38, borderRadius: 0 }} />
                </td></tr>
              ))
            ) : !sorted.length ? (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                No data for this filter combination
              </td></tr>
            ) : sorted.map((r, i) => {
              const rev = pickRev(r, lensMode);
              return (
                <tr key={r.location_id || i}
                    onClick={() => onStoreClick && onStoreClick({ id: r.location_id, name: r.location_name })}
                    style={{ cursor: onStoreClick ? 'pointer' : 'default', transition: 'background-color 140ms' }}
                    onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(2, 132, 199, 0.04)'}
                    onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'center', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontWeight: 700 }}>{i + 1}</td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', fontWeight: 700, color: '#0B1220' }}>
                    {r.location_name}
                    {r.store_code && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                        {r.store_code}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)' }}>
                    <Pill>{r.channel}</Pill>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', color: 'var(--text-secondary)' }}>
                    {r.city || '—'}
                    {r.state && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>· {r.state}</span>}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <MiniBar value={rev} max={maxRev} color="#059669" />
                    <span style={{ fontWeight: 700 }} title={`Exact: ₹${fmtIndianFull(Math.round(rev))}`}>
                      {fmtRupee(rev)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {fmtNum(r.units_sold)}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right' }}>
                    <span style={{
                      color: Number(r.return_rate_pct) >= 5 ? '#DC2626' : Number(r.return_rate_pct) >= 3 ? '#D97706' : '#059669',
                      fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                    }}>
                      {Number(r.return_rate_pct || 0).toFixed(1)}%
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <MiniBar value={r.stock_on_hand} max={maxStock} color="#7C3AED" />
                    <span style={{ fontWeight: 600 }} title={`Exact: ${fmtIndianFull(r.stock_on_hand)}`}>
                      {fmtNum(r.stock_on_hand)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right' }}>
                    <ChevronRight size={14} color="#94A3B8" strokeWidth={2.5} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── OOS at Busy Stores — actionable transfer-candidate table ───────
function OosAtBusyStoresTable({ rows, loading, onSkuClick }) {
  const [limit, setLimit] = useState(20);
  const sorted = useMemo(() => (rows || []).slice(0, limit), [rows, limit]);
  const total = (rows || []).length;
  if (!loading && !total) return null; // nothing to show

  return (
    <div className="card sx-table-wrap" style={{ marginBottom: 24 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={15} strokeWidth={2} color="#DC2626" />
          <span className="card-title">Stock-out at Busy Stores</span>
          <Pill color="#DC2626" bg="rgba(220, 38, 38, 0.08)">
            {total} action items
          </Pill>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
          best sellers missing at high-revenue stores · transfer candidates
        </span>
      </div>
      <div style={{ maxHeight: 460, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'var(--font-body)', fontSize: 12 }}>
          <thead>
            <tr>
              <SortHeader label="SKU"             active={false} dir="desc" onClick={() => {}} />
              <SortHeader label="Product"         active={false} dir="desc" onClick={() => {}} />
              <SortHeader label="SKU Net Sales"   active={false} dir="desc" onClick={() => {}} align="right" />
              <SortHeader label="Store"           active={false} dir="desc" onClick={() => {}} />
              <SortHeader label="Store Net Sales" active={false} dir="desc" onClick={() => {}} align="right" />
              <SortHeader label="Action"          active={false} dir="desc" onClick={() => {}} align="center" />
            </tr>
          </thead>
          <tbody>
            {loading && !sorted.length ? (
              [...Array(6)].map((_, i) => (
                <tr key={i}><td colSpan={6} style={{ padding: 0 }}>
                  <div className="sx-shimmer" style={{ height: 36, borderRadius: 0 }} />
                </td></tr>
              ))
            ) : sorted.map((r, i) => (
              <tr key={i}
                  style={{ transition: 'background-color 140ms' }}
                  onClick={() => onSkuClick && onSkuClick({ id: r.sku_id, name: r.sku_code, product: r.product_name })}
                  onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(220, 38, 38, 0.04)'}
                  onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', fontWeight: 700, color: '#0B1220' }}>
                  {r.sku_code}
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                    {r.color_name} · {r.size}
                  </div>
                </td>
                <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.product_name}
                </td>
                <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
                    title={`Exact: ₹${fmtIndianFull(Math.round(r.sku_sales_value))}`}>
                  {fmtRupee(r.sku_sales_value)}
                </td>
                <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)' }}>
                  <span style={{ fontWeight: 700, color: '#0B1220' }}>{r.location_name}</span>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                    {r.city} · {r.channel}
                  </div>
                </td>
                <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
                    title={`Exact: ₹${fmtIndianFull(Math.round(r.store_revenue))}`}>
                  {fmtRupee(r.store_revenue)}
                </td>
                <td style={{ padding: '10px 14px', borderBottom: '1px solid rgba(15,23,42,0.04)', textAlign: 'center' }}>
                  <Pill color="#DC2626" bg="rgba(220, 38, 38, 0.08)">TRANSFER ★</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > limit && (
        <div style={{ padding: '10px 16px', textAlign: 'center', borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={() => setLimit(l => l + 30)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700,
              color: '#2563EB',
            }}>
            Show {Math.min(30, total - limit)} more →
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Public component — wires the cross-pivot endpoint to the 3 tables
// ─────────────────────────────────────────────────────────────────────
export default function CrossPivotTables({
  fetchFn,         // (params) → Promise<response.data.data>
  filterParams,    // {mode, gender, ...}
  cacheGet,        // (key) => any | null
  cacheSet,        // (key, val) => void
  isCacheFresh,    // (key) => boolean
  lensMode = 'net',
  onSkuClick,
  onStoreClick,
}) {
  const cacheKey = useMemo(() => {
    return 'ov:crosspivot:' + JSON.stringify(filterParams);
  }, [filterParams]);

  const [data, setData] = useState(() => cacheGet ? (cacheGet(cacheKey) || null) : null);
  const [loading, setLoading] = useState(() => !cacheGet || !cacheGet(cacheKey));
  const activeKeyRef = useRef(cacheKey);

  useEffect(() => {
    activeKeyRef.current = cacheKey;
    // Try cache first — paint instantly if we have it
    const cached = cacheGet ? cacheGet(cacheKey) : null;
    if (cached) {
      setData(cached);
      if (isCacheFresh && isCacheFresh(cacheKey)) { setLoading(false); return; }
      setLoading(false); // stale-but-displayable
    } else {
      setLoading(true);
    }
    let cancelled = false;
    fetchFn(filterParams)
      .then(payload => {
        if (cancelled) return;
        if (activeKeyRef.current !== cacheKey) return; // race-guard
        setData(payload);
        cacheSet && cacheSet(cacheKey, payload);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled && activeKeyRef.current === cacheKey) setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return (
    <>
      <TopSellersStockTable
        rows={data?.top_skus_with_stock || []}
        loading={loading}
        onSkuClick={onSkuClick}
        lensMode={lensMode}
      />
      <TopStoresPerformanceTable
        rows={data?.top_stores_with_skus || []}
        loading={loading}
        onStoreClick={onStoreClick}
        lensMode={lensMode}
      />
      <OosAtBusyStoresTable
        rows={data?.oos_at_busy_stores || []}
        loading={loading}
        onSkuClick={onSkuClick}
      />
    </>
  );
}
