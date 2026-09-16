// ─── Primary Sales controller ────────────────────────────────────────────────
// Powers the "Primary Sales" page — warehouse-level movements from the Infor M3
// MITTRA ledger, an INDEPENDENT feed from the store-level secondary-sales
// pipeline. Read-only (SELECT only). NEVER touches the ~110M-row raw ledger.
//
// TWO speed layers, chosen per request (see pickSource):
//   • primary_sales_daily_wh — grain (trdt × warehouse × ttyp × category).
//     226× smaller than sku grain. Serves everything the page shows by default:
//     KPIs, daily/flow/monthly, top warehouses, top categories, txn types, the
//     warehouse / type / category pivots + trends, and the category Lens filter.
//   • primary_sales_daily    — grain (trdt × warehouse × sku × ttyp). Only for
//     SKU-attribute views (colour / size / product dims, non-category Lens
//     filters) and the one KPI that cannot be folded: COUNT(DISTINCT sku_id).
// Both are written in the same ETL transaction, so they always agree.
//
// Conventions mirror stockAvailability.controller.js: `query`+`getOrSet`/`TTL`,
// { success, data }, today-relative windows, strict whitelists (no
// attacker-controlled SQL — every identifier comes from a table below).
//
// SEMANTICS: qty is SIGNED (Σ trqt). "Net value" keeps the sign (stock value
// added/drawn); "Throughput" = Σ|qty×price| (direction-agnostic, so the headline
// never reads negative). All date windows filter on TRDT (transaction date).

const { query, pool } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');

const WH_TABLE = 'primary_sales_daily_wh';
const SKU_TABLE = 'primary_sales_daily';

// ─── Whitelisted group-by dimensions ─────────────────────────────────────────
// `col(src)` yields the column for the chosen source. warehouse keys by WHLO
// (not id) so a pivot row's `key` is directly the value the warehouse filter
// accepts — lets the page drill on a row click uniformly.
const GROUP_DIMS = {
  warehouse: { col: () => 'w.whlo',            label: () => "(w.whlo || ' · ' || COALESCE(w.whnm,''))", needsWh: true,  needsSku: false },
  type:      { col: () => 'r.ttyp',            label: () => 'r.ttyp',                                   needsWh: false, needsSku: false },
  category:  { col: (s) => s.categoryCol,      label: (s) => s.categoryCol,                             needsWh: false, needsSku: false },
  colour:    { col: () => 's.color_name',      label: () => 's.color_name',                             needsWh: false, needsSku: true  },
  size:      { col: () => 's.size',            label: () => 's.size',                                   needsWh: false, needsSku: true  },
  product:   { col: () => 's.product',         label: () => 's.product',                                needsWh: false, needsSku: true  },
};
const normalizeGroupBy = (g) => (g === 'color' ? 'colour' : g);

// Pre-summed rollup columns; the controller re-aggregates with SUM(...).
const MEASURE_EXPR = { units: 'r.qty', gross: 'r.gross', cost: 'r.cost' };
const measureOrUnits = (m) => (MEASURE_EXPR[m] ? m : 'units');

// Lens filters that exist only on the SKU master (category is folded into the
// warehouse-grain rollup, so it is NOT in this list).
const SKU_ONLY_FILTERS = ['colour', 'color', 'size', 'product', 'sub_product', 'gender', 'season'];
const hasSkuOnlyFilter = (q) => SKU_ONLY_FILTERS.some((k) => q[k]);

// ─── TTYP labels ─────────────────────────────────────────────────────────────
// M3 transaction-type codes → human names. Direction is proven from the loaded
// data (qty sign); the names describe each code's role, derived from the ledger
// structure — mirror pairs (92↔93, 50↔51) net to zero ⇒ warehouse transfers;
// unpaired positive ⇒ receipts; unpaired negative ⇒ issues; zero-qty ⇒ status.
// EDIT this map to match your M3 configuration's official descriptions.
const TTYP_LABELS = {
  '10': 'PO receipt',            '11': 'PO return',
  '20': 'Receipt (order)',       '21': 'Receipt (order)',      '23': 'Adjustment',
  '25': 'Goods receipt',         '30': 'Goods receipt',        '31': 'Stock issue',
  '40': 'Stock adjustment (+)',  '41': 'Stock adjustment (−)',
  '50': 'Warehouse transfer',    '51': 'Warehouse transfer',   '52': 'In-transit (G2G)',
  '92': 'Warehouse transfer',    '93': 'Warehouse transfer',
  '96': 'Reclassification',      '97': 'Status posting',
};
const ttypLabel = (code) => TTYP_LABELS[String(code)] || `Type ${code}`;

