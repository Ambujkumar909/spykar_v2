// ─── stress_war_room.js — the War Room under its worst cases ────────────────
// npm run warroom:stress [-- --seed=N]
// Worst first: random custom dates (cold), edge dates (leap day, FY start,
// month start, Monday / Sunday, year end, first / last day, no stock
// snapshot), the heaviest product filters, a cold burst of concurrent mixed
// requests, cascading filter options, memory under the cache cap. Every
// board built is checked against the raw sale lines (accuracy) and for
// internal consistency. Refuses to run against the production database.
require('dotenv').config();
process.env.PG_STATEMENT_TIMEOUT = '0';
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { query } = require('../config/database');
const cache = require('../config/cache');
const wr = require('../services/warRoom');

if ((process.env.PG_DATABASE || '') === 'spykar_inventory' || process.env.PG_PORT === '5432') { console.error('Refusing: production database.'); process.exit(2); }
let seed = Number((process.argv.find((a) => a.startsWith('--seed=')) || '--seed=20261022').split('=')[1]);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };   // reproducible
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const pctile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (a) => `p50 ${pctile(a, 0.5)} ms · p95 ${pctile(a, 0.95)} ms · max ${Math.max(...a)} ms`;

async function truth(a, b, where = '', params = []) {
  const { rows } = await query(`
    SELECT l.external_id AS code,
      SUM(CASE WHEN m.movement_type = 'SALE' THEN ABS(m.qty_change) ELSE -ABS(m.qty_change) END)::bigint AS q,
      SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * COALESCE(m.sale_value, 0))::numeric AS v,
      (COUNT(DISTINCT (m.moved_at::date, m.reference_no)) FILTER (WHERE m.reference_no IS NOT NULL))::int AS b
    FROM inventory_movements m JOIN skus s ON s.id = m.sku_id JOIN locations l ON l.id = m.location_id
    WHERE m.movement_type IN ('SALE', 'RETURN') AND l.is_active AND s.is_active
      AND m.moved_at >= $1::date AND m.moved_at < $2::date + interval '1 day' ${where} GROUP BY 1`, [a, b, ...params]);
  return Object.fromEntries(rows.map((r) => [r.code, r]));
}
// Board vs raw for every period; returns the number of wrong cells.
async function check(board, where = '', params = [], bills = true) {
  const B = Object.fromEntries(board.stores.map((s) => [s.code, s])); let bad = 0; let cells = 0;
  for (const k of ['cw', 'pw', 'ly', 'pwly', 'mtd', 'mtdly', 'ytd', 'ytdly']) {
    const T = await truth(board.periods[k][0], board.periods[k][1], where, params);
    for (const [code, t] of Object.entries(T)) {
      const s = B[code]; cells++;
      if (!s) { if (Number(t.q) || Math.abs(Number(t.v)) > 0.01) bad++; continue; }
      const [q, v, , b] = s.m[k];
      if (q !== Number(t.q) || Math.abs(v - Number(t.v)) > 0.011 || (bills && b !== t.b)) bad++;
    }
  }
  for (const s of board.stores) {
    if (Math.abs(s.dy.reduce((x, y) => x + y, 0) - s.m.mtd[1]) > s.dy.length) bad++;
    if (Math.abs(s.wk[s.wk.length - 1] - s.m.cw[1]) > 1) bad++;
    if (Object.values(s.cat).reduce((x, a) => x + a[0], 0) !== s.m.ytd[0]) bad++;
  }
  return { bad, cells };
}

