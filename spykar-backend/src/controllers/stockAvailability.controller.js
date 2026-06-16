// ─── Stock Availability controller ──────────────────────────────────────────
// Powers the 4th portal page: STOCK OVER TIME. Every figure is read-only
// (SELECT only) and sourced from inventory_daily_snapshot (the per-day stock
// table) + inventory_snapshot (current) + inventory_movements (sales for
// cover-days). Mirrors the conventions of analytics.controller.js:
//   • `query` from config/database, `getOrSet`/`TTL` from config/cache
//   • response shape { success: true, data }
//   • never hardcode dates — windows track the wall clock / existing snapshots
//
// Dimensions (region/zone deliberately EXCLUDED — locations.zone_id is NULL for
// every row; revisit once the sync populates it). Channel = locations.group_name
// ('EBO - SOR' vs 'Alternate - SOR'). Active = is_active=true AND shop_closed=false.
//
// NO ageing / dead-stock here by design (receipt/warehouse data is incomplete).

const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');

// Today as 'YYYY-MM-DD' (server local). Default upper bound — never hardcode.
const todayISO = () => new Date().toISOString().slice(0, 10);

// ─── Whitelisted group-by dimensions ────────────────────────────────────────
// `keyCol` identifies a member; `labelCol` is its display string. Strict
// whitelist → the value can never be attacker-controlled SQL.
const GROUP_DIMS = {
  state:    { keyCol: 'l.state',         labelCol: 'l.state',                          needsSku: false },
  city:     { keyCol: 'l.city',          labelCol: 'l.city',                           needsSku: false },
  channel:  { keyCol: 'l.group_name',    labelCol: 'l.group_name',                     needsSku: false },
  store:    { keyCol: 'l.id::text',      labelCol: "(l.code || ' · ' || l.name)",      needsSku: false },
  category: { keyCol: 's.category_norm', labelCol: 's.category_norm',                  needsSku: true  },
  colour:   { keyCol: 's.color_name',    labelCol: 's.color_name',                     needsSku: true  },
  size:     { keyCol: 's.size',          labelCol: 's.size',                           needsSku: true  },
};
// Accept the American spelling as an alias for the choropleth / pivots.
const normalizeGroupBy = (g) => (g === 'color' ? 'colour' : g);

// ─── Measure → SQL expression ───────────────────────────────────────────────
// gross = qty × MRP (MRP is the GST-inclusive consumer price, so "Gross"
// needs no extra GST math — matches the existing pages' qty*mrp valuation).
// cost  = qty × cost_price (nullable on some SKUs → COALESCE 0).
const MEASURE_EXPR = {
  units: 'd.qty_on_hand',
  gross: 'd.qty_on_hand * s.mrp',
  cost:  'd.qty_on_hand * COALESCE(s.cost_price, 0)',
};
const measureOrUnits = (m) => (MEASURE_EXPR[m] ? m : 'units');

// ─── Period → [from,to] (server-side, today-relative) ───────────────────────
// Used when the caller passes ?period= instead of explicit from/to. Mirrors the
// frontend presets so the page and API agree. Custom → use from/to verbatim.
function periodToRange(period, from, to) {
  if (from && to) return { from, to };
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (String(period || '').toLowerCase()) {
    case 'today': return { from: fmt(today), to: fmt(today) };
    case 'wtd': { // week-to-date (Mon start)
      const d = new Date(today); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow);
      return { from: fmt(d), to: fmt(today) };
    }
    case 'qtd': { const q = Math.floor(m / 3) * 3; return { from: fmt(new Date(y, q, 1)), to: fmt(today) }; }
    case 'ytd': return { from: fmt(new Date(y, 0, 1)), to: fmt(today) };
    case 'mtd':
    default:    return { from: fmt(new Date(y, m, 1)), to: fmt(today) };
  }
}

