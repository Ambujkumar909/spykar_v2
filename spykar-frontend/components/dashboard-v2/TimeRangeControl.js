// ─── TimeRangeControl — segmented pill driving every v2 component ────────────
// Today · WTD · MTD · QTD · YTD · Custom
// Sliding indicator + tabular nums label.  Hooks into useTimeRange().

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PRESETS } from '../../lib/v2/useTimeRange';

const LABELS = {
  today:  'Today',
  wtd:    'WTD',
  mtd:    'MTD',
  qtd:    'QTD',
  ytd:    'YTD',
  custom: 'Custom',
};

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// The --v2-* tokens exist only inside .v2-app (Overview). On /sales and
// /primary-sales the pill sits in the app header, so each token falls back to
// the app's own theme token instead of resolving to nothing.
export default function TimeRangeControl({ preset, onChange }) {
  const wrap = useRef(null);
  const btns = useRef({});
  // The highlight sits exactly on the selected button (buttons size to their
  // label, so equal 1/6 slots drifted off "Today", "QTD", "Custom" …).
  const [box, setBox] = useState(null);        // { left, width } in px, null until measured
  const [ready, setReady] = useState(false);   // no slide on the very first placement

  useIsoLayoutEffect(() => {
    const measure = () => {
      const b = btns.current[preset] || btns.current[PRESETS[0]];
      if (b) setBox((prev) => (prev && prev.left === b.offsetLeft && prev.width === b.offsetWidth
        ? prev : { left: b.offsetLeft, width: b.offsetWidth }));
    };
    measure();
    // Fonts loading, the mobile header padding and window resizes all change widths.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && wrap.current) ro.observe(wrap.current);
    return () => ro && ro.disconnect();
  }, [preset]);
  useEffect(() => {
    if (!box || ready) return undefined;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [box, ready]);

  return (
    <div
      ref={wrap}
      className="time-range-control"
      role="tablist"
      aria-label="Time range"
      style={{
        display: 'inline-flex',
        position: 'relative',
        background: 'var(--v2-bg-elevated, var(--bg-elevated))',
        border: '1px solid var(--v2-border, var(--border-subtle))',
        borderRadius: 999,
        padding: 3,
        height: 34,
      }}
    >
      {/* Look (glass on dark, solid white on light) lives in globals.css .trc-thumb */}
      <span
        aria-hidden
        className="trc-thumb"
        style={{
          position: 'absolute',
          top: 2, bottom: 2,
          left: box ? box.left : 0,
          width: box ? box.width : 0,
          visibility: box ? 'visible' : 'hidden',
          borderRadius: 999,
          transition: ready ? 'left 220ms var(--v2-ease, cubic-bezier(0.16, 1, 0.3, 1)), width 220ms var(--v2-ease, cubic-bezier(0.16, 1, 0.3, 1))' : 'none',
        }}
      />
      {PRESETS.map(p => (
        <button
          key={p}
          ref={(el) => { btns.current[p] = el; }}
          role="tab"
          aria-selected={preset === p}
          type="button"
          onClick={() => onChange(p)}
          style={{
            position: 'relative', zIndex: 1,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0 14px',
            fontFamily: 'var(--v2-font-body, var(--font-body))',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.01em',
            color: preset === p ? 'var(--v2-fg-primary, var(--text-primary))' : 'var(--v2-fg-tertiary, var(--text-muted))',
            transition: 'color 200ms',
          }}
        >
          {LABELS[p]}
        </button>
      ))}
    </div>
  );
}
