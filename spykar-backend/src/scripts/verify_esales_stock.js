/**
 * verify_esales_stock.js — end-to-end proof for the ESales stock feed
 * ─────────────────────────────────────────────────────────────────────────────
 * DESTRUCTIVE: empties the esales_* tables. Run it on a throwaway Postgres
 * (it refuses the production database), e.g. the private instance on :55432:
 *
 *   PG_HOST=127.0.0.1 PG_PORT=55432 PG_DATABASE=spykar_esales PG_PASSWORD= \
 *   ESALES_VERIFY_DIR=<folder of real workbooks> ESALES_ORACLE_CSV=<csv> \
 *   node src/scripts/verify_esales_stock.js
 *
 * Needs `skus` (and master_refresh_state) in that database.
 *
 *   PART 1  workbook reader + validation rules, on workbooks built in memory
 *   PART 2  loader: add / unchanged / changed / duplicate date / rename /
 *           rejected / prune — and that a rejected file never damages data
 *   PART 3  API numbers on a tiny hand-computed dataset, cache refresh after a
 *           load, item-master refresh picked up
 *   PART 4  (needs ESALES_VERIFY_DIR + ESALES_ORACLE_CSV) the real workbooks:
 *           loader vs an independent reading of the same files (the CSV, made
 *           by tools/oracle_csv.py with Python's own zip/XML parsers), then
 *           every endpoint vs numbers recomputed here from that CSV + skus,
 *           across date windows × filters × dimensions; and the partner totals
 *           vs the pivot tables the workbooks themselves carry.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

if ((process.env.PG_DATABASE || 'spykar_inventory') === 'spykar_inventory' || String(process.env.PG_PORT || '5432') === '5432') {
  console.error('Refusing to run: this harness empties the esales_* tables. Point PG_PORT / PG_DATABASE at a throwaway Postgres.');
  process.exit(2);
}
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { query, pool } = require('../config/database');
const cache = require('../config/cache');
const { parseWorkbook, loadFolder, channelOf, nameDateMismatch } = require('../services/esalesStock');
const { readSheet } = require('../services/xlsxLite');
const ctrl = require('../controllers/esalesStock.controller');
const age = require('../controllers/ageing.controller');

let passed = 0; const failures = [];
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
// eq for objects whose key order carries no meaning (a bucket map built in a different order is the same map).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const eqc = (name, got, want) => eq(name, canon(got), canon(want));
const section = (s) => console.log(`\n── ${s}`);

// ── build an .xlsx in memory (stored zip) ────────────────────────────────────
const serial = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function zip(files) {
  const locals = []; const central = []; let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'); const nm = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
// cell: number → numeric; string → shared string; { inline } → inline string; { n } → raw numeric text; null → no cell
function xlsx(sheets, { date1904 = false } = {}) {
  const sst = []; const sidx = new Map();
  const col = (i) => String.fromCharCode(65 + i);
  const sheetXml = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((cells, r) => (cells === null ? `<row r="${r + 1}"/>` : `<row r="${r + 1}" spans="1:4">${cells.map((c, i) => {
      const ref = `${col(i)}${r + 1}`;
      if (c === null || c === undefined) return '';
      if (typeof c === 'number') return `<c r="${ref}" s="1"><v>${c}</v></c>`;
      if (typeof c === 'object' && 'n' in c) return `<c r="${ref}"><v>${c.n}</v></c>`;
      if (typeof c === 'object' && 'inline' in c) return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(c.inline)}</t></is></c>`;
      if (!sidx.has(c)) { sidx.set(c, sst.length); sst.push(c); }
      return `<c r="${ref}" t="s"><v>${sidx.get(c)}</v></c>`;
    }).join('')}</row>`)).join('')}</sheetData></worksheet>`;
  const parts = sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]);
  return zip([
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets>${
      sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
    ...parts,
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
      sst.map((s) => `<si><r><t xml:space="preserve">${xmlEsc(s)}</t></r></si>`).join('')}</sst>`],
  ]);
}
const HEAD = ['Partner', 'barcode', 'Qty', 'Date'];
const book = (rows, opts) => xlsx([{ name: 'Sumary', rows: [['x', 1]] }, { name: 'Consolidate', rows: [HEAD, ...rows] }], opts);
const throws = (name, fn, re) => {
  try { fn(); check(name, false, 'did not throw'); } catch (e) { check(name, re.test(e.message), `message: ${e.message}`); }
};

// ── controller invocation (same trick the cache warm-up uses) ────────────────
const call = (fn, q = {}) => new Promise((resolve, reject) => {
  fn({ query: q }, { json: (b) => resolve(b.data ?? b.options), status: (c) => ({ json: (b) => reject(new Error(`${c}: ${JSON.stringify(b)}`)) }) }, reject);
});
const reset = async () => {
  await query('TRUNCATE esales_stock, esales_files, esales_partners, esales_items, esales_meta RESTART IDENTITY CASCADE');
  await query('REFRESH MATERIALIZED VIEW esales_stock_wide');
  await query('REFRESH MATERIALIZED VIEW esales_ageing');
  cache.clear();
};
const dbTotals = async () => (await query('SELECT COUNT(*)::int AS rows, COALESCE(SUM(qty),0)::int AS units, COALESCE(SUM(lines),0)::int AS lines FROM esales_stock')).rows[0];
// PG's ROUND(numeric): half away from zero.
const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));

async function part1() {
  section('PART 1 — workbook reader + validation');
  const D = serial('2026-09-30');
  const p = parseWorkbook(book([
    ['A  &  Co', 8905566000001, 2, D],
    ['A & Co', 8905566000001, 3, D],                       // repeated partner+barcode → summed
    null,                                                  // empty <row/>
    [null, null, null, null],                              // blank spacer row
    ['B <Ltd>', 'NA', 0, D],                               // junk barcode + zero qty are kept
    ['B <Ltd>', { inline: '8905566000002' }, -1, D],       // inline string, negative qty
    ['B <Ltd>', { n: '8.905566000003E12' }, 4, D],         // scientific-notation numeric barcode
    ['B <Ltd>', { n: '8905566000004.0' }, 1, D + 0.75],    // float text; date with a time part
    ['B <Ltd>', null, 7, D],                               // blank barcode still counts
  ]));
  eq('snapshot date', p.snapshotDate, '2026-09-30');
  eq('lines / units', [p.lines, p.units], [7, 16]);
  const m = Object.fromEntries(p.rows.map((r) => [`${r.partner}|${r.barcode}`, [r.qty, r.lines]]));
  eq('rows', m, { 'A & Co|8905566000001': [5, 2], 'B <Ltd>|NA': [0, 1], 'B <Ltd>|8905566000002': [-1, 1],
    'B <Ltd>|8905566000003': [4, 1], 'B <Ltd>|8905566000004': [1, 1], 'B <Ltd>|': [7, 1] });
  eq('1904 date system', parseWorkbook(book([['A', 1, 1, serial('2026-09-30') - 1462]], { date1904: true })).snapshotDate, '2026-09-30');
  eq('header is case/space tolerant', parseWorkbook(xlsx([{ name: ' consolidate ', rows: [[' PARTNER', 'Barcode ', 'QTY', 'date'], ['A', 1, 1, D]] }])).units, 1);

  throws('fractional Qty rejected', () => parseWorkbook(book([['A', 1, 1.5, D]])), /row 2: Qty/);
  throws('text Qty rejected', () => parseWorkbook(book([['A', 1, 'x', D]])), /row 2: Qty is not a number/);
  throws('empty Qty rejected', () => parseWorkbook(book([['A', 1, 1, D], ['A', 2, null, D]])), /row 3: Qty is empty/);
  throws('empty Partner rejected', () => parseWorkbook(book([[null, 1, 1, D]])), /row 2: Partner is empty/);
  throws('two dates rejected', () => parseWorkbook(book([['A', 1, 1, D], ['A', 2, 1, D + 1]])), /row 3: Date .* differs/);
  throws('text Date rejected', () => parseWorkbook(book([['A', 1, 1, '30/09/2026']])), /row 2: Date is not an Excel date/);
  throws('absurd Date rejected', () => parseWorkbook(book([['A', 1, 1, 5]])), /out of range/);
  throws('empty Date rejected', () => parseWorkbook(book([['A', 1, 1, null]])), /row 2: Date is empty/);
  throws('wrong header rejected', () => parseWorkbook(xlsx([{ name: 'Consolidate', rows: [['barcode', 'Partner', 'Qty', 'Date'], ['A', 1, 1, D]] }])), /header must be/);
  throws('missing Consolidate sheet rejected', () => parseWorkbook(xlsx([{ name: 'Sheet1', rows: [HEAD, ['A', 1, 1, D]] }])), /exactly one matching sheet, found 0/);
  throws('header-only sheet rejected', () => parseWorkbook(book([])), /no data rows/);
  const good = book([['A', 1, 1, D]]);
  throws('truncated file rejected', () => parseWorkbook(good.subarray(0, good.length - 40)), /zip|corrupt/i);
  const bad = Buffer.from(good); bad[bad.lastIndexOf('<sheetData>') + 3] ^= 0xff;   // inside the Consolidate part
  throws('bit-flipped file rejected (CRC)', () => parseWorkbook(bad), /CRC/);
  throws('non-zip rejected', () => parseWorkbook(Buffer.from('not a workbook at all, just some text padding............')), /not a zip/);

  eq('file name vs Date column', [nameDateMismatch('E-Sales   SEPT 26.xlsx', '2026-09-30'), nameDateMismatch('E-Sales  July 24.xlsx', '2024-07-30'),
    nameDateMismatch('E-Sales 01 Dec 23.xlsx', '2023-12-01'), nameDateMismatch('stock.xlsx', '2026-09-30'), /says 2025-09 .* says 2025-08-31/.test(nameDateMismatch('E-Sales   SEPT 25.xlsx', '2025-08-31'))],
  [null, null, null, null, true]);
  eq('channel grouping', ['Flipkart India Pvt Ltd (SOR) -UJ', 'Myntra Jabong India Pvt Ltd (Womens)', 'Reliance Retail Limited - SOR', 'ZEPTO -UJ', 'ZEPTO',
    'KNOTNOW -MENS-Womens & UJ', 'Big Basket -BB -UJ', 'Panchanan International Pvt. Ltd.', 'Zilo Sevices', 'Setu E-Tail Private Limited',
    'Cyclone Retailing & Clothing Pvt Ltd'].map(channelOf),
  ['Flipkart', 'Myntra', 'Reliance Retail', 'Zepto', 'Zepto', 'KnotNow', 'Big Basket', 'Panchanan', 'Zilo', 'Setu', 'Cyclone']);
}

async function part2and3() {
  section('PART 2 — loader: add / unchanged / changed / duplicate / rename / reject / prune');
  await reset();
  // Two real item-master barcodes in different categories. The first is one of
  // the master's leading-zero EANs: written as a NUMBER it reaches the loader
  // as 12 digits and must still match.
  const sk = (await query(`(SELECT external_id, mrp::float AS mrp, category_norm FROM skus WHERE external_id LIKE '0%' AND mrp > 100 ORDER BY external_id LIMIT 1)
                           UNION ALL
                           (SELECT external_id, mrp::float AS mrp, category_norm FROM skus WHERE category_norm = 'DENIM' AND mrp > 100 ORDER BY external_id LIMIT 1)`)).rows;
  check('test barcodes available (one leading-zero)', sk.length === 2 && sk[0].external_id.startsWith('0') && sk[0].category_norm !== sk[1].category_norm, JSON.stringify(sk));
  const [K1, K2] = sk; const B1 = Number(K1.external_id); const B2 = Number(K2.external_id);
  const D1 = serial('2026-08-31'); const D2 = serial('2026-09-30');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esales-verify-'));
  const put = (name, buf) => fs.writeFileSync(path.join(dir, name), buf);
  const quiet = { log: () => {} };

  put('aug.xlsx', book([['Flipkart One', B1, 10, D1], ['Flipkart One', B2, 4, D1], ['Myntra Two', B1, 6, D1], ['Myntra Two', 'NA', 3, D1]]));
  put('sep.xlsx', book([['Flipkart One', B1, 7, D2], ['Flipkart One', B1, 1, D2], ['Myntra Two', B1, 9, D2], ['Myntra Two', B2, 5, D2], ['Myntra Two', 'NA', 2, D2], ['Zepto Three', B2, 0, D2]]));
  put('~$sep.xlsx', Buffer.from('excel lock file'));
  let r = await loadFolder(dir, quiet);
  eq('first load adds both', [r.added, r.failed.length], [['aug.xlsx', 'sep.xlsx'], 0]);
  eq('database totals', await dbTotals(), { rows: 9, units: 47, lines: 10 });
  eq('items = matched barcodes only', (await query('SELECT barcode FROM esales_items ORDER BY 1')).rows.map((x) => x.barcode), [K1.external_id, K2.external_id].sort());

  const stamp = async () => (await query('SELECT file_name, loaded_at::text AS t FROM esales_files ORDER BY 1')).rows;
  const before = await stamp();
  r = await loadFolder(dir, quiet);
  eq('second run: nothing to do', [r.added, r.updated, r.unchanged], [[], [], ['aug.xlsx', 'sep.xlsx']]);
  eq('unchanged files are not rewritten', await stamp(), before);

  // ── PART 3 lives here: the dataset is small enough to check by hand ──
  section('PART 3 — API on a hand-computed dataset');
  const win = { from: '2026-09-01', to: '2026-10-12' };
  let ov = await call(ctrl.getOverview, win);
  const v = (b1, b2) => roundHalfAway(b1 * K1.mrp + b2 * K2.mrp);
  eq('closing/opening dates', [ov.stock.as_of, ov.stock.opening_as_of], ['2026-09-30', '2026-08-31']);
  eq('closing units (incl. unmatched)', ov.stock.closing_units, 24);
  eq('opening units', ov.stock.opening_units, 23);
  eq('change units', ov.stock.change_units, 1);
  eq('closing value = Σ units × MRP', ov.stock.closing_value, v(17, 5));
  eq('opening value', ov.stock.opening_value, v(16, 4));
  eq('unmatched units / barcodes', [ov.stock.unmatched_units, ov.stock.unmatched_barcodes], [2, 1]);
  eq('kpis', [ov.kpis.lines, ov.kpis.partner_count, ov.kpis.channel_count, ov.kpis.snapshot_count], [6, 2, 2, 1]);
  // Myntra Two 16 of 24 units; positions: 1 zero + 1 low (the 2-unit NA) of 5; SKUs by units 17 / 5 / 2 → one SKU covers half
  eq('management KPIs', [ov.kpis.top_partner, ov.kpis.top_partner_pct_units, ov.kpis.top3_partner_pct_units, ov.kpis.thin_pct, ov.kpis.pareto_half_skus, ov.kpis.pareto_skus, ov.kpis.avg_mrp, ov.stock.yoy],
    ['Myntra Two', 66.7, 100, 40, 1, 3, Math.round(v(17, 5) / 22), null]);
  eq('season age + season mix cover all units', [ov.season_age.reduce((a, x) => a + x.u, 0), ov.top_season.reduce((a, x) => a + x.u, 0)], [24, 24]);
  const fo = await call(ctrl.getFilterOptions, {});
  eq('filter options hold only what ESales stock holds', fo.category, [K1.category_norm, K2.category_norm].sort());
  eq('partner + channel options', [fo.channel, [...fo.partner_name].sort(), [...(await call(ctrl.getFilterOptions, { channel: 'Myntra,Zepto' })).partner_name].sort()],
    [['Flipkart', 'Myntra', 'Zepto'], ['Flipkart One', 'Myntra Two', 'Zepto Three'], ['Myntra Two', 'Zepto Three']]);
  const fo2 = await call(ctrl.getFilterOptions, { category: K1.category_norm });
  eq('filter options cascade (other dims narrow, own dim does not)', [fo2.category.length, fo2.size.length, fo.size.length >= fo2.size.length], [2, 1, true]);
  // B2 was held by Flipkart One (Aug) and Myntra Two + Zepto Three (Sep); B1 never by Zepto Three
  eq('…SKU lists follow the partner picked', (await call(ctrl.getFilterOptions, { partner_name: 'Zepto Three' })).category, [K2.category_norm]);
  eq('…partner list follows the SKU filter', [...(await call(ctrl.getFilterOptions, { category: K1.category_norm })).partner_name].sort(), ['Flipkart One', 'Myntra Two']);
  eq('daily', ov.daily, [{ d: '2026-09-30', g: v(17, 5), u: 24 }]);
  eq('monthly', ov.monthly.map((x) => [x.mon, x.net_u]), [['Sep', 1]]);
  // positions: F1/B1 10→8 (−2), F1/B2 4→0 (−4), M2/B1 6→9 (+3), M2/B2 0→5 (+5), M2/NA 3→2 (−1), Z3/B2 0→0
  eq('flow units', ov.flow.map((x) => [x.dir, x.txns, x.u]), [['Inbound', 2, 8], ['Outbound', 3, 7]]);
  eq('flow nets to the change', ov.flow[0].u - ov.flow[1].u, ov.stock.change_units);
  eq('health', ov.health, { positions: 5, in_stock: 4, zero: 1, low: 1, negative: 0, negative_units: 0 });
  eq('channels', ov.channels.map((x) => [x.name, x.partners, x.skus, x.lines, x.u, x.change_u]), [['Myntra', 1, 3, 3, 16, 7], ['Flipkart', 1, 1, 2, 8, -6], ['Zepto', 0, 0, 1, 0, 0]]);
  eq('top partners', ov.top_partners.map((x) => [x.name, x.u]), [['Myntra Two', 16], ['Flipkart One', 8], ['Zepto Three', 0]]);
  eq('categories include the unmatched bucket', Object.fromEntries(ov.top_cat.map((x) => [x.name, x.u])),
    { [K1.category_norm]: 17, [K2.category_norm]: 5, 'Unmatched barcode': 2 });

  let pv = await call(ctrl.getPivot, { ...win, group_by: 'partner' });
  eq('pivot partner', pv.rows.map((x) => [x.label, x.qty, x.lines, x.skus, x.delta_qty_vs_prev_pct]),
    [['Myntra Two', 16, 3, 3, 77.8], ['Flipkart One', 8, 2, 1, -42.9], ['Zepto Three', 0, 1, 0, null]]);
  eq('pivot avg MRP ignores unmatched units', pv.rows[0].avg_price, Math.round(v(9, 5) / 14));
  pv = await call(ctrl.getPivot, { ...win, group_by: 'category', category: 'Unmatched barcode' });
  eq('drilling the unmatched bucket', pv.rows.map((x) => [x.label, x.qty, x.value, x.avg_price]), [['Unmatched barcode', 2, 0, null]]);
  const flip = (await call(ctrl.getPartners)).find((x) => x.name === 'Flipkart One');
  ov = await call(ctrl.getOverview, { ...win, partner: flip.id });
  eq('partner filter', [ov.stock.closing_units, ov.stock.opening_units], [8, 14]);
  ov = await call(ctrl.getOverview, { ...win, partner_name: 'Flipkart One' });
  eq('sidebar partner filter (by name) gives the same', [ov.stock.closing_units, ov.stock.opening_units], [8, 14]);
  ov = await call(ctrl.getOverview, { ...win, partner_name: 'Flipkart One|Myntra Two|Zepto Three' });
  eq('…and several partners add up', ov.stock.closing_units, 24);
  ov = await call(ctrl.getOverview, { ...win, partner_name: 'Flipkart One|Myntra Two', channel: 'Myntra' });
  eq('…and AND with Channel', ov.stock.closing_units, 16);
  ov = await call(ctrl.getOverview, { ...win, category: K1.category_norm });
  eq('SKU-attribute filter drops unmatched', [ov.stock.closing_units, ov.stock.unmatched_units], [17, 0]);
  eq('sku count (matched, in stock)', (await call(ctrl.getSkuCount, win)).sku_count, 2);
  const tr = await call(ctrl.getTrend, { from: '2026-08-01', to: '2026-10-12', group_by: 'partner', top: 2 });
  eq('trend', [tr.dates, tr.series.map((s) => [s.label, s.points.map((x) => x.value)])],
    [['2026-08-31', '2026-09-30'], [['Myntra Two', [9, 16]], ['Flipkart One', [14, 8]]]]);
  let it = await call(ctrl.getItems, { ...win, limit: 2, page: 1 });
  eq('items page 1', [it.total, it.rows.map((x) => [x.barcode, x.units, x.partners, x.matched])],
    [3, [[K1.external_id, 17, 2, true], [K2.external_id, 5, 1, true]]]);
  it = await call(ctrl.getItems, { ...win, search: 'na' });
  check('items search finds the junk barcode', it.rows.some((x) => x.barcode === 'NA' && x.matched === false && x.units === 2));
  // SKU detail: B1 = 10 + 6 (Aug) → 8 + 9 (Sep)
  const det = await call(ctrl.getItem, { ...win, barcode: K1.external_id });
  eq('SKU detail', [det.item.matched, det.as_of, det.opening_as_of, det.units, det.value, det.opening_units, det.change_units, det.history, det.partners.map((x) => [x.name, x.units, x.lines, x.opening_units])],
    [true, '2026-09-30', '2026-08-31', 17, roundHalfAway(17 * K1.mrp), 16, 1, [{ d: '2026-08-31', u: 16 }, { d: '2026-09-30', u: 17 }], [['Myntra Two', 9, 1, 6], ['Flipkart One', 8, 2, 10]]]);
  const detNA = await call(ctrl.getItem, { ...win, barcode: 'NA' });
  eq('SKU detail for an unmatched barcode', [detNA.item.matched, detNA.units, detNA.value, detNA.sizes], [false, 2, null, []]);
  let notFound = false; try { await call(ctrl.getItem, { ...win, barcode: 'nope' }); } catch (e) { notFound = /^404/.test(e.message); }
  check('SKU detail: unknown barcode is a 404', notFound);
  ov = await call(ctrl.getOverview, { from: '2026-10-01', to: '2026-10-12' });
  eq('window with no snapshot inside: carried forward, no change', [ov.stock.as_of, ov.stock.opening_as_of, ov.stock.change_units, ov.daily.length, ov.flow.length, ov.monthly.length],
    ['2026-09-30', '2026-09-30', 0, 0, 0, 0]);
  eq('…and pivots show no Δ', (await call(ctrl.getPivot, { from: '2026-10-01', to: '2026-10-12' })).rows[0].delta_qty_vs_prev_pct, null);
  ov = await call(ctrl.getOverview, { from: '2026-08-01', to: '2026-08-31' });
  eq('first snapshot: no opening, no fake "change" bar', [ov.stock.opening_as_of, ov.stock.opening_units, ov.monthly.length, ov.kpis.change_pct_units], [null, 0, 0, null]);
  eq('before any data', (await call(ctrl.getOverview, { from: '2020-01-01', to: '2020-12-31' })).empty, true);

  section('PART 2 (cont.) — changes on disk');
  // changed workbook: one barcode dropped, one qty changed
  put('sep.xlsx', book([['Flipkart One', B1, 20, D2], ['Myntra Two', B2, 5, D2]]));
  r = await loadFolder(dir, quiet);
  eq('changed file is reloaded', [r.updated, r.unchanged], [['sep.xlsx'], ['aug.xlsx']]);
  eq('…and fully replaces its snapshot', (await query(`SELECT COUNT(*)::int AS n, SUM(qty)::int AS u FROM esales_stock WHERE snapshot_date = '2026-09-30'`)).rows[0], { n: 2, u: 25 });
  cache.clear();   // = the 30 s state check coming round
  eq('API serves the new numbers after a reload', (await call(ctrl.getOverview, win)).stock.closing_units, 25);
  // a loader that died after writing a file but before refreshing the derived data: the API catches up by itself
  await query(`UPDATE esales_stock SET qty = qty + 1 WHERE snapshot_date = '2026-09-30' AND barcode = $1`, [K2.external_id]);
  await query(`UPDATE esales_files SET sha256 = repeat('f', 64), units = units + 1 WHERE file_name = 'sep.xlsx'`);
  cache.clear();
  eq('derived data behind the files is rebuilt on the next request', (await call(ctrl.getOverview, win)).stock.closing_units, 26);
  put('sep.xlsx', book([['Flipkart One', B1, 20, D2], ['Myntra Two', B2, 5, D2], [null, null, null, null]]));   // same data, new bytes → reload restores 25
  await loadFolder(dir, quiet); cache.clear();
  eq('…and a real reload puts the file\'s numbers back', (await call(ctrl.getOverview, win)).stock.closing_units, 25);

  // item master refreshed → esales_items rebuilt on the next state check
  await query('UPDATE skus SET mrp = mrp + 100 WHERE external_id = $1', [K1.external_id]);
  await query(`INSERT INTO master_refresh_state (name, last_success_at) VALUES ('skus', clock_timestamp())
               ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`);
  cache.clear();
  eq('item-master MRP change reaches the page', (await call(ctrl.getOverview, win)).stock.closing_value, roundHalfAway(20 * (K1.mrp + 100) + 5 * K2.mrp));
  await query('UPDATE skus SET mrp = mrp - 100 WHERE external_id = $1', [K1.external_id]);

  // second workbook claiming an already-loaded date
  put('sep-copy.xlsx', book([['Flipkart One', B1, 999, D2]]));
  r = await loadFolder(dir, quiet);
  check('duplicate snapshot date is refused', r.failed.length === 1 && /already loaded from "sep.xlsx"/.test(r.failed[0].error), JSON.stringify(r.failed));
  eq('…and nothing is double counted', (await dbTotals()).units, 23 + 25);
  fs.unlinkSync(path.join(dir, 'sep-copy.xlsx'));

  // bad edit of a loaded workbook: rejected, old version stays
  const augGood = fs.readFileSync(path.join(dir, 'aug.xlsx'));
  put('aug.xlsx', book([['Flipkart One', B1, 'ten', D1]]));
  r = await loadFolder(dir, quiet);
  check('bad edit is rejected with the row', r.failed.length === 1 && /row 2: Qty is not a number/.test(r.failed[0].error), JSON.stringify(r.failed));
  eq('…previous version of that file is intact', (await query(`SELECT SUM(qty)::int AS u FROM esales_stock WHERE snapshot_date = '2026-08-31'`)).rows[0].u, 23);
  put('aug.xlsx', augGood);
  eq('restoring the file needs no reload', (await loadFolder(dir, quiet)).unchanged.length, 2);

  // rename: same snapshot under a new file name takes the old one's place
  fs.renameSync(path.join(dir, 'aug.xlsx'), path.join(dir, 'E-Sales AUG 26.xlsx'));
  r = await loadFolder(dir, quiet);
  eq('renamed workbook replaces its old entry', [(await query('SELECT file_name FROM esales_files ORDER BY 1')).rows.map((x) => x.file_name), r.failed.length, (await dbTotals()).units],
    [['E-Sales AUG 26.xlsx', 'sep.xlsx'], 0, 48]);

  // removed from the folder
  fs.unlinkSync(path.join(dir, 'sep.xlsx'));
  r = await loadFolder(dir, quiet);
  eq('missing workbook is reported, data kept', [r.missing, r.removed, (await dbTotals()).units], [['sep.xlsx'], [], 48]);
  r = await loadFolder(dir, { ...quiet, prune: true });
  eq('--prune removes it', [r.removed, (await dbTotals()).units], [['sep.xlsx'], 23]);
  const dry = await loadFolder(dir, { ...quiet, dryRun: true });
  eq('dry run writes nothing', [dry.unchanged.length, (await dbTotals()).units], [1, 23]);
  fs.unlinkSync(path.join(dir, 'E-Sales AUG 26.xlsx'));
  let threw = false; try { await loadFolder(dir, { ...quiet, prune: true }); } catch (e) { threw = /no \.xlsx workbooks/.test(e.message); }
  check('an empty folder never prunes everything', threw && (await dbTotals()).units === 23);

  // marketplace-suffixed EAN resolves to its master EAN; file-name / Date mismatch is warned
  await reset();
  put('E-Sales SEPT 26.xlsx', book([['Myntra Two', B2, 3, D1], ['Myntra Two', `${K2.external_id}_2`, 4, D1], ['Myntra Two', 'NA', 1, D1]]));
  r = await loadFolder(dir, quiet);
  check('file name vs Date mismatch is warned, file still loads on its Date', r.added.length === 1 && r.warnings.length === 1 && /says 2026-09 .* says 2026-08-31/.test(r.warnings[0].warning), JSON.stringify(r.warnings));
  eq('…and the warning repeats on later runs', (await loadFolder(dir, quiet)).warnings.length, 1);
  cache.clear();
  const w2 = { from: '2026-08-01', to: '2026-08-31' };
  ov = await call(ctrl.getOverview, w2);
  eq('suffixed barcode is matched (only the junk stays unmatched)', [ov.stock.closing_units, ov.stock.unmatched_units, ov.stock.closing_value], [8, 1, roundHalfAway(7 * K2.mrp)]);
  eq('…and counts as the same SKU', [(await call(ctrl.getSkuCount, w2)).sku_count, (await call(ctrl.getPivot, { ...w2, group_by: 'category' })).rows.find((x) => x.key === K2.category_norm).skus], [1, 1]);
  eq('…while the SKU table still shows both barcodes as written', (await call(ctrl.getItems, w2)).rows.map((x) => [x.barcode, x.units, x.matched]).sort(),
    [[K2.external_id, 3, true], [`${K2.external_id}_2`, 4, true], ['NA', 1, false]].sort());

  // ── ageing (Inventory Ageing → ESales): continuous-on-hand, first in first out ──
  await reset();
  fs.unlinkSync(path.join(dir, 'E-Sales SEPT 26.xlsx'));
  const D0 = serial('2026-07-31');
  put('jul.xlsx', book([['Flipkart One', B1, 10, D0], ['Myntra Two', B1, 4, D0]]));
  put('aug.xlsx', book([['Flipkart One', B1, 6, D1]]));                                    // Myntra Two not in this file at all
  put('sep.xlsx', book([['Flipkart One', B1, 9, D2], ['Flipkart One', B2, 5, D2], ['Myntra Two', B1, 7, D2]]));
  await loadFolder(dir, quiet); cache.clear();
  // Flipkart/B1 10→6→9: 6 held since Jul, 3 arrived in Sep · Flipkart/B2: 5 new in Sep ·
  // Myntra/B1 4→(not reported)→7: 4 held since Jul (the missing month does not reset them), 3 new in Sep
  const ag = await call(age.getSummary, { source: 'esales' });
  eq('ageing buckets (units)', Object.fromEntries(ag.buckets.filter((b) => b.units).map((b) => [b.key, b.units])), { d0_30: 11, d61_90: 10 });
  eq('ageing totals', [ag.total_units, ag.aged_units, ag.aged_pct, ag.meta.as_of, ag.total_value_gross], [21, 0, 0, '2026-09-30', roundHalfAway(16 * K1.mrp) + roundHalfAway(5 * K2.mrp)]);
  const agp = await call(age.getPivot, { source: 'esales', group_by: 'partner' });
  eq('ageing by partner', agp.rows.map((x) => [x.label, x.units, x.buckets.d0_30, x.buckets.d61_90]), [['Flipkart One', 14, 8, 6], ['Myntra Two', 7, 3, 4]]);
  eq('ageing filtered by partner name', (await call(age.getSummary, { source: 'esales', partner_name: 'Myntra Two' })).total_units, 7);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── PART 4: the real workbooks ───────────────────────────────────────────────
function readOracle(csvPath) {
  // file,row_no,partner,barcode,qty,snapshot_date — RFC-4180 quoting
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = []; let f = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { f.push(cur); cur = ''; }
    else if (c === '\n') { f.push(cur); cur = ''; rows.push(f); f = []; }
    else if (c !== '\r') cur += c;
  }
  if (cur || f.length) { f.push(cur); rows.push(f); }
  return rows.slice(1).map((x) => ({ partner: x[2].replace(/\s+/g, ' ').trim(), barcode: x[3].trim(), qty: Number(x[4]), date: x[5] }));
}

async function part4(dirPath, csvPath) {
  section('PART 4 — real workbooks vs an independent reading');
  await reset();
  const t0 = Date.now();
  const r = await loadFolder(dirPath, { log: () => {} });
  console.log(`  loaded ${r.added.length} workbooks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  eq('no workbook rejected', r.failed, []);

  // Positions from the oracle: date → partner → barcode → { qty, lines }
  const oracle = readOracle(csvPath);
  const pos = new Map();
  for (const o of oracle) {
    let d = pos.get(o.date); if (!d) pos.set(o.date, (d = new Map()));
    const k = `${o.partner}\u0000${o.barcode}`;
    const c = d.get(k); if (c) { c.qty += o.qty; c.lines += 1; } else d.set(k, { partner: o.partner, barcode: o.barcode, qty: o.qty, lines: 1 });
  }
  const snaps = [...pos.keys()].sort();
  const db = (await query(`SELECT r.snapshot_date::text AS d, p.name, r.barcode, r.qty, r.lines FROM esales_stock r JOIN esales_partners p ON p.id = r.partner_id`)).rows;
  let bad = 0;
  for (const x of db) { const o = pos.get(x.d)?.get(`${x.name}\u0000${x.barcode}`); if (!o || o.qty !== x.qty || o.lines !== x.lines) bad += 1; }
  const oracleRows = [...pos.values()].reduce((a, m) => a + m.size, 0);
  eq('every position matches the oracle (rows, mismatches)', [db.length, bad], [oracleRows, 0]);
  eq('grand totals', await dbTotals(), { rows: oracleRows, units: oracle.reduce((a, o) => a + o.qty, 0), lines: oracle.length });
  const files = (await query('SELECT snapshot_date::text AS d, lines, units::int AS units FROM esales_files ORDER BY 1')).rows;
  eq('per-file lines and units', files, snaps.map((d) => { const m = [...pos.get(d).values()]; return { d, lines: m.reduce((a, x) => a + x.lines, 0), units: m.reduce((a, x) => a + x.qty, 0) }; }));

  // Item master straight from skus (NOT esales_items) + partner ids/channels.
  const sku = new Map((await query(`SELECT external_id, mrp::float AS mrp, category_norm, gender_name, product, sub_product, size, color_name, shade, style, season
    FROM skus WHERE external_id = ANY($1::text[])`, [[...new Set(oracle.flatMap((o) => [o.barcode, o.barcode.slice(0, 13)]))]])).rows.map((x) => [x.external_id, x]));
  // exact EAN, else an EAN + marketplace suffix
  const master = (b) => sku.get(b) || (/^\d{13}\D/.test(b) ? sku.get(b.slice(0, 13)) : undefined);
  const skuId = (b) => master(b)?.external_id || b;
  const partner = new Map((await query('SELECT id::text AS id, name, channel FROM esales_partners')).rows.map((x) => [x.name, x]));
  const U = 'Unmatched barcode';
  const attr = (b, col) => { const s = master(b); return s ? (s[col] == null || s[col] === '' ? '—' : s[col]) : U; };
  const paise = (x) => (master(x.barcode) ? x.qty * Math.round(master(x.barcode).mrp * 100) : 0);
  const rupees = (p) => roundHalfAway(p / 100);
  const DIM = { partner: (x) => partner.get(x.partner).id, channel: (x) => partner.get(x.partner).channel,
    category: (x) => attr(x.barcode, 'category_norm'), gender: (x) => attr(x.barcode, 'gender_name'), product: (x) => attr(x.barcode, 'product'),
    sub_product: (x) => attr(x.barcode, 'sub_product'), colour: (x) => attr(x.barcode, 'color_name'), size: (x) => attr(x.barcode, 'size'), season: (x) => attr(x.barcode, 'season') };
  const SCOPE_COL = { category: 'category_norm', color: 'color_name', size: 'size', product: 'product', sub_product: 'sub_product', gender: 'gender_name', season: 'season', shade: 'shade', style: 'style' };
  const inScope = (q) => (x) => Object.entries(q).every(([k, val]) => {
    const want = String(val).split(',');
    if (k === 'partner') return want.includes(partner.get(x.partner).id);
    if (k === 'partner_name') return String(val).split('|').includes(x.partner);
    if (k === 'channel') return want.includes(partner.get(x.partner).channel);
    const s = master(x.barcode);
    return s ? want.includes(s[SCOPE_COL[k]]) : want.includes(U);
  });
  const at = (d, q) => (d ? [...pos.get(d).values()].filter(inScope(q)) : []);
  const tot = (rows) => ({ u: rows.reduce((a, x) => a + x.qty, 0), g: rupees(rows.reduce((a, x) => a + paise(x), 0)), lines: rows.reduce((a, x) => a + x.lines, 0) });

  const unm = new Map(); for (const o of oracle) if (!master(o.barcode)) unm.set(o.barcode, (unm.get(o.barcode) || 0) + o.qty);
  const dbUnm = (await query(`SELECT COUNT(DISTINCT r.barcode)::int AS barcodes, COALESCE(SUM(r.qty), 0)::int AS units FROM esales_stock r
    WHERE NOT EXISTS (SELECT 1 FROM esales_items i WHERE i.barcode = r.barcode)`)).rows[0];
  eq('unmatched barcodes / units, whole history', dbUnm, { barcodes: unm.size, units: [...unm.values()].reduce((a, b) => a + b, 0) });
  console.log(`  unmatched after exact + suffix matching: ${dbUnm.barcodes} barcodes, ${dbUnm.units} units of ${oracle.reduce((a, o) => a + o.qty, 0)} — ${[...unm.keys()].sort().join(', ')}`);
  console.log(`  file-name warnings: ${r.warnings.map((x) => x.file).join(', ') || 'none'}`);

  // The workbooks' own pivot tables ("Row Labels | Sum of Qty") — the business's totals.
  let pivots = 0;
  for (const file of fs.readdirSync(dirPath).filter((f) => /\.xlsx$/i.test(f)).sort()) {
    const buf = fs.readFileSync(path.join(dirPath, file));
    for (const name of ['Sumary', 'Sheet1']) {
      let sheet; try { sheet = readSheet(buf, (n) => n.trim() === name); } catch (_) { continue; }
      const rows = sheet.rows.map((x) => x.cells.map((c) => c && c.v));
      const h = rows.findIndex((x) => x[0] === 'Row Labels' && x[1] === 'Sum of Qty');
      if (h < 0) continue;
      const want = Object.fromEntries(rows.slice(h + 1).filter((x) => x[0]).map((x) => [String(x[0]).replace(/\s+/g, ' ').trim(), Number(x[1])]));
      const d = (await query('SELECT snapshot_date::text AS d FROM esales_files WHERE file_name = $1', [file])).rows[0].d;
      const got = Object.fromEntries((await query(`SELECT p.name, SUM(r.qty)::int AS u FROM esales_stock r JOIN esales_partners p ON p.id = r.partner_id
        WHERE r.snapshot_date = $1 GROUP BY 1`, [d])).rows.map((x) => [x.name, x.u]));
      // A pivot may list only some partners (May-24 shows one); its Grand Total is the total of the rows it lists.
      got['Grand Total'] = Object.keys(want).filter((k2) => k2 !== 'Grand Total').reduce((a, k2) => a + (got[k2] || 0), 0);
      // The Jan-24 workbook still carries Dec-23's pivot (never refreshed) — it is a copy, not a total of its own sheet.
      if (file === 'E-Sales 02 Jan 24.xlsx') { check(`${file}: its pivot is the stale Dec-23 one, not its own data`, want['Grand Total'] === 71019 && got['Grand Total'] !== 71019); continue; }
      if (Object.keys(want).length < 2) continue;
      pivots += 1;
      eq(`${file}: workbook's own pivot totals`, Object.fromEntries(Object.keys(want).map((k2) => [k2, got[k2]])), want);
    }
  }
  console.log(`  ${pivots} workbook pivot tables agree with the loaded data`);

  const pairs = new Set(); for (const m of pos.values()) for (const k2 of m.keys()) pairs.add(k2);   // every partner × barcode ever seen
  const latest = snaps[snaps.length - 1];
  const top = (col) => { const m = new Map(); for (const x of pos.get(latest).values()) { const s = master(x.barcode); if (s) m.set(s[col], (m.get(s[col]) || 0) + x.qty); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const scopes = [{}, { partner: partner.get('Panchanan International Pvt. Ltd.').id }, { channel: 'Myntra' }, { gender: 'MENS' },
    { category: 'DENIM', size: top('size')[0][0] }, { color: top('color_name').slice(0, 2).map((x) => x[0]).join(',') }, { category: U },
    { season: top('season')[0][0] }, { channel: 'Flipkart', gender: 'WOMENS' }, { style: top('style')[0][0] }, { shade: top('shade')[0][0] },
    { category: `KNITS,${U}`, channel: 'Flipkart,Myntra' },
    { partner_name: 'Panchanan International Pvt. Ltd.|ZEPTO -UJ|Flipkart India Pvt Ltd (SOR) -UJ', gender: 'MENS' }];
  const windows = [['2026-04-01', '2026-10-12'], ['2026-10-01', '2026-10-12'], ['2023-01-01', '2026-12-31'], ['2025-08-01', '2025-08-31'],
    ['2020-01-01', '2020-12-31'], [snaps[0], '2024-03-31'], ['2025-09-01', '2025-10-31'], ['2024-12-31', '2025-01-31']];

  const before = passed + failures.length; let slowest = 0; const t1 = Date.now(); let calls = 0;
  const timed = async (fn, q) => { const t = process.hrtime.bigint(); const d = await call(fn, q); slowest = Math.max(slowest, Number(process.hrtime.bigint() - t) / 1e6); calls += 1; return d; };
  for (const [from, to] of windows) {
    const inWin = snaps.filter((d) => d >= from && d <= to);
    const C = [...snaps].reverse().find((d) => d <= to) || null;
    const O = [...snaps].reverse().find((d) => d < from) || null;
    for (const sc of scopes) {
      const tag = `${from}→${to} ${JSON.stringify(sc)}`;
      const q = { from, to, ...sc };
      const ov = await timed(ctrl.getOverview, q);
      if (!C) { check(`${tag}: empty before data`, ov.empty === true); continue; }
      const cRows = at(C, sc); const c = tot(cRows); const o = tot(at(O, sc));
      eq(`${tag}: snapshot dates`, [ov.stock.as_of, ov.stock.opening_as_of], [C, O]);
      eq(`${tag}: closing`, [ov.stock.closing_units, ov.stock.closing_value, ov.kpis.lines], [c.u, c.g, c.lines]);
      eq(`${tag}: opening`, [ov.stock.opening_units, ov.stock.opening_value], [o.u, o.g]);
      eq(`${tag}: change`, [ov.stock.change_units, ov.stock.change_value], [c.u - o.u, c.g - o.g]);
      eq(`${tag}: per-snapshot series`, ov.daily, inWin.map((d) => { const t = tot(at(d, sc)); return { d, g: t.g, u: t.u }; }));
      if (O && inWin.length) eq(`${tag}: opening + Σ net = closing`, o.u + ov.monthly.reduce((a, x) => a + x.net_u, 0), c.u);
      if (O !== C) eq(`${tag}: added − drawn down = change`, (ov.flow.find((x) => x.dir === 'Inbound')?.u || 0) - (ov.flow.find((x) => x.dir === 'Outbound')?.u || 0), c.u - o.u);
      eq(`${tag}: health adds up`, [ov.health.in_stock + ov.health.zero + ov.health.negative, ov.health.zero, ov.health.low, ov.health.negative],
        [cRows.length, cRows.filter((x) => x.qty === 0).length, cRows.filter((x) => x.qty === 1 || x.qty === 2).length, cRows.filter((x) => x.qty < 0).length]);
      eq(`${tag}: unmatched units`, ov.stock.unmatched_units, cRows.filter((x) => !master(x.barcode)).reduce((a, x) => a + x.qty, 0));
      for (const [name, list] of [['channels', ov.channels], ['partners', ov.top_partners], ['categories', ov.top_cat], ['genders', ov.top_gender]]) {
        eq(`${tag}: ${name} sum to closing`, list.reduce((a, x) => a + x.u, 0), c.u);
      }
      {
        const by = {}; for (const x of cRows) { const e = (by[x.partner] ||= { u: 0, p: 0 }); e.u += x.qty; e.p += paise(x); }
        const shareOf = (vals, n) => { const v2 = vals.map((x) => Math.max(x, 0)); const t = v2.reduce((a, b) => a + b, 0); return t > 0 ? Number((v2.sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0) / t * 100).toFixed(1)) : null; };
        const us = Object.values(by).map((e) => e.u); const gs = Object.values(by).map((e) => rupees(e.p));
        eq(`${tag}: partner concentration`, [ov.kpis.top_partner_pct_units, ov.kpis.top3_partner_pct_units, ov.kpis.top_partner_pct_value, ov.kpis.top3_partner_pct_value],
          [shareOf(us, 1), shareOf(us, 3), shareOf(gs, 1), shareOf(gs, 3)]);
        eq(`${tag}: thin positions`, ov.kpis.thin_pct, cRows.length ? Number((cRows.filter((x) => x.qty >= 0 && x.qty <= 2).length / cRows.length * 100).toFixed(1)) : null);
        const cy = Number(C.slice(0, 4)); const seas = {};
        for (const x of cRows) { const n = attr(x.barcode, 'season'); const e = (seas[n] ||= { u: 0, p: 0 }); e.u += x.qty; e.p += paise(x); }
        const isAged = (n) => { const m = /(19|20)\d{2}/.exec(n); return n !== U && m && cy - Number(m[0]) >= 2; };
        const agedU = Object.entries(seas).filter(([n]) => isAged(n)).reduce((a, [, e]) => a + e.u, 0);
        const agedG = Object.entries(seas).filter(([n]) => isAged(n)).reduce((a, [, e]) => a + rupees(e.p), 0);
        eq(`${tag}: aged-season share`, [ov.kpis.aged_pct_units, ov.kpis.aged_pct_value], [c.u > 0 ? Number((agedU / c.u * 100).toFixed(1)) : null, c.g > 0 ? Number((agedG / c.g * 100).toFixed(1)) : null]);
        eq(`${tag}: season age + mix cover closing`, [ov.season_age.reduce((a, x) => a + x.u, 0), ov.top_season.reduce((a, x) => a + x.u, 0)], [c.u, c.u]);
        const perSku = {}; for (const x of cRows) perSku[skuId(x.barcode)] = (perSku[skuId(x.barcode)] || 0) + x.qty;
        const us2 = Object.values(perSku).filter((u) => u > 0).sort((a, b) => b - a); const tot2 = us2.reduce((a, b) => a + b, 0);
        let run = 0; let half = 0; for (const u of us2) { if (run < tot2 / 2) half += 1; run += u; }
        eq(`${tag}: pareto`, [ov.kpis.pareto_half_skus, ov.kpis.pareto_skus], [half, us2.length]);
        const priced = cRows.filter((x) => master(x.barcode)).reduce((a, x) => a + x.qty, 0);
        eq(`${tag}: avg MRP`, ov.kpis.avg_mrp, priced > 0 ? Math.round(c.g / priced) : null);
        const Y = snaps.find((d) => d.slice(0, 7) === `${cy - 1}${C.slice(4, 7)}`);
        const yt = Y ? tot(at(Y, sc)) : null;
        eq(`${tag}: year-on-year`, ov.stock.yoy && [ov.stock.yoy.as_of, ov.stock.yoy.units, ov.stock.yoy.value], Y ? [Y, yt.u, yt.g] : null);
      }
      if (from === windows[0][0]) {
        // Filter lists are dynamic: each narrowed by every OTHER filter, over all stock files.
        const fo = await timed(ctrl.getFilterOptions, sc);
        const SKU_DIMS = { gender: 'gender_name', category: 'category_norm', product: 'product', sub_product: 'sub_product', size: 'size', color: 'color_name', season: 'season' };
        const skuF = Object.entries(sc).filter(([k2]) => k2 in SCOPE_COL);   // every SKU-attribute filter, incl. shade / style
        const partnerOk = (name) => Object.entries(sc).every(([k2, val]) => (k2 === 'partner' ? String(val).split(',').includes(partner.get(name).id)
          : k2 === 'channel' ? String(val).split(',').includes(partner.get(name).channel) : k2 === 'partner_name' ? String(val).split('|').includes(name) : true));
        const itemOk = (it2, skip) => skuF.every(([k2, val]) => k2 === skip || String(val).split(',').includes(it2[SCOPE_COL[k2]]));
        const held = new Map();   // master item → set of partners that ever held it
        for (const pr of pairs) { const [pn, bc] = pr.split('\u0000'); const it2 = master(bc); if (!it2) continue; let e = held.get(it2); if (!e) held.set(it2, (e = new Set())); e.add(pn); }
        for (const [dim, col] of Object.entries(SKU_DIMS)) {
          const want = new Set();
          for (const [it2, ps] of held) if (it2[col] && itemOk(it2, dim) && [...ps].some(partnerOk)) want.add(it2[col]);
          eq(`${tag}: filter options ${dim}`, [...fo[dim]].sort(), [...want].sort());
        }
        const withStock = new Set();   // partners holding an item that passes the SKU filters
        for (const [it2, ps] of held) if (itemOk(it2)) for (const pn of ps) withStock.add(pn);
        const names = skuF.length ? [...withStock] : [...partner.keys()];
        const chans = 'channel' in sc ? String(sc.channel).split(',') : null;
        eq(`${tag}: filter options channel / partner`, [[...fo.channel].sort(), [...fo.partner_name].sort()],
          [[...new Set(names.map((n) => partner.get(n).channel))].sort(), names.filter((n) => !chans || chans.includes(partner.get(n).channel)).sort()]);
      }
      eq(`${tag}: partner count`, ov.kpis.partner_count, new Set(Object.entries(cRows.reduce((m, x) => { m[x.partner] = (m[x.partner] || 0) + x.qty; return m; }, {})).filter(([, u]) => u > 0).map(([n]) => n)).size);

      const inStockMatched = new Set(cRows.filter((x) => x.qty > 0 && master(x.barcode)).map((x) => skuId(x.barcode)));
      eq(`${tag}: sku count`, (await timed(ctrl.getSkuCount, q)).sku_count, inStockMatched.size);

      for (const dim of Object.keys(DIM)) {
        if (dim in sc || (dim === 'colour' && 'color' in sc)) continue;   // a filter on the dim itself is covered by the scope checks
        const exp = new Map();
        const cell = (k) => { let e = exp.get(k); if (!e) exp.set(k, (e = { qty: 0, p: 0, lines: 0, skus: new Set(), prev: 0 })); return e; };
        for (const x of cRows) { const e = cell(DIM[dim](x)); e.qty += x.qty; e.p += paise(x); e.lines += x.lines; if (x.qty > 0) e.skus.add(skuId(x.barcode)); }
        if (O && O !== C) for (const x of at(O, sc)) cell(DIM[dim](x)).prev += x.qty;
        const pv = await timed(ctrl.getPivot, { ...q, group_by: dim });
        const got = Object.fromEntries(pv.rows.map((x) => [x.key, [x.qty, x.value, x.lines, x.skus]]));
        const want = Object.fromEntries([...exp.entries()].map(([k2, e]) => [k2, [e.qty, rupees(e.p), e.lines, e.skus.size]]));
        const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
        const diff = [...keys].filter((k2) => JSON.stringify(got[k2]) !== JSON.stringify(want[k2]));
        check(`${tag}: pivot ${dim} (${keys.size} rows)`, diff.length === 0, `${diff.length} rows differ, e.g. ${diff[0]}: got ${JSON.stringify(got[diff[0]])} want ${JSON.stringify(want[diff[0]])}`);
        eq(`${tag}: pivot ${dim} total`, pv.totals ? pv.totals.qty : 0, c.u);
        const dWant = (e) => (O && O !== C && e.prev !== 0 ? Number((((e.qty - e.prev) / Math.abs(e.prev)) * 100).toFixed(1)) : null);
        check(`${tag}: pivot ${dim} Δ`, pv.rows.every((x) => x.delta_qty_vs_prev_pct === dWant(exp.get(x.key))));
      }

      for (const dim of ['partner', 'category']) {
        const tr = await timed(ctrl.getTrend, { ...q, group_by: dim, top: 6, measure: 'units' });
        eq(`${tag}: trend ${dim} dates`, tr.dates, inWin);
        check(`${tag}: trend ${dim} points`, tr.series.every((s) => s.points.every((pt) =>
          pt.value === at(pt.date, sc).filter((x) => DIM[dim](x) === s.key).reduce((a, x) => a + x.qty, 0))));
      }

      let page = 1; let units = 0; let n = 0; let total = 0; const seen = new Set();
      for (;;) { const it = await timed(ctrl.getItems, { ...q, limit: 100, page }); total = it.total; for (const x of it.rows) { units += x.units; n += 1; seen.add(x.barcode); } if (it.rows.length < 100) break; page += 1; }
      eq(`${tag}: SKU table pages cover every barcode once`, [total, n, seen.size, units], [new Set(cRows.map((x) => x.barcode)).size, total, total, c.u]);
    }
  }
  console.log(`  ${passed + failures.length - before} checks over ${windows.length} windows × ${scopes.length} filter sets — ${calls} endpoint calls in ${((Date.now() - t1) / 1000).toFixed(0)}s, slowest uncached ${slowest.toFixed(0)} ms`);

  // SKU detail panel: the biggest SKUs now, a junk barcode and a marketplace-suffixed one, in two windows
  const big = [...pos.get(latest).values()].sort((a, b) => b.qty - a.qty).slice(0, 4).map((x) => x.barcode);
  const samples = [...new Set([...big, 'NA', [...pairs].map((k2) => k2.split('\u0000')[1]).find((b) => /^\d{13}\D/.test(b))])];
  for (const [from, to] of [windows[0], windows[2], ['2025-04-01', '2025-04-30']]) {
    const C = [...snaps].reverse().find((d) => d <= to); const O0 = [...snaps].reverse().find((d) => d < from) || null; const O = O0 && O0 !== C ? O0 : null;
    for (const bc of samples) {
      const tag = `item ${bc} ${from}→${to}`;
      const all = oracle.filter((o) => o.barcode === bc);
      const sum = (d, pn) => all.filter((o) => o.date === d && (!pn || o.partner === pn)).reduce((a, o) => a + o.qty, 0);
      const det = await call(ctrl.getItem, { from, to, barcode: bc });
      const m = master(bc);
      eq(`${tag}: units / opening / value`, [det.units, det.opening_units, det.value, det.item.matched], [sum(C), O ? sum(O) : 0, m ? roundHalfAway(sum(C) * m.mrp) : null, Boolean(m)]);
      eq(`${tag}: history over every stock file`, det.history, snaps.map((d) => ({ d, u: sum(d) })));
      const names = [...new Set(all.filter((o) => o.date === C || o.date === O).map((o) => o.partner))];
      eq(`${tag}: by partner`, Object.fromEntries(det.partners.map((x) => [x.name, [x.units, x.opening_units, x.lines]])),
        Object.fromEntries(names.map((n) => [n, [sum(C, n), O ? sum(O, n) : 0, all.filter((o) => o.date === C && o.partner === n).length]])));
      if (m) {
        const run = {}; for (const x of pos.get(C).values()) { const mm = master(x.barcode); if (mm && mm.style === m.style && mm.color_name === m.color_name) run[mm.size] = (run[mm.size] || 0) + x.qty; }
        eq(`${tag}: size run`, Object.fromEntries(det.sizes.map((x) => [x.size, x.units])), run);
      }
    }
  }

  // ── ESales ageing vs an independent first-in-first-out walk over the oracle ──
  {
    const reported = new Map();   // partner → every stock date it appears in
    for (const [d, m] of pos) for (const x of m.values()) { let e = reported.get(x.partner); if (!e) reported.set(x.partner, (e = new Set())); e.add(d); }
    const monthNo = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    const bucketOf = (mo) => (mo <= 0 ? 'd0_30' : mo === 1 ? 'd31_60' : mo === 2 ? 'd61_90' : mo <= 5 ? 'd91_180' : mo <= 11 ? 'd181_365' : 'd365_plus');
    const layers = [];
    for (const [k2, x] of pos.get(latest)) {
      if (x.qty <= 0) continue;
      const dates = [...reported.get(x.partner)].sort().reverse();
      let m = Infinity; const mins = dates.map((d) => { m = Math.min(m, Math.max(pos.get(d).get(k2)?.qty || 0, 0)); return m; });
      mins.forEach((v, i) => { const units = v - (i + 1 < mins.length ? mins[i + 1] : 0); if (units > 0) layers.push({ partner: x.partner, barcode: x.barcode, units, bucket: bucketOf(monthNo(latest) - monthNo(dates[i])) }); });
    }
    eq('ageing: layers add up to the latest file', layers.reduce((a, l) => a + l.units, 0), [...pos.get(latest).values()].reduce((a, x) => a + Math.max(x.qty, 0), 0));
    const AGED = new Set(['d91_180', 'd181_365', 'd365_plus']);
    for (const sc of [{}, { channel: 'Myntra' }, { partner_name: 'Panchanan International Pvt. Ltd.|ZEPTO -UJ' }, { category: 'DENIM', gender: 'MENS' }, { season: top('season')[0][0], channel: 'Flipkart,Reliance Retail' }]) {
      const tag = `ageing ${JSON.stringify(sc)}`;
      const mine = layers.filter(inScope(sc));
      const sumBy = (rows, keyFn) => { const o = {}; for (const l of rows) { const k2 = keyFn(l); if (k2 == null) continue; const e = (o[k2] ||= { units: 0, value: 0, aged: 0, buckets: {} }); e.units += l.units; e.value += master(l.barcode) ? roundHalfAway(l.units * master(l.barcode).mrp) : 0; if (AGED.has(l.bucket)) e.aged += l.units; e.buckets[l.bucket] = (e.buckets[l.bucket] || 0) + l.units; } return o; };
      const all = sumBy(mine, () => 'all').all || { units: 0, value: 0, aged: 0, buckets: {} };
      const sm = await call(age.getSummary, { source: 'esales', ...sc });
      eqc(`${tag}: buckets`, Object.fromEntries(sm.buckets.filter((b) => b.units).map((b) => [b.key, b.units])), all.buckets);
      eq(`${tag}: totals`, [sm.total_units, sm.total_value_gross, sm.aged_units, sm.aged_pct, sm.meta.as_of],
        [all.units, all.value, all.aged, all.units ? Number((all.aged / all.units * 100).toFixed(1)) : null, latest]);
      for (const [dim, keyFn] of [['partner', (l) => l.partner], ['channel', (l) => partner.get(l.partner).channel], ['category', (l) => master(l.barcode)?.category_norm], ['size', (l) => master(l.barcode)?.size], ['season', (l) => master(l.barcode)?.season]]) {
        const want = sumBy(mine, keyFn);
        const pv = await call(age.getPivot, { source: 'esales', group_by: dim, ...sc });
        eqc(`${tag}: by ${dim}`, Object.fromEntries(pv.rows.map((x) => [x.key, [x.units, x.value_gross, x.aged_units, Object.fromEntries(Object.entries(x.buckets).filter(([, v]) => v))]])),
          Object.fromEntries(Object.entries(want).map(([k2, e]) => [k2, [e.units, e.value, e.aged, e.buckets]])));
      }
    }
  }

  // warm path
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) await call(ctrl.getOverview, { from: '2026-04-01', to: '2026-10-12' });
  console.log(`  cached overview: ${(Number(process.hrtime.bigint() - t) / 1e6 / 200).toFixed(3)} ms per call`);
}

(async () => {
  await part1();
  await part2and3();
  if (process.env.ESALES_VERIFY_DIR && process.env.ESALES_ORACLE_CSV) await part4(process.env.ESALES_VERIFY_DIR, process.env.ESALES_ORACLE_CSV);
  else console.log('\n(PART 4 skipped — set ESALES_VERIFY_DIR and ESALES_ORACLE_CSV to verify the real workbooks)');
  console.log(`\n${failures.length ? '✗' : '✓'} ${passed} passed, ${failures.length} failed`);
  if (failures.length) failures.slice(0, 40).forEach((f) => console.log(`  ✗ ${f}`));
  await pool.end();
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
