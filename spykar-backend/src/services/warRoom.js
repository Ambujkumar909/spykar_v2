// ─── warRoom.js — the War Room board (migration 036) ─────────────────────────
// One call returns EVERY store with every number the page shows, for one
// as-on date D — strictly from the ERP data in the database:
//
//   cw    this week so far        Monday of D's week … D
//   pw    previous week, same days (cw − 7)       pwly  its last-year twin
//   ly    same week last year      (cw − 364 days, so weekdays line up)
//   mtd / mtdly   1st of D's month … D        vs the same dates a year earlier
//   ytd / ytdly   1 April (FY start) … D      vs the same dates a year earlier
//
// per store: net units, net sale value (₹), net MRP value (₹), bills; 13
// weeks of net value with last year's matching weeks; net value per day of
// the month (TY and LY); units / value by category per period; closing stock
// by category on D and a year earlier. (ASM notes come from GET /notes.)
//
// The page filters and aggregates this in the browser, so every store-side
// filter is instant. A PRODUCT filter (gender / category / product) changes
// the numbers themselves, so it is applied here: measures then come from
// wr_cat_day, and bills are null (a bill is not split by product).
//
// Sources: srd_store (units / value / MRP — the rollup every sales page
// reads), wr_store_day (bills), wr_cat_day (categories, product filter),
// wr_stock_cat ← inventory_daily_snapshot (closing stock), locations / zones,
// wr_notes (the only thing the page writes).
// ─────────────────────────────────────────────────────────────────────────────

const { query, transaction } = require('../config/database');
const engine = require('./wrEngine');

// ── dates (ISO 'YYYY-MM-DD', UTC arithmetic — no timezone drift) ─────────────
const toD = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const minusYear = (s) => {   // same calendar date a year earlier (29 Feb → 28 Feb)
  const d = toD(s); const y = d.getUTCFullYear() - 1; const m = d.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
};
const mondayOf = (s) => { const d = toD(s); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const d = toD(monthStart(s)); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); };
const fyStart = (s) => { const d = toD(s); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-04-01`; };
const WEEKS = 13;

function periodsFor(D) {
  const ws = mondayOf(D);
  const P = {
    cw: [ws, D],
    pw: [addDays(ws, -7), addDays(D, -7)],
    ly: [addDays(ws, -364), addDays(D, -364)],
    pwly: [addDays(ws, -371), addDays(D, -371)],
    mtd: [monthStart(D), D],
    ytd: [fyStart(D), D],
  };
  P.mtdly = [minusYear(P.mtd[0]), minusYear(D)];
  P.ytdly = [minusYear(P.ytd[0]), minusYear(D)];
  const weeks = [];   // oldest → newest; the last one is the current (partial) week
  for (let k = WEEKS - 1; k >= 0; k--) {
    const a = addDays(ws, -7 * k); const b = k === 0 ? D : addDays(a, 6);
    weeks.push({ ty: [a, b], ly: [addDays(a, -364), addDays(b, -364)] });
  }
  return { D, weekStart: ws, P, weeks };
}

// ── categories: the workbook's six men's lines, then the rest of the range ──
const CORE = {
  'JEANS': 'Jeans', 'EP JEANS': 'Jeans',
  'SHIRTS': 'Shirts', 'EP SHIRTS': 'Shirts',
  'T-SHIRTS': 'T-Shirts', 'EP T-SHIRTS': 'T-Shirts', 'T-SHIRT- ALBERT': 'T-Shirts', 'T-SHIRT - CC': 'T-Shirts',
  'TROUSERS': 'Non-Denim', 'EP TROUSERS': 'Non-Denim',
  'JACKETS': 'Winter Wear', 'EP JACKETS': 'Winter Wear', 'SWEATER': 'Winter Wear', 'SWEATSHIRT': 'Winter Wear',
  'SHORTS': 'Shorts', 'EP SHORTS': 'Shorts',
};
const CATS = ['Jeans', 'Shirts', 'T-Shirts', 'Non-Denim', 'Winter Wear', 'Shorts', 'Other Men', 'Women', 'Underjeans', 'Accessories', 'Grooming', 'Other'];
function catOf(gender, category, product) {
  const c = (category || '').toUpperCase();
  if (c === 'UNDERJEANS' || c === 'INNERWEAR') return 'Underjeans';
  if (c === 'ACCESSORIES') return 'Accessories';
  if (c === 'GROOMING') return 'Grooming';
  const g = (gender || '').toUpperCase();
  if (g === 'WOMENS') return 'Women';
  if (g === 'MENS') return CORE[(product || '').toUpperCase()] || 'Other Men';
  return 'Other';
}

// ── product scope (applied server-side; it changes the numbers) ─────────────
// light — gender / category / product: read from the wr_cat_day rollup.
// deep  — any of sub-product / size / colour / season as well: those are not in
//         a rollup, so the matching sale lines (and stock rows) are pulled into
//         a temporary table shaped like wr_cat_day / wr_stock_cat, inside one
//         transaction, and the same queries run on it — same rules, same numbers.
const listOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const PRODUCT_NORM = "regexp_replace(COALESCE(s.product, ''), '\\s*[<>].*$', '')";
const DIMS = [   // [query key, wr_cat_day column, skus expression]
  ['gender', 'gender', "COALESCE(s.gender_name, '')"], ['category', 'category', "COALESCE(s.category_norm, '')"], ['product', 'product', PRODUCT_NORM],
  ['sub_product', null, 's.sub_product'], ['size', null, 's.size'], ['color', null, 's.color_name'], ['season', null, 's.season'],
];
function productScope(q) {
  const picked = DIMS.map(([k, col, expr]) => ({ k, col, expr, v: listOf(q[k]) })).filter((d) => d.v.length);
  const params = picked.map((d) => d.v);
  return {
    active: picked.length > 0,
    deep: picked.some((d) => !d.col),
    params,
    colConds: picked.map((d, i) => `${d.col} = ANY($${i + 1}::text[])`),      // on wr_cat_day / wr_stock_cat (light only)
    skuConds: picked.map((d, i) => `${d.expr} = ANY($${i + 1}::text[])`),     // on skus s (deep)
  };
}
const shift = (sqlConds, by) => sqlConds.map((c) => c.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + by}`));

