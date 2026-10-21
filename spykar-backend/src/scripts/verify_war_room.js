// ─── verify_war_room.js — accuracy, speed and security of the War Room ──────
// npm run warroom:verify [-- --as-on=YYYY-MM-DD]
//
// ACCURACY  every store × every period of the board, for four filter cases
//           (none · category · size · season + colour), against an
//           INDEPENDENT recomputation straight from inventory_movements (no
//           rollup involved): units exact, ₹ and MRP to the paisa, bills
//           exact. Plus internal consistency (daily / weekly / category series
//           add up to the period totals) and closing stock vs the raw snapshot.
// SPEED     cold build, cached request, 25 concurrent requests, payload size.
// SECURITY  no token / bad token, malformed input, SQL-injection strings,
//           unknown store, oversized note, stored-XSS payload round-trip.
// Refuses to run against the production database (it writes a test note).
require('dotenv').config();
process.env.PG_STATEMENT_TIMEOUT = '0';
const assert = require('assert');
const zlib = require('zlib');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { query } = require('../config/database');
const wr = require('../services/warRoom');

if ((process.env.PG_DATABASE || '') === 'spykar_inventory' || process.env.PG_PORT === '5432') {
  console.error('Refusing: this is the production database. Point .env at a copy.'); process.exit(2);
}
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ ${msg}`); } };

// Independent truth: one store × window from the raw lines.
async function truth(a, b, skuWhere = '', params = []) {
  const { rows } = await query(`
    SELECT l.external_id AS code,
      SUM(CASE WHEN m.movement_type = 'SALE' THEN ABS(m.qty_change) ELSE -ABS(m.qty_change) END)::bigint AS q,
      SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * COALESCE(m.sale_value, 0))::numeric AS v,
      SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * ABS(m.qty_change)::numeric * COALESCE(s.mrp, 0))::numeric AS m,
      (COUNT(DISTINCT (m.moved_at::date, m.reference_no)) FILTER (WHERE m.reference_no IS NOT NULL))::int AS b
    FROM inventory_movements m JOIN skus s ON s.id = m.sku_id JOIN locations l ON l.id = m.location_id
    WHERE m.movement_type IN ('SALE', 'RETURN') AND l.is_active AND s.is_active
      AND m.moved_at >= $1::date AND m.moved_at < $2::date + interval '1 day' ${skuWhere}
    GROUP BY 1`, [a, b, ...params]);
  return Object.fromEntries(rows.map((r) => [r.code, { q: Number(r.q), v: Number(r.v), m: Number(r.m), b: r.b }]));
}

async function accuracy(asOn, label, q, skuWhere, params, withBills) {
  console.log(`\n▸ ${label}`);
  const b = await wr.buildBoard({ as_on: asOn, ...q });
  const B = Object.fromEntries(b.stores.map((s) => [s.code, s]));
  let cells = 0; let bad = 0; const eg = [];
  for (const k of ['cw', 'pw', 'ly', 'pwly', 'mtd', 'mtdly', 'ytd', 'ytdly']) {
    const T = await truth(b.periods[k][0], b.periods[k][1], skuWhere, params);
    for (const [code, t] of Object.entries(T)) {
      const s = B[code];
      if (!s) { if (t.q || Math.abs(t.v) > 0.01) { bad++; eg.push(`${k} ${code} missing from board`); } continue; }
      const [bq, bv, bm, bb] = s.m[k]; cells++;
      const okQ = bq === t.q; const okV = Math.abs(bv - t.v) <= 0.011; const okM = Math.abs(bm - t.m) <= 0.011; const okB = !withBills || bb === t.b;
      if (!(okQ && okV && okM && okB)) { bad++; if (eg.length < 5) eg.push(`${k} ${code}: board ${[bq, bv, bm, bb]} vs raw ${[t.q, t.v.toFixed(2), t.m.toFixed(2), t.b]}`); }
    }
  }
  ok(bad === 0, `${cells.toLocaleString()} store × period cells match the raw sale lines (units exact, ₹/MRP to the paisa${withBills ? ', bills exact' : ''})${bad ? ` — ${bad} off: ${eg.join(' | ')}` : ''}`);
  // internal consistency
  let incon = 0;
  for (const s of b.stores) {
    const dsum = s.dy.reduce((x, y) => x + y, 0);
    if (Math.abs(dsum - s.m.mtd[1]) > s.dy.length) incon++;                              // daily series (whole ₹) adds to MTD
    if (Math.abs(s.wk[s.wk.length - 1] - s.m.cw[1]) > 1) incon++;                         // last week = this week
    const cq = Object.values(s.cat).reduce((x, a) => x + a[0], 0);
    if (cq !== s.m.ytd[0]) incon++;                                                       // categories add to YTD units
  }
  ok(incon === 0, `daily, weekly and category series add up to the period totals for all ${b.stores.length} stores${incon ? ` — ${incon} off` : ''}`);
  return b;
}

(async () => {
  const meta = await wr.getMeta();
  const asOn = arg('as-on') || meta.to;
  console.log(`War Room verification · as on ${asOn} · DB ${process.env.PG_DATABASE}:${process.env.PG_PORT}`);

  // ── ACCURACY — both paths: SQL (used while the engine reloads) and the in-memory engine ──
  const { rows: [sz] } = await query("SELECT size FROM skus WHERE is_active AND size IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1");
  const { rows: [sc] } = await query(`SELECT s.season, s.color_name FROM inventory_movements m JOIN skus s ON s.id = m.sku_id
    WHERE m.movement_type = 'SALE' AND m.moved_at >= $1::date - 90 AND s.season IS NOT NULL AND s.color_name IS NOT NULL
    GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 1`, [asOn]);   // the busiest season + colour, so the check covers many stores
  let b0;
  for (const path of ['SQL', 'engine']) {
    if (path === 'engine') { const t0 = Date.now(); await wr.loadEngine(); console.log(`\n  (engine loaded in ${Date.now() - t0} ms)`); }
    console.log(`\n═ ACCURACY · ${path} path`);
    b0 = await accuracy(asOn, 'No product filter', {}, '', [], true);
    if (b0.source !== (path === 'SQL' ? 'sql' : 'engine')) { failures++; console.log(`  ✗ expected the ${path} path, got ${b0.source}`); }
    await accuracy(asOn, 'Category = DENIM', { category: 'DENIM' }, 'AND s.category_norm = $3', ['DENIM'], false);
    await accuracy(asOn, `Size = ${sz.size}`, { size: sz.size }, 'AND s.size = $3', [sz.size], false);
    await accuracy(asOn, `Season = ${sc.season} + colour = ${sc.color_name}`, { season: sc.season, color: sc.color_name },
      'AND s.season = $3 AND s.color_name = $4', [sc.season, sc.color_name], false);
  }

  console.log('\n▸ Closing stock');
  if (b0.periods.stock.ty) {
    const { rows } = await query(`SELECT l.external_id AS code, SUM(d.qty_on_hand)::bigint AS q FROM inventory_daily_snapshot d
      JOIN locations l ON l.id = d.location_id WHERE d.snapshot_date = $1 AND d.qty_on_hand <> 0 GROUP BY 1`, [b0.periods.stock.ty]);
    let bad = 0; let n = 0;
    for (const r of rows) {
      const s = b0.stores.find((x) => x.code === r.code); if (!s) continue; n++;
      if (Object.values(s.stk).reduce((x, a) => x + a[0], 0) !== Number(r.q)) bad++;
    }
    ok(bad === 0, `stock units of ${n} stores on ${b0.periods.stock.ty} equal the raw snapshot${bad ? ` — ${bad} off` : ''}`);
  } else console.log('  · no stock snapshot for this date');

  // ── SPEED ──
  console.log('\n═ SPEED');
  const app = require('../app');
  const { rows: [u] } = await query('SELECT id FROM users WHERE is_active ORDER BY created_at LIMIT 1');
  const token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);
  require('../config/cache').clear();
  let t = Date.now(); let r = await auth(request(app).get(`/api/v1/war-room/board?as_on=${asOn}`).set('Accept-Encoding', 'gzip')); const cold = Date.now() - t;
  ok(r.status === 200 && r.headers['content-encoding'] === 'gzip', `board cold: ${cold} ms (served pre-gzipped)`);
  // cached, as a browser sees it: real socket, keep-alive, body not parsed
  const http = require('http'); const server = app.listen(0); const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true });
  const hit = (path) => new Promise((resolve, reject) => {
    const t1 = process.hrtime.bigint();
    http.get({ port, path, agent, headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } }, (res) => {
      let n = 0; res.on('data', (c) => { n += c.length; }); res.on('end', () => resolve([Number(process.hrtime.bigint() - t1) / 1e6, n, res.statusCode]));
    }).on('error', reject);
  });
  const times = [];
  for (let i = 0; i < 20; i++) times.push((await hit(`/api/v1/war-room/board?as_on=${asOn}`))[0]);
  times.sort((a, b) => a - b);
  ok(times[18] < 20, `board cached over HTTP (20 requests): p50 ${times[10].toFixed(1)} ms · p95 ${times[18].toFixed(1)} ms · max ${times[19].toFixed(1)} ms`);
  server.close(); agent.destroy();
  t = Date.now(); const par = await Promise.all(Array.from({ length: 25 }, () => auth(request(app).get(`/api/v1/war-room/board?as_on=${asOn}`))));
  ok(par.every((x) => x.status === 200), `25 concurrent board requests: ${Date.now() - t} ms total`);
  const raw = JSON.stringify(r.body); ok(true, `payload ${(raw.length / 1024).toFixed(0)} KB, ${(zlib.gzipSync(raw).length / 1024).toFixed(0)} KB compressed`);
  t = Date.now(); r = await auth(request(app).get(`/api/v1/war-room/board?as_on=${asOn}&category=DENIM`)); ok(r.status === 200, `product filter (rollup) cold: ${Date.now() - t} ms`);
  t = Date.now(); r = await auth(request(app).get(`/api/v1/war-room/board?as_on=${asOn}&size=${encodeURIComponent(sz.size)}`)); ok(r.status === 200, `deep product filter (raw lines) cold: ${Date.now() - t} ms`);
  t = Date.now(); r = await auth(request(app).get('/api/v1/war-room/filter-options?wr_region=West')); ok(r.status === 200 && r.body.options.state.length > 0, `filter options (cascading) first: ${Date.now() - t} ms`);
  t = Date.now(); r = await auth(request(app).get('/api/v1/war-room/filter-options?wr_region=North&category=DENIM')); ok(r.status === 200, `filter options again: ${Date.now() - t} ms`);
  const west = r.body.options; void west;
  t = Date.now(); r = await auth(request(app).get(`/api/v1/war-room/export.xlsx?as_on=${asOn}`)).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  ok(r.status === 200 && r.body.slice(0, 2).toString() === 'PK', `Excel export: ${Date.now() - t} ms, ${(r.body.length / 1024).toFixed(0)} KB`);

  // ── SECURITY ──
  console.log('\n═ SECURITY');
  ok((await request(app).get('/api/v1/war-room/board')).status === 401, 'no token → 401');
  ok((await request(app).get('/api/v1/war-room/board').set('Authorization', 'Bearer x.y.z')).status === 401, 'forged token → 401');
  ok((await request(app).get('/api/v1/war-room/board').set('Authorization', `Bearer ${jwt.sign({ userId: u.id }, 'wrong-secret')}`)).status === 401, 'token signed with another secret → 401');
  ok((await request(app).put('/api/v1/war-room/notes').send({})).status === 401, 'notes without token → 401');
  ok((await request(app).get('/api/v1/war-room/export.xlsx')).status === 401, 'export without token → 401');
  ok((await auth(request(app).get("/api/v1/war-room/board?as_on=2026-13-45"))).status === 400, 'invalid date → 400');
  ok((await auth(request(app).get("/api/v1/war-room/board?as_on=2026-01-01'); DROP TABLE wr_notes;--"))).status === 400, 'SQL injection in the date → 400');
  r = await auth(request(app).get(`/api/v1/war-room/board?as_on=${asOn}&category=${encodeURIComponent("DENIM') OR 1=1; DROP TABLE wr_notes;--")}`));
  ok(r.status === 200 && r.body.data.stores.length === 0, 'SQL injection in a filter value → treated as a plain value, no rows');
  r = await auth(request(app).get(`/api/v1/war-room/board?as_on=${asOn}&size=${encodeURIComponent("32' UNION SELECT * FROM users--")}`));
  ok(r.status === 200 && r.body.data.stores.length === 0, 'SQL injection in a deep filter value → plain value, no rows');
  ok((await query("SELECT to_regclass('wr_notes') IS NOT NULL AS t")).rows[0].t, 'wr_notes still exists');
  ok((await auth(request(app).put('/api/v1/war-room/notes').send({ week_start: asOn, external_id: "x'; DROP TABLE wr_notes;--" }))).status === 400, 'note for an injected store code → 400');
  ok((await auth(request(app).put('/api/v1/war-room/notes').send({ week_start: asOn, external_id: 'NOPE999' }))).status === 404, 'note for an unknown store → 404');
  ok((await auth(request(app).put('/api/v1/war-room/notes').send({ week_start: asOn, external_id: b0.stores[0].code, reason: 'x'.repeat(2001) }))).status === 400, 'note longer than 2000 characters → 400');
  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const code = b0.stores[0].code;
  r = await auth(request(app).put('/api/v1/war-room/notes').send({ week_start: asOn, external_id: code, reason: xss, action: 'test' }));
  const back = await auth(request(app).get(`/api/v1/war-room/notes?week_start=${asOn}`));
  ok(r.status === 200 && back.body.data.notes[code].reason === xss, 'markup in a note is stored and returned verbatim as text (the page renders it as text, never HTML)');
  await query('DELETE FROM wr_notes WHERE external_id = $1 AND action = $2', [code, 'test']);
  ok(true, 'test note removed');

  console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ All checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
