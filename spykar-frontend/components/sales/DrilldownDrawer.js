// ─── DrilldownDrawer — right-side slide-over for store / SKU drill ───────────
// Two pivots, one drawer:
//   pivot="store" + id=<location_uuid> → "what does this store sell, in what
//     colours / sizes, with what return rate, and which SKUs lead the mix?"
//   pivot="sku"   + id=<sku_uuid>      → "which stores sell this SKU the most,
//     where is it getting returned, and what is the return rate?"
//
// Performance contract:
//   • Backend Redis 10-min TTL (`analytics:sales:drill:v1:…`) shared by every
//     user — same drill on a warm key returns instantly.
//   • Frontend dashboardCache (`sales:drill:v1:…`) localStorage-tier so
//     reopening the drawer survives a page reload. 10-min freshness window.
//   • Single in-flight request per (pivot,id,filters) — guarded by `dedupedFetch`
//     so back-to-back opens don't fire parallel requests.
//   • Stale-while-revalidate: cached snapshot paints instantly, fresh data
//     flips in if anything changed. No skeleton flash on warm reopens.
//   • Smooth slide-in via CSS transform (GPU-accelerated; respects
//     prefers-reduced-motion via the global guard in styles/globals.css).
//   • Esc + click-outside close. Body scroll locked while open.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Building2, Package, MapPin, ShoppingBag, RotateCcw, TrendingUp, Calendar } from 'lucide-react';
import { analyticsService } from '../../lib/services';
import { getCached, setCached, isFresh, dedupedFetch } from '../../lib/dashboardCache';