// ─── Period → [from,to] (today-relative) ─────────────────────────────────────
// LOCAL calendar date (server runs in IST). The previous `toISOString()` was
// UTC: between 00:00 and 05:30 IST "today" resolved to YESTERDAY, so Today/MTD
// windows silently excluded the current day and disagreed with the frontend
// (which formats local dates) — a cache-key mismatch on top of wrong numbers.
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function periodToRange(period, from, to) {
  if (from && to) return { from, to };
  const today = new Date();
  const y = today.getFullYear(); const m = today.getMonth();
  switch (String(period || '').toLowerCase()) {
    case 'today': return { from: fmt(today), to: fmt(today) };
    case 'wtd': { const d = new Date(today); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return { from: fmt(d), to: fmt(today) }; }
    case 'qtd': { const q = Math.floor(m / 3) * 3; return { from: fmt(new Date(y, q, 1)), to: fmt(today) }; }
    case 'ytd': { const fyStart = m >= 3 ? new Date(y, 3, 1) : new Date(y - 1, 3, 1); return { from: fmt(fyStart), to: fmt(today) }; }
    case 'mtd':
    default:    return { from: fmt(new Date(y, m, 1)), to: fmt(today) };
  }
}
function previousRange(from, to) {
  const f = new Date(from), t = new Date(to);
  const lenDays = Math.max(1, Math.round((t - f) / 86400000) + 1);
  const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (lenDays - 1));
  return { prevFrom: fmt(prevFrom), prevTo: fmt(prevTo), lenDays };
}

// ─── Source selection ────────────────────────────────────────────────────────
// The warehouse-grain rollup unless a SKU-only attribute is involved (as a
// filter or as the group-by dim). `forceSku` for the distinct-SKU count.
function pickSource(q, dim = null, { forceSku = false } = {}) {
  const sku = forceSku || hasSkuOnlyFilter(q) || !!(dim && dim.needsSku);
  return sku
    ? { table: SKU_TABLE, categoryCol: 's.category_norm', joinSku: true }
    : { table: WH_TABLE,  categoryCol: 'r.category_norm', joinSku: false };
}

// ─── Scope builder ───────────────────────────────────────────────────────────
// Every value may be a comma-separated multi-select (the sidebar Lens sends
// arrays as CSV) → exact `= ANY(array)` match. Columns are aligned with
// filters.controller so the sidebar's option values match what we filter on.
function buildScope(q, params, src) {
  const conds = [];
  const addMulti = (col, val) => {
    const arr = String(val).split(',').map((x) => x.trim()).filter(Boolean);
    if (!arr.length) return;
    params.push(arr);
    conds.push(`${col} = ANY($${params.length}::text[])`);
  };
  if (q.warehouse)         addMulti('w.whlo', q.warehouse);
  if (q.type)              addMulti('r.ttyp', q.type);
  if (q.category)          addMulti(src.categoryCol, q.category);
  if (q.colour || q.color) addMulti('s.color_name', q.colour || q.color);
  if (q.size)              addMulti('s.size', q.size);
  if (q.product)           addMulti('s.product', q.product);
  if (q.sub_product)       addMulti('s.sub_product', q.sub_product);
  if (q.gender)            addMulti('s.gender_name', q.gender);
  if (q.season)            addMulti('s.season', q.season);
  return { conds };
}

