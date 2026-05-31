// ─── KpiHeroCard — Zone C card.  The replacement for current flat KPIs. ─────
// Layout (top → bottom):
//   1. Top accent rail (3px, color = health)
//   2. Icon + label row
//   3. Hero number (text-4xl tabular-nums) — count-up animated
//      Sparkline (32px tall, no axes) — anchored right
//   4. Delta pill (▲/▼, colored by health) + footnote line
//
// Props are documented inline. All values flow through formatINR/formatPct
// from lib/v2/format.js so a single helper change updates every card.

import { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatINR, formatCompact, formatPct, formatDelta } from '../../lib/v2/format';
import { healthFromDelta, inverseHealthFromDelta, HEALTH_TOKENS } from '../../lib/v2/colors';

// Count-up: 700ms ease-out, respects prefers-reduced-motion.  Anchored on
// fromRef so a value change re-runs from the previous shown number, not 0.
function useCountUp(target, duration = 700) {
  const [n, setN] = useState(target ?? 0);
  const fromRef   = useRef(target ?? 0);
  const rafRef    = useRef(null);
  const mounted   = useRef(false);

  useEffect(() => {
    if (typeof target !== 'number' || Number.isNaN(target)) {
      setN(target); return;
    }
    if (!mounted.current) {
      mounted.current = true; setN(target); fromRef.current = target; return;
    }
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setN(target); fromRef.current = target; return; }

    const from = Number(fromRef.current) || 0;
    const to   = Number(target) || 0;
    const start = performance.now();
    const ease  = t => 1 - Math.pow(1 - t, 3);
    const tick = now => {
      const t = Math.min((now - start) / duration, 1);
      setN(from + (to - from) * ease(t));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else { setN(to); fromRef.current = to; }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return n;
}

// Sparkline — pure inline SVG, no chart lib.  Area fill via linearGradient
// using the health color, line on top, last-point dot.
function Sparkline({ data = [], color, height = 36, width = 110 }) {
  if (!data || data.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 3;
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const idSafeColor = String(color).replace(/[^a-zA-Z0-9]/g, '');
  const lastPt = points.split(' ').pop().split(',');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`spk-${idSafeColor}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`${points} ${(width - pad).toFixed(1)},${height} ${pad},${height}`}
        fill={`url(#spk-${idSafeColor})`} stroke="none"
      />
      <polyline
        points={points} fill="none" stroke={color}
        strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"
      />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="2.6" fill={color} />
    </svg>
  );
}

// Delta pill — neutral dash when no comparison is available.
function DeltaPill({ delta, health, unit = '%' }) {
  const tokens = HEALTH_TOKENS[health] || HEALTH_TOKENS.neutral;
  if (delta == null) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 999,
        background: 'var(--v2-bg-elevated)', color: 'var(--v2-fg-tertiary)',
        fontSize: 11, fontWeight: 700,
        border: '1px solid var(--v2-border)',
      }}>
        <Minus size={11} /> No LY data
      </span>
    );
  }
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  return (
    <span
      title={`Δ ${delta.toFixed(2)}${unit}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 999,
        background: tokens.bg, color: tokens.fg,
        fontSize: 11, fontWeight: 700,
        border: `1px solid ${tokens.fg}`,
      }}
    >
      <Icon size={11} />
      {formatDelta(delta, { unit, decimals: 1 }).replace(/^[▲▼·]\s*/, '')}
    </span>
  );
}

export default function KpiHeroCard({
  label,
  value,
  unit = 'cr',          // 'cr' | 'count' | '%' | 'string'
  delta,                // % vs LY (or last_period); null if not comparable
  deltaUnit = '%',
  inverseHealth = false, // true for return-rate / DoH (lower is better)
  sparkline = [],
  footnote,
  icon: Icon,
  loading = false,
  compareLabel = 'vs LY',
}) {
  // Health drives the rail color, sparkline tint, delta-pill background.
  const health = (inverseHealth ? inverseHealthFromDelta : healthFromDelta)(delta);
  const tokens = HEALTH_TOKENS[health] || HEALTH_TOKENS.neutral;

  const animatedValue = useCountUp(typeof value === 'number' ? value : 0);
  const display = (() => {
    if (loading || value == null) return null;
    const n = typeof value === 'number' ? animatedValue : value;
    if (unit === 'cr')    return formatINR(n);
    if (unit === 'count') return formatCompact(n);
    if (unit === '%')     return formatPct(n, { decimals: 1 });
    return String(value);
  })();

  if (loading) return <KpiHeroCardSkeleton label={label} icon={Icon} />;

  return (
    <div
      className="v2-card"
      style={{
        position: 'relative',
        padding: '18px 20px 16px',
        overflow: 'hidden',
        animation: 'v2FadeInUp 380ms var(--v2-ease) both',
        cursor: 'default',
      }}
    >
      {/* Top accent rail — health-driven */}
      <div
        aria-hidden
        style={{
          position: 'absolute', top: 0, left: 14, right: 14, height: 3,
          background: tokens.solid,
          borderRadius: '0 0 2px 2px',
          opacity: 0.95,
        }}
      />

      {/* Header — icon + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, marginTop: 6 }}>
        {Icon && (
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: tokens.bg, color: tokens.fg,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={14} strokeWidth={2} />
          </div>
        )}
        <span style={{
          fontFamily: 'var(--v2-font-body)',
          fontSize: 12, fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--v2-fg-secondary)',
          flex: 1,
        }}>
          {label}
        </span>
      </div>

      {/* Hero row — number left, sparkline right */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, marginBottom: 10 }}>
        <div
          className="tabular-nums"
          style={{
            fontFamily: 'var(--v2-font-display)',
            fontSize: 34, fontWeight: 700, letterSpacing: '-0.03em',
            lineHeight: 1, color: 'var(--v2-fg-primary)',
          }}
        >
          {display ?? '—'}
        </div>
        <Sparkline
          data={sparkline}
          color={tokens.solid}
          height={34}
          width={92}
        />
      </div>

      {/* Delta pill + comparison label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <DeltaPill delta={delta} health={health} unit={deltaUnit} />
        {delta != null && (
          <span style={{
            fontSize: 12.5, fontWeight: 600, color: 'var(--v2-fg-secondary)',
            letterSpacing: '0.02em',
          }}>
            {compareLabel}
          </span>
        )}
      </div>

      {/* Footnote */}
      {footnote && (
        <div style={{
          marginTop: 6,
          fontSize: 13, fontWeight: 500, lineHeight: 1.45,
          color: 'var(--v2-fg-secondary)',
        }}>
          {footnote}
        </div>
      )}
    </div>
  );
}

// Skeleton — same outer dimensions so layout doesn't jump on first paint.
export function KpiHeroCardSkeleton({ label, icon: Icon }) {
  return (
    <div className="v2-card" style={{ padding: '18px 20px 16px', overflow: 'hidden', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, marginTop: 6 }}>
        {Icon && (
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'var(--v2-bg-elevated)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, color: 'var(--v2-fg-tertiary)',
          }}>
            <Icon size={14} />
          </div>
        )}
        <span style={{
          fontSize: 12, fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--v2-fg-secondary)',
        }}>{label || 'Loading'}</span>
      </div>
      <div style={{
        height: 34, width: '60%', borderRadius: 6, marginBottom: 12,
        background: 'linear-gradient(90deg, var(--v2-bg-elevated), var(--v2-paper-100), var(--v2-bg-elevated))',
        backgroundSize: '200% 100%',
        animation: 'v2Shimmer 1.6s linear infinite',
      }} />
      <div style={{
        height: 14, width: '35%', borderRadius: 4,
        background: 'var(--v2-bg-elevated)',
      }} />
      <style jsx>{`
        @keyframes v2Shimmer {
          from { background-position: 200% 0; }
          to   { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
