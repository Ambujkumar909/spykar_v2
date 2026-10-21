// ─── salesRollup.js — Phase 1 daily sales rollup maintenance ──────────────────
//
// Builds/refreshes srd_store and srd_sku (migration 013) from
// inventory_movements. The valuation expressions here are a BYTE-FOR-BYTE copy
// of the live mov CTE in analytics.controller.js (getSalesAnalytics) so a
// rollup-served response is numerically identical to the live one:
//   mrp_val  = |qty| * COALESCE(mrp,0)
//   cost_val = |qty| * COALESCE(cost_price, COALESCE(mrp,0)*0.45)
//   gst_val  = gst_amount (the ERP's own GST for the line; rows without it fall
//              back to sale_value * gst_rate / (100 + gst_rate), default 12)
//   ex_gst   = sale_value - gst_val
//
// Two entry points:
//   rebuildAll(client)            — TRUNCATE + full reload (FULL sync / backfill)
//   refreshRange(client, from,to) — DELETE+reload a date window (DELTA sync)
//
// Both run inside the caller's transaction so readers never see a half-built
// table. Called by the DETACHED sync process (its pool has NO statement_timeout,
// so these multi-second scans are never capped).

// The per-row valuation, shared by both rollups. `m`/`s` are the movement/sku
// aliases. Identical to the live mov CTE.
const VAL = {
  qty:     `ABS(m.qty_change)::int`,
  val:     `COALESCE(m.sale_value,0)`,
  mrp:     `ABS(m.qty_change)::numeric * COALESCE(s.mrp,0)`,
  cost:    `ABS(m.qty_change)::numeric * COALESCE(s.cost_price, COALESCE(s.mrp,0)*0.45)`,
  gst:     `COALESCE(m.gst_amount, COALESCE(m.sale_value,0)::numeric * COALESCE(s.gst_rate,12) / NULLIF(100+COALESCE(s.gst_rate,12),0))`,
  exgst:   `COALESCE(m.sale_value,0)::numeric - COALESCE(m.gst_amount, COALESCE(m.sale_value,0)::numeric * COALESCE(s.gst_rate,12) / NULLIF(100+COALESCE(s.gst_rate,12),0))`,
};

// The 14 measure expressions (SALE-filtered then RETURN-filtered), reused by
// both INSERTs. `b` is the per-row CTE alias holding qty/val/mrp/cost/gst/exgst.
// Monetary measures stored as NUMERIC (full precision) so the controller can
// round ONCE at final aggregation — matching the live query, which casts to
// bigint only after summing every row. Casting per-group to bigint here would
// drop sub-rupee precision that accumulates across 236K groups (~₹800 drift).
function measureCols(b = 'b') {
  return `
    COALESCE(SUM(${b}.qty)   FILTER (WHERE ${b}.mt='SALE'),0)::int     AS s_qty,
    COALESCE(SUM(${b}.val)   FILTER (WHERE ${b}.mt='SALE'),0)::numeric AS s_val,
    COUNT(*)                 FILTER (WHERE ${b}.mt='SALE')::int        AS s_txn,
    COALESCE(SUM(${b}.mrp)   FILTER (WHERE ${b}.mt='SALE'),0)::numeric AS s_mrp,
    COALESCE(SUM(${b}.cost)  FILTER (WHERE ${b}.mt='SALE'),0)::numeric AS s_cogs,
    COALESCE(SUM(${b}.gst)   FILTER (WHERE ${b}.mt='SALE'),0)::numeric AS s_gst,
    COALESCE(SUM(${b}.exgst) FILTER (WHERE ${b}.mt='SALE'),0)::numeric AS s_exgst,
    COALESCE(SUM(${b}.qty)   FILTER (WHERE ${b}.mt='RETURN'),0)::int     AS r_qty,
    COALESCE(SUM(${b}.val)   FILTER (WHERE ${b}.mt='RETURN'),0)::numeric AS r_val,
    COUNT(*)                 FILTER (WHERE ${b}.mt='RETURN')::int        AS r_txn,
    COALESCE(SUM(${b}.mrp)   FILTER (WHERE ${b}.mt='RETURN'),0)::numeric AS r_mrp,
    COALESCE(SUM(${b}.cost)  FILTER (WHERE ${b}.mt='RETURN'),0)::numeric AS r_cogs,
    COALESCE(SUM(${b}.gst)   FILTER (WHERE ${b}.mt='RETURN'),0)::numeric AS r_gst,
    COALESCE(SUM(${b}.exgst) FILTER (WHERE ${b}.mt='RETURN'),0)::numeric AS r_exgst`;
}

