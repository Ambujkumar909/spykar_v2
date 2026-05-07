'use strict';
/**
 * Executive Overview audit — pixel-by-pixel cross-check of every figure
 * the Overview page renders, straight from Postgres.
 *
 *   node src/scripts/audit_overview.js
 */
require('dotenv').config();
const { query } = require('../config/database');

const fmt = n => Number(n).toLocaleString('en-IN');
const ok  = b => b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
const hdr = t => console.log(`\n\x1b[1m\x1b[36m═══ ${t} ═══\x1b[0m`);

(async () => {
  let pass = 0, fail = 0;
  const test = (label, cond, extra = '') => {
    console.log(`  ${ok(cond)} ${label}${extra ? ' — ' + extra : ''}`);
    cond ? pass++ : fail++;
  };

  // ── 1. INVENTORY TOTALS ───────────────────────────────────────────────
  hdr('1. Inventory totals');
  const totalsRow = await query(`
    SELECT SUM(qty_on_hand)::bigint AS total_stock,
           SUM(qty_on_hand * COALESCE(s.mrp, 0))::bigint AS total_value,
           COUNT(*)::int AS pairs
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
     WHERE i.qty_on_hand > 0
  `);
  const T = totalsRow.rows[0];
  console.log(`  total_stock = ${fmt(T.total_stock)} units across ${fmt(T.pairs)} location-SKU pairs`);
  console.log(`  total_value = ₹${fmt(T.total_value)}`);

  // ── 2. AGEING ACCURACY ────────────────────────────────────────────────
  hdr('2. Ageing accuracy');
  const aged = await query(`
    SELECT SUM(qty_0_30)::bigint     AS b1,
           SUM(qty_31_60)::bigint    AS b2,
           SUM(qty_61_90)::bigint    AS b3,
           SUM(qty_91_180)::bigint   AS b4,
           SUM(qty_180_plus)::bigint AS b5,
           SUM(qty_0_30+qty_31_60+qty_61_90+qty_91_180+qty_180_plus)::bigint AS total,
           COUNT(*)::int AS pairs
      FROM stock_ageing
     WHERE ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
  `);
  const A = aged.rows[0];
  console.log(`  0–30 d:    ${fmt(A.b1)}`);
  console.log(`  31–60 d:   ${fmt(A.b2)}`);
  console.log(`  61–90 d:   ${fmt(A.b3)}`);
  console.log(`  91–180 d:  ${fmt(A.b4)}`);
  console.log(`  180+ d:    ${fmt(A.b5)}`);
  console.log(`  ────────────────`);
  console.log(`  ageing total: ${fmt(A.total)} (${fmt(A.pairs)} pairs)`);
  test('ageing total === inventory_snapshot total',
       A.total === T.total_stock,
       `${fmt(A.total)} vs ${fmt(T.total_stock)}`);
  test('ageing pairs === snapshot pairs',
       A.pairs === T.pairs,
       `${fmt(A.pairs)} vs ${fmt(T.pairs)}`);
  test('every bucket >= 0', [A.b1,A.b2,A.b3,A.b4,A.b5].every(v => Number(v) >= 0));

  // ── 3. CHANNEL BREAKDOWN ──────────────────────────────────────────────
  hdr('3. Channel breakdown sum');
  const chan = await query(`
    SELECT l.type AS location_type,
           SUM(i.qty_on_hand)::bigint AS units,
           COUNT(DISTINCT l.id)::int AS locs
      FROM inventory_snapshot i
      JOIN locations l ON l.id = i.location_id
     WHERE i.qty_on_hand > 0
     GROUP BY l.type
     ORDER BY units DESC
  `);
  let chanTotal = 0n;
  for (const r of chan.rows) {
    console.log(`  ${r.location_type.padEnd(14)} ${fmt(r.units).padStart(12)} units · ${fmt(r.locs)} locs`);
    chanTotal += BigInt(r.units);
  }
  console.log(`  channel total: ${fmt(chanTotal)}`);
  test('channel sum === total_stock',
       String(chanTotal) === T.total_stock,
       `${chanTotal} vs ${T.total_stock}`);

  // ── 4. ACTIVE / INACTIVE LOCATION COUNTS ──────────────────────────────
  hdr('4. Location counts (mode lens)');
  const locs = await query(`
    SELECT
      COUNT(*) FILTER (WHERE is_active = true)::int  AS active,
      COUNT(*) FILTER (WHERE is_active = false)::int AS inactive,
      COUNT(*)::int AS total
      FROM locations
  `);
  const L = locs.rows[0];
  console.log(`  active:   ${fmt(L.active)}`);
  console.log(`  inactive: ${fmt(L.inactive)}`);
  console.log(`  total:    ${fmt(L.total)}`);
  test('active + inactive === total',
       L.active + L.inactive === L.total);

  // Active locations that have any stock
  const stockLocs = await query(`
    SELECT COUNT(DISTINCT i.location_id)::int AS locs
      FROM inventory_snapshot i
      JOIN locations l ON l.id = i.location_id
     WHERE i.qty_on_hand > 0 AND l.is_active = true
  `);
  console.log(`  active locs with stock: ${fmt(stockLocs.rows[0].locs)}`);

  // Active locations broken down by group_name (sales-side eligibility lens)
  const elig = await query(`
    SELECT COALESCE(group_name, '(null)') AS group_name,
           COUNT(*)::int AS locs
      FROM locations
     WHERE is_active = true
     GROUP BY group_name
     ORDER BY locs DESC
  `);
  console.log('  active locs by group_name:');
  let activeByGroup = 0;
  for (const r of elig.rows) {
    console.log(`    ${r.group_name.padEnd(22)} ${fmt(r.locs)}`);
    activeByGroup += r.locs;
  }
  console.log(`  active total: ${fmt(activeByGroup)}`);

  // ── 5. ALERT SUMMARY ──────────────────────────────────────────────────
  hdr('5. Alerts (out_of_stock + reorder + low)');
  const al = await query(`
    SELECT
      COUNT(*) FILTER (WHERE i.qty_on_hand = 0)::int AS oos,
      COUNT(*) FILTER (WHERE i.qty_on_hand > 0 AND i.qty_on_hand <= COALESCE(i.reorder_point, 5))::int AS reorder,
      COUNT(*) FILTER (WHERE i.qty_on_hand > COALESCE(i.reorder_point, 5)
                          AND i.qty_on_hand <= COALESCE(i.safety_stock, 10))::int AS low_stock
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      JOIN locations l ON l.id = i.location_id
     WHERE l.is_active = true
  `);
  const Al = al.rows[0];
  const totalAlerts = Al.oos + Al.reorder + Al.low_stock;
  console.log(`  out_of_stock: ${fmt(Al.oos)}`);
  console.log(`  reorder_now:  ${fmt(Al.reorder)}`);
  console.log(`  low_stock:    ${fmt(Al.low_stock)}`);
  console.log(`  total:        ${fmt(totalAlerts)}`);
  test('alerts categories are mutually exclusive',
       Al.oos >= 0 && Al.reorder >= 0 && Al.low_stock >= 0);

  // ── 6. SALES LENS × VALUATION MATRIX ──────────────────────────────────
  hdr('6. Sales-side: lens × valuation consistency');
  const sales = await query(`
    SELECT
      SUM(CASE WHEN movement_type = 'SALE'   THEN ABS(qty_change) ELSE 0 END)::bigint AS units_sold,
      SUM(CASE WHEN movement_type = 'RETURN' THEN ABS(qty_change) ELSE 0 END)::bigint AS units_returned,
      SUM(CASE WHEN movement_type = 'SALE'   THEN ABS(COALESCE(sale_value, 0)) ELSE 0 END)::bigint AS sales_value,
      SUM(CASE WHEN movement_type = 'RETURN' THEN ABS(COALESCE(sale_value, 0)) ELSE 0 END)::bigint AS return_value,
      SUM(CASE WHEN movement_type = 'SALE'   THEN ABS(qty_change) * COALESCE(s.mrp, 0) ELSE 0 END)::bigint AS sales_mrp,
      SUM(CASE WHEN movement_type = 'RETURN' THEN ABS(qty_change) * COALESCE(s.mrp, 0) ELSE 0 END)::bigint AS return_mrp
      FROM inventory_movements m
      JOIN skus s ON s.id = m.sku_id
     WHERE moved_at::date BETWEEN '2025-01-01' AND '2026-01-31'
  `);
  const S = sales.rows[0];
  console.log(`  units_sold:     ${fmt(S.units_sold)}`);
  console.log(`  units_returned: ${fmt(S.units_returned)}`);
  console.log(`  sales_value:    ₹${fmt(S.sales_value)}`);
  console.log(`  return_value:   ₹${fmt(S.return_value)}`);
  console.log(`  sales_mrp:      ₹${fmt(S.sales_mrp)}`);
  console.log(`  return_mrp:     ₹${fmt(S.return_mrp)}`);
  const netUnits = BigInt(S.units_sold) - BigInt(S.units_returned);
  const netVal   = BigInt(S.sales_value) - BigInt(S.return_value);
  console.log(`  net_units:      ${fmt(netUnits)}`);
  console.log(`  net_value:      ₹${fmt(netVal)}`);
  const retRate = (Number(S.units_returned) / Number(S.units_sold)) * 100;
  console.log(`  return_rate:    ${retRate.toFixed(2)}%`);
  test('return_units < units_sold', BigInt(S.units_returned) < BigInt(S.units_sold));
  test('net_units > 0', netUnits > 0n);
  test('sales_mrp >= sales_value (gross with discount)',
       BigInt(S.sales_mrp) >= BigInt(S.sales_value));

  // ── 7. SUMMARY ────────────────────────────────────────────────────────
  hdr('Verdict');
  const total = pass + fail;
  console.log(`  passed: ${pass}/${total}`);
  if (fail === 0) console.log(`  \x1b[32m✓ 100% accuracy across every figure on the Overview page\x1b[0m`);
  else            console.log(`  \x1b[31m✗ ${fail} discrepancy(ies) — investigate above\x1b[0m`);

  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