// Conditional FROM — only join what the query needs. Values (qty/gross/cost) are
// already in the rollup, so most aggregates need NO joins at all. `w` is added
// for warehouse grouping/filter, `s` only when the source is sku grain AND a
// SKU attribute is actually referenced.
function buildFrom(q, src, { wh = false } = {}) {
  const needWh = wh || !!q.warehouse;
  const needSku = src.joinSku && (hasSkuOnlyFilter(q) || !!q.category || src.dimNeedsSku);
  return `FROM ${src.table} r`
    + (needWh ? ' JOIN primary_warehouses w ON w.id = r.warehouse_id' : '')
    + (needSku ? ' JOIN skus s ON s.id = r.sku_id' : '');
}
const withDim = (src, dim) => ({ ...src, dimNeedsSku: !!(dim && dim.needsSku) });

function pct(now, then) {
  if (then === 0 || then == null) return null;
  return Number((((now - then) / Math.abs(then)) * 100).toFixed(1));
}
async function hasAnyData() {
  const r = await query(`SELECT EXISTS(SELECT 1 FROM ${WH_TABLE} LIMIT 1) AS e`);
  return r.rows[0].e === true;
}
// Build a fresh (params, where) with the TRDT window + scope filters.
function windowScope(q, from, to, src) {
  const p = [];
  const { conds } = buildScope(q, p, src);
  const fi = p.push(from); const ti = p.push(to);
  const where = [`r.trdt BETWEEN $${fi}::date AND $${ti}::date`, ...conds].join(' AND ');
  return { p, where };
}
// COUNT(DISTINCT sku_id) over a window — the one KPI that needs sku grain.
// Index-only via idx_psd_trdt_sku when unscoped.
async function distinctSkus(q, from, to) {
  const src = pickSource(q, null, { forceSku: true });
  const ws = windowScope(q, from, to, src);
  const r = await query(`SELECT COUNT(DISTINCT r.sku_id)::int AS n ${buildFrom(q, src)} WHERE ${ws.where}`, ws.p);
  return Number(r.rows[0].n);
}

