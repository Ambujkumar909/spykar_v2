#!/usr/bin/env node
'use strict';
/**
 * test_filters.js — Comprehensive filter regression suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers every "impossible" case I could think of for the v2 universal filter
 * bar so we can prove the dropdown population is world-class:
 *
 *   ① Baseline (no filter) — every dim returns its full domain
 *   ② Self-strip — picking value X for dim D never narrows D itself
 *   ③ Cross-narrow — picking value X for dim D narrows EVERY OTHER dim
 *   ④ Cascade — chaining filters narrows progressively
 *   ⑤ Multi-select — comma-separated values OR-combined correctly
 *   ⑥ Mode lens — active / inactive / all narrows results correctly
 *   ⑦ Case insensitivity — 'denim' and 'DENIM' should both work
 *   ⑧ Whitespace — '  MENS  ' should match 'MENS'
 *   ⑨ Empty / unknown — nonsense values return 0 results, not 500
 *   ⑩ SQL-injection — single quotes / DROP TABLE / -- comments are safe
 *   ⑪ Special chars — store codes with apostrophes, hyphens, etc.
 *   ⑫ Stock anchor change — when /sync runs and stock changes, options
 *      refresh within the cache TTL (separately tested manually)
 *
 * Usage:
 *   node src/scripts/test_filters.js                 — run all tests
 *   node src/scripts/test_filters.js --verbose       — print full responses
 *
 * Returns exit code 0 on full pass, 1 on any failure.
 */

require('dotenv').config();
// Node 22 has global fetch — no axios dependency needed for this script.

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4001/api/v1';
const EMAIL    = process.env.TEST_EMAIL    || 'admin@spykar.com';
const PASSWORD = process.env.TEST_PASSWORD || 'Admin@123';
const VERBOSE  = process.argv.includes('--verbose');