// ─── Scope builder ──────────────────────────────────────────────────────────
// Appends location/SKU filter predicates to `params` and returns the condition
// list. `joinSku` tells the caller whether a skus join is required.
function buildScope(q, params) {
  const conds = ['l.is_active = true'];
  let joinSku = false;

  const mode = String(q.status || q.mode || 'active').toLowerCase();
  if (mode === 'active')   conds.push('l.shop_closed = false');
  if (mode === 'inactive') conds.push('l.shop_closed = true');
  // 'all' → no shop_closed filter

  const addIlike = (col, val) => { params.push(val); conds.push(`${col} ILIKE $${params.length}`); };
  const addEq    = (col, val) => { params.push(val); conds.push(`${col} = $${params.length}`); };

  if (q.state)   addIlike('l.state', q.state);
  if (q.city)    addIlike('l.city', q.city);
  if (q.channel) addEq('l.group_name', q.channel);
  if (q.store)   addEq('l.code', q.store);

  if (q.category) { addIlike('s.category_norm', q.category); joinSku = true; }
  if (q.colour || q.color) { addIlike('s.color_name', q.colour || q.color); joinSku = true; }
  if (q.size)     { addEq('s.size', q.size); joinSku = true; }

  return { conds, joinSku, mode };
}

// Resolve a requested date to the newest snapshot that actually exists on or
// before it (snap to existing dates). Returns 'YYYY-MM-DD' or null if empty.
async function resolveAsOf(asOf) {
  const r = await query(
    `SELECT MAX(snapshot_date)::text AS d
       FROM inventory_daily_snapshot
      WHERE snapshot_date <= COALESCE($1::date, CURRENT_DATE)`,
    [asOf || null]
  );
  return r.rows[0]?.d || null;
}

// Classify the spacing of snapshot dates in a window so the UI can label the
// chart honestly (daily vs month-end-only vs mixed).
function classifyGranularity(dates) {
  if (!dates || dates.length <= 1) return 'daily';
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    const a = new Date(dates[i - 1]); const b = new Date(dates[i]);
    gaps.push(Math.round((b - a) / 86400000));
  }
  const allDaily   = gaps.every((g) => g <= 1);
  const allMonthly = gaps.every((g) => g >= 26);
  if (allDaily) return 'daily';
  if (allMonthly) return 'monthly';
  return 'mixed';
}