// Per-row source CTE — the immutable join + valuation. `dateWhere` optionally
// scopes to a window (incremental); empty string = whole history (full rebuild).
function rowSource(dateWhere) {
  return `
    SELECT
      m.moved_at, m.location_id, m.sku_id, m.movement_type AS mt,
      ${VAL.qty}   AS qty,
      ${VAL.val}   AS val,
      ${VAL.mrp}   AS mrp,
      ${VAL.cost}  AS cost,
      ${VAL.gst}   AS gst,
      ${VAL.exgst} AS exgst,
      s.sku_code, s.product_name, s.fit_type, s.color_code, s.color_name, s.size, s.mrp AS sku_mrp,
      m.reference_no AS bill_no, s.gender_name, s.category_norm, s.product AS sku_product,
      l.name AS loc_name, l.code AS loc_code, COALESCE(l.external_id,'') AS external_id,
      COALESCE(l.group_name, l.type::text) AS channel, l.city, l.state, l.shop_closed
    FROM inventory_movements m
    JOIN skus s      ON s.id = m.sku_id
    JOIN locations l ON l.id = m.location_id
    WHERE m.movement_type IN ('SALE','RETURN') AND l.is_active = true AND s.is_active = true${dateWhere}`;
  // Active stores and ACTIVE SKU master only — the same baseline every live
  // endpoint applies, so the fast path and the live path always agree.
}

function storeInsertSQL(dateWhere) {
  return `
    INSERT INTO srd_store (sale_date, location_id, loc_name, loc_code, external_id,
      channel, city, state, shop_closed,
      s_qty,s_val,s_txn,s_mrp,s_cogs,s_gst,s_exgst, r_qty,r_val,r_txn,r_mrp,r_cogs,r_gst,r_exgst)
    SELECT b.moved_at::date, b.location_id,
      b.loc_name, b.loc_code, b.external_id, b.channel, b.city, b.state, b.shop_closed,
      ${measureCols('b')}
    FROM (${rowSource(dateWhere)}) b
    GROUP BY b.moved_at::date, b.location_id, b.loc_name, b.loc_code, b.external_id,
             b.channel, b.city, b.state, b.shop_closed`;
}

function skuInsertSQL(dateWhere) {
  return `
    INSERT INTO srd_sku (sale_date, shop_closed, sku_id, sku_code, product_name,
      fit_type, color_code, color_name, size, mrp,
      s_qty,s_val,s_txn,s_mrp,s_cogs,s_gst,s_exgst, r_qty,r_val,r_txn,r_mrp,r_cogs,r_gst,r_exgst)
    SELECT b.moved_at::date, b.shop_closed, b.sku_id,
      b.sku_code, b.product_name, b.fit_type, b.color_code, b.color_name, b.size, MAX(b.sku_mrp),
      ${measureCols('b')}
    FROM (${rowSource(dateWhere)}) b
    GROUP BY b.moved_at::date, b.shop_closed, b.sku_id,
             b.sku_code, b.product_name, b.fit_type, b.color_code, b.color_name, b.size`;
}

