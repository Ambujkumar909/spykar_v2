require('dotenv').config();
const { query } = require('./src/config/database');

async function check() {
  try {
    const res = await query(`
      SELECT
        movement_type,
        COUNT(*) AS total_rows,
        COUNT(DISTINCT DATE_TRUNC('day', moved_at)) AS distinct_days,
        MIN(moved_at) AS min_date,
        MAX(moved_at) AS max_date
      FROM inventory_movements
      WHERE moved_at >= '2026-05-01'::date AND moved_at < '2026-05-30'::date
      GROUP BY movement_type
    `);
    console.log("=== MOVEMENT STATS FOR MAY 2026 ===");
    console.log(JSON.stringify(res.rows, null, 2));

    // List all distinct sale days in May 2026 where movement_type = 'SALE'
    const daysRes = await query(`
      SELECT DISTINCT DATE_TRUNC('day', moved_at)::date AS sale_date, COUNT(*) AS tx_count
      FROM inventory_movements
      WHERE moved_at >= '2026-05-01'::date AND moved_at < '2026-05-30'::date
        AND movement_type = 'SALE'
      GROUP BY 1
      ORDER BY 1
    `);
    console.log("\n=== DISTINCT SALE DAYS IN MAY 2026 ===");
    console.log(JSON.stringify(daysRes.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
check();