// ════════════════════════════════════════════════════════════════════════════
// A) GET /summary
// ════════════════════════════════════════════════════════════════════════════
async function getSummary(req, res, next) {
  try {
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);
    const cacheKey = `primsales:summary:${from}:${to}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      if (!(await hasAnyData())) {
        return { from, to, qty: 0, value_gross: 0, value_cost: 0, txns: 0, warehouse_count: 0, sku_count: 0, delta_qty_vs_prev_pct: null };
      }
      const src = pickSource(req.query);
      const F = buildFrom(req.query, src);
      const cur = windowScope(req.query, from, to, src);
      const { prevFrom, prevTo } = previousRange(from, to);
      const prev = windowScope(req.query, prevFrom, prevTo, src);
      const [cRes, pRes, skuCount] = await Promise.all([
        query(`SELECT COALESCE(SUM(r.qty),0)::bigint AS qty, COALESCE(SUM(r.gross),0)::bigint AS value_gross,
                      COALESCE(SUM(r.cost),0)::bigint AS value_cost, COALESCE(SUM(r.txns),0)::bigint AS txns,
                      COUNT(DISTINCT r.warehouse_id)::int AS warehouse_count
               ${F} WHERE ${cur.where}`, cur.p),
        query(`SELECT COALESCE(SUM(r.qty),0)::bigint AS qty ${F} WHERE ${prev.where}`, prev.p),
        distinctSkus(req.query, from, to),
      ]);
      const c = cRes.rows[0];
      return {
        from, to, qty: Number(c.qty), value_gross: Number(c.value_gross), value_cost: Number(c.value_cost),
        txns: Number(c.txns), warehouse_count: Number(c.warehouse_count), sku_count: skuCount,
        delta_qty_vs_prev_pct: pct(Number(c.qty), Number(pRes.rows[0].qty)),
      };
    }, TTL.SALES_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// B) GET /trend
// ════════════════════════════════════════════════════════════════════════════
async function getTrend(req, res, next) {
  try {
    const groupBy = normalizeGroupBy(req.query.group_by || 'warehouse');
    const dim = GROUP_DIMS[groupBy];
    if (!dim) return res.status(400).json({ success: false, error: `invalid group_by: ${req.query.group_by}` });
    const measure = measureOrUnits(req.query.measure);
    const top = Math.min(Math.max(parseInt(req.query.top, 10) || 8, 1), 20);
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);

    const cacheKey = `primsales:trend:${groupBy}:${measure}:${from}:${to}:${top}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      const src = withDim(pickSource(req.query, dim), dim);
      const keyCol = dim.col(src), labelCol = dim.label(src);
      const F = buildFrom(req.query, src, { wh: dim.needsWh });
      const d0 = windowScope(req.query, from, to, src);
      const dates = (await query(`SELECT DISTINCT r.trdt::text AS d ${F} WHERE ${d0.where} ORDER BY 1`, d0.p)).rows.map((x) => x.d);
      if (!dates.length) return { from, to, group_by: groupBy, measure, dates: [], series: [] };

      const s1 = windowScope(req.query, from, to, src);
      const w1 = [s1.where, `${keyCol} IS NOT NULL`].join(' AND ');
      const members = (await query(
        `SELECT ${keyCol} AS k, MAX(${labelCol}) AS label, COALESCE(SUM(${MEASURE_EXPR[measure]}),0)::bigint AS v
         ${F} WHERE ${w1} GROUP BY ${keyCol}
         ORDER BY ABS(SUM(${MEASURE_EXPR[measure]})) DESC NULLS LAST LIMIT ${top}`, s1.p)).rows;
      if (!members.length) return { from, to, group_by: groupBy, measure, dates, series: [] };

      const s2 = windowScope(req.query, from, to, src);
      const kIdx = s2.p.push(members.map((m) => m.k));
      const w2 = [s2.where, `${keyCol} = ANY($${kIdx})`].join(' AND ');
      const rows = (await query(
        `SELECT r.trdt::text AS date, ${keyCol} AS k, COALESCE(SUM(${MEASURE_EXPR[measure]}),0)::bigint AS v
         ${F} WHERE ${w2} GROUP BY r.trdt, ${keyCol}`, s2.p)).rows;

      const byKey = new Map(members.map((m) => [m.k, new Map()]));
      for (const x of rows) { const s = byKey.get(x.k); if (s) s.set(x.date, Number(x.v)); }
      const lbl = (v) => (groupBy === 'type' ? `${ttypLabel(v)} · T${v}` : v);
      const series = members.map((m) => ({ key: m.k, label: lbl(m.label), points: dates.map((dt) => ({ date: dt, value: byKey.get(m.k).get(dt) ?? 0 })) }));
      return { from, to, group_by: groupBy, measure, dates, series };
    }, TTL.SALES_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// C) GET /pivot
