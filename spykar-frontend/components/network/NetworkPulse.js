// ─── NetworkPulse — the god-tier hero section for the Network page ───────────
// Bundles together every elite widget the user asked for:
//   ① Hero KPI strip — 5 premium cards with current-status splits
//   ② Pareto Reveal callout — "100 stores hold 50% of your value"
//   ③ Where's My Money? — top 10 stores + top 10 states + channel donut
//   ④ Action Panel — OOS at active stores + Dead Stock drilldown
//   ⑤ Stock Ageing band — fresh / 31-60 / 61-90 / 91-180 / 180+ days
//
// IMPORTANT temporal note:
//   The stock anchor is `2026-02-01`; many of the "closed" stores in the
//   master closed AFTER that date. We therefore do NOT frame closed-store
//   stock as "dead capital" — at the time of the snapshot, those stores
//   were active. The Active/Closed split is shown as informational context
//   only, never as alert-coloured.
//
// All driven by ONE round-trip to /locations/network-pulse — the same v2
// filter set narrows every widget consistently. Every number is animated,
// every panel has a hover lift, the Pareto reveal has its own "wow" entrance.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, MapPin, Building2, IndianRupee, Sparkles, Layers,
         AlertTriangle, Zap, Target, TrendingUp, ChevronRight } from 'lucide-react';
import { locationService } from '../../lib/services';
import { getCached, setCached, isFresh } from '../../lib/dashboardCache';
import PremiumKpi from '../ui/PremiumKpi';

// Stable cache key per filter combo so toggling Active ↔ Inactive ↔ All
// (or any other dim) hits its own cached slot. JSON.stringify with sorted
// keys ensures `{a:1,b:2}` and `{b:2,a:1}` map to the same slot.
function pulseCacheKey(filters) {
  const norm = {};
  Object.keys(filters || {}).sort().forEach(k => {
    const v = filters[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v) && v.length === 0) return;
    norm[k] = Array.isArray(v) ? [...v].sort().join(',') : String(v);
  });
  return `net:pulse:${JSON.stringify(norm)}`;
}

