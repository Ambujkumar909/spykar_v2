// ─── ESales Stock controller ─────────────────────────────────────────────────
// Powers the "ESales Stock" page — stock on hand at the e-commerce partners,
// from the month-end partner workbooks (see services/esalesStock.js for how
// they are loaded and what guarantees the numbers). Read-only apart from
// keeping esales_items in step with the item master (ensureState).
//
// THE DATA IS SNAPSHOTS, NOT MOVEMENTS. Each workbook is the stock on one date.
// For a date window [from, to]:
//   closing  = the latest snapshot on or before `to`   (stock carries forward)
//   opening  = the latest snapshot before `from`
//   change   = closing − opening
//   series   = every snapshot dated inside the window
// Units come straight from the files. Value = units × MRP from the item master
// (the files carry no prices); a barcode the master does not know has no MRP,
// so it counts in units, is worth ₹0, and is grouped as "Unmatched barcode".
//
// Response shapes follow primarySales.controller.js so the page is the same
// page with different content. Every SQL identifier comes from a table below.

const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');
const { rebuildItems, FILES_MD5 } = require('../services/esalesStock');

const UNMATCHED = 'Unmatched barcode';
// Reads esales_stock_wide — stock ⋈ partner ⋈ item, pre-joined (migration 034).
// The three LATERAL selects only NAME its columns as r (stock row), p (partner)
// and s (item; all NULL for an unmatched barcode): Postgres flattens them, so
// this is a plain scan of one table while every query below reads as the
// three-table join it stands for.
const FROM = `FROM esales_stock_wide w
  CROSS JOIN LATERAL (SELECT w.snapshot_date, w.partner_id, w.barcode, w.qty, w.lines) r
  CROSS JOIN LATERAL (SELECT w.partner_id AS id, w.partner_name AS name, w.channel) p
  CROSS JOIN LATERAL (SELECT w.item_barcode AS barcode, w.sku, w.sku_key, w.mrp, w.category_norm, w.gender_name, w.product,
                             w.sub_product, w.size, w.color_name, w.shade, w.style, w.season) s`;
const VALUE = 'r.qty * COALESCE(s.mrp, 0)';
// One SKU = one item-master EAN (a suffixed marketplace barcode resolves to its
// EAN); a barcode the master does not know is its own SKU. sku_key is that
// identity as a dense integer.
const SKU = 's.sku_key';
const skuDim = (col) => `CASE WHEN s.barcode IS NULL THEN '${UNMATCHED}' ELSE COALESCE(NULLIF(${col}, ''), '—') END`;

// Whitelisted group-by dimensions. `key` is what the matching filter accepts,
// so a pivot row can be drilled by sending its key back.
const GROUP_DIMS = {
  partner:  { key: 'p.id::text',               label: 'p.name' },
  channel:  { key: 'p.channel',                label: 'p.channel' },
  category: { key: skuDim('s.category_norm'),  label: skuDim('s.category_norm') },
  gender:   { key: skuDim('s.gender_name'),    label: skuDim('s.gender_name') },
  sub_product: { key: skuDim('s.sub_product'), label: skuDim('s.sub_product') },
  season:   { key: skuDim('s.season'),         label: skuDim('s.season') },
  colour:   { key: skuDim('s.color_name'),     label: skuDim('s.color_name') },
  size:     { key: skuDim('s.size'),           label: skuDim('s.size') },
  product:  { key: skuDim('s.product'),        label: skuDim('s.product') },
};
const normalizeGroupBy = (g) => (g === 'color' ? 'colour' : g);
const MEASURE_EXPR = { units: 'r.qty', value: VALUE };
const measureOf = (m) => (m === 'value' || m === 'gross' ? 'value' : 'units');

const num = (v) => Number(v || 0);
function pct(now, then) {
  if (then === 0 || then == null) return null;
  return Number((((now - then) / Math.abs(then)) * 100).toFixed(1));
}

// ─── Data state: snapshot list + a version for cache keys ────────────────────
// Checked at most every 5 s. The version changes whenever a workbook is
// loaded/removed or the derived data is rebuilt, so a load shows up within
// seconds without waiting for the 24 h analytics TTL. Also the one place that keeps
// esales_items in step with the item master.
async function loadState() {
  const read = async () => (await query(`
    SELECT (${FILES_MD5})                                                             AS files,
           (SELECT last_success_at FROM master_refresh_state WHERE name = 'skus')      AS master,
           (SELECT items_built_at FROM esales_meta)                                    AS built,
           (SELECT files_md5 FROM esales_meta)                                         AS built_files`)).rows[0];
  let st = await read();
  // Derived data is behind when the set of workbooks changed since it was
  // built (a loader that died before its own rebuild) or the item master was
  // refreshed after it.
  if (st.built_files !== st.files || (st.master && st.built < st.master)) {
    await rebuildItems();
    st = await read();
  }
  const snaps = (await query('SELECT snapshot_date::text AS d FROM esales_files ORDER BY snapshot_date')).rows.map((x) => x.d);
  return { version: `${st.files}:${st.built ? new Date(st.built).getTime() : 0}`, snaps };
}
const ensureState = () => getOrSet('esales:state', loadState, 5);
const cached = async (name, req, fn) => {
  const st = await ensureState();
  return getOrSet(`esales:${st.version}:${name}:${JSON.stringify(req.query)}`, () => fn(st), TTL.SALES_ANALYTICS);
};