(async () => {
  const app = require('../app');
  const { rows: [u] } = await query('SELECT id FROM users WHERE is_active ORDER BY created_at LIMIT 1');
  const token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '30m' });
  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`).set('Accept-Encoding', 'gzip');
  let t0 = Date.now(); await wr.loadEngine(); console.log(`engine loaded in ${Date.now() - t0} ms (production loads it at start-up and after each sync)`);
  const meta = await wr.getMeta();
  const span = Math.round((new Date(meta.to) - new Date(meta.from)) / 864e5);
  const randDate = () => new Date(new Date(meta.from).getTime() + Math.floor(rnd() * (span + 1)) * 864e5).toISOString().slice(0, 10);
  console.log(`War Room stress · data ${meta.from} → ${meta.to} · seed ${seed}`);

  console.log('\n═ 1. Random custom dates, cold (cache cleared before each)');
  const dates = Array.from({ length: 30 }, randDate); const t1 = []; let shapeBad = 0;
  for (const d of dates) {
    cache.clear(); const t = Date.now(); const r = await get(`/api/v1/war-room/board?as_on=${d}`); t1.push(Date.now() - t);
    if (r.status !== 200 || r.body.data.periods.asOn !== d) shapeBad++;
  }
  ok(shapeBad === 0, `30 random dates all served for the exact date asked`);
  ok(pctile(t1, 0.95) < 600, `cold board · ${stat(t1)}`);
  for (const d of dates) await get(`/api/v1/war-room/board?as_on=${d}`);   // prime (cold above cleared the cache each time)
  // cached, as a browser sees it: real socket, keep-alive, body not parsed
  const http = require('http'); const server = app.listen(0); const port = server.address().port; const agent = new http.Agent({ keepAlive: true });
  const hit = (path) => new Promise((resolve, reject) => { const t = process.hrtime.bigint();
    http.get({ port, path, agent, headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(Number(process.hrtime.bigint() - t) / 1e6)); }).on('error', reject); });
  const t1w = [];
  for (const d of dates) t1w.push(Math.round(await hit(`/api/v1/war-room/board?as_on=${d}`)));
  ok(pctile(t1w, 0.95) < 20, `same dates, cached (HTTP) · ${stat(t1w)}`);
  server.close(); agent.destroy();

  console.log('\n═ 2. Accuracy on 8 random dates (every store × every period vs the raw lines)');
  for (const d of dates.slice(0, 8)) {
    const b = await wr.buildBoard({ as_on: d }); const { bad, cells } = await check(b);
    ok(bad === 0, `${d} · ${cells.toLocaleString()} cells${bad ? ` · ${bad} WRONG` : ' exact'}`);
  }

  console.log('\n═ 3. Edge dates');
  const edges = [['leap day', '2024-02-29'], ['day after leap day', '2024-03-01'], ['FY start', '2025-04-01'], ['FY start', '2026-04-01'], ['FY end', '2026-03-31'],
    ['month start (MTD = 1 day)', '2026-10-01'], ['Monday (week = 1 day)', '2026-10-19'], ['Sunday (full week)', '2026-10-18'], ['first data day', meta.from], ['last data day', meta.to],
    ['no stock snapshot', '2025-06-15'], ['LY on 29 Feb', '2025-02-28']].filter(([, d]) => d >= meta.from && d <= meta.to);
  for (const [label, d] of edges) {
    const t = Date.now(); const b = await wr.buildBoard({ as_on: d }); const ms = Date.now() - t;
    const { bad, cells } = await check(b);
    const P = b.periods; const dow = new Date(`${P.cw[0]}T00:00:00Z`).getUTCDay();
    const sane = P.asOn === d && dow === 1 && P.cw[1] === d && P.mtd[0] === `${d.slice(0, 7)}-01` && P.ytd[0].endsWith('-04-01')
      && new Date(`${P.ly[0]}T00:00:00Z`).getUTCDay() === 1;
    ok(bad === 0 && sane, `${label.padEnd(26)} ${d} · ${ms} ms · ${cells.toLocaleString()} cells${bad ? ` · ${bad} WRONG` : ' exact'}${sane ? '' : ' · PERIODS WRONG'} · stock ${P.stock.ty || 'n/a'} / LY ${P.stock.ly || 'n/a'}`);
  }

  console.log('\n═ 4. Heaviest product filters (cold)');
  const top = async (col, n) => (await query(`SELECT ${col} AS v FROM skus WHERE is_active AND ${col} IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT ${n}`)).rows.map((r) => r.v);
  const sizes = await top('size', 10); const colours = await top('color_name', 30); const subs = await top('sub_product', 50);
  const seasons = await top('season', 6); const cats = await top('category_norm', 4); const gens = await top('gender_name', 2);
  const prods = (await query(`SELECT DISTINCT regexp_replace(product, '\\s*[<>].*$', '') AS v FROM skus WHERE is_active AND product IS NOT NULL LIMIT 20`)).rows.map((r) => r.v);
  const cases = [
    ['10 sizes', { size: sizes }], ['30 colours', { color: colours }], ['50 sub-products', { sub_product: subs }],
    ['all 7 dimensions at once', { gender: gens, category: cats, product: prods, sub_product: subs, size: sizes, color: colours, season: seasons }],
    ['4 categories (rollup)', { category: cats }],
  ];
  for (const [label, f] of cases) {
    cache.clear();
    const qs = Object.entries(f).map(([k, v]) => `${k}=${encodeURIComponent(v.join(','))}`).join('&');
    const t = Date.now(); const r = await get(`/api/v1/war-room/board?as_on=${meta.to}&${qs}`); const ms = Date.now() - t;
    ok(r.status === 200 && ms < 1500, `${label.padEnd(26)} · ${ms} ms cold · ${r.body.data.stores.length} stores`);
  }
  {   // accuracy of the heaviest deep case
    const f = { size: sizes.slice(0, 5), color: colours.slice(0, 10) };
    const b = await wr.buildBoard({ as_on: meta.to, size: f.size.join(','), color: f.color.join(',') });
    const { bad, cells } = await check(b, 'AND s.size = ANY($3::text[]) AND s.color_name = ANY($4::text[])', [f.size, f.color], false);
    ok(bad === 0, `5 sizes × 10 colours vs raw lines · ${cells.toLocaleString()} cells${bad ? ` · ${bad} WRONG` : ' exact'}`);
  }

  console.log('\n═ 5. Cold burst: 40 concurrent mixed requests (8 dates × 5 kinds)');
  cache.clear();
  const burstDates = Array.from({ length: 8 }, randDate);
  const urls = burstDates.flatMap((d) => [`/api/v1/war-room/board?as_on=${d}`, `/api/v1/war-room/board?as_on=${d}`, `/api/v1/war-room/board?as_on=${d}&category=DENIM`,
    `/api/v1/war-room/filter-options?as_on=${d}&wr_region=West`, `/api/v1/war-room/notes?week_start=${d}`]);
  const t5 = Date.now(); const res = await Promise.all(urls.map(async (url) => { const t = Date.now(); const r = await get(url); return [r.status, Date.now() - t]; }));
  ok(res.every(([s]) => s === 200), `all 40 answered 200 · wall ${Date.now() - t5} ms · slowest ${Math.max(...res.map((x) => x[1]))} ms (identical requests coalesce)`);

  console.log('\n═ 6. Cascading filter options');
  await get('/api/v1/war-room/filter-options');   // production's post-sync warm-up does this
  const combos = ['wr_region=West', 'wr_region=North&state=Uttar%20Pradesh', 'category=DENIM&size=32', 'wr_type=L2L&category=KNITS&season=WINTER%20-%202025', 'gender=WOMENS&product=JEANS&wr_region=South'];
  const t6 = [];
  for (const c of combos) { const t = Date.now(); const r = await get(`/api/v1/war-room/filter-options?${c}`); t6.push(Date.now() - t); if (r.status !== 200) fails++; }
  ok(pctile(t6, 0.95) < 200, `5 cascading combos · ${stat(t6)}`);
  const r6 = await get('/api/v1/war-room/filter-options?wr_region=North');
  const allStates = (await get('/api/v1/war-room/filter-options')).body.options.state;
  ok(r6.body.options.state.length > 0 && r6.body.options.state.length < allStates.length, `Region = North narrows states ${allStates.length} → ${r6.body.options.state.length}`);

  console.log('\n═ 7. Memory under the cache cap (60 distinct dates)');
  cache.clear(); if (global.gc) global.gc();
  const m0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 60; i++) await get(`/api/v1/war-room/board?as_on=${randDate()}`);
  if (global.gc) global.gc();
  const grew = (process.memoryUsage().heapUsed - m0) / 2 ** 20;
  ok(grew < 400, `heap grew ${grew.toFixed(0)} MB after 60 dates (at most 40 boards kept)`);

  console.log(fails ? `\n✗ ${fails} check(s) failed` : '\n✓ All stress checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