// SUM … FILTER for every window, in one pass over the date range.
function windowCols(windows, exprs) {
  const cols = []; const params = [];
  for (const [name, [a, b]] of windows) {
    params.push(a, b); const i = params.length - 1;
    for (const [suffix, e] of exprs) cols.push(`COALESCE(SUM(${e}) FILTER (WHERE x.d BETWEEN $${i}::date AND $${i + 1}::date), 0) AS "${name}${suffix}"`);
  }
  return { cols: cols.join(',\n  '), params };
}

// ── per-sync memo: things that only change when a sync lands ────────────────
// (store list, date range, stock-date checks) — keyed by the last sync's
// completion time, so a new sync invalidates them automatically.
const memo = { mark: null, map: new Map() };
async function once(key, fn) {
  const { rows: [r] } = await query(`SELECT MAX(completed_at) AS at FROM sync_logs WHERE status IN ('SUCCESS', 'FAILED')`);
  const mark = r.at ? new Date(r.at).getTime() : 0;
  if (memo.mark !== mark) { memo.mark = mark; memo.map = new Map(); }
  if (!memo.map.has(key)) memo.map.set(key, Promise.resolve(fn()).catch((e) => { memo.map.delete(key); throw e; }));
  return memo.map.get(key);
}

// ── closing stock by store × product for one day (materialised on demand) ────
async function ensureStock(date) {
  const { rows: [src] } = await query('SELECT COUNT(*)::bigint AS n FROM inventory_daily_snapshot WHERE snapshot_date = $1', [date]);
  const n = Number(src.n);
  const { rows: [have] } = await query('SELECT source_rows FROM wr_stock_dates WHERE snapshot_date = $1', [date]);
  if (have && Number(have.source_rows) === n) return n > 0;
  await transaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wr_stock:${date}`]);
    const { rows: [again] } = await c.query('SELECT source_rows FROM wr_stock_dates WHERE snapshot_date = $1', [date]);
    if (again && Number(again.source_rows) === n) return;
    await c.query('DELETE FROM wr_stock_cat WHERE snapshot_date = $1', [date]);
    await c.query(`
      INSERT INTO wr_stock_cat (snapshot_date, location_id, gender, category, product, qty, mrp)
      SELECT d.snapshot_date, d.location_id, COALESCE(s.gender_name, ''), COALESCE(s.category_norm, ''),
             regexp_replace(COALESCE(s.product, ''), '\\s*[<>].*$', ''),
             SUM(d.qty_on_hand)::int, SUM(d.qty_on_hand::numeric * COALESCE(s.mrp, 0))
      FROM inventory_daily_snapshot d JOIN skus s ON s.id = d.sku_id
      WHERE d.snapshot_date = $1 AND d.qty_on_hand <> 0
      GROUP BY 1, 2, 3, 4, 5`, [date]);
    await c.query(`INSERT INTO wr_stock_dates (snapshot_date, source_rows, built_at) VALUES ($1, $2, NOW())
      ON CONFLICT (snapshot_date) DO UPDATE SET source_rows = EXCLUDED.source_rows, built_at = NOW()`, [date, n]);
  });
  return n > 0;
}
// The snapshot for D, or the latest one in the 7 days before it (snapshots can lag a day).
async function stockDateFor(date) {
  const { rows } = await query(`SELECT MAX(snapshot_date)::text AS d FROM inventory_daily_snapshot
    WHERE snapshot_date BETWEEN $1::date - 7 AND $1::date`, [date]);
  return rows[0].d || null;
}

// ── store type, from what the database knows ────────────────────────────────
// Closed = the store's shop_closed flag; otherwise by its first sale day:
// New = first sale this financial year; Annualised = during last financial
// year (part of its LY is missing); L2L = trading before last financial year.
function storeType(st, P) {
  if (st.closed) return 'Closed';
  if (!st.first || st.first > P.ytd[0]) return 'New';
  if (st.first > P.ytdly[0]) return 'Annualised';
  return 'L2L';
}
const regionOf = (zone) => (zone ? zone.replace(/\s+India$/i, '') : '—');
const title = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;   // headline measures: to the paisa
const r0 = (n) => Math.round(Number(n || 0));                // chart series: whole rupees

// ── the board ────────────────────────────────────────────────────────────────
async function buildBoard(q) {
  const scope = productScope(q);
  const e = await engine.current();
  if (e) return boardFromEngine(q, scope, e);                  // in memory: any filter, one pass
  if (!scope.deep) return boardWith(q, scope, query);
  // deep product filter without the engine: stage the matching rows in temp tables, then the same board
  return transaction(async (c) => boardWith(q, scope, c.query.bind(c), c));
}

// ── targets (migration 037): day-wise store targets → per store and window ──
// to date: cw (week so far), pw (previous week, same days), mtd, ytd;
// whole: week (Mon–Sun), month, fy. Each [units, ₹]. Cached per as-on date
// and per target load, so a new target file shows as soon as it is loaded.
const tgCache = new Map();
async function targetsFor(D, P) {
  const { rows: [ld] } = await query(`SELECT id, files, loaded_at, date_from::text AS "from", date_to::text AS "to", stores
    FROM wr_target_loads ORDER BY id DESC LIMIT 1`);
  if (!ld) return null;
  const key = `${D}|${ld.id}`;
  if (tgCache.has(key)) return tgCache.get(key);
  const fyEnd = `${Number(P.ytd[0].slice(0, 4)) + 1}-03-31`;
  const W = { cw: P.cw, pw: P.pw, mtd: P.mtd, ytd: P.ytd, week: [P.cw[0], addDays(P.cw[0], 6)], month: [P.mtd[0], monthEnd(D)], fy: [P.ytd[0], fyEnd] };
  const params = []; const cols = [];
  for (const [k, [a, b]] of Object.entries(W)) {
    params.push(a, b); const i = params.length - 1;
    cols.push(`SUM(qty) FILTER (WHERE target_date BETWEEN $${i}::date AND $${i + 1}::date)::float AS "${k}_q"`,
      `SUM(val) FILTER (WHERE target_date BETWEEN $${i}::date AND $${i + 1}::date)::float AS "${k}_v"`);
  }
  const lo = [P.pw[0], P.ytd[0]].sort()[0]; const hi = [fyEnd, monthEnd(D), addDays(P.cw[0], 6)].sort().pop();
  const { rows } = await query(`SELECT external_id, ${cols.join(', ')} FROM wr_targets
    WHERE target_date BETWEEN $${params.length + 1}::date AND $${params.length + 2}::date GROUP BY 1`, [...params, lo, hi]);
  const map = {};
  for (const r of rows) {
    const t = {}; let any = false;
    for (const k of Object.keys(W)) { const q = r[`${k}_q`]; const v = r[`${k}_v`]; t[k] = q == null && v == null ? null : [Math.round(q || 0), Math.round(v || 0)]; if (t[k]) any = true; }
    if (any) map[r.external_id] = t;
  }
  const out = { map, info: { file: ld.files, loadedAt: ld.loaded_at, from: ld.from, to: ld.to, stores: ld.stores } };
  tgCache.set(key, out); if (tgCache.size > 60) tgCache.delete(tgCache.keys().next().value);
  return out;
}

// Shared by both paths: dates, stock dates (rollup materialised), store list.
async function frame(q) {
  const meta = await getMeta();
  const D = q.as_on && q.as_on <= meta.to ? q.as_on : meta.to;
  if (!D) return { meta, D: null };
  const { weekStart, P, weeks } = periodsFor(D);
  const [tyStock, lyStock] = await Promise.all([once(`sd:${D}`, () => stockDateFor(D)), once(`sd:${minusYear(D)}`, () => stockDateFor(minusYear(D)))]);
  const [tyOk, lyOk] = await Promise.all([tyStock ? once(`st:${tyStock}`, () => ensureStock(tyStock)) : false, lyStock ? once(`st:${lyStock}`, () => ensureStock(lyStock)) : false]);
  return { meta, D, weekStart, P, weeks, windows: Object.entries(P), tyStock, lyStock, tyOk, lyOk, stockDates: [tyOk && tyStock, lyOk && lyStock].filter(Boolean) };
}
const CAT_P = ['ytd', 'ytdly', 'mtd', 'mtdly', 'cw', 'ly'];

async function boardFromEngine(q, scope, e) {
  const F = await frame(q);
  if (!F.D) return { meta: F.meta, periods: null, stores: [] };
  const { D, P, weeks, windows } = F;
  const sel = Object.fromEntries(DIMS.map(([k]) => [k, listOf(q[k])]));
  // stock: the rollup (no / light product filter); SKU-level rows in memory for a deep filter
  const stockQ = scope.deep
    ? null
    : query(`SELECT snapshot_date::text AS d, location_id, gender, category, product, qty, mrp FROM wr_stock_cat
             WHERE snapshot_date = ANY($1::date[]) ${scope.active ? `AND ${shift(scope.colConds, 1).join(' AND ')}` : ''}`, [F.stockDates, ...scope.params]);
  const [stores, stockRows, stockTy, stockLy] = await Promise.all([
    storeList(),
    stockQ || { rows: [] },
    scope.deep && F.stockDates.includes(F.tyStock) ? engine.stockFor(e, F.tyStock, sel, CATS.length) : null,
    scope.deep && F.stockDates.includes(F.lyStock) ? engine.stockFor(e, F.lyStock, sel, CATS.length) : null,
  ]);
  const R = engine.compute(e, { windows, weeks, mtd: P.mtd, mtdly: P.mtdly, catPeriods: CAT_P, nCats: CATS.length }, sel);
  const { acc, seen, stride, oWk, oD, oC, nW, nWk, nD, nC } = R;
  const S = {}; const DY = {}; const C = {}; const B = {};
  e.locs.forEach((id, li) => {
    if (!seen[li]) return;
    const o = li * stride; const row = {};
    windows.forEach(([k], w) => { row[`${k}_q`] = acc[o + w * 4]; row[`${k}_v`] = acc[o + w * 4 + 1] / 100; row[`${k}_m`] = acc[o + w * 4 + 2] / 100; B[id] = B[id] || {}; B[id][k] = acc[o + w * 4 + 3]; });
    for (let i = 0; i < nWk; i++) { row[`w${i}`] = acc[o + oWk + 2 * i] / 100; row[`l${i}`] = acc[o + oWk + 2 * i + 1] / 100; }
    S[id] = row;
    const ty = []; const ly = []; for (let i = 0; i < nD; i++) { ty.push(acc[o + oD + 2 * i] / 100); ly.push(acc[o + oD + 2 * i + 1] / 100); }
    DY[id] = [ty, ly];
    const cm = {};
    CATS.forEach((c, ci) => {
      const a = new Array(12).fill(0); let any = false;
      for (let k = 0; k < nC; k++) { const j = o + oC + (ci * nC + k) * 2; a[k] = acc[j]; a[6 + k] = acc[j + 1] / 100; if (acc[j] || acc[j + 1]) any = true; }
      if (any) cm[c] = a;
    });
    C[id] = cm;
  });
  let K = {};
  if (scope.deep) {
    for (const [t, ly] of [[stockTy, 0], [stockLy, 1]]) if (t) for (const [li, a] of t) {
      const m = (K[e.locs[li]] ||= {});
      CATS.forEach((c, ci) => { if (a[ci * 2] || a[ci * 2 + 1]) { const x = (m[c] ||= [0, 0, 0, 0]); x[ly] += a[ci * 2]; x[2 + ly] += a[ci * 2 + 1]; } });
    }
  } else K = stockByCat(stockRows.rows, F.lyStock);
  const TG = scope.active ? null : await targetsFor(F.D, F.P);     // targets are per store, not per product
  return assemble(F, scope, stores, S, B, DY, C, K, 'engine', TG);
}

async function boardWith(q, scope, run, client) {
  const meta = await getMeta();
  const D = q.as_on && q.as_on <= meta.to ? q.as_on : meta.to;
  if (!D) return { meta, periods: null, stores: [] };
  const { weekStart, P, weeks } = periodsFor(D);
  const windows = Object.entries(P);
  const wkWindows = weeks.flatMap((w, i) => [[`w${i}`, w.ty], [`l${i}`, w.ly]]);
  const lo = [P.ytdly[0], P.pwly[0], weeks[0].ly[0]].sort()[0];

  // units / value / MRP per store per window (+ the weekly value series)
  const [tyStock, lyStock] = await Promise.all([once(`sd:${D}`, () => stockDateFor(D)), once(`sd:${minusYear(D)}`, () => stockDateFor(minusYear(D)))]);
  const [tyOk, lyOk] = await Promise.all([tyStock ? once(`st:${tyStock}`, () => ensureStock(tyStock)) : false, lyStock ? once(`st:${lyStock}`, () => ensureStock(lyStock)) : false]);
  const stockDates = [tyOk && tyStock, lyOk && lyStock].filter(Boolean);

  let catTable = 'wr_cat_day'; const stockTable = 'wr_stock_cat'; let conds = scope.active ? scope.colConds : [];
  if (scope.deep) {
    await run(`CREATE TEMP TABLE wr_x ON COMMIT DROP AS
      SELECT m.moved_at::date AS sale_date, m.location_id, COALESCE(s.gender_name, '') AS gender, COALESCE(s.category_norm, '') AS category,
             ${PRODUCT_NORM} AS product,
             SUM(CASE WHEN m.movement_type = 'SALE' THEN ABS(m.qty_change) ELSE -ABS(m.qty_change) END)::int AS qty,
             SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * COALESCE(m.sale_value, 0)) AS val,
             SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * ABS(m.qty_change)::numeric * COALESCE(s.mrp, 0)) AS mrp
      FROM inventory_movements m JOIN skus s ON s.id = m.sku_id JOIN locations l ON l.id = m.location_id
      WHERE m.movement_type IN ('SALE', 'RETURN') AND l.is_active = true AND s.is_active = true
        AND m.moved_at >= $${scope.params.length + 1}::date AND m.moved_at < $${scope.params.length + 2}::date + interval '1 day'
        AND ${scope.skuConds.join(' AND ')}
      GROUP BY 1, 2, 3, 4, 5`, [...scope.params, [P.ytdly[0], P.pwly[0], weeks[0].ly[0]].sort()[0], D]);
    await run('ANALYZE wr_x');
    catTable = 'wr_x'; conds = [];
  }
  const params = scope.deep ? [] : scope.params;
  const src = scope.active
    ? { from: catTable, q: 'qty', v: 'val', m: 'mrp' }
    : { from: 'srd_store', q: 's_qty - r_qty', v: 's_val - r_val', m: 's_mrp - r_mrp' };
  const scoped = (by) => (conds.length ? `AND ${shift(conds, by).join(' AND ')}` : '');
  const main = windowCols(windows, [['_q', 'x.q'], ['_v', 'x.v'], ['_m', 'x.m']]);
  const wk = windowCols(wkWindows, [['', 'x.v']]);
  const baseParams = [...main.params, ...wk.params];
  const off = baseParams.length;
  const salesSQL = `
    WITH x AS (SELECT sale_date AS d, location_id, (${src.q}) AS q, (${src.v}) AS v, (${src.m}) AS m
               FROM ${src.from} WHERE sale_date BETWEEN $${off + 1}::date AND $${off + 2}::date ${scoped(off + 2)})
    SELECT x.location_id, ${main.cols},
      ${wk.cols.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + main.params.length}`)}
    FROM x GROUP BY x.location_id`;
  // net value per store per day of the month, TY and LY
  const dailySQL = `
    SELECT location_id, sale_date::text AS d, SUM(${src.v})::float AS v FROM ${src.from}
    WHERE (sale_date BETWEEN $1::date AND $2::date OR sale_date BETWEEN $3::date AND $4::date) ${scoped(4)}
    GROUP BY 1, 2`;
  const billsWin = windowCols(windows, [['', 'x.b']]);
  const billsSQL = `
    WITH x AS (SELECT sale_date AS d, location_id, bills AS b FROM wr_store_day
               WHERE sale_date BETWEEN $${billsWin.params.length + 1}::date AND $${billsWin.params.length + 2}::date)
    SELECT x.location_id, ${billsWin.cols} FROM x GROUP BY x.location_id`;
  const catWin = windowCols(windows.filter(([k]) => CAT_P.includes(k)), [['_q', 'x.q'], ['_v', 'x.v']]);
  const catSQL = `
    WITH x AS (SELECT sale_date AS d, location_id, gender, category, product, qty AS q, val AS v FROM ${catTable}
               WHERE sale_date BETWEEN $${catWin.params.length + 1}::date AND $${catWin.params.length + 2}::date ${scoped(catWin.params.length + 2)})
    SELECT x.location_id, x.gender, x.category, x.product, ${catWin.cols} FROM x GROUP BY 1, 2, 3, 4`;

  // stock: the rollup (all / light), or the raw snapshot rows for a deep filter (via the pool, in parallel)
  const stockSQL = scope.deep
    ? `SELECT d.snapshot_date::text AS d, d.location_id, COALESCE(s.gender_name, '') AS gender, COALESCE(s.category_norm, '') AS category,
              ${PRODUCT_NORM} AS product, SUM(d.qty_on_hand)::int AS qty, SUM(d.qty_on_hand::numeric * COALESCE(s.mrp, 0)) AS mrp
       FROM inventory_daily_snapshot d JOIN skus s ON s.id = d.sku_id
       WHERE d.snapshot_date = ANY($1::date[]) AND d.qty_on_hand <> 0 AND ${shift(scope.skuConds, 1).join(' AND ')}
       GROUP BY 1, 2, 3, 4, 5`
    : `SELECT snapshot_date::text AS d, location_id, gender, category, product, qty, mrp FROM ${stockTable}
       WHERE snapshot_date = ANY($1::date[]) ${scoped(1)}`;
  const stockParams = [stockDates, ...scope.params];

  // pool queries run in parallel; the deep path's temp-table queries share one
  // client, so they run one after another (alongside the pool's)
  const pool = [storeList(), stockDates.length ? query(stockSQL, stockParams) : { rows: [] },
    scope.active ? { rows: [] } : query(billsSQL, [...billsWin.params, lo, D])];
  const own = [[salesSQL, [...baseParams, lo, D, ...params]], [dailySQL, [P.mtd[0], D, P.mtdly[0], P.mtdly[1], ...params]],
    [catSQL, [...catWin.params, P.ytdly[0], D, ...params]]];
  let sales; let daily; let cats;
  if (client) { sales = await run(...own[0]); daily = await run(...own[1]); cats = await run(...own[2]); }
  else [sales, daily, cats] = await Promise.all(own.map(([sql, p]) => run(sql, p)));
  const [stores, stock, bills] = await Promise.all(pool);

  const byLoc = (rows) => Object.fromEntries(rows.map((r) => [r.location_id, r]));
  const S = byLoc(sales.rows); const B = byLoc(bills.rows);
  const nDays = Number(D.slice(8)); const lyStart = P.mtdly[0];
  const DY = {}; for (const r of daily.rows) {
    const a = (DY[r.location_id] ||= [new Array(nDays).fill(0), new Array(nDays).fill(0)]);
    if (r.d >= P.mtd[0]) a[0][Number(r.d.slice(8)) - 1] += r.v;
    else if (r.d >= lyStart) { const i = Number(r.d.slice(8)) - 1; if (i < nDays) a[1][i] += r.v; }
  }
  // ₹ added up in integer paisa, then rounded once — exactly as the engine does
  const paisa = (x) => Math.round(Number(x) * 100);
  const C = {}; for (const r of cats.rows) {
    const k = catOf(r.gender, r.category, r.product); const m = (C[r.location_id] ||= {}); const a = (m[k] ||= new Array(12).fill(0));
    CAT_P.forEach((p, i) => { a[i] += Number(r[`${p}_q`]); a[6 + i] += paisa(r[`${p}_v`]); });
  }
  for (const m of Object.values(C)) for (const a of Object.values(m)) for (let i = 6; i < 12; i++) a[i] /= 100;
  const K = stockByCat(stock.rows, lyStock);
  const TG = scope.active ? null : await targetsFor(D, P);
  return assemble({ meta, D, weekStart, P, weeks, windows, tyStock, lyStock, tyOk, lyOk }, scope, stores, S, B, DY, C, K, 'sql', TG);
}

