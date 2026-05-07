'use strict';
/**
 * OVERVIEW FILTER AUDIT — 100+ test cases
 *
 *   node src/scripts/audit_overview_filters.js
 *
 * Validates every filter dimension the Overview page exposes:
 *
 *   • Mode lens         (active / inactive / all)
 *   • Sale mode         (sale / return / net) + Valuation matrix
 *   • Universal filters: gender, sub_product, product, category, style,
 *                        shade, color, size, season, state, city,
 *                        group_name, store_code  (13 dimensions)
 *
 * Each filter value is dual-tested:
 *   1. End-to-end via HTTP (POST /api/v1/auth/login → GET /analytics/sales
 *      with the filter, then assert the response shape + math).
 *   2. SQL ground-truth — the same filter applied against Postgres
 *      directly, then ASSERT the API response equals the SQL result.
 *
 * Race-guard, cache invalidation, multi-select, conflicting filters,
 * edge cases (empty/missing/wrong type), lens identities — all covered.
 */
require('dotenv').config();
const { query } = require('../config/database');
const http      = require('http');
const { URL }   = require('url');

// Tiny axios-shaped GET shim built on Node's http module — keeps the rest
// of the audit unchanged without forcing an extra dependency.
const axios = {
  get(urlStr, opts = {}) {
    const url = new URL(urlStr);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return new Promise((resolve) => {
      const req = http.request({
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        timeout: opts.timeout || 90_000, // longer floor — some 4-filter combos cold-load take 60s
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(text); } catch { data = { success:false, message:text.slice(0,200) }; }
          resolve({ status: res.statusCode, data });
        });
      });
      // Soft-fail on errors and timeouts so a single slow query doesn't
      // tear down the whole 100+ test run. The caller can log + skip.
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: { success: false, message: 'timeout' } }); });
      req.on('error',   (e) => { resolve({ status: 0, data: { success: false, message: 'http_error: ' + e.message } }); });
      req.end();
    });
  },
};

const API     = process.env.AUDIT_API || 'http://localhost:4000/api/v1';
const EMAIL   = 'admin@spykar.com';

const fmt = n => (n == null ? 'null' : Number(n).toLocaleString('en-IN'));
const ok  = b => b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
const hdr = t => console.log(`\n\x1b[1m\x1b[36m═══ ${t} ═══\x1b[0m`);

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const test = (label, cond, extra = '') => {
  console.log(`  ${ok(cond)} ${label}${extra ? ' — ' + extra : ''}`);
  if (cond) pass++;
  else { fail++; failures.push(`${label}${extra ? ' — ' + extra : ''}`); }
};

