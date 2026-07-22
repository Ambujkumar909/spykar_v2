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

const { query, pool } = require('../config/database');
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

  // Every dimension is MULTI-select — the sidebar Lens sends comma-joined lists
  // (e.g. category=Denim,Shirts). Split → match with `= ANY(array)`. Text dims
  // are matched case-insensitively (lower(col) = ANY(lowered array)); exact dims
  // (channel/store code/size) match verbatim. A single value is just a 1-elem array.
  const split = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const addCI = (col, val) => {           // case-insensitive multi-match
    const arr = split(val).map((s) => s.toLowerCase());
    if (!arr.length) return;
    params.push(arr); conds.push(`lower(${col}) = ANY($${params.length})`);
  };
  const addEq = (col, val) => {           // exact multi-match
    const arr = split(val);
    if (!arr.length) return;
    params.push(arr); conds.push(`${col} = ANY($${params.length})`);
  };

  if (q.state)    addCI('l.state', q.state);
  if (q.city)     addCI('l.city', q.city);
  if (q.channel || q.group_name) addEq('l.group_name', q.channel || q.group_name);
  if (q.store || q.store_code)   addEq('l.code', q.store || q.store_code);
  if (q.location_id) { params.push(q.location_id); conds.push(`l.id = $${params.length}::uuid`); } // drill by store UUID

  if (q.category)    { addCI('s.category_norm', q.category); joinSku = true; }
  if (q.colour || q.color) { addCI('s.color_name', q.colour || q.color); joinSku = true; }
  if (q.size)        { addEq('s.size', q.size); joinSku = true; }
  if (q.product)     { addCI('s.product', q.product); joinSku = true; }
  if (q.gender)      { addCI('s.gender_name', q.gender); joinSku = true; }
  if (q.sub_product) { addCI('s.sub_product', q.sub_product); joinSku = true; }
  if (q.season)      { addCI('s.season', q.season); joinSku = true; }
  if (q.sku_id)      { params.push(q.sku_id); conds.push(`s.id = $${params.length}::uuid`); joinSku = true; } // drill by SKU

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
// 0) GET /range — calendar bounds ONLY (instant). The recent-history sparkline
//    is a SEPARATE, lazy call (/history) so nothing on the critical path (the
//    calendar + default date, which gate summary/pivot) waits on an aggregate.
// ════════════════════════════════════════════════════════════════════════════
async function getRange(req, res, next) {
  try {
    const data = await getOrSet('stockavail:range', async () => {
      // MIN/MAX(snapshot_date) are per-partition index lookups — instant at any
      // history size. No summing, no scan.
      const b = await query(
        `SELECT MIN(snapshot_date)::text AS from, MAX(snapshot_date)::text AS to
           FROM inventory_daily_snapshot`);
      return { from: b.rows[0]?.from || null, to: b.rows[0]?.to || null };
    }, TTL.INVENTORY_SNAPSHOT);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// 0b) GET /history — recent-history sparkline (per-date total on-hand). Bounded
//    to the last ~35 days so it prunes to the newest partition(s) — never a scan
//    over full history — cached, and loaded LAZILY by the UI (after first paint),
//    so it never blocks the page. No precomputed rollup to seed or maintain.
// ════════════════════════════════════════════════════════════════════════════
async function getHistory(req, res, next) {
  try {
    const data = await getOrSet('stockavail:history', async () => {
      const mx = await query('SELECT MAX(snapshot_date)::text AS to FROM inventory_daily_snapshot');
      const to = mx.rows[0]?.to || null;
      if (!to) return { dates: [] };
      const dts = await query(
        `SELECT snapshot_date::text AS d, SUM(qty_on_hand)::bigint AS u
           FROM inventory_daily_snapshot
          WHERE snapshot_date > ($1::date - INTERVAL '35 days')
          GROUP BY snapshot_date ORDER BY 1`, [to]);
      return { dates: dts.rows.map((x) => ({ d: x.d, u: Number(x.u) })) };
    }, TTL.INVENTORY_SNAPSHOT);
    res.json({ success: true, data });
  } catch (err) { next(err); }
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

  // cur (today's snapshot) + prior (30d-ago snapshot, for Δ) + sales30 (cover
  // days). The old avg30 CTE re-scanned the whole 30-day snapshot window on
  // EVERY pivot — the dominant cost — for a secondary "30d avg" column; dropped.
  // Runs on a dedicated client with raised work_mem + parallel workers.
  const params = [...p];                       // $1..$asOfIdx already include asOf + filters
  const priorIdx = params.push(priorDate);     // may be null
  const client = await pool.connect();
  let rows, totRes;
  try {
    await client.query(`SET work_mem = '512MB'`);
    await client.query(`SET max_parallel_workers_per_gather = 4`);
  // `base` collapses to one row per (member, store) so `cur` can COUNT(*) for
  // store_count — a two-level GROUP BY that is far cheaper than COUNT(DISTINCT)
  // over the raw rows (which was the pivot's dominant cost for wide dims like
  // category/colour). label is functionally determined by the key, so the extra
  // GROUP BY column doesn't change cardinality.
  rows = await client.query(
    `WITH base AS (
        SELECT ${dim.keyCol} AS k, ${dim.labelCol} AS label, d.location_id AS lid,
               SUM(d.qty_on_hand)                          AS u,
               SUM(d.qty_on_hand * s.mrp)                  AS vg,
               SUM(d.qty_on_hand * COALESCE(s.cost_price,0)) AS vc
          FROM inventory_daily_snapshot d
          JOIN locations l ON l.id = d.location_id
          JOIN skus s ON s.id = d.sku_id
         WHERE d.snapshot_date = $${asOfIdx} AND ${where} AND ${dim.keyCol} IS NOT NULL
         GROUP BY ${dim.keyCol}, ${dim.labelCol}, d.location_id
     ),
     cur AS (
        SELECT k, MAX(label) AS label,
               COUNT(*)::int                       AS store_count,
               COALESCE(SUM(u),0)::bigint          AS stock_units,
               COALESCE(SUM(vg),0)::bigint         AS value_gross,
               COALESCE(SUM(vc),0)::bigint         AS value_cost
          FROM base GROUP BY k
     ),
     prior AS (
        SELECT ${dim.keyCol} AS k, COALESCE(SUM(d.qty_on_hand),0)::bigint AS units_then
          FROM inventory_daily_snapshot d
          JOIN locations l ON l.id = d.location_id
          JOIN skus s ON s.id = d.sku_id
         WHERE $${priorIdx}::date IS NOT NULL AND d.snapshot_date = $${priorIdx}::date
           AND ${where} AND ${dim.keyCol} IS NOT NULL
         GROUP BY ${dim.keyCol}
     )
     SELECT cur.k AS key, cur.label, cur.store_count, cur.stock_units,
            cur.value_gross, cur.value_cost,
            CASE WHEN prior.units_then > 0
                 THEN ROUND(((cur.stock_units - prior.units_then)::numeric / prior.units_then) * 100, 1)
                 ELSE NULL END AS delta_vs_30d_pct
       FROM cur
       LEFT JOIN prior ON prior.k = cur.k
      ORDER BY ${sortExpr} DESC NULLS LAST`,
    params
  );

  } finally {
    try { await client.query('RESET work_mem'); } catch (_) {}
    try { await client.query('RESET max_parallel_workers_per_gather'); } catch (_) {}
    client.release();
  }

  const outRows = rows.rows.map((r) => ({
    key: r.key,
    label: r.label,
    store_count: Number(r.store_count),
    stock_units: Number(r.stock_units),
    value_gross: Number(r.value_gross),
    value_cost: Number(r.value_cost),
    delta_vs_30d_pct: r.delta_vs_30d_pct === null ? null : Number(r.delta_vs_30d_pct),
  }));

  // Totals summed in JS from the rows — no extra full-day scan.
  const totals = outRows.length ? {
    stock_units: outRows.reduce((a, x) => a + x.stock_units, 0),
    value_gross: outRows.reduce((a, x) => a + x.value_gross, 0),
    value_cost: outRows.reduce((a, x) => a + x.value_cost, 0),
  } : null;

  return { group_by: groupBy, measure, as_of: asOf, rows: outRows, totals };
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
    const cols = ['member', 'stores', 'stock_units', 'value_gross', 'value_cost', 'delta_vs_30d_pct'];
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
        r.delta_vs_30d_pct,
      ].map(esc).join(',') + '\n');
    }
    res.end();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// G) GET /sales-vs-stock — daily stock-on-hand (line) vs units sold (bars),
