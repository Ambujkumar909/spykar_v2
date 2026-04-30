// ─── SalesPulse — the world-class hero section for the Sales page ───────────
// Mirrors NetworkPulse's structure so the Sales page speaks the same visual
// language: KPIs → Concentration Reveal → Top widgets → Action Panel.
//
// Driven by the SAME filtered API response as the rest of the page (every
// dropdown pick narrows pulse + tables + charts together — no second call).
// Lens-aware: the user picks Sale / Return / Net via the parent's pill, and
// every KPI here flips to that lens with smooth count-up animation.
//
// Layout matches the Pearl Light design system used across the rest of the
// dashboard. Premium glass surfaces, gradient accent rails, hover lifts.

import { useMemo, useState, useEffect, useRef } from 'react';
import {
  ShoppingBag, RotateCcw, IndianRupee, TrendingUp, TrendingDown, Building2,
  Sparkles, Zap, Target, Layers, AlertTriangle, ChevronRight, Award, Calendar,
} from 'lucide-react';

// ── Indian-numeric formatters ────────────────────────────────────────────────
const fmtL = (n) => {
  if (n == null || isNaN(n)) return '—';
  const v = Math.abs(n);
  if (v >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (v >= 100000)   return (n / 100000).toFixed(2) + ' L';
  if (v >= 1000)     return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString('en-IN');
};
const fmtRs = (n) => '₹' + fmtL(n);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtPct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '0%';

// Smooth integer count-up so KPI changes feel alive instead of dead-jumping.
function useCountUp(value, duration = 700) {
  const [n, setN]     = useState(value);
  const fromRef       = useRef(value);
  const rafRef        = useRef(null);
  const mounted       = useRef(false);
  useEffect(() => {
    if (typeof value !== 'number' || isNaN(value)) { setN(value); return; }
    if (!mounted.current) { mounted.current = true; setN(value); fromRef.current = value; return; }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setN(value); fromRef.current = value; return; }
    const from = Number(fromRef.current) || 0;
    const to   = Number(value) || 0;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      setN(from + (to - from) * ease(t));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else { setN(to); fromRef.current = to; }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);
  return n;
}

// ─── KPI card — single big number with optional gradient accent rail ────────
function KpiHero({ label, value, format = 'indian', icon: Icon, accent, context, loading, prefix = '', suffix = '' }) {
  const animate = !loading && typeof value === 'number';
  const shown = useCountUp(animate ? value : null, 720);
  const display = loading ? null
    : format === 'string'  ? value
    : format === 'indian'  ? prefix + fmtL(animate ? Math.round(shown) : value) + suffix
    : (prefix + (animate ? Math.round(shown) : Number(value)).toLocaleString('en-IN') + suffix);
  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 16,
        padding: '18px 20px 16px',
        overflow: 'hidden',
        transition: 'all 240ms cubic-bezier(0.4,0,0.2,1)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.boxShadow = `0 10px 30px rgba(15,23,42,0.10), 0 0 0 1px ${accent}33`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Gradient accent rail */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: `linear-gradient(135deg, ${accent}, ${accent}dd)`, borderRadius: '16px 16px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, marginTop: 4 }}>
        {Icon && (
          <div style={{ width: 32, height: 32, borderRadius: 9, background: `${accent}14`,
            border: `1px solid ${accent}33`, color: accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={16} strokeWidth={2} />
          </div>
        )}
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</span>
      </div>
      {loading ? (
        <div className="skeleton" style={{ height: 36, width: '70%', marginBottom: 10 }} />
      ) : (
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800,
          color: 'var(--text-primary)', lineHeight: 1.02, letterSpacing: '-0.025em', marginBottom: 6 }}>
          {display ?? '—'}
        </div>
      )}
      {context && (
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-disabled)' }}>{context}</div>
      )}
    </div>
  );
}