// ════════════════════════════════════════════════════════════════════════════
// A) GET /summary
// ════════════════════════════════════════════════════════════════════════════
async function getSummary(req, res, next) {
  try {
    const asOf = await resolveAsOf(req.query.as_of);
    if (!asOf) {
      return res.json({
        success: true,
        data: { as_of: null, stock_units: 0, value_gross: 0, value_cost: 0,
                store_count: 0, sku_count: 0, avg_per_store: 0, delta_units_vs_30d_pct: null },
      });
    }

    const params = [];
    const { conds, joinSku } = buildScope(req.query, params);
    const skuJoin = joinSku ? 'JOIN skus s ON s.id = d.sku_id' : 'LEFT JOIN skus s ON s.id = d.sku_id';
    const where = conds.join(' AND ');
    const asOfIdx = params.push(asOf); // current snapshot date param

    const cacheKey = `stockavail:summary:${asOf}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      // Current totals at as_of
      const cur = await query(
        `SELECT
            COALESCE(SUM(d.qty_on_hand), 0)::bigint                       AS stock_units,
            COALESCE(SUM(d.qty_on_hand * s.mrp), 0)::bigint               AS value_gross,
            COALESCE(SUM(d.qty_on_hand * COALESCE(s.cost_price,0)),0)::bigint AS value_cost,
            COUNT(DISTINCT d.location_id)::int                            AS store_count,
            COUNT(DISTINCT d.sku_id)::int                                 AS sku_count
           FROM inventory_daily_snapshot d
           JOIN locations l ON l.id = d.location_id
           ${skuJoin}
          WHERE d.snapshot_date = $${asOfIdx} AND ${where}`,
        params
      );
      const row = cur.rows[0];

      // Snap to the newest snapshot on/before (as_of - 30d) for the delta.
      const prior = await query(
        `SELECT MAX(snapshot_date)::text AS d
           FROM inventory_daily_snapshot
          WHERE snapshot_date <= ($1::date - INTERVAL '30 days')`,
        [asOf]
      );
      const priorDate = prior.rows[0]?.d || null;

      let deltaPct = null;
      if (priorDate) {
        const p2 = [];
        const sc2 = buildScope(req.query, p2);
        const skuJoin2 = sc2.joinSku ? 'JOIN skus s ON s.id = d.sku_id' : 'LEFT JOIN skus s ON s.id = d.sku_id';
        const pIdx = p2.push(priorDate);
        const then = await query(
          `SELECT COALESCE(SUM(d.qty_on_hand),0)::bigint AS u
             FROM inventory_daily_snapshot d
             JOIN locations l ON l.id = d.location_id
             ${skuJoin2}
            WHERE d.snapshot_date = $${pIdx} AND ${sc2.conds.join(' AND ')}`,
          p2
        );
        const thenU = Number(then.rows[0]?.u || 0);
        const nowU = Number(row.stock_units || 0);
        if (thenU > 0) deltaPct = Number((((nowU - thenU) / thenU) * 100).toFixed(1));
      }

      const storeCount = Number(row.store_count || 0);
      return {
        as_of: asOf,
        stock_units: Number(row.stock_units),
        value_gross: Number(row.value_gross),
        value_cost: Number(row.value_cost),
        store_count: storeCount,
        sku_count: Number(row.sku_count),
        avg_per_store: storeCount ? Math.round(Number(row.stock_units) / storeCount) : 0,
        delta_units_vs_30d_pct: deltaPct,
      };
    }, TTL.INVENTORY_SNAPSHOT);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// B) GET /trend — multi-line daily stock-on-hand per top-N dimension member
// ════════════════════════════════════════════════════════════════════════════
async function getTrend(req, res, next) {
  try {
    const groupBy = normalizeGroupBy(req.query.group_by || 'channel');
    const dim = GROUP_DIMS[groupBy];
    if (!dim) return res.status(400).json({ success: false, error: `invalid group_by: ${req.query.group_by}` });

    const measure = measureOrUnits(req.query.measure);
    const top = Math.min(Math.max(parseInt(req.query.top, 10) || 8, 1), 20);
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);

    const cacheKey = `stockavail:trend:${groupBy}:${measure}:${from}:${to}:${top}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      // Snap to the snapshot dates that actually exist in the window.
      const dRes = await query(
        `SELECT DISTINCT snapshot_date::text AS d
           FROM inventory_daily_snapshot
          WHERE snapshot_date BETWEEN $1::date AND $2::date
          ORDER BY 1`,
        [from, to]
      );
      const dates = dRes.rows.map((r) => r.d);
      if (dates.length === 0) {
        return { granularity: 'daily', from, to, group_by: groupBy, measure, dates: [], series: [] };
      }
      const granularity = classifyGranularity(dates);
      const latest = dates[dates.length - 1];

      // measure expr always needs skus for gross/cost; for units we can skip,
      // but keeping the join uniform keeps the SQL simple and still indexed.
      const params = [];
      const { conds } = buildScope(req.query, params);
      const where = conds.join(' AND ');
      const latestIdx = params.push(latest);

      // Top-N members ranked by the measure at the latest snapshot in window.
      const topRes = await query(
        `SELECT ${dim.keyCol} AS k, MAX(${dim.labelCol}) AS label,
                COALESCE(SUM(${MEASURE_EXPR[measure]}),0)::bigint AS v
           FROM inventory_daily_snapshot d
           JOIN locations l ON l.id = d.location_id
           JOIN skus s ON s.id = d.sku_id
          WHERE d.snapshot_date = $${latestIdx} AND ${where} AND ${dim.keyCol} IS NOT NULL
          GROUP BY ${dim.keyCol}
          ORDER BY v DESC
          LIMIT ${top}`,
        params
      );
      const members = topRes.rows;
      if (members.length === 0) {
        return { granularity, from, to, group_by: groupBy, measure, dates, series: [] };
      }

      // Daily series for just those members across the snapshot dates in window.
      const params2 = [];
      const sc2 = buildScope(req.query, params2);
      const where2 = sc2.conds.join(' AND ');
      const fromIdx = params2.push(from);
      const toIdx = params2.push(to);
      const keys = members.map((m) => m.k);
      const keysIdx = params2.push(keys);

      const seriesRes = await query(
        `SELECT d.snapshot_date::text AS date, ${dim.keyCol} AS k,
                COALESCE(SUM(${MEASURE_EXPR[measure]}),0)::bigint AS v
           FROM inventory_daily_snapshot d
           JOIN locations l ON l.id = d.location_id
           JOIN skus s ON s.id = d.sku_id
          WHERE d.snapshot_date BETWEEN $${fromIdx}::date AND $${toIdx}::date
            AND ${where2}
            AND ${dim.keyCol} = ANY($${keysIdx})
          GROUP BY d.snapshot_date, ${dim.keyCol}`,
        params2
      );

      // Pivot rows → one series per member, zero-filled across all window dates.
      const byKey = new Map();
      for (const m of members) byKey.set(m.k, { key: m.k, label: m.label, pts: new Map() });
      for (const r of seriesRes.rows) {
        const s = byKey.get(r.k);
        if (s) s.pts.set(r.date, Number(r.v));
      }
      const series = members.map((m) => {
        const s = byKey.get(m.k);
        return {
          key: m.k,
          label: m.label,
          points: dates.map((dt) => ({ date: dt, value: s.pts.get(dt) ?? 0 })),
        };
      });

      return { granularity, from, to, group_by: groupBy, measure, dates, series };
    }, TTL.INVENTORY_SNAPSHOT);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// C) GET /pivot — per-member stock now + 30d avg + delta + cover days
