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
  // Skeleton ONLY when we have nothing to display (cold load). During a
  // mode/filter refetch we keep showing the previous value so toggling
  // Active ↔ Inactive ↔ All never blanks the hero to a pulsing placeholder.
  const hasValue   = value !== null && value !== undefined && value !== '';
  const showSkel   = loading && !hasValue;
  const animate    = !showSkel && typeof value === 'number';
  const shown      = useCountUp(animate ? value : null, 720);
  // For percentage cards keep one decimal so 3.4% doesn't read as "3%".
  // For Indian-format big numbers we still show K/L/Cr — the raw figure
  // is exposed via the hover tooltip below.
  const isPct = suffix === '%';
  const display    = showSkel ? null
    : format === 'string'  ? value
    : format === 'indian'  && isPct
      ? prefix + (animate ? (Math.round(shown * 10) / 10).toFixed(1) : Number(value).toFixed(1)) + suffix
    : format === 'indian'
      ? prefix + fmtL(animate ? Math.round(shown) : value) + suffix
    : (prefix + (animate ? Math.round(shown) : Number(value)).toLocaleString('en-IN') + suffix);
  // Hover tooltip — show the precise raw figure (full Indian-localised
  // number with commas) so a user hovering on "5.40 L" sees "5,40,000".
  const rawTooltip = (typeof value === 'number')
    ? prefix + Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + suffix
    : (value != null ? String(value) : '');
  return (
    <div
      className="sx-card sales-kpi-card"
      style={{
        position: 'relative',
        padding: '20px 22px 18px',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Whisper-thin accent rail at the top edge — communicates the lens
          colour without shouting. 2px not 3px; corners hugged via radius. */}
      <div style={{ position: 'absolute', top: 0, left: 14, right: 14, height: 2,
        background: `linear-gradient(90deg, ${accent}, ${accent}cc)`,
        borderRadius: '2px', opacity: 0.85 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, marginTop: 4 }}>
        {Icon && (
          <div style={{ width: 30, height: 30, borderRadius: 9,
            background: `${accent}10`,
            color: accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon size={15} strokeWidth={2} />
          </div>
        )}
        <span style={{
          fontFamily: 'var(--font-body)',
          fontSize: 12.5, fontWeight: 800, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: 'var(--text-secondary)',
        }}>{label}</span>
      </div>
      {showSkel ? (
        <div className="sx-shimmer" style={{ height: 36, width: '70%', marginBottom: 10, borderRadius: 6 }} />
      ) : (
        <div className="sx-hero-num"
          title={rawTooltip}
          style={{ marginBottom: 8, fontSize: 32, cursor: 'help' }}>
          {display ?? '—'}
        </div>
      )}
      {context && (
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)',
          letterSpacing: '0.005em', lineHeight: 1.45,
        }}>{context}</div>
      )}
    </div>
  );
}

