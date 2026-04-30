// ─── PremiumKpi — elite-tier KPI card with breakdown chips ──────────────────
// World-best dashboards (Stripe, Linear, Notion analytics) don't just show ONE
// number — they show the headline number with the most relevant breakdowns
// inline. A user looking at "Total Stock 9.14L" instantly wants to know "how
// much is sitting in CLOSED stores?" without clicking anywhere.
//
// This component delivers that:
//   • Big, bold headline number (CountUp-animated)
//   • Up to 3 inline "breakdown chips" with their own count + percentage
//   • Hover lift + glow, gradient top border, color-coded per metric
//   • Optional context line (date, last updated) at the bottom
//   • Optional trend pill (▲ ▼) when delta is provided
//   • Skeleton during load that matches the eventual layout
//
// Designed to be self-contained so any page can drop it in without ceremony.

import { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

const PRESETS = {
  slate:   { color: '#0f172a', bg: 'rgba(15,23,42,0.06)',   border: 'rgba(15,23,42,0.10)',   gradient: 'linear-gradient(135deg, #0f172a, #475569)' },
  brand:   { color: '#C0392B', bg: 'rgba(192,57,43,0.07)',  border: 'rgba(192,57,43,0.18)',  gradient: 'linear-gradient(135deg, #C0392B, #E74C3C)' },
  emerald: { color: '#059669', bg: 'rgba(5,150,105,0.08)',  border: 'rgba(5,150,105,0.20)',  gradient: 'linear-gradient(135deg, #10b981, #059669)' },
  sky:     { color: '#0284C7', bg: 'rgba(2,132,199,0.08)',  border: 'rgba(2,132,199,0.20)',  gradient: 'linear-gradient(135deg, #0ea5e9, #0284c7)' },
  amber:   { color: '#D97706', bg: 'rgba(217,119,6,0.08)',  border: 'rgba(217,119,6,0.20)',  gradient: 'linear-gradient(135deg, #f59e0b, #d97706)' },
  violet:  { color: '#7C3AED', bg: 'rgba(124,58,237,0.08)', border: 'rgba(124,58,237,0.20)', gradient: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' },
  teal:    { color: '#0D9488', bg: 'rgba(13,148,136,0.08)', border: 'rgba(13,148,136,0.20)', gradient: 'linear-gradient(135deg, #14b8a6, #0d9488)' },
};

// Smooth integer count-up. First mount → snap. After that → animate.
function useCountUp(value, duration = 750) {
  const [n, setN] = useState(value);
  const fromRef   = useRef(value);
  const rafRef    = useRef(null);
  const mounted   = useRef(false);

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

// Format helpers — Lakhs / Crores Indian convention.
function fmtIndian(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Math.abs(n);
  if (v >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (v >= 100000)   return (n / 100000).toFixed(2) + ' L';
  if (v >= 1000)     return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString('en-IN');
}
function fmtPct(part, total) {
  if (!total) return '0%';
  return Math.round((part / total) * 100) + '%';
}

export default function PremiumKpi({
  label,
  value,                  // headline number
  format = 'indian',      // 'indian' | 'plain' | 'string'
  icon: Icon,
  accent = 'slate',
  breakdowns = [],        // [{ label, value, color, total? }] — total optional, defaults to value
  context,                // bottom-line context (e.g. "as of Feb 1, 2026")
  loading = false,
  delta,                  // number — % change vs prior period
  highlight = false,      // emphasised border for "primary" KPI
}) {
  const preset = PRESETS[accent] || PRESETS.slate;
  const animate = !loading && typeof value === 'number' && format !== 'string';
  const shown   = useCountUp(animate ? value : null, 750);

  const headline = loading ? null
    : format === 'string' ? value
    : format === 'indian' ? fmtIndian(animate ? Math.round(shown) : value)
    : (animate ? Math.round(shown) : Number(value)).toLocaleString('en-IN');

  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--bg-card)',
        border: `1px solid ${highlight ? preset.border : 'var(--border-subtle)'}`,
        borderRadius: 16,
        padding: '18px 20px 16px',
        overflow: 'hidden',
        transition: 'all 240ms cubic-bezier(0.4,0,0.2,1)',
        boxShadow: highlight ? '0 1px 3px rgba(15,23,42,0.04), 0 4px 16px rgba(15,23,42,0.05)' : '0 1px 2px rgba(15,23,42,0.03)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.boxShadow = `0 10px 30px rgba(15,23,42,0.10), 0 0 0 1px ${preset.border}`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = highlight ? '0 1px 3px rgba(15,23,42,0.04), 0 4px 16px rgba(15,23,42,0.05)' : '0 1px 2px rgba(15,23,42,0.03)';
      }}
    >
      {/* Top gradient accent rail */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: preset.gradient, borderRadius: '16px 16px 0 0',
      }} />

      {/* Header row — label + icon + delta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, marginTop: 4 }}>
        {Icon && (
          <div style={{
            width: 32, height: 32, borderRadius: 9,
            background: preset.bg,
            border: `1px solid ${preset.border}`,
            color: preset.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={16} strokeWidth={2} />
          </div>
        )}
        <span style={{
          fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
          color: 'var(--text-muted)', textTransform: 'uppercase',
          letterSpacing: '0.07em', flex: 1,
        }}>{label}</span>
        {delta != null && !loading && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 7px', borderRadius: 999,
            background: delta >= 0 ? 'var(--mint-glow)' : 'var(--coral-glow)',
            color:      delta >= 0 ? 'var(--mint)'      : 'var(--coral)',
            fontSize: 11, fontWeight: 700,
          }}>
            {delta >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {Math.abs(delta)}%
          </span>
        )}
      </div>

      {/* Headline number */}
      {loading ? (
        <div className="skeleton" style={{ height: 36, width: '70%', marginBottom: 10 }} />
      ) : (
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 30, fontWeight: 800,
          color: 'var(--text-primary)',
          lineHeight: 1.02, letterSpacing: '-0.025em',
          marginBottom: breakdowns.length > 0 ? 12 : 6,
        }}>{headline ?? '—'}</div>
      )}

      {/* Breakdown chips */}
      {!loading && breakdowns.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6,
          marginBottom: context ? 8 : 0,
        }}>
          {breakdowns.map((b, i) => {
            // Only compute % if `total` is explicitly supplied AND it's a
            // meaningful denominator (i.e. b.value is a part of b.total).
            // Avoids NaN% on orthogonal metrics (e.g. Avg / Top channel).
            const showPct = b.total != null && Number(b.total) > 0 && typeof b.value === 'number';
            const pct = showPct ? fmtPct(b.value, b.total) : null;
            return (
              <div key={i}
                title={pct ? `${b.label}: ${pct}` : b.label}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 9px', borderRadius: 999,
                  background: b.color ? `${b.color}14` : 'var(--bg-elevated)',
                  border: `1px solid ${b.color ? `${b.color}33` : 'var(--border-subtle)'}`,
                }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: b.color || 'var(--text-muted)',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600,
                  color: 'var(--text-muted)',
                }}>{b.label}</span>
                <span style={{
                  fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 800,
                  color: 'var(--text-primary)',
                  letterSpacing: '-0.01em',
                }}>{typeof b.value === 'number' ? fmtIndian(b.value) : (b.value ?? '—')}</span>
                {pct && (
                  <span style={{
                    fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700,
                    color: 'var(--text-disabled)',
                  }}>· {pct}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Context line (small, bottom) */}
      {context && (
        <div style={{
          fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 500,
          color: 'var(--text-disabled)',
          marginTop: 4,
        }}>{context}</div>
      )}
    </div>
  );
}
