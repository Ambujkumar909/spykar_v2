// ─── useDashboardMetrics — single round-trip data hook for v2 dashboard ──────
// Returns the shape every KPI card + the narrative banner needs:
//   { loading, error, asOf, kpis: {netSales, unitsSold, inventoryValuation,
//     sellThrough, returnRate}, syncStatus }
//
// Fetch strategy:
//   • Sales current period   — /analytics/sales?date_from=A&date_to=B
//   • Sales last year period — /analytics/sales?date_from=A-1y&date_to=B-1y
//   • Inventory snapshot     — /inventory/executive-summary
// All three issue in parallel; deltas are computed client-side from the pair.
//
// Sparklines: backend doesn't yet return per-day series for hero metrics, so
// we synthesise a 30-point random-walk anchored on the current value.  Not
// shown to users as accurate history — purely a visual "is it trending"
// pulse until the backend adds /analytics/sales/daily-series in Phase 4.

import { useEffect, useState, useMemo } from 'react';
import { analyticsService, inventoryService, syncService } from '../services';
import { getCached, setCached, isFresh } from '../dashboardCache';
import { pctDelta } from './format';

function shiftYear(iso, years) {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() - years);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Pull a sparkline series from the backend's daily array.  Falls back to a
// deterministic fake when the daily series is empty (e.g. very small windows).
// `field` is one of: sales_value, sales_qty, return_qty.  Limit to last 30
// points so all KPI sparklines have a comparable scale on the x-axis.
function realSparkline(daily, field, limit = 30) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  const slice = daily.slice(-limit);
  // Cumulative for sales-rate KPIs — non-cumulative for headline value.  Per
  // KPI we just take the daily value; the sparkline renders its own scale.
  return slice.map(d => Number(d[field] || 0));
}

// Cumulative variant for return-rate (rolling window so it doesn't reset).
function returnRateSparkline(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  const slice = daily.slice(-30);
  return slice.map(d => {
    const sold = Number(d.sales_qty || 0);
    const ret  = Number(d.return_qty || 0);
    return sold + ret > 0 ? (ret / Math.max(1, sold)) * 100 : 0;
  });
}

// Map the valuation lens onto the slim-summary fields.  The backend's
// getSalesSummary returns parallel families:
//   gross    → sales_value      / return_value      / net_value
//   ex_gst   → sales_ex_gst_value / return_ex_gst_value / net_ex_gst_value
//   gst      → sales_gst_collected / return_gst_collected / net_gst_collected
//   mrp      → sales_mrp_value  / return_mrp_value  / net_mrp_value
//   discount → sales_discount_value (no return/net family — pure delta)
function pickNet(summary, valuation) {
  const c = summary || {};
  switch (valuation) {
    case 'ex_gst':   return Number(c.net_ex_gst_value     || 0);
    case 'gst':      return Number(c.net_gst_collected    || 0);
    case 'mrp':      return Number(c.net_mrp_value        || 0);
    case 'discount': return Number(c.sales_discount_value || 0);
    case 'gross':
    default:         return Number(c.net_value || c.net_gross_value || 0);
  }
}

function pickSalesField(valuation) {
  switch (valuation) {
    case 'ex_gst':   return 'sales_ex_gst_value';
    case 'gst':      return 'sales_gst_collected';
    case 'mrp':      return 'sales_mrp_value';
    case 'discount': return 'sales_discount_value';
    case 'gross':
    default:         return 'sales_value';
  }
}