// ════════════════════════════════════════════════════════════════════════════
async function buildPivot(req) {
  const groupBy = normalizeGroupBy(req.query.group_by || 'state');
  const dim = GROUP_DIMS[groupBy];
  if (!dim) { const e = new Error(`invalid group_by: ${req.query.group_by}`); e.status = 400; throw e; }
  const measure = measureOrUnits(req.query.measure);

  const asOf = await resolveAsOf(req.query.as_of);
  if (!asOf) return { group_by: groupBy, measure, as_of: null, rows: [], totals: null };

  // ── Current snapshot per member ─────────────────────────────────────────
  const p = [];
  const { conds } = buildScope(req.query, p);
  const where = conds.join(' AND ');
  const asOfIdx = p.push(asOf);

  // ── 30d-ago snapshot date (for delta) + trailing window start (for avg) ──
  const priorRes = await query(
    `SELECT MAX(snapshot_date)::text AS d
       FROM inventory_daily_snapshot
      WHERE snapshot_date <= ($1::date - INTERVAL '30 days')`,
    [asOf]
  );
  const priorDate = priorRes.rows[0]?.d || null;

  const sortExpr = { units: 'stock_units', gross: 'value_gross', cost: 'value_cost' }[measure];

  // One round-trip: current + trailing-30d avg + 30d-ago + sales-30d, joined on
  // the member key. CTEs pre-aggregate so each scan is bounded.
  const params = [...p];                       // $1..$asOfIdx already include asOf + filters
  const winStartIdx = params.push(`${asOf}`);  // window end = as_of
  const priorIdx = params.push(priorDate);     // may be null
  // 30d sales window uses moved_at >= as_of - 30d
  const rows = await query(
    `WITH cur AS (
        SELECT ${dim.keyCol} AS k, MAX(${dim.labelCol}) AS label,
               COUNT(DISTINCT l.id)::int                                   AS store_count,
               COALESCE(SUM(d.qty_on_hand),0)::bigint                      AS stock_units,
               COALESCE(SUM(d.qty_on_hand * s.mrp),0)::bigint              AS value_gross,
               COALESCE(SUM(d.qty_on_hand * COALESCE(s.cost_price,0)),0)::bigint AS value_cost
          FROM inventory_daily_snapshot d
          JOIN locations l ON l.id = d.location_id
          JOIN skus s ON s.id = d.sku_id
         WHERE d.snapshot_date = $${asOfIdx} AND ${where} AND ${dim.keyCol} IS NOT NULL
         GROUP BY ${dim.keyCol}
     ),
     avg30 AS (
        SELECT k, AVG(daily_units)::bigint AS avg_30d FROM (
          SELECT ${dim.keyCol} AS k, d.snapshot_date, SUM(d.qty_on_hand) AS daily_units
            FROM inventory_daily_snapshot d
            JOIN locations l ON l.id = d.location_id
            JOIN skus s ON s.id = d.sku_id
           WHERE d.snapshot_date > ($${winStartIdx}::date - INTERVAL '30 days')
             AND d.snapshot_date <= $${winStartIdx}::date
             AND ${where} AND ${dim.keyCol} IS NOT NULL
           GROUP BY ${dim.keyCol}, d.snapshot_date
        ) q GROUP BY k
     ),
     prior AS (
        SELECT ${dim.keyCol} AS k, COALESCE(SUM(d.qty_on_hand),0)::bigint AS units_then
          FROM inventory_daily_snapshot d
          JOIN locations l ON l.id = d.location_id
          JOIN skus s ON s.id = d.sku_id
         WHERE $${priorIdx}::date IS NOT NULL AND d.snapshot_date = $${priorIdx}::date
           AND ${where} AND ${dim.keyCol} IS NOT NULL
         GROUP BY ${dim.keyCol}
     ),
     sales30 AS (
        SELECT ${dim.keyCol} AS k,
               SUM(-m.qty_change)::bigint AS units_sold_30d
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s ON s.id = m.sku_id
         WHERE m.movement_type = 'SALE'
           AND m.moved_at >= ($${asOfIdx}::date - INTERVAL '30 days')
           AND m.moved_at <  ($${asOfIdx}::date + INTERVAL '1 day')
           AND ${where} AND ${dim.keyCol} IS NOT NULL
         GROUP BY ${dim.keyCol}
     )
     SELECT cur.k AS key, cur.label, cur.store_count, cur.stock_units,
            cur.value_gross, cur.value_cost,
            COALESCE(avg30.avg_30d,0)::bigint AS avg_30d,
            CASE WHEN prior.units_then > 0
                 THEN ROUND(((cur.stock_units - prior.units_then)::numeric / prior.units_then) * 100, 1)
                 ELSE NULL END AS delta_vs_30d_pct,
            CASE WHEN COALESCE(sales30.units_sold_30d,0) > 0
                 THEN ROUND(cur.stock_units::numeric / (sales30.units_sold_30d::numeric / 30.0), 1)
                 ELSE NULL END AS cover_days
       FROM cur
       LEFT JOIN avg30   ON avg30.k = cur.k
       LEFT JOIN prior   ON prior.k = cur.k
       LEFT JOIN sales30 ON sales30.k = cur.k
      ORDER BY ${sortExpr} DESC NULLS LAST`,
    params
  );

  // Totals row (filters applied, ungrouped) at as_of.
  const tParams = [];
  const tsc = buildScope(req.query, tParams);
  const tIdx = tParams.push(asOf);
  const totRes = await query(
    `SELECT COUNT(DISTINCT l.id)::int AS store_count,
            COALESCE(SUM(d.qty_on_hand),0)::bigint AS stock_units,
            COALESCE(SUM(d.qty_on_hand * s.mrp),0)::bigint AS value_gross,
            COALESCE(SUM(d.qty_on_hand * COALESCE(s.cost_price,0)),0)::bigint AS value_cost
       FROM inventory_daily_snapshot d
       JOIN locations l ON l.id = d.location_id
       JOIN skus s ON s.id = d.sku_id
      WHERE d.snapshot_date = $${tIdx} AND ${tsc.conds.join(' AND ')}`,
    tParams
  );
  const t = totRes.rows[0];

  return {
    group_by: groupBy,
    measure,
    as_of: asOf,
    rows: rows.rows.map((r) => ({
      key: r.key,
      label: r.label,
      store_count: Number(r.store_count),
      stock_units: Number(r.stock_units),
      value_gross: Number(r.value_gross),
      value_cost: Number(r.value_cost),
      avg_30d: Number(r.avg_30d),
      delta_vs_30d_pct: r.delta_vs_30d_pct === null ? null : Number(r.delta_vs_30d_pct),
      cover_days: r.cover_days === null ? null : Number(r.cover_days),
    })),
    totals: t ? {
      store_count: Number(t.store_count),
      stock_units: Number(t.stock_units),
      value_gross: Number(t.value_gross),
      value_cost: Number(t.value_cost),
    } : null,
  };
}

