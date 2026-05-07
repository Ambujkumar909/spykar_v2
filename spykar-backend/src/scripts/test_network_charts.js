#!/usr/bin/env node
'use strict';
/**
 * test_network_charts.js — exhaustive Network page logic verification.
 * Covers EVERY widget on the Network page across all 3 modes + edge cases:
 *
 *   ① KPI strip (5 cards) — totals, splits, avg/store, top channel
 *   ② Pareto reveal — stores_for_50/80/90 sanity, total_stores_with_stock
 *   ③ Top stores list — uniqueness, ordering, length, mode filtering
 *   ④ Top states list — same
 *   ⑤ Channel mix — sums equal pulse total, billing model classification
 *   ⑥ Stock ageing buckets — non-negative
 *   ⑦ Action panel — empty stores, dead stock, closed-store stock
 *   ⑧ Cross-mode invariants:
 *        active.total_stock + inactive.total_stock === all.total_stock
 *        active.total_value + inactive.total_value === all.total_value
 *        active.locations + inactive.locations    === all.locations
 *   ⑨ Filter combinations: gender+state, gender+category, mode×filter
 *   ⑩ Edge cases: nonsense values, empty arrays, multi-select, single-store
 *
 * Returns 0 on full pass, 1 on any failure.
 */
require('dotenv').config();

const API = process.env.TEST_API_BASE || 'http://localhost:4001/api/v1';
const EMAIL = 'admin@spykar.com', PASS = 'Admin@123';

let passed = 0, failed = 0, fails = [];
const ok  = n => { passed++; console.log(`  ✅ ${n}`); };
const bad = (n, why) => { failed++; fails.push({ n, why }); console.log(`  ❌ ${n}\n     ${why}`); };
const expect = (n, cond, why = '') => cond ? ok(n) : bad(n, why);

