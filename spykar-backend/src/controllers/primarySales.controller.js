// ─── Primary Sales controller ────────────────────────────────────────────────
// Powers the "Primary Sales" page — warehouse-level movements from the Infor M3
// MITTRA ledger, an INDEPENDENT feed from the store-level secondary-sales
// pipeline. Read-only (SELECT only). Every analytical query reads the
// pre-aggregated rollup `primary_sales_daily r` (grain: trdt × warehouse × sku ×
// ttyp), NOT the ~110M-row raw ledger — so responses are ~1s, not ~60s. The raw
// table is only touched by /types (needs trtp, cached). Conventions mirror
// stockAvailability.controller.js: `query`+`getOrSet`/`TTL`, { success, data },
// today-relative windows, strict whitelists (no attacker-controlled SQL).
//
// SEMANTICS: qty is SIGNED (Σ trqt). "Net value" keeps the sign (stock value
// added/drawn); "Throughput" = Σ|qty×price| (direction-agnostic, so the headline
// never reads negative). All date windows filter on TRDT (transaction date).

const { query, pool } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');

// ─── Whitelisted group-by dimensions (rollup-based) ──────────────────────────
const GROUP_DIMS = {
  // warehouse keys by WHLO (not id) so a pivot row's `key` is directly the value
  // the warehouse filter accepts — lets the page drill on a row click uniformly.
  warehouse: { keyCol: 'w.whlo',           labelCol: "(w.whlo || ' · ' || COALESCE(w.whnm,''))", needsSku: false },
  type:      { keyCol: 'r.ttyp',           labelCol: 'r.ttyp',          needsSku: false },
  category:  { keyCol: 's.category_norm',  labelCol: 's.category_norm', needsSku: true  },
  colour:    { keyCol: 's.color_name',     labelCol: 's.color_name',    needsSku: true  },
  size:      { keyCol: 's.size',           labelCol: 's.size',          needsSku: true  },
  product:   { keyCol: 's.product',        labelCol: 's.product',       needsSku: true  },
};
const normalizeGroupBy = (g) => (g === 'color' ? 'colour' : g);

// Pre-summed rollup columns; the controller re-aggregates with SUM(...).
const MEASURE_EXPR = { units: 'r.qty', gross: 'r.gross', cost: 'r.cost' };
const measureOrUnits = (m) => (MEASURE_EXPR[m] ? m : 'units');

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
function periodToRange(period, from, to) {
  if (from && to) return { from, to };
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
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
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { prevFrom: fmt(prevFrom), prevTo: fmt(prevTo), lenDays };
}

