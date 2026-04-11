/**
 * Diagnostic script — checks warehouse, alerts, and trend issues
 * Run: node src/scripts/diagnose.js
 */
require('dotenv').config();
const sql    = require('mssql');
const { Pool } = require('pg');

const pg = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT) || 5433,
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

const mssqlConfig = {
  server:   process.env.MSSQL_HOST,
  port:     parseInt(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options:  { encrypt: false, trustServerCertificate: true, connectTimeout: 15000 },
};

async function main() {
  console.log('\n===== WAREHOUSE DIAGNOSTIC =====');

  // 1. Check warehouse locations in PostgreSQL
  const wh = await pg.query(`
    SELECT id, code, external_id, name, type
    FROM locations WHERE type = 'WAREHOUSE' ORDER BY code
  `);
  console.log('\n[PG] Warehouse locations:');
  wh.rows.forEach(r => console.log(`  id=${r.id} | code=${r.code} | external_id=${r.external_id} | name=${r.name}`));

  // 2. Check movements for warehouses
  const whMov = await pg.query(`
    SELECT l.code, l.external_id, COUNT(m.id) AS movements
    FROM locations l
    LEFT JOIN inventory_movements m ON m.location_id = l.id
    WHERE l.type = 'WAREHOUSE'
    GROUP BY l.id, l.code, l.external_id
  `);
  console.log('\n[PG] Warehouse movements:');
  whMov.rows.forEach(r => console.log(`  ${r.code} (ext_id=${r.external_id}) → ${r.movements} movements`));

  // 3. Check SQL Server GoodsReceipt loc_codes for warehouse locations
  try {
    const pool = await sql.connect(mssqlConfig);
    const grLocs = await pool.request().query(`
      SELECT DISTINCT gr.loc_code, COUNT(*) AS receipts, SUM(grd.qty_received) AS total_qty
      FROM GoodsReceipt gr
      JOIN GoodsReceiptDetails grd ON grd.receipt_no = gr.receipt_no
      JOIN LocationMaster lm ON lm.loc_code = gr.loc_code
      WHERE lm.loc_type IN ('WAREHOUSE','WH')
      GROUP BY gr.loc_code
      ORDER BY gr.loc_code
    `);
    console.log('\n[MSSQL] GoodsReceipt warehouse loc_codes:');
    grLocs.recordset.forEach(r => console.log(`  loc_code=${r.loc_code} → ${r.receipts} receipts, ${r.total_qty} total qty`));

    // 4. Check if those loc_codes exist in PostgreSQL
    for (const r of grLocs.recordset) {
      const pg_check = await pg.query('SELECT id, code FROM locations WHERE external_id = $1', [r.loc_code]);
      if (pg_check.rows.length === 0) {
        console.log(`  ⚠️  loc_code="${r.loc_code}" NOT FOUND in PG locations.external_id`);
      } else {
        console.log(`  ✅  loc_code="${r.loc_code}" → PG id=${pg_check.rows[0].id}, code=${pg_check.rows[0].code}`);
      }
    }

    // 5. Check ALL loc_codes used in GoodsReceipt (not just warehouse)
    const allGrLocs = await pool.request().query(`
      SELECT DISTINCT loc_code FROM GoodsReceipt ORDER BY loc_code
    `);
    console.log('\n[MSSQL] All loc_codes in GoodsReceipt:');
    const allLocCodes = allGrLocs.recordset.map(r => r.loc_code);
    console.log('  ' + allLocCodes.join(', '));

    // 6. Check LocationMaster for warehouse entries
    const lmWh = await pool.request().query(`
      SELECT loc_code, loc_name, loc_type FROM LocationMaster WHERE loc_type IN ('WAREHOUSE','WH')
    `);
    console.log('\n[MSSQL] LocationMaster warehouse entries:');
    lmWh.recordset.forEach(r => console.log(`  loc_code=${r.loc_code} | name=${r.loc_name} | type=${r.loc_type}`));

    await pool.close();
  } catch (e) {
    console.log('\n[MSSQL] Connection failed:', e.message);
  }

  console.log('\n===== ALERTS DIAGNOSTIC =====');
  const alertStats = await pg.query(`
    SELECT
      COUNT(*) FILTER (WHERE qty_on_hand = 0) AS out_of_stock,
      COUNT(*) FILTER (WHERE safety_stock > 0 AND qty_on_hand <= safety_stock) AS below_safety,
      COUNT(*) FILTER (WHERE safety_stock = 0) AS no_threshold,
      MIN(qty_on_hand) AS min_qty, MAX(qty_on_hand) AS max_qty,
      ROUND(AVG(qty_on_hand),1) AS avg_qty
    FROM inventory_snapshot
  `);
  console.log('\n[PG] Snapshot alert stats:', alertStats.rows[0]);

  console.log('\n===== DATE / TREND DIAGNOSTIC =====');
  const dateDiag = await pg.query(`
    SELECT
      MIN(moved_at)::date AS earliest_movement,
      MAX(moved_at)::date AS latest_movement,
      NOW()::date AS today,
      (NOW()::date - MAX(moved_at)::date) AS gap_days,
      COUNT(*) FILTER (WHERE moved_at >= NOW() - INTERVAL '14 days') AS last_14_days,
      COUNT(*) FILTER (WHERE moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '14 days') AS relative_14_days
    FROM inventory_movements
  `);
  console.log('\n[PG] Movement date stats:', dateDiag.rows[0]);

  await pg.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