// ════════════════════════════════════════════════════════════════════════════
async function buildPivot(req) {
  const groupBy = normalizeGroupBy(req.query.group_by || 'warehouse');
  const dim = GROUP_DIMS[groupBy];
  if (!dim) { const e = new Error(`invalid group_by: ${req.query.group_by}`); e.status = 400; throw e; }
  const measure = measureOrUnits(req.query.measure);
  const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);
  if (!(await hasAnyData())) return { group_by: groupBy, measure, from, to, rows: [], totals: null };

  const src = withDim(pickSource(req.query, dim), dim);
  const keyCol = dim.col(src), labelCol = dim.label(src);
  const F = buildFrom(req.query, src, { wh: dim.needsWh });
  const sortExpr = measure === 'units' ? 'SUM(r.qty)' : `SUM(${MEASURE_EXPR[measure]})`;
  const cur = windowScope(req.query, from, to, src);
  const w = [cur.where, `${keyCol} IS NOT NULL`].join(' AND ');
  const { prevFrom, prevTo } = previousRange(from, to);
  const prev = windowScope(req.query, prevFrom, prevTo, src);
  const pw = [prev.where, `${keyCol} IS NOT NULL`].join(' AND ');

  // Both scans on one client with a raised work_mem so a sku-grain hash
  // aggregate stays in RAM instead of spilling to disk. 256MB is plenty for a
  // YTD window; the old 512MB × N concurrent pivots could exhaust the box.
  const client = await pool.connect();
  let curRows, prevRows;
  try {
    await client.query(`SET work_mem = '256MB'`);
    curRows = (await client.query(
      `SELECT ${keyCol} AS key, MAX(${labelCol}) AS label,
              COALESCE(SUM(r.qty),0)::bigint AS qty, COALESCE(SUM(r.gross),0)::bigint AS value_gross,
              COALESCE(SUM(r.cost),0)::bigint AS value_cost, COALESCE(SUM(r.txns),0)::bigint AS txns
       ${F} WHERE ${w} GROUP BY ${keyCol}
       ORDER BY ABS(${sortExpr}) DESC NULLS LAST`, cur.p)).rows;
    prevRows = (await client.query(
      `SELECT ${keyCol} AS key, COALESCE(SUM(r.qty),0)::bigint AS qty ${F} WHERE ${pw} GROUP BY ${keyCol}`, prev.p)).rows;
  } finally {
    try { await client.query('RESET work_mem'); } catch (_) { /* ignore */ }
    client.release();
  }
  const prevByKey = new Map(prevRows.map((x) => [x.key, Number(x.qty)]));

  const rows = curRows.map((x) => {
    const qty = Number(x.qty), gross = Number(x.value_gross), txns = Number(x.txns);
    return { key: x.key, label: groupBy === 'type' ? `${ttypLabel(x.label)} · T${x.label}` : x.label, qty,
      value_gross: gross, value_cost: Number(x.value_cost), txns,
      avg_price: qty !== 0 ? Math.round(gross / qty) : null,
      delta_qty_vs_prev_pct: pct(qty, prevByKey.get(x.key) ?? 0) };
  });

  // Totals: sum in JS from curRows — avoids a third full scan.
  const totals = rows.length ? {
    qty: rows.reduce((a, x) => a + x.qty, 0),
    value_gross: rows.reduce((a, x) => a + x.value_gross, 0),
    value_cost: rows.reduce((a, x) => a + x.value_cost, 0),
    txns: rows.reduce((a, x) => a + x.txns, 0),
  } : null;

  return { group_by: groupBy, measure, from, to, rows, totals };
}
async function getPivot(req, res, next) {
  try {
    const cacheKey = `primsales:pivot:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, () => buildPivot(req), TTL.SALES_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D) GET /types — distinct transaction types (warehouse-grain rollup; cached)
// ════════════════════════════════════════════════════════════════════════════
async function getTypes(req, res, next) {
  try {
    const data = await getOrSet('primsales:types', async () => {
      // Powers the Type dropdown (filters by ttyp only). The ttyp set is stable,
      // so the last 120 days of the tiny warehouse-grain rollup cover every
      // active type. (This once scanned the 110M-row raw ledger on every mount.)
      const r = await query(
        `SELECT ttyp, COALESCE(SUM(txns),0)::bigint AS txns, COALESCE(SUM(qty),0)::bigint AS qty
           FROM ${WH_TABLE}
          WHERE ttyp IS NOT NULL
            AND trdt > (SELECT MAX(trdt) FROM ${WH_TABLE}) - INTERVAL '120 days'
          GROUP BY ttyp ORDER BY txns DESC`);
      return r.rows.map((x) => ({ ttyp: x.ttyp, trtp: null, label: ttypLabel(x.ttyp), txns: Number(x.txns), qty: Number(x.qty) }));
    }, TTL.FILTER_OPTIONS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// E) GET /warehouses
// ════════════════════════════════════════════════════════════════════════════
async function getWarehouses(req, res, next) {
  try {
    const data = await getOrSet('primsales:warehouses', async () => {
      const r = await query(`SELECT whlo, whnm, faci, whty FROM primary_warehouses WHERE is_active = true ORDER BY whlo`);
      return r.rows;
    }, TTL.LOCATION_MASTER);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// H) GET /range — the min/max TRDT that actually has data (for the Custom picker)
// ════════════════════════════════════════════════════════════════════════════
async function getRange(req, res, next) {
  try {
    const data = await getOrSet('primsales:range', async () => {
      const r = await query(`SELECT MIN(trdt)::text AS from, MAX(trdt)::text AS to FROM ${WH_TABLE}`);
      return { from: r.rows[0].from || null, to: r.rows[0].to || null };
    }, TTL.LOCATION_MASTER);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// G) GET /overview — the whole briefing in one round-trip (TRDT-windowed)
// ════════════════════════════════════════════════════════════════════════════
async function getOverview(req, res, next) {
  try {
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);
    const cacheKey = `primsales:overview:${from}:${to}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      const base = { from, to, empty: true, kpis: null, daily: [], flow: [], monthly: [], top_wh: [], top_cat: [], ttyp: [] };
      if (!(await hasAnyData())) return base;

      const src = pickSource(req.query);                       // warehouse grain unless a SKU-only filter is on
      const Fbase = buildFrom(req.query, src);                 // no joins unless a filter needs one
      const Fwh = buildFrom(req.query, src, { wh: true });     // + warehouses (leaderboard)
      const catExpr = `COALESCE(NULLIF(${src.categoryCol},''),'—')`;
      const s = () => windowScope(req.query, from, to, src);
      const k1 = s();
      const kpisQ = query(
        `SELECT COALESCE(SUM(r.txns),0)::bigint AS txns, COALESCE(SUM(r.qty),0)::bigint AS net_qty,
                COALESCE(SUM(r.gross_abs),0)::bigint AS throughput, COALESCE(SUM(ABS(r.qty)),0)::bigint AS throughput_units,
                COALESCE(SUM(r.gross),0)::bigint AS net_value,
                COUNT(DISTINCT r.warehouse_id)::int AS wh, COUNT(DISTINCT r.ttyp)::int AS ttyp
         ${Fbase} WHERE ${k1.where}`, k1.p);
      const d = s();
      const dailyQ = query(`SELECT r.trdt::text AS d, COALESCE(SUM(r.gross_abs),0)::bigint AS g, COALESCE(SUM(ABS(r.qty)),0)::bigint AS u ${Fbase} WHERE ${d.where} GROUP BY r.trdt ORDER BY r.trdt`, d.p);
      const fl = s();
      const flowQ = query(`SELECT CASE WHEN r.qty>0 THEN 'Inbound' WHEN r.qty<0 THEN 'Outbound' ELSE 'Neutral' END AS dir,
                COALESCE(SUM(r.txns),0)::bigint AS txns, COALESCE(SUM(r.gross_abs),0)::bigint AS g, COALESCE(SUM(ABS(r.qty)),0)::bigint AS u ${Fbase} WHERE ${fl.where} GROUP BY 1 ORDER BY g DESC`, fl.p);
      const mo = s();
      const monthlyQ = query(`SELECT to_char(date_trunc('month',r.trdt),'Mon') AS mon, date_trunc('month',r.trdt) AS mk, COALESCE(SUM(r.gross),0)::bigint AS net, COALESCE(SUM(r.qty),0)::bigint AS net_u
         ${Fbase} WHERE ${mo.where} GROUP BY 1,2 ORDER BY 2`, mo.p);
      const wh = s();
      const whQ = query(`SELECT w.whlo AS code, w.whnm AS name, COALESCE(SUM(r.gross_abs),0)::bigint AS g, COALESCE(SUM(ABS(r.qty)),0)::bigint AS u
         ${Fwh} WHERE ${wh.where} GROUP BY w.whlo, w.whnm ORDER BY g DESC NULLS LAST LIMIT 10`, wh.p);
      const ca = s();
      const Fcat = buildFrom(req.query, withDim(src, GROUP_DIMS.colour)); // on sku grain the category column lives on skus → force the join
      const catQ = query(`SELECT ${catExpr} AS name, COALESCE(SUM(r.gross_abs),0)::bigint AS g, COALESCE(SUM(ABS(r.qty)),0)::bigint AS u
         ${Fcat} WHERE ${ca.where} GROUP BY 1 ORDER BY g DESC NULLS LAST LIMIT 8`, ca.p);
      const tt = s();
      const ttypQ = query(`SELECT r.ttyp AS code, COALESCE(SUM(r.txns),0)::bigint AS txns, COALESCE(SUM(r.qty),0)::bigint AS qty, COALESCE(SUM(r.gross),0)::bigint AS net
         ${Fbase} WHERE ${tt.where} AND r.ttyp IS NOT NULL GROUP BY r.ttyp ORDER BY SUM(r.gross_abs) DESC NULLS LAST LIMIT 8`, tt.p);
      const { prevFrom, prevTo } = previousRange(from, to);
      const pv = windowScope(req.query, prevFrom, prevTo, src);
      const prevQ = query(`SELECT COALESCE(SUM(r.gross_abs),0)::bigint AS throughput ${Fbase} WHERE ${pv.where}`, pv.p);

      const [k, daily, flow, monthly, whr, cat, ttr, prev] = await Promise.all([kpisQ, dailyQ, flowQ, monthlyQ, whQ, catQ, ttypQ, prevQ]);
      const kr = k.rows[0]; const throughput = Number(kr.throughput);
      return {
        from, to, empty: Number(kr.txns) === 0,
        kpis: { txns: Number(kr.txns), net_qty: Number(kr.net_qty), throughput, throughput_units: Number(kr.throughput_units),
          net_value: Number(kr.net_value),
          // sku_count is served by GET /sku-count (the one KPI that needs the
          // sku-grain table: ~1.4s over a full year even index-only). Keeping it
          // out of /overview lets the page paint in ~150ms; the tile fills lazily.
          warehouse_count: Number(kr.wh), sku_count: null, ttyp_count: Number(kr.ttyp),
          throughput_delta_pct: pct(throughput, Number(prev.rows[0].throughput)) },
        daily: daily.rows.map((x) => ({ d: x.d, g: Number(x.g), u: Number(x.u) })),
        flow: flow.rows.map((x) => ({ dir: x.dir, txns: Number(x.txns), g: Number(x.g), u: Number(x.u) })),
        monthly: monthly.rows.map((x) => ({ mon: x.mon, net: Number(x.net), net_u: Number(x.net_u) })),
        top_wh: whr.rows.map((x) => ({ code: x.code, name: x.name, g: Number(x.g), u: Number(x.u) })),
        top_cat: cat.rows.map((x) => ({ name: x.name, g: Number(x.g), u: Number(x.u) })),
        ttyp: ttr.rows.map((x) => ({ code: x.code, label: ttypLabel(x.code), txns: Number(x.txns), qty: Number(x.qty), net: Number(x.net) })),
      };
    }, TTL.SALES_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// I) GET /sku-count — distinct SKUs moved in the window (lazy KPI)
// ════════════════════════════════════════════════════════════════════════════
async function getSkuCount(req, res, next) {
  try {
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);
    const cacheKey = `primsales:skucount:${from}:${to}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => ({
      from, to, sku_count: (await hasAnyData()) ? await distinctSkus(req.query, from, to) : 0,
    }), TTL.SALES_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// F) GET /export.csv — same filters as /pivot, streamed
// ════════════════════════════════════════════════════════════════════════════
async function exportCsv(req, res, next) {
  try {
    const pivot = await buildPivot(req);
    const cols = ['member', 'net_units', 'value_gross', 'value_cost', 'txns', 'avg_price', 'delta_qty_vs_prev_pct'];
    const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="primary-sales-${pivot.group_by}-${pivot.from}_${pivot.to}.csv"`);
    res.write(cols.join(',') + '\n');
    for (const x of pivot.rows) {
      res.write([esc(x.label), x.qty, x.value_gross, x.value_cost, x.txns, x.avg_price, x.delta_qty_vs_prev_pct].map(esc).join(',') + '\n');
    }
    res.end();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

module.exports = { getSummary, getTrend, getPivot, getTypes, getWarehouses, getOverview, getRange, getSkuCount, exportCsv };
