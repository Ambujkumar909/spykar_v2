// ─── AgingWaterfall — Zone D · the slide every CEO asks for ─────────────────
// Horizontal stacked bar of inventory units by aging bucket.  The right edge
// of the bar is "this much capital is at liquidation risk".
//
// SEMANTICS — IMPORTANT:
//   The buckets are NOT "days since the unit arrived in the store".  The
//   underlying SQL (scripts/run_ageing_update.js) buckets each (location,
//   SKU) row in inventory_snapshot by *days since the SKU was last sold at
//   that store* — the gap between the network-wide latest sale date and
//   `MAX(moved_at)` for that location+sku pair.  So the labels below read
//   "Sold ≤ N d / not sold > N d" instead of plain "0–30 d", and the 180+
//   bucket explicitly notes "or never sold here" because the SQL puts
//   never-sold (location, SKU) combinations there too.
//
// Color gradient ok-500 → warn-500 → bad-500 follows the inventory health
// convention everywhere else in the dashboard.

import { Boxes, Info } from 'lucide-react';
import { formatCompact, formatPct } from '../../lib/v2/format';

// Each bucket carries:
//   key      — matches the value useDashboardMetrics emits (don't change)
//   label    — terse pill caption
//   long     — verbose description for hover tooltip
//   color    — health-scale colour token
const BUCKET_META = [
  { key: '0-30',   label: 'Sold ≤ 30 d',  long: 'A unit of this SKU was sold at this store within the last 30 days. Active sellers.',                color: 'var(--v2-ok-500)'   },
  { key: '31-60',  label: 'Sold 31–60 d', long: 'Last sold here 31–60 days ago. Slowing but still inside the season.',                                color: 'var(--v2-ok-400)'   },
  { key: '61-90',  label: 'Sold 61–90 d', long: 'Last sold here 61–90 days ago. Approaching the markdown line.',                                       color: 'var(--v2-warn-400)' },
  { key: '91-180', label: 'Sold 91–180 d',long: 'Last sold here 91–180 days ago. Past peak — markdown / clearance candidate.',                          color: 'var(--v2-warn-500)' },
  { key: '180+',   label: 'Sold > 180 d or never', long: 'Last sold here over 180 days ago — OR this SKU has never sold at this store. Investigate allocation, then liquidate.', color: 'var(--v2-bad-500)' },
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
      tooltip="Buckets count current on-hand stock by days since the SKU was last sold at that specific store. The 180+ bucket also includes SKUs that have never sold at that store."
      subtitle={total > 0
        ? <>Total <strong style={{ color: 'var(--v2-fg-primary)' }}>{formatCompact(total)}</strong> units · grouped by recency of last sale at each store</>
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
            title={`${b.label}\n${formatCompact(b.units)} units · ${formatPct(b.pct)}\n\n${b.long}`}
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
          <div
            key={b.key}
            title={b.long}
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'help' }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color, flexShrink: 0 }} />
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
          title="Sum of the 91-180 d and >180 d / never-sold buckets — capital tied up in stock that hasn't moved at its current store in over a quarter."
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: agedPct > 20 ? 'var(--v2-bad-50)' : 'var(--v2-warn-50)',
            border: `1px solid ${agedPct > 20 ? 'var(--v2-bad-500)' : 'var(--v2-warn-500)'}`,
            borderRadius: 8,
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, fontWeight: 600,
            color: agedPct > 20 ? 'var(--v2-bad-500)' : 'var(--v2-warn-500)',
            cursor: 'help',
          }}
        >
          <Boxes size={14} />
          <span className="tabular-nums">{formatCompact(aged)}</span>
          <span> units not sold at their current store in 90+ days · {formatPct(agedPct, { decimals: 1 })} of network — review allocation, then markdown</span>
        </div>
      )}

      {/* Footnote — explain the 180+ "or never" semantic.  Keeps the chart
          honest without burying the headline. */}
      <div style={{
        marginTop: 10,
        fontSize: 11, color: 'var(--v2-fg-tertiary)',
        lineHeight: 1.5,
      }}>
        <Info size={11} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4 }} />
        <strong style={{ color: 'var(--v2-fg-secondary)', fontWeight: 700 }}>How buckets are computed:</strong> each (store × SKU) row of on-hand
        stock is binned by days since that SKU was last sold at that specific
        store, using the latest sale date in the ERP (refreshed nightly) as the
        reference. The <em>{'> 180 d or never'}</em> bucket also captures SKUs
        that have never sold at their current store — often a wrong-allocation
        signal rather than pure dead stock.
      </div>
    </CardShell>
  );
}

// Common card chrome shared with the other intelligence-grid widgets.  Kept
// inline rather than abstracted to keep each widget visually self-contained.
function CardShell({ title, subtitle, tooltip, children }) {
  return (
    <div className="v2-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            fontFamily: 'var(--v2-font-display)',
            fontSize: 13, fontWeight: 800,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--v2-fg-tertiary)',
          }}>
            {title}
          </div>
          {tooltip && (
            <span title={tooltip} style={{ display: 'inline-flex', cursor: 'help', color: 'var(--v2-fg-tertiary)' }}>
              <Info size={12} />
            </span>
          )}
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
