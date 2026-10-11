/**
 * xlsxLite.js — read ONE sheet of an .xlsx workbook as raw cell values.
 * ─────────────────────────────────────────────────────────────────────────────
 * An .xlsx is a zip of XML parts; Node ships zlib but no zip reader, and the
 * backend has no spreadsheet dependency. This reads exactly what the ESales
 * loader needs — cell text/number as stored, no formatting, no formulas — and
 * fails loudly on anything it does not understand (zip64, encryption, a bad
 * CRC) instead of returning a partial sheet.
 *
 *   const { readSheet } = require('./xlsxLite');
 *   const { date1904, rows } = readSheet(buffer, (name) => name === 'Consolidate');
 *   rows → [{ r: 1, cells: [{ v: 'Partner', t: 's' }, …] }, …]   (cells indexed by column, holes = undefined)
 *
 * ponytail: whole-file in memory + regex tokenising — fine for the ~3 MB
 * workbooks this feed carries; switch to a streaming SAX parser if they ever
 * reach hundreds of MB.
 */

'use strict';

const zlib = require('zlib');

// ── zip container ────────────────────────────────────────────────────────────
function zipEntries(buf) {
  // End-of-central-directory record: last 22+ bytes (a trailing comment may follow).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('zip64 workbooks are not supported');

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (flags & 1) throw new Error('password-protected workbooks are not supported');
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error('zip64 workbooks are not supported');
    entries.set(name, { method, crc, csize, usize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  let out;
  if (e.method === 0) out = raw;
  else if (e.method === 8) out = zlib.inflateRawSync(raw);
  else throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  if (out.length !== e.usize || zlib.crc32(out) !== e.crc) throw new Error(`zip CRC/size mismatch for ${name} — file is corrupt or still uploading`);
  return out.toString('utf8');
}

// ── XML helpers (SpreadsheetML is regular enough to tokenise) ────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s) {
  if (s.indexOf('&') === -1 && s.indexOf('_x') === -1) return s;
  return s
    .replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(\w+));/g, (m, hex, dec, named) => (
      hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(parseInt(dec, 10)) : (ENT[named] ?? m)))
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));   // Excel's escape for control chars
}
const attr = (tag, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
// Text of a string item: every <t> run, minus phonetic (<rPh>) guides.
function textOf(xml) {
  let out = '';
  const body = xml.indexOf('<rPh') === -1 ? xml : xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  for (let m; (m = re.exec(body));) out += unxml(m[1] || '');
  return out;
}
function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/**
 * @param {Buffer} buf       the .xlsx file
 * @param {(name: string) => boolean} pickSheet  chooses the sheet by its tab name
 * @returns {{ sheetName: string, date1904: boolean, rows: Array<{ r: number, cells: Array<{ v: string, t: string }|undefined> }> }}
 */
function readSheet(buf, pickSheet) {
  const entries = zipEntries(buf);
  const wb = zipRead(buf, entries, 'xl/workbook.xml');
  const rels = zipRead(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('not an Excel workbook (xl/workbook.xml missing)');

  const targets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) targets.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) sheets.push({ name: attr(m[0], 'name'), rid: attr(m[0], 'r:id') });
  const hits = sheets.filter((s) => pickSheet(s.name));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one matching sheet, found ${hits.length} (sheets: ${sheets.map((s) => s.name).join(', ')})`);
  }
  const target = targets.get(hits[0].rid);
  if (!target) throw new Error(`sheet "${hits[0].name}" has no part in the workbook`);
  const sheetXml = zipRead(buf, entries, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  if (sheetXml == null) throw new Error(`sheet part ${target} missing from the workbook`);

  const shared = [];
  const sst = zipRead(buf, entries, 'xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(m[1] || ''));

  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(wb);
  const rows = [];
  let seq = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (let rm; (rm = rowRe.exec(sheetXml));) {
    seq += 1;
    const r = Number(attr(rm[1], 'r')) || seq;
    seq = r;
    const cells = [];
    if (rm[2]) {
      cellRe.lastIndex = 0;
      let next = 0;
      for (let cm; (cm = cellRe.exec(rm[2]));) {
        const ref = attr(cm[1], 'r');
        const i = ref ? colIndex(ref) : next;
        next = i + 1;
        const t = attr(cm[1], 't') || 'n';
        const body = cm[2] || '';
        let v = null;
        if (t === 'inlineStr') v = textOf(body);
        else {
          const vm = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(body);
          if (vm) {
            const raw = unxml(vm[1] || '');
            if (t === 's') {
              v = shared[Number(raw)];
              if (v === undefined) throw new Error(`row ${r}: shared string #${raw} missing`);
            } else v = raw;
          }
        }
        if (v !== null && v !== '') cells[i] = { v, t };
      }
    }
    rows.push({ r, cells });
  }
  return { sheetName: hits[0].name, date1904, rows };
}

module.exports = { readSheet };
