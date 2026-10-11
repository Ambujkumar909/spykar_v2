/**
 * esalesStock.js — load the ESales partner stock workbooks into Postgres
 * ─────────────────────────────────────────────────────────────────────────────
 * Source: a folder of "E-Sales <month>.xlsx" files (the OneDrive ESales_Stock
 * folder, mirrored locally). Only the "Consolidate" sheet is read:
 *
 *     Partner | barcode | Qty | Date        ← one stock snapshot per workbook
 *
 * ACCURACY RULES (a file either loads exactly or not at all):
 *   • every non-blank row is kept — repeated partner+barcode rows are SUMMED
 *     (that is how the workbooks' own pivot totals are built), zero and
 *     negative quantities included;
 *   • a row with a missing/non-integer Qty, a missing Partner, or a Date that
 *     is not an Excel date rejects the WHOLE file, naming the row;
 *   • a workbook must hold exactly one Date, and no two workbooks may claim
 *     the same Date (it would double count);
 *   • after writing, Σ qty and the row count in Postgres are compared with the
 *     sheet inside the same transaction — any difference rolls it back.
 *   A rejected file leaves its previously loaded version untouched.
 *
 * CHANGE DETECTION: esales_files keeps each workbook's sha256. Unchanged files
 * are skipped; a changed file replaces its snapshot; a new file is added.
 *
 * Barcodes are stored as written (trimmed). SKU attributes + MRP live in
 * esales_items, a slim copy of the item master for just these barcodes,
 * rebuilt after every load and whenever the item master is refreshed — as is
 * esales_stock_wide, the pre-joined copy the page queries.
 *
 * A workbook whose file name says one month while its Date column says
 * another still loads on the Date (the data wins) — and is reported as a
 * warning, because one of the two is a typo.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');
const { query } = db;
const { readSheet } = require('./xlsxLite');

const SHEET = 'consolidate';
const HEADER = ['partner', 'barcode', 'qty', 'date'];
// Excel serial bounds for a believable snapshot date: 2015-01-01 … 2100-01-01.
const SERIAL_MIN = 42005;
const SERIAL_MAX = 73051;

// Marketplace grouping for a partner name ("Flipkart India Pvt Ltd (SOR) -UJ"
// → Flipkart). First word, with the few names that need more than that.
// Stored on esales_partners.channel when a partner is first seen; edit the row
// to regroup — the loader never overwrites it.
const CHANNEL_NAMES = { big: 'Big Basket', knotnow: 'KnotNow', reliance: 'Reliance Retail' };
function channelOf(partner) {
  const first = partner.split(/[\s-]+/)[0] || partner;
  return CHANNEL_NAMES[first.toLowerCase()] || first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

// Excel serial → ISO date (UTC arithmetic: no timezone drift).
function serialToISO(serial, date1904) {
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  return new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
}

// A barcode cell: numbers come through as "8905566067660" (or, from some
// writers, "8905566067660.0" / "8.90556606766E12"); text is kept verbatim.
// Excel cannot keep a leading zero on a NUMBER, so a 12-digit numeric barcode
// is an EAN-13 that lost its "0" (the item master has a few) — put it back.
function barcodeText(cell) {
  if (!cell) return '';
  const raw = String(cell.v).trim();
  if (cell.t !== 'n') return raw;
  let digits = raw;
  if (!/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) return raw;
    digits = String(n);
  }
  return digits.length === 12 ? `0${digits}` : digits;
}

/**
 * Parse one workbook. Throws (with the row number) on anything that would make
 * the load inexact. Pure — touches no database.
 * @returns {{ snapshotDate: string, lines: number, units: number,
 *             rows: Array<{ partner: string, barcode: string, qty: number, lines: number }> }}
 */
function parseWorkbook(buf) {
  const { rows, date1904 } = readSheet(buf, (name) => clean(name).toLowerCase() === SHEET);
  const head = rows.find((r) => r.cells.some(Boolean));
  const got = head ? HEADER.map((_, i) => (head.cells[i] ? clean(head.cells[i].v).toLowerCase() : '')) : [];
  if (!head || HEADER.some((h, i) => got[i] !== h)) {
    throw new Error(`"Consolidate" header must be Partner | barcode | Qty | Date — found: ${got.join(' | ') || '(empty sheet)'}`);
  }

  const agg = new Map();
  let lines = 0; let units = 0; let snapshotDate = null;
  for (const row of rows) {
    if (row === head) continue;
    const [p, b, q, d] = [0, 1, 2, 3].map((i) => row.cells[i]);
    if (!p && !b && !q && !d) continue;                       // blank spacer row
    const where = `row ${row.r}`;

    const partner = p ? clean(p.v) : '';
    if (!partner) throw new Error(`${where}: Partner is empty`);

    if (!q || q.t !== 'n') throw new Error(`${where}: Qty is ${q ? `not a number ("${q.v}")` : 'empty'}`);
    const qty = Number(q.v);
    if (!Number.isInteger(qty) || Math.abs(qty) > 1e7) throw new Error(`${where}: Qty "${q.v}" is not a whole number`);

    if (!d || d.t !== 'n') throw new Error(`${where}: Date is ${d ? `not an Excel date ("${d.v}")` : 'empty'}`);
    const serial = Number(d.v);
    if (!(serial >= SERIAL_MIN && serial < SERIAL_MAX)) throw new Error(`${where}: Date "${d.v}" is out of range`);
    const iso = serialToISO(serial, date1904);
    if (snapshotDate && iso !== snapshotDate) throw new Error(`${where}: Date ${iso} differs from ${snapshotDate} — a workbook must hold one snapshot date`);
    snapshotDate = iso;

    const barcode = barcodeText(b);
    const key = `${partner}\u0000${barcode}`;
    const cur = agg.get(key);
    if (cur) { cur.qty += qty; cur.lines += 1; } else agg.set(key, { partner, barcode, qty, lines: 1 });
    lines += 1; units += qty;
  }
  if (!lines) throw new Error('"Consolidate" sheet has no data rows');
  return { snapshotDate, lines, units, rows: [...agg.values()] };
}