// War Room rollups (migration 036), from the same rows as srd_store so the
// two always agree. NOB = distinct bill numbers of sale AND return bills —
// the definition the War Room workbook uses. Product drops its price-band
// suffix ('JEANS<', 'JACKETS>=5000' → 'JEANS', 'JACKETS'); net = sold − returned.
function warRoomInsertSQL(dateWhere) {
  return [`
    INSERT INTO wr_store_day (sale_date, location_id, bills)
    SELECT b.moved_at::date, b.location_id, COUNT(DISTINCT b.bill_no)::int
    FROM (${rowSource(dateWhere)}) b
    GROUP BY b.moved_at::date, b.location_id`, `
    INSERT INTO wr_cat_day (sale_date, location_id, gender, category, product, qty, val, mrp)
    SELECT b.moved_at::date, b.location_id,
      COALESCE(b.gender_name, ''), COALESCE(b.category_norm, ''),
      regexp_replace(COALESCE(b.sku_product, ''), '\\s*[<>].*$', ''),
      SUM(CASE WHEN b.mt = 'SALE' THEN b.qty ELSE -b.qty END)::int,
      SUM(CASE WHEN b.mt = 'SALE' THEN b.val ELSE -b.val END),
      SUM(CASE WHEN b.mt = 'SALE' THEN b.mrp ELSE -b.mrp END)
    FROM (${rowSource(dateWhere)}) b
    GROUP BY 1, 2, 3, 4, 5`];
}

// Rebuild only the War Room rollups (first build after migration 036, or a repair).
async function rebuildWarRoom(client) {
  const t0 = Date.now();
  await client.query('TRUNCATE wr_store_day, wr_cat_day');
  for (const sql of warRoomInsertSQL('')) await client.query(sql);
  const { rows: [r] } = await client.query('SELECT (SELECT COUNT(*) FROM wr_store_day)::int AS d, (SELECT COUNT(*) FROM wr_cat_day)::int AS c');
  return { wr_store_day: r.d, wr_cat_day: r.c, ms: Date.now() - t0 };
}

// Full rebuild — used by FULL sync and the one-time backfill. TRUNCATE + reload
// inside the caller's transaction (AccessExclusiveLock → readers see new data
// atomically, never an empty table).
async function rebuildAll(client) {
  const t0 = Date.now();
  await client.query('TRUNCATE srd_store');
  await client.query('TRUNCATE srd_sku');
  await client.query(storeInsertSQL(''));
  await client.query(skuInsertSQL(''));
  await client.query('TRUNCATE wr_store_day, wr_cat_day');
  for (const sql of warRoomInsertSQL('')) await client.query(sql);
  const [{ rows: [a] }, { rows: [b] }] = await Promise.all([
    client.query('SELECT COUNT(*)::int n FROM srd_store'),
    client.query('SELECT COUNT(*)::int n FROM srd_sku'),
  ]);
  return { srd_store: a.n, srd_sku: b.n, ms: Date.now() - t0 };
}

// Incremental — refresh a [from,to] date window (inclusive). DELETE the window
// then reload it. Used after a DELTA sync, scoped to the sync's date range.
async function refreshRange(client, fromISO, toISO) {
  const t0 = Date.now();
  const dateWhere = ` AND m.moved_at >= '${fromISO}'::date AND m.moved_at < '${toISO}'::date + interval '1 day'`;
  await client.query(`DELETE FROM srd_store WHERE sale_date >= $1::date AND sale_date <= $2::date`, [fromISO, toISO]);
  await client.query(`DELETE FROM srd_sku   WHERE sale_date >= $1::date AND sale_date <= $2::date`, [fromISO, toISO]);
  await client.query(storeInsertSQL(dateWhere));
  await client.query(skuInsertSQL(dateWhere));
  await client.query(`DELETE FROM wr_store_day WHERE sale_date >= $1::date AND sale_date <= $2::date`, [fromISO, toISO]);
  await client.query(`DELETE FROM wr_cat_day   WHERE sale_date >= $1::date AND sale_date <= $2::date`, [fromISO, toISO]);
  for (const sql of warRoomInsertSQL(dateWhere)) await client.query(sql);
  return { window: [fromISO, toISO], ms: Date.now() - t0 };
}

module.exports = { rebuildAll, refreshRange, rebuildWarRoom };