// ─── Scope builder ───────────────────────────────────────────────────────────
// Every value may be a comma-separated multi-select (the sidebar Lens sends
// arrays as CSV) → exact `= ANY(array)` match. Columns are aligned with
// filters.controller so the sidebar's option values match what we filter on.
function buildScope(q, params) {
  const conds = [];
  const addMulti = (col, val) => {
    const arr = String(val).split(',').map((x) => x.trim()).filter(Boolean);
    if (!arr.length) return;
    params.push(arr);
    conds.push(`${col} = ANY($${params.length}::text[])`);
  };
  if (q.warehouse)         addMulti('w.whlo', q.warehouse);
  if (q.type)              addMulti('r.ttyp', q.type);
  if (q.category)          addMulti('s.category_norm', q.category);
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
// for warehouse grouping/filter, `s` for any sku-attribute dim/filter. Dropping
// the 3.6M×75k skus hash join from warehouse/daily/flow/kpi queries is the win.
function buildFrom(q, { wh = false, sku = false } = {}) {
  const needWh = wh || !!q.warehouse;
  const needSku = sku || !!(q.category || q.colour || q.color || q.size || q.product || q.sub_product || q.gender || q.season);
  return 'FROM primary_sales_daily r'
    + (needWh ? ' JOIN primary_warehouses w ON w.id = r.warehouse_id' : '')
    + (needSku ? ' JOIN skus s ON s.id = r.sku_id' : '');
}
const dimJoins = (dim) => ({ wh: dim.keyCol.startsWith('w.'), sku: !!dim.needsSku });

function pct(now, then) {
  if (then === 0 || then == null) return null;
  return Number((((now - then) / Math.abs(then)) * 100).toFixed(1));
}
async function hasAnyData() {
  const r = await query('SELECT EXISTS(SELECT 1 FROM primary_sales_daily LIMIT 1) AS e');
  return r.rows[0].e === true;
}
// Build a fresh (params, where) with the TRDT window + scope filters.
function windowScope(q, from, to) {
  const p = [];
  const { conds } = buildScope(q, p);
  const fi = p.push(from); const ti = p.push(to);
  const where = [`r.trdt BETWEEN $${fi}::date AND $${ti}::date`, ...conds].join(' AND ');
  return { p, where };
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
      const F = buildFrom(req.query);
      const cur = windowScope(req.query, from, to);
      const c = (await query(
        `SELECT COALESCE(SUM(r.qty),0)::bigint AS qty, COALESCE(SUM(r.gross),0)::bigint AS value_gross,
                COALESCE(SUM(r.cost),0)::bigint AS value_cost, COALESCE(SUM(r.txns),0)::bigint AS txns,
                COUNT(DISTINCT r.warehouse_id)::int AS warehouse_count, COUNT(DISTINCT r.sku_id)::int AS sku_count
         ${F} WHERE ${cur.where}`, cur.p)).rows[0];
      const { prevFrom, prevTo } = previousRange(from, to);
      const prev = windowScope(req.query, prevFrom, prevTo);
      const pqty = Number((await query(`SELECT COALESCE(SUM(r.qty),0)::bigint AS qty ${F} WHERE ${prev.where}`, prev.p)).rows[0].qty);
      return {
        from, to, qty: Number(c.qty), value_gross: Number(c.value_gross), value_cost: Number(c.value_cost),
        txns: Number(c.txns), warehouse_count: Number(c.warehouse_count), sku_count: Number(c.sku_count),
        delta_qty_vs_prev_pct: pct(Number(c.qty), pqty),
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
      const F = buildFrom(req.query, dimJoins(dim));
      const d0 = windowScope(req.query, from, to);
      const dates = (await query(`SELECT DISTINCT r.trdt::text AS d ${F} WHERE ${d0.where} ORDER BY 1`, d0.p)).rows.map((x) => x.d);
      if (!dates.length) return { from, to, group_by: groupBy, measure, dates: [], series: [] };

      const s1 = windowScope(req.query, from, to);
      const w1 = [s1.where, `${dim.keyCol} IS NOT NULL`].join(' AND ');
      const members = (await query(
        `SELECT ${dim.keyCol} AS k, MAX(${dim.labelCol}) AS label, COALESCE(SUM(${MEASURE_EXPR[measure]}),0)::bigint AS v
         ${F} WHERE ${w1} GROUP BY ${dim.keyCol}
         ORDER BY ABS(SUM(${MEASURE_EXPR[measure]})) DESC NULLS LAST LIMIT ${top}`, s1.p)).rows;
      if (!members.length) return { from, to, group_by: groupBy, measure, dates, series: [] };

      const s2 = windowScope(req.query, from, to);
      const kIdx = s2.p.push(members.map((m) => m.k));
      const w2 = [s2.where, `${dim.keyCol} = ANY($${kIdx})`].join(' AND ');
      const rows = (await query(
        `SELECT r.trdt::text AS date, ${dim.keyCol} AS k, COALESCE(SUM(${MEASURE_EXPR[measure]}),0)::bigint AS v
         ${F} WHERE ${w2} GROUP BY r.trdt, ${dim.keyCol}`, s2.p)).rows;

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

  const F = buildFrom(req.query, dimJoins(dim));
  const sortExpr = { units: 'qty', gross: 'value_gross', cost: 'value_cost' }[measure];
  const cur = windowScope(req.query, from, to);
  const w = [cur.where, `${dim.keyCol} IS NOT NULL`].join(' AND ');
  const { prevFrom, prevTo } = previousRange(from, to);
  const prev = windowScope(req.query, prevFrom, prevTo);
  const pw = [prev.where, `${dim.keyCol} IS NOT NULL`].join(' AND ');

  // Both scans on one client with a raised work_mem so the 3.6M-row hash
  // aggregate + COUNT(DISTINCT) stays in RAM instead of spilling to disk.
  const client = await pool.connect();
  let curRows, prevRows;
  try {
    await client.query(`SET work_mem = '512MB'`);
    curRows = (await client.query(
      `SELECT ${dim.keyCol} AS key, MAX(${dim.labelCol}) AS label,
              COALESCE(SUM(r.qty),0)::bigint AS qty, COALESCE(SUM(r.gross),0)::bigint AS value_gross,
              COALESCE(SUM(r.cost),0)::bigint AS value_cost, COALESCE(SUM(r.txns),0)::bigint AS txns
       ${F} WHERE ${w} GROUP BY ${dim.keyCol}
       ORDER BY ABS(${sortExpr === 'qty' ? 'SUM(r.qty)' : `SUM(${MEASURE_EXPR[measure]})`}) DESC NULLS LAST`, cur.p)).rows;
    prevRows = (await client.query(
      `SELECT ${dim.keyCol} AS key, COALESCE(SUM(r.qty),0)::bigint AS qty ${F} WHERE ${pw} GROUP BY ${dim.keyCol}`, prev.p)).rows;
  } finally {
    try { await client.query('RESET work_mem'); } catch (_) {}
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
// D) GET /types — distinct transaction types (reads RAW for trtp; cached)
// ════════════════════════════════════════════════════════════════════════════
async function getTypes(req, res, next) {
  try {
    const data = await getOrSet('primsales:types', async () => {
      // Powers the Type dropdown (filters by ttyp only). Read the pre-aggregated
      // rollup bounded to the last 120 days — the ttyp set is stable, so this
      // covers every active type — instead of a full scan of the 110M-row raw
      // ledger (which timed out cold on prod). Grouped by ttyp (trtp was only
      // label decoration; the filter never used it).
      const r = await query(
        `SELECT ttyp, COALESCE(SUM(txns),0)::bigint AS txns, COALESCE(SUM(qty),0)::bigint AS qty
           FROM primary_sales_daily
          WHERE ttyp IS NOT NULL
            AND trdt > (SELECT MAX(trdt) FROM primary_sales_daily) - INTERVAL '120 days'
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
      const r = await query('SELECT MIN(trdt)::text AS from, MAX(trdt)::text AS to FROM primary_sales_daily');
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

      const Fbase = buildFrom(req.query);              // no joins unless a filter needs one
      const Fwh = buildFrom(req.query, { wh: true });   // + warehouses (leaderboard)
      const Fcat = buildFrom(req.query, { sku: true }); // + skus (category)
      const s = () => windowScope(req.query, from, to);
      const k1 = s();
      const kpisQ = query(
        `SELECT COALESCE(SUM(r.txns),0)::bigint AS txns, COALESCE(SUM(r.qty),0)::bigint AS net_qty,
                COALESCE(SUM(r.gross_abs),0)::bigint AS throughput, COALESCE(SUM(ABS(r.qty)),0)::bigint AS throughput_units,
                COALESCE(SUM(r.gross),0)::bigint AS net_value,
                COUNT(DISTINCT r.warehouse_id)::int AS wh, COUNT(DISTINCT r.sku_id)::int AS sku, COUNT(DISTINCT r.ttyp)::int AS ttyp
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
      const catQ = query(`SELECT COALESCE(NULLIF(s.category_norm,''),'—') AS name, COALESCE(SUM(r.gross_abs),0)::bigint AS g, COALESCE(SUM(ABS(r.qty)),0)::bigint AS u
         ${Fcat} WHERE ${ca.where} GROUP BY 1 ORDER BY g DESC NULLS LAST LIMIT 8`, ca.p);
      const tt = s();
      const ttypQ = query(`SELECT r.ttyp AS code, COALESCE(SUM(r.txns),0)::bigint AS txns, COALESCE(SUM(r.qty),0)::bigint AS qty, COALESCE(SUM(r.gross),0)::bigint AS net
         ${Fbase} WHERE ${tt.where} AND r.ttyp IS NOT NULL GROUP BY r.ttyp ORDER BY SUM(r.gross_abs) DESC NULLS LAST LIMIT 8`, tt.p);
      const { prevFrom, prevTo } = previousRange(from, to);
      const pv = windowScope(req.query, prevFrom, prevTo);
      const prevQ = query(`SELECT COALESCE(SUM(r.gross_abs),0)::bigint AS throughput ${Fbase} WHERE ${pv.where}`, pv.p);

      const [k, daily, flow, monthly, whr, cat, ttr, prev] = await Promise.all([kpisQ, dailyQ, flowQ, monthlyQ, whQ, catQ, ttypQ, prevQ]);
      const kr = k.rows[0]; const throughput = Number(kr.throughput);
      return {
        from, to, empty: Number(kr.txns) === 0,
        kpis: { txns: Number(kr.txns), net_qty: Number(kr.net_qty), throughput, throughput_units: Number(kr.throughput_units),
          net_value: Number(kr.net_value),
          warehouse_count: Number(kr.wh), sku_count: Number(kr.sku), ttyp_count: Number(kr.ttyp),
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

module.exports = { getSummary, getTrend, getPivot, getTypes, getWarehouses, getOverview, getRange, exportCsv };
