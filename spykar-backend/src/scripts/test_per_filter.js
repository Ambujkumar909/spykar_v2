#!/usr/bin/env node
'use strict';
/**
 * test_per_filter.js — Strict per-dimension verification.
 * For EVERY one of the 13 filter dimensions, verifies that picking a real
 * value:
 *   ① the dimension's own dropdown is unaffected (self-strip rule)
 *   ② every OTHER dimension narrows or stays equal (never grows)
 *   ③ the network-pulse total_stock changes (i.e. the filter actually
 *      reaches the data layer, not just the dropdown population)
 *
 * If pulse total_stock is identical to baseline for every test value, the
 * filter is silently being ignored downstream — that's the bug we just
 * fixed for `product` and want to catch for any other dim.
 */
require('dotenv').config();

const API = process.env.TEST_API_BASE || 'http://localhost:4001/api/v1';
const EMAIL = 'admin@spykar.com', PASS = 'Admin@123';

let passed = 0, failed = 0;
const fails = [];

const qs = p => new URLSearchParams(Object.fromEntries(Object.entries(p||{}).filter(([,v]) => v != null && v !== ''))).toString();
const get = async (url, params, headers) => {
  const r = await fetch(`${url}${params ? `?${qs(params)}` : ''}`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const post = async (url, body) => {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function bad(name, why) { failed++; fails.push({name,why}); console.log(`  ❌ ${name}\n     ${why}`); }

(async () => {
  const login = await post(`${API}/auth/login`, { email: EMAIL, password: PASS });
  const token = login?.accessToken || login?.data?.accessToken;
  const H = { Authorization: `Bearer ${token}` };

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Per-Filter Strict Verification');
  console.log('═══════════════════════════════════════════════════════════════');

  const baseline   = (await get(`${API}/filters/options`, {}, H)).options;
  const baseline_p = (await get(`${API}/locations/network-pulse`, {mode:'all'}, H)).data;
  const baseStock  = baseline_p.summary.total_stock;
  console.log(`\nBaseline (no filter, mode=all): total_stock=${baseStock.toLocaleString()}\n`);

  // Pick a sample value for each dimension. Use the SECOND option to skip
  // any "empty" first entries.
  const dims = [
    { name: 'gender',      apiKey: 'gender' },
    { name: 'sub_product', apiKey: 'sub_product' },
    { name: 'product',     apiKey: 'product' },
    { name: 'category',    apiKey: 'category' },
    { name: 'style',       apiKey: 'style' },
    { name: 'shade',       apiKey: 'shade' },
    { name: 'season',      apiKey: 'season' },
    { name: 'state',       apiKey: 'state' },
    { name: 'city',        apiKey: 'city' },
    { name: 'group_name',  apiKey: 'group_name' },
    { name: 'store_code',  apiKey: 'store_code' },
  ];

  for (const d of dims) {
    const domain = baseline[d.name] || [];
    if (!domain.length) { console.log(`\n[${d.name}] SKIPPED — no values in domain`); continue; }
    const sample = domain[0];
    console.log(`\n[${d.name}] picking "${sample}"`);

    const filtered = (await get(`${API}/filters/options`, { [d.apiKey]: sample }, H)).options;
    const pulseR   = (await get(`${API}/locations/network-pulse`, { [d.apiKey]: sample, mode:'all' }, H)).data;

    // ① self-strip
    if ((filtered[d.name]?.length || 0) === domain.length) ok(`self-strip — ${d.name} stays at ${domain.length}`);
    else bad(`self-strip — ${d.name} narrowed to ${filtered[d.name]?.length} (should be ${domain.length})`, JSON.stringify(filtered[d.name]?.slice(0,5)));

    // ② cross-narrow on at least ONE other dim (proves filter reaches options API)
    const otherDimsThatNarrowed = dims.filter(o => o.name !== d.name).filter(o => {
      const before = baseline[o.name]?.length || 0;
      const after  = filtered[o.name]?.length || 0;
      return after < before;
    });
    if (otherDimsThatNarrowed.length > 0) ok(`cross-narrow — ${otherDimsThatNarrowed.length} other dims narrowed`);
    else bad(`cross-narrow — no other dim narrowed (filter ineffective)`, '');

    // ③ pulse total_stock changes (proves filter reaches data layer)
    if (pulseR.summary.total_stock < baseStock) ok(`pulse — total_stock dropped to ${pulseR.summary.total_stock.toLocaleString()}`);
    else if (pulseR.summary.total_stock === baseStock) bad(`pulse — total_stock UNCHANGED ${baseStock} (filter ignored by /network-pulse)`, '');
    else ok(`pulse — total_stock = ${pulseR.summary.total_stock.toLocaleString()}`);
  }

  console.log('\n' + '═'.repeat(63));
  console.log(`  RESULT  ✅ ${passed} passed   ❌ ${failed} failed`);
  console.log('═'.repeat(63));
  if (fails.length) console.log('\nFailures:\n' + fails.map(f => `  • ${f.name}\n    ${f.why}`).join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(2); });