// ─── Pareto Reveal — "X SKUs drive 50% of sales" ────────────────────────────
function SalesPareto({ rows, totalValue, label = 'SKUs', loading }) {
  const stats = useMemo(() => {
    const v = (r) => Number(r.sales_value ?? r.value ?? 0);
    const sorted = [...(rows || [])].sort((a, b) => v(b) - v(a));
    const total = totalValue || sorted.reduce((s, r) => s + v(r), 0);
    if (!total) return null;
    let cum = 0, n50 = 0, n80 = 0, n90 = 0;
    for (let i = 0; i < sorted.length; i++) {
      cum += v(sorted[i]);
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
      <div className="sx-mobile-three-grid sales-pareto-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, position: 'relative' }}>
        <Slice n={stats.n50} of={stats.total} pct={Math.round((stats.n50/stats.total)*100)} label={`${label} drive 50% of sales`} tone="strong" />
        <Slice n={stats.n80} of={stats.total} pct={Math.round((stats.n80/stats.total)*100)} label={`${label} drive 80% of sales`} tone="medium" />
        <Slice n={stats.n90} of={stats.total} pct={Math.round((stats.n90/stats.total)*100)} label={`${label} drive 90% of sales`} tone="soft" />
      </div>
    </div>
  );
}

// ─── TopList — same structure as NetworkPulse, sortable + size-able ────────
// Direction toggle (Top vs Bottom) lets the user pivot from "best 10 stores"
// to "worst 10 stores" with one click — same data, just sorted ASC instead
// of DESC. Worst-N is the canonical CFO ask for finding under-performers.
function TopList({ title, icon: Icon, rows, loading, renderLeft, renderRight, empty, sortKeyValue = 'value', sortKeyUnits = 'units', onRowClick }) {
  const [sortBy,   setSortBy]   = useState('value');
  const [limit,    setLimit]    = useState(10);
  const [direction, setDirection] = useState('top'); // 'top' | 'bottom'
  const visible = useMemo(() => {
    const key = sortBy === 'units' ? sortKeyUnits : sortKeyValue;
    const sorted = [...(rows || [])].sort((a, b) =>
      direction === 'bottom'
        ? Number(a?.[key] || 0) - Number(b?.[key] || 0)
        : Number(b?.[key] || 0) - Number(a?.[key] || 0)
    );
    // For bottom view, hide rows that are completely zero (e.g. stores with
    // zero sales in the window) since "0 / 0 / 0" rows are noise; the user
    // wants the lowest non-zero performers. Top view always shows everything.
    const filtered = direction === 'bottom'
      ? sorted.filter(r => Number(r?.[key] || 0) > 0)
      : sorted;
    return filtered.slice(0, limit);
  }, [rows, sortBy, limit, direction, sortKeyValue, sortKeyUnits]);
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
    <div className="sx-card sales-rank-card" style={{ padding: '18px 20px 16px' }}>
      {/* Header — title on row 1, controls on row 2. Two-row layout keeps the
          title readable even when the parent column is narrow (the Shades
          column is 1.2fr and was wrapping the title to 4 lines when 3 chips
          were stuffed onto the same row). */}
      <div className="sales-rank-card__header" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
        <div className="sales-rank-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {Icon && <Icon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.07em',
            textTransform: 'uppercase', color: 'var(--text-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            flex: 1, minWidth: 0,
          }} title={title}>{title}</span>
        </div>
        <div className="sales-rank-card__controls" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <SelectChip value={direction} onChange={setDirection}
            options={[{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }]} />
          <SelectChip value={sortBy} onChange={setSortBy}
            options={[{ value: 'value', label: 'Value' }, { value: 'units', label: 'Units' }]} />
          <SelectChip value={String(limit)} onChange={v => setLimit(Number(v))}
            options={[10, 15, 20, 25, 50].map(n => ({
              value: String(n), label: `${direction === 'bottom' ? 'Worst' : 'Top'} ${n}`,
            }))} />
        </div>
      </div>
      {/* Skeleton ONLY on cold load. Refetch keeps prior rows visible. */}
      {loading && visible.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[0,1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 36, borderRadius: 6 }} />)}
        </div>
      )}
      {!loading && visible.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{empty}</div>
      )}
      {visible.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {visible.map((r, i) => (
            <div key={i}
              className="sales-rank-row"
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              title={onRowClick ? 'Open drilldown' : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 8px', borderRadius: 8, transition: 'background 120ms',
              cursor: onRowClick ? 'pointer' : 'default' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              {/* Top 3 badges glow accent (gold-ish); Worst 3 badges glow red
                  so the bottom view reads as a problem signal at a glance. */}
              <div className="sales-rank-row__index" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 6,
                background: i < 3
                  ? (direction === 'bottom' ? 'rgba(220,38,38,0.12)' : 'var(--accent-glow)')
                  : 'var(--bg-elevated)',
                color: i < 3
                  ? (direction === 'bottom' ? '#DC2626' : 'var(--accent-primary)')
                  : 'var(--text-muted)',
                fontSize: 11, fontWeight: 800,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
              <div className="sales-rank-row__main" style={{ flex: 1, minWidth: 0 }}>{renderLeft(r)}</div>
              <div className="sales-rank-row__metric" style={{ flexShrink: 0 }}>{renderRight(r)}</div>
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
    <div className="sx-card sales-channel-card" style={{ padding: '18px 20px 16px' }}>
      <div className="sales-channel-card__header" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Layers size={13} strokeWidth={2.2} style={{ color: 'var(--text-muted)' }} />
        <span className="sx-eyebrow">Channels — sales mix</span>
      </div>
      {/* Skeleton ONLY on cold load. Refetch keeps prior bars visible. */}
      {loading && (!rows || rows.length === 0) && <div className="sx-shimmer" style={{ height: 100, borderRadius: 10 }} />}
      {!loading && (!rows || rows.length === 0) && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>No channels match</div>
      )}
      {rows && rows.length > 0 && (
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
  // High-return SKUs — shades where return % is highest (≥ 5 returns).
  // by_color now ships with `return_qty` so this is real data.
  const highReturnColors = useMemo(() => {
    return [...(byColor || [])]
      .filter(c => Number(c.return_qty || 0) >= 5)
      .map(c => ({
        ...c,
        return_rate: Number(c.units_sold || 0) > 0
          ? (Number(c.return_qty || 0) / Number(c.units_sold || 0)) * 100 : 0,
      }))
      .sort((a, b) => b.return_rate - a.return_rate)
      .slice(0, 5);
  }, [byColor]);

  // Slow stores — bottom 5 by sales_value with > 0 sales (excludes dead).
  const slowStores = useMemo(() => {
    return [...(allStores || [])]
      .filter(r => Number(r.units_sold || 0) > 0)
      .sort((a, b) => Number(a.sales_value || 0) - Number(b.sales_value || 0))
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
        <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--bg-elevated)',
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
    <div className="sx-mobile-card-grid sales-action-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
      <Card
        accent="#DC2626" tint="rgba(220,38,38,0.05)" border="rgba(220,38,38,0.20)"
        icon={RotateCcw}
        title="Returns rate (period)"
        headline={overallRate + '%'}
        bullets={[
          `${fmtNum(summary?.return_units)} units returned · ${fmtRs(summary?.return_value)} value`,
          highReturnColors[0] ? `Top return shade: ${highReturnColors[0].color_name} (${highReturnColors[0].return_rate.toFixed(1)}%)` : 'No high-return shades in scope',
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
            ? highReturnColors.slice(0, 3).map(c => `${c.color_name} — ${fmtNum(c.return_qty)} returns (${c.return_rate.toFixed(1)}%)`)
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
            ? slowStores.slice(0, 3).map(s => `${s.location_name || s.location_code} — ${fmtRs(s.sales_value)}`)
            : ['Every store moved inventory']
        }
        cta="Plan support"
      />
    </div>
  );
}

// ─── SalesPulseTables — the bottom row, exported separately so it can sit
// BELOW the legacy KPI cards (Sales Transactions / Units / Net Revenue /
// Returns / Stock) on the page instead of immediately under the hero strip.
// Driven by the SAME `data` prop as SalesPulse → narrows with every filter.
export function SalesPulseTables({ data, loading, lensMode = 'net', valuation = 'gross', onStoreClick }) {
  const s = data?.summary || {};
  const lens = lensMode || 'net';
  const lensLabel = lens === 'sale' ? 'Sales' : lens === 'return' ? 'Returns' : 'Net';
  const valuationResolved = resolveValuation(s, lens, valuation);
  const value = valuationResolved.value;
  const valuationKind  = valuationResolved.kind;
  const valuationLabel = valuationResolved.label;

  // Build a derived "value" field per row matching the chosen lens ×
  // valuation combo. Now lens-aware so picking Return → Top Stores ranks by
  // most-returned-revenue stores (or returned-units when sort=Units). Net
  // mode picks sales − returns. Includes _saleVal / _returnVal so the
  // sub-line under the value can show context.
  const _enrichRows = (rows) => (rows || []).map(r => {
    const saleVal   = rowValuation(r, valuation, 'sale');
    const returnVal = rowValuation(r, valuation, 'return');
    const lensVal   = rowValuation(r, valuation, lens);
    const lensUnits = lens === 'return' ? Number(r.return_qty || 0)
                    : lens === 'net'    ? Number(r.units_sold || 0) - Number(r.return_qty || 0)
                    : Number(r.units_sold || 0);
    return { ...r, _val: lensVal, _saleVal: saleVal, _returnVal: returnVal, _units: lensUnits };
  });
  // Memoize per-array so toggling lens doesn't re-map on unrelated renders.
  const enrichedStores   = useMemo(() => _enrichRows(data?.all_stores),  // eslint-disable-line react-hooks/exhaustive-deps
    [data?.all_stores,  lens, valuation]); // eslint-disable-line react-hooks/exhaustive-deps
  const enrichedColors   = useMemo(() => _enrichRows(data?.by_color),    // eslint-disable-line react-hooks/exhaustive-deps
    [data?.by_color,    lens, valuation]); // eslint-disable-line react-hooks/exhaustive-deps
  const enrichedChannels = useMemo(() => _enrichRows(data?.by_channel),  // eslint-disable-line react-hooks/exhaustive-deps
    [data?.by_channel,  lens, valuation]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatRowValue = (val) => valuationKind === 'pct' ? `${val.toFixed(1)}%` : fmtRs(val);

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="sx-mobile-three-grid sales-pulse-tables-grid" style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr', gap: 14 }}>
        <TopList
          title={`Top Stores · ${lensLabel} ${valuationLabel}`}
          icon={Building2}
          rows={enrichedStores}
          loading={loading}
          onRowClick={onStoreClick ? (r) => onStoreClick(r.location_id) : null}
          renderLeft={(r) => (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {r.location_name || r.location_code}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {r.location_code} · {r.city || '—'}, {r.state || '—'} · {r.channel || '—'}
              </div>
            </>
          )}
          renderRight={(r) => {
            // Units displayed match the lens — Return mode shows return units,
            // Net shows sales − returns.
            const lensUnits = lens === 'return' ? Number(r.return_qty || 0)
                            : lens === 'net'    ? Number(r.units_sold || 0) - Number(r.return_qty || 0)
                            : Number(r.units_sold || 0);
            return (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 800, fontSize: 13.5 }}>{formatRowValue(r._val)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtNum(lensUnits)} {lens === 'return' ? 'returns' : 'units'}</div>
              </div>
            );
          }}
          sortKeyValue="_val" sortKeyUnits="_units"
          empty="No stores match the current filters"
        />
        <TopList
          title={`Top Shades · ${lensLabel} ${valuationLabel}`}
          icon={Award}
          rows={enrichedColors}
          loading={loading}
          sortKeyValue="_val" sortKeyUnits="_units"
          renderLeft={(r) => (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {r.color_name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtNum(r.transactions)} txns · {fmtNum(r.return_qty)} returns
              </div>
            </>
          )}
          renderRight={(r) => {
            // Units displayed match the lens — Return mode shows return units,
            // Net shows sales − returns.
            const lensUnits = lens === 'return' ? Number(r.return_qty || 0)
                            : lens === 'net'    ? Number(r.units_sold || 0) - Number(r.return_qty || 0)
                            : Number(r.units_sold || 0);
            return (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 800, fontSize: 13.5 }}>{formatRowValue(r._val)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtNum(lensUnits)} {lens === 'return' ? 'returns' : 'units'}</div>
              </div>
            );
          }}
          empty="No shades match"
        />
        <ChannelMixBars rows={enrichedChannels.map(c => ({ ...c, value: c._val }))} totalValue={value} loading={loading} />
      </div>
    </div>
  );
}

// ─── Valuation lens resolver ─────────────────────────────────────────────
// The user picks one of 8 lenses; this returns the right ₹ figure for the
// (Sale/Return/Net) movement type. Margin% is special — returns a percent
// not a rupee figure — so the caller knows whether to render with a ₹ or %.
function resolveValuation(s, sale_mode, valuation) {
  const sm = sale_mode || 'net';
  const v  = valuation || 'gross';
  const pickByMode = (saleK, retK, netK) =>
    Number(s?.[sm === 'sale' ? saleK : sm === 'return' ? retK : netK] || 0);
  switch (v) {
    case 'gross':   return { kind: 'rupee', value: pickByMode('sales_value','return_value','net_gross_value'), label: 'Gross (with GST)' };
    case 'ex_gst':  return { kind: 'rupee', value: pickByMode('sales_ex_gst_value','return_ex_gst_value','net_ex_gst_value'), label: 'Ex-GST revenue' };
    case 'gst':     return { kind: 'rupee', value: pickByMode('sales_gst_collected','return_gst_collected','net_gst_collected'), label: 'GST collected' };
    case 'mrp':     return { kind: 'rupee', value: pickByMode('sales_mrp_value','return_mrp_value','net_mrp_value'), label: 'At MRP' };
    case 'discount': {
      const mrp   = pickByMode('sales_mrp_value','return_mrp_value','net_mrp_value');
      const gross = pickByMode('sales_value','return_value','net_gross_value');
      return { kind: 'rupee', value: Math.max(0, mrp - gross), label: 'Discount given' };
    }
    case 'cogs':    return { kind: 'rupee', value: pickByMode('sales_cogs_value','return_cogs_value','net_cogs_value'), label: 'COGS (cost basis)' };
    case 'margin':  return { kind: 'rupee', value: Number(sm === 'net' ? s?.net_margin_value : s?.sales_margin_value || 0), label: 'Gross Margin' };
    case 'margin_pct': return { kind: 'pct', value: Number(sm === 'net' ? s?.net_margin_pct : s?.sales_margin_pct || 0), label: 'Margin %' };
    default:        return { kind: 'rupee', value: pickByMode('sales_value','return_value','net_gross_value'), label: 'Gross' };
  }
}

// Pick the right ₹ field on a row aggregate (by_color/by_store/etc.) for
// the chosen lens × valuation combo. Now lens-aware: Return mode picks
// return-side fields (so "most-returned stores" actually ranks by returns),
// Net mode picks sales − returns, Sale mode picks sales-side. The backend
// ships return_value, return_mrp_value, return_gst_collected,
// return_ex_gst_value alongside the sales-side columns on every aggregate.
function rowValuation(r, valuation, lensMode = 'sale') {
  const lm = lensMode || 'sale';
  // Sale-side picker
  const saleVal = (() => {
    switch (valuation) {
      case 'ex_gst':     return Number(r?.ex_gst_value || 0);
      case 'gst':        return Number(r?.gst_collected || 0);
      case 'mrp':        return Number(r?.mrp_value || 0);
      case 'discount':   return Math.max(0, Number(r?.mrp_value || 0) - Number(r?.sales_value || 0));
      case 'cogs':       return Number(r?.cogs_value || 0);
      case 'margin':     return Number(r?.sales_value || 0) - Number(r?.cogs_value || 0);
      case 'margin_pct': {
        const sv = Number(r?.sales_value || 0);
        const cogs = Number(r?.cogs_value || 0);
        return sv > 0 ? Math.round(((sv - cogs) / sv) * 1000) / 10 : 0;
      }
      case 'gross':
      default:           return Number(r?.sales_value || 0);
    }
  })();
  // Return-side picker. cogs/margin/margin_pct fall back to sale-side since
  // the breakdown rows don't ship return cogs (a real-world cost-of-returns
  // signal would need RMA-side cost; out of scope for a UI flip).
  const returnVal = (() => {
    switch (valuation) {
      case 'ex_gst':     return Number(r?.return_ex_gst_value || 0);
      case 'gst':        return Number(r?.return_gst_collected || 0);
      case 'mrp':        return Number(r?.return_mrp_value || 0);
      case 'discount':   return Math.max(0, Number(r?.return_mrp_value || 0) - Number(r?.return_value || 0));
      case 'cogs':
      case 'margin':
      case 'margin_pct': return saleVal; // fallback
      case 'gross':
      default:           return Number(r?.return_value || 0);
    }
  })();
  if (lm === 'return') return returnVal;
  if (lm === 'net')    return saleVal - returnVal;
  return saleVal;
}

// ─── Main SalesPulse component (top: header + KPIs only) ──────────────────
export default function SalesPulse({ data, loading, lensMode = 'net', valuation = 'gross', dateFrom, dateTo }) {
  const s = data?.summary || {};
  const byChannel = data?.by_channel || []; // backend optional; falls back if absent

  // Lens-aware values — same pattern as the parent's KPI cards.
  const lens = lensMode || 'net';
  const lensLabel = lens === 'sale' ? 'Sales' : lens === 'return' ? 'Returns' : 'Net';
  const lensColor = lens === 'sale' ? '#2563EB' : lens === 'return' ? '#F43F5E' : '#059669';
  const units = lens === 'sale' ? Number(s.units_sold||0)
              : lens === 'return' ? Number(s.return_units||0)
              : Number(s.net_units||0);
  const valuationResolved = resolveValuation(s, lens, valuation);
  const value = valuationResolved.value;
  const valuationKind = valuationResolved.kind;
  const valuationLabel = valuationResolved.label;
  const txns  = lens === 'sale' ? Number(s.sales_txns||0)
              : lens === 'return' ? Number(s.return_txns||0)
              : Number(s.sales_txns||0) - Number(s.return_txns||0);

  const avgPerTxn = txns ? Math.round(value / txns) : 0;
  const skuCount  = Number(s.unique_skus_sold || 0);
  const dailyAvg  = Number(s.active_days || 0) > 0 ? Math.round(units / Number(s.active_days)) : 0;

  return (
    <div className="sales-pulse-section" style={{ marginBottom: 32 }}>
      {/* ── Header strip — refined eyebrow + lens chip + date capsule ── */}
      <div className="sales-pulse-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkles size={13} strokeWidth={2} style={{ color: 'var(--accent-primary)' }} />
          <span className="sx-eyebrow">Sales Pulse</span>
          <span className="sx-pill" style={{
            background: `${lensColor}10`,
            border: `1px solid ${lensColor}26`,
            color: lensColor,
          }}>
            <span className="sx-pill-dot" />
            {lensLabel}
          </span>
        </div>
        <span className="sx-pill" style={{
          background: 'rgba(15, 23, 42, 0.04)',
          border: '1px solid rgba(15, 23, 42, 0.06)',
          color: 'var(--text-muted)',
          fontWeight: 700, letterSpacing: '0.02em', textTransform: 'none', fontSize: 11,
        }}>
          <Calendar size={11} strokeWidth={2.2} />
          {dateFrom} → {dateTo}
        </span>
      </div>

      {/* ── MERGED KPI STRIP — one section, no duplicates ─────────────────
          Single row with the 7 most decision-driving numbers. Lens-aware
          where the metric makes sense; static for what doesn't depend on
          Sale/Return/Net (Returns Rate, Active Days, Best Day, Stock). ── */}
      <div className="sx-mobile-card-grid sales-pulse-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(208px, 1fr))',
        gap: 16, marginBottom: 28 }}>
        <KpiHero
          label={`${lensLabel} — Units`}
          icon={ShoppingBag} accent={lensColor}
          value={units} loading={loading}
          context={`${fmtNum(skuCount)} unique SKUs · avg ${fmtNum(dailyAvg)}/day`}
        />
        <KpiHero
          label={`${lensLabel} — ${valuationLabel}`}
          icon={IndianRupee} accent={lensColor}
          value={value} format="indian"
          prefix={valuationKind === 'pct' ? '' : '₹'}
          suffix={valuationKind === 'pct' ? '%' : ''}
          loading={loading}
          context={
            valuationKind === 'pct'
              ? `gross ₹${fmtL(Number(s.sales_value||0))} − COGS ₹${fmtL(Number(s.sales_cogs_value||0))}`
              : `avg ₹${fmtNum(txns ? Math.round(value / txns) : 0)} per txn`
          }
        />
        <KpiHero
          label={`${lensLabel} — Transactions`}
          icon={Award} accent={lensColor}
          value={txns} loading={loading}
          context={`avg ${fmtNum(s.sales_txns && s.active_days ? Math.round(Number(s.sales_txns)/Number(s.active_days)) : 0)} sale txns/day`}
        />
        {/* Stores KPI — eligible store count under the active filters,
            with sub-line showing how many actually sold in the window.
            Transparent: "284 stores · 275 sold · 9 silent" reveals the gap. */}
        <KpiHero
          label="Stores"
          icon={Building2} accent="#0284C7"
          value={Number(s.eligible_store_count || 0)}
          loading={loading}
          context={(() => {
            const elig   = Number(s.eligible_store_count || 0);
            const sold   = Number(s.stores_with_sales   || 0);
            const silent = Math.max(0, elig - sold);
            return `${fmtNum(sold)} sold · ${silent > 0 ? `${fmtNum(silent)} silent` : 'all active'}`;
          })()}
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
          label="Best Day"
          icon={Zap} accent="#D97706"
          value={(() => {
            const rows = data?.daily || [];
            if (!rows.length) return '—';
            const best = [...rows].sort((a,b) => Number(b.sales_value)-Number(a.sales_value))[0];
            return best ? new Date(best.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' }) : '—';
          })()}
          format="string"
          loading={loading}
          context={(() => {
            const rows = data?.daily || [];
            if (!rows.length) return '';
            const best = [...rows].sort((a,b) => Number(b.sales_value)-Number(a.sales_value))[0];
            return best ? `Peak: ${fmtRs(best.sales_value)} (${fmtNum(best.sales_qty)} units)` : '';
          })()}
        />
        <KpiHero
          label={`Stock as of ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`}
          icon={TrendingUp} accent="#7C3AED"
          value={Number(data?.stock_snapshot?.total_units || 0)} loading={loading}
          context={`MRP: ${fmtRs(data?.stock_snapshot?.total_mrp_value)} · narrows with filters`}
        />
      </div>

      {/* The "Top Stores / Top Shades / Channels" row lives in
          <SalesPulseTables/> (exported separately) so the page can place it
          BELOW the legacy KPI cards. ─────────────────────────────────── */}
    </div>
  );
}
