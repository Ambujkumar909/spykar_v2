// ─── salesRollupRead.js — Phase 1 fast-path reader ────────────────────────────
//
// When a /analytics/sales request has ONLY a date range + mode (no color/size/
// location/state/sku filters), we serve it from the daily rollups (srd_store,
// srd_sku) instead of the live mega-CTE. aggregateFromRollup() returns an object
// shaped EXACTLY like the live megaRes.rows[0], so every downstream line in
// getSalesAnalytics (summary derivation, silent-store merge, return shape) is
// reused unchanged.
//
// Eligibility is intentionally strict: any deep filter falls back to the live
// path (which still works + is cached). This covers the default page load, any
// custom date range, and the full "all data" view — the cases the user wants
// instant — at 100% correctness.

const { query } = require('../config/database');
const { getOrSet } = require('../config/cache');

// Cold-start / safety guard: only use the rollups once they're actually
// populated. On a fresh deploy the tables exist (migration) but are EMPTY until
// the first sync's STAGE 3.5 backfills them — serving from empty rollups would
// show zero data. Cached 5 min (and busted by the sync's analytics:* invalidate),
// so it's ~free per request. Any error (e.g. table missing) → false → live path.
async function rollupsReady() {
  try {
    return await getOrSet('analytics:sales:rollups-ready:v1', async () => {
      const r = await query('SELECT EXISTS(SELECT 1 FROM srd_store LIMIT 1) AS ok');
      return r.rows[0].ok === true;
    }, 300);
  } catch { return false; }
}

// Strict gate: rollup-eligible ⇔ no filter beyond date range + mode.
function isRollupEligible(f) {
  if (f.color_name || f.size || f.location_id || f.category) return false;
  const arrs = [f.states, f.cities, f.groups, f.storeCodes, f.skuGenders,
    f.skuSubProds, f.skuProducts, f.skuStyles, f.skuShades, f.skuColors,
    f.skuSizes, f.skuSeasons];
  return arrs.every(a => !a || a.length === 0);
}

// mode → shop_closed predicate fragment (mode is already allow-listed upstream).
function modeClause(mode) {
  const m = String(mode || 'active').toLowerCase();
  if (m === 'active')   return ' AND shop_closed = false';
  if (m === 'inactive') return ' AND shop_closed = true';
  return ''; // 'all'
}
// Same for the raw inventory_movements seek (stores_count enrichment), on l.
function modeClauseRaw(mode) {
  const m = String(mode || 'active').toLowerCase();
  if (m === 'active')   return ' AND l.shop_closed = false';
  if (m === 'inactive') return ' AND l.shop_closed = true';
  return '';
}