async function getPivot(req, res, next) {
  try {
    const cacheKey = `stockavail:pivot:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, () => buildPivot(req), TTL.INVENTORY_SNAPSHOT);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D) GET /store/:locationId/trend — per-store stock line vs daily sales bars
// ════════════════════════════════════════════════════════════════════════════
async function getStoreTrend(req, res, next) {
  try {
    const { locationId } = req.params;
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);

    const cacheKey = `stockavail:store:${locationId}:${from}:${to}`;
    const data = await getOrSet(cacheKey, async () => {
      const locRes = await query(
        `SELECT id, code, name, city, state, type, group_name AS channel
           FROM locations WHERE id = $1::uuid`,
        [locationId]
      );
      if (locRes.rows.length === 0) { const e = new Error('store not found'); e.status = 404; throw e; }
      const store = locRes.rows[0];

      // Snapshot dates in window for this store.
      const dRes = await query(
        `SELECT DISTINCT snapshot_date::text AS d
           FROM inventory_daily_snapshot
          WHERE location_id = $1::uuid AND snapshot_date BETWEEN $2::date AND $3::date
          ORDER BY 1`,
        [locationId, from, to]
      );
      const dates = dRes.rows.map((r) => r.d);
      const granularity = classifyGranularity(dates);

      // Daily stock-on-hand for the store.
      const stockRes = await query(
        `SELECT snapshot_date::text AS date, SUM(qty_on_hand)::bigint AS stock_on_hand
           FROM inventory_daily_snapshot
          WHERE location_id = $1::uuid AND snapshot_date BETWEEN $2::date AND $3::date
          GROUP BY snapshot_date`,
        [locationId, from, to]
      );
      const stockByDate = new Map(stockRes.rows.map((r) => [r.date, Number(r.stock_on_hand)]));

      // Daily units sold for the store (SALE movements).
      const salesRes = await query(
        `SELECT (moved_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date,
                SUM(-qty_change)::bigint AS units_sold
           FROM inventory_movements
          WHERE location_id = $1::uuid AND movement_type = 'SALE'
            AND moved_at >= $2::date AND moved_at < ($3::date + INTERVAL '1 day')
          GROUP BY 1`,
        [locationId, from, to]
      );
      const soldByDate = new Map(salesRes.rows.map((r) => [r.date, Number(r.units_sold)]));

      // Union of dates from both stock + sales so sales-only days still show.
      const allDates = Array.from(new Set([...dates, ...soldByDate.keys()])).sort();
      const series = allDates.map((dt) => ({
        date: dt,
        stock_on_hand: stockByDate.get(dt) ?? null,
        units_sold: soldByDate.get(dt) ?? 0,
      }));

      const stockVals = series.map((s) => s.stock_on_hand).filter((v) => v != null);
      const stockNow = stockVals.length ? stockVals[stockVals.length - 1] : 0;
      const avgStock = stockVals.length ? Math.round(stockVals.reduce((a, b) => a + b, 0) / stockVals.length) : 0;
      const totalSold = series.reduce((a, s) => a + s.units_sold, 0);
      const spanDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
      const avgSalePerDay = Number((totalSold / spanDays).toFixed(2));
      const coverDays = avgSalePerDay > 0 ? Number((stockNow / avgSalePerDay).toFixed(1)) : null;

      // Plain-language recommendation (no ageing logic — pure cover-days rule).
      let recommendation;
      if (avgSalePerDay <= 0) {
        recommendation = 'No sales recorded in this window — review assortment fit or store activity before replenishing.';
      } else if (coverDays != null && coverDays < 14) {
        recommendation = `Only ~${coverDays} days of cover at the current sell rate — prioritise replenishment.`;
      } else if (coverDays != null && coverDays > 120) {
        recommendation = `~${coverDays} days of cover — overstocked vs sell-through; consider holding/transferring stock.`;
      } else {
        recommendation = `~${coverDays} days of cover — stock and sell-through are broadly balanced.`;
      }

      return {
        store,
        summary: { stock_now: stockNow, avg_stock: avgStock, avg_sale_per_day: avgSalePerDay, cover_days: coverDays },
        granularity,
        from, to,
        series,
        recommendation,
      };
    }, TTL.INVENTORY_SNAPSHOT);

    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: err.message });
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// E) GET /export.csv — same filters as /pivot, streamed
// ════════════════════════════════════════════════════════════════════════════
async function exportCsv(req, res, next) {
  try {
    const pivot = await buildPivot(req);
    const cols = ['member', 'stores', 'stock_units', 'value_gross', 'value_cost', 'avg_30d', 'delta_vs_30d_pct', 'cover_days'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stock-availability-${pivot.group_by}-${pivot.as_of || 'na'}.csv"`);
    res.write(cols.join(',') + '\n');
    for (const r of pivot.rows) {
      res.write([
        esc(r.label), r.store_count, r.stock_units, r.value_gross, r.value_cost,
        r.avg_30d, r.delta_vs_30d_pct, r.cover_days,
      ].map(esc).join(',') + '\n');
    }
    res.end();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

module.exports = { getSummary, getTrend, getPivot, getStoreTrend, exportCsv };