// Stock rollup rows → store × category [qty TY, qty LY, MRP TY, MRP LY] (MRP in paisa, then ₹).
function stockByCat(rows, lyStock) {
  const K = {};
  for (const r of rows) {
    const k = catOf(r.gender, r.category, r.product); const m = (K[r.location_id] ||= {}); const a = (m[k] ||= [0, 0, 0, 0]);
    const ly = r.d === lyStock ? 1 : 0; a[ly] += Number(r.qty); a[2 + ly] += Math.round(Number(r.mrp) * 100);
  }
  for (const m of Object.values(K)) for (const a of Object.values(m)) { a[2] /= 100; a[3] /= 100; }
  return K;
}

// Both paths end here: one store object per store that sold in any window.
function assemble(F, scope, stores, S, B, DY, C, K, source, TG) {
  const { meta, D, weekStart, P, weeks, windows, tyStock, lyStock, tyOk, lyOk } = F;
  const nDays = Number(D.slice(8));
  const out = [];
  for (const st of stores) {
    const b = B[st.id]; const tg = TG ? TG.map[st.code] || null : null;
    const s = S[st.id] || {};
    const sold = windows.some(([k]) => Number(s[`${k}_q`]) || Number(s[`${k}_v`]));
    if (!sold && !(tg && Object.values(tg).some((x) => x && (x[0] || x[1])))) continue;   // neither sales nor a target
    const m = {};
    for (const [k] of windows) m[k] = [Number(s[`${k}_q`] || 0), r2(s[`${k}_v`]), r2(s[`${k}_m`]), scope.active ? null : Number(b?.[k] || 0)];
    const dy = DY[st.id] || [new Array(nDays).fill(0), new Array(nDays).fill(0)];
    out.push({
      code: st.code, name: st.name, city: st.city, state: st.state, region: regionOf(st.zone),
      channel: st.channel, closed: st.closed, opened: st.first, lastSale: st.last,
      type: storeType(st, P),
      m, wk: weeks.map((_, i) => r0(s[`w${i}`])), wkly: weeks.map((_, i) => r0(s[`l${i}`])),
      dy: dy[0].map(r0), dyly: dy[1].map(r0),
      cat: C[st.id] ? Object.fromEntries(Object.entries(C[st.id]).map(([k, a]) => [k, a.map(r0)])) : {},
      stk: K[st.id] ? Object.fromEntries(Object.entries(K[st.id]).map(([k, a]) => [k, a.map(r0)])) : {},
      t: tg,
    });
  }
  return {
    meta, scoped: scope.active, cats: CATS, source,
    periods: { asOn: D, weekStart, ...P, weeks: weeks.map((w) => w.ty), weeksLy: weeks.map((w) => w.ly),
      stock: { ty: tyOk ? tyStock : null, ly: lyOk ? lyStock : null },
      targets: TG ? TG.info : null },
    stores: out,
  };
}

