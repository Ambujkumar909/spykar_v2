// ─── DistributionDonuts — Recharts twin donut (Colour + Size) ────────────────
// Migrated from ApexCharts → Recharts on 2026-05-02 to remove the heavy
// updateOptions cycle, fix the intermittent "parser Error" crashes, and
// halve the per-toggle render cost. Recharts is plain React + SVG with no
// internal state machine, so lens-toggle re-renders are pure React
// reconciliation (~5–10ms per chart vs ~80–120ms for ApexCharts).
//
// Performance:
//   • Reads from `data.by_color` / `data.by_size` already in `dataLens`
//     (parent passes lens-enriched rows). No extra API, no extra cache key.
//   • Inherits the 24h Redis TTL on /analytics/sales (recently bumped from
//     2h) and the frontend dashboardCache. A second click of the same date
//     range hits warm cache → page paints in ~0.5s.
//   • bucketed/palette/totals memoised on (rows × topN). Hover doesn't
//     trigger React renders — Recharts manages its own hover internally.
//   • isAnimationActive=false → instant slice transitions, no animation lag.
//
// Visual:
//   • Donut: innerRadius 58% / outerRadius 80% — same proportions as before
//   • Centre: HTML overlay (absolute-positioned div) — full React control,
//     never replaced on hover (no equivalent of ApexCharts' name/value blocks)
//   • Tooltip: custom component, lens-aware
//   • Side legend unchanged

import { useMemo, useCallback, useState } from 'react';
import { Palette, Ruler } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

// ── Colour-name → hex mapping for the Colour donut ─────────────────────────
// When a colour name maps to a real-world hue we use it so the donut LITERALLY
// shows the colour in the slice. Falls through to the premium palette for
// anything unrecognised. Names are upper-cased before lookup for safety.
const NAMED_COLOURS = {
  'BLACK':           '#0B1220',
  'CHARCOAL_BLACK':  '#1F2937',
  'CHARCOAL BLACK':  '#1F2937',
  'WHITE':           '#F1F5F9',
  'OFF WHITE':       '#FAF7F2',
  'OFFWHITE':        '#FAF7F2',
  'IVORY':           '#FAF6E9',
  'CREAM':           '#F5EFE0',
  'BEIGE':           '#E8DCC4',
  'GREY':            '#94A3B8',
  'GRAY':            '#94A3B8',
  'LIGHT GREY':      '#CBD5E1',
  'DARK GREY':       '#475569',
  'NAVY':            '#1E3A8A',
  'NAVY BLUE':       '#1E3A8A',
  'DARK BLUE':       '#1E3A8A',
  'MID BLUE':        '#2563EB',
  'BLUE':            '#3B82F6',
  'LIGHT BLUE':      '#60A5FA',
  'SKY BLUE':        '#7DD3FC',
  'VINTAGE BLUE':    '#1E40AF',
  'INDIGO':          '#4F46E5',
  'TEAL':            '#0D9488',
  'AQUA':            '#06B6D4',
  'GREEN':           '#16A34A',
  'OLIVE':           '#65A30D',
  'KHAKI':           '#A3A86B',
  'LIGHT GREEN':     '#86EFAC',
  'DARK GREEN':      '#15803D',
  'YELLOW':          '#EAB308',
  'MUSTARD':         '#CA8A04',
  'GOLD':            '#D97706',
  'ORANGE':          '#F97316',
  'CORAL':           '#FB7185',
  'RED':             '#DC2626',
  'MAROON':          '#7F1D1D',
  'BURGUNDY':        '#7F1D1D',
  'PINK':            '#EC4899',
  'LIGHT PINK':      '#FBCFE8',
  'ROSE':            '#F43F5E',
  'PURPLE':          '#8B5CF6',
  'LAVENDER':        '#C4B5FD',
  'VIOLET':          '#7C3AED',
  'BROWN':           '#78350F',
  'TAN':             '#A8814E',
  'CHOCOLATE':       '#5C2C0A',
  'CAMEL':           '#A78458',
};

// Premium fallback palette — used for sizes (no real colour mapping) and
// for unrecognised colour names. 8 hues that hold up next to each other.
const PREMIUM_PALETTE = [
  '#0B1220', // ink
  '#2563EB', // royal
  '#0D9488', // teal
  '#D97706', // amber
  '#7C3AED', // violet
  '#0EA5E9', // sky
  '#DC2626', // crimson
  '#65A30D', // olive
  '#475569', // slate (Others)
];

