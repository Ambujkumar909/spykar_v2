// ─── War Room controller — /api/v1/war-room ─────────────────────────────────
// board          every store × every period for one as-on date (services/warRoom.js)
// meta           the sales date range
// filter-options lists for the Lens rail
// notes (PUT)    save the ASM reason / action for a store's week
// export.xlsx    the board as a workbook, with the notes
const zlib = require('zlib');
const { getOrSet, invalidatePattern } = require('../config/cache');
const { query } = require('../config/database');
const wr = require('../services/warRoom');
const engine = require('../services/wrEngine');
const { writeWorkbook } = require('../services/xlsxWrite');

const DAY = 24 * 3600;
const PRODUCT_KEYS = ['gender', 'category', 'product', 'sub_product', 'size', 'color', 'season'];
// Lists sorted so the same selection in any order is one cache entry.
const norm = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).sort().join(',');
const boardKey = (q) => `wr:board:${q.as_on || ''}|${PRODUCT_KEYS.map((k) => norm(q[k])).join('|')}`;
const meta = () => getOrSet('wr:meta', () => wr.getMeta(), 300);
// The as-on date resolved first (missing or past the data → the latest sales
// day), so "latest" and an explicit latest date share one cache entry.
async function resolve(q) {
  const { from, to } = await meta();
  const d = q.as_on || to;
  const r = { as_on: !to || d > to ? to : from && d < from ? from : d };   // clamped into the data range
  for (const k of PRODUCT_KEYS) if (norm(q[k])) r[k] = norm(q[k]);
  return r;
}
// Boards are big (~0.5 MB each): keep the 40 most recently used, drop the rest.
const recent = new Map();
function touch(key) {
  recent.delete(key); recent.set(key, true);
  while (recent.size > 40) { const old = recent.keys().next().value; recent.delete(old); invalidatePattern(old).catch(() => {}); invalidatePattern(`${old}:wire`).catch(() => {}); }
}
async function board(q) { const r = await resolve(q); const k = boardKey(r); touch(k); return getOrSet(k, () => wr.buildBoard(r), DAY); }
const growth = (a, b) => (b ? a / b - 1 : null);

// The response is cached serialised AND gzipped: a hit sends ready bytes —
// no JSON.stringify, no compression per request.
async function getBoard(req, res, next) {
  try {
    const r = await resolve(req.query);
    touch(boardKey(r));
    const body = await getOrSet(`${boardKey(r)}:wire`, async () => {
      const json = JSON.stringify({ success: true, data: await board(r) });
      return { json, gz: zlib.gzipSync(json, { level: 6 }) };
    }, DAY);
    res.set('Vary', 'Accept-Encoding').type('application/json');
    if (/\bgzip\b/.test(req.get('Accept-Encoding') || '')) res.set('Content-Encoding', 'gzip').send(body.gz);
    else res.send(body.json);
  } catch (err) { next(err); }
}

async function getMeta(req, res, next) {
  try { res.json({ success: true, data: await meta() }); } catch (err) { next(err); }
}

// Cascading lists: each dimension's options are the values present among the
// stores (or sold SKUs) that match every OTHER selected filter.
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
function facet(items, dims, sel) {
  const out = {};
  for (const [key, f] of Object.entries(dims)) {
    const others = Object.entries(dims).filter(([k]) => k !== key && sel[k] && sel[k].length);
    const vals = new Set();
    for (const it of items) if (others.every(([k, g]) => sel[k].includes(String(g(it) ?? '')))) { const v = f(it); if (v) vals.add(String(v)); }
    out[key] = [...vals].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
  }
  return out;
}
const STORE_FACETS = {
  wr_channel: (s) => s.channel, wr_region: (s) => s.region, wr_type: (s) => s.type, wr_asm: (s) => s.asm,
  state: (s) => s.state, city: (s) => s.city, store_code: (s) => s.code,
};
const SKU_FACETS = { gender_name: (r) => r.g, category: (r) => r.c, product: (r) => r.p, sub_product: (r) => r.sp, size: (r) => r.z, color: (r) => r.co, season: (r) => r.se };

async function getFilterOptions(req, res, next) {
  try {
    const key = `wr:opts:${Object.keys(req.query).sort().map((k) => `${k}=${norm(req.query[k])}`).join('&')}`;
    res.json(await getOrSet(key, () => buildOptions(req), 120));   // a selection's lists, reused for 2 minutes
  } catch (err) { next(err); }
}

async function buildOptions(req) {
  {
    const b = await board({ as_on: req.query.as_on });
    const from = b.periods ? b.periods.ytdly[0] : '1900-01-01';
    const [attrs, notes] = await Promise.all([
      getOrSet(`wr:skuattrs:${from}`, async () => {
        const e = await engine.current();
        if (e) return engine.soldAttrs(e, from);        // from memory
        return (await query(`
        SELECT DISTINCT COALESCE(s.gender_name, '') AS g, COALESCE(s.category_norm, '') AS c,
               regexp_replace(COALESCE(s.product, ''), '\\s*[<>].*$', '') AS p, s.sub_product AS sp, s.size AS z, s.color_name AS co, s.season AS se
        FROM skus s JOIN (SELECT DISTINCT sku_id FROM inventory_movements WHERE movement_type = 'SALE' AND moved_at >= $1::date) x ON x.sku_id = s.id
        WHERE s.is_active`, [from])).rows;
      }, DAY),
      wr.getNotes(b.periods ? b.periods.weekStart : new Date().toISOString().slice(0, 10)),
    ]);
    const stores = b.stores.map((s) => ({ ...s, asm: notes.asm[s.code] || '' }));
    const sel = Object.fromEntries([...Object.keys(STORE_FACETS), 'gender', 'category', 'product', 'sub_product', 'size', 'color', 'season']
      .map((k) => [k === 'gender' ? 'gender_name' : k, csv(req.query[k])]));
    return { success: true, options: {
      ...facet(stores, STORE_FACETS, sel),
      ...facet(attrs, SKU_FACETS, sel),
      wr_status: ['Growth', 'Stable', 'Soft', 'Degrowth', 'Critical', 'New', 'Closed'],
      wr_review: ['Reviewed', 'Pending'],
    } };
  }
}

