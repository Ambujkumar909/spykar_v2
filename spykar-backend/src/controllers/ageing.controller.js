// ─── Inventory Ageing controller ─────────────────────────────────────────────
// Reads the PRECOMPUTED `inventory_ageing` table (built by
// src/database/load_inventory_ageing.js — see migration 019). Two sources:
//   • warehouse — true FIFO ageing off the M3 MITTRA ledger
//   • store     — continuous-on-hand ageing off the daily snapshot
// Everything here is read-only + cached; the heavy computation lives in the
// batch loader so these endpoints return in milliseconds. Lens-filterable
// (same multi-select scope grammar as stockAvailability).

const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');

const AGE_TTL = TTL.STOCK_AGEING || TTL.INVENTORY_SNAPSHOT || 300;

// Bucket registry (index in the table → key + label + "is this aged?").
const BUCKETS = [
  { idx: 0, key: 'd0_30',        label: '0–30 days',    aged: false },
  { idx: 1, key: 'd31_60',       label: '31–60 days',   aged: false },
  { idx: 2, key: 'd61_90',       label: '61–90 days',   aged: false },
  { idx: 3, key: 'd91_180',      label: '91–180 days',  aged: true  },
  { idx: 4, key: 'd181_365',     label: '181–365 days', aged: true  },
  { idx: 5, key: 'd365_plus',    label: '365+ days',    aged: true  },
  { idx: 9, key: 'undetermined', label: 'Undetermined', aged: false },
];

const SOURCES = new Set(['warehouse', 'store']);
const normSource = (s) => (SOURCES.has(s) ? s : 'warehouse');

// group-by dimension whitelist per source. keyCol identifies a member,
// labelCol is its display string. needs: which join the dim requires.
function dimsFor(source) {
  const sku = {
    category: { keyCol: 's.category_norm', labelCol: 's.category_norm' },
    colour:   { keyCol: 's.color_name',    labelCol: 's.color_name'    },
    size:     { keyCol: 's.size',          labelCol: 's.size'          },
    product:  { keyCol: 's.product',       labelCol: 's.product'       },
    gender:   { keyCol: 's.gender_name',   labelCol: 's.gender_name'   },
    season:   { keyCol: 's.season',        labelCol: 's.season'        },
  };
  if (source === 'warehouse') {
    return { warehouse: { keyCol: 'w.whlo', labelCol: "(w.whlo || ' · ' || w.whnm)" }, ...sku };
  }
  return {
    state:   { keyCol: 'l.state',      labelCol: 'l.state'      },
    city:    { keyCol: 'l.city',       labelCol: 'l.city'       },
    channel: { keyCol: 'l.group_name', labelCol: 'l.group_name' },
    store:   { keyCol: 'l.id::text',   labelCol: "(l.code || ' · ' || l.name)" },
    ...sku,
  };
}
const normalizeGroupBy = (g) => (g === 'color' ? 'colour' : g);

// FROM clause + scope predicates. Both sources join skus (attributes + value);
// store joins locations, warehouse joins primary_warehouses.
function baseFrom(source) {
  return source === 'warehouse'
    ? `FROM inventory_ageing a
         JOIN primary_warehouses w ON w.id = a.ref_id
         JOIN skus s ON s.id = a.sku_id`
    : `FROM inventory_ageing a
         JOIN locations l ON l.id = a.ref_id
         JOIN skus s ON s.id = a.sku_id`;
}

function buildScope(q, params, source) {
  params.push(source);
  const conds = [`a.source = $${params.length}`];

  const split = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const addCI = (col, val) => { const a = split(val).map((s) => s.toLowerCase()); if (!a.length) return; params.push(a); conds.push(`lower(${col}) = ANY($${params.length})`); };
  const addEq = (col, val) => { const a = split(val); if (!a.length) return; params.push(a); conds.push(`${col} = ANY($${params.length})`); };

  // SKU attributes (both sources)
  if (q.category)    addCI('s.category_norm', q.category);
  if (q.colour || q.color) addCI('s.color_name', q.colour || q.color);
  if (q.size)        addEq('s.size', q.size);
  if (q.product)     addCI('s.product', q.product);
  if (q.gender)      addCI('s.gender_name', q.gender);
  if (q.sub_product) addCI('s.sub_product', q.sub_product);
  if (q.season)      addCI('s.season', q.season);

  if (source === 'store') {
    const mode = String(q.status || q.mode || 'active').toLowerCase();
    conds.push('l.is_active = true');
    if (mode === 'active')   conds.push('l.shop_closed = false');
    if (mode === 'inactive') conds.push('l.shop_closed = true');
    if (q.state)   addCI('l.state', q.state);
    if (q.city)    addCI('l.city', q.city);
    if (q.channel || q.group_name) addEq('l.group_name', q.channel || q.group_name);
    if (q.store || q.store_code)   addEq('l.code', q.store || q.store_code);
  } else {
    if (q.warehouse) addEq('w.whlo', q.warehouse);
  }
  return { conds };
}