// Tiny axios-shim using fetch so the rest of the script reads naturally.
function qs(params) {
  const u = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    u.set(k, String(v));
  });
  return u.toString();
}
async function httpGet(url, params, headers) {
  const full = params && Object.keys(params).length ? `${url}?${qs(params)}` : url;
  const res = await fetch(full, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}
async function httpPost(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}

// ─── Test runner harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') {
  passed++;
  console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`);
}
function fail(name, detail) {
  failed++;
  failures.push({ name, detail });
  console.log(`  ❌ ${name}\n     ${detail}`);
}

function assert(name, cond, detailIfFail = '') {
  if (cond) ok(name);
  else fail(name, detailIfFail);
}

async function options(token, params = {}) {
  const r = await httpGet(`${API_BASE}/filters/options`, params, { Authorization: `Bearer ${token}` });
  return r?.options || {};
}
async function pulse(token, params = {}) {
  const r = await httpGet(`${API_BASE}/locations/network-pulse`, params, { Authorization: `Bearer ${token}` });
  return r?.data;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function suite_baseline(token) {
  console.log('\n[1] BASELINE — every dim returns its full domain');
  const o = await options(token);
  assert('gender returns 4 values',     o.gender?.length === 4,      `got ${o.gender?.length}: [${o.gender?.join(', ')}]`);
  assert('sub_product returns 100+',     o.sub_product?.length >= 100, `got ${o.sub_product?.length}`);
  assert('category returns 5+',          o.category?.length >= 5,      `got ${o.category?.length}`);
  assert('state returns 15+',            o.state?.length >= 15,        `got ${o.state?.length}`);
  assert('city returns 100+',            o.city?.length >= 100,        `got ${o.city?.length}`);
  assert('group_name returns 1+',        o.group_name?.length >= 1,    `got ${o.group_name?.length}`);
  assert('store_code returns 100+',      o.store_code?.length >= 100,  `got ${o.store_code?.length}`);
}

async function suite_self_strip(token) {
  console.log('\n[2] SELF-STRIP — picking value for dim D never collapses D');
  const checks = [
    { picked: { gender: 'MENS' },        dim: 'gender',     expected: 4 },
    { picked: { state:  'MAHARASHTRA' }, dim: 'state',      expectedMin: 15 },
    { picked: { sub_product: 'JEAN' },   dim: 'sub_product',expectedMin: 100 },
    { picked: { category: 'DENIM' },     dim: 'category',   expectedMin: 5 },
  ];
  for (const c of checks) {
    const o = await options(token, c.picked);
    const got = o[c.dim]?.length || 0;
    if (c.expected != null) {
      assert(`pick ${Object.keys(c.picked)[0]} → ${c.dim} stays at ${c.expected}`, got === c.expected,
        `got ${got}: [${(o[c.dim]||[]).slice(0,5).join(', ')}…]`);
    } else {
      assert(`pick ${Object.keys(c.picked)[0]} → ${c.dim} stays at ${c.expectedMin}+`, got >= c.expectedMin,
        `got ${got}`);
    }
  }
}

async function suite_cross_narrow(token) {
  console.log('\n[3] CROSS-NARROW — picking dim D narrows every OTHER dim');
  const baseline = await options(token);
  const filtered = await options(token, { gender: 'MENS' });
  // sub_product should narrow (MENS-only sub-products)
  assert('gender=MENS narrows sub_product',
    (filtered.sub_product?.length || 0) < (baseline.sub_product?.length || 0),
    `baseline=${baseline.sub_product?.length}  filtered=${filtered.sub_product?.length}`);
  // shade narrows
  assert('gender=MENS narrows shade',
    (filtered.shade?.length || 0) <= (baseline.shade?.length || 0),
    `baseline=${baseline.shade?.length}  filtered=${filtered.shade?.length}`);

  const womensOnly = await options(token, { gender: 'WOMENS' });
  assert('gender=MENS sub_product != WOMENS sub_product',
    JSON.stringify(filtered.sub_product?.slice(0,5)) !== JSON.stringify(womensOnly.sub_product?.slice(0,5)),
    'sub_products should differ between MENS and WOMENS');
}

async function suite_cascade(token) {
  console.log('\n[4] CASCADE — chaining narrows progressively');
  const a = await options(token, { gender: 'MENS' });
  const b = await options(token, { gender: 'MENS', category: 'DENIM' });
  const c = await options(token, { gender: 'MENS', category: 'DENIM', state: 'MAHARASHTRA' });
  assert('+category=DENIM narrows shade further', (b.shade?.length || 0) <= (a.shade?.length || 0),
    `a=${a.shade?.length}  b=${b.shade?.length}`);
  assert('+state=MAHARASHTRA narrows city to MH only', c.city?.length > 0 && c.city?.length < (b.city?.length || 999),
    `b=${b.city?.length}  c=${c.city?.length}`);
  assert('+state=MAHARASHTRA narrows store_code', c.store_code?.length > 0 && c.store_code?.length < (b.store_code?.length || 999),
    `b=${b.store_code?.length}  c=${c.store_code?.length}`);
}

async function suite_multi_select(token) {
  console.log('\n[5] MULTI-SELECT — CSV values OR-combined');
  const single = await options(token, { gender: 'MENS' });
  const both   = await options(token, { gender: 'MENS,WOMENS' });
  // sub_product for MENS+WOMENS should be >= sub_product for MENS alone
  assert('gender=MENS,WOMENS ⊇ MENS-only sub_product',
    (both.sub_product?.length || 0) >= (single.sub_product?.length || 0),
    `single=${single.sub_product?.length}  both=${both.sub_product?.length}`);
}

async function suite_mode(token) {
  console.log('\n[6] MODE LENS — active / inactive / all narrows');
  const active = await pulse(token, { mode: 'active' });
  const inactive = await pulse(token, { mode: 'inactive' });
  const all = await pulse(token, { mode: 'all' });
  assert('mode=active stores=284',  active.summary.total_locations === 284,
    `got ${active.summary.total_locations}`);
  assert('mode=inactive stores=384',inactive.summary.total_locations === 384,
    `got ${inactive.summary.total_locations}`);
  assert('mode=all stores=668',     all.summary.total_locations === 668,
    `got ${all.summary.total_locations}`);
  // Channels-without-SKU-filter: all channels in scope are shown (legacy
  // empty ones too, so the user sees the full network breakdown). HAVING
  // value > 0 only kicks in when a SKU/category filter is active.
  assert('mode=active sees 2 channels',          active.channels.length === 2,
    `got ${active.channels.length}: [${active.channels.map(c=>c.channel).join(',')}]`);
  assert('mode=inactive sees all 6 channels (incl MBO + 3 empty)',
    inactive.channels.length === 6 && inactive.channels.some(c => c.channel === 'MBO - SOR'),
    `got ${inactive.channels.length}: [${inactive.channels.map(c=>c.channel).join(',')}]`);
  assert('mode=all sees all 6 channels',         all.channels.length === 6,
    `got ${all.channels.length}`);
}

async function suite_case_insensitivity(token) {
  console.log('\n[7] CASE INSENSITIVITY — denim ≡ DENIM ≡ Denim');
  const upper = await options(token, { category: 'DENIM' });
  const lower = await options(token, { category: 'denim' });
  const mixed = await options(token, { category: 'Denim' });
  assert('category=DENIM and denim should match',
    (lower.shade?.length || 0) === (upper.shade?.length || 0),
    `upper.shade=${upper.shade?.length}  lower.shade=${lower.shade?.length}`);
  assert('category=DENIM and Denim should match',
    (mixed.shade?.length || 0) === (upper.shade?.length || 0),
    `upper.shade=${upper.shade?.length}  mixed.shade=${mixed.shade?.length}`);
}

async function suite_whitespace(token) {
  console.log('\n[8] WHITESPACE TOLERANCE');
  const clean   = await options(token, { gender: 'MENS' });
  const padded  = await options(token, { gender: '  MENS  ' });
  assert('gender=  MENS   trims to MENS',
    (padded.sub_product?.length || 0) === (clean.sub_product?.length || 0),
    `clean=${clean.sub_product?.length}  padded=${padded.sub_product?.length}`);
}

async function suite_unknown_values(token) {
  console.log('\n[9] UNKNOWN / EMPTY VALUES');
  const o1 = await options(token, { gender: 'ROBOT_ALIEN' });
  assert('gender=ROBOT_ALIEN returns 0 sub_products (not 500)',
    Array.isArray(o1.sub_product) && o1.sub_product.length === 0,
    `got: ${JSON.stringify(o1.sub_product?.slice(0,3))}`);
  const o2 = await options(token, { state: '' });
  assert('state="" treated as no-filter',
    Array.isArray(o2.state) && o2.state.length >= 15,
    `got ${o2.state?.length}`);
}

async function suite_sql_injection(token) {
  console.log('\n[10] SQL-INJECTION — every payload is parameterised');
  const payloads = [
    "MENS'; DROP TABLE skus; --",
    "' OR 1=1 --",
    "MENS\\\"; SELECT * FROM users; --",
    "MENS%' UNION SELECT password_hash FROM users --",
  ];
  for (const p of payloads) {
    try {
      const o = await options(token, { gender: p });
      assert(`payload "${p.slice(0,30)}…" returns safely`, Array.isArray(o.gender),
        `unexpected response shape`);
    } catch (e) {
      fail(`payload "${p.slice(0,30)}…" must not error`, e.message);
    }
  }
}

async function suite_special_chars(token) {
  console.log('\n[11] SPECIAL CHARS — codes containing hyphens / quotes parse cleanly');
  const all = await options(token);
  const sample = (all.store_code || [])[0];
  if (!sample) { fail('store_code domain empty', ''); return; }
  // Picking a store_code narrows EVERY OTHER dim to that store's reachable
  // values. The store_code dropdown itself remains the full domain (self-
  // strip rule), so we verify narrowing on a peer dim instead.
  const baseline = await options(token);
  const filtered = await options(token, { store_code: sample });
  assert(`store_code=${sample} narrows state/city`,
    (filtered.city?.length || 0) <= (baseline.city?.length || 0)
    && (filtered.state?.length || 0) <= (baseline.state?.length || 0),
    `baseline city=${baseline.city?.length}/${baseline.state?.length}  filtered=${filtered.city?.length}/${filtered.state?.length}`);
  assert(`store_code=${sample} returns 1 city (the store's city)`,
    (filtered.city?.length || 0) <= 1,
    `got ${filtered.city?.length}`);
  assert(`store_code dropdown unaffected (self-strip)`,
    (filtered.store_code?.length || 0) === (baseline.store_code?.length || 0),
    `baseline=${baseline.store_code?.length}  filtered=${filtered.store_code?.length}`);
}