// ── Number formatters (Indian convention) ────────────────────────────────
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtCr  = (n) => {
  const v = Number(n || 0);
  if (v >= 10_000_000) return `₹${(v/10_000_000).toFixed(2)} Cr`;
  if (v >= 100_000)    return `₹${(v/100_000).toFixed(2)} L`;
  if (v >= 1_000)      return `₹${(v/1_000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtL = (n) => {
  const v = Number(n || 0);
  if (v >= 10_000_000) return (v/10_000_000).toFixed(2) + ' Cr';
  if (v >= 100_000)    return (v/100_000).toFixed(2) + 'L';
  if (v >= 1_000)      return (v/1_000).toFixed(1) + 'K';
  return v.toLocaleString('en-IN');
};

// Build the cache key. The `filters` param IS already the exact querystring
// the backend will see, so JSON-stringifying it gives us a bijective key.
function drilldownCacheKey(pivot, id, filters) {
  const norm = {};
  Object.keys(filters || {}).sort().forEach(k => {
    const v = filters[k];
    if (v === undefined || v === null || v === '') return;
    norm[k] = String(v);
  });
  return `sales:drill:v1:${pivot}:${id}:${JSON.stringify(norm)}`;
}

export default function DrilldownDrawer({
  open,            // bool
  pivot,           // 'store' | 'sku'
  id,              // uuid
  filters = {},    // backend filters (state, city, mode, valuation, etc.)
  onClose,         // () => void
  valuation = 'gross',
  lensMode = 'net',
}) {
  const cacheKey = useMemo(() => id ? drilldownCacheKey(pivot, id, filters) : null,
    [pivot, id, JSON.stringify(filters || {})]);

  const [data, setData]       = useState(() => cacheKey ? (getCached(cacheKey) ?? null) : null);
  const [loading, setLoading] = useState(false);
  const activeKeyRef = useRef(cacheKey);

  useEffect(() => { activeKeyRef.current = cacheKey; }, [cacheKey]);

  // Stale-while-revalidate fetch. Fires when drawer opens or when the
  // (pivot,id,filters) cache key changes. Skips network entirely if a fresh
  // cached snapshot exists — drawer paints in microseconds for warm keys.
  useEffect(() => {
    if (!open || !id || !cacheKey) return;
    const cached = getCached(cacheKey);
    if (cached) {
      setData(cached);
      if (isFresh(cacheKey)) { setLoading(false); return; }
      setLoading(false); // stale-but-displayable; refetch in background
    } else {
      setLoading(true); // cold open — no prior data, show skeleton
      setData(null);
    }
    const params = { type: pivot, id, ...filters };
    const issuedFor = cacheKey;
    dedupedFetch(cacheKey, () => analyticsService.getSalesDrilldown(params))
      .then(r => {
        const v = r.data?.data;
        if (!v) return;
        setCached(issuedFor, v);
        if (activeKeyRef.current === issuedFor) {
          setData(v);
          setLoading(false);
        }
      })
      .catch(() => {
        if (activeKeyRef.current === issuedFor) setLoading(false);
      });
  }, [open, pivot, id, cacheKey]);

  // Esc + click-outside + body-scroll-lock + focus trap on open
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* Backdrop — clicks dismiss the drawer */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: open ? 'rgba(15, 23, 42, 0.42)' : 'transparent',
          backdropFilter: open ? 'blur(2px)' : 'none',
          WebkitBackdropFilter: open ? 'blur(2px)' : 'none',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 280ms cubic-bezier(0.16, 1, 0.3, 1), backdrop-filter 280ms',
          zIndex: 9000,
        }}
      />
      {/* Drawer panel — GPU-accelerated transform for buttery slide */}
      <aside
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(640px, 92vw)',
          background: 'var(--bg-card)',
          boxShadow: '-32px 0 80px -20px rgba(15, 23, 42, 0.18), -8px 0 24px -10px rgba(15, 23, 42, 0.08)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 320ms cubic-bezier(0.16, 1, 0.3, 1)',
          zIndex: 9001,
          display: 'flex', flexDirection: 'column',
          fontFeatureSettings: '"tnum" 1',
        }}
        className="sx-page"
      >
        {/* Header */}
        <DrawerHeader data={data} pivot={pivot} loading={loading && !data} onClose={onClose} />

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 32px' }}>
          {loading && !data ? (
            <DrawerSkeleton />
          ) : !data ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
              No data for this {pivot}.
            </div>
          ) : (
            <DrawerBody data={data} pivot={pivot} valuation={valuation} lensMode={lensMode} />
          )}
        </div>
      </aside>
    </>,
    document.body
  );
}

// ── Header ──────────────────────────────────────────────────────────────
function DrawerHeader({ data, pivot, loading, onClose }) {
  const id = data?.identity || {};
  const title = pivot === 'store'
    ? (id.name || 'Store details')
    : (id.product_name || id.sku_code || 'SKU details');
  const sub = pivot === 'store'
    ? [id.code, id.city, id.state, id.channel].filter(Boolean).join(' · ')
    : [id.sku_code, id.color_name, id.size, id.fit_type].filter(Boolean).join(' · ');
  const Icon = pivot === 'store' ? Building2 : Package;
  return (
    <header style={{
      padding: '20px 24px 18px',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex', alignItems: 'flex-start', gap: 14,
      background: 'var(--bg-card)',
    }}>
      <span style={{
        width: 38, height: 38, borderRadius: 10,
        background: 'var(--bg-elevated)', color: 'var(--text-primary)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={18} strokeWidth={2.2} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sx-eyebrow" style={{ marginBottom: 4 }}>
          {pivot === 'store' ? 'Store Drilldown' : 'SKU Drilldown'}
        </div>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 20, fontWeight: 800,
          color: 'var(--text-primary)', letterSpacing: '-0.02em',
          margin: 0, lineHeight: 1.15,
          overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={title}>
          {loading ? <span className="sx-shimmer" style={{ display: 'inline-block', width: 240, height: 22, borderRadius: 5 }} /> : title}
        </h2>
        {sub && (
          <div style={{
            fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
            marginTop: 4, letterSpacing: '0.005em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{sub}</div>
        )}
      </div>
      <button onClick={onClose} title="Close (Esc)"
        style={{
          width: 34, height: 34, borderRadius: 10,
          border: '1px solid var(--border-default)',
          background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          transition: 'background 160ms ease, transform 160ms ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(15,23,42,0.04)'; e.currentTarget.style.transform = 'scale(1.04)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)'; e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <X size={16} strokeWidth={2.2} color="currentColor" />
      </button>
    </header>
  );
}

// ── Body — KPI strip + lists + breakdowns ───────────────────────────────
function DrawerBody({ data, pivot, valuation, lensMode }) {
  const s = data.summary || {};

  // Lens-aware revenue picker — same scheme as the main page so flipping
  // lens / valuation up there auto-reflects in the drawer too.
  const pickRevenue = (kind /* 'sale' | 'return' */) => {
    const prefix = kind === 'return' ? 'return_' : 'sales_';
    switch (valuation) {
      case 'ex_gst':   return Number(s[`${prefix}ex_gst_value`]   || 0);
      case 'gst':      return Number(s[`${prefix}gst_collected`]  || 0);
      case 'mrp':      return Number(s[`${prefix}mrp_value`]      || 0);
      case 'discount': return Math.max(0, Number(s[`${prefix}mrp_value`] || 0) - Number(s[`${kind === 'return' ? 'return_value' : 'sales_value'}`] || 0));
      case 'gross':
      default:         return Number(s[kind === 'return' ? 'return_value' : 'sales_value'] || 0);
    }
  };
  // Drawer is net-of-returns by design. We expose all three figures via
  // the sub-lines (sold + returned) so the user always sees the breakdown.
  const saleRev   = pickRevenue('sale');
  const returnRev = pickRevenue('return');
  const netRev    = saleRev - returnRev;
  const soldUnits   = Number(s.units_sold   || 0);
  const returnUnits = Number(s.return_units || 0);
  const netUnits    = soldUnits - returnUnits;
  const lensColor   = '#059669'; // green for net-positive — drawer is always net
  const valuationLabel = valuation === 'gross' ? 'Gross' : valuation === 'ex_gst' ? 'Ex-GST' : valuation === 'gst' ? 'GST' : valuation === 'mrp' ? 'MRP' : valuation === 'discount' ? 'Discount' : valuation;
  // Kept for any UI string still referencing "lens", but drawer is net.
  const lensLabel = 'Net';
  void lensMode;

  // Drawer is ALWAYS net-of-returns (sold − returned), independent of the
  // page Show pill. The valuation dropdown still drives the ₹ basis so a
  // user on MRP sees net-MRP, on Ex-GST sees net-Ex-GST, etc.
  // Sub-line on each row breaks out X sold · Y returned so both sides of
  // the net are visible without the user toggling anything.
  const saleVal = (r) => {
    switch (valuation) {
      case 'ex_gst':   return Number(r?.ex_gst_value || 0);
      case 'gst':      return Number(r?.gst_collected || 0);
      case 'mrp':      return Number(r?.mrp_value || 0);
      case 'discount': return Math.max(0, Number(r?.mrp_value || 0) - Number(r?.sales_value || 0));
      case 'gross':
      default:         return Number(r?.sales_value || 0);
    }
  };
  const returnVal = (r) => {
    switch (valuation) {
      case 'ex_gst':   return Number(r?.return_ex_gst_value || 0);
      case 'gst':      return Number(r?.return_gst_collected || 0);
      case 'mrp':      return Number(r?.return_mrp_value || 0);
      case 'discount': return Math.max(0, Number(r?.return_mrp_value || 0) - Number(r?.return_value || 0));
      case 'gross':
      default:         return Number(r?.return_value || 0);
    }
  };
  const rowUnits = (r) => Number(r?.units_sold || 0) - Number(r?.return_qty || 0);
  const rowValue = (r) => saleVal(r) - returnVal(r);

  return (
    <>
      {/* KPI strip — drawer is always net-of-returns; valuation drives ₹.
          Sub-line on each tile shows the sold + returned breakdown so the
          user sees both sides without toggling anything. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 12, marginBottom: 22,
      }}>
        <KpiTile
          icon={ShoppingBag}
          label="Net Units"
          value={fmtL(netUnits)}
          rawTooltip={fmtNum(netUnits)}
          accent={lensColor}
          sub={`${fmtNum(soldUnits)} sold · ${fmtNum(returnUnits)} returned`}
        />
        <KpiTile
          icon={TrendingUp}
          label={`Net ${valuationLabel}`}
          value={fmtCr(netRev)}
          rawTooltip={`₹${fmtNum(netRev)}`}
          accent={lensColor}
          sub={`${fmtCr(saleRev)} sold − ${fmtCr(returnRev)} returned`}
        />
        <KpiTile
          icon={RotateCcw}
          label="Return Rate"
          value={`${(s.return_rate_pct ?? 0).toFixed?.(1) || s.return_rate_pct}%`}
          rawTooltip={`${fmtNum(s.return_units)} of ${fmtNum(s.units_sold)} units`}
          accent={Number(s.return_rate_pct) >= 5 ? '#B91C1C' : Number(s.return_rate_pct) >= 2 ? '#D97706' : '#475569'}
          sub={`${fmtNum(returnUnits)} returns / ${fmtNum(soldUnits)} sold`}
        />
        <KpiTile
          icon={pivot === 'store' ? Package : MapPin}
          label={pivot === 'store' ? 'Unique SKUs sold' : 'Stores carrying it'}
          value={fmtNum(pivot === 'store' ? s.unique_skus_sold : s.unique_stores)}
          rawTooltip={fmtNum(pivot === 'store' ? s.unique_skus_sold : s.unique_stores)}
          accent="#0B1220"
          sub={`${s.active_days || 0} active days`}
        />
      </div>

      {/* Date span chip */}
      {(s.first_sold_at || s.last_sold_at) && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 999,
          background: 'var(--bg-elevated)',
          border: '1px solid rgba(15, 23, 42, 0.06)',
          fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
          marginBottom: 22, letterSpacing: '0.01em',
        }}>
          <Calendar size={11} strokeWidth={2.2} />
          {s.first_sold_at ? new Date(s.first_sold_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
          {' → '}
          {s.last_sold_at ? new Date(s.last_sold_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
          <span style={{ color: 'rgba(15,23,42,0.3)', margin: '0 4px' }}>·</span>
          {s.active_days || 0} active days
        </div>
      )}

      {/* Pivot-specific lists */}
      {pivot === 'store' ? (
        <>
          <RankList
            title={`Top SKUs sold here · Net ${valuationLabel}`}
            rows={data.top_skus}
            emptyText="No SKU activity in this window"
            renderLeft={(r) => ({
              primary: r.product_name || r.sku_code,
              secondary: `${r.sku_code} · ${r.color_name || '—'} · ${r.size || '—'}`,
            })}
            renderRight={(r) => ({
              value: fmtCr(rowValue(r)),
              units: `${fmtNum(rowUnits(r))} net · ${fmtNum(r.units_sold)} sold · ${fmtNum(r.return_qty)} returned`,
            })}
            limit={15}
          />
          {/* Most-returned SKUs at this store — sorted by return ₹ DESC.
              Always shown as actual returns regardless of page lens since
              the section's purpose is to spotlight return concentration. */}
          <RankList
            title="Most returned SKUs here"
            rows={data.top_return_skus}
            emptyText="No returns logged at this store"
            tone="loss"
            renderLeft={(r) => ({
              primary: r.product_name || r.sku_code,
              secondary: `${r.sku_code} · ${r.color_name || '—'} · ${r.size || '—'}`,
            })}
            renderRight={(r) => ({
              value: fmtCr(r.return_value),
              units: `${fmtNum(r.return_qty)} returned${Number(r.units_sold) > 0 ? ` · ${fmtNum(r.units_sold)} sold` : ''}`,
            })}
            limit={15}
          />
          <ColourSizeRow byColor={data.by_color} bySize={data.by_size} />
        </>
      ) : (
        <>
          <RankList
            title={`Top stores selling this SKU · Net ${valuationLabel}`}
            rows={data.top_stores}
            emptyText="Not stocked anywhere yet"
            renderLeft={(r) => ({
              primary: r.location_name,
              secondary: `${r.location_code || ''} · ${r.city || '—'}, ${r.state || '—'} · ${r.channel || '—'}`,
            })}
            renderRight={(r) => ({
              value: fmtCr(rowValue(r)),
              units: `${fmtNum(rowUnits(r))} net · ${fmtNum(r.units_sold)} sold · ${fmtNum(r.return_qty)} returned`,
            })}
            limit={15}
          />
          <RankList
            title="Stores with most returns"
            rows={data.top_return_stores}
            emptyText="No returns logged"
            tone="loss"
            renderLeft={(r) => ({
              primary: r.location_name,
              secondary: `${r.location_code || ''} · ${r.city || '—'}, ${r.state || '—'}`,
            })}
            renderRight={(r) => ({
              value: fmtCr(r.return_value),
              units: `${fmtNum(r.return_qty)} returned · ${fmtNum(r.units_sold)} sold`,
            })}
            limit={10}
          />
        </>
      )}
    </>
  );
}

// ── Compact KPI tile inside the drawer ──────────────────────────────────
function KpiTile({ icon: Icon, label, value, rawTooltip, accent, sub }) {
  return (
    <div className="sx-card" style={{ padding: '14px 16px 12px', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 12, right: 12, height: 2,
        background: `linear-gradient(90deg, ${accent}, ${accent}cc)`,
        borderRadius: 2, opacity: 0.85 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 2 }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, background: `${accent}10`, color: accent,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={13} strokeWidth={2} />
        </span>
        <span style={{
          fontFamily: 'var(--font-body)',
          fontSize: 10, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>{label}</span>
      </div>
      <div className="sx-hero-num" title={rawTooltip}
        style={{ fontSize: 22, cursor: 'help' }}>
        {value}
      </div>
      {sub && (
        <div style={{
          fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)',
          marginTop: 6, letterSpacing: '0.005em',
        }}>{sub}</div>
      )}
    </div>
  );
}

// ── Generic ranked list ────────────────────────────────────────────────
function RankList({ title, rows, renderLeft, renderRight, emptyText, limit = 15, tone }) {
  const visible = (rows || []).slice(0, limit);
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="sx-eyebrow" style={{ marginBottom: 10 }}>{title}</div>
      {visible.length === 0 && (
        <div style={{ padding: 18, textAlign: 'center', fontSize: 12, fontWeight: 600,
          color: 'var(--text-muted)', background: 'var(--row-stripe)', borderRadius: 10 }}>
          {emptyText}
        </div>
      )}
      {visible.length > 0 && (
        <div className="sx-card" style={{ padding: 8 }}>
          {visible.map((r, i) => {
            const left  = renderLeft(r);
            const right = renderRight(r);
            const rankColor = tone === 'loss' && i < 3 ? '#B91C1C' : i < 3 ? '#0B1220' : 'var(--text-muted)';
            return (
              <div key={r.sku_id || r.location_id || i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '24px 1fr auto',
                  gap: 12, alignItems: 'center',
                  padding: '9px 10px',
                  borderRadius: 8,
                  transition: 'background 140ms ease',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(15,23,42,0.025)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{
                  fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 800,
                  color: rankColor, letterSpacing: '-0.005em', textAlign: 'center',
                }}>{i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{left.primary}</div>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{left.secondary}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="sx-num" style={{
                    fontSize: 13, color: tone === 'loss' ? '#B91C1C' : 'var(--text-primary)',
                  }}>{right.value}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', marginTop: 2 }}>
                    {right.units}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Inline colour + size mini-tables (store pivot) ──────────────────────
function ColourSizeRow({ byColor, bySize }) {
  const top = (rows, n = 6) => (rows || []).slice(0, n);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 22 }}>
      <MiniBreakdown title="Top Colours" rows={top(byColor)} keyField="color_name" />
      <MiniBreakdown title="Top Sizes"   rows={top(bySize)}  keyField="size"       />
    </div>
  );
}
function MiniBreakdown({ title, rows, keyField }) {
  const total = rows.reduce((s, r) => s + Number(r.units_sold || 0), 0);
  return (
    <div>
      <div className="sx-eyebrow" style={{ marginBottom: 8 }}>{title}</div>
      <div className="sx-card" style={{ padding: 8 }}>
        {rows.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>—</div>
        )}
        {rows.map((r, i) => {
          const pct = total > 0 ? (Number(r.units_sold || 0) / total) * 100 : 0;
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 60px auto',
              alignItems: 'center', gap: 10,
              padding: '6px 10px', borderRadius: 7,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[keyField]}</div>
              <div style={{ background: 'var(--border-default)', borderRadius: 99, height: 5, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', background: 'linear-gradient(90deg,#0B1220,#475569)' }} />
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', minWidth: 56, textAlign: 'right' }}>
                {fmtNum(r.units_sold)} · {pct.toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Skeleton on cold open ───────────────────────────────────────────────
function DrawerSkeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 22 }}>
        {[0,1,2,3].map(i => (
          <div key={i} className="sx-card" style={{ padding: 16 }}>
            <div className="sx-shimmer" style={{ height: 12, width: '50%', borderRadius: 4, marginBottom: 14 }} />
            <div className="sx-shimmer" style={{ height: 24, width: '70%', borderRadius: 5 }} />
          </div>
        ))}
      </div>
      <div className="sx-shimmer" style={{ height: 16, width: 160, borderRadius: 4, marginBottom: 12 }} />
      <div className="sx-card" style={{ padding: 8 }}>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} className="sx-shimmer" style={{ height: 38, borderRadius: 6, margin: '4px 0' }} />
        ))}
      </div>
    </div>
  );
}
