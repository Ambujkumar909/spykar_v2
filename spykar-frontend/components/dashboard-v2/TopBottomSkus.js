// ─── TopBottomSkus — dual column compact table ──────────────────────────────
// Left: Top 8 SKUs by units sold (last 30 days).
// Right: Bottom 8 — slow / never-moved with stock-on-hand badge.
//
// Each row is one line: rank, SKU code (truncated), product name (small),
// metric.  Designed for skim-reading at meeting velocity, not deep
// analysis — the SKU drill-down is a separate page.

import { TrendingUp, AlertTriangle } from 'lucide-react';
import { formatCompact } from '../../lib/v2/format';

function Column({ icon: Icon, title, subtitle, rows, metricLabel, metricKey, dangerKey, accent, emptyText }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px solid var(--v2-border)' }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: accent + '22', color: accent,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={12} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--v2-fg-tertiary)' }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 11, color: 'var(--v2-fg-tertiary)', fontWeight: 500 }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {(!rows || rows.length === 0) ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: 'var(--v2-fg-tertiary)' }}>
          {emptyText}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((r, i) => (
            <div
              key={(r.sku_code || '') + i}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0',
                borderBottom: i < rows.length - 1 ? '1px solid var(--v2-border)' : 'none',
              }}
            >
              <span style={{
                width: 18, fontSize: 10, fontWeight: 700, color: 'var(--v2-fg-tertiary)', textAlign: 'right',
                flexShrink: 0,
              }}>
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 11.5, fontWeight: 700,
                  color: 'var(--v2-fg-primary)',
                  fontFamily: 'monospace, var(--v2-font-body)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {r.sku_code}
                </div>
                <div style={{
                  fontSize: 10.5, color: 'var(--v2-fg-tertiary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {r.product_name} · {r.color_name} · {r.size}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="tabular-nums" style={{ fontSize: 12, fontWeight: 800, color: accent }}>
                  {formatCompact(r[metricKey])}
                </div>
                <div style={{ fontSize: 9.5, color: 'var(--v2-fg-tertiary)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700 }}>
                  {metricLabel}
                </div>
                {dangerKey && r[dangerKey] != null && (
                  <div style={{ fontSize: 10, color: 'var(--v2-bad-500)', fontWeight: 700, marginTop: 2 }}>
                    {r[dangerKey]} d idle
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TopBottomSkus({ topSkus, bottomSkus, loading }) {
  return (
    <div className="v2-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontFamily: 'var(--v2-font-display)',
          fontSize: 13, fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--v2-fg-tertiary)',
        }}>
          SKU Pulse — Best & Slowest Movers
        </div>
        <div style={{ fontSize: 13, marginTop: 4, color: 'var(--v2-fg-secondary)' }}>
          Units sold last 30 days vs SKUs sitting idle 90+ days
        </div>
      </div>

      {loading ? (
        <div style={{ height: 240, background: 'var(--v2-bg-elevated)', borderRadius: 8 }} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <Column
            icon={TrendingUp}
            title="Top Movers"
            subtitle="Most units sold · last 30 d"
            rows={topSkus}
            metricLabel="sold"
            metricKey="total_sold"
            accent="#10B981"
            emptyText="No sales activity yet"
          />
          <Column
            icon={AlertTriangle}
            title="Slow Movers"
            subtitle="No movement · 90+ days"
            rows={bottomSkus}
            metricLabel="on hand"
            metricKey="qty_on_hand"
            dangerKey="days_no_movement"
            accent="#F59E0B"
            emptyText="No slow movers"
          />
        </div>
      )}
    </div>
  );
}
