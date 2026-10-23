// ─── load_war_room_targets.js — day-wise store targets → wr_targets ─────────
// Reads every .xlsx in the target folder (WR_TARGET_DIR, default the OneDrive
// mirror ~/spykar/onedrive/Target_Data/DaywiseTarget), first sheet, columns
// found by header name: Code, Date, Qty, Value (others ignored).
//
//   • rows without a real store code (#N/A, NSO, blank) or a valid date are skipped and counted
//   • a store-day listed twice: identical copies count once; differing copies are added and reported
//   • two files with the same store-day: the newer file wins
//   • a file with under half the previous load's store-days is REFUSED (the current targets stay)
//     unless --force — protects against a truncated or wrong upload
//   • unchanged files (same sha256 as the last load) are skipped unless --force
// The table is replaced in one transaction.
//   node src/database/load_war_room_targets.js [--force]
require('dotenv').config();
process.env.PG_STATEMENT_TIMEOUT = '0';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const copyFrom = require('pg-copy-streams').from;
const { pool, query } = require('../config/database');
const { readSheet } = require('../services/xlsxLite');

const DIR = process.env.WR_TARGET_DIR || path.join(os.homedir(), 'spykar/onedrive/Target_Data/DaywiseTarget');
const force = process.argv.includes('--force');
const serialISO = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 864e5).toISOString().slice(0, 10);
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

async function main() {
  const files = (fs.existsSync(DIR) ? fs.readdirSync(DIR) : [])
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => ({ f, p: path.join(DIR, f), m: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => a.m - b.m);                                   // oldest first → newer files override
  if (!files.length) { console.log(`No target workbook in ${DIR} — nothing loaded, current targets kept.`); return 0; }
  const bufs = files.map((x) => fs.readFileSync(x.p));
  const sha = crypto.createHash('sha256');
  files.forEach((x, i) => sha.update(`${x.f}\0`).update(crypto.createHash('sha256').update(bufs[i]).digest('hex')));
  const digest = sha.digest('hex');
  const { rows: [last] } = await query('SELECT sha256, store_days FROM wr_target_loads ORDER BY id DESC LIMIT 1');
  if (last && last.sha256 === digest && !force) { console.log('Targets unchanged since the last load — skipped.'); return 0; }

  const T = new Map();            // code|date → [qty, val]
  const skipped = { no_store_code: 0, bad_date: 0, bad_number: 0, identical_duplicates: 0, summed_duplicates: 0, examples: [] };
  let read = 0;
  for (const [i, x] of files.entries()) {
    const { rows } = readSheet(bufs[i], () => true);
    if (!rows.length) continue;
    const hdr = rows[0].cells.map((c) => String(c?.v ?? '').trim().toLowerCase());
    const col = (...names) => hdr.findIndex((h) => names.includes(h));
    const C = { code: col('code', 'store code'), date: col('date'), qty: col('qty', 'quantity', 'target qty'), val: col('value', 'target value', 'val') };
    if (Object.values(C).some((v) => v < 0)) throw new Error(`${x.f}: expected columns Code, Date, Qty, Value — found ${hdr.filter(Boolean).join(', ')}`);
    const fileMap = new Map();
    for (const r of rows.slice(1)) {
      const g = (k) => r.cells[C[k]]?.v;
      const code = String(g('code') ?? '').trim();
      if (!code && g('date') == null) continue;                   // blank row
      read++;
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(code) || code.toUpperCase() === 'NSO') { skipped.no_store_code++; continue; }
      const rawD = g('date'); const d = /^\d+(\.\d+)?$/.test(String(rawD)) ? serialISO(rawD) : String(rawD || '').slice(0, 10);
      if (!isISO(d) || d < '2000-01-01' || d > '2100-12-31') { skipped.bad_date++; continue; }
      const q = g('qty') == null || g('qty') === '' ? 0 : Number(g('qty')); const v = g('val') == null || g('val') === '' ? 0 : Number(g('val'));
      if (!Number.isFinite(q) || !Number.isFinite(v)) { skipped.bad_number++; continue; }
      const k = `${code}|${d}`; const prev = fileMap.get(k);
      if (!prev) fileMap.set(k, [q, v]);
      else if (prev[0] === q && prev[1] === v) skipped.identical_duplicates++;
      else { prev[0] += q; prev[1] += v; skipped.summed_duplicates++; if (skipped.examples.length < 10) skipped.examples.push(`${x.f}: ${code} ${d}`); }
    }
    for (const [k, a] of fileMap) T.set(k, a);                    // newer file wins
  }
  const storeDays = T.size;
  const stores = new Set([...T.keys()].map((k) => k.split('|')[0])).size;
  const dates = [...T.keys()].map((k) => k.split('|')[1]).sort();
  if (!storeDays) throw new Error('No usable target rows — nothing loaded, current targets kept.');
  if (last && storeDays < last.store_days * 0.5 && !force) {
    throw new Error(`Refused: ${storeDays.toLocaleString()} store-days vs ${Number(last.store_days).toLocaleString()} in the last load (under half). Current targets kept; run with --force if this is intended.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE wr_targets');
    const lines = [...T].map(([k, [q, v]]) => { const [c, d] = k.split('|'); return `${c}\t${d}\t${q}\t${v}\n`; });
    await pipeline(Readable.from(lines), client.query(copyFrom('COPY wr_targets (external_id, target_date, qty, val) FROM STDIN')));
    await client.query(`INSERT INTO wr_target_loads (files, sha256, rows_read, store_days, stores, date_from, date_to, skipped)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [files.map((x) => x.f).join(', '), digest, read, storeDays, stores, dates[0], dates[dates.length - 1], JSON.stringify(skipped)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  const { rows: [chk] } = await query('SELECT COUNT(*)::int AS n, SUM(qty)::float AS q, SUM(val)::float AS v FROM wr_targets');
  const sq = [...T.values()].reduce((a, x) => a + x[0], 0); const sv = [...T.values()].reduce((a, x) => a + x[1], 0);
  if (chk.n !== storeDays || Math.abs(chk.q - sq) > 0.5 || Math.abs(chk.v - sv) > 0.5) throw new Error(`Post-load check failed: table ${chk.n}/${chk.q}/${chk.v} vs file ${storeDays}/${sq}/${sv}`);
  console.log(`Targets loaded from ${files.map((x) => x.f).join(', ')}: ${storeDays.toLocaleString()} store-days, ${stores} stores, ${dates[0]} → ${dates[dates.length - 1]}, `
    + `₹${Math.round(sv).toLocaleString('en-IN')} · ${Math.round(sq).toLocaleString('en-IN')} units · skipped ${JSON.stringify(skipped)} · table matches the file.`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`Target load failed: ${e.message}`); process.exit(1); });
