/**
 * Fix warehouse movements:
 * 1. Create DISPATCH (TRANSFER_OUT) inventory movements for warehouse locations
 *    based on existing dispatch_line_items records.
 * 2. Inject opening stock adjustments for any location where net movements go negative.
 * 3. Rebuild inventory snapshot and stock ageing.
 *
 * Run: node src/scripts/fix-warehouse-movements.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pg = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT) || 5433,
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

async function main() {
  console.log('\n=== Step 1: Create DISPATCH movements for warehouse locations ===');

  // For every dispatch that came from a warehouse location and has line items,
  // create a DISPATCH (negative) movement in inventory_movements.
  // We use qty_dispatched if available, else qty_ordered.
  const res = await pg.query(`
    SELECT
      d.id AS dispatch_id,
      d.from_location_id,
      d.dispatched_at,
      dli.sku_id,
      COALESCE(dli.qty_dispatched, dli.qty_ordered) AS qty
    FROM dispatch_orders d
    JOIN dispatch_line_items dli ON dli.dispatch_id = d.id
    JOIN locations l ON l.id = d.from_location_id
    WHERE l.type = 'WAREHOUSE'
      AND COALESCE(dli.qty_dispatched, dli.qty_ordered) > 0
    ORDER BY d.dispatched_at ASC
  `);

  console.log(`Found ${res.rows.length} warehouse dispatch line items`);

  let inserted = 0;
  let skipped  = 0;

  for (const row of res.rows) {
    const qty = Math.abs(parseInt(row.qty));
    if (qty === 0) { skipped++; continue; }

    // Check if movement already exists to avoid duplicates
    const existing = await pg.query(`
      SELECT id FROM inventory_movements
      WHERE location_id = $1 AND sku_id = $2
        AND movement_type = 'DISPATCH'
        AND moved_at::date = $3::date
        AND qty_change = $4
      LIMIT 1
    `, [row.from_location_id, row.sku_id, row.dispatched_at, -qty]);

    if (existing.rows.length > 0) { skipped++; continue; }

    await pg.query(`
      INSERT INTO inventory_movements
        (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, synced_from, notes)
      VALUES ($1, $2, 'DISPATCH', $3, 0, 0, $4, 'SYSTEM', 'Warehouse dispatch (backfill)')
      ON CONFLICT DO NOTHING
    `, [row.from_location_id, row.sku_id, -qty, row.dispatched_at]);
    inserted++;
  }
  console.log(`Inserted: ${inserted}, Skipped (already exist): ${skipped}`);

  console.log('\n=== Step 2: Fix before/after for new warehouse movements (window function) ===');
  await pg.query(`
    WITH ordered AS (
      SELECT id, qty_change,
        COALESCE(SUM(qty_change) OVER (
          PARTITION BY location_id, sku_id
          ORDER BY moved_at ASC, id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS computed_before
      FROM inventory_movements
    )
    UPDATE inventory_movements m SET
      qty_before = GREATEST(0, o.computed_before),
      qty_after  = GREATEST(0, o.computed_before + o.qty_change)
    FROM ordered o WHERE m.id = o.id
  `);
  console.log('Before/after updated');

  console.log('\n=== Step 3: Inject opening stock for locations with net negative movements ===');
  const negRows = await pg.query(`
    WITH net AS (
      SELECT location_id, sku_id, SUM(qty_change) AS net_qty
      FROM inventory_movements
      GROUP BY location_id, sku_id
    )
    SELECT n.location_id, n.sku_id, (-n.net_qty) AS opening_qty,
           (SELECT MIN(moved_at) FROM inventory_movements m2
            WHERE m2.location_id = n.location_id AND m2.sku_id = n.sku_id) AS first_move
    FROM net n WHERE n.net_qty < 0
  `);
  console.log(`Found ${negRows.rows.length} location+SKU combos needing opening stock`);

  let adjInserted = 0;
  for (const row of negRows.rows) {
    await pg.query(`
      INSERT INTO inventory_movements
        (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, synced_from, notes)
      VALUES ($1, $2, 'ADJUSTMENT', $3, 0, $4, $5, 'SYSTEM', 'Opening stock injection (backfill)')
      ON CONFLICT DO NOTHING
    `, [row.location_id, row.sku_id, row.opening_qty, row.opening_qty,
        new Date(new Date(row.first_move).getTime() - 86400000)]);
    adjInserted++;
  }
  console.log(`Opening stock adjustments inserted: ${adjInserted}`);

  console.log('\n=== Step 4: Rebuild inventory snapshot ===');
  await pg.query(`
    INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at)
    SELECT
      m.location_id,
      m.sku_id,
      GREATEST(0, SUM(m.qty_change)) AS qty_on_hand,
      MAX(m.moved_at)                AS last_movement_at
    FROM inventory_movements m
    GROUP BY m.location_id, m.sku_id
    ON CONFLICT (location_id, sku_id) DO UPDATE SET
      qty_on_hand      = GREATEST(0, EXCLUDED.qty_on_hand),
      last_movement_at = EXCLUDED.last_movement_at,
      updated_at       = NOW()
  `);
  console.log('Snapshot rebuilt');

  console.log('\n=== Step 5: Verify warehouse stock ===');
  const whCheck = await pg.query(`
    SELECT l.code, l.name,
           COUNT(DISTINCT m.sku_id) AS sku_count,
           SUM(CASE WHEN m.movement_type = 'DISPATCH' THEN 1 ELSE 0 END) AS dispatch_moves,
           SUM(CASE WHEN m.movement_type = 'ADJUSTMENT' THEN 1 ELSE 0 END) AS adj_moves,
           COALESCE((SELECT SUM(qty_on_hand) FROM inventory_snapshot WHERE location_id = l.id), 0) AS snapshot_qty
    FROM locations l
    LEFT JOIN inventory_movements m ON m.location_id = l.id
    WHERE l.type = 'WAREHOUSE'
    GROUP BY l.id, l.code, l.name
  `);
  console.log('\nWarehouse results:');
  whCheck.rows.forEach(r =>
    console.log(`  ${r.code}: ${r.sku_count} SKUs | ${r.dispatch_moves} dispatches | ${r.adj_moves} adjustments | snapshot: ${r.snapshot_qty}`)
  );

  await pg.end();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