async function aggregateFromRollup({ from, to, mode }) {
  const mc = modeClause(mode);
  // Upper bound is INCLUSIVE of `to` — must match the live mega-CTE in
  // getSalesAnalytics (`m.moved_at < to::date + interval '1 day'`). Using
  // `sale_date < to` here dropped the final day of every window: for the
  // "Today" preset (from == to) the range collapsed to empty → the /sales
  // page showed zero while the dashboard (live path) showed the real number.
  const where = `sale_date >= $1::date AND sale_date <= $2::date${mc}`;
  const p = [from, to];

  // TWO single-pass queries instead of 12 concurrent scans. Running 12 GROUP-BY
  // queries via Promise.all thrashed the 8 parallel workers + work_mem (measured
  // 11–16 s for the full range despite each query being <0.5 s alone). Each
  // query below materialises its rollup CTE ONCE and derives every widget from
  // it — mirroring the proven live mega-CTE shape, but over the tiny rollups.

  // ── Query A: everything sourced from srd_store (236K rows) ─────────────────
  const storeQ = query(`
    WITH r AS (SELECT * FROM srd_store WHERE ${where})
    SELECT
      (SELECT row_to_json(t) FROM (SELECT
        COALESCE(SUM(s_qty),0)::int units_sold, COALESCE(SUM(s_val),0)::bigint sales_value,
        COALESCE(SUM(s_txn),0)::int sales_txns, COALESCE(SUM(r_qty),0)::int return_units,
        COALESCE(SUM(r_val),0)::bigint return_value, COALESCE(SUM(r_txn),0)::int return_txns,
        COUNT(DISTINCT location_id) FILTER (WHERE s_qty>0)::int stores_with_sales,
        COUNT(DISTINCT sale_date)   FILTER (WHERE s_qty>0)::int active_days,
        COALESCE(SUM(s_mrp),0)::bigint sales_mrp_value, COALESCE(SUM(s_cogs),0)::bigint sales_cogs_value,
        COALESCE(SUM(s_gst),0)::bigint sales_gst_collected, COALESCE(SUM(s_exgst),0)::bigint sales_ex_gst_value,
        COALESCE(SUM(r_mrp),0)::bigint return_mrp_value, COALESCE(SUM(r_cogs),0)::bigint return_cogs_value,
        COALESCE(SUM(r_gst),0)::bigint return_gst_collected, COALESCE(SUM(r_exgst),0)::bigint return_ex_gst_value
      FROM r) t) AS summary,
      (SELECT json_agg(d ORDER BY d.date) FROM (
        SELECT sale_date AS date, COALESCE(SUM(s_qty),0)::int sales_qty,
          COALESCE(SUM(s_mrp),0)::bigint mrp_value, COALESCE(SUM(s_gst),0)::bigint gst_collected,
          COALESCE(SUM(s_exgst),0)::bigint ex_gst_value, COALESCE(SUM(s_val),0)::bigint sales_value,
          COALESCE(SUM(r_qty),0)::int return_qty, COALESCE(SUM(s_txn),0)::int transactions
        FROM r GROUP BY sale_date) d) AS daily,
      (SELECT json_agg(st ORDER BY st.sales_value DESC) FROM (
        SELECT loc_name AS location_name, channel, city,
          COALESCE(SUM(s_qty),0)::int units_sold, COALESCE(SUM(s_val),0)::bigint sales_value,
          COALESCE(SUM(s_txn),0)::int transactions, COALESCE(SUM(r_qty),0)::int return_qty,
          COALESCE(SUM(r_val),0)::bigint return_value, COALESCE(SUM(s_mrp),0)::bigint mrp_value,
          COALESCE(SUM(s_cogs),0)::bigint cogs_value, COALESCE(SUM(s_gst),0)::bigint gst_collected,
          COALESCE(SUM(s_exgst),0)::bigint ex_gst_value, COALESCE(SUM(r_mrp),0)::bigint return_mrp_value,
          COALESCE(SUM(r_gst),0)::bigint return_gst_collected, COALESCE(SUM(r_exgst),0)::bigint return_ex_gst_value
        FROM r GROUP BY loc_name, channel, city ORDER BY sales_value DESC LIMIT 50) st) AS by_store,
      (SELECT json_agg(mo ORDER BY mo.month_date) FROM (
        SELECT TO_CHAR(DATE_TRUNC('month',sale_date),'Mon YY') AS month_label,
          DATE_TRUNC('month',sale_date)::date AS month_date, COALESCE(SUM(s_qty),0)::int sales_qty,
          COALESCE(SUM(s_val),0)::bigint sales_value, COALESCE(SUM(s_mrp),0)::bigint mrp_value,
          COALESCE(SUM(s_gst),0)::bigint gst_collected, COALESCE(SUM(s_exgst),0)::bigint ex_gst_value,
          COALESCE(SUM(r_qty),0)::int return_qty
        FROM r GROUP BY 1,2) mo) AS by_month,
      (SELECT json_agg(ch ORDER BY ch.sales_value DESC) FROM (
        SELECT COALESCE(channel,'(unassigned)')::text AS channel, COUNT(DISTINCT location_id)::int stores,
          COALESCE(SUM(s_qty),0)::int units, COALESCE(SUM(s_val),0)::bigint sales_value,
          COALESCE(SUM(s_val),0)::bigint value, COALESCE(SUM(s_txn),0)::int transactions,
          COALESCE(SUM(r_qty),0)::int return_qty, COALESCE(SUM(r_val),0)::bigint return_value,
          COALESCE(SUM(s_mrp),0)::bigint mrp_value, COALESCE(SUM(s_cogs),0)::bigint cogs_value,
          COALESCE(SUM(s_gst),0)::bigint gst_collected, COALESCE(SUM(s_exgst),0)::bigint ex_gst_value,
          COALESCE(SUM(r_mrp),0)::bigint return_mrp_value, COALESCE(SUM(r_gst),0)::bigint return_gst_collected,
          COALESCE(SUM(r_exgst),0)::bigint return_ex_gst_value,
          CASE WHEN COALESCE(channel,'') ILIKE '%outright%' OR COALESCE(channel,'') ILIKE '%- or' OR COALESCE(channel,'') ILIKE '% - or' OR COALESCE(channel,'') ILIKE '%- rt' THEN 'OUTRIGHT' ELSE 'SOR' END AS billing_model
        FROM r GROUP BY 1, billing_model HAVING COALESCE(SUM(s_val),0) > 0) ch) AS by_channel,
      (SELECT json_agg(ast ORDER BY ast.sales_value DESC) FROM (
        SELECT loc_name AS location_name, location_id::text AS location_id,
          COALESCE(loc_code,'') AS location_code, COALESCE(external_id,'') AS external_id,
          COALESCE(channel,'') AS channel, COALESCE(city,'') AS city, COALESCE(state,'') AS state,
          COALESCE(SUM(s_qty),0)::int units_sold, COALESCE(SUM(s_val),0)::bigint sales_value,
          COALESCE(SUM(s_txn),0)::int transactions, COALESCE(SUM(r_qty),0)::int return_qty,
          COALESCE(SUM(r_val),0)::bigint return_value, COALESCE(SUM(s_mrp),0)::bigint mrp_value,
          COALESCE(SUM(s_cogs),0)::bigint cogs_value, COALESCE(SUM(s_gst),0)::bigint gst_collected,
          COALESCE(SUM(s_exgst),0)::bigint ex_gst_value, COALESCE(SUM(r_mrp),0)::bigint return_mrp_value,
          COALESCE(SUM(r_gst),0)::bigint return_gst_collected, COALESCE(SUM(r_exgst),0)::bigint return_ex_gst_value
        FROM r GROUP BY loc_name, location_id, loc_code, external_id, channel, city, state) ast) AS all_stores
  `, p);

  // ── Query B: everything sourced from srd_sku via ONE materialized sku_agg ──
  const DIM = (col) => `
    (SELECT json_agg(x ORDER BY x.units_sold DESC NULLS LAST) FROM (
      SELECT ${col},
        COALESCE(SUM(units_sold),0)::int units_sold, COALESCE(SUM(sales_value),0)::bigint sales_value,
        COALESCE(SUM(transactions),0)::int transactions, COALESCE(SUM(return_qty),0)::int return_qty,
        COALESCE(SUM(return_value),0)::bigint return_value, COALESCE(SUM(mrp_value),0)::bigint mrp_value,
        COALESCE(SUM(cogs_value),0)::bigint cogs_value, COALESCE(SUM(gst_collected),0)::bigint gst_collected,
        COALESCE(SUM(ex_gst_value),0)::bigint ex_gst_value, COALESCE(SUM(return_mrp_value),0)::bigint return_mrp_value,
        COALESCE(SUM(return_gst_collected),0)::bigint return_gst_collected, COALESCE(SUM(return_ex_gst_value),0)::bigint return_ex_gst_value,
        ROUND(COALESCE(SUM(sales_value),0)/NULLIF(SUM(units_sold),0),0)::int avg_price
      FROM sku_agg GROUP BY ${col} ORDER BY units_sold DESC NULLS LAST LIMIT 50) x)`;
  const skuQ = query(`
    WITH sku_agg AS MATERIALIZED (
      -- GROUP BY sku_id ONLY (uuid) — dims via MAX(). Grouping by the 7 wide TEXT
      -- dims was ~4× slower. days_sold/first/last (COUNT DISTINCT, MIN/MAX over
      -- date) are DELIBERATELY excluded here: they force a sorted GroupAggregate
      -- over ~1.9M rows (the 1.5 s sort). Without them PG uses a parallel
      -- HashAggregate (~0.5 s); those 3 fields are enriched for only the ~400
      -- displayed SKUs below. MATERIALIZED so the 6 consumers share one pass.
      SELECT sku_id::text AS sku_id, MAX(sku_code) AS sku_code, MAX(product_name) AS product_name,
        COALESCE(MAX(fit_type),'') AS fit_type, MAX(color_code) AS color_code,
        MAX(color_name) AS color_name, MAX(size) AS size, MAX(mrp) AS mrp,
        COALESCE(SUM(s_qty),0)::int units_sold, COALESCE(SUM(s_val),0)::bigint sales_value,
        COALESCE(SUM(s_txn),0)::int transactions, COALESCE(SUM(r_qty),0)::int return_qty,
        COALESCE(SUM(r_val),0)::bigint return_value,
        COALESCE(SUM(s_mrp),0)::bigint mrp_value, COALESCE(SUM(s_cogs),0)::bigint cogs_value,
        COALESCE(SUM(s_gst),0)::bigint gst_collected, COALESCE(SUM(s_exgst),0)::bigint ex_gst_value,
        COALESCE(SUM(r_mrp),0)::bigint return_mrp_value, COALESCE(SUM(r_gst),0)::bigint return_gst_collected,
        COALESCE(SUM(r_exgst),0)::bigint return_ex_gst_value
      FROM srd_sku WHERE ${where}
      GROUP BY sku_id
      HAVING COALESCE(SUM(s_qty),0) + COALESCE(SUM(r_qty),0) > 0
    )
    SELECT
      (SELECT json_agg(s ORDER BY s.sales_value DESC) FROM (SELECT * FROM sku_agg ORDER BY sales_value DESC LIMIT 200) s) AS by_sku,
      (SELECT json_agg(s ORDER BY s.sales_value ASC) FROM (SELECT * FROM sku_agg ORDER BY sales_value ASC, units_sold ASC LIMIT 200) s) AS by_sku_slow,
      (SELECT COUNT(*)::int FROM sku_agg) AS sku_universe_count,
      (SELECT COUNT(*)::int FROM sku_agg WHERE units_sold>0) AS unique_skus_sold,
      ${DIM('color_name')} AS by_color,
      ${DIM('size')}       AS by_size
  `, p);

  const [storeRes, skuRes] = await Promise.all([storeQ, skuQ]);
  const A = storeRes.rows[0];
  const B = skuRes.rows[0];

  const sm = { ...A.summary, unique_skus_sold: B.unique_skus_sold };
  const byColor = { rows: B.by_color || [] };
  const bySize  = { rows: B.by_size  || [] };
  const byStore = { rows: A.by_store || [] };
  const byMonth = { rows: A.by_month || [] };
  const byChannel = { rows: A.by_channel || [] };
  const allStores = { rows: A.all_stores || [] };
  const bySku = { rows: B.by_sku || [] };
  const bySkuSlow = { rows: B.by_sku_slow || [] };
  const daily = { rows: A.daily || [] };
  const universe = { rows: [{ n: B.sku_universe_count }] };

  // ── Enrich ONLY the ~400 displayed SKUs with the non-additive fields kept
  //    out of the main pass: stores_count (distinct stores, from raw movements)
  //    and days_sold / first_sold_at / last_sold_at (from srd_sku, indexed seek
  //    on sku_id). Both are tiny indexed lookups on a 400-id list.
  const topRows  = bySku.rows;
  const slowRows = bySkuSlow.rows;
  const skuIds = [...new Set([...topRows, ...slowRows].map(r => r.sku_id))];
  let storesCountMap = new Map();
  let dateMap = new Map();
  if (skuIds.length) {
    const [scRes, dtRes] = await Promise.all([
      query(`
        SELECT m.sku_id::text AS sku_id, COUNT(DISTINCT m.location_id)::int AS stores_count
        FROM inventory_movements m JOIN locations l ON l.id = m.location_id
        WHERE m.movement_type='SALE' AND m.sku_id = ANY($1::uuid[])
          AND m.moved_at >= $2::date AND m.moved_at < $3::date + interval '1 day'${modeClauseRaw(mode)}
        GROUP BY m.sku_id`, [skuIds, from, to]),
      query(`
        SELECT sku_id::text AS sku_id,
          COUNT(DISTINCT sale_date) FILTER (WHERE s_qty>0)::int AS days_sold,
          MIN(sale_date) FILTER (WHERE s_qty>0) AS first_sold_at,
          MAX(sale_date) FILTER (WHERE s_qty>0) AS last_sold_at
        FROM srd_sku WHERE sku_id = ANY($1::uuid[])
          AND sale_date >= $2::date AND sale_date <= $3::date${modeClause(mode)}
        GROUP BY sku_id`, [skuIds, from, to]),
    ]);
    storesCountMap = new Map(scRes.rows.map(r => [r.sku_id, r.stores_count]));
    dateMap = new Map(dtRes.rows.map(r => [r.sku_id, r]));
  }
  const addStores = (r) => {
    const d = dateMap.get(r.sku_id) || {};
    return {
      ...r,
      stores_count:  storesCountMap.get(r.sku_id) || 0,
      days_sold:     d.days_sold || 0,
      first_sold_at: d.first_sold_at || null,
      last_sold_at:  d.last_sold_at || null,
    };
  };

  // Shape identical to megaRes.rows[0] consumed downstream in the controller.
  return {
    summary: sm,
    daily:        daily.rows,
    by_color:     byColor.rows,
    by_size:      bySize.rows,
    by_store:     byStore.rows,
    by_month:     byMonth.rows,
    by_channel:   byChannel.rows,
    all_stores:   allStores.rows,
    by_sku:       topRows.map(addStores),
    by_sku_slow:  slowRows.map(addStores),
    sku_universe_count: universe.rows[0].n,
  };
}

module.exports = { isRollupEligible, rollupsReady, aggregateFromRollup };