async function meta(source) {
  const r = await query(
    `SELECT as_of_date::text AS as_of, covered_days, computed_at FROM inventory_ageing_meta WHERE source = $1`,
    [source]);
  return r.rows[0] || { as_of: null, covered_days: null, computed_at: null };
}

// ── A) summary — bucket totals + KPIs ────────────────────────────────────────
async function getSummary(req, res, next) {
  try {
    const source = normSource(req.query.source);
    const cacheKey = `ageing:summary:${source}:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, async () => {
      const params = [];
      const { conds } = buildScope(req.query, params, source);
      const r = await query(
        `SELECT a.age_bucket,
                SUM(a.units)::bigint       AS units,
                SUM(a.value_gross)::bigint AS value_gross,
                SUM(a.value_cost)::bigint  AS value_cost
           ${baseFrom(source)}
          WHERE ${conds.join(' AND ')}
          GROUP BY a.age_bucket`, params);

      const byIdx = new Map(r.rows.map((x) => [Number(x.age_bucket), x]));
      const buckets = BUCKETS.map((b) => {
        const row = byIdx.get(b.idx);
        return { ...b, units: Number(row?.units || 0), value_gross: Number(row?.value_gross || 0), value_cost: Number(row?.value_cost || 0) };
      });
      const sum = (f) => buckets.reduce((a, b) => a + b[f], 0);
      const agedUnits = buckets.filter((b) => b.aged).reduce((a, b) => a + b.units, 0);
      const totalUnits = sum('units');
      return {
        source,
        meta: await meta(source),
        buckets,
        total_units: totalUnits,
        total_value_gross: sum('value_gross'),
        total_value_cost: sum('value_cost'),
        aged_units: agedUnits,                          // > 90 days
        aged_pct: totalUnits > 0 ? Number((agedUnits / totalUnits * 100).toFixed(1)) : null,
        aged_value_gross: buckets.filter((b) => b.aged).reduce((a, b) => a + b.value_gross, 0),
      };
    }, AGE_TTL);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ── B) pivot — per-member ageing breakdown ──────────────────────────────────
async function buildPivot(req) {
  const source = normSource(req.query.source);
  const groupBy = normalizeGroupBy(req.query.group_by || (source === 'warehouse' ? 'warehouse' : 'category'));
  const dim = dimsFor(source)[groupBy];
  if (!dim) { const e = new Error(`invalid group_by: ${req.query.group_by}`); e.status = 400; throw e; }
  const measure = ['units', 'gross', 'cost'].includes(req.query.measure) ? req.query.measure : 'units';
  const sortCol = { units: 'units', gross: 'value_gross', cost: 'value_cost' }[measure];

  const params = [];
  const { conds } = buildScope(req.query, params, source);
  const bucketAgg = BUCKETS.map((b) => `SUM(a.units) FILTER (WHERE a.age_bucket = ${b.idx})::bigint AS ${b.key}`).join(',\n            ');

  const r = await query(
    `SELECT ${dim.keyCol} AS key, MAX(${dim.labelCol}) AS label,
            SUM(a.units)::bigint       AS units,
            SUM(a.value_gross)::bigint AS value_gross,
            SUM(a.value_cost)::bigint  AS value_cost,
            SUM(a.units) FILTER (WHERE a.age_bucket IN (3,4,5))::bigint AS aged_units,
            ${bucketAgg}
       ${baseFrom(source)}
      WHERE ${conds.join(' AND ')} AND ${dim.keyCol} IS NOT NULL
      GROUP BY ${dim.keyCol}
      ORDER BY ${sortCol} DESC NULLS LAST`, params);

  const rows = r.rows.map((x) => {
    const units = Number(x.units);
    const buckets = {}; BUCKETS.forEach((b) => { buckets[b.key] = Number(x[b.key] || 0); });
    return {
      key: x.key, label: x.label, units,
      value_gross: Number(x.value_gross), value_cost: Number(x.value_cost),
      aged_units: Number(x.aged_units),
      aged_pct: units > 0 ? Number((Number(x.aged_units) / units * 100).toFixed(1)) : null,
      buckets,
    };
  });
  return { source, group_by: groupBy, measure, rows };
}

async function getPivot(req, res, next) {
  try {
    const cacheKey = `ageing:pivot:${JSON.stringify(req.query)}`;
    const data = await getOrSet(cacheKey, () => buildPivot(req), AGE_TTL);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

// ── C) export.csv ────────────────────────────────────────────────────────────
async function exportCsv(req, res, next) {
  try {
    const pivot = await buildPivot(req);
    const cols = ['member', 'units', 'value_gross', 'value_cost', 'aged_units', 'aged_pct',
      ...BUCKETS.map((b) => b.key)];
    const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ageing-${pivot.source}-${pivot.group_by}.csv"`);
    res.write(cols.join(',') + '\n');
    for (const r of pivot.rows) {
      res.write([esc(r.label), r.units, r.value_gross, r.value_cost, r.aged_units, r.aged_pct,
        ...BUCKETS.map((b) => r.buckets[b.key])].join(',') + '\n');
    }
    res.end();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

module.exports = { getSummary, getPivot, exportCsv };