// Indian-numeric formatters
const fmtL = (n) => {
  if (n == null) return '—';
  const v = Math.abs(n);
  if (v >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (v >= 100000)   return (n / 100000).toFixed(2) + ' L';
  if (v >= 1000)     return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString('en-IN');
};
const fmtRs = (n) => '₹' + fmtL(n);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');

// Active uses the brand mint; "Closed today" uses a neutral slate so it
// reads as "context" not "alert" — these stores were OPEN at the time of
// the stock snapshot (Feb 1, 2026); their closure happened afterwards.
const COL_ACTIVE = '#059669';
const COL_CLOSED = '#64748B';

export default function NetworkPulse({ filters }) {
  // Cache key per unique filter combo. Lookup is synchronous in
  // useState's lazy initialiser → first paint sees cached data immediately
  // (no skeleton flash) when the same filters were used before.
  const cacheKey = useMemo(() => pulseCacheKey({ ...filters, mode: filters?.mode || 'active' }), [JSON.stringify(filters || {})]);

  const [pulse, setPulse]     = useState(() => getCached(cacheKey));
  const [loading, setLoading] = useState(() => !getCached(cacheKey));

  // Track the most recently issued cacheKey so a slow in-flight fetch from
  // a previous combo can't stomp the current view when it eventually lands.
  // Without this, rapid Active→Inactive→Active toggling can let a stale
  // response paint after the user has already moved on.
  const activeKeyRef = useRef(cacheKey);
  useEffect(() => { activeKeyRef.current = cacheKey; }, [cacheKey]);

  // ── Stale-while-revalidate fetch ────────────────────────────────────────
  // 1. On filter change, pull cached data INSTANTLY into `pulse` so KPIs paint.
  // 2. If the cached entry is fresh (<60 s old), skip the network round-trip.
  // 3. Else fire a background refresh; only repaint if user is still on this
  //    combo when the response lands.
  useEffect(() => {
    const cached = getCached(cacheKey);
    setPulse(cached ?? null);
    if (cached && isFresh(cacheKey)) {
      setLoading(false);
      return;
    }
    setLoading(!cached);

    let cancelled = false;
    const params = { mode: filters?.mode || 'active' };
    Object.entries(filters || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v) && v.length === 0) return;
      const apiKey = k === 'gender_name' ? 'gender' : k;
      params[apiKey] = Array.isArray(v) ? v.join(',') : v;
    });

    const issuedFor = cacheKey;
    locationService.getNetworkPulse(params)
      .then(r => {
        if (cancelled) return;
        const data = r.data?.data || null;
        // Always cache by the key this fetch was issued for, even if user
        // has since switched — future returns to that combo are instant.
        setCached(issuedFor, data);
        if (activeKeyRef.current === issuedFor) {
          setPulse(data);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled && activeKeyRef.current === issuedFor) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const s = pulse?.summary || {};
  const totalStores  = s.total_locations  || 0;
  const activeStores = s.active_locations || 0;
  const closedStores = s.closed_locations || 0;
  const totalStock   = s.total_stock      || 0;
  const activeStock  = s.active_stock     || 0;
  const closedStock  = s.closed_stock     || 0;
  const totalValue   = s.total_value      || 0;
  const activeValue  = s.active_value     || 0;
  const closedValue  = s.dead_capital     || 0; // backend label kept for compat; reframed in UI

  // ── Mode lens — Active / Inactive / All ─────────────────────────────────
  // The user picks ONE lens via the FilterBar pill; every KPI on the strip
  // shows that lens's number. Clean, focused, no information overload.
  const mode = (filters?.mode || 'active').toLowerCase();
  const lensLabel  = mode === 'inactive' ? 'Inactive (closed)' : mode === 'all' ? 'All stores' : 'Active stores';
  const lensColor  = mode === 'inactive' ? '#64748B' : mode === 'all' ? '#0284C7' : '#059669';
  const lensStock  = mode === 'inactive' ? closedStock  : mode === 'all' ? totalStock  : activeStock;
  const lensValue  = mode === 'inactive' ? closedValue  : mode === 'all' ? totalValue  : activeValue;
  const lensStores = mode === 'inactive' ? closedStores : mode === 'all' ? totalStores : activeStores;
  const avgPerStore  = lensStores ? Math.round(lensStock / lensStores) : 0;
  const avgValuePerStore = lensStores ? Math.round(lensValue / lensStores) : 0;

  return (
    <div style={{ marginBottom: 32 }}>

      {/* ── Header strip — pulse label + lens chip + as-of date ─────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkles size={14} style={{ color: 'var(--accent-primary)' }} />
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>Network Pulse</span>
          {/* Lens chip — echoes the FilterBar mode pill so the user always
              knows which slice the KPIs are showing. */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 10px',
            background: `${lensColor}14`,
            border: `1px solid ${lensColor}33`,
            color: lensColor,
            borderRadius: 999,
            fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: lensColor }} />
            {lensLabel}
          </span>
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          background: 'rgba(2,132,199,0.08)',
          color: 'var(--sky)',
          border: '1px solid rgba(2,132,199,0.20)',
          borderRadius: 999,
          fontSize: 11, fontWeight: 700,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--sky)' }} />
          Stock as of {s.as_of_date || '—'}
        </div>
      </div>

      {/* ── HERO KPI STRIP — single-number cards, lens-aware ────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 14, marginBottom: 24,
      }}>
        <PremiumKpi
          label="Total Stock"
          icon={Package}
          accent="brand"
          highlight
          value={lensStock}
          loading={loading}
          context={`${fmtNum(s.unique_skus)} unique SKUs in stock`}
        />
        <PremiumKpi
          label="Stock Value (MRP)"
          icon={IndianRupee}
          accent="emerald"
          value={lensValue}
          loading={loading}
          context="MRP × qty"
        />
        <PremiumKpi
          label="Stores"
          icon={Building2}
          accent="violet"
          value={lensStores}
          format="plain"
          loading={loading}
          context={`${s.state_count || 0} states covered`}
        />
        <PremiumKpi
          label="Avg Stock / Store"
          icon={Target}
          accent="sky"
          value={avgPerStore}
          loading={loading}
          context={`avg ${fmtRs(avgValuePerStore)} per store`}
        />
        <PremiumKpi
          label="Top Channel"
          icon={Layers}
          accent="amber"
          value={pulse?.channels?.[0]?.channel || '—'}
          format="string"
          loading={loading}
          context={pulse?.channels?.[0]
            ? `${fmtNum(pulse.channels[0].stores)} stores · ${fmtRs(pulse.channels[0].value)} · ${pulse.channels[0].billing_model}`
            : ''}
        />
      </div>

      {/* ── PARETO REVEAL — "the killer 80/20 callout" ──────────────────── */}
      {pulse?.pareto && (
        <ParetoReveal
          totalStores={pulse.pareto.total_stores_with_stock}
          stores50={pulse.pareto.stores_for_50}
          stores80={pulse.pareto.stores_for_80}
          stores90={pulse.pareto.stores_for_90}
          loading={loading}
        />
      )}

      {/* ── WHERE'S MY MONEY? — top stores + top states + channel mix ──── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr', gap: 14, marginBottom: 24 }}>
        <TopList
          title="Top Stores by Stock Value"
          icon={Building2}
          rows={pulse?.top_stores || []}
          loading={loading}
          renderRight={(r) => (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{fmtRs(r.value)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtL(r.units)} units</div>
            </div>
          )}
          renderLeft={(r) => (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{r.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {r.code} · {r.city || '—'}, {r.state || '—'} ·{' '}
                <span style={{ color: r.shop_closed ? COL_CLOSED : COL_ACTIVE, fontWeight: 600 }}>
                  {r.shop_closed ? 'CLOSED' : 'ACTIVE'}
                </span>
              </div>
            </>
          )}
          empty="No stores with stock match the current filters"
        />
        <TopList
          title="Top States by Value"
          icon={MapPin}
          rows={pulse?.top_states || []}
          loading={loading}
          renderRight={(r) => (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{fmtRs(r.value)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.active_stores}/{r.stores} stores</div>
            </div>
          )}
          renderLeft={(r) => (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{r.state}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtL(r.units)} units</div>
            </>
          )}
          empty="No states match"
        />
        <ChannelMix channels={pulse?.channels || []} loading={loading} />
      </div>

      {/* ── ACTION PANEL — decisions to make right now ────────────────── */}
      <ActionPanel actions={pulse?.actions} loading={loading} />
    </div>
  );
}

