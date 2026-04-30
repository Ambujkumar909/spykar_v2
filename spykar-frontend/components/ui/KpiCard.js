import { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatNumber, formatCurrency } from '../../lib/utils';

// ── CountUp — smooth animated number transitions ─────────────────────────────
// World-class dashboards (Stripe, Linear, Vercel) animate KPI numbers when
// they change so the user can SEE that the metric updated. Static jumps feel
// dead. We use a 700ms ease-out curve — slow enough to track with the eye,
// fast enough to feel snappy. Respects prefers-reduced-motion.
//
// First mount: snaps directly to the value (no count-up from zero on every
// page load — that's annoying). Only animates when the underlying number
// actually changes after mount.
function useCountUp(value, duration = 700) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const rafRef  = useRef(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (typeof value !== 'number' || isNaN(value)) { setShown(value); return; }
    if (!mounted.current) { mounted.current = true; setShown(value); fromRef.current = value; return; }

    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(value); fromRef.current = value; return; }

    const from   = Number(fromRef.current) || 0;
    const to     = Number(value) || 0;
    const start  = performance.now();
    const ease   = (t) => 1 - Math.pow(1 - t, 3); // cubic-out

    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const v = from + (to - from) * ease(t);
      setShown(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else { setShown(to); fromRef.current = to; }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return shown;
}

// Color presets — each card gets a personality
export const KPI_COLORS = {
  violet:  { color: '#8b5cf6', glow: 'rgba(139,92,246,0.15)', bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.2)',  gradient: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' },
  emerald: { color: '#10b981', glow: 'rgba(16,185,129,0.15)',  bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.2)', gradient: 'linear-gradient(135deg, #10b981, #059669)' },
  amber:   { color: '#f59e0b', glow: 'rgba(245,158,11,0.15)',  bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.2)', gradient: 'linear-gradient(135deg, #f59e0b, #d97706)' },
  rose:    { color: '#f43f5e', glow: 'rgba(244,63,94,0.15)',   bg: 'rgba(244,63,94,0.08)',   border: 'rgba(244,63,94,0.2)',  gradient: 'linear-gradient(135deg, #f43f5e, #e11d48)' },
  sky:     { color: '#0ea5e9', glow: 'rgba(14,165,233,0.15)',  bg: 'rgba(14,165,233,0.08)',  border: 'rgba(14,165,233,0.2)', gradient: 'linear-gradient(135deg, #0ea5e9, #0284c7)' },
  fuchsia: { color: '#d946ef', glow: 'rgba(217,70,239,0.15)', bg: 'rgba(217,70,239,0.08)',  border: 'rgba(217,70,239,0.2)', gradient: 'linear-gradient(135deg, #d946ef, #a21caf)' },
  orange:  { color: '#f97316', glow: 'rgba(249,115,22,0.15)',  bg: 'rgba(249,115,22,0.08)',  border: 'rgba(249,115,22,0.2)', gradient: 'linear-gradient(135deg, #f97316, #ea580c)' },
  teal:    { color: '#14b8a6', glow: 'rgba(20,184,166,0.15)',  bg: 'rgba(20,184,166,0.08)',  border: 'rgba(20,184,166,0.2)', gradient: 'linear-gradient(135deg, #14b8a6, #0d9488)' },
};

export default function KpiCard({
  label,
  value,
  format = 'number',
  change,
  changeSuffix = '%',
  icon: Icon,
  colorKey = 'violet',   // key from KPI_COLORS
  iconColor,             // override
  iconBg,                // override
  sub,
  loading = false,
  style = {},
  barValue,              // 0–100 for bottom progress bar
}) {
  const preset = KPI_COLORS[colorKey] || KPI_COLORS.violet;
  const resolvedColor = iconColor || preset.color;
  const resolvedBg    = iconBg    || preset.bg;

  // Animate numeric KPI values; pass strings through untouched. Format AFTER
  // the animated number lands in `shown` so commas/units recompute every frame.
  const animatable = !loading && (format === 'number' || format === 'currency') && typeof value === 'number';
  const shown = useCountUp(animatable ? value : null, 700);
  const displayValue = loading ? null
    : format === 'currency' ? formatCurrency(animatable ? Math.round(shown) : value)
    : format === 'number'   ? formatNumber(animatable ? Math.round(shown) : value)
    : value;

  const isUp   = change > 0;
  const isDown = change < 0;
  const ChangeIcon  = isUp ? TrendingUp : isDown ? TrendingDown : Minus;
  const changeColor = isUp ? '#10b981' : isDown ? '#f43f5e' : 'var(--text-muted)';

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: `1px solid ${preset.border}`,
      borderRadius: 'var(--radius-lg)',
      padding: '20px 22px 18px',
      position: 'relative',
      overflow: 'hidden',
      transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
      cursor: 'default',
      ...style,
    }}
    onMouseEnter={e => {
      e.currentTarget.style.transform = 'translateY(-2px)';
      e.currentTarget.style.boxShadow = `0 8px 24px rgba(15,23,42,0.09), 0 2px 6px rgba(15,23,42,0.05), 0 0 0 1px ${preset.border}`;
    }}
    onMouseLeave={e => {
      e.currentTarget.style.transform = 'translateY(0)';
      e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.04), 0 4px 12px rgba(15,23,42,0.04)';
    }}
    >
      {/* Top gradient line */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: 3,
        background: preset.gradient,
        borderRadius: '14px 14px 0 0',
      }} />

      {/* Glow mesh top-right */}
      <div style={{
        position: 'absolute',
        top: -20, right: -20,
        width: 100, height: 100,
        background: `radial-gradient(circle, ${preset.glow}, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* Icon */}
      {Icon && (
        <div style={{
          width: 42, height: 42,
          borderRadius: 12,
          background: resolvedBg,
          border: `1px solid ${preset.border}`,
          color: resolvedColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'absolute', top: 18, right: 18,
        }}>
          <Icon size={18} strokeWidth={2} />
        </div>
      )}

      {/* Label */}
      <div style={{
        fontFamily: 'var(--font-body)',
        fontSize: 12, fontWeight: 700,
        color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em',
        marginBottom: 12, marginTop: 4,
      }}>{label}</div>

      {/* Value */}
      {loading ? (
        <div className="skeleton" style={{ height: 38, width: '55%', marginBottom: 12 }} />
      ) : (
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 34, fontWeight: 800,
          color: 'var(--text-primary)',
          lineHeight: 1, marginBottom: 10,
          letterSpacing: '-0.03em',
        }}>
          {displayValue ?? '—'}
        </div>
      )}

      {/* Sub / change */}
      <div style={{
        fontFamily: 'var(--font-body)',
        fontSize: 13, color: 'var(--text-secondary)',
        display: 'flex', alignItems: 'center', gap: 6,
        lineHeight: 1.4,
      }}>
        {change != null && !loading && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: changeColor, fontWeight: 600 }}>
            <ChangeIcon size={12} />
            {Math.abs(change)}{changeSuffix}
          </span>
        )}
        {sub && <span style={{ color: 'var(--text-muted)' }}>{sub}</span>}
      </div>

      {/* Optional bottom progress bar */}
      {barValue != null && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: 3, background: 'var(--border-subtle)',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(barValue, 100)}%`,
            background: preset.gradient,
            transition: 'width 1s ease',
          }} />
        </div>
      )}
    </div>
  );
}
