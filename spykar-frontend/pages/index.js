// ─── /  — Overview (the executive dashboard) ────────────────────────────────
// This page WAS previously a 2,500-line legacy "v1" Overview hitting ~10
// heavy backend endpoints on every load.  It has been replaced with the
// v2 Executive Redesign — same surface (route /), but driven by a single
// slim metrics hook and only 4-5 lightweight endpoints.
//
// Why the old code is gone, not commented out:
//   • Every old API call (executive-summary, ageing, alerts, alerts-summary,
//     analytics/sales mega-CTE, cross-pivot, top-moving, slow-moving, sync,
//     in-transit, size-distribution, color-distribution) is no longer
//     reachable from the UI.  Strict requirement: "no api call, no query
//     should be there from old overview page."
//   • Bundle size for /  drops dramatically (no PremiumKpi, CrossPivotTables,
//     dispatch service, etc. as dependencies).
//
// Layout / behaviour:
//   • Light theme is default; theme toggle in TopBar flips to "boardroom" dark.
//   • TopBar drives time range (Today/WTD/MTD/QTD/YTD/Custom), sync pill,
//     saved-view picker, filter drawer, theme toggle.
//   • Hero zone — narrative banner + 5 KPI cards (Net Sales · Units · Inv
//     Valuation · Sell-Through · Return Rate) with sparklines, vs-LY deltas,
//     count-up.
//   • Intelligence grid — India choropleth, aging waterfall (last-sold
//     bucketing), today-vs-LY pace, channel mix donut.
//   • Right rail — Needs Attention exception list (out-of-stock, reorder,
//     aged inventory, sync freshness, return-rate spikes, silent stores).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { IndianRupee, Package, Boxes, Percent, RotateCcw } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import { useTheme } from '../lib/v2/useTheme';
import { useTimeRange } from '../lib/v2/useTimeRange';
import { useDashboardMetrics } from '../lib/v2/useDashboardMetrics';
import { useKeyboardShortcuts } from '../lib/v2/useKeyboardShortcuts';
import TopBar from '../components/dashboard-v2/TopBar';
import NarrativeBanner from '../components/dashboard-v2/NarrativeBanner';
import KpiHeroCard, { KpiHeroCardSkeleton } from '../components/dashboard-v2/KpiHeroCard';
import IndiaHeatmap from '../components/dashboard-v2/IndiaHeatmap';
import AgingWaterfall from '../components/dashboard-v2/AgingWaterfall';
import TodayVsLY from '../components/dashboard-v2/TodayVsLY';
import CategoryMix from '../components/dashboard-v2/CategoryMix';
import Sidebar from '../components/layout/Sidebar';
import AiChatbot from '../components/AiChatbot';

const DEFAULT_MODE = 'active';
const DEFAULT_VALUATION = 'gross';