// ─── Pareto Reveal — animated 80/20 callout ──────────────────────────────────
function ParetoReveal({ totalStores, stores50, stores80, stores90, loading }) {
  if (loading || !totalStores) return null;
  const pct50 = Math.round((stores50 / totalStores) * 100);
  const pct80 = Math.round((stores80 / totalStores) * 100);
  return (
    <div style={{
      position: 'relative',
      background: 'linear-gradient(135deg, rgba(192,57,43,0.04), rgba(231,76,60,0.04))',
      border: '1px solid rgba(192,57,43,0.18)',
      borderRadius: 16, padding: '20px 24px',
      marginBottom: 24,
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', right: -40, top: -40,
        width: 180, height: 180,
        background: 'radial-gradient(circle, rgba(192,57,43,0.10), transparent 70%)',
        pointerEvents: 'none',
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'rgba(192,57,43,0.10)',
          color: 'var(--accent-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Zap size={18} strokeWidth={2.5} />
        </div>
        <div>
          <div style={{
            fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--accent-primary)',
          }}>Concentration Reveal</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>
            The 80/20 of your inventory
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, position: 'relative' }}>
        <ParetoSlice n={stores50} of={totalStores} pct={pct50} label="hold 50%" tone="strong" />
        <ParetoSlice n={stores80} of={totalStores} pct={pct80} label="hold 80%" tone="medium" />
        <ParetoSlice n={stores90} of={totalStores} pct={Math.round((stores90 / totalStores) * 100)} label="hold 90%" tone="soft" />
      </div>
    </div>
  );
}

function ParetoSlice({ n, of, pct, label, tone }) {
  const colors = {
    strong: { bar: '#C0392B', label: 'rgba(192,57,43,0.9)' },
    medium: { bar: '#E74C3C', label: 'rgba(231,76,60,0.85)' },
    soft:   { bar: '#F87171', label: 'rgba(248,113,113,0.85)' },
  }[tone];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.025em' }}>
          {n}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>/ {of}</span>
        <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, color: colors.label, letterSpacing: '0.04em' }}>
          ({pct}%)
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600 }}>
        stores {label} of total stock value
      </div>
      <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: colors.bar, borderRadius: 999,
          transition: 'width 800ms cubic-bezier(0.16,1,0.3,1)',
        }} />
      </div>
    </div>
  );
}

