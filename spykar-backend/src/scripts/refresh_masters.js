/**
 * refresh_masters.js — run the SKU + store master refresh by hand
 *
 *   npm run masters:refresh            runs only if due (MASTER_REFRESH_EVERY_DAYS, default 3)
 *   npm run masters:refresh -- --force runs now regardless of cadence
 *
 * Same code path the nightly sync uses (src/services/masterRefresh.js): both
 * loaders with --force, row-floor guarded, state recorded in master_refresh_state.
 * Afterwards run `npm run primary:remap` (or let the next sync do it) so
 * previously unmappable primary-sales rows are loaded.
 */
'use strict';
require('dotenv').config();
const { pool } = require('../config/database');
const mr = require('../services/masterRefresh');

(async () => {
  const r = await mr.refreshMastersIfDue({ force: process.argv.includes('--force') });
  if (r.skipped) console.log(`Skipped — ${r.reason}. Last success ${r.lastSuccessAt?.toISOString() || 'never'}, next due ${r.nextDueAt?.toISOString() || 'now'}. Use --force to run anyway.`);
  else console.log(`Ran: ${r.ran.join(', ') || '—'}; failed: ${r.failed.join(', ') || '—'}; skuMapChanged=${r.skuMapChanged} skuPriceChanged=${r.skuPriceChanged} (${r.seconds}s)`);
  await pool.end().catch(() => {});
  process.exit(r.failed && r.failed.length ? 1 : 0);
})().catch(async (e) => { console.error('❌', e.message || e); await pool.end().catch(() => {}); process.exit(1); });
