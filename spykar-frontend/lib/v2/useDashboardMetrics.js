// ─── useDashboardMetrics — single round-trip data hook for v2 dashboard ──────
// Returns the shape every KPI card + the narrative banner needs:
//   { loading, error, asOf, kpis: {netSales, unitsSold, inventoryValuation,
//     sellThrough, returnRate}, syncStatus }
//
// Fetch strategy: ONE request — GET /analytics/overview (sales now + last year
// clipped like-for-like, stock totals, India map, sync status). The valuation
// lens is applied locally, so switching it costs no network.
//
// Sparklines: backend doesn't yet return per-day series for hero metrics, so
// we synthesise a 30-point random-walk anchored on the current value.  Not
// shown to users as accurate history — purely a visual "is it trending"
// pulse until the backend adds /analytics/sales/daily-series in Phase 4.

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { analyticsService } from '../services';
import { getCached, setCached, isFresh } from '../dashboardCache';
import { pctDelta, formatFull } from './format';

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
  // The slim summary's daily rows carry only the gross family (sales_value,
  // sales_qty, return_*). For the Ex-GST / GST / MRP / Discount lenses the
  // field is absent and the sparkline was flat zeros — show the gross trend.
  if (!(field in daily[0])) field = 'sales_value';
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

// Pure derivation: one /analytics/overview bundle + the valuation lens → the
// shape every KPI card, the banner, the LY chart, the map and channel mix read.
// The bundle carries every lens (gross / ex-GST / GST / MRP / discount), so a
// lens switch is a re-derivation, not a network round-trip.
function buildMetrics(b, valuation) {
  const cur = b.current || {};
  const c = cur.summary || {};
  const dailyCur = cur.daily || [];
  const comparable = !!b.comparable;
  const ly = comparable ? b.ly : null;
  const lyS = ly?.summary || {};
  const dLy = (a, x) => (comparable && ly ? pctDelta(a, x) : null);
  const stock = cur.stock_snapshot || {};
  const totals = b.stock || {};
  const dailyLy = ly?.daily || [];
  const byChannel = cur.by_channel || [];

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
      delta: dLy(netValue, lyNet),
      spark: realSparkline(dailyCur, salesField),
      footnote: c.units_sold > 0
        ? `avg ₹${Math.round(netValue / Math.max(1, c.units_sold)).toLocaleString('en-IN')} per unit`
        : null,
    },
    unitsSold: {
      value: unitsSold,
      delta: dLy(unitsSold, lyUnits),
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
      // The card shows this delta in percentage POINTS ("pp"), so it is
      // the difference of the two rates — pctDelta gave a relative change
      // (5% vs 4% showed "▲ 25.0pp" instead of 1.0pp).
      value: returnRate,
      delta: comparable && ly && lyS.units_sold > 0 ? returnRate - lyReturn : null,
      spark: returnRateSparkline(dailyCur),
      footnote: c.return_units > 0
        ? `${Number(c.return_units).toLocaleString('en-IN')} returns · ${formatFull(c.return_value, { rupee: true })}`
        : null,
    },
  };

  // Aging dataset removed — the Aging widget is paused and the only other
  // consumer (Needs Attention) is disabled, so getAgeing is no longer
  // fetched. AgingWaterfall renders its own "Available soon" placeholder.

  // Today vs LY, cumulative. Aligned by CALENDAR date (d → same day last
  // year), not by array index: either window can skip a day with no
  // movements, which shifted the whole LY curve.
  const lySorted = [...dailyLy].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let cumCur = 0, cumLy = 0, j = 0;
  const todayVsLy = dailyCur.map((d) => {
    cumCur += Number(d.sales_value || 0);
    const lyDay = shiftYear(String(d.date).slice(0, 10), 1);
    while (j < lySorted.length && String(lySorted[j].date).slice(0, 10) <= lyDay) {
      cumLy += Number(lySorted[j].sales_value || 0); j++;
    }
    return { date: d.date, today: cumCur, ly: lySorted.length ? cumLy : null };
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

  return {
    asOf: b.fetchedAt || new Date().toISOString(),
    kpis,
    todayVsLy,
    channelMix,
    stateHeatmap: b.state_heatmap || null,
    syncStatus: b.sync || null,
    raw: { current: c, ly: lyS, stock, totals },
  };
}

export function useDashboardMetrics({ fromISO, toISO, mode = 'active', valuation = 'gross' } = {}) {
  // ONE request per (window, mode): GET /analytics/overview returns sales now,
  // last year (clipped server-side to the last day with data — like-for-like),
  // stock totals, the India map and sync status. It replaced 5 requests plus a
  // sequential 6th (the LY re-fetch when data lagged the window), and its
  // server blocks are rollup-backed. The raw bundle is cached per window+mode
  // (localStorage via the 'ov:metrics:' persist tier → instant paint on revisit);
  // the valuation lens is applied locally in buildMetrics.
  const cacheKey = `ov:metrics:v2:${fromISO || ''}:${toISO || ''}:${mode}`;

  const [bundle, setBundle]   = useState(() => getCached(cacheKey) ?? null);
  const [loading, setLoading] = useState(() => !getCached(cacheKey));
  const [error, setError]     = useState(null);
  const [nonce, setNonce]     = useState(0);        // bumped by reload() (the Retry button)
  const forceRef = useRef(false);                    // one-shot: skip the fresh-cache shortcut once
  const reload = useCallback(() => { forceRef.current = true; setNonce((n) => n + 1); }, []);

  useEffect(() => {
    if (!fromISO || !toISO) return;
    let alive = true;
    setError(null);

    // Paint cached data immediately; with nothing cached for THIS key, drop the
    // previous key's payload (never show MTD numbers under a YTD label).
    const cached = getCached(cacheKey);
    if (cached) { setBundle(cached); setLoading(false); }
    else        { setBundle(null); setLoading(true); }

    // Fresh cache (within TTL and newer than the last sync) → zero network.
    const forced = forceRef.current; forceRef.current = false;
    if (cached && isFresh(cacheKey) && !forced) return () => { alive = false; };

    analyticsService.getOverview({ date_from: fromISO, date_to: toISO, mode })
      .then((res) => {
        if (!alive) return;
        const b = { ...(res?.data?.data || {}), fetchedAt: new Date().toISOString() };
        setCached(cacheKey, b);
        setBundle(b);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        // eslint-disable-next-line no-console
        console.warn('[useDashboardMetrics] fetch failed', err?.message);
        setError(err);
        setLoading(false);
      });

    return () => { alive = false; };
  }, [fromISO, toISO, mode, cacheKey, nonce]);

  const data = useMemo(() => (bundle ? buildMetrics(bundle, valuation) : null), [bundle, valuation]);
  return { data, loading, error, reload };
}

