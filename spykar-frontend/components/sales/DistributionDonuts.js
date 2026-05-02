// ─── DistributionDonuts — premium twin donut for Colour + Size ───────────────
// Two side-by-side donut charts that visualise how units / revenue split
// across Colour and Size dimensions. Lens-aware (Sale/Return/Net) and
// valuation-aware (Gross / Ex-GST / GST / MRP / Discount) — the slice
// math + center figure flip together with the page-level pills.
//
// Performance:
//   • Reads from `data.by_color` and `data.by_size` already in `dataLens`
//     (parent passes the lens-enriched arrays). No extra API call, no extra
//     cache key — inherits the sales endpoint's 10-min Redis TTL and the
//     frontend dashboardCache 10-min freshness window.
//   • Series + options memoised on (rows × lens × valuation × topN). Re-renders
//     during unrelated state changes (filter dropdown opens, hover) cost ~0.
//   • Top N + "Others" bucket caps DOM nodes at 9 slices regardless of how
//     many distinct colours / sizes the dataset has — keeps the canvas snappy.
//
// Visual:
//   • 78%-thick donut so the centre stays legible
//   • Centre shows the lens-active total (units) with a soft label
//   • Custom legend: rank dot · name · units · % share
//   • Hover: ApexCharts highlights the active slice + premium tooltip
//   • Reduced motion friendly via the global guard in styles/globals.css

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Palette, Ruler } from 'lucide-react';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

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

  // Build the bucketed dataset: top N + Others. Each bucket carries its
  // lens-active units AND value (so the tooltip can show both). Memoised
  // on the array reference, lensMode and valuation — the parent passes
  // pre-enriched rows from `dataLens`, so this is essentially a sort+slice.
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
  }, [rows, pickLabel, topN, lensMode, valuation]);

  const totalUnits = useMemo(() => bucketed.reduce((s, r) => s + r.units, 0), [bucketed]);
  const totalValue = useMemo(() => bucketed.reduce((s, r) => s + r.value, 0), [bucketed]);
  const palette    = useMemo(
    () => bucketed.map((r, i) => colourFor(r.label, i)),
    [bucketed, colourFor]
  );

  const series  = useMemo(() => bucketed.map(r => r.units), [bucketed]);
  const labels  = useMemo(() => bucketed.map(r => r.label), [bucketed]);

  // Apex options — premium donut with center total + custom tooltip.
  // Larger radius, thicker ring, dramatic centre value, gradient-tinted
  // segment fills, and a deeper soft shadow lifted off the canvas via
  // SVG filter — gives the donut a "frosted-glass over neutral" feel.
  const options = useMemo(() => ({
    chart: {
      type: 'donut',
      fontFamily: 'var(--font-body)',
      animations: {
        enabled: true,
        easing: 'easeOutCubic',
        speed: 700,
        animateGradually: { enabled: true, delay: 60 },
      },
      toolbar: { show: false },
      sparkline: { enabled: false },
      background: 'transparent',
      dropShadow: {
        enabled: true,
        top: 4, left: 0, blur: 14,
        opacity: 0.10,
        color: 'var(--text-primary)',
      },
    },
    labels,
    colors: palette,
    stroke: { width: 3, colors: ['#fff'] },
    fill: {
      type: 'gradient',
      gradient: {
        shade: 'light',
        type: 'diagonal2',
        shadeIntensity: 0.16,
        gradientToColors: undefined, // auto-derive lighter shade
        inverseColors: false,
        opacityFrom: 1,
        opacityTo: 0.92,
        stops: [0, 100],
      },
    },
    plotOptions: {
      pie: {
        donut: {
          size: '74%', // slightly thicker ring for premium presence
          background: 'transparent',
          labels: {
            show: true,
            // Single source of truth for the donut centre. We drop the
            // separate `name` + `value` blocks because Apex prioritises
            // them on hover and they don't always pick up lensLabel
            // changes from a re-memoised options object — `total` with
            // `showAlways: true` is the deterministic path.
            name: {
              show: true,
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              fontWeight: 800,
              color: 'var(--text-muted)',
              letterSpacing: '0.08em',
              offsetY: 24,
              formatter: () => `${lensLabel.toUpperCase()} UNITS`,
            },
            value: {
              show: true,
              fontSize: '34px', // bigger, more dramatic hero number
              fontFamily: 'var(--font-display)',
              fontWeight: 900,
              color: 'var(--text-primary)',
              letterSpacing: '-0.02em',
              offsetY: -20,
              formatter: (v) => fmtL(Number(v) || 0),
            },
            total: {
              show: true,
              showAlways: true,
              label: `${lensLabel.toUpperCase()} UNITS`,
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              fontWeight: 800,
              color: 'var(--text-muted)',
              formatter: () => fmtL(totalUnits),
            },
          },
        },
        expandOnClick: false,
        offsetX: 0, offsetY: 0,
        customScale: 0.96, // tiny breathing room inside the larger canvas
      },
    },
    dataLabels: { enabled: false },
    legend:     { show: false }, // we render our own premium legend
    states: {
      hover:  { filter: { type: 'lighten', value: 0.06 } },
      active: { filter: { type: 'darken',  value: 0.10 } },
    },
    tooltip: {
      style: { fontSize: '12px', fontFamily: 'var(--font-body)' },
      custom: ({ series, seriesIndex }) => {
        const row = bucketed[seriesIndex] || {};
        const total = totalUnits || 1;
        const pct   = ((Number(series[seriesIndex] || 0) / total) * 100).toFixed(1);
        return `
          <div style="
            padding: 10px 14px;
            background: #fff;
            border: 1px solid rgba(15,23,42,0.08);
            border-radius: 10px;
            box-shadow: 0 12px 28px -10px rgba(15,23,42,0.18), 0 1px 2px rgba(15,23,42,0.04);
            font-family: var(--font-body);
            min-width: 180px;
          ">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${palette[seriesIndex]};display:inline-block;"></span>
              <span style="font-size:12.5px;font-weight:800;color:#0B1220;letter-spacing:-0.005em">${row.label}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#475569;font-weight:700;letter-spacing:0.02em;text-transform:uppercase">
              <span>${lensLabel} Units</span><span style="color:#0B1220;font-feature-settings:'tnum'">${fmtNum(row.units)} · ${pct}%</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#475569;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;margin-top:3px">
              <span>${valuationLabel}</span><span style="color:${lensColor};font-feature-settings:'tnum'">${fmtCr(row.value)}</span>
            </div>
          </div>
        `;
      },
    },
    responsive: [
      { breakpoint: 1280, options: { chart: { height: 320 } } },
      { breakpoint: 900,  options: { chart: { height: 280 } } },
      { breakpoint: 640,  options: { chart: { height: 240 } } },
    ],
  }), [bucketed, labels, palette, lensLabel, lensColor, valuationLabel, totalUnits]);

  const isEmpty = !loading && bucketed.length === 0;
  const showSkeleton = loading && bucketed.length === 0;

  return (
    <div className="sx-card" style={{ padding: '24px 26px 26px', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{
          width: 26, height: 26, borderRadius: 8,
          background: 'rgba(15,23,42,0.04)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {Icon && <Icon size={13} color="#0B1220" strokeWidth={2.2} />}
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
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 1.55fr) minmax(200px, 1fr)',
        gap: 24, alignItems: 'start',
      }}>
        {/* Donut canvas — taller (360px) with a soft radial halo behind
            the chart so it floats off the card surface. The halo is a
            pure CSS gradient so it costs zero to paint and animates
            with the chart's own dropShadow. */}
        <div style={{
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
            // Key forces a fresh chart instance on lens / valuation change.
            // Without it, Apex sometimes caches the centre-text formatter
            // closure from the prior render and shows the wrong label
            // ("NET UNITS" while chip reads "SALES · GROSS"). Re-mounting
            // costs ~30 ms and the parent already keeps `bucketed` stable
            // so DOM diffing is cheap.
            <Chart
              key={`${lensMode}-${valuation}`}
              options={options}
              series={series}
              type="donut"
              height={360}
            />
          )}
          </div>
        </div>

        {/* Premium legend — rank dot + name + units + % share, scrollable
            so we can render all top N+1 entries without crowding the donut. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
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
  const colourLabel = (r) => String(r?.color_name || '—');
  const sizeLabel   = (r) => String(r?.size       || '—');

  // Real-colour mapping for the colour donut. Falls back to the premium
  // palette in stable order so successive runs of the same data produce
  // the same hue assignment — important for visual continuity when the user
  // toggles lens.
  const colourFor = (label) => {
    const key = String(label || '').toUpperCase().trim();
    if (NAMED_COLOURS[key]) return NAMED_COLOURS[key];
    if (key === 'OTHERS')   return PREMIUM_PALETTE[PREMIUM_PALETTE.length - 1];
    // Stable hash → palette index for unrecognised colour names
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return PREMIUM_PALETTE[h % (PREMIUM_PALETTE.length - 1)];
  };
  const sizeFor = (label, idx) => {
    if (String(label || '').toUpperCase() === 'OTHERS')
      return PREMIUM_PALETTE[PREMIUM_PALETTE.length - 1];
    return PREMIUM_PALETTE[idx % (PREMIUM_PALETTE.length - 1)];
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
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
