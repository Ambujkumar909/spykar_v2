// ─── TodayVsLY — cumulative sales line, current period vs same-period-LY ────
// X-axis is day-index of the period (so MTD vs MTD-LY align even when the
// month boundaries don't).  Two series: solid brand for current, dashed
// muted for LY.  No axes — just gridless tick marks at start/end.

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import { formatINR } from '../../lib/v2/format';

// ApexCharts is window-only; SSR-skip per Next.js dynamic import pattern.
const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

export default function TodayVsLY({ data, loading, isDark }) {
  const series = useMemo(() => {
    // {x, y} object format — ApexCharts v4 ignores [x,y] tuples.
    // No per-series `type` field: that triggers "mixed chart" mode which
    // makes fill.opacity bleed into stroke opacity and hides the lines.
    const todayPts = (data || []).map((d, i) => ({ x: i, y: d.today || 0 }));
    const lyPts    = (data || []).map((d, i) => ({ x: i, y: d.ly ?? 0 }))
                      .filter(p => p.y != null);
    return [
      { name: 'This period',      data: todayPts },
      { name: 'Same period · LY', data: lyPts },
    ];
  }, [data]);

  const lastTodayValue = data?.length ? data[data.length - 1].today : 0;
  const lastLyValue    = data?.length ? data[data.length - 1].ly : null;
  const deltaPct = (lastLyValue && lastLyValue > 0)
    ? ((lastTodayValue - lastLyValue) / Math.abs(lastLyValue)) * 100
    : null;

  const fg = isDark ? '#D1D5DB' : '#374151';
  const mutedFg = isDark ? '#A8B0BC' : '#5B6470';
  const tooltipBg = isDark ? '#111827' : '#FFFFFF';
  const tooltipBorder = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.14)';
  const gridColor = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)';

  const options = useMemo(() => ({
    chart: {
      type: 'line', toolbar: { show: false }, zoom: { enabled: false },
      animations: { enabled: true, easing: 'easeOutCubic', speed: 600 },
      foreColor: fg, fontFamily: 'Inter, system-ui, sans-serif',
      background: 'transparent',
      theme: { mode: isDark ? 'dark' : 'light' },
    },
    stroke: {
      show: true,
      curve: 'smooth',
      lineCap: 'round',
      width: [4, 3],
      dashArray: [0, 6],
      colors: ['#E11D2E', isDark ? '#CBD5E1' : '#334155'],
    },
    colors: ['#E11D2E', isDark ? '#6B7280' : '#475569'],
    grid: { borderColor: gridColor, strokeDashArray: 3, padding: { left: 0, right: 0, top: 0, bottom: 0 } },
    legend: {
      show: true,
      position: 'top',
      horizontalAlign: 'left',
      fontSize: '12px',
      fontWeight: 700,
      labels: { colors: fg },
      markers: { width: 8, height: 8, radius: 8 },
    },
    xaxis: {
      type: 'numeric',
      axisBorder: { show: false }, axisTicks: { show: false },
      labels: { show: false },
      tooltip: { enabled: false },
    },
    yaxis: {
      labels: {
        style: { colors: fg, fontSize: '11px', fontWeight: 600 },
        formatter: (v) => {
          if (v >= 1e7) return '₹' + (v / 1e7).toFixed(1) + ' Cr';
          if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1) + ' L';
          if (v >= 1e3) return '₹' + (v / 1e3).toFixed(0) + 'K';
          return '₹' + v;
        },
      },
    },
    tooltip: {
      theme: isDark ? 'dark' : 'light',
      shared: true,
      x: { formatter: (i) => `Day ${Number(i) + 1}` },
      y: { formatter: v => v == null ? '—' : formatINR(v) },
      style: { fontSize: '12px' },
    },
    markers: {
      size: 3,
      colors: ['#E11D2E', isDark ? '#CBD5E1' : '#334155'],
      strokeColors: isDark ? '#171A20' : '#FFFFFF',
      strokeWidth: 2,
      hover: { size: 6 },
    },
  }), [fg, gridColor, isDark]);

  return (
    <div className="v2-card v2-today-vs-ly-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{
            fontFamily: 'var(--v2-font-display)',
            fontSize: 13, fontWeight: 800,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: isDark ? '#A8B0BC' : '#5B6470',
          }}>
            This Period vs Same Period · LY
          </div>
          <div style={{ fontSize: 13, marginTop: 4, color: isDark ? '#D1D5DB' : '#374151' }}>
            Cumulative net sales — pace at the cutoff
          </div>
        </div>
        {deltaPct != null && (
          <div
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 999,
              background: deltaPct >= 0 ? 'var(--v2-ok-50)' : 'var(--v2-bad-50)',
              color:      deltaPct >= 0 ? 'var(--v2-ok-500)' : 'var(--v2-bad-500)',
              border: `1px solid ${deltaPct >= 0 ? 'var(--v2-ok-500)' : 'var(--v2-bad-500)'}`,
              fontSize: 11, fontWeight: 700,
              flexShrink: 0,
            }}
          >
            <TrendingUp size={11} style={{ transform: deltaPct >= 0 ? 'none' : 'rotate(180deg)' }} />
            {Math.abs(deltaPct).toFixed(1)}% {deltaPct >= 0 ? 'ahead' : 'behind'}
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ height: 220, background: 'var(--v2-bg-elevated)', borderRadius: 8 }} />
      ) : (data || []).length === 0 ? (
        <div style={{
          height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--v2-fg-tertiary)', fontSize: 13,
        }}>
          No daily series in this window
        </div>
      ) : (
        <Chart key={`tdvsly-${isDark ? 'dark' : 'light'}-${(data||[]).length}`} options={options} series={series} type="line" height={220} />
      )}
      <style jsx global>{`
        .v2-today-vs-ly-card .apexcharts-legend-text {
          color: ${fg} !important;
        }
        .v2-today-vs-ly-card .apexcharts-yaxis-label tspan,
        .v2-today-vs-ly-card .apexcharts-xaxis-label tspan {
          fill: ${fg} !important;
        }
        .v2-today-vs-ly-card .apexcharts-grid line,
        .v2-today-vs-ly-card .apexcharts-gridline {
          stroke: ${gridColor} !important;
        }
        .v2-today-vs-ly-card .apexcharts-line-series .apexcharts-series path,
        .v2-today-vs-ly-card .apexcharts-line .apexcharts-series path {
          opacity: 1 !important;
          stroke-opacity: 1 !important;
          fill: none !important;
        }
        .v2-today-vs-ly-card .apexcharts-line-series .apexcharts-series:nth-of-type(1) path,
        .v2-today-vs-ly-card .apexcharts-line .apexcharts-series:nth-of-type(1) path {
          stroke: #E11D2E !important;
        }
        .v2-today-vs-ly-card .apexcharts-line-series .apexcharts-series:nth-of-type(2) path,
        .v2-today-vs-ly-card .apexcharts-line .apexcharts-series:nth-of-type(2) path {
          stroke: ${isDark ? '#CBD5E1' : '#334155'} !important;
        }
        .v2-today-vs-ly-card .apexcharts-tooltip {
          background: ${tooltipBg} !important;
          border-color: ${tooltipBorder} !important;
        }
        .v2-today-vs-ly-card .apexcharts-tooltip-title {
          color: ${mutedFg} !important;
          background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)'} !important;
        }
        .v2-today-vs-ly-card .apexcharts-tooltip-text-y-label,
        .v2-today-vs-ly-card .apexcharts-tooltip-text-y-value {
          color: ${fg} !important;
        }
      `}</style>
    </div>
  );
}
