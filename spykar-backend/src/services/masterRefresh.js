/**
 * masterRefresh.js — scheduled refresh of the SKU + store masters
 * ─────────────────────────────────────────────────────────────────────────────
 * The ERP's Item_spykar (→ skus) and AIgetParty (→ locations) change all the
 * time, but the two loaders were one-time manual scripts: every master change
 * silently dropped rows in every sync ("SKU_NOT_IN_MASTER") until someone
 * remembered to run them. This module runs both loaders (as child processes,
 * exactly like the CLI, with --force) every MASTER_REFRESH_EVERY_DAYS days from
 * the sync, remembers when it last succeeded in master_refresh_state, and tells
 * the caller WHAT changed so the dependent layers can heal:
 *
 *   • skuMapChanged   — item codes / active flags changed → primary-sales
 *                       `remap()` can now load previously unmappable rows.
 *   • skuPriceChanged — mrp / cost_price / category_norm changed → the
 *                       primary-sales rollups (which bake those in) must be
 *                       rebuilt (off-lock swap).
 *
 * Both loaders carry a ROW-FLOOR GUARD (floorOk below): a partial ERP result
 * (fewer than MASTER_FLOOR_FRACTION of the current rows) aborts the loader
 * without touching anything — so an ERP hiccup can never soft-archive half the
 * stores or deactivate the catalogue. The guard exits with code 3.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { query } = require('../config/database');
const logger = require('../config/logger');

const LOADERS = [
  { name: 'locations', script: 'load_party_master.js', table: 'locations' },
  { name: 'skus',      script: 'load_item_master.js',  table: 'skus' },
];
const EXIT_FLOOR = 3;

const everyDaysDefault = () => Math.max(1, parseInt(process.env.MASTER_REFRESH_EVERY_DAYS, 10) || 3);
const floorFraction = () => {
  const f = parseFloat(process.env.MASTER_FLOOR_FRACTION);
  return Number.isFinite(f) && f > 0 && f <= 1 ? f : 0.9;
};

// Pure: is a fetched master big enough to be trusted against what we hold?
// Small/empty targets (first load) always pass.
function floorOk(fetched, existing, fraction = floorFraction(), minExisting = 10) {
  if (!(existing > minExisting)) return true;
  return fetched >= Math.ceil(existing * fraction);
}

// Fingerprints of the SKU master: what the primary-sales mapping depends on,
// and what its rollups bake in. ~0.5s on 300k rows.
async function skuFingerprints() {
  const r = await query(`
    SELECT md5(COALESCE(string_agg(concat_ws('|', external_id, upper(infor_item_code), upper(style_variant), is_active::text), ',' ORDER BY id), '')) AS map_fp,
           md5(COALESCE(string_agg(concat_ws('|', id::text, mrp::text, cost_price::text, category_norm), ',' ORDER BY id), '')) AS price_fp,
           count(*)::int AS n
      FROM skus`);
  return r.rows[0];
}
const countRows = async (table) => Number((await query(`SELECT count(*)::bigint AS c FROM ${table}`)).rows[0].c);

// Default runner: spawn the loader like the CLI does. Returns { code, tail }.
function spawnLoader(script) {
  return new Promise((resolve) => {
    const file = path.join(__dirname, '..', 'database', script);
    const child = spawn(process.execPath, ['--max-old-space-size=4096', file, '--force'], {
      cwd: path.join(__dirname, '..', '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (buf) => { tail = (tail + buf.toString()).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (err) => resolve({ code: -1, tail: `${tail}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, tail }));
  });
}

async function lastSuccessAt() {
  const r = await query(`SELECT MIN(last_success_at) AS t, COUNT(*)::int AS n FROM master_refresh_state`);
  // Due if any loader has never succeeded, or the OLDEST success is past the cadence.
  if (!r.rows[0] || r.rows[0].n < LOADERS.length) return null;
  return r.rows[0].t;
}
async function isDue(everyDays = everyDaysDefault(), now = new Date()) {
  const t = await lastSuccessAt();
  if (!t) return { due: true, lastSuccessAt: null, nextDueAt: null };
  const next = new Date(new Date(t).getTime() + everyDays * 86400000);
  return { due: now >= next, lastSuccessAt: new Date(t), nextDueAt: next };
}

// Run both loaders now. `runner(script)` is injectable for tests.
async function refreshMasters({ runner = spawnLoader } = {}) {
  const t0 = Date.now();
  const before = await skuFingerprints();
  const result = { ran: [], failed: [], skuMapChanged: false, skuPriceChanged: false, counts: {}, seconds: 0 };
  for (const l of LOADERS) {
    const rowsBefore = await countRows(l.table);
    const ts = Date.now();
    await query(`INSERT INTO master_refresh_state (name, last_run_at, last_status, rows_before)
                 VALUES ($1, NOW(), 'running', $2)
                 ON CONFLICT (name) DO UPDATE SET last_run_at = NOW(), last_status = 'running', rows_before = EXCLUDED.rows_before`, [l.name, rowsBefore]);
    let out;
    try { out = await runner(l.script); } catch (err) { out = { code: -1, tail: err.message }; }
    const rowsAfter = await countRows(l.table);
    const ok = out.code === 0;
    const status = ok ? 'success' : out.code === EXIT_FLOOR ? 'floor-guard' : 'failed';
    await query(`UPDATE master_refresh_state
                    SET last_status = $2, last_exit_code = $3, rows_after = $4, duration_ms = $5, note = $6,
                        last_success_at = CASE WHEN $2 = 'success' THEN NOW() ELSE last_success_at END
                  WHERE name = $1`, [l.name, status, out.code, rowsAfter, Date.now() - ts, (out.tail || '').split('\n').slice(-6).join('\n')]);
    result.counts[l.name] = { before: rowsBefore, after: rowsAfter };
    if (ok) { result.ran.push(l.name); logger.info(`[MASTER] ✓ ${l.name} refreshed: ${rowsBefore.toLocaleString()} → ${rowsAfter.toLocaleString()} rows in ${((Date.now() - ts) / 1000).toFixed(1)}s`); }
    else { result.failed.push(l.name); logger.error(`[MASTER] ✗ ${l.name} loader ${status} (exit ${out.code}) — nothing changed: ${(out.tail || '').trim().split('\n').slice(-2).join(' | ')}`); }
  }
  const after = await skuFingerprints();
  result.skuMapChanged = before.map_fp !== after.map_fp;
  result.skuPriceChanged = before.price_fp !== after.price_fp;
  result.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  logger.info(`[MASTER] refresh done in ${result.seconds}s — skus ${before.n} → ${after.n}; mapping ${result.skuMapChanged ? 'CHANGED' : 'unchanged'}, prices/categories ${result.skuPriceChanged ? 'CHANGED' : 'unchanged'}`);
  return result;
}

// The sync entry point: run only when the cadence says so (or forced).
async function refreshMastersIfDue({ everyDays = everyDaysDefault(), force = false, runner } = {}) {
  const d = await isDue(everyDays);
  if (!force && !d.due) {
    return { skipped: true, reason: 'not due', lastSuccessAt: d.lastSuccessAt, nextDueAt: d.nextDueAt, skuMapChanged: false, skuPriceChanged: false };
  }
  logger.info(`[MASTER] refresh due (${d.lastSuccessAt ? `last success ${d.lastSuccessAt.toISOString()}, every ${everyDays}d` : 'never run'}) — running both loaders…`);
  return { skipped: false, ...(await refreshMasters({ runner })) };
}

module.exports = { refreshMasters, refreshMastersIfDue, isDue, floorOk, skuFingerprints, LOADERS, EXIT_FLOOR };
