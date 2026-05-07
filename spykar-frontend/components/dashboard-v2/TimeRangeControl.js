// ─── TimeRangeControl — segmented pill driving every v2 component ────────────
// Today · WTD · MTD · QTD · YTD · Custom
// Sliding indicator + tabular nums label.  Hooks into useTimeRange().

import { PRESETS } from '../../lib/v2/useTimeRange';

const LABELS = {
  today:  'Today',
  wtd:    'WTD',
  mtd:    'MTD',
  qtd:    'QTD',
  ytd:    'YTD',
  custom: 'Custom',
};

export default function TimeRangeControl({ preset, onChange }) {
  const idx = Math.max(0, PRESETS.indexOf(preset));
  const seg = 100 / PRESETS.length;

  return (
    <div
      role="tablist"
      aria-label="Time range"
      style={{
        display: 'inline-flex',
        position: 'relative',
        background: 'var(--v2-bg-elevated)',
        border: '1px solid var(--v2-border)',
        borderRadius: 999,
        padding: 3,
        height: 34,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          // Thicker, more visible transparent bar for the active preset.
          // Uses a translucent white so it reads on both light AND dark
          // page backgrounds (sales has a near-black canvas where the old
          // bg-card token blended in). Inset highlight + outer shadow give
          // the "raised glass" look the user asked for.
          top: 2, bottom: 2,
          left:  `calc(${idx * seg}% + 2px)`,
          width: `calc(${seg}% - 4px)`,
          background: 'rgba(255,255,255,0.14)',
          border: '1px solid rgba(255,255,255,0.22)',
          borderRadius: 999,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.30)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          transition: 'left 220ms var(--v2-ease), width 220ms var(--v2-ease)',
        }}
      />
      {PRESETS.map(p => (
        <button
          key={p}
          role="tab"
          aria-selected={preset === p}
          type="button"
          onClick={() => onChange(p)}
          style={{
            position: 'relative', zIndex: 1,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0 14px',
            fontFamily: 'var(--v2-font-body)',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.01em',
            color: preset === p ? 'var(--v2-fg-primary)' : 'var(--v2-fg-tertiary)',
            transition: 'color 200ms',
          }}
        >
          {LABELS[p]}
        </button>
      ))}
    </div>
  );
}