// ─── Pareto Reveal — "X SKUs drive 50% of sales" ────────────────────────────
function SalesPareto({ rows, totalValue, label = 'SKUs', loading }) {
  const stats = useMemo(() => {
    const sorted = [...(rows || [])].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
    const total = totalValue || sorted.reduce((s, r) => s + Number(r.value || 0), 0);
    if (!total) return null;
    let cum = 0, n50 = 0, n80 = 0, n90 = 0;
    for (let i = 0; i < sorted.length; i++) {
      cum += Number(sorted[i].value || 0);
      if (!n50 && cum >= total * 0.5) n50 = i + 1;
      if (!n80 && cum >= total * 0.8) n80 = i + 1;
      if (!n90 && cum >= total * 0.9) n90 = i + 1;
    }
    return { total: sorted.length, n50, n80, n90, grand: total };
  }, [rows, totalValue]);

  if (loading || !stats || !stats.total) return null;
  const colors = { strong: '#C0392B', medium: '#E74C3C', soft: '#F87171' };
  const Slice = ({ n, of, pct, label, tone }) => (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800,
          color: 'var(--text-primary)', letterSpacing: '-0.025em' }}>{n}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>/ {of}</span>
        <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700,
          color: colors[tone], letterSpacing: '0.04em' }}>({pct}%)</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: colors[tone],
          borderRadius: 999, transition: 'width 800ms cubic-bezier(0.16,1,0.3,1)' }} />
      </div>
    </div>
  );
  return (
    <div style={{
      position: 'relative',
      background: 'linear-gradient(135deg, rgba(192,57,43,0.04), rgba(231,76,60,0.04))',
      border: '1px solid rgba(192,57,43,0.18)',
      borderRadius: 16, padding: '20px 24px', marginBottom: 24, overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', right: -40, top: -40, width: 180, height: 180,
        background: 'radial-gradient(circle, rgba(192,57,43,0.10), transparent 70%)', pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(192,57,43,0.10)',
          color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Zap size={18} strokeWidth={2.5} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--accent-primary)' }}>Concentration Reveal</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>
            The 80/20 of your sales
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, position: 'relative' }}>
        <Slice n={stats.n50} of={stats.total} pct={Math.round((stats.n50/stats.total)*100)} label={`${label} drive 50% of sales`} tone="strong" />
        <Slice n={stats.n80} of={stats.total} pct={Math.round((stats.n80/stats.total)*100)} label={`${label} drive 80% of sales`} tone="medium" />
        <Slice n={stats.n90} of={stats.total} pct={Math.round((stats.n90/stats.total)*100)} label={`${label} drive 90% of sales`} tone="soft" />
      </div>
    </div>
  );
}

