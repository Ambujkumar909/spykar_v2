/**
 * Sales + returns history reload (store ERP only).
 * Re-pulls SalesAI / SalesReturnAI from Jan 2024 → today and merges onto the
 * existing movements in place (no truncate — the dashboard stays up), then
 * rebuilds the sales rollups. Stock, ageing and primary sales are not touched.
 * Usage: node --max-old-space-size=8192 src/scripts/reload_sales_history.js
 * Restart the API afterwards to flush its in-process cache.
 */
'use strict';
require('dotenv').config();
process.env.PG_STATEMENT_TIMEOUT = '0';   // multi-minute merges must not be capped
const { query, pool } = require('../config/database');
const E = require('../services/syncEngine');
const { rebuildAll } = require('../services/salesRollup');

(async () => {
  // Same liveness lock as the scheduled sync, so the two can never overlap.
  const lock = await pool.connect();
  const got = (await lock.query('SELECT pg_try_advisory_lock($1, $2) AS got', [E.SYNC_LOCK_CLASSID, E.SYNC_LOCK_OBJID])).rows[0].got;
  if (!got) throw new Error('A sync is already running — try again when it finishes');

  const erp = await E.tryConnectSqlServer();
  if (!erp) throw new Error('SQL Server (store ERP) unreachable — nothing changed');
  const stats = { fetched: 0, inserted: 0, updated: 0, failed: 0 };
  try {
    const maps = await E.buildLookupMaps({ includeInactive: true });
    const to = new Date(); to.setHours(23, 59, 59, 999);
    await E.syncSalesChunked(erp, maps, E.FULL_HISTORY_START, to, stats);
    await E.syncReturnsChunked(erp, maps, E.FULL_HISTORY_START, to, stats);
  } finally { await erp.close().catch(() => {}); }
  if (stats.chunkFailures) throw new Error(`${stats.chunkFailures} monthly chunk(s) failed — re-run (the merge is idempotent)`);

  await query('VACUUM (ANALYZE) inventory_movements');
  const c = await pool.connect();
  try { await c.query('BEGIN'); console.log('rollups', await rebuildAll(c)); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }

  // Rows the ERP no longer returns keep their old value and no gst_amount.
  const left = (await query(`SELECT COUNT(*)::int n, COALESCE(SUM(sale_value),0) v FROM inventory_movements
                              WHERE movement_type IN ('SALE','RETURN') AND gst_amount IS NULL`)).rows[0];
  console.log(`merged ${stats.inserted.toLocaleString()} rows; not re-pulled (no gst_amount): ${left.n} rows, ₹${left.v}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