export default function Overview() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { isDark, toggle: toggleTheme } = useTheme();
  const { preset, setPreset, fromISO, toISO, setCustom } = useTimeRange('mtd');
  const [mode,      setMode]      = useState(DEFAULT_MODE);
  const [valuation, setValuation] = useState(DEFAULT_VALUATION);

  const { data: metrics, loading: metricsLoading } = useDashboardMetrics({
    fromISO, toISO, mode, valuation,
  });

  // T/M/Y for time presets, D for dark mode. (Filter drawer + its F shortcut
  // were removed — filters now live inline in the TopBar.)
  useKeyboardShortcuts({
    setPreset,
    toggleTheme,
  });

  // Same auth gate the rest of the app uses.
  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-canvas)', color: 'var(--text-muted)',
        fontSize: 13, fontFamily: 'Inter, sans-serif',
      }}>
        Loading Spykar IQ…
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-content" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className={`v2-app${isDark ? ' theme-dark' : ''}`} style={{ flex: 1 }}>
          <TopBar
            preset={preset}
            onPresetChange={setPreset}
            fromISO={fromISO}
            toISO={toISO}
            onCustomRangeChange={setCustom}
            isDark={isDark}
            onToggleTheme={toggleTheme}
            mode={mode}
            onModeChange={setMode}
            valuation={valuation}
            onValuationChange={setValuation}
            user={user}
          />

          <div
            className="v2-page-grid"
            style={{
              maxWidth: 1480,
              margin: '0 auto',
              padding: '20px 24px 64px',
              display: 'grid',
              gap: 20,
            }}
          >
            <main style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
              {/* Zone B — Narrative Banner */}
              <NarrativeBanner
                kpis={metrics?.kpis}
                asOf={metrics?.asOf}
                loading={metricsLoading}
              />

              {/* Zone C — Hero KPI row (5 cards on desktop, wraps on smaller screens) */}
              <div
                className="v2-kpi-row"
                style={{ display: 'grid', gap: 12 }}
              >
                {metricsLoading ? (
                  <>
                    <KpiHeroCardSkeleton label="Net Sales"           icon={IndianRupee} />
                    <KpiHeroCardSkeleton label="Units Sold"          icon={Package} />
                    <KpiHeroCardSkeleton label="Inventory Valuation" icon={Boxes} />
                    <KpiHeroCardSkeleton label="Sell-Through"        icon={Percent} />
                    <KpiHeroCardSkeleton label="Return Rate"         icon={RotateCcw} />
                  </>
                ) : (
                  <>
                    <KpiHeroCard
                      label="Net Sales" icon={IndianRupee} unit="cr"
                      value={metrics?.kpis?.netSales?.value}
                      delta={metrics?.kpis?.netSales?.delta}
                      sparkline={metrics?.kpis?.netSales?.spark}
                      footnote={metrics?.kpis?.netSales?.footnote}
                    />
                    <KpiHeroCard
                      label="Units Sold" icon={Package} unit="count"
                      value={metrics?.kpis?.unitsSold?.value}
                      delta={metrics?.kpis?.unitsSold?.delta}
                      sparkline={metrics?.kpis?.unitsSold?.spark}
                      footnote={metrics?.kpis?.unitsSold?.footnote}
                    />
                    <KpiHeroCard
                      label="Inventory Valuation" icon={Boxes} unit="cr"
                      value={metrics?.kpis?.inventoryValuation?.value}
                      delta={metrics?.kpis?.inventoryValuation?.delta}
                      sparkline={metrics?.kpis?.inventoryValuation?.spark}
                      footnote={metrics?.kpis?.inventoryValuation?.footnote}
                    />
                    <KpiHeroCard
                      label="Sell-Through" icon={Percent} unit="%"
                      value={metrics?.kpis?.sellThrough?.value}
                      delta={metrics?.kpis?.sellThrough?.delta}
                      sparkline={metrics?.kpis?.sellThrough?.spark}
                      footnote={metrics?.kpis?.sellThrough?.footnote}
                    />
                    <KpiHeroCard
                      label="Return Rate" icon={RotateCcw} unit="%"
                      value={metrics?.kpis?.returnRate?.value}
                      delta={metrics?.kpis?.returnRate?.delta}
                      deltaUnit="pp"
                      inverseHealth
                      sparkline={metrics?.kpis?.returnRate?.spark}
                      footnote={metrics?.kpis?.returnRate?.footnote}
                    />
                  </>
                )}
              </div>

              {/* Zone D — Intelligence Grid */}
              <div
                id="aging"
                className="v2-intelligence"
                style={{ display: 'grid', gap: 16 }}
              >
                <IndiaHeatmap   data={metrics?.stateHeatmap} loading={metricsLoading} preset={preset} fromISO={fromISO} toISO={toISO} />
                <AgingWaterfall loading={metricsLoading} />
                <TodayVsLY      data={metrics?.todayVsLy}    loading={metricsLoading} isDark={isDark} />
                <CategoryMix    data={metrics?.channelMix}   loading={metricsLoading} isDark={isDark} />
              </div>
            </main>

            {/* Zone E — "Needs Attention" right rail removed (disabled per request) */}
          </div>
        </div>
      </div>

      {/* Floating Spykar IQ chatbot — same instance used on every other page */}
      <AiChatbot />
    </div>
  );
}
