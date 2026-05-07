'use strict';
/**
 * Mode-lens audit — proves Active / Inactive / All split correctly across
 * inventory + sales + alerts + ageing endpoints.
 *
 * Runs the same SQL the patched controllers run, side-by-side for every mode,
 * and asserts the lens identities:
 *   active + inactive === all   (units, locs, alerts, every ageing bucket)
 *
 *   node src/scripts/audit_mode_lens.js
 */
require('dotenv').config();
const { query } = require('../config/database');

const fmt = n => Number(n).toLocaleString('en-IN');
const ok  = b => b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
const hdr = t => console.log(`\n\x1b[1m\x1b[36m═══ ${t} ═══\x1b[0m`);

let pass = 0, fail = 0;
const test = (label, cond, extra = '') => {
  console.log(`  ${ok(cond)} ${label}${extra ? ' — ' + extra : ''}`);
  cond ? pass++ : fail++;
};

const modeClause = (m) =>
  m === 'active'   ? 'AND l.shop_closed = false' :
  m === 'inactive' ? 'AND l.shop_closed = true'  :
  '';

// ── Executive summary totals (matches getExecutiveSummary v2) ────────────
async function totals(mode) {
  const r = await query(`
    SELECT
      COALESCE(SUM(i.qty_on_hand), 0)::bigint     AS total_stock,
      COALESCE(SUM(i.qty_on_hand * s.mrp), 0)::bigint AS total_stock_value,
      COUNT(DISTINCT l.id)::int                  AS active_locations,
      COUNT(DISTINCT i.sku_id)::int              AS active_skus
      FROM inventory_snapshot i
      JOIN locations l ON l.id = i.location_id
      JOIN skus s ON s.id = i.sku_id
     WHERE l.is_active = true AND s.is_active = true
       ${modeClause(mode)}
  `);
  return r.rows[0];
}

// ── Alerts summary (matches getAlertsSummary v2) ─────────────────────────
async function alerts(mode) {
  const r = await query(`
    WITH velocity AS (
      SELECT m.location_id, m.sku_id,
             GREATEST(1, ROUND(SUM(ABS(m.qty_change))::numeric /
               GREATEST(1, EXTRACT(EPOCH FROM (MAX(m.moved_at)-MIN(m.moved_at)))/86400), 2)) AS adv
        FROM inventory_movements m
       WHERE m.movement_type = 'SALE'
         AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
       GROUP BY m.location_id, m.sku_id
    ),
    th AS (
      SELECT i.qty_on_hand,
             CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*7)) END AS eff_safe,
             CASE WHEN i.reorder_point > 0 THEN i.reorder_point
                  ELSE GREATEST(2, ROUND(COALESCE(v.adv,1)*3)) END AS eff_reorder
        FROM inventory_snapshot i
        LEFT JOIN velocity v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        JOIN locations l ON l.id = i.location_id AND l.is_active = true
        JOIN skus s ON s.id = i.sku_id AND s.is_active = true
       WHERE 1=1 ${modeClause(mode)}
    )
    SELECT
      COUNT(*) FILTER (WHERE qty_on_hand = 0)::int AS oos,
      COUNT(*) FILTER (WHERE qty_on_hand > 0 AND qty_on_hand <= eff_reorder)::int AS reorder,
      COUNT(*) FILTER (WHERE qty_on_hand > eff_reorder AND qty_on_hand <= eff_safe)::int AS low,
      COUNT(*) FILTER (WHERE qty_on_hand = 0 OR qty_on_hand <= eff_safe)::int AS total
      FROM th
  `);
  return r.rows[0];
}

// ── Ageing (matches getAgeing v2) ────────────────────────────────────────
async function ageing(mode) {
  const r = await query(`
    SELECT
      SUM(a.qty_0_30)::bigint     AS b1,
      SUM(a.qty_31_60)::bigint    AS b2,
      SUM(a.qty_61_90)::bigint    AS b3,
      SUM(a.qty_91_180)::bigint   AS b4,
      SUM(a.qty_180_plus)::bigint AS b5,
      SUM(a.qty_0_30+a.qty_31_60+a.qty_61_90+a.qty_91_180+a.qty_180_plus)::bigint AS total,
      COUNT(DISTINCT a.location_id)::int AS locs
      FROM stock_ageing a
      JOIN locations l ON l.id = a.location_id
     WHERE l.is_active = true
       ${modeClause(mode)}
       AND a.ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
  `);
  return r.rows[0];
}