// ─── Window → snapshots ──────────────────────────────────────────────────────
function windowOf(snaps, q) {
  const from = q.from ? String(q.from).slice(0, 10) : '0001-01-01';
  const to = q.to ? String(q.to).slice(0, 10) : '9999-12-31';
  const inWin = snaps.filter((d) => d >= from && d <= to);
  const last = (test) => { for (let i = snaps.length - 1; i >= 0; i--) if (test(snaps[i])) return snaps[i]; return null; };
  return { from, to, inWin, closing: last((d) => d <= to), opening: last((d) => d < from) };
}

// ─── Scope builder ───────────────────────────────────────────────────────────
// Every value may be a comma-separated multi-select (the sidebar Lens sends
// CSV) → exact `= ANY(array)`. Partner is filtered by id: names are free text.
// An SKU-attribute filter drops unmatched barcodes (they have no attributes)
// unless the "Unmatched barcode" bucket itself is selected.
function buildScope(q, p) {
  const conds = [];
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  const add = (col, val, { cast = 'text', sku = false } = {}) => {
    const arr = list(val);
    if (!arr.length) return;
    p.push(arr);
    const c = `${col} = ANY($${p.length}::${cast}[])`;
    conds.push(sku && arr.includes(UNMATCHED) ? `(${c} OR s.barcode IS NULL)` : c);
  };
  if (q.partner)           add('p.id::text', q.partner);
  if (q.partner_name) {     // sidebar Lens: names, '|'-separated (a name may hold a comma)
    const names = String(q.partner_name).split('|').map((x) => x.trim()).filter(Boolean);
    if (names.length) { p.push(names); conds.push(`p.name = ANY($${p.length}::text[])`); }
  }
  if (q.channel)           add('p.channel', q.channel);
  if (q.category)          add('s.category_norm', q.category, { sku: true });
  if (q.colour || q.color) add('s.color_name', q.colour || q.color, { sku: true });
  if (q.size)              add('s.size', q.size, { sku: true });
  if (q.product)           add('s.product', q.product, { sku: true });
  if (q.sub_product)       add('s.sub_product', q.sub_product, { sku: true });
  if (q.gender)            add('s.gender_name', q.gender, { sku: true });
  if (q.season)            add('s.season', q.season, { sku: true });
  if (q.shade)             add('s.shade', q.shade, { sku: true });
  if (q.style)             add('s.style', q.style, { sku: true });
  return conds;
}
// Fresh (params, where) for a set of snapshot dates + the scope filters.
function datesScope(q, dates) {
  const p = [dates];
  const where = ['r.snapshot_date = ANY($1::date[])', ...buildScope(q, p)].join(' AND ');
  return { p, where };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ════════════════════════════════════════════════════════════════════════════
// GET /overview — the whole briefing in one round-trip
// ════════════════════════════════════════════════════════════════════════════
async function buildOverview(q, st) {
  const w = windowOf(st.snaps, q);
  const base = { from: w.from, to: w.to, empty: true, kpis: null, stock: null, daily: [], flow: [], monthly: [], top_partners: [], top_cat: [], top_gender: [], top_season: [], season_age: [], channels: [], health: null };
  if (!w.closing) return base;
  const C = w.closing; const O = w.opening;
  const both = O && O !== C ? [O, C] : [C];
  const isC = `r.snapshot_date = '${C}'::date`;           // C / O come from esales_files, not the request
  const isO = O && O !== C ? `r.snapshot_date = '${O}'::date` : 'FALSE';

  // Same calendar month a year before the closing snapshot, when a file exists for it.
  const Y = st.snaps.find((d) => d.slice(0, 7) === `${Number(C.slice(0, 4)) - 1}${C.slice(4, 7)}`) || null;
  const s1 = datesScope(q, [...new Set([...both, ...w.inWin, ...(Y ? [Y] : [])])]);
  const seriesQ = query(`SELECT r.snapshot_date::text AS d, SUM(r.qty)::bigint AS u, ROUND(SUM(${VALUE}))::bigint AS g, SUM(r.lines)::bigint AS lines
    ${FROM} WHERE ${s1.where} GROUP BY r.snapshot_date`, s1.p);

  const s2 = datesScope(q, [C]);
  const closeQ = query(`SELECT COALESCE(SUM(r.qty) FILTER (WHERE s.barcode IS NULL), 0)::bigint AS unmatched_units,
           COUNT(DISTINCT r.barcode) FILTER (WHERE s.barcode IS NULL)::int AS unmatched_barcodes,
           COUNT(*) FILTER (WHERE r.qty > 0)::int AS in_stock, COUNT(*) FILTER (WHERE r.qty = 0)::int AS zero,
           COUNT(*) FILTER (WHERE r.qty BETWEEN 1 AND 2)::int AS low, COUNT(*) FILTER (WHERE r.qty < 0)::int AS negative,
           COALESCE(SUM(r.qty) FILTER (WHERE r.qty < 0), 0)::bigint AS negative_units, COUNT(*)::int AS positions
    ${FROM} WHERE ${s2.where}`, s2.p);

  const s3 = datesScope(q, [C]);
  const partnerQ = query(`SELECT p.id::text AS key, p.name, p.channel, SUM(r.qty)::bigint AS u, ROUND(SUM(${VALUE}))::bigint AS g
    ${FROM} WHERE ${s3.where} GROUP BY p.id, p.name, p.channel ORDER BY u DESC, p.name`, s3.p);

  const s4 = datesScope(q, [C]);
  const catQ = query(`SELECT ${skuDim('s.category_norm')} AS name, SUM(r.qty)::bigint AS u, ROUND(SUM(${VALUE}))::bigint AS g
    ${FROM} WHERE ${s4.where} GROUP BY 1 ORDER BY u DESC, 1`, s4.p);

  const s4g = datesScope(q, [C]);
  const genderQ = query(`SELECT ${skuDim('s.gender_name')} AS name, SUM(r.qty)::bigint AS u, ROUND(SUM(${VALUE}))::bigint AS g
    ${FROM} WHERE ${s4g.where} GROUP BY 1 ORDER BY u DESC, 1`, s4g.p);

  const s4s = datesScope(q, [C]);
  const seasonQ = query(`SELECT ${skuDim('s.season')} AS name, SUM(r.qty)::bigint AS u, ROUND(SUM(${VALUE}))::bigint AS g
    ${FROM} WHERE ${s4s.where} GROUP BY 1 ORDER BY u DESC, 1`, s4s.p);

  // Pareto: how few SKUs hold half the units (largest first).
  const s4p = datesScope(q, [C]);
  const paretoQ = query(`SELECT COUNT(*) FILTER (WHERE x.run - x.u < x.total / 2.0)::int AS half, COUNT(*)::int AS skus
      FROM (SELECT y.u, SUM(y.u) OVER (ORDER BY y.u DESC, y.k) AS run, SUM(y.u) OVER () AS total
              FROM (SELECT ${SKU} AS k, SUM(r.qty) AS u ${FROM} WHERE ${s4p.where} GROUP BY 1 HAVING SUM(r.qty) > 0) y) x`, s4p.p);

  const s5 = datesScope(q, both);
  // Two-level (channel × barcode, then channel): distinct barcodes by hashing,
  // not by a 50k-row text sort.
  const chanQ = query(`SELECT x.name, COALESCE(SUM(x.l), 0)::bigint AS lines, COALESCE(SUM(x.u), 0)::bigint AS u,
           COALESCE(ROUND(SUM(x.g)), 0)::bigint AS g, COALESCE(SUM(x.ou), 0)::bigint AS ou, COUNT(*) FILTER (WHERE x.instock)::int AS skus
      FROM (SELECT p.channel AS name, SUM(r.lines) FILTER (WHERE ${isC}) AS l, SUM(r.qty) FILTER (WHERE ${isC}) AS u,
                   SUM(${VALUE}) FILTER (WHERE ${isC}) AS g, SUM(r.qty) FILTER (WHERE ${isO}) AS ou,
                   COALESCE(BOOL_OR(r.qty > 0) FILTER (WHERE ${isC}), FALSE) AS instock
              ${FROM} WHERE ${s5.where} GROUP BY p.channel, ${SKU}) x
     GROUP BY x.name ORDER BY u DESC, 1`, s5.p);

  // Stock built vs drawn down between the opening and closing snapshot, per
  // partner × barcode position. No snapshot inside the window → no change.
  const s6 = datesScope(q, both);
  const flowQ = O === C ? Promise.resolve({ rows: [] }) : query(`
    SELECT COUNT(*) FILTER (WHERE d.dq > 0)::bigint AS in_n,  COALESCE(SUM(d.dq) FILTER (WHERE d.dq > 0), 0)::bigint AS in_u,
           COALESCE(ROUND(SUM(d.dq * d.mrp) FILTER (WHERE d.dq > 0)), 0)::bigint AS in_g,
           COUNT(*) FILTER (WHERE d.dq < 0)::bigint AS out_n, COALESCE(-SUM(d.dq) FILTER (WHERE d.dq < 0), 0)::bigint AS out_u,
           COALESCE(ROUND(-SUM(d.dq * d.mrp) FILTER (WHERE d.dq < 0)), 0)::bigint AS out_g
      FROM (SELECT SUM(CASE WHEN ${isC} THEN r.qty ELSE -r.qty END) AS dq, COALESCE(MAX(s.mrp), 0) AS mrp
              ${FROM} WHERE ${s6.where} GROUP BY r.partner_id, r.barcode) d`, s6.p);

  const [series, close, partners, cats, genders, seasons, pareto, chans, flow] = await Promise.all([seriesQ, closeQ, partnerQ, catQ, genderQ, seasonQ, paretoQ, chanQ, flowQ]);
  const at = new Map(series.rows.map((x) => [x.d, { u: num(x.u), g: num(x.g), lines: num(x.lines) }]));
  const zero = { u: 0, g: 0, lines: 0 };
  const c = at.get(C) || zero; const o = (O && at.get(O)) || zero;
  const inWin = w.inWin.map((d) => ({ d, ...(at.get(d) || zero) }));
  const years = new Set(w.inWin.map((d) => d.slice(0, 4)));
  const mon = (d) => MON[Number(d.slice(5, 7)) - 1] + (years.size > 1 ? ` ${d.slice(2, 4)}` : '');
  const f = flow.rows[0];
  const y = Y ? (at.get(Y) || zero) : null;

  // Concentration: share of closing stock held by the biggest partners.
  const share = (rows, n, m) => { const t = rows.reduce((a, x) => a + Math.max(num(x[m]), 0), 0); const top = rows.map((x) => Math.max(num(x[m]), 0)).sort((a, b) => b - a).slice(0, n).reduce((a, x) => a + x, 0); return t > 0 ? Number((top / t * 100).toFixed(1)) : null; };
  const lead = partners.rows[0] && num(partners.rows[0].u) > 0 ? partners.rows[0] : null;

  // Season age at the closing date: stock from a season N calendar years back.
  // "ALL SEASON" / "CORE" carry no year and never age.
  const cy = Number(C.slice(0, 4));
  const AGE = [{ key: 'current', label: `Current year (${cy})` }, { key: 'y1', label: `1 year old (${cy - 1})` }, { key: 'y2', label: `2 years old (${cy - 2})` },
    { key: 'y3', label: `3+ years old (${cy - 3} & before)` }, { key: 'core', label: 'All-season / core' }, { key: 'unmatched', label: UNMATCHED }];
  const ageOf = (name) => { if (name === UNMATCHED) return 'unmatched'; const m = /(19|20)\d{2}/.exec(name); if (!m) return 'core'; const a = cy - Number(m[0]); return a <= 0 ? 'current' : a === 1 ? 'y1' : a === 2 ? 'y2' : 'y3'; };
  const age = new Map(AGE.map((a) => [a.key, { ...a, u: 0, g: 0 }]));
  for (const x of seasons.rows) { const a = age.get(ageOf(x.name)); a.u += num(x.u); a.g += num(x.g); }
  const agedPct = (m) => (c[m] > 0 ? Number(((age.get('y2')[m] + age.get('y3')[m]) / c[m] * 100).toFixed(1)) : null);
  const priced = c.u - num(close.rows[0].unmatched_units);

  return {
    from: w.from, to: w.to, empty: false,
    kpis: { lines: c.lines, units: c.u, value: c.g, partner_count: partners.rows.filter((x) => num(x.u) > 0).length,
      channel_count: chans.rows.filter((x) => num(x.u) > 0).length, snapshot_count: w.inWin.length, sku_count: null,
      change_pct_units: pct(c.u, O ? o.u : null), change_pct_value: pct(c.g, O ? o.g : null),
      // Management read-outs (all at the closing snapshot)
      avg_mrp: priced > 0 ? Math.round(c.g / priced) : null,
      top_partner: lead ? lead.name : null, top_partner_pct_units: share(partners.rows, 1, 'u'), top_partner_pct_value: share(partners.rows, 1, 'g'),
      top3_partner_pct_units: share(partners.rows, 3, 'u'), top3_partner_pct_value: share(partners.rows, 3, 'g'),
      aged_pct_units: agedPct('u'), aged_pct_value: agedPct('g'),
      thin_pct: close.rows[0].positions ? Number(((close.rows[0].zero + close.rows[0].low) / close.rows[0].positions * 100).toFixed(1)) : null,
      pareto_half_skus: pareto.rows[0].half, pareto_skus: pareto.rows[0].skus },
    stock: { as_of: C, opening_as_of: O,
      closing_units: c.u, closing_value: c.g, opening_units: o.u, opening_value: o.g,
      change_units: c.u - o.u, change_value: c.g - o.g,
      unmatched_units: num(close.rows[0].unmatched_units), unmatched_barcodes: close.rows[0].unmatched_barcodes,
      avg_units: inWin.length ? Math.round(inWin.reduce((a, x) => a + x.u, 0) / inWin.length) : null,
      avg_value: inWin.length ? Math.round(inWin.reduce((a, x) => a + x.g, 0) / inWin.length) : null,
      data_from: st.snaps[0], data_to: st.snaps[st.snaps.length - 1],
      yoy: y ? { as_of: Y, units: y.u, value: y.g, pct_units: pct(c.u, y.u), pct_value: pct(c.g, y.g) } : null },
    daily: inWin.map((x) => ({ d: x.d, g: x.g, u: x.u })),
    // Change vs the snapshot before; the very first snapshot has no baseline.
    monthly: inWin.map((x, i) => ({ x, prev: i ? inWin[i - 1] : (O ? o : null) })).filter((y) => y.prev)
      .map(({ x, prev }) => ({ mon: mon(x.d), d: x.d, net: x.g - prev.g, net_u: x.u - prev.u })),
    flow: f ? [{ dir: 'Inbound', txns: num(f.in_n), g: num(f.in_g), u: num(f.in_u) },
               { dir: 'Outbound', txns: num(f.out_n), g: num(f.out_g), u: num(f.out_u) }].filter((x) => x.txns > 0) : [],
    top_partners: partners.rows.map((x) => ({ key: x.key, name: x.name, channel: x.channel, g: num(x.g), u: num(x.u) })),
    top_cat: cats.rows.map((x) => ({ name: x.name, g: num(x.g), u: num(x.u) })),
    top_gender: genders.rows.map((x) => ({ name: x.name, g: num(x.g), u: num(x.u) })),
    top_season: seasons.rows.map((x) => ({ name: x.name, g: num(x.g), u: num(x.u) })),
    season_age: [...age.values()].filter((a) => a.u !== 0 || a.g !== 0),
    channels: chans.rows.map((x) => ({ name: x.name, partners: partners.rows.filter((y) => y.channel === x.name && num(y.u) > 0).length, skus: x.skus, lines: num(x.lines), u: num(x.u), g: num(x.g),
      change_u: O && O !== C ? num(x.u) - num(x.ou) : null })),
    // Partner × barcode positions at the closing snapshot, by quantity on hand.
    health: { positions: close.rows[0].positions, in_stock: close.rows[0].in_stock, zero: close.rows[0].zero, low: close.rows[0].low,
      negative: close.rows[0].negative, negative_units: num(close.rows[0].negative_units) },
  };
}
async function getOverview(req, res, next) {
  try { res.json({ success: true, data: await cached('overview', req, (st) => buildOverview(req.query, st)) }); } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /sku-count — distinct item-master SKUs in stock at the closing snapshot
// ════════════════════════════════════════════════════════════════════════════
async function getSkuCount(req, res, next) {
  try {
    const data = await cached('skucount', req, async (st) => {
      const w = windowOf(st.snaps, req.query);
      if (!w.closing) return { from: w.from, to: w.to, sku_count: 0 };
      const s = datesScope(req.query, [w.closing]);
      const r = await query(`SELECT COUNT(DISTINCT s.sku)::int AS n ${FROM} WHERE ${s.where} AND r.qty > 0 AND s.barcode IS NOT NULL`, s.p);
      return { from: w.from, to: w.to, sku_count: r.rows[0].n };
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /pivot — closing stock by dimension, with change vs the opening snapshot
// ════════════════════════════════════════════════════════════════════════════
async function buildPivot(q, st) {
  const groupBy = normalizeGroupBy(q.group_by || 'partner');
  const dim = GROUP_DIMS[groupBy];
  if (!dim) { const e = new Error(`invalid group_by: ${q.group_by}`); e.status = 400; throw e; }
  const measure = measureOf(q.measure);
  const w = windowOf(st.snaps, q);
  const out = { group_by: groupBy, measure, from: w.from, to: w.to, as_of: w.closing, opening_as_of: w.opening, rows: [], totals: null };
  if (!w.closing) return out;
  const C = w.closing; const O = w.opening;
  const isC = `r.snapshot_date = '${C}'::date`;
  const s = datesScope(q, O && O !== C ? [O, C] : [C]);
  // Two-level (member × barcode, then member): distinct barcodes by hashing,
  // not by a 50k-row text sort.
  const res = await query(`
    SELECT x.key, MAX(x.label) AS label,
           COALESCE(SUM(x.qty), 0)::bigint AS qty, COALESCE(ROUND(SUM(x.value)), 0)::bigint AS value,
           COALESCE(SUM(x.lines), 0)::bigint AS lines, COUNT(*) FILTER (WHERE x.instock)::int AS skus,
           COALESCE(SUM(x.qty) FILTER (WHERE x.matched), 0)::bigint AS priced_qty, COALESCE(SUM(x.prev_qty), 0)::bigint AS prev_qty
      FROM (SELECT ${dim.key} AS key, MAX(${dim.label}) AS label,
                   SUM(r.qty) FILTER (WHERE ${isC}) AS qty, SUM(${VALUE}) FILTER (WHERE ${isC}) AS value,
                   SUM(r.lines) FILTER (WHERE ${isC}) AS lines, SUM(r.qty) FILTER (WHERE NOT ${isC}) AS prev_qty,
                   COALESCE(BOOL_OR(r.qty > 0) FILTER (WHERE ${isC}), FALSE) AS instock, BOOL_OR(s.barcode IS NOT NULL) AS matched
              ${FROM} WHERE ${s.where} GROUP BY ${dim.key}, ${SKU}) x
     GROUP BY x.key`, s.p);
  const by = measure === 'units' ? 'qty' : 'value';
  out.rows = res.rows.map((x) => {
    const qty = num(x.qty); const value = num(x.value); const priced = num(x.priced_qty);
    return { key: x.key, label: x.label, qty, value, lines: num(x.lines), skus: x.skus,
      avg_price: priced !== 0 ? Math.round(value / priced) : null,       // ₹ per unit, over units that have an MRP
      // No snapshot inside the window (opening = closing) → nothing to compare.
      delta_qty_vs_prev_pct: O && O !== C ? pct(qty, num(x.prev_qty)) : null };
  }).sort((a, b) => Math.abs(b[by]) - Math.abs(a[by]) || String(a.label).localeCompare(String(b.label)));
  if (out.rows.length) {
    out.totals = { qty: out.rows.reduce((a, x) => a + x.qty, 0), value: out.rows.reduce((a, x) => a + x.value, 0),
      lines: out.rows.reduce((a, x) => a + x.lines, 0) };
  }
  return out;
}
async function getPivot(req, res, next) {
  try {
    res.json({ success: true, data: await cached('pivot', req, (st) => buildPivot(req.query, st)) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /trend — stock per snapshot for the top-N members of a dimension
// ════════════════════════════════════════════════════════════════════════════
async function getTrend(req, res, next) {
  try {
    const groupBy = normalizeGroupBy(req.query.group_by || 'partner');
    const dim = GROUP_DIMS[groupBy];
    if (!dim) return res.status(400).json({ success: false, error: `invalid group_by: ${req.query.group_by}` });
    const measure = measureOf(req.query.measure);
    const top = Math.min(Math.max(parseInt(req.query.top, 10) || 8, 1), 20);
    const data = await cached('trend', req, async (st) => {
      const w = windowOf(st.snaps, req.query);
      const out = { from: w.from, to: w.to, group_by: groupBy, measure, dates: w.inWin, series: [] };
      if (!w.inWin.length) return out;
      const M = `SUM(${MEASURE_EXPR[measure]})`;
      // Rank on the closing snapshot — the members that matter now.
      const s1 = datesScope(req.query, [w.closing]);
      const members = (await query(`SELECT ${dim.key} AS k, MAX(${dim.label}) AS label
        ${FROM} WHERE ${s1.where} GROUP BY ${dim.key} ORDER BY ABS(${M}) DESC, 1 LIMIT ${top}`, s1.p)).rows;
      if (!members.length) return out;
      const s2 = datesScope(req.query, w.inWin);
      const kIdx = s2.p.push(members.map((m) => m.k));
      const rows = (await query(`SELECT r.snapshot_date::text AS date, ${dim.key} AS k, ROUND(${M})::bigint AS v
        ${FROM} WHERE ${s2.where} AND ${dim.key} = ANY($${kIdx}::text[]) GROUP BY r.snapshot_date, ${dim.key}`, s2.p)).rows;
      const byKey = new Map(members.map((m) => [m.k, new Map()]));
      for (const x of rows) byKey.get(x.k)?.set(x.date, num(x.v));
      out.series = members.map((m) => ({ key: m.k, label: m.label, points: w.inWin.map((d) => ({ date: d, value: byKey.get(m.k).get(d) ?? 0 })) }));
      return out;
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /items — every barcode in stock at the closing snapshot (paged, searchable)
// ════════════════════════════════════════════════════════════════════════════
const ITEM_SORT = { units: 'units', value: 'value', mrp: 'mrp', partners: 'partners', barcode: 'r.barcode' };
async function getItems(req, res, next) {
  try {
    const data = await cached('items', req, async (st) => {
      const q = req.query;
      const w = windowOf(st.snaps, q);
      const page = Math.max(parseInt(q.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 100);
      const out = { as_of: w.closing, page, limit, total: 0, rows: [] };
      if (!w.closing) return out;
      const s = datesScope(q, [w.closing]);
      let where = s.where;
      const search = String(q.search || '').trim();
      if (search) {
        s.p.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
        where += ` AND (r.barcode ILIKE $${s.p.length} OR s.style ILIKE $${s.p.length} OR s.product ILIKE $${s.p.length} OR s.color_name ILIKE $${s.p.length})`;
      }
      const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const li = s.p.push(limit); const oi = s.p.push((page - 1) * limit);
      const r = await query(`
        SELECT r.barcode, MAX(s.style) AS style, MAX(s.product) AS product, MAX(s.category_norm) AS category, MAX(s.gender_name) AS gender,
               MAX(s.color_name) AS colour, MAX(s.size) AS size, MAX(s.season) AS season, MAX(s.mrp) AS mrp, BOOL_OR(s.barcode IS NOT NULL) AS matched,
               SUM(r.qty)::bigint AS units, ROUND(SUM(${VALUE}))::bigint AS value, COUNT(*) FILTER (WHERE r.qty > 0)::int AS partners,
               COUNT(*) OVER ()::int AS total
          ${FROM} WHERE ${where} GROUP BY r.barcode
         ORDER BY ${ITEM_SORT[q.sort] || 'units'} ${dir} NULLS LAST, r.barcode LIMIT $${li} OFFSET $${oi}`, s.p);
      out.total = r.rows[0]?.total || 0;
      out.rows = r.rows.map((x) => ({ barcode: x.barcode, matched: x.matched, style: x.style, product: x.product, category: x.category, gender: x.gender,
        colour: x.colour, size: x.size, season: x.season, mrp: x.mrp == null ? null : Number(x.mrp), units: num(x.units), value: num(x.value), partners: x.partners }));
      return out;
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /item — everything the files say about ONE barcode (the SKU detail panel)
// ════════════════════════════════════════════════════════════════════════════
// Whole-partner view on purpose: the Lens filters do not apply, only the as-on
// window. `history` covers every stock file (0 where the barcode is absent);
// `sizes` is the size run of the same style + colour at the closing snapshot.
const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];
const sizeRank = (s) => { const n = parseFloat(s); if (!Number.isNaN(n)) return [0, n]; const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i >= 0 ? [1, i] : [2, 0]; };
async function getItem(req, res, next) {
  try {
    const data = await cached('item', req, async (st) => {
      const barcode = String(req.query.barcode ?? '');
      const w = windowOf(st.snaps, req.query);
      const C = w.closing; const O = w.opening && w.opening !== C ? w.opening : null;
      const rows = (await query(`SELECT r.snapshot_date::text AS d, p.name, p.channel, r.qty, r.lines ${FROM} WHERE r.barcode = $1`, [barcode])).rows;
      if (!rows.length) return null;
      const it = (await query(`SELECT sku, mrp, style, product, sub_product, category_norm AS category, gender_name AS gender,
                                      color_name AS colour, size, season FROM esales_items WHERE barcode = $1`, [barcode])).rows[0] || null;
      const mrp = it ? Number(it.mrp) : null;
      const byDate = new Map();
      for (const x of rows) byDate.set(x.d, (byDate.get(x.d) || 0) + x.qty);
      const partners = new Map();
      for (const x of rows) {
        if (x.d !== C && x.d !== O) continue;
        let e = partners.get(x.name); if (!e) partners.set(x.name, (e = { name: x.name, channel: x.channel, units: 0, lines: 0, opening_units: 0 }));
        if (x.d === C) { e.units += x.qty; e.lines += x.lines; } else e.opening_units += x.qty;
      }
      const units = C ? byDate.get(C) || 0 : 0; const opening = O ? byDate.get(O) || 0 : 0;
      const history = st.snaps.map((d) => ({ d, u: byDate.get(d) || 0 }));
      const seen = history.filter((h) => byDate.has(h.d));
      const peak = seen.reduce((a, h) => (h.u > a.u ? h : a), seen[0]);
      let sizes = [];
      if (it && it.style && C) {
        sizes = (await query(`SELECT s.size, SUM(r.qty)::int AS units, COUNT(DISTINCT p.id) FILTER (WHERE r.qty > 0)::int AS partners
          ${FROM} WHERE r.snapshot_date = $1::date AND s.style = $2 AND s.color_name = $3 GROUP BY s.size`, [C, it.style, it.colour])).rows
          .sort((a, b) => { const [ga, va] = sizeRank(a.size); const [gb, vb] = sizeRank(b.size); return ga - gb || va - vb || String(a.size).localeCompare(String(b.size)); });
      }
      return {
        item: { barcode, matched: Boolean(it), sku: it ? it.sku : null, mrp, style: it?.style || null, product: it?.product || null, sub_product: it?.sub_product || null,
          category: it?.category || null, gender: it?.gender || null, colour: it?.colour || null, size: it?.size || null, season: it?.season || null },
        as_of: C, opening_as_of: O,
        units, value: mrp == null ? null : Math.round(units * mrp), opening_units: opening, change_units: O ? units - opening : null,
        partners: [...partners.values()].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)),
        history, first_seen: seen[0].d, last_seen: seen[seen.length - 1].d, peak: { d: peak.d, u: peak.u },
        sizes,
      };
    });
    if (!data) return res.status(404).json({ success: false, error: 'barcode not found in the ESales stock files' });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// Filter lists + data range
// ════════════════════════════════════════════════════════════════════════════
async function getPartners(req, res, next) {
  try {
    const data = await cached('partners', { query: {} }, async () =>
      (await query('SELECT id::text AS id, name, channel FROM esales_partners ORDER BY name')).rows);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}
async function getChannels(req, res, next) {
  try {
    const data = await cached('channels', { query: {} }, async () =>
      (await query('SELECT channel, COUNT(*)::int AS partners FROM esales_partners GROUP BY channel ORDER BY channel')).rows);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}
// Sidebar Lens options — ONLY values that exist on ESales stock (the global
// lists carry 13k styles and seasons this feed never held), and DYNAMIC: every
// list is narrowed by the other selected filters, never by its own —
//   • a SKU list by the other SKU filters and by the Channel / Partner picked
//     (only what those partners have ever held);
//   • Channel and Partner by the SKU filters (only partners that hold such
//     stock); Partner also by the Channel picked.
// Lists span all stock files, so a selection survives changing the as-on date.
const LENS = { gender: 's.gender_name', category: 's.category_norm', product: 's.product', sub_product: 's.sub_product',
  size: 's.size', color: 's.color_name', season: 's.season' };
const partnerOnly = (q) => ({ partner: q.partner, partner_name: q.partner_name, channel: q.channel });
const skuOnly = (q) => ({ ...q, partner: undefined, partner_name: undefined, channel: undefined });
async function getFilterOptions(req, res, next) {
  try {
    const data = await cached('filteropts', req, async () => {
      const q = req.query; const out = {};
      const skuLists = Object.entries(LENS).map(async ([dim, col]) => {
        const others = { ...q, [dim]: undefined, ...(dim === 'color' ? { colour: undefined } : {}) };
        const p = [];
        const conds = [`NULLIF(${col}, '') IS NOT NULL`, ...buildScope(skuOnly(others), p)];
        const held = buildScope(partnerOnly(q), p);
        if (held.length) conds.push(`s.barcode IN (SELECT r.barcode FROM esales_stock r JOIN esales_partners p ON p.id = r.partner_id WHERE ${held.join(' AND ')})`);
        out[dim] = (await query(`SELECT DISTINCT ${col} AS v FROM esales_items s WHERE ${conds.join(' AND ')} ORDER BY 1`, p)).rows.map((x) => x.v);
      });
      const p2 = [];
      const sku = buildScope(skuOnly(q), p2);
      const partnersQ = query(sku.length
        ? `SELECT DISTINCT p.name, p.channel FROM esales_stock r JOIN esales_partners p ON p.id = r.partner_id JOIN esales_items s ON s.barcode = r.barcode WHERE ${sku.join(' AND ')}`
        : 'SELECT name, channel FROM esales_partners', p2);
      const [ps] = await Promise.all([partnersQ, ...skuLists]);
      const chans = String(q.channel || '').split(',').map((x) => x.trim()).filter(Boolean);
      out.channel = [...new Set(ps.rows.map((x) => x.channel))].sort();
      out.partner_name = ps.rows.filter((x) => !chans.length || chans.includes(x.channel)).map((x) => x.name).sort();
      return out;
    });
    res.json({ success: true, options: data });
  } catch (err) { next(err); }
}

async function getRange(req, res, next) {
  try {
    const { snaps } = await ensureState();
    res.json({ success: true, data: { from: snaps[0] || null, to: snaps[snaps.length - 1] || null, snapshots: snaps } });
  } catch (err) { next(err); }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /export.csv — same filters as /pivot
// ════════════════════════════════════════════════════════════════════════════
async function exportCsv(req, res, next) {
  try {
    const pivot = await buildPivot(req.query, await ensureState());
    const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="esales-stock-${pivot.group_by}-${pivot.as_of || 'none'}.csv"`);
    res.write('member,units,value_mrp,skus,lines,avg_mrp,delta_units_vs_opening_pct\n');
    for (const x of pivot.rows) {
      res.write([x.label, x.qty, x.value, x.skus, x.lines, x.avg_price, x.delta_qty_vs_prev_pct].map(esc).join(',') + '\n');
    }
    res.end();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    next(err);
  }
}

module.exports = { getOverview, getSkuCount, getPivot, getTrend, getItems, getItem, getFilterOptions, getPartners, getChannels, getRange, exportCsv,
  UNMATCHED, buildOverview, buildPivot, windowOf };