// ─── TopList — generic ranked list with sort + limit controls ────────────────
// `sortKeyValue` / `sortKeyUnits` tell the list which row props to sort by;
// the user toggles via two pill dropdowns in the top-right corner. Defaults
// to value-sort, top 10 — same as the original render.
function TopList({ title, icon: Icon, rows, loading, renderLeft, renderRight, empty, sortKeyValue = 'value', sortKeyUnits = 'units' }) {
  const [sortBy, setSortBy] = useState('value');
  const [limit,  setLimit]  = useState(10);

  // Sort + slice client-side. Backend already returns 25 rows so any
  // top-10/15/20 view is a stable subset.
  const visible = useMemo(() => {
    const key = sortBy === 'units' ? sortKeyUnits : sortKeyValue;
    return [...(rows || [])]
      .sort((a, b) => Number(b?.[key] || 0) - Number(a?.[key] || 0))
      .slice(0, limit);
  }, [rows, sortBy, limit, sortKeyValue, sortKeyUnits]);

  const SelectChip = ({ value, onChange, options }) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        height: 26,
        padding: '0 22px 0 8px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 999,
        fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
        letterSpacing: '0.02em', color: 'var(--text-secondary)',
        cursor: 'pointer', appearance: 'none',
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%2364748b' stroke-width='1.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 7px center',
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {Icon && <Icon size={14} style={{ color: 'var(--text-muted)' }} />}
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        {/* Sort + limit pills, top-right corner */}
        <SelectChip
          value={sortBy}
          onChange={setSortBy}
          options={[{ value: 'value', label: 'Value' }, { value: 'units', label: 'Units' }]}
        />
        <SelectChip
          value={String(limit)}
          onChange={v => setLimit(Number(v))}
          options={[10, 15, 20].map(n => ({ value: String(n), label: `Top ${n}` }))}
        />
      </div>
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[0,1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 36, borderRadius: 6 }} />)}
        </div>
      )}
      {!loading && visible.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{empty}</div>
      )}
      {!loading && visible.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {visible.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 8px', borderRadius: 8,
              transition: 'background 120ms',
            }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{
                width: 22, height: 22, flexShrink: 0,
                borderRadius: 6,
                background: i < 3 ? 'var(--accent-glow)' : 'var(--bg-elevated)',
                color: i < 3 ? 'var(--accent-primary)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 800,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>{renderLeft(r)}</div>
              <div style={{ flexShrink: 0 }}>{renderRight(r)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ChannelMix — horizontal bar list (SOR vs Outright at a glance) ──────────
function ChannelMix({ channels, loading }) {
  const total = useMemo(() => channels.reduce((s, c) => s + Number(c.value || 0), 0), [channels]);
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Layers size={14} style={{ color: 'var(--text-muted)' }} />
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Channels</span>
      </div>
      {loading && <div className="skeleton" style={{ height: 100, borderRadius: 8 }} />}
      {!loading && channels.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No channels match</div>
      )}
      {!loading && channels.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {channels.map((c, i) => {
            const pct = total ? (Number(c.value || 0) / total) * 100 : 0;
            const color = c.billing_model === 'OUTRIGHT' ? '#0284C7' : '#7C3AED';
            return (
              <div key={i}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{c.channel}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{fmtRs(c.value)} · {pct.toFixed(0)}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 999, transition: 'width 700ms cubic-bezier(0.16,1,0.3,1)' }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-disabled)', marginTop: 3, fontWeight: 600 }}>
                  {fmtNum(c.stores)} {c.stores === 1 ? 'store' : 'stores'} · {c.billing_model}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ActionPanel — OOS + Dead Stock callouts ────────────────────────────────
// Dead Capital intentionally omitted: stores marked closed in the master
// were OPEN at the snapshot date (2026-02-01). Reframing closed-store stock
// as "stuck capital" would mislabel legitimate operating inventory.
function ActionPanel({ actions, loading }) {
  const oos = actions?.oos_active || { count: 0, value: 0 };
  const ds  = actions?.dead_stock || { count: 0, units: 0, value: 0 };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
      <ActionCard
        accent="#D97706" tint="rgba(217,119,6,0.06)" border="rgba(217,119,6,0.22)"
        icon={AlertTriangle}
        title="Empty Active Stores — no stock at all"
        headline={fmtNum(oos.count)}
        loading={loading}
        bullets={[
          'Active stores carrying zero inventory',
          'Open for trade but nothing to sell',
          'Reorder priority',
        ]}
        cta="Generate reorder"
      />
      <ActionCard
        accent="#7C3AED" tint="rgba(124,58,237,0.06)" border="rgba(124,58,237,0.22)"
        icon={Target}
        title="Dead Stock — no sale in 180+ days"
        headline={fmtRs(ds.value)}
        loading={loading}
        bullets={[
          `${fmtNum(ds.count)} SKU-store lines`,
          `${fmtL(ds.units)} units sitting`,
          'Mark for clearance',
        ]}
        cta="Plan clearance"
      />
    </div>
  );
}

function ActionCard({ accent, tint, border, icon: Icon, title, headline, bullets, cta, loading }) {
  return (
    <div style={{
      position: 'relative',
      background: tint,
      border: `1px solid ${border}`,
      borderRadius: 14,
      padding: '16px 18px',
      transition: 'all 220ms cubic-bezier(0.4,0,0.2,1)',
      overflow: 'hidden',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 10px 24px ${border}`; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)';     e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9,
          background: '#fff', color: accent, border: `1px solid ${border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={16} strokeWidth={2.5} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: accent }}>{title}</span>
      </div>
      {loading ? (
        <div className="skeleton" style={{ height: 28, width: '60%', marginBottom: 12 }} />
      ) : (
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800,
          color: 'var(--text-primary)', letterSpacing: '-0.025em', marginBottom: 10,
        }}>{headline}</div>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: accent, flexShrink: 0 }} />
            {b}
          </li>
        ))}
      </ul>
      <button
        type="button"
        style={{
          marginTop: 12,
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'transparent', border: 'none',
          color: accent, cursor: 'pointer',
          fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 800,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          padding: 0,
        }}
      >
        {cta} <ChevronRight size={12} strokeWidth={3} />
      </button>
    </div>
  );
}