// "E-Sales SEPT 25.xlsx" should hold a September-2025 date. Returns a warning
// when the month/year in the file name disagrees with the snapshot date.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function nameDateMismatch(file, iso) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{2})\b/i.exec(file);
  if (!m) return null;
  const named = `20${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
  return named === iso.slice(0, 7) ? null : `file name says ${named} but its Date column says ${iso} — loaded as ${iso}; fix whichever is the typo`;
}

// ── derived data: esales_items (item master narrowed to ESales barcodes) and
//    esales_stock_wide (the pre-joined rows the page reads) ───────────────────
// Fingerprint of the loaded workbooks; esales_meta remembers which set the
// derived data was built from, so the API can tell when it is behind.
const FILES_MD5 = `SELECT md5(COALESCE(string_agg(sha256 || snapshot_date, ',' ORDER BY file_name), '')) FROM esales_files`;
const ITEMS_LOCK = 734001;   // advisory lock: one rebuild at a time
async function rebuildItems(client) {
  const run = async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [ITEMS_LOCK]);
    await c.query('DELETE FROM esales_items');
    const r = await c.query(`
      INSERT INTO esales_items (barcode, sku, mrp, category_norm, gender_name, product, sub_product, size, color_name, shade, style, season)
      SELECT b.barcode, s.external_id, s.mrp, s.category_norm, s.gender_name, s.product, s.sub_product, s.size, s.color_name, s.shade, s.style, s.season
        FROM (SELECT DISTINCT barcode FROM esales_stock) b
        -- Exact EAN, or an EAN carrying a marketplace suffix ("8907966850859_2").
        JOIN skus s ON s.external_id = CASE WHEN b.barcode ~ '^[0-9]{13}[^0-9]' THEN left(b.barcode, 13) ELSE b.barcode END`);
    // Fresh planner stats: without them the first queries after a load pick
    // nested loops over tens of thousands of rows (seconds instead of ms).
    await c.query('ANALYZE esales_items');
    await c.query('ANALYZE esales_stock');
    await c.query('REFRESH MATERIALIZED VIEW esales_stock_wide');   // what the page reads (migration 034)
    await c.query('ANALYZE esales_stock_wide');
    await c.query('REFRESH MATERIALIZED VIEW esales_ageing');       // Inventory Ageing → ESales (migration 035)
    await c.query('ANALYZE esales_ageing');
    await c.query(`INSERT INTO esales_meta (id, items_built_at, files_md5) VALUES (TRUE, clock_timestamp(), (${FILES_MD5}))
                   ON CONFLICT (id) DO UPDATE SET items_built_at = EXCLUDED.items_built_at, files_md5 = EXCLUDED.files_md5`);
    return r.rowCount;
  };
  if (client) return run(client);
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const n = await run(c);
    await c.query('COMMIT');
    return n;
  } catch (err) { await c.query('ROLLBACK').catch(() => {}); throw err; } finally { c.release(); }
}

// ── one workbook → Postgres, all-or-nothing ──────────────────────────────────
async function writeSnapshot(client, fileName, sha256, parsed, present) {
  const clash = (await client.query(
    'SELECT file_name FROM esales_files WHERE snapshot_date = $1 AND file_name <> $2', [parsed.snapshotDate, fileName])).rows[0];
  if (clash) {
    // The other file is still in the folder → two workbooks, one date: refuse.
    // It is gone → this is that workbook renamed: take its place.
    if (present.has(clash.file_name)) {
      throw new Error(`snapshot date ${parsed.snapshotDate} is already loaded from "${clash.file_name}" — two workbooks cannot share a date`);
    }
    await client.query('DELETE FROM esales_files WHERE file_name = $1', [clash.file_name]);
  }
  await client.query('DELETE FROM esales_files WHERE file_name = $1', [fileName]);   // cascades to esales_stock
  await client.query(
    'INSERT INTO esales_files (file_name, sha256, snapshot_date, lines, units) VALUES ($1, $2, $3, $4, $5)',
    [fileName, sha256, parsed.snapshotDate, parsed.lines, parsed.units]);

  const names = [...new Set(parsed.rows.map((r) => r.partner))];
  await client.query(
    `INSERT INTO esales_partners (name, channel) SELECT n, c FROM unnest($1::text[], $2::text[]) AS t(n, c)
     ON CONFLICT (name) DO NOTHING`, [names, names.map(channelOf)]);
  const ids = new Map((await client.query('SELECT id, name FROM esales_partners WHERE name = ANY($1::text[])', [names]))
    .rows.map((r) => [r.name, r.id]));

  await client.query(
    `INSERT INTO esales_stock (snapshot_date, partner_id, barcode, qty, lines)
     SELECT $1::date, t.p, t.b, t.q, t.l FROM unnest($2::smallint[], $3::text[], $4::int[], $5::int[]) AS t(p, b, q, l)`,
    [parsed.snapshotDate, parsed.rows.map((r) => ids.get(r.partner)), parsed.rows.map((r) => r.barcode),
      parsed.rows.map((r) => r.qty), parsed.rows.map((r) => r.lines)]);

  const chk = (await client.query(
    'SELECT COALESCE(SUM(qty), 0)::bigint AS units, COALESCE(SUM(lines), 0)::bigint AS lines FROM esales_stock WHERE snapshot_date = $1',
    [parsed.snapshotDate])).rows[0];
  if (Number(chk.units) !== parsed.units || Number(chk.lines) !== parsed.lines) {
    throw new Error(`reconcile failed: sheet has ${parsed.lines} rows / ${parsed.units} units, database has ${chk.lines} / ${chk.units}`);
  }
}

/**
 * Load every workbook in `dir` that is new or changed.
 * @param {string} dir
 * @param {{ prune?: boolean, dryRun?: boolean, log?: (s: string) => void }} [opts]
 *   prune  — also remove snapshots whose workbook is no longer in the folder
 *   dryRun — parse + validate only, write nothing
 * @returns {{ added: string[], updated: string[], unchanged: string[], removed: string[], missing: string[],
 *             failed: Array<{ file: string, error: string }>, warnings: Array<{ file: string, warning: string }> }}
 */
async function loadFolder(dir, { prune = false, dryRun = false, log = () => {} } = {}) {
  const files = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort();
  if (!files.length) throw new Error(`no .xlsx workbooks in ${dir}`);   // never prune against an empty/wrong folder
  const present = new Set(files);
  const loaded = (await query('SELECT file_name, sha256, snapshot_date::text AS d FROM esales_files')).rows;
  const known = new Map(loaded.map((r) => [r.file_name, r.sha256]));
  const dates = new Map(loaded.map((r) => [r.file_name, r.d]));
  const out = { added: [], updated: [], unchanged: [], removed: [], missing: [], failed: [], warnings: [] };

  for (const file of files) {
    try {
      const buf = fs.readFileSync(path.join(dir, file));
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (known.get(file) === sha256) { out.unchanged.push(file); continue; }
      const parsed = parseWorkbook(buf);
      const kind = known.has(file) ? 'updated' : 'added';
      if (!dryRun) {
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');
          await writeSnapshot(client, file, sha256, parsed, present);
          await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
      }
      out[kind].push(file);
      dates.set(file, parsed.snapshotDate);
      log(`  ${kind === 'added' ? '+' : '*'} ${file} — ${parsed.snapshotDate} · ${parsed.lines} rows · ${parsed.units} units`);
    } catch (err) {
      out.failed.push({ file, error: err.message });
      log(`  ! ${file} — ${err.message}`);
    }
  }

  for (const file of files) {
    const warning = dates.has(file) ? nameDateMismatch(file, dates.get(file)) : null;
    if (warning) { out.warnings.push({ file, warning }); log(`  ⚠ ${file} — ${warning}`); }
  }

  // Workbooks loaded earlier that are no longer in the folder.
  const gone = (await query('SELECT file_name FROM esales_files WHERE NOT (file_name = ANY($1::text[]))', [files])).rows.map((r) => r.file_name);
  if (prune && !dryRun && gone.length) {
    await query('DELETE FROM esales_files WHERE file_name = ANY($1::text[])', [gone]);
    out.removed = gone;
  } else out.missing = gone;
  for (const f of gone) log(`  ${prune && !dryRun ? '-' : '?'} ${f} — no longer in the folder${prune ? '' : ' (kept; pass --prune to remove)'}`);

  if (!dryRun && (out.added.length || out.updated.length || out.removed.length)) await rebuildItems();
  return out;
}

module.exports = { parseWorkbook, loadFolder, rebuildItems, channelOf, nameDateMismatch, FILES_MD5 };
