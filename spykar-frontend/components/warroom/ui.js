// ─── War Room primitives ─────────────────────────────────────────────────────
// Small, theme-aware building blocks (colours come from the .wr tokens in
// WarRoomStyles). Pure SVG — no chart library for rings / sparklines, so a
// 300-row league table of sparklines stays instant.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { pct, tone, STATUS_TONE } from './wrMath';

export function Delta({ v, d = 1, good, bad, label, size = 'md', invert = false }) {
  const t = invert ? ({ pos: 'neg', neg: 'pos', warn: 'flat', flat: 'warn' }[tone(v, { good, bad })] || 'mute') : tone(v, { good, bad });
  const Icon = v == null ? Minus : v >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`wr-delta wr-${t} wr-delta-${size}`} title={label ? `${label} ${pct(v, 2)}` : undefined}>
      {label && <span className="wr-delta-lbl">{label}</span>}
      <Icon size={size === 'sm' ? 10 : 12} strokeWidth={2.6} />
      {pct(v, d)}
    </span>
  );
}

// Achievement ring: arc = value (to 100 %), a thin gold inner arc beyond 100 %.
export function Ring({ value, size = 64, stroke = 6, label, sub }) {
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const v = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(value, 2));
  const t = value == null ? 'mute' : value >= 1 ? 'pos' : value >= 0.9 ? 'warn' : 'neg';
  const over = Math.max(0, v - 1); const ri = r - stroke - 1.5;
  return (
    <div className={`wr-ring wr-${t}`} style={{ width: size, height: size }} title={value == null ? undefined : `${(value * 100).toFixed(1)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="wr-ring-track" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} className="wr-ring-arc" strokeWidth={stroke} fill="none"
          strokeDasharray={`${c * Math.min(v, 1)} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        {over > 0 && <circle cx={size / 2} cy={size / 2} r={ri} className="wr-ring-over" strokeWidth={2.5} fill="none"
          strokeDasharray={`${2 * Math.PI * ri * Math.min(over, 1)} ${2 * Math.PI * ri}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </svg>
      <div className="wr-ring-c"><b>{label ?? (value == null ? '—' : `${Math.round(value * 100)}%`)}</b>{sub && <span>{sub}</span>}</div>
    </div>
  );
}

// Sparkline of TY with LY ghosted behind; last point marked.
export function Spark({ ty = [], ly = [], w = 96, h = 26, stroke = 1.6 }) {
  const all = [...ty, ...ly].filter((x) => Number.isFinite(x));
  if (!all.length || all.every((x) => x === 0)) return <svg width={w} height={h} className="wr-spark" />;
  const max = Math.max(...all, 1); const min = Math.min(0, ...all);
  const X = (i, n) => (n <= 1 ? w / 2 : 2 + (i * (w - 4)) / (n - 1));
  const Y = (v) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
  const path = (a) => a.map((v, i) => `${i ? 'L' : 'M'}${X(i, a.length).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = ty.length ? `${path(ty)} L${X(ty.length - 1, ty.length).toFixed(1)},${h - 1} L${X(0, ty.length).toFixed(1)},${h - 1} Z` : '';
  const up = ty.length > 1 && ty[ty.length - 1] >= (ly[ly.length - 1] || 0);
  return (
    <svg width={w} height={h} className={`wr-spark ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${w} ${h}`}>
      {ly.length > 0 && <path d={path(ly)} className="wr-spark-ly" fill="none" strokeWidth={1.1} />}
      {area && <path d={area} className="wr-spark-area" />}
      <path d={path(ty)} className="wr-spark-ty" fill="none" strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" />
      {ty.length > 0 && <circle cx={X(ty.length - 1, ty.length)} cy={Y(ty[ty.length - 1])} r={2.2} className="wr-spark-dot" />}
    </svg>
  );
}

export function StatusPill({ status, small }) {
  return <span className={`wr-pill wr-pill-${STATUS_TONE[status] || 'mute'}${small ? ' wr-pill-sm' : ''}`}>{status}</span>;
}

export function Seg({ value, onChange, options, size = 'md', title }) {
  return (
    <div className={`wr-seg wr-seg-${size}`} role="tablist" title={title}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button key={o.value} type="button" role="tab" aria-selected={value === o.value}
            className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {Icon && <Icon size={13} strokeWidth={2.2} />}<span>{o.label}</span>
            {o.badge != null && <em>{o.badge}</em>}
          </button>
        );
      })}
    </div>
  );
}

export function Card({ title, eyebrow, icon: Icon, right, children, className = '', pad = true, accent }) {
  return (
    <section className={`wr-card ${className}`} data-accent={accent}>
      {(title || right) && (
        <header className="wr-card-h">
          <div className="wr-card-t">
            {Icon && <span className="wr-card-ic"><Icon size={14} strokeWidth={2.2} /></span>}
            <div>{eyebrow && <div className="wr-eyebrow">{eyebrow}</div>}<h3>{title}</h3></div>
          </div>
          {right && <div className="wr-card-r">{right}</div>}
        </header>
      )}
      <div className={pad ? 'wr-card-b' : ''}>{children}</div>
    </section>
  );
}

export function Shim({ h = 14, w = '100%', r = 6 }) { return <div className="wr-shim" style={{ height: h, width: w, borderRadius: r }} />; }

// Number that eases to its new value (respects reduced motion).
export function Tween({ value, format, ms = 650 }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value); const raf = useRef(0);
  useEffect(() => {
    if (value == null || !Number.isFinite(value) || typeof window === 'undefined'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !Number.isFinite(from.current)) { setShown(value); from.current = value; return undefined; }
    const a = from.current; const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms); const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf.current = requestAnimationFrame(step); else from.current = value;
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

// Horizontal two-tone bar (TY over LY ghost), width relative to `max`.
export function DualBar({ ty, ly, max, toneName }) {
  const w = (x) => `${max ? Math.max(0, Math.min(100, (x / max) * 100)) : 0}%`;
  return (
    <div className="wr-dbar">
      <div className="wr-dbar-ly" style={{ width: w(ly) }} />
      <div className={`wr-dbar-ty wr-${toneName || 'flat'}`} style={{ width: w(ty) }} />
    </div>
  );
}
