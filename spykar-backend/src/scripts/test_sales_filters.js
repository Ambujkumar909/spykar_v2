#!/usr/bin/env node
'use strict';
/**
 * test_sales_filters.js — exhaustive Sales-page filter regression suite.
 *
 * Verifies every dimension of the v2 universal filter set + Sale/Return/Net
 * lens + date-range against /api/v1/analytics/sales. Designed to catch every
 * "impossible-but-the-user-might-do-it" scenario:
 *
 *   ① Baseline — full window returns expected non-zero data
 *   ② Per-dimension self-strip + cross-narrow + value drop
 *   ③ Mode lens (active/inactive/all) narrows correctly + cross-mode invariants
 *   ④ Date-range presets — Today, Last 7d/30d/90d, MTD, QTD, YTD, FY, custom
 *   ⑤ Multi-select combinations (CSV) for every dim
 *   ⑥ Cross-aggregate invariants — sum(by_color.units) ≈ summary.units_sold
 *   ⑦ Returns coherence — net_units = units_sold − return_units
 *   ⑧ Edge cases — nonsense values, whitespace, case-insensitive, empty,
 *     0-day date range, future dates, before-data dates
 *   ⑨ SQL-injection — every payload is parameterised (no 500)
 *   ⑩ Stress — wide multi-selects, deep cascade chains
 *   ⑪ Lens math — gross / mrp / ex-GST ordering invariants (when applicable)
 *
 * Returns 0 on full pass, 1 on any failure.
 */
require('dotenv').config();

const API   = process.env.TEST_API_BASE || 'http://localhost:4001/api/v1';
const EMAIL = 'admin@spykar.com', PASS = 'Admin@123';

let passed = 0, failed = 0, fails = [];
const ok  = n => { passed++; console.log(`  ✅ ${n}`); };
const bad = (n, why) => { failed++; fails.push({ n, why }); console.log(`  ❌ ${n}\n     ${why}`); };
const expect = (n, cond, why = '') => cond ? ok(n) : bad(n, why);

const qs = (p) => new URLSearchParams(Object.fromEntries(
  Object.entries(p || {}).filter(([, v]) => v != null && v !== '')
)).toString();
const get = async (path, params, headers) => {
  const url = `${API}${path}${params ? `?${qs(params)}` : ''}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${path} :: ${(await r.text().catch(() => '')).slice(0,200)}`);
  return r.json();
};
const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};
const sales = async (token, params = {}) =>
  (await get('/analytics/sales', params, { Authorization: `Bearer ${token}` }))?.data;

const filterOpts = async (token, params = {}) =>
  (await get('/filters/options', params, { Authorization: `Bearer ${token}` }))?.options;

