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
    const todayPts = (data || []).map((d, i) => [i, d.today || 0]);
    const lyPts    = (data || []).map((d, i) => [i, d.ly]).filter(p => p[1] != null);
    return [
      { name: 'This period', type: 'line', data: todayPts },
      { name: 'Same period · LY', type: 'line', data: lyPts },
    ];
  }, [data]);

  const lastTodayValue = data?.length ? data[data.length - 1].today : 0;
  const lastLyValue    = data?.length ? data[data.length - 1].ly : null;
  const deltaPct = (lastLyValue && lastLyValue > 0)
    ? ((lastTodayValue - lastLyValue) / Math.abs(lastLyValue)) * 100
    : null;

  const fg = isDark ? '#A8B0BC' : '#5B6470';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(10,11,13,0.06)';

  const options = useMemo(() => ({
    chart: {
      type: 'line', toolbar: { show: false }, zoom: { enabled: false },
      animations: { enabled: true, easing: 'easeOutCubic', speed: 600 },
      foreColor: fg, fontFamily: 'Inter, system-ui, sans-serif',
      background: 'transparent',
    },
    stroke: { curve: 'smooth', width: [2.5, 1.5], dashArray: [0, 5] },
    colors: ['#E11D2E', isDark ? '#6B7280' : '#8A929D'],
    grid: { borderColor: gridColor, strokeDashArray: 3, padding: { left: 0, right: 0, top: 0, bottom: 0 } },
    legend: { show: true, position: 'top', horizontalAlign: 'left', fontSize: '12px', fontWeight: 600, markers: { width: 8, height: 8, radius: 8 } },
    xaxis: {
      type: 'numeric',
      axisBorder: { show: false }, axisTicks: { show: false },
      labels: { show: false },
      tooltip: { enabled: false },
    },
    yaxis: {
      labels: {
        style: { colors: fg, fontSize: '11px' },
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
    },
    markers: { size: 0, hover: { size: 4 } },
    fill: {
      type: 'gradient',
      gradient: { type: 'vertical', shadeIntensity: 1, opacityFrom: 0.18, opacityTo: 0, stops: [0, 100] },
    },
  }), [fg, gridColor, isDark]);

  return (
    <div className="v2-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{
            fontFamily: 'var(--v2-font-display)',
            fontSize: 13, fontWeight: 800,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--v2-fg-tertiary)',
          }}>
            This Period vs Same Period · LY
          </div>
          <div style={{ fontSize: 13, marginTop: 4, color: 'var(--v2-fg-secondary)' }}>
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
        <Chart options={options} series={series} type="line" height={220} />
      )}
    </div>
  );
}