// Every active store with a code, its zone, and its first / last sale day.
const storeList = () => once('stores', storeListRaw);
async function storeListRaw() {
  const { rows } = await query(`
    SELECT l.id, l.external_id AS code, l.name, l.city, l.state, COALESCE(l.group_name, l.type::text) AS channel,
           l.shop_closed AS closed, z.name AS zone, f.first::text AS first, f.last::text AS last
    FROM locations l
    LEFT JOIN zones z ON z.id = l.zone_id
    LEFT JOIN (SELECT location_id, MIN(sale_date) AS first, MAX(sale_date) AS last FROM srd_store GROUP BY 1) f ON f.location_id = l.id
    WHERE l.is_active AND l.external_id IS NOT NULL`);
  return rows.map((r) => ({
    id: r.id, code: r.code, name: (r.name || '').replace(/\s+/g, ' ').trim(), city: title(r.city), state: title(r.state),
    channel: r.channel, closed: r.closed, zone: r.zone, first: r.first, last: r.last,
  }));
}

const getMeta = () => once('meta', async () => (await query('SELECT MIN(sale_date)::text AS "from", MAX(sale_date)::text AS "to" FROM srd_store')).rows[0]);

// ── notes (the one thing the page writes) ────────────────────────────────────
// Kept out of the board so a save never invalidates the cached sales board.
// → { notes: {code: {asm, reason, action, by, at}}, prev: {code: {week, reason, action, by}}, asm: {code: name} }
async function getNotes(weekStartAny) {
  const ws = mondayOf(weekStartAny);
  const [cur, prev, asm] = await Promise.all([
    query('SELECT external_id, asm, reason, action, updated_by, updated_at FROM wr_notes WHERE week_start = $1', [ws]),
    query(`SELECT DISTINCT ON (external_id) external_id, week_start::text AS week_start, reason, action, updated_by
           FROM wr_notes WHERE week_start < $1 AND (COALESCE(reason, '') <> '' OR COALESCE(action, '') <> '')
           ORDER BY external_id, week_start DESC`, [ws]),
    query(`SELECT DISTINCT ON (external_id) external_id, asm FROM wr_notes
           WHERE COALESCE(asm, '') <> '' AND week_start <= $1 ORDER BY external_id, week_start DESC`, [ws]),
  ]);
  return {
    week: ws,
    notes: Object.fromEntries(cur.rows.map((r) => [r.external_id, { asm: r.asm || '', reason: r.reason || '', action: r.action || '', by: r.updated_by, at: r.updated_at }])),
    prev: Object.fromEntries(prev.rows.map((r) => [r.external_id, { week: r.week_start, reason: r.reason || '', action: r.action || '', by: r.updated_by }])),
    asm: Object.fromEntries(asm.rows.map((r) => [r.external_id, r.asm])),
  };
}

async function saveNote({ week_start, external_id, asm, reason, action }, user) {
  const ws = mondayOf(week_start);
  const by = user ? user.name || user.email : null;
  await query(`INSERT INTO wr_notes (week_start, external_id, asm, reason, action, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (week_start, external_id) DO UPDATE SET asm = EXCLUDED.asm, reason = EXCLUDED.reason,
      action = EXCLUDED.action, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
  [ws, external_id, asm || null, reason || null, action || null, by]);
  return { week_start: ws, external_id, by };
}

module.exports = { buildBoard, boardWith, _scope: productScope, getMeta, saveNote, getNotes, loadEngine: () => engine.load(catOf, CATS), periodsFor, catOf, ensureStock, CATS, _test: { minusYear, mondayOf, fyStart, storeType } };