//    scoped by store / colour / size / category / SKU (both sides filtered).
//    Store optional → network-wide when omitted. Powers the "Sales vs Stock"
//    feature: e.g. "store X, colour Red — daily sell-through vs cover".
// ════════════════════════════════════════════════════════════════════════════
async function getSalesVsStock(req, res, next) {
  try {
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);
    const cacheKey = `stockavail:svs:${from}:${to}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      // Stock side — daily on-hand from the snapshot table, scoped. Only join
      // skus when the scope actually needs a SKU attribute (category/colour/…);
      // otherwise summing qty over a 90–180-day window × skus is a needless join
      // that dominates on full history. stock_value (unused by the UI) is skipped
      // entirely when unscoped so the network-wide default is a pure SUM.
      const p1 = [];
      const sc1 = buildScope(req.query, p1);
      const j1 = sc1.joinSku ? 'JOIN skus s ON s.id = d.sku_id' : '';
      const val1 = sc1.joinSku ? 'SUM(d.qty_on_hand * s.mrp)::bigint' : '0::bigint';
      const f1 = p1.push(from); const t1 = p1.push(to);
      const stock = await query(
        `SELECT d.snapshot_date::text AS date, SUM(d.qty_on_hand)::bigint AS stock_on_hand,
                ${val1} AS stock_value
           FROM inventory_daily_snapshot d
           JOIN locations l ON l.id = d.location_id
           ${j1}
          WHERE d.snapshot_date BETWEEN $${f1}::date AND $${t1}::date AND ${sc1.conds.join(' AND ')}
          GROUP BY d.snapshot_date`, p1);

      // Sales side — daily SALE movements, same scope. Same conditional join.
      const p2 = [];
      const sc2 = buildScope(req.query, p2);
      const j2 = sc2.joinSku ? 'JOIN skus s ON s.id = m.sku_id' : '';
      const f2 = p2.push(from); const t2 = p2.push(to);
      const sales = await query(
        `SELECT (m.moved_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date,
                SUM(-m.qty_change)::bigint AS units_sold,
                SUM(COALESCE(m.sale_value,0))::bigint AS sale_value
           FROM inventory_movements m
           JOIN locations l ON l.id = m.location_id
           ${j2}
          WHERE m.movement_type = 'SALE'
            AND m.moved_at >= $${f2}::date AND m.moved_at < ($${t2}::date + INTERVAL '1 day')
            AND ${sc2.conds.join(' AND ')}
          GROUP BY 1`, p2);

      const stockBy = new Map(stock.rows.map((r) => [r.date, Number(r.stock_on_hand)]));
      const svalBy  = new Map(stock.rows.map((r) => [r.date, Number(r.stock_value)]));
      const soldBy  = new Map(sales.rows.map((r) => [r.date, Number(r.units_sold)]));
      const salvBy  = new Map(sales.rows.map((r) => [r.date, Number(r.sale_value)]));
      const dates = Array.from(new Set([...stockBy.keys(), ...soldBy.keys()])).sort();
      const series = dates.map((dt) => ({
        date: dt,
        stock_on_hand: stockBy.get(dt) ?? null,
        stock_value: svalBy.get(dt) ?? null,
        units_sold: soldBy.get(dt) ?? 0,
        sale_value: salvBy.get(dt) ?? 0,
      }));

      const stockVals = series.map((s) => s.stock_on_hand).filter((v) => v != null);
      const stockNow = stockVals.length ? stockVals[stockVals.length - 1] : 0;
      const avgStock = stockVals.length ? Math.round(stockVals.reduce((a, b) => a + b, 0) / stockVals.length) : 0;
      const totalSold = series.reduce((a, s) => a + s.units_sold, 0);
      const totalSaleValue = series.reduce((a, s) => a + s.sale_value, 0);
      const spanDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
      const avgSalePerDay = Number((totalSold / spanDays).toFixed(2));
      const coverDays = avgSalePerDay > 0 ? Number((stockNow / avgSalePerDay).toFixed(1)) : null;
      const sellThroughPct = (stockNow + totalSold) > 0 ? Number((totalSold / (stockNow + totalSold) * 100).toFixed(1)) : null;

      return { from, to, series,
        summary: { stock_now: stockNow, avg_stock: avgStock, total_sold: totalSold, total_sale_value: totalSaleValue,
                   avg_sale_per_day: avgSalePerDay, cover_days: coverDays, sell_through_pct: sellThroughPct } };
    }, TTL.INVENTORY_SNAPSHOT);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

module.exports = { getRange, getHistory, getSummary, getTrend, getPivot, getStoreTrend, getSalesVsStock, exportCsv };