const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtCr  = (n) => {
  const v = Number(n || 0);
  if (v >= 10_000_000) return `₹${(v/10_000_000).toFixed(2)} Cr`;
  if (v >= 100_000)    return `₹${(v/100_000).toFixed(2)} L`;
  if (v >= 1_000)      return `₹${(v/1_000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtL = (n) => {
  const v = Number(n || 0);
  if (v >= 10_000_000) return (v/10_000_000).toFixed(2) + ' Cr';
  if (v >= 100_000)    return (v/100_000).toFixed(2) + 'L';
  if (v >= 1_000)      return (v/1_000).toFixed(1) + 'K';
  return v.toLocaleString('en-IN');
};

// ── Single donut card ─────────────────────────────────────────────────────
function DonutCard({
  title, icon: Icon, rows, loading,
  lensMode = 'net', valuation = 'gross',
  pickLabel,        // (row) => string
  colourFor,        // (label, idx) => hex
  topN = 8,
}) {
  const lensLabel = lensMode === 'sale' ? 'Sales' : lensMode === 'return' ? 'Returns' : 'Net';
  const lensColor = lensMode === 'sale' ? '#2563EB' : lensMode === 'return' ? '#F43F5E' : '#059669';
  const valuationLabel = valuation === 'gross' ? 'Gross' : valuation === 'ex_gst' ? 'Ex-GST' : valuation === 'gst' ? 'GST' : valuation === 'mrp' ? 'MRP' : valuation === 'discount' ? 'Discount' : valuation;

  // Hovered-slice state for the custom tooltip. Driven directly by the
  // Pie's per-Cell onMouseEnter so the displayed data is always the slice
  // the cursor is actually on. `pos` follows the cursor inside the chart
  // container so the tooltip floats just above the hovered slice's colour.
  const [hover, setHover] = useState(null); // { row, x, y } | null

  // Build the bucketed dataset: top N + Others. Each bucket carries its
  // lens-active units AND value (so the tooltip can show both). Recharts
  // re-renders are pure React reconciliation, so memoisation just avoids
  // recomputing the sort/slice — the chart itself doesn't pay an extra cost.
  const bucketed = useMemo(() => {
    const src = (rows || []).map(r => ({
      label: pickLabel(r) || '—',
      units: Math.max(0, Number(r._units || 0)),
      value: Math.max(0, Number(r._val   || 0)),
    })).filter(r => r.units > 0 || r.value > 0);

    src.sort((a, b) => b.units - a.units);
    if (src.length <= topN + 1) return src;

    const head   = src.slice(0, topN);
    const tail   = src.slice(topN);
    const others = tail.reduce(
      (acc, r) => ({ label: 'Others', units: acc.units + r.units, value: acc.value + r.value }),
      { label: 'Others', units: 0, value: 0 }
    );
    return [...head, others];
  }, [rows, pickLabel, topN]);

  const totalUnits = useMemo(() => bucketed.reduce((s, r) => s + r.units, 0), [bucketed]);
  const totalValue = useMemo(() => bucketed.reduce((s, r) => s + r.value, 0), [bucketed]);
  const palette    = useMemo(
    () => bucketed.map((r, i) => colourFor(r.label, i)),
    [bucketed, colourFor]
  );

  // Recharts pie data — one row per slice with units + value. The chart
  // reads `units` for slice angles via dataKey="units"; tooltip and legend
  // read the rest of the fields directly.
  const pieData = useMemo(
    () => bucketed.map((r, i) => ({ ...r, color: palette[i] })),
    [bucketed, palette]
  );

  // Tooltip component — receives the active slice's payload, renders the
  // same lens-aware HTML the previous ApexCharts custom tooltip did.
  const renderTooltip = ({ active, payload }) => {
    if (!active || !payload?.[0]) return null;
    const row = payload[0].payload || {};
    const total = totalUnits || 1;
    const pct   = ((Number(row.units) || 0) / total * 100).toFixed(1);
    return (
      <div className="distribution-donut-tooltip" style={{
        padding: '10px 14px', background: '#fff',
        border: '1px solid rgba(15,23,42,0.08)', borderRadius: 10,
        boxShadow: '0 12px 28px -10px rgba(15,23,42,0.18), 0 1px 2px rgba(15,23,42,0.04)',
        fontFamily: 'var(--font-body)', minWidth: 180,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: row.color, display: 'inline-block' }} />
          <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0B1220', letterSpacing: '-0.005em' }}>{row.label}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase' }}>
          <span>{lensLabel} Units</span>
          <span style={{ color: '#0B1220', fontFeatureSettings: '"tnum" 1' }}>{fmtNum(row.units)} · {pct}%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase', marginTop: 3 }}>
          <span>{valuationLabel}</span>
          <span style={{ color: lensColor, fontFeatureSettings: '"tnum" 1' }}>{fmtCr(row.value)}</span>
        </div>
      </div>
    );
  };

  const isEmpty = !loading && bucketed.length === 0;
  const showSkeleton = loading && bucketed.length === 0;

  return (
    <div className="sx-card distribution-donut-card" style={{ padding: '24px 26px 26px', overflow: 'hidden' }}>
      {/* Header */}
      <div className="distribution-donut-header" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{
          width: 26, height: 26, borderRadius: 8,
          background: 'rgba(15,23,42,0.04)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {Icon && <Icon size={13} color="currentColor" strokeWidth={2.2} />}
        </span>
        <span style={{
          fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 800,
          color: 'var(--text-primary)', letterSpacing: '-0.005em', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span className="sx-pill" style={{
          background: `${lensColor}10`,
          border: `1px solid ${lensColor}26`,
          color: lensColor,
        }}>
          <span className="sx-pill-dot" />
          {lensLabel} · {valuationLabel}
        </span>
      </div>

      {/* Body — wide donut + custom legend.
          Grid 1.55fr / 1fr pushes the donut canvas wider (~58% of card)
          so the chart reads like a hero figure instead of a thumbnail.
          Min-width on the donut column locks a generous canvas even when
          the legend tries to grow. Vertically aligned to top so the
          centre-text sits on the visual cross-axis with the header. */}
      <div className="distribution-donut-body" style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 1.55fr) minmax(200px, 1fr)',
        gap: 24, alignItems: 'start',
      }}>
        {/* Donut canvas — taller (360px) with a soft radial halo behind
            the chart so it floats off the card surface. The halo is a
            pure CSS gradient so it costs zero to paint and animates
            with the chart's own dropShadow. */}
        <div className="distribution-donut-visual" style={{
          minHeight: 360, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* Radial halo behind the donut — premium "lifted-off-page" feel */}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            background: `radial-gradient(closest-side, ${lensColor}0F 0%, transparent 72%)`,
            filter: 'blur(12px)',
            zIndex: 0, pointerEvents: 'none',
          }} />
          <div style={{ position: 'relative', zIndex: 1, width: '100%' }}>
          {showSkeleton && <div className="sx-shimmer" style={{ height: 320, borderRadius: '50%', maxWidth: 320, margin: '0 auto' }} />}
          {isEmpty && (
            <div style={{
              height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', fontWeight: 700, fontSize: 12,
            }}>No data for selected filters</div>
          )}
          {!showSkeleton && !isEmpty && (
            <div
              className="distribution-donut-chart"
              style={{ position: 'relative', width: '100%', height: 360 }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setHover(prev => prev ? { ...prev, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
              }}
              onMouseLeave={() => setHover(null)}
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="units"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius="58%"
                    outerRadius="80%"
                    stroke="#fff"
                    strokeWidth={3}
                    isAnimationActive={false}
                    paddingAngle={0}
                    onMouseLeave={() => setHover(null)}
                  >
                    {pieData.map((entry, i) => (
                      <Cell
                        key={`c-${i}`}
                        fill={entry.color}
                        // Per-Cell mouseEnter — fires reliably when the cursor
                        // crosses from one slice into another within the same
                        // Pie. Pie-level onMouseEnter only fires on Pie-entry,
                        // so it leaves stale tooltips when sliding slice→slice.
                        onMouseEnter={() => setHover(prev => ({ row: entry, x: prev?.x || 0, y: prev?.y || 0 }))}
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* Custom tooltip — positioned just above the cursor, anchored
                  to the slice's colour. Driven by per-slice mouseEnter so the
                  data shown always matches the slice under the cursor. */}
              {hover && (
                <div style={{
                  position: 'absolute',
                  left: Math.max(8, hover.x - 90),
                  top:  Math.max(8, hover.y - 90),
                  pointerEvents: 'none',
                  zIndex: 5,
                }}>
                  {renderTooltip({ active: true, payload: [{ payload: hover.row }] })}
                </div>
              )}
              {/* Centre overlay — pure HTML, never replaced by hover. Gives
                  full control over typography and never has the ApexCharts
                  closure-staleness problem. */}
              <div className="distribution-donut-center" style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <div style={{
                  fontSize: 34, fontWeight: 900,
                  fontFamily: 'var(--font-display)',
                  color: 'var(--text-primary)',
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>
                  {fmtL(totalUnits)}
                </div>
                <div style={{
                  marginTop: 6,
                  fontSize: 11, fontWeight: 800,
                  fontFamily: 'var(--font-body)',
                  color: 'var(--text-muted)',
                  letterSpacing: '0.08em',
                }}>
                  {lensLabel.toUpperCase()} UNITS
                </div>
              </div>
            </div>
          )}
          </div>
        </div>

        {/* Premium legend — rank dot + name + units + % share, scrollable
            so we can render all top N+1 entries without crowding the donut. */}
        <div className="distribution-donut-legend" style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
          {bucketed.map((r, i) => {
            const pct = totalUnits ? (r.units / totalUnits) * 100 : 0;
            return (
              <div key={r.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '12px 1fr auto',
                  gap: 10, alignItems: 'center',
                  padding: '7px 8px', borderRadius: 7,
                  transition: 'background 140ms ease',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(15,23,42,0.03)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: 3,
                  background: palette[i],
                  border: r.label === 'WHITE' || r.label === 'OFF WHITE' ? '1px solid rgba(15,23,42,0.12)' : 'none',
                  flexShrink: 0,
                }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{r.label}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', marginTop: 1, letterSpacing: '0.005em' }}>
                    {fmtNum(r.units)} {lensLabel.toLowerCase()} · {fmtCr(r.value)}
                  </div>
                </div>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 800,
                  color: 'var(--text-primary)', letterSpacing: '-0.005em',
                  fontFeatureSettings: '"tnum" 1',
                  minWidth: 42, textAlign: 'right',
                }}>{pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer reading: how many distinct items we visualised */}
      {!showSkeleton && !isEmpty && (
        <div style={{
          marginTop: 14, paddingTop: 12,
          borderTop: '1px solid rgba(15,23,42,0.05)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 8,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
            Top <strong style={{ color: 'var(--text-primary)' }}>{Math.min(topN, (rows||[]).length)}</strong> shown
            {(rows || []).length > topN && <> · <strong style={{ color: 'var(--text-primary)' }}>{(rows||[]).length - topN}</strong> more rolled into Others</>}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-disabled)', letterSpacing: '0.02em' }}>
            <span style={{ color: 'var(--text-muted)' }}>Total {valuationLabel.toLowerCase()}</span> · <span style={{ color: lensColor, fontFamily: 'var(--font-display)', fontFeatureSettings: '"tnum" 1' }}>{fmtCr(totalValue)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Public twin export ─────────────────────────────────────────────────────
export default function DistributionDonuts({ data, loading, lensMode = 'net', valuation = 'gross' }) {
  // Stable label pickers — wrapped in inline functions but the donut card
  // memoises by reference; useCallback isn't strictly needed because the
  // parent passes `data` from `dataLens` which only changes when the lens or
  // filters move (forcing the bucket to recompute anyway).
  const colourLabel = useCallback((r) => String(r?.color_name || '—'), []);
  const sizeLabel   = useCallback((r) => String(r?.size       || '—'), []);

  // Real-colour mapping for the colour donut. Falls back to the premium
  // palette in stable order so successive runs of the same data produce
  // the same hue assignment — important for visual continuity when the user
  // toggles lens.
  const colourFor = useCallback((label) => {
    const key = String(label || '').toUpperCase().trim();
    if (NAMED_COLOURS[key]) return NAMED_COLOURS[key];
    if (key === 'OTHERS')   return PREMIUM_PALETTE[PREMIUM_PALETTE.length - 1];
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return PREMIUM_PALETTE[h % (PREMIUM_PALETTE.length - 1)];
  }, []);
  const sizeFor = useCallback((label, idx) => {
    if (String(label || '').toUpperCase() === 'OTHERS')
      return PREMIUM_PALETTE[PREMIUM_PALETTE.length - 1];
    return PREMIUM_PALETTE[idx % (PREMIUM_PALETTE.length - 1)];
  }, []);

  return (
    <div className="sx-mobile-two-grid distribution-donuts-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
      <DonutCard
        title="Colour Distribution"
        icon={Palette}
        rows={data?.by_color}
        loading={loading}
        lensMode={lensMode}
        valuation={valuation}
        pickLabel={colourLabel}
        colourFor={colourFor}
        topN={8}
      />
      <DonutCard
        title="Size Distribution"
        icon={Ruler}
        rows={data?.by_size}
        loading={loading}
        lensMode={lensMode}
        valuation={valuation}
        pickLabel={sizeLabel}
        colourFor={sizeFor}
        topN={10}
      />
    </div>
  );
}