// ─── TopList — same structure as NetworkPulse, sortable + size-able ────────
function TopList({ title, icon: Icon, rows, loading, renderLeft, renderRight, empty, sortKeyValue = 'value', sortKeyUnits = 'units' }) {
  const [sortBy, setSortBy] = useState('value');
  const [limit, setLimit]   = useState(10);
  const visible = useMemo(() => {
    const key = sortBy === 'units' ? sortKeyUnits : sortKeyValue;
    return [...(rows || [])]
      .sort((a, b) => Number(b?.[key] || 0) - Number(a?.[key] || 0))
      .slice(0, limit);
  }, [rows, sortBy, limit, sortKeyValue, sortKeyUnits]);
  const SelectChip = ({ value, onChange, options }) => (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        height: 26, padding: '0 22px 0 8px',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        borderRadius: 999, fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
        letterSpacing: '0.02em', color: 'var(--text-secondary)', cursor: 'pointer', appearance: 'none',
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%2364748b' stroke-width='1.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 7px center',
      }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      borderRadius: 14, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {Icon && <Icon size={14} style={{ color: 'var(--text-muted)' }} />}
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        <SelectChip value={sortBy} onChange={setSortBy}
          options={[{ value: 'value', label: 'Value' }, { value: 'units', label: 'Units' }]} />
        <SelectChip value={String(limit)} onChange={v => setLimit(Number(v))}
          options={[10, 15, 20].map(n => ({ value: String(n), label: `Top ${n}` }))} />
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
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 8px', borderRadius: 8, transition: 'background 120ms' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <div style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 6,
                background: i < 3 ? 'var(--accent-glow)' : 'var(--bg-elevated)',
                color: i < 3 ? 'var(--accent-primary)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 800,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>{renderLeft(r)}</div>
              <div style={{ flexShrink: 0 }}>{renderRight(r)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Channel mix horizontal bars ────────────────────────────────────────────
function ChannelMixBars({ rows, totalValue, loading }) {
  const total = totalValue || (rows || []).reduce((s, r) => s + Number(r.value || 0), 0);
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      borderRadius: 14, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Layers size={14} style={{ color: 'var(--text-muted)' }} />
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: 'var(--text-muted)' }}>Channels — sales mix</span>
      </div>
      {loading && <div className="skeleton" style={{ height: 100, borderRadius: 8 }} />}
      {!loading && (!rows || rows.length === 0) && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No channels match</div>
      )}
      {!loading && rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((c, i) => {
            const pct = total ? (Number(c.value || 0) / total) * 100 : 0;
            const color = i === 0 ? '#7C3AED' : i === 1 ? '#0284C7' : '#059669';
            return (
              <div key={i}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{c.channel}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                    {fmtRs(c.value)} · {pct.toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 999,
                    transition: 'width 700ms cubic-bezier(0.16,1,0.3,1)' }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-disabled)', marginTop: 3, fontWeight: 600 }}>
                  {fmtNum(c.units)} units · {fmtNum(c.transactions)} txns
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Action panel — high-return SKUs + slow movers + dead-on-arrival ───────
function ActionPanel({ summary, byColor, byStore, allStores, loading }) {
  // High-return SKUs — colours where return % is highest (≥ 5 returns)
  const highReturnColors = useMemo(() => {
    return [...(byColor || [])]
      .filter(c => Number(c.return_units || 0) >= 5)
      .map(c => ({
        ...c,
        return_rate: Number(c.units || 0) > 0
          ? (Number(c.return_units || 0) / Number(c.units || 0)) * 100 : 0,
      }))
      .sort((a, b) => b.return_rate - a.return_rate)
      .slice(0, 5);
  }, [byColor]);

  // Slow stores — bottom 5 by net value, but with > 0 sales (excludes dead)
  const slowStores = useMemo(() => {
    return [...(allStores || [])]
      .filter(r => Number(r.units || 0) > 0)
      .sort((a, b) => Number(a.value || 0) - Number(b.value || 0))
      .slice(0, 5);
  }, [allStores]);

  const Card = ({ accent, tint, border, icon: Icon, title, headline, bullets, cta }) => (
    <div style={{ position: 'relative', background: tint, border: `1px solid ${border}`,
      borderRadius: 14, padding: '16px 18px',
      transition: 'all 220ms cubic-bezier(0.4,0,0.2,1)', overflow: 'hidden' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = `0 10px 24px ${border}`; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none'; }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: '#fff',
          color: accent, border: `1px solid ${border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={16} strokeWidth={2.5} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: accent }}>{title}</span>
      </div>
      {loading
        ? <div className="skeleton" style={{ height: 28, width: '60%', marginBottom: 12 }} />
        : <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800,
            color: 'var(--text-primary)', letterSpacing: '-0.025em', marginBottom: 10 }}>{headline}</div>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0,
        display: 'flex', flexDirection: 'column', gap: 4 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: accent, flexShrink: 0 }} />
            {b}
          </li>
        ))}
      </ul>
      {cta && (
        <button type="button" style={{ marginTop: 12,
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'transparent', border: 'none', color: accent, cursor: 'pointer',
          fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 800,
          letterSpacing: '0.04em', textTransform: 'uppercase', padding: 0 }}>
          {cta} <ChevronRight size={12} strokeWidth={3} />
        </button>
      )}
    </div>
  );

  const overallRate = summary?.return_rate_pct ?? 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
      <Card
        accent="#DC2626" tint="rgba(220,38,38,0.05)" border="rgba(220,38,38,0.20)"
        icon={RotateCcw}
        title="Returns rate (period)"
        headline={overallRate + '%'}
        bullets={[
          `${fmtNum(summary?.return_units)} units returned · ${fmtRs(summary?.return_value)} value`,
          highReturnColors[0] ? `Top return shade: ${highReturnColors[0].color_name} (${highReturnColors[0].return_rate.toFixed(1)}%)` : 'No high-return shades',
          overallRate >= 5 ? 'High friction — investigate fit/quality' : 'Within healthy band',
        ]}
        cta="Investigate"
      />
      <Card
        accent="#D97706" tint="rgba(217,119,6,0.05)" border="rgba(217,119,6,0.22)"
        icon={AlertTriangle}
        title="High-return shades (≥ 5 returns)"
        headline={fmtNum(highReturnColors.length)}
        bullets={
          highReturnColors.length > 0
            ? highReturnColors.slice(0, 3).map(c => `${c.color_name} — ${fmtNum(c.return_units)} returns (${c.return_rate.toFixed(1)}%)`)
            : ['No shades with 5+ returns in this window']
        }
        cta="Review quality"
      />
      <Card
        accent="#7C3AED" tint="rgba(124,58,237,0.05)" border="rgba(124,58,237,0.22)"
        icon={Target}
        title="Slowest selling stores (period)"
        headline={fmtNum(slowStores.length) + ' stores'}
        bullets={
          slowStores.length > 0
            ? slowStores.slice(0, 3).map(s => `${s.loc_name || s.loc_code} — ${fmtRs(s.value)}`)
            : ['Every store moved inventory']
        }
        cta="Plan support"
      />
    </div>
  );
}

// ─── Main SalesPulse component ─────────────────────────────────────────────
export default function SalesPulse({ data, loading, lensMode = 'net', dateFrom, dateTo }) {
  const s = data?.summary || {};
  const byChannel = data?.by_channel || []; // backend optional; falls back if absent

  // Lens-aware values — same pattern as the parent's KPI cards.
  const lens = lensMode || 'net';
  const lensLabel = lens === 'sale' ? 'Sales' : lens === 'return' ? 'Returns' : 'Net';
  const lensColor = lens === 'sale' ? '#2563EB' : lens === 'return' ? '#F43F5E' : '#059669';
  const units = lens === 'sale' ? Number(s.units_sold||0)
              : lens === 'return' ? Number(s.return_units||0)
              : Number(s.net_units||0);
  const value = lens === 'sale' ? Number(s.sales_value||0)
              : lens === 'return' ? Number(s.return_value||0)
              : Number(s.net_value||0);
  const txns  = lens === 'sale' ? Number(s.sales_txns||0)
              : lens === 'return' ? Number(s.return_txns||0)
              : Number(s.sales_txns||0) - Number(s.return_txns||0);

  const avgPerTxn = txns ? Math.round(value / txns) : 0;
  const skuCount  = Number(s.unique_skus_sold || 0);
  const dailyAvg  = Number(s.active_days || 0) > 0 ? Math.round(units / Number(s.active_days)) : 0;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* ── Header strip ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkles size={14} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--text-muted)' }}>Sales Pulse</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 10px', background: `${lensColor}14`,
            border: `1px solid ${lensColor}33`, color: lensColor,
            borderRadius: 999, fontSize: 11, fontWeight: 800, letterSpacing: '0.04em' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: lensColor }} />
            {lensLabel}
          </span>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', background: 'rgba(2,132,199,0.08)',
          color: 'var(--sky)', border: '1px solid rgba(2,132,199,0.20)',
          borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
          <Calendar size={11} />
          {dateFrom} → {dateTo}
        </div>
      </div>

      {/* ── HERO KPI STRIP ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 14, marginBottom: 24 }}>
        <KpiHero
          label={`${lensLabel} — Units`}
          icon={ShoppingBag} accent={lensColor}
          value={units} loading={loading}
          context={`${fmtNum(skuCount)} unique SKUs · avg ${fmtNum(dailyAvg)}/day`}
        />
        <KpiHero
          label={`${lensLabel} — Revenue`}
          icon={IndianRupee} accent={lensColor}
          value={value} format="indian" prefix="₹" loading={loading}
          context={`avg ₹${fmtNum(avgPerTxn)} per txn`}
        />
        <KpiHero
          label="Returns Rate"
          icon={RotateCcw} accent={Number(s.return_rate_pct) >= 5 ? '#DC2626' : '#D97706'}
          value={Number(s.return_rate_pct || 0)} format="indian" suffix="%" loading={loading}
          context={`${fmtNum(s.return_units)} returns · ${fmtRs(s.return_value)}`}
        />
        <KpiHero
          label="Active Days"
          icon={Calendar} accent="#0284C7"
          value={Number(s.active_days || 0)} loading={loading}
          context={`${fmtNum(s.stores_with_sales)} stores recorded sales`}
        />
        <KpiHero
          label="Net Stock Today"
          icon={TrendingUp} accent="#7C3AED"
          value={Number(data?.stock_snapshot?.total_units || 0)} loading={loading}
          context={`MRP: ${fmtRs(data?.stock_snapshot?.total_mrp_value)}`}
        />
      </div>

      {/* ── Pareto Reveal — top SKUs / colours that drive sales ──────── */}
      <SalesPareto rows={data?.by_color || []} totalValue={value} label="shades" loading={loading} />

      {/* ── "Where's my revenue?" row — top stores + top shades + channels ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr', gap: 14, marginBottom: 24 }}>
        <TopList
          title={`Top Stores by ${lensLabel}`}
          icon={Building2}
          rows={data?.all_stores || []}
          loading={loading}
          renderLeft={(r) => (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {r.loc_name || r.loc_code}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {r.loc_code} · {r.city || '—'}, {r.state || '—'} · {r.channel || '—'}
              </div>
            </>
          )}
          renderRight={(r) => (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{fmtRs(r.value)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtNum(r.units)} units</div>
            </div>
          )}
          empty="No stores match the current filters"
        />
        <TopList
          title="Top Shades"
          icon={Award}
          rows={data?.by_color || []}
          loading={loading}
          sortKeyValue="value" sortKeyUnits="units"
          renderLeft={(r) => (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {r.color_name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtNum(r.transactions)} txns · {fmtNum(r.return_units)} returns
              </div>
            </>
          )}
          renderRight={(r) => (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{fmtRs(r.value)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtNum(r.units)} units</div>
            </div>
          )}
          empty="No shades match"
        />
        <ChannelMixBars rows={byChannel} totalValue={value} loading={loading} />
      </div>

      {/* ── Action Panel — what to act on right now ───────────────────── */}
      <ActionPanel
        summary={s}
        byColor={data?.by_color || []}
        byStore={data?.by_store || []}
        allStores={data?.all_stores || []}
        loading={loading}
      />
    </div>
  );
}