export function useDashboardMetrics({ fromISO, toISO, mode = 'active', valuation = 'gross' } = {}) {
  // Instant-paint cache key — same mechanism /sales and /network use. Persisted
  // to localStorage (see the 'ov:metrics:' entry in dashboardCache PERSIST_TIERS)
  // so revisiting the dashboard — even after a full reload or browser restart —
  // paints last-known numbers synchronously instead of flashing skeletons while
  // a (50 ms) refetch runs. valuation is in the key because the computed KPI
  // payload bakes in the valuation lens.
  const cacheKey = `ov:metrics:${fromISO || ''}:${toISO || ''}:${mode}:${valuation}`;

  const [data, setData]       = useState(() => getCached(cacheKey) ?? null);
  const [loading, setLoading] = useState(() => !getCached(cacheKey));
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!fromISO || !toISO) return;
    let alive = true;
    setError(null);

    // Paint cached data immediately; only show the skeleton when we truly have
    // nothing for this key yet.
    const cached = getCached(cacheKey);
    if (cached) { setData(cached); setLoading(false); }
    else        { setLoading(true); }

    const lyFrom = shiftYear(fromISO, 1);
    const lyTo   = shiftYear(toISO, 1);

    // State heatmap is the heaviest dashboard query (full inventory_movements
    // scan, grouped by state). It feeds ONLY the India map — no KPI card needs
    // it — so we fetch it OUT-OF-BAND and merge it in when it lands, instead of
    // gating the whole `loading` flag (and thus every KPI card + skeleton) on
    // the slowest call. KPIs now paint as soon as sales + inventory resolve;
    // the map fills in a beat later without holding the page hostage.
    //
    // `heatmapData` bridges the two async paths so the merge is order-independent:
    //   • heatmap resolves first → setData is a no-op (data not built yet), but
    //     the Promise.all below reads heatmapData when it constructs `data`.
    //   • Promise.all resolves first → it seeds stateHeatmap:null, then this
    //     handler patches the real value in.
    let heatmapData = cached?.stateHeatmap ?? null;
    analyticsService.getStateHeatmap?.({ date_from: fromISO, date_to: toISO, mode })
      .then(heatmap => {
        if (!alive) return;
        heatmapData = heatmap?.data?.data || null;
        setData(prev => (prev ? { ...prev, stateHeatmap: heatmapData } : prev));
      })
      .catch(() => { /* best-effort — map shows its empty state */ });

    // Fresh cache (within TTL and newer than the last sync) → the numbers on
    // screen are already current. Skip the KPI refetch entirely; flipping
    // back to the dashboard costs zero network. isFresh() returns false after
    // a sync (Header feeds setDataVersion), so post-sync we still refresh.
    if (cached && isFresh(cacheKey)) {
      return () => { alive = false; };
    }

    Promise.all([
      // Slim endpoint — returns ONLY summary + daily + by_channel (the three
      // blocks v2 consumes).  ~240 ms cold vs ~8 s for /analytics/sales.
      analyticsService.getSalesSummary({ date_from: fromISO, date_to: toISO, mode }),
      // LY data for a closed window doesn't change — bump TTL to 24h.
      analyticsService.getSalesSummary({
        date_from: lyFrom, date_to: lyTo, mode, ttl_override: 86400,
      }).catch(() => null),
      inventoryService.getExecutiveSummary({ mode }),
      syncService.getStatus().catch(() => null),
      // Removed: inventoryService.getAgeing + getAlertsSummary — these fed ONLY
      // the (now-removed) "Needs Attention" rail and the already-paused Aging
      // widget, so the dashboard no longer calls either endpoint. The endpoints
      // themselves are untouched (other pages still use /inventory/alerts via
      // useAlerts, and /inventory/ageing remains available).
      // Removed earlier: skuService.getTopMoving / getSlowMoving (SKU Pulse retired).
    ])
      .then(([cur, ly, inv, sync]) => {
        if (!alive) return;
        const c = cur?.data?.data?.summary || {};
        const lyS = ly?.data?.data?.summary || {};
        const stock = cur?.data?.data?.stock_snapshot || {};
        const totals = inv?.data?.data?.totals || {};
        const dailyCur = cur?.data?.data?.daily || [];
        const dailyLy  = ly?.data?.data?.daily || [];
        const byChannel = cur?.data?.data?.by_channel || [];

        const netValue   = pickNet(c, valuation);
        const salesField = pickSalesField(valuation);
        const unitsSold  = Number(c.units_sold || 0);
        const returnRate = Number(c.return_rate_pct || 0);
        const invValue   = Number(stock.total_mrp_value || totals.total_stock_value || 0);
        const invUnits   = Number(stock.total_units || totals.total_stock || 0);
        // Sell-through: how much of (sold + on-hand) actually moved.  An
        // executive-friendly proxy that doesn't require an opening-inventory
        // baseline (which the API doesn't yet expose).
        const sellThrough = (unitsSold + invUnits) > 0
          ? (unitsSold / (unitsSold + invUnits)) * 100
          : 0;

        const lyNet     = pickNet(lyS, valuation);
        const lyUnits   = Number(lyS.units_sold || 0);
        const lyReturn  = Number(lyS.return_rate_pct || 0);
        // No prior-year inventory or sell-through — leave deltas null so the
        // pill renders "—" rather than a phony number.

        // Sparklines now read from the real daily series.  Inventory has no
        // time series in our schema yet, so its sparkline stays empty (the
        // KpiHeroCard handles that gracefully).
        const kpis = {
          netSales: {
            value: netValue,
            delta: pctDelta(netValue, lyNet),
            spark: realSparkline(dailyCur, salesField),
            footnote: c.units_sold > 0
              ? `avg ₹${Math.round(netValue / Math.max(1, c.units_sold)).toLocaleString('en-IN')} per unit`
              : null,
          },
          unitsSold: {
            value: unitsSold,
            delta: pctDelta(unitsSold, lyUnits),
            spark: realSparkline(dailyCur, 'sales_qty'),
            footnote: c.return_units > 0
              ? `${Number(c.return_units).toLocaleString('en-IN')} returned`
              : null,
          },
          inventoryValuation: {
            value: invValue,
            delta: null,
            spark: [],
            footnote: invUnits ? `${invUnits.toLocaleString('en-IN')} units · ${totals.active_locations || stock.locations || '—'} locations` : null,
          },
          sellThrough: {
            value: sellThrough,
            delta: null,
            spark: realSparkline(dailyCur, 'sales_qty'),
            footnote: `${unitsSold.toLocaleString('en-IN')} sold against on-hand`,
          },
          returnRate: {
            // Lower is better for return rate — caller uses inverseHealthFromDelta.
            value: returnRate,
            delta: pctDelta(returnRate, lyReturn),
            spark: returnRateSparkline(dailyCur),
            footnote: c.return_units > 0
              ? `${Number(c.return_units).toLocaleString('en-IN')} returns · ${formatINRCompact(c.return_value)}`
              : null,
          },
        };

        // Aging dataset removed — the Aging widget is paused and the only other
        // consumer (Needs Attention) is disabled, so getAgeing is no longer
        // fetched. AgingWaterfall renders its own "Available soon" placeholder.

        // Today vs LY: align by day index so one curve is "today's pace" and
        // the other is "same-day-LY pace".  Cumulative so the line is monotone.
        let cumCur = 0, cumLy = 0;
        const todayVsLy = dailyCur.map((d, i) => {
          cumCur += Number(d.sales_value || 0);
          cumLy  += Number(dailyLy[i]?.sales_value || 0);
          return {
            date: d.date,
            today: cumCur,
            ly:    dailyLy[i] ? cumLy : null,
          };
        });

        // Channel mix (no real "category" field in schema — channel is the
        // closest meaningful split for executive view).
        const channelMix = byChannel.map(r => ({
          name:    r.channel,
          value:   Number(r.sales_value || 0),
          units:   Number(r.units || 0),
          stores:  Number(r.stores || 0),
        })).filter(r => r.value > 0);

        // "Needs Attention" exception list removed (disabled per request). It
        // was the only consumer of getAlertsSummary + getAgeing, so both calls
        // are gone above. The shared /inventory/alerts endpoint (useAlerts) and
        // /inventory/ageing remain available to other pages — untouched here.

        const built = {
          asOf: new Date().toISOString(),
          kpis,
          todayVsLy,
          channelMix,
          stateHeatmap: heatmapData,
          syncStatus: sync?.data?.data || null,
          raw: { current: c, ly: lyS, stock, totals },
        };
        // Persist for instant paint on the next mount/reload. The heatmap may
        // still be arriving — its own handler patches setData + the cache entry
        // is refreshed on the next full fetch; caching it now (possibly null)
        // is fine because the cheap 3 ms heatmap call always re-runs on mount.
        setCached(cacheKey, built);
        setData(built);
        setLoading(false);
      })
      .catch(err => {
        if (!alive) return;
        // eslint-disable-next-line no-console
        console.warn('[useDashboardMetrics] fetch failed', err?.message);
        setError(err);
        setLoading(false);
      });

    return () => { alive = false; };
  }, [fromISO, toISO, mode, valuation, cacheKey]);

  return { data, loading, error };
}

function formatINRCompact(v) {
  const n = Number(v) || 0;
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
  if (n >= 1e3) return '₹' + (n / 1e3).toFixed(1) + 'K';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
