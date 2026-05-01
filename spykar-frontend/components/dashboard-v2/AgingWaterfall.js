// ─── AgingWaterfall — Zone D · the slide every CEO asks for ─────────────────
// Horizontal stacked bar of inventory units by aging bucket.  The right edge
// of the bar is "this much capital is at liquidation risk".
//
// Why this UX over a stacked vertical column:
//   • Reads left-to-right along with the labels under the bar.
//   • Single bar is a cleaner statement than 5 disconnected donuts.
//   • Hover surfaces the exact unit count + share — no need to squint.
//
// Color gradient ok-500 → warn-500 → bad-500 follows the inventory health
// convention everywhere else in the dashboard.

import { Boxes } from 'lucide-react';
import { formatCompact, formatPct } from '../../lib/v2/format';

const BUCKET_META = [
  { key: '0-30',  label: '0–30 d',     color: 'var(--v2-ok-500)'   },
  { key: '31-60', label: '31–60 d',    color: 'var(--v2-ok-400)'   },
  { key: '61-90', label: '61–90 d',    color: 'var(--v2-warn-400)' },
  { key: '91-180',label: '91–180 d',   color: 'var(--v2-warn-500)' },
  { key: '180+',  label: '180+ d',     color: 'var(--v2-bad-500)'  },
];

export default function AgingWaterfall({ data, loading }) {
  if (loading) {
    return (
      <CardShell title="Inventory Aging">
        <div style={{ height: 80, background: 'var(--v2-bg-elevated)', borderRadius: 8 }} />
      </CardShell>
    );
  }

  const buckets = (data || []).map(b => {
    const meta = BUCKET_META.find(m => m.key === b.bucket) || BUCKET_META[0];
    return { ...b, ...meta };
  });
  const total = buckets.reduce((s, b) => s + (b.units || 0), 0);
  // The "exposure" line below the bar — units/% in the 91+ buckets.
  const aged   = buckets.filter(b => b.key === '91-180' || b.key === '180+').reduce((s, b) => s + b.units, 0);
  const agedPct = total ? (aged / total) * 100 : 0;

  return (
    <CardShell
      title="Inventory Aging"
      subtitle={total > 0
        ? <>Total <strong style={{ color: 'var(--v2-fg-primary)' }}>{formatCompact(total)}</strong> units across the network</>
        : 'No inventory data'}
    >
      {/* The bar */}
      <div
        style={{
          display: 'flex', height: 32,
          borderRadius: 8, overflow: 'hidden',
          border: '1px solid var(--v2-border)',
          background: 'var(--v2-bg-elevated)',
        }}
      >
        {buckets.map(b => (
          <div
            key={b.key}
            title={`${b.label}: ${formatCompact(b.units)} units · ${formatPct(b.pct)}`}
            style={{
              flexBasis: `${b.pct || 0}%`,
              background: b.color,
              transition: 'flex-basis 320ms var(--v2-ease)',
              borderRight: '1px solid rgba(0,0,0,0.06)',
              minWidth: b.pct > 0 ? 2 : 0,
            }}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
        {buckets.map(b => (
          <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--v2-fg-tertiary)' }}>
                {b.label}
              </span>
              <span className="tabular-nums" style={{ fontSize: 13, fontWeight: 700, color: 'var(--v2-fg-primary)' }}>
                {formatCompact(b.units)} <span style={{ fontWeight: 500, color: 'var(--v2-fg-tertiary)' }}>· {formatPct(b.pct, { decimals: 0 })}</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Liquidation-risk callout */}
      {aged > 0 && (
        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: agedPct > 20 ? 'var(--v2-bad-50)' : 'var(--v2-warn-50)',
            border: `1px solid ${agedPct > 20 ? 'var(--v2-bad-500)' : 'var(--v2-warn-500)'}`,
            borderRadius: 8,
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, fontWeight: 600,
            color: agedPct > 20 ? 'var(--v2-bad-500)' : 'var(--v2-warn-500)',
          }}
        >
          <Boxes size={14} />
          <span className="tabular-nums">{formatCompact(aged)}</span>
          <span> units aged 91+ days · {formatPct(agedPct, { decimals: 1 })} of network — liquidation candidate</span>
        </div>
      )}
    </CardShell>
  );
}

// Common card chrome shared with the other intelligence-grid widgets.  Kept
// inline rather than abstracted to keep each widget visually self-contained.
function CardShell({ title, subtitle, children }) {
  return (
    <div className="v2-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontFamily: 'var(--v2-font-display)',
          fontSize: 13, fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--v2-fg-tertiary)',
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 13, marginTop: 4,
            color: 'var(--v2-fg-secondary)',
          }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