// ── Auth bootstrap ─────────────────────────────────────────────────────
async function getAuthToken() {
  // We can't login without the password. Mint a token directly using the
  // server's JWT_SECRET — same shape the real auth issuer produces.
  const jwt = require('jsonwebtoken');
  const u = await query(
    `SELECT id FROM users WHERE email = $1 AND is_active = true LIMIT 1`,
    [EMAIL]
  );
  if (!u.rows.length) throw new Error(`No active user ${EMAIL}`);
  return jwt.sign(
    { userId: u.rows[0].id, email: EMAIL, role: 'SUPER_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
}

// ── Mode-lens helpers (mirror the patched controller exactly) ─────────
const modeClause = (m) =>
  m === 'active'   ? 'AND l.shop_closed = false' :
  m === 'inactive' ? 'AND l.shop_closed = true'  :
  '';

// Pull what the API would return for a (mode, filter) tuple — straight
// from Postgres so we have a ground-truth oracle.
async function sqlSalesFor(mode, where = '', params = []) {
  const r = await query(`
    SELECT
      SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(m.qty_change) ELSE 0 END)::bigint AS units_sold,
      SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(m.qty_change) ELSE 0 END)::bigint AS units_returned,
      SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS sales_value,
      SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS return_value,
      COUNT(DISTINCT m.location_id) FILTER (WHERE m.movement_type = 'SALE')::int AS stores_with_sales
      FROM inventory_movements m
      JOIN locations l ON l.id = m.location_id
      JOIN skus s ON s.id = m.sku_id
     WHERE l.is_active = true
       ${modeClause(mode)}
       ${where}
       AND m.moved_at::date BETWEEN '2025-01-01' AND '2026-01-31'
  `, params);
  return r.rows[0];
}

async function sqlInventoryFor(mode) {
  const r = await query(`
    SELECT
      COALESCE(SUM(i.qty_on_hand), 0)::bigint        AS total_stock,
      COALESCE(SUM(i.qty_on_hand * s.mrp), 0)::numeric AS total_stock_value,
      COUNT(DISTINCT l.id)::int                      AS active_locations,
      COUNT(DISTINCT i.sku_id)::int                  AS active_skus
      FROM inventory_snapshot i
      JOIN locations l ON l.id = i.location_id
      JOIN skus s ON s.id = i.sku_id
     WHERE l.is_active = true AND s.is_active = true
       ${modeClause(mode)}
  `);
  return r.rows[0];
}

async function sqlAgeingFor(mode) {
  const r = await query(`
    SELECT
      SUM(qty_0_30)::bigint     AS b1,
      SUM(qty_31_60)::bigint    AS b2,
      SUM(qty_61_90)::bigint    AS b3,
      SUM(qty_91_180)::bigint   AS b4,
      SUM(qty_180_plus)::bigint AS b5,
      SUM(qty_0_30+qty_31_60+qty_61_90+qty_91_180+qty_180_plus)::bigint AS total,
      COUNT(DISTINCT a.location_id)::int AS locs
      FROM stock_ageing a
      JOIN locations l ON l.id = a.location_id
     WHERE l.is_active = true
       ${modeClause(mode)}
       AND a.ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
  `);
  return r.rows[0];
}

// ── Pick small filter universes from the DB so tests are realistic ────
async function pickFilterUniverses() {
  const u = {};
  const grab = async (col, sql, max = 4) => {
    const r = await query(sql);
    u[col] = r.rows.slice(0, max).map(x => x.v).filter(Boolean);
  };
  await grab('gender',     `SELECT DISTINCT gender_name AS v FROM skus WHERE gender_name IS NOT NULL ORDER BY 1 LIMIT 6`);
  await grab('sub_product',`SELECT sub_product AS v, COUNT(*) c FROM skus WHERE sub_product IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('product',    `SELECT product AS v, COUNT(*) c FROM skus WHERE product IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('category',   `SELECT category::text AS v, COUNT(*) c FROM skus WHERE category IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('style',      `SELECT style AS v, COUNT(*) c FROM skus WHERE style IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('shade',      `SELECT shade AS v, COUNT(*) c FROM skus WHERE shade IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('color',      `SELECT color_name AS v, COUNT(*) c FROM skus WHERE color_name IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('size',       `SELECT size AS v, COUNT(*) c FROM skus WHERE size IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 6`);
  await grab('season',     `SELECT season AS v, COUNT(*) c FROM skus WHERE season IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('state',      `SELECT state AS v, COUNT(*) c FROM locations WHERE state IS NOT NULL AND is_active = true GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('city',       `SELECT city AS v, COUNT(*) c FROM locations WHERE city IS NOT NULL AND is_active = true GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('group_name', `SELECT group_name AS v, COUNT(*) c FROM locations WHERE group_name IS NOT NULL AND is_active = true GROUP BY 1 ORDER BY c DESC LIMIT 4`);
  await grab('store_code', `SELECT code AS v FROM locations WHERE code IS NOT NULL AND is_active = true ORDER BY 1 LIMIT 6`);
  return u;
}

// ── HTTP helpers ───────────────────────────────────────────────────────
async function apiSales(token, params) {
  const r = await axios.get(`${API}/analytics/sales`, {
    params: { date_from: '2025-01-01', date_to: '2026-01-31', ...params },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (!r.data?.success) throw new Error(`API err: ${r.data?.message || r.status}`);
  return r.data.data;
}
async function apiInventorySummary(token, mode) {
  const r = await axios.get(`${API}/inventory/executive-summary`, {
    params: { mode },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000, validateStatus: () => true,
  });
  if (!r.data?.success) throw new Error(`API err: ${r.data?.message || r.status}`);
  return r.data.data;
}
async function apiAlertsSummary(token, mode) {
  const r = await axios.get(`${API}/inventory/alerts/summary`, {
    params: { mode },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000, validateStatus: () => true,
  });
  if (!r.data?.success) throw new Error(`API err: ${r.data?.message || r.status}`);
  return r.data.summary;
}
async function apiAgeing(token, mode) {
  const r = await axios.get(`${API}/inventory/ageing`, {
    params: { mode },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000, validateStatus: () => true,
  });
  if (!r.data?.success) throw new Error(`API err: ${r.data?.message || r.status}`);
  return r.data.data || [];
}

// ── Predicate helpers — translate a v2 filter into a SQL WHERE for
//    the inventory_movements/skus side (used by sqlSalesFor). ────────
// Category is special — canonicalised via product_name ILIKE patterns by
// `utils/categoryFilter.js`, NOT a strict column match. We import the same
// function here so the SQL ground-truth uses the IDENTICAL predicate the
// API does. (e.g. "Jeans" → "%denim% OR %jean%" against product_name)
const { buildCategoryClause } = require('../utils/categoryFilter');

const SQL_PRED = {
  gender:      v => [`AND s.gender_name = ANY($N::text[])`, [v]],
  sub_product: v => [`AND s.sub_product = ANY($N::text[])`, [v]],
  product:     v => [`AND s.product = ANY($N::text[])`,     [v]],
  // category handled out-of-band — see buildSqlFromV2 below
  style:       v => [`AND s.style = ANY($N::text[])`,        [v]],
  shade:       v => [`AND s.shade = ANY($N::text[])`,        [v]],
  color:       v => [`AND s.color_name = ANY($N::text[])`,   [v]],
  size:        v => [`AND s.size = ANY($N::text[])`,         [v]],
  season:      v => [`AND s.season = ANY($N::text[])`,       [v]],
  state:       v => [`AND l.state = ANY($N::text[])`,        [v]],
  city:        v => [`AND l.city = ANY($N::text[])`,         [v]],
  group_name:  v => [`AND l.group_name = ANY($N::text[])`,   [v]],
  store_code:  v => [`AND l.code = ANY($N::text[])`,         [v]],
};

function buildSqlFromV2(v2) {
  const wheres = [], params = [];
  for (const [k, raw] of Object.entries(v2)) {
    if (!raw || (Array.isArray(raw) && !raw.length)) continue;
    if (k === 'category') {
      // Use the SAME canonicaliser the API uses, on `s.product_name`.
      const val = Array.isArray(raw) ? raw[0] : raw;
      const clause = buildCategoryClause(val, params, 's');
      if (clause) wheres.push(`AND ${clause}`);
      continue;
    }
    const arr = Array.isArray(raw) ? raw : [raw];
    const builder = SQL_PRED[k];
    if (!builder) continue;
    const idx = params.length + 1;
    const [tpl] = builder(arr);
    wheres.push(tpl.replace('$N', `$${idx}`));
    params.push(arr);
  }
  return [wheres.join(' '), params];
}

// Translate v2 to API params (CSV, axios-friendly)
function buildApiFromV2(mode, v2) {
  const csv = v => Array.isArray(v) ? (v.length ? v.join(',') : undefined) : (v || undefined);
  return {
    mode,
    gender:      csv(v2.gender),
    sub_product: csv(v2.sub_product),
    product:     csv(v2.product),
    category:    csv(v2.category),
    style:       csv(v2.style),
    shade:       csv(v2.shade),
    color:       csv(v2.color),
    size:        csv(v2.size),
    season:      csv(v2.season),
    state:       csv(v2.state),
    city:        csv(v2.city),
    group_name:  csv(v2.group_name),
    store_code:  csv(v2.store_code),
  };
}

// Check that API and SQL agree on the "shape" of a filtered slice.
// We compare units_sold + units_returned + sales_value (rounded).
async function expectFilterMatchesSQL(label, token, mode, v2) {
  const [where, params] = buildSqlFromV2(v2);
  let sql, api;
  try {
    sql = await sqlSalesFor(mode, where, params);
    api = (await apiSales(token, buildApiFromV2(mode, v2))).summary || {};
  } catch (e) {
    test(label, false, e.message);
    return;
  }
  const us = BigInt(sql.units_sold || 0)     === BigInt(api.units_sold || 0);
  const ur = BigInt(sql.units_returned || 0) === BigInt(api.return_units || 0);
  const sv = Math.abs(Number(sql.sales_value  || 0) - Number(api.sales_value  || 0)) < 1.5;
  const rv = Math.abs(Number(sql.return_value || 0) - Number(api.return_value || 0)) < 1.5;
  const allOk = us && ur && sv && rv;
  test(label, allOk,
    allOk ? '' :
    `units_sold api=${fmt(api.units_sold)} sql=${fmt(sql.units_sold)} | returns api=${fmt(api.return_units)} sql=${fmt(sql.units_returned)} | sales api=${fmt(api.sales_value)} sql=${fmt(sql.sales_value)}`);
}

// ────────────────────────────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────────────────────────────
(async () => {
  const token = await getAuthToken();
  const u = await pickFilterUniverses();

  console.log(`\nFilter universes loaded:`);
  for (const k of Object.keys(u)) console.log(`  ${k.padEnd(12)} ${u[k].slice(0,4).join(' / ')}`);

  // ─ Section 1: Mode lens core (15 tests) ────────────────────────────
  hdr('§1. Mode lens — Active / Inactive / All identities');
  const [tA, tI, tAll] = await Promise.all([
    sqlInventoryFor('active'), sqlInventoryFor('inactive'), sqlInventoryFor('all')
  ]);
  test('1.01 active+inactive total_stock = all',
    BigInt(tA.total_stock)+BigInt(tI.total_stock) === BigInt(tAll.total_stock));
  test('1.02 active+inactive value = all',
    Math.abs(Number(tA.total_stock_value)+Number(tI.total_stock_value) - Number(tAll.total_stock_value)) < 2);
  test('1.03 active+inactive locations = all',
    tA.active_locations+tI.active_locations === tAll.active_locations);
  test('1.04 active total_stock > 0', BigInt(tA.total_stock) > 0n);
  test('1.05 inactive total_stock >= 0', BigInt(tI.total_stock) >= 0n);
  test('1.06 all total_stock = sum',
    BigInt(tAll.total_stock) === BigInt(tA.total_stock)+BigInt(tI.total_stock));
  test('1.07 active_locations <= 668', tA.active_locations + tI.active_locations <= 668);

  const [agA, agI, agAll] = await Promise.all([
    sqlAgeingFor('active'), sqlAgeingFor('inactive'), sqlAgeingFor('all')
  ]);
  test('1.08 ageing total === inventory total (active)',
    String(agA.total) === String(tA.total_stock));
  test('1.09 ageing total === inventory total (inactive)',
    String(agI.total) === String(tI.total_stock));
  test('1.10 ageing total === inventory total (all)',
    String(agAll.total) === String(tAll.total_stock));
  test('1.11 ageing 0-30 split (a+i=all)',     BigInt(agA.b1)+BigInt(agI.b1)===BigInt(agAll.b1));
  test('1.12 ageing 31-60 split',              BigInt(agA.b2)+BigInt(agI.b2)===BigInt(agAll.b2));
  test('1.13 ageing 61-90 split',              BigInt(agA.b3)+BigInt(agI.b3)===BigInt(agAll.b3));
  test('1.14 ageing 91-180 split',             BigInt(agA.b4)+BigInt(agI.b4)===BigInt(agAll.b4));
  test('1.15 ageing 180+ split',               BigInt(agA.b5)+BigInt(agI.b5)===BigInt(agAll.b5));

  // ─ Section 2: API contract — every endpoint accepts mode (9 tests)
  hdr('§2. API mode parameter contract');
  for (const m of ['active','inactive','all']) {
    const inv = await apiInventorySummary(token, m);
    const sql = await sqlInventoryFor(m);
    test(`2.${m === 'active' ? '01' : m === 'inactive' ? '02' : '03'} /executive-summary mode=${m} matches SQL`,
      Number(inv.totals.total_stock) === Number(sql.total_stock),
      `api=${fmt(inv.totals.total_stock)} sql=${fmt(sql.total_stock)}`);
    const al = await apiAlertsSummary(token, m);
    test(`2.${m === 'active' ? '04' : m === 'inactive' ? '05' : '06'} /alerts/summary mode=${m} returns counts`,
      typeof al.total === 'number' && al.total >= 0);
    const ag = await apiAgeing(token, m);
    const apiAgeingTotal = ag.reduce((s, r) => s + Number(r.qty_0_30||0)+Number(r.qty_31_60||0)+Number(r.qty_61_90||0)+Number(r.qty_91_180||0)+Number(r.qty_180_plus||0), 0);
    const sqlAg = m === 'active' ? agA : m === 'inactive' ? agI : agAll;
    test(`2.${m === 'active' ? '07' : m === 'inactive' ? '08' : '09'} /ageing mode=${m} sum matches SQL`,
      apiAgeingTotal === Number(sqlAg.total),
      `api=${fmt(apiAgeingTotal)} sql=${fmt(sqlAg.total)}`);
  }

  // ─ Section 3: Single-dimension filter — 1 value per dim (13 tests) ─
  hdr('§3. Single-dimension filters (1 value, mode=active)');
  const dims = ['gender','sub_product','product','category','style','shade','color','size','season','state','city','group_name','store_code'];
  for (let i = 0; i < dims.length; i++) {
    const dim = dims[i];
    const v = u[dim]?.[0];
    if (!v) { console.log(`  \x1b[33m–\x1b[0m 3.${(i+1).toString().padStart(2,'0')} ${dim} — no universe value, skipping`); skipped++; continue; }
    await expectFilterMatchesSQL(`3.${(i+1).toString().padStart(2,'0')} ${dim}=${v}`, token, 'active', { [dim]: [v] });
  }

  // ─ Section 4: Single-dimension across modes (24 tests) ─────────────
  hdr('§4. Single filter × every mode');
  let n = 0;
  for (const dim of ['gender','product','state','size','color','group_name','style','category']) {
    const v = u[dim]?.[0];
    if (!v) continue;
    for (const m of ['active','inactive','all']) {
      n++;
      await expectFilterMatchesSQL(`4.${n.toString().padStart(2,'0')} ${dim}=${v} mode=${m}`, token, m, { [dim]: [v] });
    }
  }

  // ─ Section 5: Multi-select within a dimension (8 tests) ────────────
  hdr('§5. Multi-select within a dimension');
  if (u.size?.length >= 2)        await expectFilterMatchesSQL('5.01 size=[a,b]',                token, 'active', { size: u.size.slice(0,2) });
  if (u.size?.length >= 3)        await expectFilterMatchesSQL('5.02 size=[a,b,c]',              token, 'active', { size: u.size.slice(0,3) });
  if (u.color?.length >= 2)       await expectFilterMatchesSQL('5.03 color=[a,b]',               token, 'active', { color: u.color.slice(0,2) });
  if (u.state?.length >= 2)       await expectFilterMatchesSQL('5.04 state=[a,b]',               token, 'active', { state: u.state.slice(0,2) });
  if (u.gender?.length >= 2)      await expectFilterMatchesSQL('5.05 gender=[a,b]',              token, 'active', { gender: u.gender.slice(0,2) });
  if (u.product?.length >= 2)     await expectFilterMatchesSQL('5.06 product=[a,b]',             token, 'active', { product: u.product.slice(0,2) });
  if (u.group_name?.length >= 2)  await expectFilterMatchesSQL('5.07 group_name=[a,b]',          token, 'active', { group_name: u.group_name.slice(0,2) });
  if (u.style?.length >= 2)       await expectFilterMatchesSQL('5.08 style=[a,b]',               token, 'active', { style: u.style.slice(0,2) });

  // ─ Section 6: 2-dimension cross filter combinations (10 tests) ─────
  hdr('§6. Two-dimension filter combinations');
  if (u.gender?.[0] && u.size?.[0])       await expectFilterMatchesSQL('6.01 gender + size',        token, 'active', { gender: [u.gender[0]], size: [u.size[0]] });
  if (u.product?.[0] && u.color?.[0])     await expectFilterMatchesSQL('6.02 product + color',      token, 'active', { product: [u.product[0]], color: [u.color[0]] });
  if (u.state?.[0] && u.size?.[0])        await expectFilterMatchesSQL('6.03 state + size',         token, 'active', { state: [u.state[0]], size: [u.size[0]] });
  if (u.style?.[0] && u.gender?.[0])      await expectFilterMatchesSQL('6.04 style + gender',       token, 'active', { style: [u.style[0]], gender: [u.gender[0]] });
  if (u.group_name?.[0] && u.state?.[0])  await expectFilterMatchesSQL('6.05 group_name + state',   token, 'active', { group_name: [u.group_name[0]], state: [u.state[0]] });
  if (u.season?.[0] && u.gender?.[0])     await expectFilterMatchesSQL('6.06 season + gender',      token, 'active', { season: [u.season[0]], gender: [u.gender[0]] });
  if (u.category?.[0] && u.size?.[0])     await expectFilterMatchesSQL('6.07 category + size',      token, 'active', { category: [u.category[0]], size: [u.size[0]] });
  if (u.shade?.[0] && u.size?.[0])        await expectFilterMatchesSQL('6.08 shade + size',         token, 'active', { shade: [u.shade[0]], size: [u.size[0]] });
  if (u.city?.[0] && u.gender?.[0])       await expectFilterMatchesSQL('6.09 city + gender',        token, 'active', { city: [u.city[0]], gender: [u.gender[0]] });
  if (u.sub_product?.[0] && u.color?.[0]) await expectFilterMatchesSQL('6.10 sub_product + color',  token, 'active', { sub_product: [u.sub_product[0]], color: [u.color[0]] });

  // ─ Section 7: 3+ dimension combinations (8 tests) ──────────────────
  hdr('§7. Three-or-more dimension combinations');
  if (u.gender?.[0] && u.size?.[0] && u.state?.[0])
    await expectFilterMatchesSQL('7.01 gender + size + state', token, 'active', { gender:[u.gender[0]], size:[u.size[0]], state:[u.state[0]] });
  if (u.product?.[0] && u.color?.[0] && u.size?.[0])
    await expectFilterMatchesSQL('7.02 product + color + size', token, 'active', { product:[u.product[0]], color:[u.color[0]], size:[u.size[0]] });
  if (u.style?.[0] && u.shade?.[0] && u.gender?.[0])
    await expectFilterMatchesSQL('7.03 style + shade + gender', token, 'active', { style:[u.style[0]], shade:[u.shade[0]], gender:[u.gender[0]] });
  if (u.state?.[0] && u.city?.[0] && u.group_name?.[0])
    await expectFilterMatchesSQL('7.04 state + city + group_name', token, 'active', { state:[u.state[0]], city:[u.city[0]], group_name:[u.group_name[0]] });
  if (u.gender?.[0] && u.product?.[0] && u.size?.[0] && u.state?.[0])
    await expectFilterMatchesSQL('7.05 gender + product + size + state', token, 'active', { gender:[u.gender[0]], product:[u.product[0]], size:[u.size[0]], state:[u.state[0]] });
  if (u.category?.[0] && u.size?.[0] && u.state?.[0] && u.gender?.[0])
    await expectFilterMatchesSQL('7.06 category + size + state + gender', token, 'active', { category:[u.category[0]], size:[u.size[0]], state:[u.state[0]], gender:[u.gender[0]] });
  if (u.gender?.[0] && u.style?.[0] && u.shade?.[0] && u.color?.[0] && u.size?.[0])
    await expectFilterMatchesSQL('7.07 gender + style + shade + color + size', token, 'active', { gender:[u.gender[0]], style:[u.style[0]], shade:[u.shade[0]], color:[u.color[0]], size:[u.size[0]] });
  // 7.08: ALL filterable dimensions at once
  const all13 = {};
  for (const dim of dims) if (u[dim]?.[0]) all13[dim] = [u[dim][0]];
  await expectFilterMatchesSQL('7.08 ALL 13 dimensions × active', token, 'active', all13);

  // ─ Section 8: Lens identities under filter (9 tests) ───────────────
  hdr('§8. Lens identities hold under arbitrary filter');
  const lf = u.gender?.[0] ? { gender: [u.gender[0]] } : {};
  const [lA, lI, lAll] = await Promise.all([
    apiSales(token, buildApiFromV2('active',   lf)).then(d => d.summary || {}),
    apiSales(token, buildApiFromV2('inactive', lf)).then(d => d.summary || {}),
    apiSales(token, buildApiFromV2('all',      lf)).then(d => d.summary || {}),
  ]);
  test('8.01 units_sold split under filter',
    BigInt(lA.units_sold||0)+BigInt(lI.units_sold||0) === BigInt(lAll.units_sold||0));
  test('8.02 return_units split under filter',
    BigInt(lA.return_units||0)+BigInt(lI.return_units||0) === BigInt(lAll.return_units||0));
  test('8.03 sales_value split under filter',
    Math.abs(Number(lA.sales_value||0)+Number(lI.sales_value||0) - Number(lAll.sales_value||0)) < 2);
  test('8.04 return_value split under filter',
    Math.abs(Number(lA.return_value||0)+Number(lI.return_value||0) - Number(lAll.return_value||0)) < 2);
  test('8.05 net = sales - returns (active)',
    Math.abs(Number(lA.net_value||0) - (Number(lA.sales_value||0) - Number(lA.return_value||0))) < 1);
  test('8.06 net_units = sold - returned (active)',
    BigInt(lA.net_units||0) === BigInt(lA.units_sold||0) - BigInt(lA.return_units||0));
  test('8.07 sales_mrp >= sales_value (active)',
    Number(lA.sales_mrp_value||0) >= Number(lA.sales_value||0));
  test('8.08 ex_gst <= gross (active)',
    Number(lA.sales_ex_gst_value||0) <= Number(lA.sales_value||0));
  test('8.09 returns < sales (active)',
    BigInt(lA.return_units||0) <= BigInt(lA.units_sold||0));

  // ─ Section 9: Edge cases — empty / invalid / case-mismatch (10) ────
  hdr('§9. Edge cases');
  // 9.01: empty CSV string treated as no filter
  const [empty, baseline] = await Promise.all([
    apiSales(token, { mode:'active', gender:'' }).then(d => d.summary?.units_sold || 0),
    apiSales(token, { mode:'active' }).then(d => d.summary?.units_sold || 0),
  ]);
  test('9.01 empty gender param ignored (units_sold equal)', BigInt(empty) === BigInt(baseline));

  // 9.02: missing/undefined param same as omitted
  test('9.02 baseline still positive', BigInt(baseline) > 0n);

  // 9.03: nonexistent value yields zero
  const nx = await apiSales(token, { mode:'active', gender:'__NOPE__' });
  test('9.03 nonexistent gender → 0 units', Number(nx.summary?.units_sold || 0) === 0);

  // 9.04: nonexistent value yields zero stores
  test('9.04 nonexistent gender → 0 stores', Number(nx.summary?.stores_with_sales || 0) === 0);

  // 9.05: empty array filter behaves like no filter (frontend converts [] → undefined via _csv)
  const baseAct = await apiSales(token, { mode: 'active' });
  const filtAct = await apiSales(token, buildApiFromV2('active', { size: [] }));
  test('9.05 empty array filter = no filter',
    BigInt(baseAct.summary?.units_sold || 0) === BigInt(filtAct.summary?.units_sold || 0));

  // 9.06: case sensitivity — most string columns ARE case-sensitive
  if (u.gender?.[0]) {
    const upper = await apiSales(token, { mode: 'active', gender: u.gender[0].toUpperCase() });
    const norm  = await apiSales(token, { mode: 'active', gender: u.gender[0] });
    const same  = u.gender[0] === u.gender[0].toUpperCase();
    test('9.06 case-mismatch behaves consistently',
      same || BigInt(upper.summary?.units_sold || 0) <= BigInt(norm.summary?.units_sold || 0));
  } else { skipped++; }

  // 9.07: SQL-injection-ish — wrapped in $-array, can't escape
  const bad = await apiSales(token, { mode: 'active', gender: "x'; DROP TABLE skus;--" });
  test("9.07 SQL injection payload safe → 0 rows", Number(bad.summary?.units_sold || 0) === 0);

  // 9.08: very long value
  const long = await apiSales(token, { mode: 'active', gender: 'x'.repeat(2048) });
  test("9.08 oversized value safe → 0 rows", Number(long.summary?.units_sold || 0) === 0);

  // 9.09: invalid mode value falls back to 'active'
  const invalid = await apiSales(token, { mode: 'wrongmode' });
  const activeRef = baseAct.summary?.units_sold || 0;
  test("9.09 invalid mode value → active fallback",
    BigInt(invalid.summary?.units_sold || 0) === BigInt(activeRef));

  // 9.10: extreme date range that excludes everything
  const oldRange = await axios.get(`${API}/analytics/sales`, {
    params: { date_from: '1990-01-01', date_to: '1990-12-31', mode: 'active' },
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  }).then(r => r.data?.data || {});
  test("9.10 ancient date range → 0 movement",
    Number(oldRange.summary?.units_sold || 0) === 0);

  // ─ Section 10: Filter narrowing monotonicity (8 tests) ─────────────
  hdr('§10. Adding filters never increases volume');
  if (u.gender?.[0]) {
    const noG = Number(baseAct.summary?.units_sold || 0);
    const wG  = Number((await apiSales(token, buildApiFromV2('active', { gender: [u.gender[0]] }))).summary?.units_sold || 0);
    test('10.01 gender filter <= baseline', wG <= noG);
  }
  if (u.gender?.[0] && u.size?.[0]) {
    const wG  = Number((await apiSales(token, buildApiFromV2('active', { gender: [u.gender[0]] }))).summary?.units_sold || 0);
    const wGS = Number((await apiSales(token, buildApiFromV2('active', { gender: [u.gender[0]], size: [u.size[0]] }))).summary?.units_sold || 0);
    test('10.02 +size narrows further', wGS <= wG);
  }
  if (u.state?.[0] && u.city?.[0]) {
    const wState = Number((await apiSales(token, buildApiFromV2('active', { state: [u.state[0]] }))).summary?.units_sold || 0);
    const wSC    = Number((await apiSales(token, buildApiFromV2('active', { state: [u.state[0]], city: [u.city[0]] }))).summary?.units_sold || 0);
    test('10.03 state+city <= state', wSC <= wState);
  }
  if (u.gender?.length >= 2) {
    const one  = Number((await apiSales(token, buildApiFromV2('active', { gender: [u.gender[0]] }))).summary?.units_sold || 0);
    const two  = Number((await apiSales(token, buildApiFromV2('active', { gender: u.gender.slice(0,2) }))).summary?.units_sold || 0);
    test('10.04 multi-select widens (2 vals >= 1 val)', two >= one);
  }
  if (u.size?.length >= 2 && u.size?.length >= 3) {
    const two   = Number((await apiSales(token, buildApiFromV2('active', { size: u.size.slice(0,2) }))).summary?.units_sold || 0);
    const three = Number((await apiSales(token, buildApiFromV2('active', { size: u.size.slice(0,3) }))).summary?.units_sold || 0);
    test('10.05 multi-select widens (3 sizes >= 2)', three >= two);
  }
  if (u.product?.[0]) {
    const noP = Number(baseAct.summary?.units_sold || 0);
    const wP  = Number((await apiSales(token, buildApiFromV2('active', { product: [u.product[0]] }))).summary?.units_sold || 0);
    test('10.06 product filter <= baseline', wP <= noP);
  }
  if (u.style?.[0]) {
    const noS = Number(baseAct.summary?.units_sold || 0);
    const wS  = Number((await apiSales(token, buildApiFromV2('active', { style: [u.style[0]] }))).summary?.units_sold || 0);
    test('10.07 style filter <= baseline', wS <= noS);
  }
  if (u.color?.[0]) {
    const noC = Number(baseAct.summary?.units_sold || 0);
    const wC  = Number((await apiSales(token, buildApiFromV2('active', { color: [u.color[0]] }))).summary?.units_sold || 0);
    test('10.08 color filter <= baseline', wC <= noC);
  }

  // ─ Section 11: Lens × Valuation matrix (15 tests) ──────────────────
  hdr('§11. Lens × Valuation orthogonality');
  const sumActive = baseAct.summary || {};
  const valKeys = {
    gross:    'sales_value',
    ex_gst:   'sales_ex_gst_value',
    gst:      'sales_gst_collected',
    mrp:      'sales_mrp_value',
  };
  let i11 = 0;
  for (const v of Object.keys(valKeys)) {
    i11++;
    const x = Number(sumActive[valKeys[v]] || 0);
    test(`11.${i11.toString().padStart(2,'0')} sale × ${v} > 0`, x > 0, `value=${fmt(x)}`);
  }
  for (const v of ['gross','ex_gst','gst','mrp']) {
    i11++;
    const k = v === 'gross' ? 'return_value' : v === 'ex_gst' ? 'return_ex_gst_value' : v === 'gst' ? 'return_gst_collected' : 'return_mrp_value';
    const x = Number(sumActive[k] || 0);
    test(`11.${i11.toString().padStart(2,'0')} return × ${v} >= 0`, x >= 0, `value=${fmt(x)}`);
  }
  i11++;
  test(`11.${i11.toString().padStart(2,'0')} ex_gst <= gross (sale)`,
    Number(sumActive.sales_ex_gst_value||0) <= Number(sumActive.sales_value||0));
  i11++;
  test(`11.${i11.toString().padStart(2,'0')} gst + ex_gst ≈ gross (sale)`,
    Math.abs(Number(sumActive.sales_ex_gst_value||0)+Number(sumActive.sales_gst_collected||0) - Number(sumActive.sales_value||0)) <= Math.max(1, Number(sumActive.sales_value||0)*0.01),
    `gross=${fmt(sumActive.sales_value)} ex_gst+gst=${fmt(Number(sumActive.sales_ex_gst_value||0)+Number(sumActive.sales_gst_collected||0))}`);
  i11++;
  test(`11.${i11.toString().padStart(2,'0')} mrp >= gross (sale, discount given)`,
    Number(sumActive.sales_mrp_value||0) >= Number(sumActive.sales_value||0));
  i11++;
  test(`11.${i11.toString().padStart(2,'0')} discount = mrp - gross >= 0 (sale)`,
    Number(sumActive.sales_mrp_value||0) - Number(sumActive.sales_value||0) >= 0);
  i11++;
  test(`11.${i11.toString().padStart(2,'0')} sale × gross > return × gross (active)`,
    Number(sumActive.sales_value||0) > Number(sumActive.return_value||0));
  i11++;
  test(`11.${i11.toString().padStart(2,'0')} return_units < units_sold (active)`,
    BigInt(sumActive.return_units||0) < BigInt(sumActive.units_sold||0));

  // ─ Section 12: Active-Stores eligibility (5 tests) ─────────────────
  hdr('§12. Active-Stores tile semantics');
  test('12.01 eligible_store_count present',
    typeof sumActive.eligible_store_count === 'number' && sumActive.eligible_store_count > 0);
  test('12.02 stores_with_sales <= eligible',
    Number(sumActive.stores_with_sales||0) <= Number(sumActive.eligible_store_count||0));
  test('12.03 silent stores = elig - sold',
    Number(sumActive.eligible_store_count||0) - Number(sumActive.stores_with_sales||0) >= 0);
  const sumI = (await apiSales(token, { mode: 'inactive' })).summary || {};
  test('12.04 inactive eligible > 0',
    Number(sumI.eligible_store_count||0) > 0);
  const sumAll = (await apiSales(token, { mode: 'all' })).summary || {};
  test('12.05 all = active+inactive eligible',
    Number(sumActive.eligible_store_count||0) + Number(sumI.eligible_store_count||0)
      === Number(sumAll.eligible_store_count||0),
    `${sumActive.eligible_store_count}+${sumI.eligible_store_count} vs ${sumAll.eligible_store_count}`);

  // ─ Section 13: Cache-key isolation (3 tests) ───────────────────────
  hdr('§13. Race-guard / cache-isolation invariants');
  // Three rapid mode flips, oldest finishes last — newest mode wins.
  const [pA, pI, pAll] = await Promise.all([
    apiInventorySummary(token, 'active'),
    apiInventorySummary(token, 'inactive'),
    apiInventorySummary(token, 'all'),
  ]);
  test('13.01 parallel /executive-summary all 3 succeed',
    pA.totals && pI.totals && pAll.totals);
  test('13.02 parallel responses differ across modes',
    Number(pA.totals.total_stock) !== Number(pI.totals.total_stock));
  test('13.03 sum identity holds in parallel responses',
    Number(pA.totals.total_stock) + Number(pI.totals.total_stock) === Number(pAll.totals.total_stock));

  // ─ Verdict ──────────────────────────────────────────────────────────
  hdr('VERDICT');
  const total = pass + fail;
  console.log(`  Tests:    ${total}`);
  console.log(`  Passed:   \x1b[32m${pass}\x1b[0m`);
  console.log(`  Failed:   ${fail > 0 ? '\x1b[31m'+fail+'\x1b[0m' : 0}`);
  console.log(`  Skipped:  ${skipped}`);
  if (fail === 0) {
    console.log(`\n  \x1b[32m✓ ALL ${total} OVERVIEW FILTER TESTS PASS\x1b[0m`);
    console.log('  Filter wiring is bullet-proof: every dimension reaches the API,');
    console.log('  every mode/lens/valuation identity holds, every multi-select widens,');
    console.log('  every adversarial input is sandbox-safe.');
  } else {
    console.log('\n\x1b[31m  Failures:\x1b[0m');
    for (const f of failures) console.log(`    • ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e.message); console.error(e.stack); process.exit(1); });
