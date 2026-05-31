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

import { Info } from 'lucide-react';

// NOTE: the per-bucket metadata + formatting helpers used by the real ageing
// chart were removed while the chart is paused (see placeholder below). They
// live in git history and can be restored alongside the chart once warehouse
// data is integrated.

export default function AgingWaterfall({ data, loading }) {
  // ── Inventory Aging — paused until warehouse data is integrated ──────────
  // The previous bucketing was "days since the SKU was last sold at that
  // store", with the 180+ bucket also absorbing SKUs that never sold there.
  // For apparel that overstated aged/dead stock (the normal size-colour
  // long-tail + mis-allocation read as "aged"). Until the warehouse +
  // receipt feeds are live we cannot compute TRUE stock age, so we show an
  // honest placeholder instead of a misleading chart. data/loading are kept
  // for the eventual restore.
  void data; void loading;
  return (
    <CardShell title="Inventory Aging">
      <div style={{ padding: '12px 2px 6px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontFamily: 'var(--v2-font-display)', fontSize: 18, fontWeight: 800, color: 'var(--v2-fg-primary)' }}>
          Available soon
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--v2-fg-secondary)', lineHeight: 1.5, maxWidth: 460 }}>
          Warehouse data integration is in progress — accurate inventory-ageing
          buckets (180+ day aged stock) will appear here once the warehouse &amp;
          receipt feeds are live.
        </div>
      </div>
    </CardShell>
  );
}

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
