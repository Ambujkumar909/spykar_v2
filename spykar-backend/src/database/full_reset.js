/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  SPYKAR — Full Database Reset                           ║
 * ║  Wipes ALL data. Schema (tables) are preserved.         ║
 * ║  Run ONLY before a brand-new pipeline load.             ║
 * ║  Usage: node src/database/full_reset.js --confirm       ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

if (!process.argv.includes('--confirm')) {
  console.error('\n⛔  Safety lock: pass --confirm to proceed with full reset.\n');
  process.exit(1);
}

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT) || 5433,
  database: process.env.PG_DATABASE || 'spykar_inventory',
  user:     process.env.PG_USER     || 'spykar_app',
  password: process.env.PG_PASSWORD,
});

async function fullReset() {
  const client = await pool.connect();
  const start  = Date.now();

  console.log('\n══════════════════════════════════════════════════');
  console.log('  SPYKAR — FULL DATABASE RESET');
  console.log('══════════════════════════════════════════════════\n');

  try {
    await client.query('BEGIN');

    // Order matters — respect FK constraints (children before parents)
    // NOTE: users table is intentionally excluded — accounts survive a data reset
    const tables = [
      'stock_ageing',
      'inventory_movements',
      'inventory_snapshot',
      'dispatch_line_items',
      'dispatch_orders',
      'sync_logs',
      'stock_alerts',
      'skus',
      'locations',
      'zones',
    ];

    for (const t of tables) {
      // Use a savepoint per table — if table doesn't exist, rollback only that step
      await client.query(`SAVEPOINT sp_${t}`);
      try {
        await client.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
        await client.query(`RELEASE SAVEPOINT sp_${t}`);
        console.log(`  ✓ Truncated: ${t}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT sp_${t}`);
        await client.query(`RELEASE SAVEPOINT sp_${t}`);
        if (err.code === '42P01') {
          console.log(`  — Skipped (not found): ${t}`);
        } else {
          throw err;
        }
      }
    }

    // Also clear migration history so schema re-runs cleanly if needed
    // (keep _migrations so schema.sql doesn't re-run — we only clear data, not structure)
    // Uncomment below ONLY if you want to fully drop and recreate schema:
    // await client.query(`DELETE FROM _migrations WHERE filename = 'schema.sql'`);

    await client.query('COMMIT');

    const ms = Date.now() - start;
    console.log(`\n✅ All tables cleared in ${ms}ms`);
    console.log('\nNext steps:');
    console.log('  1. node src/database/load_item_master.js --force');
    console.log('  2. node src/database/load_party_master.js --force');
    console.log('  3. npm run sync:full\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Reset failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

fullReset().catch(() => process.exit(1));