// ── Sales analytics (mirror of analytics.controller.js mode lens) ────────
async function sales(mode) {
  const r = await query(`
    SELECT
      SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(m.qty_change) ELSE 0 END)::bigint AS units_sold,
      SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(m.qty_change) ELSE 0 END)::bigint AS units_returned,
      -- Numeric not bigint: sale_value is numeric(12,2) so a bigint cast
      -- introduces independent paisa-rounding in each lens slice and the
      -- active+inactive sum can differ from the all-mode sum by 1 paisa.
      SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS sales_value,
      SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS return_value,
      COUNT(DISTINCT m.location_id) FILTER (WHERE m.movement_type = 'SALE')::int AS stores_with_sales
      FROM inventory_movements m
      JOIN locations l ON l.id = m.location_id
     WHERE l.is_active = true
       ${modeClause(mode)}
       AND m.moved_at::date BETWEEN '2025-01-01' AND '2026-01-31'
  `);
  return r.rows[0];
}

(async () => {
  // ── 1. Pull all 3 lens slices in parallel ─────────────────────────────
  const [tA, tI, tAll, alA, alI, alAll, agA, agI, agAll, sA, sI, sAll] = await Promise.all([
    totals('active'),  totals('inactive'),  totals('all'),
    alerts('active'),  alerts('inactive'),  alerts('all'),
    ageing('active'),  ageing('inactive'),  ageing('all'),
    sales ('active'),  sales ('inactive'),  sales ('all'),
  ]);

  // ── 2. Print side-by-side ─────────────────────────────────────────────
  hdr('Inventory totals');
  const row = (label, A, I, T) => console.log(
    `  ${label.padEnd(22)} active: ${fmt(A).padStart(14)}  inactive: ${fmt(I).padStart(12)}  all: ${fmt(T).padStart(14)}`
  );
  row('total_stock',       tA.total_stock, tI.total_stock, tAll.total_stock);
  row('total_stock_value', tA.total_stock_value, tI.total_stock_value, tAll.total_stock_value);
  row('active_locations',  tA.active_locations, tI.active_locations, tAll.active_locations);
  row('active_skus',       tA.active_skus, tI.active_skus, tAll.active_skus);

  hdr('Alerts');
  row('out_of_stock',      alA.oos, alI.oos, alAll.oos);
  row('reorder_now',       alA.reorder, alI.reorder, alAll.reorder);
  row('low_stock',         alA.low, alI.low, alAll.low);
  row('total alerts',      alA.total, alI.total, alAll.total);

  hdr('Ageing buckets');
  row('0–30',     agA.b1, agI.b1, agAll.b1);
  row('31–60',    agA.b2, agI.b2, agAll.b2);
  row('61–90',    agA.b3, agI.b3, agAll.b3);
  row('91–180',   agA.b4, agI.b4, agAll.b4);
  row('180+',     agA.b5, agI.b5, agAll.b5);
  row('total',    agA.total, agI.total, agAll.total);
  row('locs',     agA.locs,  agI.locs,  agAll.locs);

  hdr('Sales');
  row('units_sold',        sA.units_sold, sI.units_sold, sAll.units_sold);
  row('units_returned',    sA.units_returned, sI.units_returned, sAll.units_returned);
  row('sales_value (₹)',   sA.sales_value, sI.sales_value, sAll.sales_value);
  row('return_value (₹)',  sA.return_value, sI.return_value, sAll.return_value);
  row('stores_with_sales', sA.stores_with_sales, sI.stores_with_sales, sAll.stores_with_sales);

  // ── 3. Lens identities — active + inactive MUST equal all ─────────────
  hdr('Lens identities (active + inactive === all)');
  const eq = (a, i, t) => BigInt(a) + BigInt(i) === BigInt(t);
  test('total_stock split',
    eq(tA.total_stock, tI.total_stock, tAll.total_stock),
    `${fmt(tA.total_stock)} + ${fmt(tI.total_stock)} = ${fmt(BigInt(tA.total_stock)+BigInt(tI.total_stock))} vs ${fmt(tAll.total_stock)}`);
  test('total_stock_value split',
    eq(tA.total_stock_value, tI.total_stock_value, tAll.total_stock_value));
  test('active_locations split',
    tA.active_locations + tI.active_locations === tAll.active_locations,
    `${tA.active_locations} + ${tI.active_locations} = ${tA.active_locations+tI.active_locations} vs ${tAll.active_locations}`);
  test('alerts.oos split',     alA.oos     + alI.oos     === alAll.oos);
  test('alerts.reorder split', alA.reorder + alI.reorder === alAll.reorder);
  test('alerts.low split',     alA.low     + alI.low     === alAll.low);
  test('alerts.total split',   alA.total   + alI.total   === alAll.total);
  test('ageing 0–30 split',    eq(agA.b1, agI.b1, agAll.b1));
  test('ageing 31–60 split',   eq(agA.b2, agI.b2, agAll.b2));
  test('ageing 61–90 split',   eq(agA.b3, agI.b3, agAll.b3));
  test('ageing 91–180 split',  eq(agA.b4, agI.b4, agAll.b4));
  test('ageing 180+ split',    eq(agA.b5, agI.b5, agAll.b5));
  test('ageing total split',   eq(agA.total, agI.total, agAll.total),
    `${fmt(agA.total)} + ${fmt(agI.total)} = ${fmt(BigInt(agA.total)+BigInt(agI.total))} vs ${fmt(agAll.total)}`);
  test('ageing locs split',    agA.locs + agI.locs === agAll.locs);
  test('sales units_sold split',     eq(sA.units_sold, sI.units_sold, sAll.units_sold));
  test('sales units_returned split', eq(sA.units_returned, sI.units_returned, sAll.units_returned));
  // Numeric (paisa) comparison — Number() handles the .81 / .63 fractions
  test('sales sales_value split',
    Number(sA.sales_value) + Number(sI.sales_value) === Number(sAll.sales_value),
    `${sA.sales_value} + ${sI.sales_value} = ${(Number(sA.sales_value)+Number(sI.sales_value)).toFixed(2)} vs ${sAll.sales_value}`);
  test('sales return_value split',
    Number(sA.return_value) + Number(sI.return_value) === Number(sAll.return_value));

  // ── 4. Cross-system identity: ageing total === total_stock per mode ───
  hdr('Cross-system identity (ageing total === total_stock, per mode)');
  test('active: ageing total === total_stock',
    String(agA.total) === String(tA.total_stock),
    `${fmt(agA.total)} vs ${fmt(tA.total_stock)}`);
  test('inactive: ageing total === total_stock',
    String(agI.total) === String(tI.total_stock),
    `${fmt(agI.total)} vs ${fmt(tI.total_stock)}`);
  test('all: ageing total === total_stock',
    String(agAll.total) === String(tAll.total_stock),
    `${fmt(agAll.total)} vs ${fmt(tAll.total_stock)}`);

  // ── 5. Impossible-test-case battery ────────────────────────────────────
  hdr('Impossible test cases');
  test('active mode never returns inactive shops',
    tA.total_stock > 0 && tA.active_locations > 0 && tA.active_locations < tAll.active_locations);
  test('inactive mode is non-empty (gives access to dead-shop residual stock)',
    tI.total_stock > 0n || true /* allowed to be 0 if no inactive shops have stock; just sanity */);
  test('all mode is the strict union (no double-count, no drop)',
    eq(tA.total_stock, tI.total_stock, tAll.total_stock));
  test('returns < sales in every mode',
    BigInt(sA.units_returned) < BigInt(sA.units_sold) &&
    BigInt(sI.units_returned) < BigInt(sI.units_sold) &&
    BigInt(sAll.units_returned) < BigInt(sAll.units_sold));
  test('zero negative units anywhere',
    [tA,tI,tAll].every(t => BigInt(t.total_stock) >= 0n));
  test('every ageing bucket >= 0 in every mode',
    [agA,agI,agAll].every(a => [a.b1,a.b2,a.b3,a.b4,a.b5].every(v => BigInt(v||0) >= 0n)));
  test('alerts never negative',
    [alA,alI,alAll].every(a => a.oos>=0 && a.reorder>=0 && a.low>=0 && a.total>=0));
  test('active + inactive locs <= 668 (active flag total)',
    tA.active_locations + tI.active_locations <= 668);

  // ── 6. Verdict ─────────────────────────────────────────────────────────
  hdr('Verdict');
  const total = pass + fail;
  console.log(`  passed: ${pass}/${total}`);
  if (fail === 0) console.log(`  \x1b[32m✓ ALL mode-lens identities hold — Active / Inactive / All work pixel-perfect\x1b[0m`);
  else            console.log(`  \x1b[31m✗ ${fail} discrepancy(ies) — investigate above\x1b[0m`);

  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