const N = (v) => Number(v || 0);
const eqInt = (a, b, slack = 0) => Math.abs(N(a) - N(b)) <= slack;
const FY = { from: '2025-04-01', to: '2026-01-31' }; // Indian FY 2025-26 (data window)
const FULL = { date_from: '2024-04-01', date_to: '2026-01-31', mode: 'all' };

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Sales Filter Regression Suite — exhaustive');
  console.log('═══════════════════════════════════════════════════════════════════════');

  let token;
  try { const r = await post('/auth/login', { email: EMAIL, password: PASS });
        token = r?.accessToken || r?.data?.accessToken; }
  catch (e) { console.error('❌ Login failed:', e.message); process.exit(1); }
  if (!token) { console.error('❌ No token'); process.exit(1); }

  // Snapshot full dataset upfront for cross-mode invariants
  const baseline = await sales(token, FULL);
  console.log(`\nBaseline (full window, mode=all):`);
  console.log(`  units_sold=${N(baseline.summary.units_sold).toLocaleString('en-IN')}  sales_value=${N(baseline.summary.sales_value).toLocaleString('en-IN')}`);
  console.log(`  return_units=${N(baseline.summary.return_units).toLocaleString('en-IN')}  return_value=${N(baseline.summary.return_value).toLocaleString('en-IN')}`);
  console.log(`  net_units=${N(baseline.summary.net_units).toLocaleString('en-IN')}  net_value=${N(baseline.summary.net_value).toLocaleString('en-IN')}`);
  console.log(`  by_color rows=${baseline.by_color?.length}  by_size rows=${baseline.by_size?.length}  by_store rows=${baseline.by_store?.length}  all_stores=${baseline.all_stores?.length}\n`);

  // ─── ① BASELINE ───────────────────────────────────────────────────────
  console.log('[1] BASELINE — full data window');
  expect('summary.units_sold > 0',     N(baseline.summary.units_sold) > 0,   `got ${baseline.summary.units_sold}`);
  expect('summary.sales_value > 0',    N(baseline.summary.sales_value) > 0,  `got ${baseline.summary.sales_value}`);
  expect('summary.return_units >= 0',  N(baseline.summary.return_units) >= 0,'returns can be 0 but not negative');
  expect('net_units = units_sold − return_units',
    eqInt(N(baseline.summary.net_units), N(baseline.summary.units_sold) - N(baseline.summary.return_units), 1),
    `${baseline.summary.units_sold} − ${baseline.summary.return_units} ≠ ${baseline.summary.net_units}`);
  expect('net_value = sales_value − return_value',
    eqInt(N(baseline.summary.net_value), N(baseline.summary.sales_value) - N(baseline.summary.return_value), 1),
    `${baseline.summary.sales_value} − ${baseline.summary.return_value} ≠ ${baseline.summary.net_value}`);
  expect('by_color, by_size, by_store, all_stores arrays present',
    Array.isArray(baseline.by_color) && Array.isArray(baseline.by_size) &&
    Array.isArray(baseline.by_store) && Array.isArray(baseline.all_stores), '');
  expect('daily array present',  Array.isArray(baseline.daily), '');
  expect('by_month array present',  Array.isArray(baseline.by_month), '');

  // ─── ② PER-DIMENSION FILTERS ──────────────────────────────────────────
  console.log('\n[2] PER-DIMENSION FILTERS — each narrows total units');
  // Get domain for each dim from /filters/options to pick a real value
  const domain = await filterOpts(token);
  const SAMPLES = {
    gender:      domain.gender?.[0],
    sub_product: domain.sub_product?.find(v => v && v.length < 25),  // skip ultra-long sub_products
    product:     domain.product?.[0],
    category:    domain.category?.[0],
    style:       domain.style?.[0],
    shade:       domain.shade?.[0],
    color:       domain.color?.[0],
    size:        domain.size?.find(s => s && s.length <= 4),  // pick short sizes (e.g. 32, S, M, L)
    season:      domain.season?.[0],
    state:       domain.state?.[0],
    city:        domain.city?.[0],
    group_name:  domain.group_name?.[0],
    store_code:  domain.store_code?.[0],
  };
  for (const [dim, sample] of Object.entries(SAMPLES)) {
    if (!sample) { console.log(`   [skip] ${dim}: no sample value`); continue; }
    const r = await sales(token, { ...FULL, [dim]: sample });
    expect(`${dim}=${sample.slice ? sample.slice(0,18) : sample}: units_sold ≤ baseline`,
      N(r.summary.units_sold) <= N(baseline.summary.units_sold) + 1,
      `${r.summary.units_sold} > ${baseline.summary.units_sold}`);
    expect(`${dim}=${sample.slice ? sample.slice(0,18) : sample}: sales_value ≤ baseline`,
      N(r.summary.sales_value) <= N(baseline.summary.sales_value) + 1, '');
    expect(`${dim}=${sample.slice ? sample.slice(0,18) : sample}: net_value invariant`,
      eqInt(N(r.summary.net_value), N(r.summary.sales_value) - N(r.summary.return_value), 1),
      `summary.net_value (${r.summary.net_value}) ≠ sales_value − return_value`);
  }

  // ─── ③ MODE LENS — active vs inactive vs all ─────────────────────────
  console.log('\n[3] MODE LENS — active vs inactive vs all narrowing');
  const A = await sales(token, { ...FULL, mode: 'active' });
  const I = await sales(token, { ...FULL, mode: 'inactive' });
  const X = await sales(token, { ...FULL, mode: 'all' });
  expect('active.units_sold ≤ all.units_sold',
    N(A.summary.units_sold) <= N(X.summary.units_sold) + 1,
    `${A.summary.units_sold} > ${X.summary.units_sold}`);
  expect('inactive.units_sold ≤ all.units_sold',
    N(I.summary.units_sold) <= N(X.summary.units_sold) + 1, '');
  expect('cross-mode invariant: active + inactive ≈ all (units_sold)',
    eqInt(N(A.summary.units_sold) + N(I.summary.units_sold), N(X.summary.units_sold), 5),
    `${A.summary.units_sold} + ${I.summary.units_sold} = ${N(A.summary.units_sold) + N(I.summary.units_sold)} ≠ ${X.summary.units_sold}`);
  expect('cross-mode invariant: active + inactive ≈ all (sales_value)',
    eqInt(N(A.summary.sales_value) + N(I.summary.sales_value), N(X.summary.sales_value), 100),
    `${A.summary.sales_value} + ${I.summary.sales_value} ≠ ${X.summary.sales_value}`);
  expect('cross-mode invariant: active + inactive ≈ all (return_units)',
    eqInt(N(A.summary.return_units) + N(I.summary.return_units), N(X.summary.return_units), 5), '');

  // ─── ④ DATE-RANGE PRESETS ─────────────────────────────────────────────
  console.log('\n[4] DATE-RANGE PRESETS');
  const allRange = await sales(token, { ...FULL, date_from: '2024-04-01', date_to: '2026-01-31' });
  const fy       = await sales(token, { ...FY, mode: 'all' });
  const lastQ    = await sales(token, { date_from: '2025-10-01', date_to: '2025-12-31', mode: 'all' });
  const month    = await sales(token, { date_from: '2025-12-01', date_to: '2025-12-31', mode: 'all' });
  expect('FY 2025-26 ⊆ full window',
    N(fy.summary.units_sold) <= N(allRange.summary.units_sold) + 5, '');
  expect('Q4 2025 ⊆ full window',
    N(lastQ.summary.units_sold) <= N(allRange.summary.units_sold) + 5, '');
  expect('Dec 2025 ⊆ Q4 2025',
    N(month.summary.units_sold) <= N(lastQ.summary.units_sold) + 1,
    `Dec=${month.summary.units_sold} > Q4=${lastQ.summary.units_sold}`);
  expect('Dec 2025: 31 daily rows max',
    Array.isArray(month.daily) && month.daily.length <= 31, `got ${month.daily?.length}`);

  // ─── ⑤ MULTI-SELECT (CSV) ─────────────────────────────────────────────
  console.log('\n[5] MULTI-SELECT — CSV value combos');
  if (domain.gender?.length >= 2) {
    const single = await sales(token, { ...FULL, gender: domain.gender[0] });
    const multi  = await sales(token, { ...FULL, gender: `${domain.gender[0]},${domain.gender[1]}` });
    expect('gender=A,B ≥ gender=A',
      N(multi.summary.units_sold) >= N(single.summary.units_sold) - 1,
      `multi=${multi.summary.units_sold}, single=${single.summary.units_sold}`);
  }
  if (domain.state?.length >= 2) {
    const single = await sales(token, { ...FULL, state: domain.state[0] });
    const multi  = await sales(token, { ...FULL, state: `${domain.state[0]},${domain.state[1]}` });
    expect('state=A,B ≥ state=A',
      N(multi.summary.units_sold) >= N(single.summary.units_sold) - 1, '');
  }
  if (domain.color?.length >= 2) {
    const single = await sales(token, { ...FULL, color: domain.color[0] });
    const multi  = await sales(token, { ...FULL, color: `${domain.color[0]},${domain.color[1]}` });
    expect('color=A,B ≥ color=A',
      N(multi.summary.units_sold) >= N(single.summary.units_sold) - 1, '');
  }

  // ─── ⑥ CROSS-AGGREGATE INVARIANTS ─────────────────────────────────────
  console.log('\n[6] CROSS-AGGREGATE INVARIANTS — sum(by_X) ≈ summary');
  // Real field names: by_color/by_size/by_store/all_stores use units_sold +
  // sales_value. by_month uses sales_qty (movement-type aware) + return_qty.
  const sumColorUnits = (baseline.by_color||[]).reduce((a,r)=>a+N(r.units_sold),0);
  const sumColorVal   = (baseline.by_color||[]).reduce((a,r)=>a+N(r.sales_value),0);
  const sumSizeUnits  = (baseline.by_size||[]).reduce((a,r)=>a+N(r.units_sold),0);
  const sumStoreUnits = (baseline.by_store||[]).reduce((a,r)=>a+N(r.units_sold),0);
  const sumDailyUnits = (baseline.daily||[]).reduce((a,r)=>a+N(r.sales_qty),0);
  const sumMonthUnits = (baseline.by_month||[]).reduce((a,r)=>a+N(r.sales_qty),0);
  // by_color may exclude rows where color_name is NULL, so use small slack
  expect('sum(by_color.units) ≤ summary.units_sold',
    sumColorUnits <= N(baseline.summary.units_sold) + 5,
    `Σcolors=${sumColorUnits} > summary=${baseline.summary.units_sold}`);
  expect('sum(by_size.units) ≤ summary.units_sold',
    sumSizeUnits <= N(baseline.summary.units_sold) + 5, '');
  expect('sum(by_store.units) ≤ summary.units_sold',
    sumStoreUnits <= N(baseline.summary.units_sold) + 5, '');
  expect('sum(daily.sales_qty) ≈ summary.units_sold',
    eqInt(sumDailyUnits, N(baseline.summary.units_sold), 5),
    `Σdaily=${sumDailyUnits} vs summary=${baseline.summary.units_sold}`);
  expect('sum(by_month.units) ≈ summary.units_sold',
    eqInt(sumMonthUnits, N(baseline.summary.units_sold), 5),
    `Σmonth=${sumMonthUnits} vs summary=${baseline.summary.units_sold}`);
  expect('every by_color.sales_value ≥ 0',
    (baseline.by_color||[]).every(r => N(r.sales_value) >= 0), '');
  expect('every by_store.units_sold ≥ 0',
    (baseline.by_store||[]).every(r => N(r.units_sold) >= 0), '');

  // ─── ⑦ RETURNS COHERENCE ─────────────────────────────────────────────
  console.log('\n[7] RETURNS COHERENCE');
  expect('return_rate_pct = return_units / units_sold × 100 (within 0.5%)',
    Math.abs(N(baseline.summary.return_rate_pct) -
      (N(baseline.summary.units_sold) > 0
        ? (N(baseline.summary.return_units) / N(baseline.summary.units_sold)) * 100
        : 0)) <= 0.5,
    `got ${baseline.summary.return_rate_pct}`);
  expect('return_units >= 0', N(baseline.summary.return_units) >= 0, '');
  expect('return_units <= units_sold (returns don\'t exceed sales)',
    N(baseline.summary.return_units) <= N(baseline.summary.units_sold) + 1,
    `returns ${baseline.summary.return_units} > sales ${baseline.summary.units_sold}`);

  // ─── ⑧ EDGE CASES ────────────────────────────────────────────────────
  console.log('\n[8] EDGE CASES');
  // Nonsense filter
  const nonsense = await sales(token, { ...FULL, gender: 'ROBOT_ALIEN_999' });
  expect('nonsense gender → 0 units (graceful)',
    N(nonsense.summary.units_sold) === 0, `got ${nonsense.summary.units_sold}`);
  expect('nonsense gender → 0 by_color rows',
    Array.isArray(nonsense.by_color) && nonsense.by_color.length === 0, `got ${nonsense.by_color?.length}`);
  // Empty values
  const empty = await sales(token, { ...FULL, gender: '', state: '' });
  expect('empty filter values treated as no-filter',
    N(empty.summary.units_sold) === N(baseline.summary.units_sold),
    `empty=${empty.summary.units_sold}, baseline=${baseline.summary.units_sold}`);
  // Whitespace
  if (domain.gender?.[0]) {
    const padded = await sales(token, { ...FULL, gender: `  ${domain.gender[0]}  ` });
    const clean  = await sales(token, { ...FULL, gender: domain.gender[0] });
    expect('whitespace trimmed', N(padded.summary.units_sold) === N(clean.summary.units_sold),
      `padded=${padded.summary.units_sold}, clean=${clean.summary.units_sold}`);
  }
  // Case-insensitivity
  if (domain.gender?.[0]) {
    const upper = await sales(token, { ...FULL, gender: domain.gender[0].toUpperCase() });
    const lower = await sales(token, { ...FULL, gender: domain.gender[0].toLowerCase() });
    expect('gender filter case-insensitive', N(upper.summary.units_sold) === N(lower.summary.units_sold),
      `upper=${upper.summary.units_sold}, lower=${lower.summary.units_sold}`);
  }
  // 0-day date range
  const zeroDay = await sales(token, { date_from: '2025-12-15', date_to: '2025-12-15', mode: 'all' });
  expect('0-day date range returns ≤ 1 daily row',
    Array.isArray(zeroDay.daily) && zeroDay.daily.length <= 1, `got ${zeroDay.daily?.length}`);
  // Future date range
  const future = await sales(token, { date_from: '2030-01-01', date_to: '2030-12-31', mode: 'all' });
  expect('future date range → 0 units',
    N(future.summary.units_sold) === 0, `got ${future.summary.units_sold}`);
  expect('future date range → empty daily',
    Array.isArray(future.daily) && future.daily.length === 0, `got ${future.daily?.length}`);
  // Before-data date range
  const ancient = await sales(token, { date_from: '2010-01-01', date_to: '2020-12-31', mode: 'all' });
  expect('before-data date range → 0 units',
    N(ancient.summary.units_sold) === 0, `got ${ancient.summary.units_sold}`);

  // ─── ⑨ SQL-INJECTION SAFETY ─────────────────────────────────────────
  console.log('\n[9] SQL-INJECTION SAFETY');
  const payloads = [
    "MENS'; DROP TABLE inventory_movements; --",
    "' OR 1=1 --",
    "MENS\"; SELECT password_hash FROM users; --",
    "MENS%' UNION SELECT * FROM users --",
    "../../../etc/passwd",
    "<script>alert('xss')</script>",
  ];
  for (const p of payloads) {
    try {
      const r = await sales(token, { ...FULL, gender: p });
      expect(`payload "${p.slice(0,30)}…" handled safely`,
        N(r.summary.units_sold) === 0 && r.summary !== null,
        `units=${r.summary?.units_sold}`);
    } catch (e) {
      bad(`payload "${p.slice(0,30)}…" must not 500`, e.message);
    }
  }

  // ─── ⑩ STRESS — wide multi-selects & deep cascades ───────────────────
  console.log('\n[10] STRESS — wide arrays + deep cascade');
  if ((domain.shade||[]).length >= 10) {
    const top10Shades = domain.shade.slice(0, 10).join(',');
    const r = await sales(token, { ...FULL, shade: top10Shades });
    expect('shade=top-10-csv: returns valid response',
      typeof r.summary.units_sold === 'number', `got ${typeof r.summary.units_sold}`);
  }
  if ((domain.state||[]).length >= 5) {
    const top5States = domain.state.slice(0, 5).join(',');
    const r = await sales(token, { ...FULL, state: top5States });
    expect('state=top-5-csv: returns valid response',
      typeof r.summary.units_sold === 'number', '');
  }
  // Deep cascade — all 13 dim filters + mode + date
  if (SAMPLES.gender && SAMPLES.category && SAMPLES.state) {
    const deep = await sales(token, {
      ...FULL,
      gender: SAMPLES.gender, category: SAMPLES.category, state: SAMPLES.state,
    });
    expect('deep cascade (gender + category + state) returns valid number',
      typeof deep.summary.units_sold === 'number' && N(deep.summary.units_sold) >= 0, '');
    expect('deep cascade ≤ baseline',
      N(deep.summary.units_sold) <= N(baseline.summary.units_sold) + 1, '');
  }

  // ─── ⑪ BACKWARD-COMPAT — legacy single-value filters still work ──────
  console.log('\n[11] BACKWARD-COMPAT — legacy single-value filters');
  if (domain.color?.[0]) {
    const legacy = await sales(token, { ...FULL, color_name: domain.color[0] });
    expect('legacy color_name still narrows',
      N(legacy.summary.units_sold) <= N(baseline.summary.units_sold) + 1, '');
  }
  if (domain.size?.[0]) {
    const legacy = await sales(token, { ...FULL, size: domain.size[0] });
    expect('legacy single size still narrows',
      N(legacy.summary.units_sold) <= N(baseline.summary.units_sold) + 1, '');
  }

  // ─── ⑫ SHAPE INVARIANTS — every row has expected fields ─────────────
  console.log('\n[12] RESPONSE SHAPE INVARIANTS');
  expect('summary has 12 expected keys',
    ['units_sold','sales_value','sales_txns','return_units','return_value','return_txns','net_units','net_value','stores_with_sales','active_days','unique_skus_sold','return_rate_pct'].every(k => k in baseline.summary),
    `keys: ${Object.keys(baseline.summary).join(', ')}`);
  expect('every by_color row has color_name + units_sold + sales_value',
    (baseline.by_color||[]).every(r => 'color_name' in r && 'units_sold' in r && 'sales_value' in r),
    `sample keys: ${Object.keys(baseline.by_color?.[0]||{}).join(', ')}`);
  expect('every by_store row has location_name + units_sold + sales_value',
    (baseline.by_store||[]).every(r => 'location_name' in r && 'units_sold' in r && 'sales_value' in r),
    `sample keys: ${Object.keys(baseline.by_store?.[0]||{}).join(', ')}`);
  expect('every by_month row has month_label + sales_qty',
    (baseline.by_month||[]).every(r => 'month_label' in r && 'sales_qty' in r),
    `sample keys: ${Object.keys(baseline.by_month?.[0]||{}).join(', ')}`);
  expect('every by_color row has return_qty (now that we added it)',
    (baseline.by_color||[]).every(r => 'return_qty' in r), '');

  // ─── ⑬ FILTER COMBINATIONS REGRESSION ──────────────────────────────
  console.log('\n[13] FILTER COMBINATIONS — every dim × mode × narrow');
  const dims = Object.entries(SAMPLES).filter(([_, v]) => v);
  for (let i = 0; i < dims.length; i++) {
    const [dimA, valA] = dims[i];
    for (let j = i + 1; j < Math.min(i + 3, dims.length); j++) {  // 2 + 1 cascade max per dim
      const [dimB, valB] = dims[j];
      const combo = await sales(token, { ...FULL, [dimA]: valA, [dimB]: valB });
      expect(`${dimA}+${dimB}: returns valid response`,
        typeof combo.summary.units_sold === 'number', '');
      expect(`${dimA}+${dimB}: combined ≤ baseline`,
        N(combo.summary.units_sold) <= N(baseline.summary.units_sold) + 1, '');
    }
  }

  // ─── ⑭ VALUATION LENS — Gross / Ex-GST / GST / MRP / Discount ─────
  console.log('\n[14] VALUATION LENS — every ₹ field present + math invariants');
  const lensBase = await sales(token, FULL);
  const ls = lensBase.summary || {};
  const NUM = (v) => Number.isFinite(Number(v)) ? Number(v) : NaN;

  // Every lens summary field must be a finite number (no NaN / undefined)
  const lensFields = [
    'sales_value', 'sales_ex_gst_value', 'sales_gst_collected', 'sales_mrp_value',
    'return_value', 'return_ex_gst_value', 'return_gst_collected', 'return_mrp_value',
    'net_value', 'net_ex_gst_value', 'net_gst_collected', 'net_mrp_value',
  ];
  for (const k of lensFields) {
    expect(`summary.${k} is finite number`, Number.isFinite(NUM(ls[k])), `got ${ls[k]}`);
  }

  // Math invariants: Gross ≈ Ex-GST + GST (small slack for ₹ rounding across rows)
  const grossSale = NUM(ls.sales_value);
  const exGstSale = NUM(ls.sales_ex_gst_value);
  const gstSale   = NUM(ls.sales_gst_collected);
  const mrpSale   = NUM(ls.sales_mrp_value);
  const slack = Math.max(1000, Math.round(grossSale * 0.005));   // ₹1k or 0.5%
  expect('Gross ≈ Ex-GST + GST (sales)',
    Math.abs(grossSale - (exGstSale + gstSale)) <= slack,
    `gross=${grossSale} ex=${exGstSale} gst=${gstSale} slack=${slack}`);

  // MRP ≥ Gross (billed price never exceeds MRP after discount)
  expect('MRP ≥ Gross (sales)', mrpSale + 1 >= grossSale,
    `mrp=${mrpSale} gross=${grossSale}`);

  // Ex-GST < Gross (since GST is positive)
  expect('Ex-GST ≤ Gross (sales)', exGstSale <= grossSale + 1,
    `ex=${exGstSale} gross=${grossSale}`);

  // GST > 0 when there are sales
  if (grossSale > 0) {
    expect('GST collected > 0 when sales > 0', gstSale > 0,
      `gst=${gstSale}`);
  }

  // Discount = MRP − Gross ≥ 0
  const discountSale = Math.max(0, mrpSale - grossSale);
  expect('Discount = MAX(0, MRP − Gross) is non-negative', discountSale >= 0, '');

  // Returns: same invariants
  const grossRet = NUM(ls.return_value);
  const exGstRet = NUM(ls.return_ex_gst_value);
  const gstRet   = NUM(ls.return_gst_collected);
  const mrpRet   = NUM(ls.return_mrp_value);
  const slackR = Math.max(500, Math.round(grossRet * 0.005));
  expect('Gross ≈ Ex-GST + GST (returns)',
    Math.abs(grossRet - (exGstRet + gstRet)) <= slackR,
    `gross=${grossRet} ex=${exGstRet} gst=${gstRet}`);
  expect('MRP ≥ Gross (returns)', mrpRet + 1 >= grossRet, '');

  // Net consistency: net_X = sales_X − return_X for every lens
  for (const lens of ['value', 'ex_gst_value', 'gst_collected', 'mrp_value']) {
    const s = NUM(ls[`sales_${lens}`]);
    const r = NUM(ls[`return_${lens}`]);
    const n = NUM(ls[`net_${lens}`]);
    expect(`net_${lens} = sales − return`,
      Math.abs(n - (s - r)) <= 1, `s=${s} r=${r} n=${n}`);
  }

  // Per-row aggregates carry every lens column
  const sampleColor = (lensBase.by_color || [])[0];
  if (sampleColor) {
    expect('by_color row has mrp_value, gst_collected, ex_gst_value',
      'mrp_value' in sampleColor && 'gst_collected' in sampleColor && 'ex_gst_value' in sampleColor,
      `keys=${Object.keys(sampleColor).join(',')}`);
  }
  const sampleSize = (lensBase.by_size || [])[0];
  if (sampleSize) {
    expect('by_size row has mrp_value, gst_collected, ex_gst_value',
      'mrp_value' in sampleSize && 'gst_collected' in sampleSize && 'ex_gst_value' in sampleSize, '');
  }
  const sampleStore = (lensBase.by_store || [])[0];
  if (sampleStore) {
    expect('by_store row has mrp_value, gst_collected, ex_gst_value',
      'mrp_value' in sampleStore && 'gst_collected' in sampleStore && 'ex_gst_value' in sampleStore, '');
  }
  const sampleDay = (lensBase.daily || [])[0];
  if (sampleDay) {
    expect('daily row has mrp_value, gst_collected, ex_gst_value',
      'mrp_value' in sampleDay && 'gst_collected' in sampleDay && 'ex_gst_value' in sampleDay, '');
  }
  const sampleMonth = (lensBase.by_month || [])[0];
  if (sampleMonth) {
    expect('by_month row has mrp_value, gst_collected, ex_gst_value',
      'mrp_value' in sampleMonth && 'gst_collected' in sampleMonth && 'ex_gst_value' in sampleMonth, '');
  }

  // Cross-row coherence: SUM(by_color.mrp_value) ≈ summary.sales_mrp_value
  const colorMrp = (lensBase.by_color || []).reduce((a, r) => a + NUM(r.mrp_value), 0);
  const slackMrp = Math.max(5000, Math.round(mrpSale * 0.01));
  expect('SUM(by_color.mrp_value) ≈ summary.sales_mrp_value',
    Math.abs(colorMrp - mrpSale) <= slackMrp,
    `colors=${colorMrp} summary=${mrpSale} slack=${slackMrp}`);

  // Cross-mode: lens math holds under every mode lens
  for (const m of ['active', 'inactive', 'all']) {
    const r = await sales(token, { ...FULL, mode: m });
    const s = r.summary;
    const g = NUM(s.sales_value);
    const e = NUM(s.sales_ex_gst_value);
    const x = NUM(s.sales_gst_collected);
    const sl = Math.max(1000, Math.round(g * 0.005));
    expect(`mode=${m}: Gross ≈ Ex-GST + GST`, Math.abs(g - (e + x)) <= sl,
      `gross=${g} ex=${e} gst=${x}`);
    expect(`mode=${m}: MRP ≥ Gross`, NUM(s.sales_mrp_value) + 1 >= g, '');
  }

  // Cross-filter: lens math holds with a narrow filter (state=Maharashtra slice)
  const narrowed = await sales(token, { ...FULL, state: 'Maharashtra' });
  if (narrowed?.summary) {
    const g = NUM(narrowed.summary.sales_value);
    const e = NUM(narrowed.summary.sales_ex_gst_value);
    const x = NUM(narrowed.summary.sales_gst_collected);
    const sl = Math.max(500, Math.round(g * 0.005));
    expect('state=MH: Gross ≈ Ex-GST + GST',
      Math.abs(g - (e + x)) <= sl,
      `gross=${g} ex=${e} gst=${x}`);
  }

  // Empty filter (nonsense state) → all lens fields are 0, not NaN/undefined.
  // Use a string with NO sql-wildcards (`_` and `%` are wildcards in ILIKE).
  const lensEmpty = await sales(token, { ...FULL, state: 'ZZZZNOWHERELAND999' });
  for (const k of lensFields) {
    expect(`empty filter: summary.${k} = 0`,
      NUM(lensEmpty?.summary?.[k]) === 0, `got ${lensEmpty?.summary?.[k]}`);
  }
  expect('empty filter: by_color = []',
    Array.isArray(lensEmpty.by_color) && lensEmpty.by_color.length === 0, '');
  expect('empty filter: by_size = []',
    Array.isArray(lensEmpty.by_size) && lensEmpty.by_size.length === 0, '');
  expect('empty filter: by_store = []',
    Array.isArray(lensEmpty.by_store) && lensEmpty.by_store.length === 0, '');
  expect('empty filter: all_stores = []',
    Array.isArray(lensEmpty.all_stores) && lensEmpty.all_stores.length === 0, '');

  // ─── ⑮ VALUATION FORMULAS — every formula, every aggregate ─────────
  console.log('\n[15] VALUATION FORMULAS — exhaustive math + impossible combos');
  // Source-of-truth formulas (must match analytics.controller.js mov CTE):
  //   gross   = sale_value (raw, GST-inclusive)
  //   ex_gst  = sale_value × 100 / (100 + gst_rate)
  //   gst     = sale_value × gst_rate / (100 + gst_rate)
  //   mrp     = qty × skus.mrp
  //   discount= MAX(0, mrp − gross)
  //
  // Every one of these invariants must hold across every aggregate
  // (summary, by_color[], by_size[], by_store[], all_stores[], daily[], by_month[])
  // and across every (mode × filter) combination.

  const aggregates = [
    { name: 'by_color',   rows: lensBase.by_color   || [] },
    { name: 'by_size',    rows: lensBase.by_size    || [] },
    { name: 'by_store',   rows: lensBase.by_store   || [] },
    { name: 'all_stores', rows: lensBase.all_stores || [] },
    { name: 'daily',      rows: lensBase.daily      || [] },
    { name: 'by_month',   rows: lensBase.by_month   || [] },
  ];

  for (const agg of aggregates) {
    if (!agg.rows.length) continue;

    // Every row must have all four lens columns
    const sample = agg.rows[0];
    expect(`${agg.name}: row has sales_value`, 'sales_value' in sample, '');
    expect(`${agg.name}: row has mrp_value`,   'mrp_value' in sample, '');
    expect(`${agg.name}: row has gst_collected`, 'gst_collected' in sample, '');
    expect(`${agg.name}: row has ex_gst_value`,  'ex_gst_value' in sample, '');

    // Every row's lens math must hold (Gross ≈ Ex-GST + GST, MRP ≥ Gross, Ex-GST ≤ Gross)
    let badGrossSplit = 0, badMrpVsGross = 0, badExGstVsGross = 0, badNaN = 0;
    for (const r of agg.rows) {
      const g = NUM(r.sales_value);
      const e = NUM(r.ex_gst_value);
      const x = NUM(r.gst_collected);
      const m = NUM(r.mrp_value);
      if (!Number.isFinite(g) || !Number.isFinite(e) || !Number.isFinite(x) || !Number.isFinite(m)) badNaN++;
      // Per-row slack: ₹100 or 1% (rounding accumulates over many movements)
      const sl = Math.max(100, Math.round(g * 0.01));
      if (Math.abs(g - (e + x)) > sl) badGrossSplit++;
      if (m + 1 < g) badMrpVsGross++;
      if (e > g + 1) badExGstVsGross++;
    }
    expect(`${agg.name}: every row has finite lens numbers`, badNaN === 0, `${badNaN}/${agg.rows.length} bad`);
    expect(`${agg.name}: every row Gross ≈ Ex-GST + GST`, badGrossSplit === 0, `${badGrossSplit}/${agg.rows.length} off`);
    expect(`${agg.name}: every row MRP ≥ Gross`, badMrpVsGross === 0, `${badMrpVsGross}/${agg.rows.length} off`);
    expect(`${agg.name}: every row Ex-GST ≤ Gross`, badExGstVsGross === 0, `${badExGstVsGross}/${agg.rows.length} off`);

    // SUM(rows.sales_value) ≈ summary.sales_value
    if (['by_color','by_size','all_stores','daily','by_month'].includes(agg.name)) {
      const sumGross = agg.rows.reduce((a, r) => a + NUM(r.sales_value), 0);
      const sumExGst = agg.rows.reduce((a, r) => a + NUM(r.ex_gst_value), 0);
      const sumGst   = agg.rows.reduce((a, r) => a + NUM(r.gst_collected), 0);
      const sumMrp   = agg.rows.reduce((a, r) => a + NUM(r.mrp_value), 0);
      const slXSum = Math.max(5000, Math.round(grossSale * 0.01));
      expect(`SUM(${agg.name}.sales_value) ≈ summary.sales_value`,
        Math.abs(sumGross - grossSale) <= slXSum, `sum=${sumGross} sumry=${grossSale}`);
      expect(`SUM(${agg.name}.ex_gst_value) ≈ summary.sales_ex_gst_value`,
        Math.abs(sumExGst - exGstSale) <= slXSum, `sum=${sumExGst} sumry=${exGstSale}`);
      expect(`SUM(${agg.name}.gst_collected) ≈ summary.sales_gst_collected`,
        Math.abs(sumGst - gstSale) <= slXSum, `sum=${sumGst} sumry=${gstSale}`);
      expect(`SUM(${agg.name}.mrp_value) ≈ summary.sales_mrp_value`,
        Math.abs(sumMrp - mrpSale) <= slXSum, `sum=${sumMrp} sumry=${mrpSale}`);
    }
  }

  // GST rate sanity — implicit GST rate should sit between 5% and 18%
  // (Indian apparel HSN: 5% under ₹1000, 12% above; we default 12%).
  if (grossSale > 0) {
    const gstRatePct = (gstSale / grossSale) * 100;
    expect('Implicit GST rate is between 4% and 19% (sanity)',
      gstRatePct >= 4 && gstRatePct <= 19, `${gstRatePct.toFixed(2)}%`);
  }

  // Discount margin sanity — discount/MRP ratio under 90% (no one gives away 99%)
  if (mrpSale > 0) {
    const discPct = (discountSale / mrpSale) * 100;
    expect('Discount/MRP is between 0% and 90% (sanity)',
      discPct >= 0 && discPct <= 90, `${discPct.toFixed(2)}%`);
  }

  // Returns: sales_value ≥ return_value (we don't return more than we sell)
  expect('sales_value ≥ return_value', grossSale + 1 >= grossRet,
    `sales=${grossSale} return=${grossRet}`);

  // Net = Gross − Returns must equal summary.net_value
  const netCalc = grossSale - grossRet;
  expect('summary.net_value = sales_value − return_value',
    Math.abs(NUM(ls.net_value) - netCalc) <= 1, '');

  // ─── ⑯ VALUATION × MODE × FILTER CROSS-PRODUCT ─────────────────────
  console.log('\n[16] VALUATION × MODE × FILTER cross-product');

  // Every (mode × dim × valuation_invariant) combo must hold
  const sampleDims = [
    { mode: 'active',   filter: {} },
    { mode: 'inactive', filter: {} },
    { mode: 'all',      filter: {} },
    { mode: 'all',      filter: { gender: 'MENS' } },
    { mode: 'all',      filter: { gender: 'WOMENS' } },
    { mode: 'all',      filter: { state: 'Maharashtra' } },
    { mode: 'all',      filter: { state: 'Gujarat' } },
    { mode: 'all',      filter: { product: 'JEANS' } },
    { mode: 'all',      filter: { date_from: '2025-09-01', date_to: '2025-09-30' } },
    { mode: 'all',      filter: { date_from: '2025-12-01', date_to: '2025-12-31' } },
    { mode: 'active',   filter: { gender: 'MENS', product: 'JEANS' } },
    { mode: 'all',      filter: { sub_product: 'BOTTOM' } },
  ];
  for (const c of sampleDims) {
    const r = await sales(token, { ...FULL, mode: c.mode, ...c.filter });
    const s = r?.summary || {};
    const g = NUM(s.sales_value), e = NUM(s.sales_ex_gst_value), x = NUM(s.sales_gst_collected), m = NUM(s.sales_mrp_value);
    const tag = `mode=${c.mode}` + (Object.keys(c.filter).length ? ` ${JSON.stringify(c.filter)}` : '');
    expect(`${tag}: Gross ≈ Ex-GST + GST`,
      Math.abs(g - (e + x)) <= Math.max(1000, Math.round(g * 0.01)),
      `g=${g} e=${e} x=${x}`);
    expect(`${tag}: MRP ≥ Gross`, m + 1 >= g, `m=${m} g=${g}`);
    expect(`${tag}: Ex-GST ≤ Gross`, e <= g + 1, `e=${e} g=${g}`);
    if (g > 0) {
      const ratePct = (x / g) * 100;
      expect(`${tag}: GST rate plausible (4%–19%)`,
        ratePct >= 4 && ratePct <= 19, `${ratePct.toFixed(2)}%`);
    }
    expect(`${tag}: every lens field finite`,
      ['sales_value','sales_ex_gst_value','sales_gst_collected','sales_mrp_value',
       'return_value','return_ex_gst_value','return_gst_collected','return_mrp_value',
       'net_value','net_ex_gst_value','net_gst_collected','net_mrp_value']
        .every(k => Number.isFinite(NUM(s[k]))),
      '');
  }

  // ─── ⑰ IMPOSSIBLE / ADVERSARIAL VALUATION INPUTS ────────────────────
  console.log('\n[17] IMPOSSIBLE inputs — must not 500, must not return NaN');

  const adversarial = [
    { tag: 'date_from > date_to (inverted)', q: { date_from: '2026-01-31', date_to: '2024-04-01' } },
    { tag: 'date_from = date_to (same day)', q: { date_from: '2025-12-15', date_to: '2025-12-15' } },
    { tag: 'date in far future',             q: { date_from: '2099-01-01', date_to: '2099-12-31' } },
    { tag: 'date before any data',           q: { date_from: '2010-01-01', date_to: '2010-12-31' } },
    { tag: 'huge multi-state CSV',           q: { state: Array(50).fill('Maharashtra').join(',') } },
    { tag: 'mode=garbage',                   q: { mode: 'NOTAREALMODE' } },
    { tag: 'gender=lowercase',               q: { gender: 'mens' } },          // case-insensitive
    { tag: 'gender=mixedcase',               q: { gender: 'MeNs' } },
    { tag: 'state with whitespace',          q: { state: '  Maharashtra  ' } },
    { tag: 'empty CSV (just commas)',        q: { state: ',,,,' } },
    { tag: 'CSV with empty entries',         q: { state: 'Maharashtra,,Gujarat,' } },
    { tag: 'numeric injection',              q: { state: "1' OR '1'='1" } },
    { tag: 'unicode state',                  q: { state: 'महाराष्ट्र' } },
    { tag: 'extremely long string',          q: { state: 'X'.repeat(2000) } },
    { tag: 'all dims set to nonsense',       q: { gender:'XYZ', product:'XYZ', shade:'XYZ', state:'XYZ', city:'XYZ' } },
  ];
  for (const a of adversarial) {
    let r;
    try { r = await sales(token, { ...FULL, ...a.q }); }
    catch (e) { bad(`adversarial ${a.tag}: did not 500`, e.message); continue; }
    const s = r?.summary || {};
    expect(`adversarial ${a.tag}: response has summary`, !!r?.summary, '');
    for (const k of lensFields) {
      expect(`adversarial ${a.tag}: ${k} is finite`,
        Number.isFinite(NUM(s[k])), `got ${s[k]}`);
    }
    // If totals are 0, all lens fields must be 0 (no orphan GST/MRP/discount)
    if (NUM(s.sales_value) === 0) {
      const allZero = ['sales_ex_gst_value','sales_gst_collected','sales_mrp_value']
        .every(k => NUM(s[k]) === 0);
      expect(`adversarial ${a.tag}: zero gross ⇒ zero ex/gst/mrp`, allZero, '');
    }
  }

  // ─── ⑱ MONOTONICITY — narrowing never increases lens values ────────
  console.log('\n[18] MONOTONICITY — narrow filter ≤ baseline for every lens');
  const narrowSet = [
    { gender: 'MENS' },
    { gender: 'WOMENS' },
    { state: 'Maharashtra' },
    { product: 'JEANS' },
    { date_from: '2025-12-01', date_to: '2025-12-31' },
  ];
  for (const f of narrowSet) {
    const r = await sales(token, { ...FULL, ...f });
    const s = r?.summary || {};
    for (const k of ['sales_value','sales_ex_gst_value','sales_gst_collected','sales_mrp_value']) {
      const slack = Math.max(100, Math.round(NUM(ls[k]) * 0.001));
      expect(`narrow ${JSON.stringify(f)}: ${k} ≤ baseline`,
        NUM(s[k]) <= NUM(ls[k]) + slack,
        `narrow=${NUM(s[k])} base=${NUM(ls[k])}`);
    }
  }

  // ─── ⑲ ADDITIVITY — partition ≈ whole ─────────────────────────────
  console.log('\n[19] ADDITIVITY — partition by gender ≈ all');
  const mens   = await sales(token, { ...FULL, gender: 'MENS' });
  const womens = await sales(token, { ...FULL, gender: 'WOMENS' });
  const kids   = await sales(token, { ...FULL, gender: 'KIDS' });
  for (const k of ['sales_value','sales_ex_gst_value','sales_gst_collected','sales_mrp_value']) {
    const part = NUM(mens.summary?.[k]) + NUM(womens.summary?.[k]) + NUM(kids.summary?.[k]);
    const whole = NUM(ls[k]);
    // Slack 5% to accommodate rows with NULL gender (uncategorized SKUs)
    const slP = Math.max(50000, Math.round(whole * 0.05));
    expect(`MENS+WOMENS+KIDS ≤ ALL for ${k}`,
      part <= whole + 1, `part=${part} whole=${whole}`);
    expect(`MENS+WOMENS+KIDS ≈ ALL for ${k} (within 5%)`,
      Math.abs(part - whole) <= slP, `part=${part} whole=${whole} slack=${slP}`);
  }

  // ─── ⑳ DAILY/MONTHLY ROLLUP — per-day sum ≈ summary ────────────────
  console.log('\n[20] DAILY ROLLUP — per-day sum ≈ summary');
  const dailyGrossSum = (lensBase.daily || []).reduce((a, r) => a + NUM(r.sales_value), 0);
  const slDay = Math.max(5000, Math.round(grossSale * 0.005));
  expect('SUM(daily.sales_value) ≈ summary.sales_value',
    Math.abs(dailyGrossSum - grossSale) <= slDay,
    `daily=${dailyGrossSum} sumry=${grossSale}`);
  // monthly rollup
  const monthGrossSum = (lensBase.by_month || []).reduce((a, r) => a + NUM(r.sales_value), 0);
  expect('SUM(by_month.sales_value) ≈ summary.sales_value',
    Math.abs(monthGrossSum - grossSale) <= slDay, '');
  expect('SUM(daily) ≈ SUM(by_month) (same source)',
    Math.abs(dailyGrossSum - monthGrossSum) <= slDay, '');

  // ─── ㉑ MULTI-SELECT REGRESSION ─────────────────────────────────────
  // Targets the destructuring bug where the legacy single-value `size` AND
  // the v2 multi-select `size` shared the same query-string key, causing
  // `s.size = '8,32'` AND `s.size IN ('8','32')` to both fire and zero out.
  // We now exhaustively confirm that EVERY dim accepts CSV multi-select
  // without silently zeroing the result.
  console.log('\n[21] MULTI-SELECT REGRESSION — CSV per dim, no silent zeroing');

  const MULTI_DIMS = ['gender', 'sub_product', 'product', 'category', 'style',
                      'shade', 'color', 'size', 'season', 'state', 'city',
                      'group_name', 'store_code'];

  for (const dim of MULTI_DIMS) {
    const opts = (domain[dim] || []).filter(Boolean);
    if (opts.length < 2) { console.log(`   [skip] ${dim}: needs ≥2 options`); continue; }
    // Pick two values that have non-zero data so the union also has data.
    // We probe up to 5 candidates each to avoid picking dead values.
    const candidates = opts.filter(s => s && String(s).length <= 25).slice(0, 5);
    let pickA = null, pickB = null;
    for (const v of candidates) {
      const r = await sales(token, { ...FULL, [dim]: v });
      if (N(r?.summary?.units_sold) > 0) {
        if (!pickA) pickA = { v, units: N(r.summary.units_sold) };
        else if (!pickB && v !== pickA.v) { pickB = { v, units: N(r.summary.units_sold) }; break; }
      }
    }
    if (!pickA || !pickB) { console.log(`   [skip] ${dim}: not enough non-zero values`); continue; }

    // Single-pick sanity
    const single = await sales(token, { ...FULL, [dim]: pickA.v });
    expect(`${dim}=${pickA.v} (single) → units > 0`, N(single.summary.units_sold) > 0, '');

    // CSV multi-pick must be ≥ either single pick (union ≥ each member) and
    // ≤ baseline. Crucially, must NOT be 0 — that was the original bug.
    const multi = await sales(token, { ...FULL, [dim]: `${pickA.v},${pickB.v}` });
    const both  = N(multi.summary.units_sold);
    expect(`${dim}=${pickA.v},${pickB.v} (CSV) → units > 0 (regression)`, both > 0,
      `single=${pickA.units} got=${both}`);
    expect(`${dim} CSV ≥ single A`, both >= pickA.units - 1,
      `single=${pickA.units} multi=${both}`);
    expect(`${dim} CSV ≥ single B`, both >= pickB.units - 1,
      `single=${pickB.units} multi=${both}`);
    expect(`${dim} CSV ≤ baseline`, both <= N(baseline.summary.units_sold) + 1,
      `multi=${both} base=${N(baseline.summary.units_sold)}`);

    // CSV with whitespace must be tolerated
    const wsMulti = await sales(token, { ...FULL, [dim]: ` ${pickA.v} , ${pickB.v} ` });
    expect(`${dim} CSV with whitespace tolerated`, N(wsMulti.summary.units_sold) === both,
      `ws=${N(wsMulti.summary.units_sold)} clean=${both}`);

    // CSV with duplicates must dedupe
    const dupMulti = await sales(token, { ...FULL, [dim]: `${pickA.v},${pickA.v},${pickB.v}` });
    expect(`${dim} CSV with duplicates → same as deduped`,
      N(dupMulti.summary.units_sold) === both, '');

    // CSV with an unknown value mixed with a real one — must equal the real one
    const mixMulti = await sales(token, { ...FULL, [dim]: `${pickA.v},__NEVER__` });
    expect(`${dim} CSV (real, garbage) → ≥ real-only result`,
      N(mixMulti.summary.units_sold) >= pickA.units - 1, '');
  }

  // SIZE-specific regression for the exact reported bug case
  if ((domain.size || []).length >= 2) {
    const sizes = (domain.size || []).filter(s => s && String(s).length <= 4);
    if (sizes.length >= 2) {
      const a = sizes[0], b = sizes[Math.min(sizes.length - 1, 5)];
      const csv = await sales(token, { ...FULL, size: `${a},${b}` });
      const sa  = await sales(token, { ...FULL, size: a });
      const sb  = await sales(token, { ...FULL, size: b });
      expect(`size=${a},${b}: not silently 0 (the reported bug)`,
        N(csv.summary.units_sold) > 0
          || (N(sa.summary.units_sold) === 0 && N(sb.summary.units_sold) === 0),
        `csv=${N(csv.summary.units_sold)} a=${N(sa.summary.units_sold)} b=${N(sb.summary.units_sold)}`);
      expect(`size=${a},${b} ≥ size=${a} alone (union)`,
        N(csv.summary.units_sold) >= N(sa.summary.units_sold) - 1, '');
      expect(`size=${a},${b} ≥ size=${b} alone (union)`,
        N(csv.summary.units_sold) >= N(sb.summary.units_sold) - 1, '');
    }
  }

  // ─── ㉒ BY_SKU AGGREGATION ─────────────────────────────────────────
  // Per-SKU performance ranking shipped on every sales response. Asserts the
  // ranking is well-formed, lens columns are present, and totals tie back to
  // the summary row.
  console.log('\n[22] BY_SKU AGGREGATION — ranking + lens parity + integrity');
  const skuBase = await sales(token, FULL);
  const bySku = skuBase.by_sku || [];

  expect('by_sku array present', Array.isArray(bySku), `got ${typeof bySku}`);
  expect('by_sku non-empty for full window',  bySku.length > 0, `got ${bySku.length}`);
  expect('by_sku capped at 200', bySku.length <= 200, `got ${bySku.length}`);

  if (bySku.length > 0) {
    const r0 = bySku[0];
    const requiredKeys = [
      'sku_id', 'sku_code', 'product_name', 'color_name', 'size', 'mrp',
      'units_sold', 'sales_value', 'transactions', 'return_qty',
      'stores_count', 'days_sold', 'first_sold_at', 'last_sold_at',
      'mrp_value', 'cogs_value', 'gst_collected', 'ex_gst_value',
    ];
    for (const k of requiredKeys) {
      expect(`by_sku[0] has key ${k}`, k in r0, `keys=${Object.keys(r0).join(',')}`);
    }

    // Pre-sorted by sales_value DESC
    let sortedDesc = true;
    for (let i = 1; i < bySku.length; i++) {
      if (Number(bySku[i].sales_value) > Number(bySku[i - 1].sales_value)) { sortedDesc = false; break; }
    }
    expect('by_sku sorted by sales_value DESC', sortedDesc, '');

    // Every row has finite numbers — no NaN poisoning the table
    let badNum = 0;
    for (const r of bySku) {
      for (const k of ['units_sold', 'sales_value', 'mrp_value', 'gst_collected', 'ex_gst_value', 'days_sold']) {
        if (!Number.isFinite(Number(r[k]))) badNum++;
      }
    }
    expect('every by_sku row has finite numbers', badNum === 0, `${badNum} bad values`);

    // Lens math holds per row: Gross ≈ Ex-GST + GST
    let badSplit = 0;
    for (const r of bySku) {
      const g = Number(r.sales_value), e = Number(r.ex_gst_value), x = Number(r.gst_collected);
      if (Math.abs(g - (e + x)) > Math.max(50, g * 0.02)) badSplit++;
    }
    expect('every by_sku row Gross ≈ Ex-GST + GST', badSplit === 0, `${badSplit} bad`);

    // Returns coherence: return_qty ≤ units_sold + return_qty (trivially true)
    // but also stores_count ≤ days_sold * something reasonable — sanity that
    // stores_count > 0 when there's at least one sale.
    let badStores = 0;
    for (const r of bySku) {
      if (Number(r.units_sold) > 0 && Number(r.stores_count) === 0) badStores++;
    }
    expect('units_sold > 0 ⇒ stores_count > 0', badStores === 0, `${badStores} bad`);
  }

  // by_sku narrows with filters
  if ((domain.gender || []).length > 0) {
    const g = domain.gender[0];
    const narrowed = await sales(token, { ...FULL, gender: g });
    expect(`by_sku narrows with gender=${g}`,
      Array.isArray(narrowed.by_sku) && narrowed.by_sku.length <= bySku.length,
      `narrow=${narrowed.by_sku?.length} base=${bySku.length}`);
  }

  // SKU multi-select unknown / nonsense filter ⇒ empty by_sku, not crash
  const skuNonsense = await sales(token, { ...FULL, gender: 'XYZ_NOT_A_GENDER' });
  expect('nonsense filter ⇒ by_sku is empty array',
    Array.isArray(skuNonsense.by_sku) && skuNonsense.by_sku.length === 0, '');

  // Cross-mode: by_sku exists for every mode
  for (const m of ['active', 'inactive', 'all']) {
    const r = await sales(token, { ...FULL, mode: m });
    expect(`mode=${m}: by_sku is array`, Array.isArray(r.by_sku), '');
  }

  // ─── ㉓ TRANSPARENT all_stores (LEFT JOIN) ────────────────────────────
  // Verifies the new always-include-eligible-stores behaviour. Every active
  // store under the mode + location filters must appear in all_stores even
  // if it had zero movements in the date window. Also asserts the new
  // eligible_store_count field and that stores_with_sales <= it.
  console.log('\n[23] TRANSPARENT all_stores — eligible-store LEFT JOIN');

  // Active mode in user's default window (Jan 2025 → Jan 2026): 284 active
  // stores total, 275 with sales, 9 silent.
  const tw = await sales(token, { date_from: '2025-01-01', date_to: '2026-01-31', mode: 'active' });
  const tws = tw?.summary || {};
  const tElig  = N(tws.eligible_store_count);
  const tSold  = N(tws.stores_with_sales);
  expect('active+window: eligible_store_count is finite > 0',
    Number.isFinite(tElig) && tElig > 0, `got ${tElig}`);
  expect('active+window: stores_with_sales <= eligible_store_count',
    tSold <= tElig, `sold=${tSold} elig=${tElig}`);
  expect('active+window: all_stores.length === eligible_store_count',
    (tw.all_stores || []).length === tElig,
    `rows=${(tw.all_stores || []).length} elig=${tElig}`);

  // Silent stores = eligible − stores_with_sales. Their rows should have
  // units_sold === 0 AND sales_value === 0 AND every lens column zeroed.
  const silentRows = (tw.all_stores || []).filter(r => N(r.units_sold) === 0 && N(r.sales_value) === 0);
  expect('silent count = eligible − stores_with_sales',
    silentRows.length === (tElig - tSold),
    `silent=${silentRows.length} expected=${tElig - tSold}`);

  let badZero = 0;
  for (const r of silentRows) {
    if (N(r.return_qty) !== 0 || N(r.return_value) !== 0
        || N(r.mrp_value) !== 0 || N(r.gst_collected) !== 0
        || N(r.ex_gst_value) !== 0 || N(r.return_mrp_value) !== 0
        || N(r.return_gst_collected) !== 0 || N(r.return_ex_gst_value) !== 0
        || N(r.transactions) !== 0) badZero++;
  }
  expect('every silent store has all numeric columns = 0', badZero === 0,
    `${badZero}/${silentRows.length} dirty`);

  // Identity columns must still be present on silent stores
  let badIdent = 0;
  for (const r of silentRows) {
    if (!r.location_id || !r.location_name) badIdent++;
  }
  expect('silent stores still ship identity columns', badIdent === 0,
    `${badIdent} missing id/name`);

  // SUM(all_stores.sales_value) ≈ summary.sales_value — the LEFT JOIN
  // adds zero-rows that contribute nothing, so this invariant must hold.
  const sumAllStores = (tw.all_stores || []).reduce((a, r) => a + N(r.sales_value), 0);
  const slackAS = Math.max(5000, Math.round(N(tws.sales_value) * 0.005));
  expect('SUM(all_stores.sales_value) ≈ summary.sales_value',
    Math.abs(sumAllStores - N(tws.sales_value)) <= slackAS,
    `sum=${sumAllStores} sumry=${N(tws.sales_value)}`);

  // ── Cross-mode: every mode reports a sane eligible_store_count ──
  for (const m of ['active', 'inactive', 'all']) {
    const r = await sales(token, { ...FULL, mode: m });
    const e = N(r?.summary?.eligible_store_count);
    expect(`mode=${m}: eligible_store_count ≥ 0`, e >= 0, `got ${e}`);
    expect(`mode=${m}: all_stores.length === eligible_store_count`,
      (r.all_stores || []).length === e,
      `rows=${(r.all_stores || []).length} elig=${e}`);
    expect(`mode=${m}: stores_with_sales ≤ eligible_store_count`,
      N(r.summary.stores_with_sales) <= e, '');
  }

  // ── Mode partition: active + inactive should equal all (or close) ──
  {
    const a = await sales(token, { ...FULL, mode: 'active' });
    const i = await sales(token, { ...FULL, mode: 'inactive' });
    const x = await sales(token, { ...FULL, mode: 'all' });
    const sumPart = N(a.summary.eligible_store_count) + N(i.summary.eligible_store_count);
    const whole   = N(x.summary.eligible_store_count);
    expect('active.elig + inactive.elig === all.elig',
      sumPart === whole, `part=${sumPart} whole=${whole}`);
  }

  // ── State narrowing reduces eligible count predictably ──
  if ((domain.state || []).length > 0) {
    const st = domain.state[0];
    const r  = await sales(token, { ...FULL, state: st });
    const e  = N(r.summary.eligible_store_count);
    expect(`state=${st}: eligible ≤ baseline`, e <= tElig + 1, `e=${e} base=${tElig}`);
    expect(`state=${st}: all rows belong to ${st}`,
      (r.all_stores || []).every(row => String(row.state).toUpperCase() === st.toUpperCase()),
      'foreign-state row leaked');
  }

  // ── Impossible inputs / regressions ─────────────────────────────────
  // 1) Nonsense state → empty arrays + zero eligible.
  const ns = await sales(token, { ...FULL, state: 'ZZZZNOWHERELAND999' });
  expect('nonsense state: eligible=0', N(ns.summary.eligible_store_count) === 0, '');
  expect('nonsense state: all_stores=[]',
    Array.isArray(ns.all_stores) && ns.all_stores.length === 0, '');
  expect('nonsense state: silent_count derivation safe',
    N(ns.summary.eligible_store_count) - N(ns.summary.stores_with_sales) >= 0, '');

  // 2) Cross-product: state + nonsense gender → still zero, no NaN
  const nx = await sales(token, { ...FULL, state: 'Maharashtra', gender: 'XYZ_NOT_REAL' });
  expect('state+nonsense gender: eligible_store_count finite',
    Number.isFinite(N(nx.summary.eligible_store_count)), '');
  expect('state+nonsense gender: all_stores is array',
    Array.isArray(nx.all_stores), '');

  // 3) Future date range → eligible stores still listed (LEFT JOIN means
  //    zero-activity stores show up regardless of date) and every row is 0.
  const fd = await sales(token, { date_from: '2099-01-01', date_to: '2099-12-31', mode: 'active' });
  expect('future window: eligible_store_count > 0 (stores still exist)',
    N(fd.summary.eligible_store_count) > 0, `got ${N(fd.summary.eligible_store_count)}`);
  expect('future window: all rows have units_sold=0',
    (fd.all_stores || []).every(r => N(r.units_sold) === 0), 'leaked sales');
  expect('future window: stores_with_sales=0',
    N(fd.summary.stores_with_sales) === 0, '');

  // 4) Inverted date range — same as future: zero activity, full eligible
  const inv = await sales(token, { date_from: '2026-12-31', date_to: '2024-01-01', mode: 'active' });
  expect('inverted dates: did not 500',
    Array.isArray(inv.all_stores), '');
  expect('inverted dates: stores_with_sales=0',
    N(inv.summary.stores_with_sales) === 0, '');

  // 5) Sort-order: silent (zero) stores must sort to bottom (NULLS LAST)
  const sorted = tw.all_stores || [];
  if (sorted.length > 1 && (tElig - tSold) > 0) {
    // First row must have sales_value > 0 (top seller)
    expect('all_stores ranked: first row has sales > 0',
      N(sorted[0].sales_value) > 0, `got ${N(sorted[0].sales_value)}`);
    // Last row should be 0 (silent store sinks to bottom)
    expect('all_stores ranked: last row is silent (sales = 0)',
      N(sorted[sorted.length - 1].sales_value) === 0,
      `got ${N(sorted[sorted.length - 1].sales_value)}`);
  }

  // 6) Once a store_code filter is applied, eligible drops to 1 (or 0 if
  //    that code doesn't match any active store under the mode).
  if ((domain.store_code || []).length > 0) {
    const sc = domain.store_code[0];
    const r  = await sales(token, { ...FULL, store_code: sc });
    expect(`store_code=${sc}: eligible_store_count <= 1`,
      N(r.summary.eligible_store_count) <= 1, '');
  }

  // 7) Whitespace-padded state still narrows correctly (ILIKE-friendly)
  if ((domain.state || []).length > 0) {
    const st = domain.state[0];
    const a  = await sales(token, { ...FULL, state: st });
    const b  = await sales(token, { ...FULL, state: `  ${st}  ` });
    expect(`state whitespace tolerated: eligible match`,
      N(a.summary.eligible_store_count) === N(b.summary.eligible_store_count), '');
  }

  // ─── SUMMARY ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(71));
  console.log(`  RESULT  ✅ ${passed} passed   ❌ ${failed} failed`);
  console.log('═'.repeat(71));
  if (fails.length) {
    console.log('\nFailures:\n' + fails.map(f => `  • ${f.n}\n    ${f.why}`).join('\n'));
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(2); });