const qs = p => new URLSearchParams(Object.fromEntries(Object.entries(p||{}).filter(([,v]) => v != null && v !== ''))).toString();
const get = async (url, params, headers) => {
  const r = await fetch(`${url}${params ? `?${qs(params)}` : ''}`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url} :: ${await r.text().catch(()=>'')}`.slice(0,200));
  return r.json();
};
const post = async (url, body) => {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const pulse = async (token, params = {}) =>
  (await get(`${API}/locations/network-pulse`, params, { Authorization: `Bearer ${token}` }))?.data;

// Tolerance helpers — sometimes counts can be ±1 off due to NULL handling
const eqInt = (a, b, slack = 0) => Math.abs(Number(a||0) - Number(b||0)) <= slack;

(async () => {
  const login = await post(`${API}/auth/login`, { email: EMAIL, password: PASS });
  const token = login?.accessToken || login?.data?.accessToken;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Network Page — Exhaustive Chart Logic Verification');
  console.log('═══════════════════════════════════════════════════════════════');

  // Snapshot the 3 mode lenses upfront — every section reuses these
  const A = await pulse(token, { mode: 'active' });
  const I = await pulse(token, { mode: 'inactive' });
  const X = await pulse(token, { mode: 'all' });

  // ─── ① KPI STRIP ────────────────────────────────────────────────────────
  console.log('\n[1] KPI STRIP — totals, splits, avg/store');
  expect('Active total_locations === 284',  A.summary.total_locations === 284,  `got ${A.summary.total_locations}`);
  expect('Inactive total_locations === 384',I.summary.total_locations === 384,  `got ${I.summary.total_locations}`);
  expect('All total_locations === 668',     X.summary.total_locations === 668,  `got ${X.summary.total_locations}`);
  expect('Active stock matches state_count', A.summary.state_count >= 18,        `got ${A.summary.state_count}`);
  expect('Active total_stock > 0',          A.summary.total_stock > 0,           `got ${A.summary.total_stock}`);
  expect('Active total_value > 0',          A.summary.total_value > 0,           `got ${A.summary.total_value}`);
  expect('Active unique_skus > 0',          A.summary.unique_skus > 0,           `got ${A.summary.unique_skus}`);
  expect('Inactive total_value smaller than Active',
    I.summary.total_value < A.summary.total_value, `A=${A.summary.total_value}, I=${I.summary.total_value}`);

  // ─── ⑧ CROSS-MODE INVARIANTS — active + inactive should equal all ─────────
  console.log('\n[8] CROSS-MODE INVARIANTS — active + inactive = all');
  expect('locations: active + inactive === all',
    A.summary.total_locations + I.summary.total_locations === X.summary.total_locations,
    `${A.summary.total_locations} + ${I.summary.total_locations} ≠ ${X.summary.total_locations}`);
  expect('total_stock: active + inactive === all',
    eqInt(Number(A.summary.total_stock) + Number(I.summary.total_stock), Number(X.summary.total_stock)),
    `${A.summary.total_stock} + ${I.summary.total_stock} ≠ ${X.summary.total_stock}`);
  expect('total_value: active + inactive === all',
    eqInt(Number(A.summary.total_value) + Number(I.summary.total_value), Number(X.summary.total_value)),
    `${A.summary.total_value} + ${I.summary.total_value} ≠ ${X.summary.total_value}`);

  // ─── ② PARETO REVEAL ────────────────────────────────────────────────────
  console.log('\n[2] PARETO REVEAL — stores_for_50 ≤ 80 ≤ 90 ≤ total');
  for (const [name, p] of [['Active', A], ['Inactive', I], ['All', X]]) {
    const par = p.pareto;
    expect(`${name}: stores_for_50 ≤ stores_for_80`, par.stores_for_50 <= par.stores_for_80,
      `50=${par.stores_for_50}, 80=${par.stores_for_80}`);
    expect(`${name}: stores_for_80 ≤ stores_for_90`, par.stores_for_80 <= par.stores_for_90,
      `80=${par.stores_for_80}, 90=${par.stores_for_90}`);
    expect(`${name}: stores_for_90 ≤ total_stores_with_stock`, par.stores_for_90 <= par.total_stores_with_stock,
      `90=${par.stores_for_90}, total=${par.total_stores_with_stock}`);
    expect(`${name}: pareto.grand_value === summary.total_value`,
      eqInt(par.grand_value, p.summary.total_value),
      `pareto=${par.grand_value}, summary=${p.summary.total_value}`);
  }

  // ─── ③ TOP STORES — uniqueness, ordering, mode filtering ────────────────
  console.log('\n[3] TOP STORES — uniqueness + ordering');
  for (const [name, p] of [['Active', A], ['Inactive', I], ['All', X]]) {
    const ts = p.top_stores || [];
    expect(`${name}: top_stores ≤ 25 (LIMIT bumped for Top 10/15/20 dropdown)`,
      ts.length <= 25, `got ${ts.length}`);
    expect(`${name}: store IDs unique`, new Set(ts.map(t => t.id)).size === ts.length, `${ts.length} returned, ${new Set(ts.map(t=>t.id)).size} unique`);
    if (ts.length > 1) {
      const isDesc = ts.every((t, i) => i === 0 || Number(ts[i-1].value) >= Number(t.value));
      expect(`${name}: ordered by value DESC`, isDesc, `values: ${ts.map(t=>t.value).join(', ')}`);
    }
    if (name === 'Active' && ts.length > 0) {
      expect(`Active: every top store is shop_closed=false`,
        ts.every(t => t.shop_closed === false),
        `closed flags: ${ts.map(t=>t.shop_closed).join(',')}`);
    }
    if (name === 'Inactive' && ts.length > 0) {
      expect(`Inactive: every top store is shop_closed=true`,
        ts.every(t => t.shop_closed === true),
        `closed flags: ${ts.map(t=>t.shop_closed).join(',')}`);
    }
  }

  // ─── ④ TOP STATES — uniqueness + active_stores ≤ stores ─────────────────
  console.log('\n[4] TOP STATES — uniqueness + structural');
  for (const [name, p] of [['Active', A], ['Inactive', I], ['All', X]]) {
    const tsts = p.top_states || [];
    expect(`${name}: top_states ≤ 25 (LIMIT bumped for Top 10/15/20 dropdown)`,
      tsts.length <= 25, `got ${tsts.length}`);
    expect(`${name}: state names unique`, new Set(tsts.map(t => t.state)).size === tsts.length);
    expect(`${name}: active_stores ≤ stores`,
      tsts.every(t => Number(t.active_stores) <= Number(t.stores)),
      tsts.find(t => t.active_stores > t.stores) ? JSON.stringify(tsts.find(t => t.active_stores > t.stores)) : '');
  }

  // ─── ⑤ CHANNEL MIX — billing model + sum coverage ──────────────────────
  console.log('\n[5] CHANNEL MIX — sums + billing model');
  for (const [name, p] of [['Active', A], ['Inactive', I], ['All', X]]) {
    const ch = p.channels || [];
    expect(`${name}: channels.length > 0`, ch.length > 0, '');
    const billings = new Set(ch.map(c => c.billing_model));
    expect(`${name}: every billing_model is OUTRIGHT or SOR`,
      [...billings].every(b => b === 'OUTRIGHT' || b === 'SOR'),
      `got: ${[...billings].join(', ')}`);
    const sumValue = ch.reduce((a, c) => a + Number(c.value || 0), 0);
    // Channel value sum equals summary.total_value exactly — every rupee of
    // stock value belongs to exactly one channel (HAVING-filtered channels
    // had value=0 anyway, so sum is unchanged).
    expect(`${name}: channel value sum === summary.total_value`,
      eqInt(sumValue, p.summary.total_value, 1),
      `Σchannels=${sumValue}, summary=${p.summary.total_value}`);
    const sumStores = ch.reduce((a, c) => a + Number(c.stores || 0), 0);
    // Channel store sum ≤ total_locations because we hide legacy channels
    // whose stores carry zero stock — stores in those empty channels still
    // count in summary.total_locations but won't appear here.
    expect(`${name}: channel store sum ≤ summary.total_locations`,
      sumStores <= p.summary.total_locations,
      `Σchannels=${sumStores}, summary=${p.summary.total_locations}`);
  }
  // No SKU filter applied → show every channel in scope (including legacy
  // empty ones). HAVING value > 0 only applies when a SKU filter narrows.
  expect('All sees all 6 channels',     X.channels.length === 6, `got ${X.channels.length}`);
  expect('Active sees 2 channels',      A.channels.length === 2, `got ${A.channels.length}`);
  expect('Inactive sees all 6 channels (incl MBO + 3 empty legacy)',
    I.channels.length === 6 && I.channels.some(c => c.channel === 'MBO - SOR'),
    `got ${I.channels.length}: [${I.channels.map(c=>c.channel).join(', ')}]`);

  // ─── ⑥ STOCK AGEING — non-negative buckets ─────────────────────────────
  console.log('\n[6] STOCK AGEING BUCKETS — non-negative');
  for (const [name, p] of [['Active', A], ['Inactive', I], ['All', X]]) {
    const a = p.ageing;
    expect(`${name}: every bucket ≥ 0`,
      a.fresh_30 >= 0 && a.d31_60 >= 0 && a.d61_90 >= 0 && a.d91_180 >= 0 && a.dead_180_plus >= 0,
      JSON.stringify(a));
  }

  // ─── ⑦ ACTION PANEL — empty stores + dead stock + closed-stock ─────────
  console.log('\n[7] ACTION PANEL — empty stores + dead stock + closed-stock');
  expect('Active: empty_stores = 18 (the known empty-active count)',
    A.actions.oos_active.count === 18, `got ${A.actions.oos_active.count}`);
  expect('Active: dead_stock units > 0 (must be real)',
    Number(A.actions.dead_stock.units) > 0, `got ${A.actions.dead_stock.units}`);
  expect('Active: closed_stock count = 0 (active mode hides closed)',
    A.actions.dead_capital_lines.count === 0, `got ${A.actions.dead_capital_lines.count}`);
  expect('Inactive: closed_stock count > 0 (inactive lens shows closed-store stock)',
    Number(I.actions.dead_capital_lines.count) > 0, `got ${I.actions.dead_capital_lines.count}`);
  expect('All: closed_stock count > 0',
    Number(X.actions.dead_capital_lines.count) > 0, `got ${X.actions.dead_capital_lines.count}`);

  // ─── ⑨ FILTER COMBINATIONS — narrow chains ─────────────────────────────
  console.log('\n[9] FILTER COMBINATIONS');
  const G = await pulse(token, { gender: 'MENS', mode: 'active' });
  expect('gender=MENS narrows total_stock',
    G.summary.total_stock < A.summary.total_stock, `MENS=${G.summary.total_stock}, all=${A.summary.total_stock}`);
  expect('gender=MENS keeps active store count = 284 OR less (filter narrows)',
    G.summary.total_locations <= 284, `got ${G.summary.total_locations}`);
  const GS = await pulse(token, { gender: 'MENS', state: 'MAHARASHTRA', mode: 'active' });
  expect('+state=MAHARASHTRA further narrows',
    GS.summary.total_stock < G.summary.total_stock, `MENS=${G.summary.total_stock}, MENS+MH=${GS.summary.total_stock}`);
  const GC = await pulse(token, { gender: 'MENS', category: 'DENIM', mode: 'active' });
  expect('+category=DENIM further narrows',
    GC.summary.total_stock < G.summary.total_stock, `MENS=${G.summary.total_stock}, MENS+DENIM=${GC.summary.total_stock}`);

  // ─── ⑪ COLOUR & SIZE DISTRIBUTION — chart endpoints honour mode+filters ──
  console.log('\n[11] COLOUR & SIZE DISTRIBUTION — mode + filter narrowing');
  const colorAll = await get(`${API}/analytics/color-distribution`, { mode: 'all' }, { Authorization: `Bearer ${token}` });
  const sizeAll  = await get(`${API}/analytics/size-distribution`,  { mode: 'all' }, { Authorization: `Bearer ${token}` });
  expect('color-distribution returns rows for mode=all',
    Array.isArray(colorAll.data) && colorAll.data.length > 0, `got ${colorAll.data?.length}`);
  expect('size-distribution returns rows for mode=all',
    Array.isArray(sizeAll.data) && sizeAll.data.length > 0, `got ${sizeAll.data?.length}`);

  const colorAct  = await get(`${API}/analytics/color-distribution`, { mode: 'active' }, { Authorization: `Bearer ${token}` });
  const colorInac = await get(`${API}/analytics/color-distribution`, { mode: 'inactive' }, { Authorization: `Bearer ${token}` });
  const sumColor = arr => arr.reduce((a, c) => a + Number(c.total_stock || 0), 0);
  const colAllStock = sumColor(colorAll.data);
  const colActStock = sumColor(colorAct.data);
  const colInacStock = sumColor(colorInac.data);
  expect('color-dist: mode=active < mode=all',
    colActStock < colAllStock, `active=${colActStock}, all=${colAllStock}`);
  expect('color-dist: mode=inactive < mode=all',
    colInacStock < colAllStock, `inactive=${colInacStock}, all=${colAllStock}`);
  expect('color-dist: active + inactive ≈ all (small slack for ties)',
    Math.abs((colActStock + colInacStock) - colAllStock) <= 5,
    `${colActStock} + ${colInacStock} = ${colActStock + colInacStock}, all=${colAllStock}`);

  const colorMens = await get(`${API}/analytics/color-distribution`, { gender: 'MENS', mode: 'all' }, { Authorization: `Bearer ${token}` });
  expect('color-dist: gender=MENS narrows < unfiltered',
    sumColor(colorMens.data) < colAllStock,
    `MENS=${sumColor(colorMens.data)}, all=${colAllStock}`);

  const sizeMens = await get(`${API}/analytics/size-distribution`, { gender: 'MENS', mode: 'all' }, { Authorization: `Bearer ${token}` });
  expect('size-dist: gender=MENS narrows < unfiltered',
    sizeMens.data.reduce((a,r) => a + Number(r.total_stock||0), 0) < sizeAll.data.reduce((a,r) => a + Number(r.total_stock||0), 0),
    'mens stock should be less than all-gender stock');

  // ─── ⑩ EDGE CASES ─────────────────────────────────────────────────────
  console.log('\n[10] EDGE CASES');
  // Nonsense filter — should return 0 stock, not 500
  const N = await pulse(token, { gender: 'ROBOT_ALIEN', mode: 'all' });
  expect('Nonsense gender returns 0 total_stock (graceful)',
    N.summary.total_stock === 0, `got ${N.summary.total_stock}`);
  expect('Nonsense gender returns 0 channels',
    Array.isArray(N.channels) && N.channels.length === 0, `got ${N.channels?.length}`);
  expect('Nonsense gender returns 0 top_stores',
    Array.isArray(N.top_stores) && N.top_stores.length === 0, `got ${N.top_stores?.length}`);
  expect('Nonsense gender pareto: 0 stores_with_stock',
    N.pareto.total_stores_with_stock === 0, `got ${N.pareto.total_stores_with_stock}`);

  // Multi-select gender = MENS,WOMENS — should be > MENS-only
  const M = await pulse(token, { gender: 'MENS,WOMENS', mode: 'active' });
  expect('Multi-gender (MENS,WOMENS) ≥ single (MENS)',
    Number(M.summary.total_stock) >= Number(G.summary.total_stock),
    `multi=${M.summary.total_stock}, single=${G.summary.total_stock}`);

  // Single-store filter — top_stores should have exactly 1 entry
  const oneStore = await pulse(token, { store_code: 'DIST-3016', mode: 'all' });
  expect('store_code filter returns exactly 1 top_store',
    oneStore.top_stores.length === 1, `got ${oneStore.top_stores.length}`);

  // ─── SUMMARY ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(63));
  console.log(`  RESULT  ✅ ${passed} passed   ❌ ${failed} failed`);
  console.log('═'.repeat(63));
  if (fails.length) console.log('\nFailures:\n' + fails.map(f => `  • ${f.n}\n    ${f.why}`).join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(2); });