async function getNotes(req, res, next) {
  try { res.json({ success: true, data: await wr.getNotes(req.query.week_start) }); } catch (err) { next(err); }
}

async function saveNote(req, res, next) {
  try {
    const { rows } = await query('SELECT 1 FROM locations WHERE external_id = $1 AND is_active LIMIT 1', [req.body.external_id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Unknown store' });
    const r = await wr.saveNote(req.body, req.user);
    await invalidatePattern('wr:asm*');
    await invalidatePattern('wr:opts:*');   // the ASM list may have changed
    res.json({ success: true, data: r });
  } catch (err) { next(err); }
}

// The board as a workbook: one row per store + the period dates.
async function exportXlsx(req, res, next) {
  try {
    const b = await board(req.query);
    const P = b.periods;
    if (!P) return res.status(404).json({ success: false, message: 'No sales data' });
    const nt = await wr.getNotes(P.weekStart);
    const L = (v) => (v == null ? null : Math.round(v) / 1e5);           // ₹ → lakh
    const H = (s) => ({ v: s, s: 1 });
    const pc = (v) => ({ v: v == null || !Number.isFinite(v) ? null : v, s: 2 });
    const head = ['Store code', 'Store', 'City', 'State', 'Region', 'Channel', 'Type', 'ASM',
      'Week qty', 'Week ₹ lakh', 'PW ₹ lakh', 'LY week ₹ lakh', 'vs PW', 'vs LY',
      'MTD qty', 'MTD ₹ lakh', 'MTD LY ₹ lakh', 'MTD GoLY',
      'YTD qty', 'YTD ₹ lakh', 'YTD MRP ₹ lakh', 'YTD disc %', 'YTD LY ₹ lakh', 'YTD GoLY',
      'MTD bills', 'MTD bills GoLY', 'MTD UPT', 'MTD ASP ₹', 'MTD ATV ₹', 'YTD bills', 'YTD UPT', 'YTD ASP ₹', 'YTD ATV ₹',
      'Weeks below LY (in a row)', 'Reason', 'Action', 'Updated by'];
    const rows = [head.map(H)];
    for (const s of b.stores) {
      const m = s.m;
      const kpi = (x) => [x[3], x[3] ? x[0] / x[3] : null, x[0] ? x[1] / x[0] : null, x[3] ? x[1] / x[3] : null];
      let streak = 0; for (let i = s.wk.length - 2; i >= 0 && s.wk[i] < s.wkly[i]; i--) streak++;   // full weeks only
      const km = kpi(m.mtd);
      const note = nt.notes[s.code];
      rows.push([s.code, s.name, s.city, s.state, s.region, s.channel, s.type, nt.asm[s.code] || '',
        m.cw[0], L(m.cw[1]), L(m.pw[1]), L(m.ly[1]), pc(growth(m.cw[1], m.pw[1])), pc(growth(m.cw[1], m.ly[1])),
        m.mtd[0], L(m.mtd[1]), L(m.mtdly[1]), pc(growth(m.mtd[1], m.mtdly[1])),
        m.ytd[0], L(m.ytd[1]), L(m.ytd[2]), pc(m.ytd[2] ? 1 - m.ytd[1] / m.ytd[2] : null), L(m.ytdly[1]), pc(growth(m.ytd[1], m.ytdly[1])),
        km[0], pc(growth(m.mtd[3], m.mtdly[3])), km[1], km[2], km[3], ...kpi(m.ytd),
        streak, note?.reason || '', note?.action || '', note?.by || '']);
    }
    const dates = [['Period', 'From', 'To'].map(H),
      ...[['Week', 'cw'], ['Previous week', 'pw'], ['LY week', 'ly'], ['MTD', 'mtd'], ['MTD LY', 'mtdly'], ['YTD', 'ytd'], ['YTD LY', 'ytdly']].map(([l, k]) => [l, P[k][0], P[k][1]]),
      ['Closing stock', P.stock.ty || 'n/a', P.stock.ly || 'n/a']];
    const buf = writeWorkbook([
      { name: 'War Room', rows, widths: [9, 34, 14, 14, 9, 14, 11, 16, ...new Array(head.length - 8).fill(11)], freeze: 1 },
      { name: 'Periods', rows: dates, widths: [16, 13, 13], freeze: 1 },
    ]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="War_Room_${P.asOn}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) { next(err); }
}

module.exports = { getBoard, getMeta, getFilterOptions, getNotes, saveNote, exportXlsx };
