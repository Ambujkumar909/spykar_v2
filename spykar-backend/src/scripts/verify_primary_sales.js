/**
 * verify_primary_sales.js — end-to-end verification of the Primary Sales ETL
 * ─────────────────────────────────────────────────────────────────────────────
 * Drives the REAL engine (src/services/primarySales.js) through backfill →
 * crash → resume → delta → idempotent delta → reconcile (×3) → window reload →
 * bootstrap, against a FAKE M3 (in-process, deterministic dataset with fault
 * injection) and a THROWAWAY Postgres database created from the real
 * schema + migrations. After every stage the ledger is compared row-by-row to
 * an independently computed expectation, and the rollup is compared both to a
 * direct SQL re-aggregation of the ledger and to a JS re-aggregation of the
 * source dataset. Nothing here touches the real database.
 *
 *   npm run primary:verify            (add --keep to leave the test DB behind)
 *
 * Exit code 0 = every check passed.
 */

'use strict';

require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { Client } = require('pg');

const MAIN_DB = process.env.PG_DATABASE || 'spykar_inventory';
const TEST_DB = `${MAIN_DB}_primary_verify`;
const KEEP = process.argv.includes('--keep');
process.env.PG_DATABASE = TEST_DB;            // every module below binds to the test DB
process.env.PG_POOL_MAX = '12';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

