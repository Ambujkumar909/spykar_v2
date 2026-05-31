import { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

const PRESETS = {
  slate:   { color: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.20)', gradient: 'linear-gradient(135deg, #64748B, #334155)' },
  brand:   { color: '#EF4444', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.28)',   gradient: 'linear-gradient(135deg, #EF4444, #DC2626)' },
  emerald: { color: '#10B981', bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.28)',  gradient: 'linear-gradient(135deg, #34D399, #10B981)' },
  sky:     { color: '#3B82F6', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.28)',  gradient: 'linear-gradient(135deg, #60A5FA, #3B82F6)' },
  amber:   { color: '#F59E0B', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.28)',  gradient: 'linear-gradient(135deg, #FCD34D, #F59E0B)' },
  violet:  { color: '#A855F7', bg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.28)',  gradient: 'linear-gradient(135deg, #C084FC, #A855F7)' },
  teal:    { color: '#14B8A6', bg: 'rgba(20,184,166,0.12)',  border: 'rgba(20,184,166,0.28)',  gradient: 'linear-gradient(135deg, #2DD4BF, #14B8A6)' },
  orange:  { color: '#F97316', bg: 'rgba(249,115,22,0.12)',  border: 'rgba(249,115,22,0.28)',  gradient: 'linear-gradient(135deg, #FB923C, #F97316)' },
};

function useCountUp(value, duration = 800) {
  const [n, setN]    = useState(value);
  const fromRef      = useRef(value);
  const rafRef       = useRef(null);
  const mounted      = useRef(false);

  useEffect(() => {
    if (typeof value !== 'number' || isNaN(value)) { setN(value); return; }
    if (!mounted.current) { mounted.current = true; setN(value); fromRef.current = value; return; }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setN(value); fromRef.current = value; return; }
    const from = Number(fromRef.current) || 0;
    const to   = Number(value) || 0;
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const tick = now => {
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

/* Mini SVG sparkline — draws a smooth polyline from an array of numbers */
function Sparkline({ data = [], color = '#3B82F6', height = 36, width = 80 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 3;
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`spk-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Area fill */}
      <polyline
        points={`${points} ${(width - pad).toFixed(1)},${height} ${pad},${height}`}
        fill={`url(#spk-${color.replace('#','')})`}
        stroke="none"
      />
      {/* Line */}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Last point dot */}
      {(() => {
        const last = points.split(' ').pop().split(',');
        return (
          <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
        );
      })()}
    </svg>
  );
}

export default function PremiumKpi({
  label,
  value,
  format   = 'indian',
  prefix   = '',
  suffix   = '',
  icon: Icon,
  accent   = 'slate',
  breakdowns = [],
  context,
  loading  = false,
  delta,
  highlight = false,
  sparkData,          // array of numbers for mini sparkline
  sparkColor,         // override sparkline color
  size     = 'normal', // 'hero' | 'normal'
}) {
  const preset  = PRESETS[accent] || PRESETS.slate;
  const animate = !loading && typeof value === 'number' && format !== 'string';
  const shown   = useCountUp(animate ? value : null, 800);

  const headlineCore = loading ? null
    : format === 'string' ? value
    : format === 'indian' ? fmtIndian(animate ? Math.round(shown) : value)
    : (animate ? Math.round(shown) : Number(value)).toLocaleString('en-IN');

  const headline = (loading || headlineCore == null || headlineCore === '—')
    ? headlineCore
    : (format === 'string' ? headlineCore : `${prefix}${headlineCore}${suffix}`);

  const rawTooltip = typeof value === 'number'
    ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : (value != null ? String(value) : '');

  const heroSize = size === 'hero' ? 52 : 36;
  const spkColor = sparkColor || preset.color;

  return (
    <div
      className="sx-card"
      style={{
        position: 'relative',
        padding: size === 'hero' ? '22px 24px 20px' : '18px 20px 16px',
        overflow: 'hidden',
        border: highlight ? `1px solid ${preset.border}` : undefined,
        background: highlight ? `${preset.bg}` : undefined,
        cursor: 'default',
        transition: 'transform 260ms cubic-bezier(0.16,1,0.3,1), box-shadow 260ms ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      {/* Gradient top rail */}
      <div style={{
        position: 'absolute', top: 0, left: 14, right: 14, height: 2,
        background: preset.gradient,
        borderRadius: '0 0 2px 2px',
        opacity: 0.90,
      }} />

      {/* Subtle corner glow */}
      <div style={{
        position: 'absolute', top: 0, right: 0,
        width: 80, height: 80,
        background: `radial-gradient(circle at 80% 0%, ${preset.color}18 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, marginTop: 4 }}>
        {Icon && (
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: preset.bg,
            color: preset.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={13} strokeWidth={2} />
          </div>
        )}
        <span style={{
          fontFamily: 'var(--font-body)',
          fontSize: 12, fontWeight: 800,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          flex: 1,
        }}>{label}</span>
        {delta != null && !loading && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 7px', borderRadius: 999,
            background: delta >= 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
            color:      delta >= 0 ? '#34D399'                : '#F87171',
            fontSize: 11, fontWeight: 700,
          }}>
            {delta >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            {Math.abs(delta)}%
          </span>
        )}
      </div>

      {/* Headline number + sparkline row */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          {loading ? (
            <div className="sx-shimmer" style={{ height: heroSize, width: 120, marginBottom: 8, borderRadius: 6 }} />
          ) : (
            <div
              title={rawTooltip}
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: heroSize,
                fontWeight: 800,
                letterSpacing: '-0.04em',
                lineHeight: 1,
                color: 'var(--text-primary)',
                fontFeatureSettings: "'tnum' 1, 'lnum' 1",
                cursor: 'help',
                marginBottom: breakdowns.length > 0 ? 10 : 6,
              }}
            >{headline ?? '—'}</div>
          )}
        </div>

        {/* Sparkline */}
        {sparkData && sparkData.length > 1 && !loading && (
          <div style={{ flexShrink: 0, opacity: 0.85 }}>
            <Sparkline data={sparkData} color={spkColor} height={34} width={72} />
          </div>
        )}
      </div>

      {/* Breakdown chips */}
      {!loading && breakdowns.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: context ? 8 : 0 }}>
          {breakdowns.map((b, i) => {
            const showPct = b.total != null && Number(b.total) > 0 && typeof b.value === 'number';
            const pct = showPct ? fmtPct(b.value, b.total) : null;
            return (
              <div key={i}
                title={pct ? `${b.label}: ${pct}` : b.label}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '3px 8px', borderRadius: 999,
                  background: b.color ? `${b.color}12` : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${b.color ? `${b.color}28` : 'rgba(255,255,255,0.08)'}`,
                }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: b.color || '#475569', flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>{b.label}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 12.5, fontWeight: 800, color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
                  {typeof b.value === 'number' ? fmtIndian(b.value) : (b.value ?? '—')}
                </span>
                {pct && (
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: 'var(--text-disabled)' }}>· {pct}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Context line */}
      {context && (
        <div style={{
          fontFamily: 'var(--font-body)', fontSize: 12.5, fontWeight: 500,
          color: 'var(--text-secondary)', marginTop: 4,
        }}>{context}</div>
      )}
    </div>
  );
}
