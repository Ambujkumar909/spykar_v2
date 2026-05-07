'use strict';
require('dotenv').config();
const { query } = require('../config/database');

(async () => {
  const inv = await query(`SELECT SUM(qty_on_hand)::bigint AS total_stock, COUNT(*)::int AS pairs FROM inventory_snapshot WHERE qty_on_hand > 0`);
  console.log('inventory_snapshot (qty>0):', inv.rows[0]);

  const aged = await query(`
    SELECT
      MAX(ageing_date) AS latest_date,
      SUM(qty_0_30+qty_31_60+qty_61_90+qty_91_180+qty_180_plus)::bigint AS total_aged,
      COUNT(*)::int AS pairs
    FROM stock_ageing
    WHERE ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
  `);
  console.log('stock_ageing latest:', aged.rows[0]);

  const dates = await query(`SELECT ageing_date, COUNT(*)::int AS pairs, SUM(qty_0_30+qty_31_60+qty_61_90+qty_91_180+qty_180_plus)::bigint AS total FROM stock_ageing GROUP BY ageing_date ORDER BY ageing_date DESC LIMIT 5`);
  console.log('ageing dates:', dates.rows);

  const missing = await query(`
    SELECT COUNT(*)::int AS pairs_missing,
           SUM(i.qty_on_hand)::bigint AS missing_units
    FROM inventory_snapshot i
    LEFT JOIN stock_ageing a
      ON a.location_id = i.location_id AND a.sku_id = i.sku_id
     AND a.ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
    WHERE i.qty_on_hand > 0 AND a.id IS NULL
  `);
  console.log('inventory rows w/o ageing:', missing.rows[0]);

  const ref = await query(`SELECT MAX(moved_at)::date AS max_sale, COUNT(*)::int AS sale_count FROM inventory_movements WHERE movement_type='SALE'`);
  console.log('sale ref:', ref.rows[0]);

  // Check active vs all locations
  const activeCmp = await query(`
    SELECT
      (SELECT COUNT(*) FROM locations WHERE is_active=true)::int AS active_locs,
      (SELECT COUNT(DISTINCT location_id) FROM stock_ageing WHERE ageing_date=(SELECT MAX(ageing_date) FROM stock_ageing))::int AS aged_locs,
      (SELECT COUNT(DISTINCT location_id) FROM inventory_snapshot WHERE qty_on_hand>0)::int AS stock_locs
  `);
  console.log('locations:', activeCmp.rows[0]);

  // Inactive stock (likely the gap)
  const inactiveStock = await query(`
    SELECT SUM(i.qty_on_hand)::bigint AS units, COUNT(*)::int AS pairs
    FROM inventory_snapshot i
    JOIN locations l ON l.id = i.location_id
    WHERE i.qty_on_hand > 0 AND l.is_active = false
  `);
  console.log('inactive locations stock:', inactiveStock.rows[0]);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