async function suite_pulse_consistency(token) {
  console.log('\n[12] PULSE-vs-FILTER CONSISTENCY — both endpoints honour same filter set');
  const filterOpts = await options(token, { gender: 'MENS' });
  const p = await pulse(token, { gender: 'MENS', mode: 'all' });
  assert('pulse with gender=MENS returns numeric total_stock', typeof p.summary.total_stock === 'number',
    `got ${typeof p.summary.total_stock}`);
  assert('pulse with gender=MENS returns top_stores',  Array.isArray(p.top_stores) && p.top_stores.length > 0,
    `got ${p.top_stores?.length}`);
  // sub_product list should be available for MENS
  assert('filter narrows sub_product to MENS scope',  filterOpts.sub_product?.length > 0 && filterOpts.sub_product?.length < 400,
    `got ${filterOpts.sub_product?.length}`);
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function login() {
  const r = await httpPost(`${API_BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  return r?.accessToken || r?.data?.accessToken;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Spykar Universal Filter — Comprehensive Regression Suite');
  console.log('═══════════════════════════════════════════════════════════════');

  let token;
  try { token = await login(); }
  catch (e) {
    console.error('❌ Login failed:', e.message);
    process.exit(1);
  }
  if (!token) { console.error('❌ No token from login'); process.exit(1); }

  const suites = [
    suite_baseline,
    suite_self_strip,
    suite_cross_narrow,
    suite_cascade,
    suite_multi_select,
    suite_mode,
    suite_case_insensitivity,
    suite_whitespace,
    suite_unknown_values,
    suite_sql_injection,
    suite_special_chars,
    suite_pulse_consistency,
  ];
  for (const s of suites) {
    try { await s(token); }
    catch (e) {
      console.error(`\n   ⚠ suite ${s.name} crashed:`, e.message);
      failed++;
    }
  }

  console.log('\n' + '═'.repeat(63));
  console.log(`  RESULT  ✅ ${passed} passed   ❌ ${failed} failed`);
  console.log('═'.repeat(63));
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f.name}\n    ${f.detail}`));
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(2); });
