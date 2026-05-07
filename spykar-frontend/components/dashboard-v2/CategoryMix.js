// ─── CategoryMix — donut of net sales by channel (no real category column) ──
// Until the schema gets a category dimension we use channel (EBO-SOR /
// Alternate-SOR / etc.) which is the closest meaningful split for an
// executive view.  Center label = total sales; side legend = each slice
// with its share + raw value.

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { formatINR, formatPct } from '../../lib/v2/format';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const PALETTE = [
  '#E11D2E', // brand red
  '#3B82F6', // info blue
  '#10B981', // ok green
  '#F59E0B', // warn amber
  '#A855F7', // accent violet
  '#14B8A6', // teal
  '#F97316', // orange
];

export default function CategoryMix({ data, loading, isDark }) {
  const slices = useMemo(() => (data || []).map((r, i) => ({
    name:  r.name,
    value: r.value,
    color: PALETTE[i % PALETTE.length],
    units: r.units,
    stores: r.stores,
  })), [data]);

  const total = slices.reduce((s, x) => s + x.value, 0);
  const labelColor = isDark ? '#FAFAFA' : '#0A0B0D';
  const subColor   = isDark ? '#D1D5DB' : '#374151';
  const mutedColor = isDark ? '#A8B0BC' : '#5B6470';
  const legendBg = isDark ? '#1F232B' : '#F4F5F7';
  const legendBorder = isDark ? '#2A2F3A' : '#D2D6DD';

  const options = useMemo(() => ({
    chart: { type: 'donut', toolbar: { show: false }, fontFamily: 'Inter, system-ui, sans-serif', background: 'transparent', foreColor: labelColor, theme: { mode: isDark ? 'dark' : 'light' } },
    colors: slices.map(s => s.color),
    labels: slices.map(s => s.name),
    stroke: { width: 3, colors: [isDark ? '#171A20' : '#FFFFFF'] },
    legend: { show: false },
    dataLabels: { enabled: false },
    plotOptions: {
      pie: {
        donut: {
          size: '72%',
          labels: {
            show: true,
            name:  { show: true, fontSize: '10px', fontWeight: 700, color: subColor, offsetY: 22 },
            value: {
              show: true, fontSize: '24px', fontWeight: 800, color: labelColor,
              offsetY: -10,
              formatter: (v) => formatINR(Number(v)),
            },
            total: {
              show: true, label: 'Total Sales',
              fontSize: '10px', fontWeight: 800, color: subColor,
              formatter: () => formatINR(total),
            },
          },
        },
      },
    },
    tooltip: {
      theme: isDark ? 'dark' : 'light',
      y: { formatter: (v) => formatINR(v) },
    },
    states: { hover: { filter: { type: 'lighten', value: 0.05 } } },
  }), [slices, total, labelColor, subColor, isDark]);

  return (
    <div className="v2-card v2-channel-mix-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontFamily: 'var(--v2-font-display)',
          fontSize: 13, fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: mutedColor,
        }}>
          Channel Mix
        </div>
        <div style={{ fontSize: 13, marginTop: 4, color: subColor }}>
          Net sales contribution by store channel
        </div>
      </div>

      {loading ? (
        <div style={{ height: 220, background: 'var(--v2-bg-elevated)', borderRadius: 8 }} />
      ) : slices.length === 0 ? (
        <div style={{
          height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--v2-fg-tertiary)', fontSize: 13,
        }}>
          No channel data
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'center' }}>
          <Chart options={options} series={slices.map(s => s.value)} type="donut" height={220} />
          {/* Side legend */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {slices.map(s => {
              const pct = total ? (s.value / total) * 100 : 0;
              return (
                <div
                  key={s.name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px',
                    background: legendBg,
                    borderRadius: 8,
                    border: `1px solid ${legendBorder}`,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: s.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 11.5, fontWeight: 700,
                      color: labelColor,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {s.name}
                    </div>
                    <div className="tabular-nums" style={{ fontSize: 11, fontWeight: 700, color: mutedColor }}>
                      {formatINR(s.value)} · {formatPct(pct, { decimals: 0 })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <style jsx global>{`
        .v2-channel-mix-card .apexcharts-datalabel-label,
        .v2-channel-mix-card .apexcharts-datalabel-label tspan {
          fill: ${subColor} !important;
          color: ${subColor} !important;
        }
        .v2-channel-mix-card .apexcharts-datalabel-value,
        .v2-channel-mix-card .apexcharts-datalabel-value tspan {
          fill: ${labelColor} !important;
          color: ${labelColor} !important;
        }
        .v2-channel-mix-card .apexcharts-pie-label,
        .v2-channel-mix-card .apexcharts-text {
          fill: ${labelColor} !important;
        }
        .v2-channel-mix-card .apexcharts-tooltip-text-y-label,
        .v2-channel-mix-card .apexcharts-tooltip-text-y-value {
          color: ${labelColor} !important;
        }
      `}</style>
    </div>
  );
}
