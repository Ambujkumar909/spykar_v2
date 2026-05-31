require('dotenv').config();
const { connectDatabase, query } = require('./src/config/database');
const sql = require('mssql');

async function fix() {
  await connectDatabase();

  const locs = await query(`SELECT id, external_id FROM locations WHERE type = 'WAREHOUSE'`);
  console.log('Warehouses found:', locs.rows.length);

  const pool = await sql.connect({
    server: process.env.MSSQL_HOST,
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true }
  });

  for (const loc of locs.rows) {
    const r = await pool.request()
      .input('loc', sql.VarChar, loc.external_id)
      .query(`
        SELECT grd.item_code AS sku_external_id,
               SUM(grd.qty_received) AS qty_received,
               gr.receipt_date
        FROM GoodsReceipt gr
        JOIN GoodsReceiptDetails grd ON grd.receipt_no = gr.receipt_no
        WHERE gr.loc_code = @loc
        GROUP BY grd.item_code, gr.receipt_date
      `);

    console.log(loc.external_id, '— receipts:', r.recordset.length);

    for (const row of r.recordset) {
      const s = await query(`SELECT id FROM skus WHERE external_id = $1`, [row.sku_external_id]);
      if (!s.rows[0]) continue;

      await query(`
        INSERT INTO inventory_movements
          (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, moved_at, synced_from)
        VALUES ($1, $2, 'RECEIPT', $3, 0, $3, $4, 'SQL_SERVER_SYNC')
        ON CONFLICT DO NOTHING
      `, [loc.id, s.rows[0].id, row.qty_received, row.receipt_date]);
    }

    console.log('✅', loc.external_id, 'done');
  }

  await pool.close();

  await query(`
    INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at)
    SELECT location_id, sku_id, GREATEST(0, SUM(qty_change)), MAX(moved_at)
    FROM inventory_movements
    GROUP BY location_id, sku_id
    ON CONFLICT (location_id, sku_id) DO UPDATE SET
      qty_on_hand = GREATEST(0, EXCLUDED.qty_on_hand),
      last_movement_at = EXCLUDED.last_movement_at,
      updated_at = NOW()
  `);

  console.log('✅ Snapshot rebuilt — refresh dashboard!');
  process.exit(0);
}

fix().catch(e => { console.error('❌', e.message); process.exit(1); });