// ─── tiny test runner ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, extra = '') {
  if (cond) passed++; else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 70 - s.length))}`);

// ─── deterministic PRNG ──────────────────────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rnd = rng(20260917);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const r2 = (x) => Math.round(x * 100) / 100;
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };

// ─── the fake M3 ─────────────────────────────────────────────────────────────
// Dataset row = one MITTRA line joined to MITMAS (stcd) and MITWHL (divi).
const AAA_WHS = [
  { WHLO: 'W01', WHNM: 'Central DC' }, { WHLO: 'W02', WHNM: 'North Hub' }, { WHLO: 'W03', WHNM: 'South Hub' },
];
const NON_AAA_WH = 'W99';
const ITEMS = [];                                  // { itno, mapVia, stcd, mrp, cost }
for (let i = 0; i < 150; i++) {
  const itno = `IT${String(i).padStart(4, '0')}`;
  const mapVia = i < 130 ? 'infor' : i < 140 ? 'style' : null;      // 140–144 unmappable
  const stcd = i >= 145 ? 0 : 1;                                     // 145–149 excluded at source
  ITEMS.push({ itno, mapVia, stcd, mrp: r2(100 + i + (i % 2 ? 0.5 : 0)), cost: i % 7 === 0 ? null : r2(60 + i * 0.25) });
}
const ITEM = new Map(ITEMS.map((x) => [x.itno, x]));
const TTYPS = [25, 31, 50, 51, 92, 93];
const positive = (t) => t === 25 || t === 50 || t === 92;
const FIRST_DAY = '2026-06-01', LAST_DAY = '2026-06-30';

let tmsxSeq = 1;
function makeRow(whlo, it, trdt, lmts) {
  const ttyp = pick(TTYPS);
  const q = int(1, 40) * (positive(ttyp) ? 1 : -1);
  const rgdt = rnd() < 0.9 ? trdt : addDays(trdt, -1);
  let whsl = 'A01';
  const p = rnd();
  if (p < 0.01) whsl = 'L,1'; else if (p < 0.02) whsl = 'Q"2'; else if (p < 0.025) whsl = 'N\n3';
  return {
    CONO: 92, WHLO: whlo, ITNO: it.itno, TRDT: trdt, RGDT: rgdt, RGTM: int(0, 235959), TMSX: tmsxSeq++,
    NSTT: int(0, 5000), TTYP: ttyp, TRTP: String(int(10, 99)), WHSL: whsl,
    TRPR: rnd() < 0.3 ? 0 : r2(it.mrp * (0.8 + rnd() * 0.4)), PUPR: rnd() < 0.3 ? 0 : (it.cost ?? 0),
    TRQT: q, REPN: tmsxSeq, STAS: '1', LMTS: lmts, stcd: it.stcd,
    divi: whlo === NON_AAA_WH ? 'BBB' : 'AAA',
  };
}
function buildDataset() {
  const rows = [];
  let day = FIRST_DAY;
  while (day <= LAST_DAY) {
    for (const wh of [...AAA_WHS.map((w) => w.WHLO), NON_AAA_WH]) {
      for (const it of ITEMS) {
        const n = rnd() < 0.55 ? 0 : int(1, 3);
        for (let k = 0; k < n; k++) {
          // LMTS: mid-morning UTC of the trade day. Last day → all within one hour
          // (so the delta's 1h overlap re-reads them as no-ops). 1% NULL.
          let lmts = new Date(`${day}T10:00:00Z`);
          lmts = new Date(lmts.getTime() + (day === LAST_DAY ? int(0, 59) : int(0, 600)) * 60000);
          if (rnd() < 0.01) lmts = null;
          rows.push(makeRow(wh, it, day, lmts));
        }
      }
    }
    day = addDays(day, 1);
  }
  return rows;
}

const SRC_VISIBLE = (r) => r.CONO === 92 && r.stcd === 1 && r.divi === 'AAA';

class FakeRequest extends EventEmitter {
  constructor(m3) { super(); this.m3 = m3; this.stream = false; this.paused = false; this.cancelled = false; }
  async query(text) {
    this.m3.queries.push(text);
    if (!this.stream) return { recordset: this.m3.recordset(text) };
    const rows = this.m3.select(text);
    const fail = this.m3.takeFailure(text);
    let i = 0;
    const pump = () => {
      if (this.cancelled) return;
      if (this.paused) { setTimeout(pump, 1); return; }
      let n = 0;
      while (i < rows.length && n < 400 && !this.paused) {
        if (fail && i === fail.afterRows) {
          if (fail.stall) return;   // silent VPN drop: no error, no done, no more rows — ever
          this.emit('error', new Error('FAKE M3: connection reset by peer (injected)')); return;
        }
        this.emit('row', this.m3.toM3(rows[i])); i++; n++;
      }
      if (i >= rows.length) { this.emit('done', { rowsAffected: [rows.length] }); return; }
      setImmediate(pump);
    };
    setImmediate(pump);
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  cancel() { this.cancelled = true; }
}

class FakeM3 {
  constructor(rows) { this.rows = rows; this.queries = []; this.failures = []; this.streamQueries = () => this.queries.filter((q) => /^SELECT (TOP \d+ )?\s*A\.CONO/.test(q.trim())); }
  request() { return new FakeRequest(this); }
  async close() {}
  takeFailure(text) { const i = this.failures.findIndex((f) => f.match.test(text)); return i >= 0 ? this.failures.splice(i, 1)[0] : null; }
  toM3(r) {
    return { CONO: r.CONO, WHLO: r.WHLO, ITNO: r.ITNO, TRDT: new Date(r.TRDT + 'T00:00:00Z'), RGDT: new Date(r.RGDT + 'T00:00:00Z'),
      RGTM: r.RGTM, TMSX: r.TMSX, NSTT: r.NSTT, TTYP: r.TTYP, TRTP: r.TRTP, WHSL: r.WHSL, TRPR: r.TRPR, PUPR: r.PUPR,
      TRQT: r.TRQT, REPN: r.REPN, STAS: r.STAS, LMTS: r.LMTS };
  }
  // Evaluate the engine's WHERE fragments (the fake understands exactly the
  // predicates the engine emits — anything else is a test failure).
  select(text) {
    let rows = this.rows.filter(SRC_VISIBLE);
    const m = (re) => text.match(re);
    const wh = m(/A\.WHLO = '([^']+)'/); if (wh) rows = rows.filter((r) => r.WHLO === wh[1]);
    const whIn = m(/A\.WHLO IN \(([^)]+)\)/); if (whIn) { const set = new Set(whIn[1].split(',').map((s) => s.trim().replace(/'/g, ''))); rows = rows.filter((r) => set.has(r.WHLO)); }
    const itIn = m(/A\.ITNO IN \(([^)]+)\)/); if (itIn) { const set = new Set(itIn[1].split(',').map((s) => s.trim().replace(/'/g, ''))); rows = rows.filter((r) => set.has(r.ITNO)); }
    const bt = m(/A\.TRDT BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/); if (bt) rows = rows.filter((r) => r.TRDT >= bt[1] && r.TRDT <= bt[2]);
    const inl = m(/A\.TRDT IN \(([^)]+)\)/); if (inl) { const set = new Set(inl[1].split(',').map((s) => s.trim().replace(/'/g, ''))); rows = rows.filter((r) => set.has(r.TRDT)); }
    const lm = m(/A\.LMTS > '([^']+)'/); if (lm) { const b = new Date(lm[1] + 'Z').getTime(); rows = rows.filter((r) => r.LMTS && r.LMTS.getTime() > b); }
    const top = m(/SELECT TOP (\d+)/); if (top) rows = rows.slice(0, parseInt(top[1], 10));
    const known = ['A.WHLO =', 'A.WHLO IN', 'A.ITNO IN', 'A.TRDT BETWEEN', 'A.TRDT IN', 'A.LMTS >', 'SELECT TOP'];
    const extra = text.split("D.DIVI = 'AAA'")[1] || '';
    if (extra.replace(/\s/g, '') && !known.some((k) => extra.includes(k))) throw new Error(`FakeM3: unknown predicate in ${extra}`);
    return rows;
  }
  recordset(text) {
    if (/SELECT TOP 1 1/.test(text)) return [{ '': 1 }];
    if (/FROM M3ReportdataPRD\.dbo\.MITWHL WHERE CONO = 92 AND DIVI = 'AAA'/.test(text)) {
      return AAA_WHS.map((w) => ({ CONO: 92, WHLO: w.WHLO, WHNM: w.WHNM, DIVI: 'AAA', FACI: 'F01', WHTY: '1' }));
    }
    if (/COUNT_BIG\(\*\)/.test(text)) {
      const bt = text.match(/A\.TRDT BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/);
      const counts = new Map();
      for (const r of this.rows) if (SRC_VISIBLE(r) && r.TRDT >= bt[1] && r.TRDT <= bt[2]) counts.set(r.TRDT, (counts.get(r.TRDT) || 0) + 1);
      return [...counts.entries()].map(([d, c]) => ({ d, c }));
    }
    throw new Error(`FakeM3: unexpected non-stream query: ${text.slice(0, 120)}`);
  }
}

// ─── expectations computed independently of the engine ──────────────────────
const rowKey = (r) => `${r.CONO}|${r.WHLO}|${r.ITNO}|${r.RGDT}|${r.RGTM}|${r.TMSX}`;
function expectedLedger(rows, { mappable }) {
  const out = new Map();
  for (const r of rows) {
    if (!SRC_VISIBLE(r) || !mappable(r.ITNO)) continue;
    const k = rowKey(r); const cur = out.get(k);
    if (!cur || ((r.LMTS ? r.LMTS.getTime() : -1) >= (cur.LMTS ? cur.LMTS.getTime() : -1))) out.set(k, r);
  }
  return out;
}
function expectedRollup(ledger) {
  const g = new Map();
  for (const r of ledger.values()) {
    const it = ITEM.get(r.ITNO); const price = r.TRPR !== 0 ? r.TRPR : it.mrp; const cost = r.PUPR !== 0 ? r.PUPR : (it.cost ?? 0);
    const k = `${r.TRDT}|${r.WHLO}|${r.ITNO}|${r.TTYP}`;
    const a = g.get(k) || { qty: 0, gross: 0, gabs: 0, cost: 0, txns: 0 };
    a.qty += r.TRQT; a.gross += r.TRQT * price; a.gabs += Math.abs(r.TRQT * price); a.cost += r.TRQT * cost; a.txns++;
    g.set(k, a);
  }
  return g;
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  const admin = new Client({ host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT) || 5432, database: MAIN_DB,
    user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false });
  await admin.connect();
  console.log(`Creating throwaway database ${TEST_DB} (real schema + migrations)…`);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  const mig = spawnSync(process.execPath, [path.join(__dirname, '..', 'database', 'migrate.js')], { env: { ...process.env, PG_DATABASE: TEST_DB }, encoding: 'utf8' });
  if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); throw new Error('migrations failed on the test DB'); }
  check('schema + all migrations applied to a fresh database', /All migrations completed/.test(mig.stdout));

  const { pool, query } = require('../config/database');
  const cache = require('../config/cache');
  const logger = require('../config/logger');
  const P = require('../services/primarySales');
  const ctrl = require('../controllers/primarySales.controller');
  const LOGS = [];
  for (const lvl of ['warn', 'info', 'error']) { const o = logger[lvl].bind(logger); logger[lvl] = (m, ...a) => { LOGS.push(String(m)); return o(m, ...a); }; }

  // Seed the SKU master: infor_item_code for most, style_variant for some,
  // nothing for the unmappable ones (145–149 exist but are STCD=0 at source).
  for (const it of ITEMS) {
    if (!it.mapVia && it.stcd === 1) continue;
    await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, cost_price, is_active, infor_item_code, style_variant, category_norm, product, gender_name)
                 VALUES ($1,$2,'BLK','Black',$3,$4,$5,$6,$7,$8,'DENIM','Jeans','Men')`,
      [`SKU-${it.itno}`, `Product ${it.itno}`, pick(['28', '30', '32', '34']), it.mrp, it.cost, ITEMS.indexOf(it) % 11 !== 0,
        it.mapVia === 'infor' ? it.itno : null, it.mapVia === 'style' ? it.itno.toLowerCase() : null]);
  }
  const skuRows = (await query('SELECT id, infor_item_code, style_variant FROM skus')).rows;
  const skuIdToItno = new Map(skuRows.map((r) => [r.id, (r.infor_item_code || r.style_variant || '').toUpperCase()]));
  const mappable = (itno) => { const it = ITEM.get(itno); return !!(it && it.mapVia); };
  check('SKU master seeded (140 mappable + 5 STCD=0 codes; 5 codes deliberately missing)', skuRows.length === 145, `${skuRows.length} skus`);

  const DATA = buildDataset();
  const fake = new FakeM3(DATA);
  P._internal.setM3Connect(async () => fake);
  const srcVisible = DATA.filter(SRC_VISIBLE).length;
  console.log(`Fake M3 dataset: ${DATA.length} MITTRA rows, ${srcVisible} visible to the source filter`);

  // ── comparators ─────────────────────────────────────────────────────────
  async function compareLedger(label) {
    const exp = expectedLedger(DATA, { mappable });
    const got = (await query(`SELECT cono, whlo, itno, rgdt::text rgdt, rgtm, tmsx, trdt::text trdt, trqt, trpr, pupr, ttyp, whsl, lmts FROM primary_sales_movements`)).rows;
    const gotMap = new Map(got.map((r) => [`${r.cono}|${r.whlo}|${r.itno}|${r.rgdt}|${r.rgtm}|${r.tmsx}`, r]));
    let mismatches = 0; const sample = [];
    for (const [k, e] of exp) {
      const g = gotMap.get(k);
      const ok = g && g.trdt === e.TRDT && Number(g.trqt) === e.TRQT && Math.abs(Number(g.trpr) - e.TRPR) < 1e-6 && Math.abs(Number(g.pupr) - e.PUPR) < 1e-6
        && String(g.ttyp) === String(e.TTYP) && g.whsl === e.WHSL && ((g.lmts == null && e.LMTS == null) || (g.lmts && e.LMTS && g.lmts.getTime() === e.LMTS.getTime()));
      if (!ok) { mismatches++; if (sample.length < 3) sample.push({ k, got: g && { trdt: g.trdt, trqt: g.trqt, whsl: g.whsl }, exp: { trdt: e.TRDT, trqt: e.TRQT, whsl: e.WHSL } }); }
    }
    const extra = got.length - exp.size;
    check(`${label}: ledger == expected (${exp.size} rows, row-by-row)`, mismatches === 0 && extra === 0,
      `mismatches=${mismatches} extra=${extra}${sample.length ? ' ' + JSON.stringify(sample) : ''}`);
    const dup = (await query(`SELECT count(*)::int c FROM (SELECT 1 FROM primary_sales_movements GROUP BY cono, whlo, itno, rgdt, rgtm, tmsx HAVING count(*) > 1) x`)).rows[0].c;
    check(`${label}: zero duplicate keys`, dup === 0, `dups=${dup}`);
    return exp;
  }
  async function compareRollup(label, exp) {
    const sqlTruth = (await query(`SELECT count(*)::int rows, coalesce(sum(qty),0) qty, coalesce(sum(gross),0) gross, coalesce(sum(gross_abs),0) gabs, coalesce(sum(cost),0) cost, coalesce(sum(txns),0)::bigint txns FROM (${P._internal.rollupSelect('')}) x`)).rows[0];
    const roll = (await query(`SELECT count(*)::int rows, coalesce(sum(qty),0) qty, coalesce(sum(gross),0) gross, coalesce(sum(gross_abs),0) gabs, coalesce(sum(cost),0) cost, coalesce(sum(txns),0)::bigint txns FROM primary_sales_daily`)).rows[0];
    const sameTotals = ['rows', 'qty', 'gross', 'gabs', 'cost', 'txns'].every((k) => String(roll[k]) === String(sqlTruth[k]));
    check(`${label}: rollup == SQL re-aggregation of the ledger`, sameTotals, `rollup=${JSON.stringify(roll)} truth=${JSON.stringify(sqlTruth)}`);
    // JS re-aggregation of the SOURCE dataset (independent of any SQL).
    const jsExp = expectedRollup(exp);
    const rows = (await query(`SELECT r.trdt::text d, w.whlo, r.sku_id, r.ttyp, r.qty, r.gross, r.gross_abs, r.cost, r.txns FROM primary_sales_daily r JOIN primary_warehouses w ON w.id = r.warehouse_id`)).rows;
    let bad = 0;
    for (const r of rows) {
      const e = jsExp.get(`${r.d}|${r.whlo}|${skuIdToItno.get(r.sku_id)}|${r.ttyp}`);
      if (!e || Number(r.qty) !== e.qty || Math.abs(Number(r.gross) - e.gross) > 0.02 || Math.abs(Number(r.gross_abs) - e.gabs) > 0.02 || Math.abs(Number(r.cost) - e.cost) > 0.02 || Number(r.txns) !== e.txns) bad++;
    }
    check(`${label}: rollup == JS re-aggregation of the source (${jsExp.size} groups)`, bad === 0 && rows.length === jsExp.size, `bad=${bad} rows=${rows.length}`);
    // Warehouse-grain rollup must equal a fresh re-aggregation of the sku grain
    // (same SQL the engine uses) AND a JS re-aggregation of the source.
    const whTruth = (await query(`SELECT count(*)::int rows, coalesce(sum(qty),0) qty, coalesce(sum(gross),0) gross, coalesce(sum(gross_abs),0) gabs, coalesce(sum(cost),0) cost, coalesce(sum(txns),0)::bigint txns, coalesce(sum(sku_rows),0)::bigint sku_rows FROM (${P._internal.whRollupSelect('primary_sales_daily')}) x(trdt, warehouse_id, ttyp, category_norm, qty, gross, gross_abs, cost, txns, sku_rows)`)).rows[0];
    const whRoll = (await query(`SELECT count(*)::int rows, coalesce(sum(qty),0) qty, coalesce(sum(gross),0) gross, coalesce(sum(gross_abs),0) gabs, coalesce(sum(cost),0) cost, coalesce(sum(txns),0)::bigint txns, coalesce(sum(sku_rows),0)::bigint sku_rows FROM primary_sales_daily_wh`)).rows[0];
    check(`${label}: warehouse-grain rollup == re-aggregation of sku grain`, ['rows', 'qty', 'gross', 'gabs', 'cost', 'txns', 'sku_rows'].every((k) => String(whRoll[k]) === String(whTruth[k])), `wh=${JSON.stringify(whRoll)} truth=${JSON.stringify(whTruth)}`);
    check(`${label}: warehouse-grain folds every sku-grain row exactly once`, String(whRoll.sku_rows) === String(roll.rows) && String(whRoll.txns) === String(roll.txns));
    const whJs = new Map();
    for (const g of exp.values()) {
      const it = ITEM.get(g.ITNO); const price = g.TRPR !== 0 ? g.TRPR : it.mrp;
      const k = `${g.TRDT}|${g.WHLO}|${g.TTYP}|DENIM`; const a = whJs.get(k) || { gabs: 0, txns: 0 }; a.gabs += Math.abs(g.TRQT * price); a.txns++; whJs.set(k, a);
    }
    const whRows = (await query(`SELECT r.trdt::text d, w.whlo, r.ttyp, r.category_norm, r.gross_abs, r.txns FROM primary_sales_daily_wh r JOIN primary_warehouses w ON w.id = r.warehouse_id`)).rows;
    let whBad = 0;
    for (const r of whRows) { const e = whJs.get(`${r.d}|${r.whlo}|${r.ttyp}|${r.category_norm}`); if (!e || Number(r.txns) !== e.txns || Math.abs(Number(r.gross_abs) - e.gabs) > 0.02) whBad++; }
    check(`${label}: warehouse-grain rollup == JS re-aggregation of the source (${whJs.size} groups)`, whBad === 0 && whRows.length === whJs.size, `bad=${whBad} rows=${whRows.length}`);
    const dirty = (await query('SELECT count(*)::int c FROM primary_rollup_dirty')).rows[0].c;
    check(`${label}: no dirty dates left`, dirty === 0, `dirty=${dirty}`);
  }
  const hw = async () => (await query(`SELECT last_lmts_ts FROM primary_sync_state WHERE feed = $1`, [P.FEED])).rows[0]?.last_lmts_ts || null;
  const maxLmts = (rows) => rows.reduce((m, r) => (SRC_VISIBLE(r) && mappable(r.ITNO) && r.LMTS && (!m || r.LMTS > m) ? r.LMTS : m), null);
  const indexNames = async (tbl) => (await query(`SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1`, [tbl])).rows.map((r) => r.indexname);

  // ═══════════════════════════════════════════════════════════════════════
  section('S0  guards on an empty ledger');
  let r = await P.runDelta();
  check('delta refuses to run with no high-water (skipped, no M3 stream)', r.skipped === true && fake.streamQueries().length === 0);
  let err = null; try { await P.runBackfill({ from: '2026-06-01' }); } catch (e) { err = e.message; }
  check('backfill rejects --from without --to', /must be given together/.test(err || ''));
  err = null; try { await P.reconcile({ from: '2026/06/01', to: '2026-06-30' }); } catch (e) { err = e.message; }
  check('reconcile rejects a malformed date before touching M3', /YYYY-MM-DD/.test(err || ''));

  // ═══════════════════════════════════════════════════════════════════════
  section('S1  backfill: VPN drops mid-way through the 2nd warehouse chunk');
  fake.failures.push({ match: /A\.WHLO = 'W02'/, afterRows: 700 });
  err = null; try { await P.runBackfill({}); } catch (e) { err = e.message; }
  check('backfill surfaces the injected M3 error', /injected/.test(err || ''), err);
  let prog = (await query(`SELECT whlo, status, rows_loaded::int rows FROM primary_backfill_progress WHERE scope = 'FULL' ORDER BY whlo`)).rows;
  check('progress: W01 done, W02 left in running (no W03 yet)', prog.length === 2 && prog[0].whlo === 'W01' && prog[0].status === 'done' && prog[1].whlo === 'W02' && prog[1].status === 'running', JSON.stringify(prog));
  const w01Expected = [...expectedLedger(DATA, { mappable }).values()].filter((x) => x.WHLO === 'W01').length;
  check('W01 chunk fully loaded', prog[0].rows === w01Expected, `${prog[0].rows} vs ${w01Expected}`);
  const partial = (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE whlo = 'W02'`)).rows[0].c;
  check('a failed COPY leaves nothing behind (atomic per statement) — zero partial W02 rows', partial === 0, `partial=${partial}`);
  check('indexes are still dropped (index-light load in progress)', !(await indexNames('primary_sales_movements')).includes('uq_primary_movement'));
  check('high-water NOT advanced by a failed backfill', (await hw()) === null);

  // ═══════════════════════════════════════════════════════════════════════
  section('S2  backfill: re-run resumes, wipes the partial chunk, finishes');
  const qBefore = fake.streamQueries().length;
  r = await P.runBackfill({});
  const streamsThisRun = fake.streamQueries().slice(qBefore);
  check('resume mode selected', r.mode === 'bulk-resume', r.mode);
  check('W01 was NOT re-streamed; W02 + W03 were', !streamsThisRun.some((q) => /WHLO = 'W01'/.test(q)) && streamsThisRun.filter((q) => /WHLO = 'W0[23]'/.test(q)).length === 2, `${streamsThisRun.length} streams`);
  check('partial chunk wiped before re-stream (log)', LOGS.some((m) => /Resuming WHLO W02: removed \d+ partial rows/.test(m)));
  let exp = await compareLedger('S2');
  check('all 3 ledger indexes rebuilt', JSON.stringify(await indexNames('primary_sales_movements')) === JSON.stringify(['idx_primary_mv_trdt', 'idx_primary_mv_trdt_brin', 'uq_primary_movement']));
  const hw2 = await hw();
  check('high-water == max LMTS of loaded rows', hw2 && hw2.getTime() === maxLmts(DATA).getTime(), `${hw2 && hw2.toISOString()} vs ${maxLmts(DATA).toISOString()}`);
  await compareRollup('S2', exp);
  const unm = (await query(`SELECT itno, rows_seen::int n FROM primary_unmapped_items ORDER BY itno`)).rows;
  const expUnm = new Map(); for (const x of DATA) if (SRC_VISIBLE(x) && !mappable(x.ITNO)) expUnm.set(x.ITNO, (expUnm.get(x.ITNO) || 0) + 1);
  // Persisted per chunk, so W01's tallies from the crashed run survive; the
  // failed W02 attempt recorded nothing (its stream never finished) → exact.
  check('unmappable ITNOs recorded per chunk (exactly the 5 codes missing from the SKU master, exact counts across the crash)',
    unm.length === 5 && unm.every((u) => expUnm.has(u.itno) && u.n === expUnm.get(u.itno)), unm.map((u) => `${u.itno}×${u.n}/${expUnm.get(u.itno)}`).join(','));
  check('CSV escaping round-trips comma / quote / newline in WHSL', (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE whsl IN ('L,1', 'Q"2', E'N\\n3')`)).rows[0].c === [...exp.values()].filter((x) => ['L,1', 'Q"2', 'N\n3'].includes(x.WHSL)).length);
  check('NULL-LMTS rows loaded', (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE lmts IS NULL`)).rows[0].c === [...exp.values()].filter((x) => x.LMTS == null).length);
  check('the rollup swap happened via RENAME (canonical index names on both rollups, no side tables)',
    JSON.stringify(await indexNames('primary_sales_daily')) === JSON.stringify(['idx_psd_trdt_sku'])
    && JSON.stringify(await indexNames('primary_sales_daily_wh')) === JSON.stringify(['idx_psdw_trdt'])
    && (await query(`SELECT count(*)::int c FROM pg_tables WHERE tablename LIKE 'primary_sales_daily%_next' OR tablename LIKE 'primary_sales_daily%_old'`)).rows[0].c === 0,
    (await indexNames('primary_sales_daily')).join(',') + ' | ' + (await indexNames('primary_sales_daily_wh')).join(','));

  // ═══════════════════════════════════════════════════════════════════════
  section('S3  guards on a populated ledger');
  await query(`DELETE FROM primary_backfill_progress`);
  err = null; try { await P.runBackfill({}); } catch (e) { err = e.message; }
  check('unbounded backfill into a populated ledger with no progress is REFUSED', /Refusing to bulk-COPY/.test(err || ''), (err || '').slice(0, 80));
  await compareLedger('S3 (unchanged after refusal)');
  await query(`UPDATE primary_sync_state SET last_lmts_ts = NULL WHERE feed = $1`, [P.FEED]);
  err = null; try { await P.runDelta({ force: true }); } catch (e) { err = e.message; }
  check('--delta --force with rows but no high-water errors with guidance (no 110M temp-table path)', /no high-water mark but the ledger already has rows/.test(err || ''));
  await query(`UPDATE primary_sync_state SET last_lmts_ts = $2 WHERE feed = $1`, [P.FEED, hw2]);

  // ═══════════════════════════════════════════════════════════════════════
  section('S4  delta: new + amended + moved rows, overlap no-ops, one back-dated row');
  const visible = DATA.filter((x) => SRC_VISIBLE(x) && mappable(x.ITNO) && x.LMTS);
  const bump = (i) => new Date(hw2.getTime() + 3600000 + i * 1000);
  // (a) 200 new rows on the last 5 days
  const newRows = [];
  for (let i = 0; i < 200; i++) { const it = ITEMS[i % 130]; const day = addDays(LAST_DAY, -(i % 5)); newRows.push(makeRow(pick(AAA_WHS).WHLO, it, day, bump(i))); }
  DATA.push(...newRows);
  // (b) 100 amended (qty changed, LMTS bumped)
  const amended = visible.filter((x) => x.TRDT < LAST_DAY).slice(0, 100);
  amended.forEach((x, i) => { x.TRQT += 3; x.LMTS = bump(1000 + i); });
  // (c) 30 moved to another TRDT (key unchanged, LMTS bumped)
  const moved = visible.filter((x) => x.TRDT === '2026-06-10').slice(0, 30);
  moved.forEach((x, i) => { x.TRDT = '2026-06-12'; x.LMTS = bump(2000 + i); });
  // (e) 1 back-dated row with an OLD LMTS — invisible to the LMTS delta
  const backdated = makeRow('W01', ITEMS[3], '2026-06-05', new Date('2026-06-05T09:00:00Z'));
  DATA.push(backdated);
  const overlapNoOps = DATA.filter((x) => SRC_VISIBLE(x) && mappable(x.ITNO) && x.LMTS && x.LMTS.getTime() > hw2.getTime() - 3600000 && x.LMTS.getTime() <= hw2.getTime()).length;
  check('test setup: overlap window contains unchanged rows to re-read as no-ops', overlapNoOps > 50, `${overlapNoOps} rows`);

  const qb4 = fake.streamQueries().length;
  r = await P.runDelta();
  check('delta issued exactly one M3 stream', fake.streamQueries().length - qb4 === 1);
  check('delta streamed the overlap too (streamed > changed)', r.streamed >= 330 + overlapNoOps - 5, `streamed=${r.streamed}`);
  check('delta changed exactly 330 rows (200 new + 100 amended + 30 moved; overlap re-reads are no-ops)', r.merged === 330, `changed=${r.merged}`);
  check('delta dirty dates include the OLD date of the moved rows (2026-06-10) and the new one (2026-06-12)', r.dates.includes('2026-06-10') && r.dates.includes('2026-06-12'), r.dates.join(','));
  const hw4 = await hw();
  check('high-water advanced to the new max LMTS', hw4 && hw4.getTime() === maxLmts(DATA).getTime());
  // The back-dated row is expected to be MISSING until reconcile.
  const expNoBackdated = new Map(expectedLedger(DATA, { mappable })); expNoBackdated.delete(rowKey(backdated));
  {
    const got = (await query(`SELECT count(*)::int c FROM primary_sales_movements`)).rows[0].c;
    check('ledger == expected minus the back-dated row', got === expNoBackdated.size, `${got} vs ${expNoBackdated.size}`);
    const bd = (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE tmsx = $1`, [backdated.TMSX])).rows[0].c;
    check('back-dated row correctly NOT visible to the LMTS delta (reconcile\'s job)', bd === 0);
    const mv = (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE tmsx = ANY($1::int[]) AND trdt = '2026-06-12'`, [moved.map((x) => x.TMSX)])).rows[0].c;
    check('moved rows now carry the new TRDT', mv === 30);
  }
  await compareRollup('S4', expNoBackdated);

  // ═══════════════════════════════════════════════════════════════════════
  section('S5  delta again: pure overlap, must be a no-op');
  r = await P.runDelta();
  check('second delta changes nothing (idempotent)', r.merged === 0 && r.dates.length === 0, `changed=${r.merged} streamed=${r.streamed}`);
  check('high-water unchanged', (await hw()).getTime() === hw4.getTime());
  await compareRollup('S5', expNoBackdated);

  // ═══════════════════════════════════════════════════════════════════════
  section('S6  crash between merge and rollup → next run self-heals');
  {
    const pg = await pool.connect();
    try {
      await pg.query('CREATE TEMP TABLE tmp_primary (LIKE stg_primary_sales)');
      const some = (await query(`SELECT *, rgdt::text AS rgdt_txt FROM primary_sales_movements WHERE trdt = '2026-06-20' LIMIT 40`)).rows;
      const cols = ['warehouse_id', 'sku_id', 'cono', 'whlo', 'itno', 'trdt', 'rgdt', 'rgtm', 'tmsx', 'nstt', 'ttyp', 'trtp', 'whsl', 'trpr', 'pupr', 'trqt', 'repn', 'stas', 'lmts'];
      // Plant the amended rows exactly as M3 would later present them: qty+5
      // and a NEW LMTS (so the follow-up delta re-reads them as pure no-ops).
      const plantedLmts = new Date(hw4.getTime() + 60000);
      for (const s of some) await pg.query(`INSERT INTO tmp_primary (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => (c === 'trqt' ? Number(s[c]) + 5 : c === 'lmts' ? plantedLmts : s[c])));
      const m = await P._internal.mergeStaged(pg);    // merge committed, rollup NOT refreshed = crash point
      check('simulated crash: merge committed 40 changes, date left dirty', m.merged === 40 && (await query(`SELECT count(*)::int c FROM primary_rollup_dirty`)).rows[0].c === 1);
      // mirror the change in the expectation
      const byKey = new Map(some.map((s) => [`${s.cono}|${s.whlo}|${s.itno}|${s.rgdt_txt}|${s.rgtm}|${s.tmsx}`, s]));
      for (const x of DATA) { const k = rowKey(x); if (byKey.has(k) && SRC_VISIBLE(x) && mappable(x.ITNO)) x.TRQT += 5; }
      // ...and make the fake M3 agree (LMTS bumped so the next delta re-reads them as no-ops)
      for (const x of DATA) if (byKey.has(rowKey(x))) x.LMTS = plantedLmts;
    } finally { await pg.query('DROP TABLE IF EXISTS tmp_primary'); pg.release(); }
  }
  r = await P.runDelta();
  check('next delta drained the leftover dirty date even though it changed nothing itself', r.merged === 0 && (await query(`SELECT count(*)::int c FROM primary_rollup_dirty`)).rows[0].c === 0, `changed=${r.merged}`);
  const expS6 = new Map(expectedLedger(DATA, { mappable })); expS6.delete(rowKey(backdated));
  await compareRollup('S6', expS6);

  // ═══════════════════════════════════════════════════════════════════════
  section('S7  reconcile ×3: heals the back-dated row, remembers unmappable residue');
  const hwBeforeReconcile = await hw();
  const unmappableInWindow = DATA.filter((x) => SRC_VISIBLE(x) && !mappable(x.ITNO)).length;
  const daysWithUnmappable = new Set(DATA.filter((x) => SRC_VISIBLE(x) && !mappable(x.ITNO)).map((x) => x.TRDT)).size;
  let qb = fake.streamQueries().length;
  r = await P.reconcile({ from: FIRST_DAY, to: LAST_DAY });
  check('run 1: every short day re-pulled in ONE batched M3 pass (not one pass per day)', fake.streamQueries().length - qb === 1 && r.shortDays === 30, `streams=${fake.streamQueries().length - qb} shortDays=${r.shortDays}`);
  check('run 1: healed exactly the back-dated row', r.healed === 1, `healed=${r.healed}`);
  check('run 1: residual == unmappable source rows in window', r.residual === unmappableInWindow, `${r.residual} vs ${unmappableInWindow}`);
  check('run 1: high-water NOT advanced by reconcile', (await hw()).getTime() === hwBeforeReconcile.getTime());
  exp = await compareLedger('S7 run 1');
  await compareRollup('S7 run 1', exp);
  check('run 1: per-day state remembered for all 30 days', (await query(`SELECT count(*)::int c FROM primary_reconcile_state`)).rows[0].c === 30);

  qb = fake.streamQueries().length;
  r = await P.reconcile({ from: FIRST_DAY, to: LAST_DAY });
  check('run 2: known-residual days SKIPPED — zero M3 streams, zero re-pulls', fake.streamQueries().length - qb === 0 && r.shortDays === 0 && r.knownDays === daysWithUnmappable, `streams=${fake.streamQueries().length - qb} short=${r.shortDays} known=${r.knownDays}/${daysWithUnmappable}`);
  check('run 2: knownResidual == unmappable rows', r.knownResidual === unmappableInWindow);

  const backdated2 = makeRow('W02', ITEMS[7], '2026-06-15', new Date('2026-06-15T09:00:00Z'));
  DATA.push(backdated2);
  qb = fake.streamQueries().length;
  r = await P.reconcile({ from: FIRST_DAY, to: LAST_DAY });
  check('run 3: a new back-dated row changes that day\'s source count → only that day re-pulled', r.shortDays === 1 && r.healed === 1 && fake.streamQueries().length - qb === 1, `short=${r.shortDays} healed=${r.healed}`);
  exp = await compareLedger('S7 run 3');
  await compareRollup('S7 run 3', exp);
  r = await P.reconcile({});      // default window (last 45 days from today) — no data there, must not crash
  check('default-window reconcile (no data in range) completes cleanly', r.checkedDays === 0 && r.shortDays === 0);

  // ═══════════════════════════════════════════════════════════════════════
  section('S8  window re-load (--from/--to on a populated ledger) via UPSERT');
  const silent = DATA.filter((x) => SRC_VISIBLE(x) && mappable(x.ITNO) && x.TRDT >= '2026-06-02' && x.TRDT <= '2026-06-03').slice(0, 25);
  silent.forEach((x) => { x.TRQT -= 1; });   // amended WITHOUT an LMTS change — only a re-load sees it
  qb = fake.streamQueries().length;
  r = await P.runBackfill({ from: '2026-06-02', to: '2026-06-03' });
  check('merge mode selected, one stream per warehouse, indexes never dropped', r.mode === 'merge' && fake.streamQueries().length - qb === 3 && (await indexNames('primary_sales_movements')).includes('uq_primary_movement'), `mode=${r.mode}`);
  check('exactly the 25 silently-amended rows changed', r.merged === 25, `changed=${r.merged}`);
  exp = await compareLedger('S8');
  await compareRollup('S8', exp);

  // ═══════════════════════════════════════════════════════════════════════
  section('S9  smoke test (--limit) is safe on a populated ledger');
  const hwBeforeSmoke = await hw();
  r = await P.runBackfill({ limit: 50 });
  check('smoke mode: TOP 50 via upsert, nothing changed', r.mode === 'smoke' && r.streamed === 50 && r.merged === 0, `mode=${r.mode} streamed=${r.streamed} changed=${r.merged}`);
  check('smoke never touches the high-water mark', (await hw()).getTime() === hwBeforeSmoke.getTime());

  // ═══════════════════════════════════════════════════════════════════════
  section('S10 --delta --force on an EMPTY ledger bootstraps via the chunked backfill');
  await query('TRUNCATE primary_sales_movements, primary_backfill_progress, primary_rollup_dirty, primary_reconcile_state');
  await query(`UPDATE primary_sync_state SET last_lmts_ts = NULL WHERE feed = $1`, [P.FEED]);
  qb = fake.streamQueries().length;
  r = await P.runDelta({ force: true });
  check('bootstrapped through backfill (3 WHLO streams, not one giant temp-table upsert)', r.bootstrapped === true && fake.streamQueries().length - qb === 3);
  exp = await compareLedger('S10');
  await compareRollup('S10', exp);

  // ═══════════════════════════════════════════════════════════════════════
  section('S11 --truncate does a clean full reload');
  r = await P.runBackfill({ truncate: true });
  check('mode bulk after truncate', r.mode === 'bulk');
  exp = await compareLedger('S11');
  await compareRollup('S11', exp);

  // ═══════════════════════════════════════════════════════════════════════
  section('S12 rollup swap under concurrent readers (never blocks, never errors)');
  {
    const holder = await pool.connect();
    await holder.query('BEGIN'); await holder.query('SELECT count(*) FROM primary_sales_daily');   // holds ACCESS SHARE
    const logsBefore = LOGS.length;
    const readerErrors = []; let reads = 0; let stop = false;
    const readerLoop = (async () => {
      const c = await pool.connect();
      try { while (!stop) { try { await c.query('SELECT count(*) FROM primary_sales_daily'); reads++; } catch (e) { readerErrors.push(e.message); } } }
      finally { c.release(); }
    })();
    const rebuild = P.rebuildRollup();
    setTimeout(async () => { await holder.query('COMMIT'); holder.release(); }, 7000);
    await rebuild; stop = true; await readerLoop;
    const retried = LOGS.slice(logsBefore).some((m) => /rollup swap blocked by a reader/.test(m));
    check('swap waited for the long transaction with lock_timeout + retry (did not deadlock, did not fail)', retried);
    check(`concurrent readers never errored during the swap (${reads} reads)`, readerErrors.length === 0, readerErrors.slice(0, 2).join(' | '));
    await compareRollup('S12', exp);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('S13 controller reads the swapped rollup; dates are LOCAL, not UTC');
  cache.clear();
  const fakeReq = (q) => ({ query: q, params: {}, headers: {}, body: {} });
  const call = (fn, q) => new Promise((resolve, reject) => { fn(fakeReq(q), { json: (b) => resolve(b), status() { return this; } }, (e) => reject(e)); });
  const ov = await call(ctrl.getOverview, { from: FIRST_DAY, to: LAST_DAY });
  const jsAgg = expectedRollup(exp); let gabs = 0, txns = 0; for (const g of jsAgg.values()) { gabs += g.gabs; txns += g.txns; }
  check('overview throughput == Σ|qty×price| of the source', Math.abs(ov.data.kpis.throughput - gabs) <= 1, `${ov.data.kpis.throughput} vs ${gabs.toFixed(2)}`);
  check('overview txns == source row count', ov.data.kpis.txns === txns);
  const sc = await call(ctrl.getSkuCount, { from: FIRST_DAY, to: LAST_DAY });
  check('/sku-count distinct SKUs == source distinct SKUs (lazy KPI; /overview leaves it null)', sc.data.sku_count === new Set([...exp.values()].map((g) => g.ITNO)).size && ov.data.kpis.sku_count === null, `${sc.data.sku_count}`);
  {
    // Every group-by dimension, on both sources, must total to the same source numbers.
    for (const dim of ['warehouse', 'type', 'category', 'colour', 'size', 'product']) {
      const pv = await call(ctrl.getPivot, { group_by: dim, from: FIRST_DAY, to: LAST_DAY });
      check(`pivot by ${dim}: totals == source (txns, |Σqty×price| within rounding)`, pv.data.totals.txns === txns && Math.abs(pv.data.totals.value_gross - [...jsAgg.values()].reduce((a, g) => a + g.gross, 0)) <= pv.data.rows.length, `txns=${pv.data.totals.txns} rows=${pv.data.rows.length}`);
    }
    // A sku-only Lens filter forces sku grain; a category filter stays on warehouse grain — both must agree with JS.
    const bySize = new Map(); for (const [id, it] of skuIdToItno) void id, void it;
    const sizeOf = new Map(skuRows.map((r) => [(r.infor_item_code || r.style_variant || '').toUpperCase(), r.id]));
    void sizeOf; void bySize;
    const s28 = (await query(`SELECT upper(coalesce(infor_item_code, style_variant)) itno FROM skus WHERE size = '28'`)).rows.map((r) => r.itno);
    const set28 = new Set(s28);
    const exp28 = [...exp.values()].filter((g) => set28.has(g.ITNO)).length;
    const ov28 = await call(ctrl.getOverview, { from: FIRST_DAY, to: LAST_DAY, size: '28' });
    check('overview with a SKU-only Lens filter (size=28) == source', ov28.data.kpis.txns === exp28, `${ov28.data.kpis.txns} vs ${exp28}`);
    const ovCat = await call(ctrl.getOverview, { from: FIRST_DAY, to: LAST_DAY, category: 'DENIM' });
    const scCat = await call(ctrl.getSkuCount, { from: FIRST_DAY, to: LAST_DAY, category: 'DENIM' });
    check('overview with the category filter (warehouse grain) == source', ovCat.data.kpis.txns === txns && scCat.data.sku_count === sc.data.sku_count);
    const ovNone = await call(ctrl.getOverview, { from: FIRST_DAY, to: LAST_DAY, category: 'NOPE' });
    check('overview with a non-matching category filter is empty', ovNone.data.empty === true && ovNone.data.kpis.txns === 0);
    const trW = await call(ctrl.getTrend, { group_by: 'warehouse', from: FIRST_DAY, to: LAST_DAY, top: 6, measure: 'gross' });
    check('trend by warehouse: 3 series × 30 dates', trW.data.series.length === 3 && trW.data.dates.length === 30);
    const types = await call(ctrl.getTypes, {});
    check('types list == the 6 ttyps in the data', types.data.length === 6 && types.data.every((t) => TTYPS.includes(Number(t.ttyp))));
  }
  const RealDate = Date;
  const fixed = new RealDate(); fixed.setHours(1, 0, 0, 0);       // 01:00 local → previous day in UTC (IST machine)
  const localToday = `${fixed.getFullYear()}-${String(fixed.getMonth() + 1).padStart(2, '0')}-${String(fixed.getDate()).padStart(2, '0')}`;
  const utcToday = fixed.toISOString().slice(0, 10);
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } };
  try {
    const s = await call(ctrl.getSummary, { period: 'today' });
    check('period=today resolves to the LOCAL calendar date', s.data.from === localToday && s.data.to === localToday, `got ${s.data.from}, local ${localToday}, utc ${utcToday}`);
    check('…which differs from the UTC date at 01:00 local (the old bug)', localToday !== utcToday || fixed.getTimezoneOffset() === 0);
  } finally { Date = RealDate; } // eslint-disable-line no-global-assign

  // ═══════════════════════════════════════════════════════════════════════
  section('S14 dataset exclusions');
  check('no STCD=0 item ever reached the ledger', (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE itno >= 'IT0145'`)).rows[0].c === 0);
  check('no non-AAA warehouse ever reached the ledger', (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE whlo = $1`, [NON_AAA_WH])).rows[0].c === 0);
  check('inactive SKUs still map (history is history)', (await query(`SELECT count(*)::int c FROM primary_sales_movements m JOIN skus s ON s.id = m.sku_id WHERE s.is_active = false`)).rows[0].c > 0);
  check('style_variant-mapped items loaded (case-insensitive match)', (await query(`SELECT count(*)::int c FROM primary_sales_movements WHERE itno BETWEEN 'IT0130' AND 'IT0139'`)).rows[0].c > 0);

  // ═══════════════════════════════════════════════════════════════════════
  section('S14b silent link drop mid-stream → stall watchdog fails the run, ledger untouched');
  {
    process.env.M3_STALL_TIMEOUT_MS = '5000';
    const before = (await query('SELECT count(*)::int c FROM primary_sales_movements')).rows[0].c;
    fake.failures.push({ match: /SELECT TOP 40 /, afterRows: 20, stall: true });
    const ts = Date.now(); err = null;
    try { await P.runBackfill({ limit: 40 }); } catch (e) { err = e.message; }
    check('stalled stream is failed by the watchdog (did not hang)', /stalled/.test(err || '') && Date.now() - ts < 20000, `${err} after ${Date.now() - ts}ms`);
    check('nothing was merged from the stalled batch', (await query('SELECT count(*)::int c FROM primary_sales_movements')).rows[0].c === before);
    delete process.env.M3_STALL_TIMEOUT_MS;
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('S15 remap: SKU master gains the 5 missing item codes → their history is healed');
  {
    const hwBefore = await hw();
    let r0 = await P.remap();
    check('remap with nothing newly mappable is a no-op (no M3 connection)', r0.items === 0 && r0.merged === 0);
    const unmBefore = (await query(`SELECT count(*)::int c FROM primary_unmapped_items`)).rows[0].c;
    check('5 unmappable codes are on record before the master change', unmBefore === 5, `unmapped=${unmBefore}`);
    // Simulate the master refresh adding the 5 codes.
    for (const it of ITEMS.filter((x) => !x.mapVia && x.stcd === 1)) {
      await query(`INSERT INTO skus (sku_code, product_name, color_code, color_name, size, mrp, cost_price, is_active, infor_item_code, category_norm, product, gender_name)
                   VALUES ($1,$2,'BLK','Black','30',$3,$4,true,$5,'DENIM','Jeans','Men')`, [`SKU-${it.itno}`, `Product ${it.itno}`, it.mrp, it.cost, it.itno]);
      it.mapVia = 'infor';
    }
    for (const r of (await query('SELECT id, infor_item_code, style_variant FROM skus')).rows) skuIdToItno.set(r.id, (r.infor_item_code || r.style_variant || '').toUpperCase());
    const expNow = expectedLedger(DATA, { mappable });
    const gain = expNow.size - exp.size;
    qb = fake.streamQueries().length;
    r0 = await P.remap();
    const remapQ = fake.streamQueries().slice(qb);
    check('remap pulled exactly those 5 item codes in ONE M3 pass, scoped to our warehouses', remapQ.length === 1 && /A\.ITNO IN \(/.test(remapQ[0]) && /A\.WHLO IN \(/.test(remapQ[0]) && r0.items === 5, `${remapQ.length} streams, items=${r0.items}`);
    check(`remap loaded exactly the ${gain} rows that were previously unmappable`, r0.merged === gain, `loaded=${r0.merged}`);
    exp = await compareLedger('S15');
    await compareRollup('S15', exp);
    check('healed codes removed from primary_unmapped_items', (await query(`SELECT count(*)::int c FROM primary_unmapped_items`)).rows[0].c === 0);
    check('remap never touches the high-water', (await hw()).getTime() === hwBefore.getTime());
    r = await P.reconcile({ from: FIRST_DAY, to: LAST_DAY });
    check('reconcile after remap: every day in sync, nothing short, no residual', r.shortDays === 0 && r.knownDays === 0 && r.residual === 0 && r.knownResidual === 0, `short=${r.shortDays} known=${r.knownDays}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('S16 master refresh: cadence, state, change detection, floor guard');
  {
    const MR = require('../services/masterRefresh');
    check('floor guard: first load always passes', MR.floorOk(5, 0) && MR.floorOk(0, 10));
    check('floor guard: 89% of current rows is refused, 90% accepted', !MR.floorOk(89, 100) && MR.floorOk(90, 100));
    await query('DELETE FROM master_refresh_state');
    let due = await MR.isDue(3);
    check('never run → due', due.due === true && due.lastSuccessAt === null);
    // Runner 1: "loaders" that change a price and a mapping (simulated).
    const runner1 = async (script) => {
      if (script === 'load_item_master.js') {
        await query(`UPDATE skus SET mrp = mrp + 1 WHERE sku_code = 'SKU-IT0000'`);
        await query(`UPDATE skus SET is_active = false WHERE sku_code = 'SKU-IT0001'`);
      }
      return { code: 0, tail: 'ok' };
    };
    let mr = await MR.refreshMastersIfDue({ everyDays: 3, runner: runner1 });
    check('run 1: both loaders ran, price AND mapping change detected', !mr.skipped && mr.ran.length === 2 && mr.failed.length === 0 && mr.skuPriceChanged === true && mr.skuMapChanged === true, JSON.stringify({ ran: mr.ran, p: mr.skuPriceChanged, m: mr.skuMapChanged }));
    const st = (await query(`SELECT name, last_status, last_success_at IS NOT NULL AS ok FROM master_refresh_state ORDER BY name`)).rows;
    check('state rows: locations + skus = success', st.length === 2 && st.every((x) => x.last_status === 'success' && x.ok));
    mr = await MR.refreshMastersIfDue({ everyDays: 3, runner: runner1 });
    check('immediately after: not due → skipped (3-day cadence)', mr.skipped === true && /not due/.test(mr.reason));
    await query(`UPDATE master_refresh_state SET last_success_at = NOW() - INTERVAL '3 days 1 minute'`);
    const runnerNoop = async () => ({ code: 0, tail: 'ok' });
    mr = await MR.refreshMastersIfDue({ everyDays: 3, runner: runnerNoop });
    check('3 days later: due again; unchanged master → no price/map change flagged', !mr.skipped && mr.skuPriceChanged === false && mr.skuMapChanged === false);
    await query(`UPDATE master_refresh_state SET last_success_at = NOW() - INTERVAL '4 days'`);
    const okBefore = (await query(`SELECT last_success_at FROM master_refresh_state WHERE name = 'skus'`)).rows[0].last_success_at;
    const runnerFloor = async (script) => (script === 'load_item_master.js' ? { code: MR.EXIT_FLOOR, tail: 'FLOOR GUARD' } : { code: 0, tail: 'ok' });
    mr = await MR.refreshMastersIfDue({ everyDays: 3, runner: runnerFloor });
    const skuState = (await query(`SELECT last_status, last_exit_code, last_success_at FROM master_refresh_state WHERE name = 'skus'`)).rows[0];
    check('floor-guarded loader: recorded as floor-guard, last_success_at NOT advanced, reported in failed[]', mr.failed.includes('skus') && mr.ran.includes('locations') && skuState.last_status === 'floor-guard' && skuState.last_exit_code === MR.EXIT_FLOOR && skuState.last_success_at.getTime() === okBefore.getTime());
    due = await MR.isDue(3);
    check('a failed loader keeps the refresh due (retried next sync, not in 3 days)', due.due === true);
    // restore the sku we deactivated so later checks are unaffected
    await query(`UPDATE skus SET is_active = true WHERE sku_code = 'SKU-IT0001'`);
  }

  // ── done ─────────────────────────────────────────────────────────────────
  await pool.end();
  if (!KEEP) { await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); }
  await admin.end();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s${KEEP ? ` (kept ${TEST_DB})` : ''}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nFATAL', e);
  process.exit(2);
});
