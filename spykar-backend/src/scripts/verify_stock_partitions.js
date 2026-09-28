// Stock-history partitions: fresh DB → archive months migration 007 never created. Run: node src/scripts/verify_stock_partitions.js
require('dotenv').config();
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const DB = 'spykar_partition_test';
process.env.LOG_LEVEL = 'error';
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const admin = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT || 5432, user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  const mig = spawnSync(process.execPath, [require('path').join(__dirname, '..', 'database', 'migrate.js')], { env: { ...process.env, PG_DATABASE: DB }, encoding: 'utf8' });
  assert(/completed successfully/.test(mig.stdout), 'fresh DB migrated');
  process.env.PG_DATABASE = DB;
  const { query, pool } = require('../config/database');
  const H = require('../services/historicalStockLoader');
  // one real row in inventory_snapshot so the archive has something to copy
  await query(`INSERT INTO locations (code, name, type, external_id) VALUES ('L1','Store 1','WAREHOUSE','L1')`);
  await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, external_id) VALUES ('S1','P','B','Black','32',1,'S1')`);
  await query(`INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand) SELECT l.id, s.id, 7 FROM locations l, skus s`);
  const parts = async () => (await query(`SELECT count(*)::int c FROM pg_inherits WHERE inhparent = 'inventory_daily_snapshot'::regclass`)).rows[0].c;
  const before = await parts();
  for (const d of ['2026-09-28', '2026-12-31', '2027-01-01', '2026-09-29']) {
    let err = null; let n = 0;
    try { n = await H.archiveCurrentSnapshot(d); } catch (e) { err = e.message; }
    assert(!err && n === 1, `archive ${d} → ${err || n + ' row'}`);
  }
  assert(await parts() === before + 3, `exactly 3 new partitions (Sep, Dec 2026, Jan 2027): ${before} → ${await parts()}`);
  const rows = (await query(`SELECT snapshot_date::text d, tableoid::regclass::text p FROM inventory_daily_snapshot ORDER BY 1`)).rows;
  assert(rows.map((r) => `${r.d}@${r.p}`).join(',') === '2026-09-28@inventory_daily_snapshot_2026_09,2026-09-29@inventory_daily_snapshot_2026_09,2026-12-31@inventory_daily_snapshot_2026_12,2027-01-01@inventory_daily_snapshot_2027_01', `rows land in the right month partitions`);
  await Promise.all([H.ensureMonthPartition('2027-05-10'), H.ensureMonthPartition('2027-05-20')]);
  assert(await parts() === before + 4, 'two concurrent creates of the same month → one partition, no error');
  let bad = null; try { await H.ensureMonthPartition("2026-09-28'; DROP TABLE skus; --"); } catch (e) { bad = e.message; }
  assert(bad === null || /bad date/.test(bad), 'date is regex-parsed, never interpolated raw');
  assert((await query(`SELECT to_regclass('skus') IS NOT NULL AS ok`)).rows[0].ok, 'skus still exists');
  await pool.end();
  await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`); await admin.end();
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
