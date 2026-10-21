// ─── wrEngine.js — the War Room's in-memory sales engine ────────────────────
// Every sale / return line, net per store × day × SKU, held in typed arrays
// (≈ 4M rows, ≈ 80 MB), sorted by day. A board for ANY as-on date and ANY
// product filter is then one pass over the rows in range — no SQL, so a
// filter on size / colour / sub-product / season answers as fast as no filter.
//
// Exactness: values are integer PAISA (every ERP value is paisa-exact; sums
// stay integers far below 2^53), grouped with the very rules of the rollups
// (salesRollup.js): SALE − RETURN, sale_value, |qty| × MRP, active stores and
// active SKUs, the day = moved_at::date on the same connection pool.
// verify_war_room.js / stress_war_room.js check it cell by cell against the
// raw lines.
//
// Life cycle: load() in the background (start-up, and after every sync via
// the cache invalidator); the new arrays swap in only when complete. While
// nothing is loaded — or the data has moved on since the load — callers use
// the SQL path.
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');
const copyTo = require('pg-copy-streams').to;
const { query, pool } = require('../config/database');
const logger = require('../config/logger');

const EPOCH = Date.UTC(2000, 0, 1);
const bNsub = (a, n) => a.subarray(0, n);
const dayNum = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH) / 864e5);
const dayIso = (n) => new Date(EPOCH + n * 864e5).toISOString().slice(0, 10);

let E = null;          // the loaded engine
let loading = null;    // in-flight load promise

const PRODUCT_NORM = "regexp_replace(COALESCE(s.product, ''), '\\s*[<>].*$', '')";
const ATTRS = [   // [scope key, SQL expression]; '' for the three light dims mirrors the rollup's COALESCE
  ['gender', "COALESCE(s.gender_name, '')"], ['category', "COALESCE(s.category_norm, '')"], ['product', PRODUCT_NORM],
  ['sub_product', 's.sub_product'], ['size', 's.size'], ['color', 's.color_name'], ['season', 's.season'],
];

async function load(catOf, CATS) {
  if (loading) return loading;
  loading = (async () => {
    const t0 = Date.now();
    const { rows: [mark] } = await query(`SELECT MAX(completed_at) AS at FROM sync_logs WHERE status IN ('SUCCESS', 'FAILED')`);
    if (E && E.mark === (mark.at ? new Date(mark.at).getTime() : 0)) return E;   // already built from the latest sync
    // SKU dictionary — ALL SKUs (stock counts inactive SKUs too; sales lines below are active-only, like the rollups)
    const { rows: skus } = await query(`SELECT s.id, ${ATTRS.map(([, e], i) => `${e} AS a${i}`).join(', ')},
      COALESCE(s.gender_name, '') AS g, COALESCE(s.category_norm, '') AS c, ${PRODUCT_NORM} AS p, COALESCE(s.mrp, 0)::float AS mrp
      FROM skus s`);
    const skuIx = new Map(); const dicts = ATTRS.map(() => new Map()); const codes = ATTRS.map(() => new Uint16Array(skus.length));
    const catIx = new Uint8Array(skus.length); const mrp = new Float64Array(skus.length);
    skus.forEach((r, i) => {
      skuIx.set(r.id, i); mrp[i] = r.mrp; catIx[i] = CATS.indexOf(catOf(r.g, r.c, r.p));
      ATTRS.forEach((_, a) => {
        const v = r[`a${a}`]; if (v == null) { codes[a][i] = 0; return; }   // 0 = no value (never matches)
        let c = dicts[a].get(v); if (c == null) { c = dicts[a].size + 1; dicts[a].set(v, c); } codes[a][i] = c;
      });
    });
    const { rows: locs } = await query('SELECT id FROM locations WHERE is_active');
    const locIx = new Map(locs.map((r, i) => [r.id, i]));
    // net lines per day × store × SKU, ordered by day, streamed as CSV
    let cap = 4_500_000; let n = 0;
    let day = new Uint16Array(cap); let loc = new Uint16Array(cap); let sku = new Uint32Array(cap);
    let q = new Int32Array(cap); let v = new Int32Array(cap); let m = new Int32Array(cap);
    const grow = () => {
      cap = Math.ceil(cap * 1.5);
      const g = (A, T) => { const B = new T(cap); B.set(A); return B; };
      day = g(day, Uint16Array); loc = g(loc, Uint16Array); sku = g(sku, Uint32Array); q = g(q, Int32Array); v = g(v, Int32Array); m = g(m, Int32Array);
    };
    const client = await pool.connect();
    try {
      const stream = client.query(copyTo(`COPY (
        SELECT (m.moved_at::date - DATE '2000-01-01') AS d, m.location_id, m.sku_id,
          SUM(CASE WHEN m.movement_type = 'SALE' THEN ABS(m.qty_change) ELSE -ABS(m.qty_change) END)::int,
          ROUND(SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * COALESCE(m.sale_value, 0)) * 100)::bigint,
          ROUND(SUM(CASE WHEN m.movement_type = 'SALE' THEN 1 ELSE -1 END * ABS(m.qty_change)::numeric * COALESCE(s.mrp, 0)) * 100)::bigint
        FROM inventory_movements m JOIN skus s ON s.id = m.sku_id JOIN locations l ON l.id = m.location_id
        WHERE m.movement_type IN ('SALE', 'RETURN') AND l.is_active = true AND s.is_active = true
        GROUP BY 1, 2, 3 ORDER BY 1) TO STDOUT`));
      let rest = '';
      await pipeline(stream, new Writable({
        write(chunk, _, cb) {
          const lines = (rest + chunk.toString('utf8')).split('\n'); rest = lines.pop();
          for (const ln of lines) {
            const f = ln.split('\t');
            const si = skuIx.get(f[2]); const li = locIx.get(f[1]);
            if (si === undefined || li === undefined) continue;
            if (n === cap) grow();
            day[n] = Number(f[0]); loc[n] = li; sku[n] = si; q[n] = Number(f[3]); v[n] = Number(f[4]); m[n] = Number(f[5]); n++;
          }
          cb();
        },
      }));
    } finally { client.release(); }
    // level 2: the same lines summed to day × store × category bucket (used when no
    // product filter is on — several times fewer rows to scan). Rows stay in day order.
    const L2 = (() => {
      const out = { day: new Uint16Array(n), loc: new Uint16Array(n), cat: new Uint8Array(n), q: new Int32Array(n), v: new Float64Array(n), m: new Float64Array(n), n: 0 };
      let i = 0;
      while (i < n) {
        const d = day[i]; const acc = new Map();
        for (; i < n && day[i] === d; i++) {
          const key = loc[i] * 32 + catIx[sku[i]];
          let a = acc.get(key); if (!a) { a = [0, 0, 0]; acc.set(key, a); }
          a[0] += q[i]; a[1] += v[i]; a[2] += m[i];
        }
        for (const [key, a] of acc) { const j = out.n++; out.day[j] = d; out.loc[j] = key >> 5; out.cat[j] = key & 31; out.q[j] = a[0]; out.v[j] = a[1]; out.m[j] = a[2]; }
      }
      const k = out.n;
      return { day: out.day.slice(0, k), loc: out.loc.slice(0, k), cat: out.cat.slice(0, k), q: out.q.slice(0, k), v: out.v.slice(0, k), m: out.m.slice(0, k), n: k };
    })();
    // bills per store per day (the wr_store_day rollup — distinct sale + return bills)
    const { rows: br } = await query(`SELECT (sale_date - DATE '2000-01-01') AS d, location_id, bills FROM wr_store_day`);
    const bDay = new Uint16Array(br.length); const bLoc = new Uint16Array(br.length); const bN = new Int32Array(br.length); let bn = 0;
    for (const r of br) { const l = locIx.get(r.location_id); if (l === undefined) continue; bDay[bn] = r.d; bLoc[bn] = l; bN[bn] = r.bills; bn++; }
    // start[k] = first row whose day ≥ d0 + k (rows are ordered by day); start[last] = n
    const d0 = n ? day[0] : 0; const d1 = n ? day[n - 1] : -1;
    const startOf = (D, N) => { const st = new Uint32Array(Math.max(0, d1 - d0 + 2)); for (let k = 0, r = 0; k < st.length; k++) { while (r < N && D[r] < d0 + k) r++; st[k] = r; } return st; };
    const start = startOf(day, n); L2.start = startOf(L2.day, L2.n);
    E = { mark: mark.at ? new Date(mark.at).getTime() : 0, n, d0, d1, start, L2, rev: dicts.map((m) => { const a = ['']; for (const [k, c] of m) a[c] = k; return a; }), bills: { day: bDay.subarray(0, bn), loc: bLoc.subarray(0, bn), n: bNsub(bN, bn) }, day, loc, sku, q, v, m, codes, dicts, catIx, mrp, skuIx, locs: locs.map((r) => r.id), locIx, stock: new Map() };
    const { rows: [sd] } = await query(`SELECT MAX(snapshot_date)::text AS d FROM inventory_daily_snapshot WHERE snapshot_date >= CURRENT_DATE - 30`);
    if (sd.d) {
      await stockRows(E, sd.d);
      const { rows: [ly] } = await query(`SELECT MAX(snapshot_date)::text AS d FROM inventory_daily_snapshot
        WHERE snapshot_date BETWEEN ($1::date - interval '1 year')::date - 7 AND ($1::date - interval '1 year')::date`, [sd.d]);
      if (ly.d) await stockRows(E, ly.d);
    }
    logger.info(`⚡ War Room engine loaded: ${n.toLocaleString()} rows, ${skus.length.toLocaleString()} SKUs, ${dayIso(d0)} → ${dayIso(d1)} in ${Date.now() - t0} ms`);
    return E;
  })().finally(() => { loading = null; });
  return loading;
}

// Ready AND built from the latest sync? (a newer sync → the SQL path until reloaded)
async function current() {
  if (!E) return null;
  const { rows: [r] } = await query(`SELECT MAX(completed_at) AS at FROM sync_logs WHERE status IN ('SUCCESS', 'FAILED')`);
  return (r.at ? new Date(r.at).getTime() : 0) === E.mark ? E : null;
}

// SKU mask for a product scope (null = every SKU)
function maskFor(e, sel) {
  const picks = ATTRS.map(([k], a) => [a, (sel[k] || []).map((x) => e.dicts[a].get(x)).filter(Boolean)]).filter(([a]) => (sel[ATTRS[a][0]] || []).length);
  if (!picks.length) return null;
  const mask = new Uint8Array(e.codes[0].length);
  outer: for (let i = 0; i < mask.length; i++) {
    for (const [a, set] of picks) if (!set.includes(e.codes[a][i])) continue outer;
    mask[i] = 1;
  }
  return mask;
}

// One pass → per store: period windows [q, v, m] (paisa) + bills, 13 weekly ₹
// TY/LY, daily ₹ of the month TY/LY, and per category [q, v] for the
// category periods. Each day's memberships are precomputed once (bit flags /
// indexes), so a line only touches the cells it belongs to.
function compute(e, { windows, weeks, mtd, mtdly, catPeriods, nCats }, sel) {
  const mask = maskFor(e, sel);
  const W = windows.map(([, [a, b]]) => [dayNum(a), dayNum(b)]);
  const wTy0 = dayNum(weeks[0].ty[0]); const wTy1 = dayNum(weeks[weeks.length - 1].ty[1]);
  const wLy0 = dayNum(weeks[0].ly[0]); const wLy1 = dayNum(weeks[weeks.length - 1].ly[1]);
  const m0 = dayNum(mtd[0]); const m1 = dayNum(mtd[1]); const l0 = dayNum(mtdly[0]); const l1 = dayNum(mtdly[1]);
  const C = catPeriods.map((k) => W[windows.findIndex(([n]) => n === k)]);
  const nW = W.length; const nWk = weeks.length; const nD = m1 - m0 + 1; const nC = C.length;
  const stride = nW * 4 + nWk * 2 + nD * 2 + nCats * nC * 2;
  const oWk = nW * 4; const oD = oWk + nWk * 2; const oC = oD + nD * 2;
  const lo = Math.min(...W.map((w) => w[0]), wLy0, l0); const hi = Math.max(...W.map((w) => w[1]), wTy1, m1);
  const span = hi - lo + 1;
  const wb = new Uint32Array(span); const cb = new Uint32Array(span);
  const wkT = new Int16Array(span).fill(-1); const wkL = new Int16Array(span).fill(-1); const dT = new Int16Array(span).fill(-1); const dL = new Int16Array(span).fill(-1);
  for (let k = 0; k < span; k++) {
    const d = lo + k;
    for (let w = 0; w < nW; w++) if (d >= W[w][0] && d <= W[w][1]) wb[k] |= 1 << w;
    for (let c = 0; c < nC; c++) if (d >= C[c][0] && d <= C[c][1]) cb[k] |= 1 << c;
    if (d >= wTy0 && d <= wTy1) wkT[k] = Math.floor((d - wTy0) / 7);
    if (d >= wLy0 && d <= wLy1) wkL[k] = Math.floor((d - wLy0) / 7);
    if (d >= m0 && d <= m1) dT[k] = d - m0;
    if (d >= l0 && d <= l1 && d - l0 < nD) dL[k] = d - l0;
  }
  const acc = new Float64Array(e.locs.length * stride); const seen = new Uint8Array(e.locs.length);
  // no product filter → the day × store × category level; otherwise the SKU lines through the mask
  const src = mask === null ? e.L2 : e;
  const at = (d) => src.start[Math.max(0, Math.min(src.start.length - 1, d - e.d0))];   // first row with day ≥ d
  const r1 = at(hi + 1);
  const { day, loc, q: Q, v: V, m: M } = src; const sku = mask === null ? null : e.sku; const catOfRow = mask === null ? e.L2.cat : null; const { catIx } = e;
  for (let r = at(lo); r < r1; r++) {
    let cat;
    if (mask !== null) { const s = sku[r]; if (mask[s] === 0) continue; cat = catIx[s]; } else cat = catOfRow[r];
    const k = day[r] - lo; const li = loc[r]; const L = li * stride; const q = Q[r]; const v = V[r];
    seen[li] = 1;
    for (let b = wb[k]; b; b &= b - 1) { const w = 31 - Math.clz32(b & -b); const o = L + w * 4; acc[o] += q; acc[o + 1] += v; acc[o + 2] += M[r]; }
    if (wkT[k] >= 0) acc[L + oWk + 2 * wkT[k]] += v;
    if (wkL[k] >= 0) acc[L + oWk + 2 * wkL[k] + 1] += v;
    if (dT[k] >= 0) acc[L + oD + 2 * dT[k]] += v;
    if (dL[k] >= 0) acc[L + oD + 2 * dL[k] + 1] += v;
    const cbk = cb[k];
    if (cbk) { const base = L + oC + cat * nC * 2; for (let b = cbk; b; b &= b - 1) { const c = 31 - Math.clz32(b & -b); acc[base + c * 2] += q; acc[base + c * 2 + 1] += v; } }
  }
  // bills (whole network only — a bill is not split by product)
  if (mask === null) {
    const B = e.bills;
    for (let i = 0; i < B.n.length; i++) {
      const k = B.day[i] - lo; if (k < 0 || k >= span) continue;
      const L = B.loc[i] * stride;
      for (let b = wb[k]; b; b &= b - 1) acc[L + (31 - Math.clz32(b & -b)) * 4 + 3] += B.n[i];
    }
  }
  return { acc, seen, stride, oWk, oD, oC, nW, nWk, nD, nC };
}

// SKU-level closing stock of one day, streamed (COPY) into typed arrays; the
// last 8 days asked for stay in memory.
async function stockRows(e, date) {
  if (e.stock.has(date)) return e.stock.get(date);
  const cap0 = 700_000; let cap = cap0; let k = 0;
  let li = new Uint16Array(cap); let si = new Int32Array(cap); let qq = new Int32Array(cap);
  const client = await pool.connect();
  try {
    const stream = client.query(copyTo(`COPY (SELECT location_id, sku_id, SUM(qty_on_hand)::int FROM inventory_daily_snapshot
      WHERE snapshot_date = '${dayIso(dayNum(date))}' AND qty_on_hand <> 0 GROUP BY 1, 2) TO STDOUT`));   // date re-formatted: never raw input
    let rest = '';
    await pipeline(stream, new Writable({
      write(chunk, _, cb) {
        const lines = (rest + chunk.toString('utf8')).split('\n'); rest = lines.pop();
        for (const ln of lines) {
          const f = ln.split('\t'); const sx = e.skuIx.get(f[1]); const lx = e.locIx.get(f[0]);
          if (sx === undefined || lx === undefined) continue;
          if (k === cap) { cap *= 2; const g = (A, T) => { const B = new T(cap); B.set(A); return B; }; li = g(li, Uint16Array); si = g(si, Int32Array); qq = g(qq, Int32Array); }
          li[k] = lx; si[k] = sx; qq[k] = Number(f[2]); k++;
        }
        cb();
      },
    }));
  } finally { client.release(); }
  const t = { li: li.subarray(0, k), si: si.subarray(0, k), q: qq.subarray(0, k) };
  e.stock.set(date, t);
  if (e.stock.size > 8) e.stock.delete(e.stock.keys().next().value);
  return t;
}

// Closing stock per store × category for one day under a product scope.
async function stockFor(e, date, sel, nCats) {
  const t = await stockRows(e, date); const mask = maskFor(e, sel);
  const out = new Map();   // loc index → Float64Array(nCats * 2) [qty, mrp]
  for (let i = 0; i < t.q.length; i++) {
    const s = t.si[i]; if (mask && !mask[s]) continue;
    let a = out.get(t.li[i]); if (!a) { a = new Float64Array(nCats * 2); out.set(t.li[i], a); }
    const c = e.catIx[s]; a[c * 2] += t.q[i]; a[c * 2 + 1] += t.q[i] * e.mrp[s];
  }
  return out;
}

// Distinct attribute combinations of the SKUs sold on or after `fromIso` (for the
// cascading filter lists), straight from memory.
function soldAttrs(e, fromIso) {
  const seen = new Uint8Array(e.codes[0].length);
  for (let r = e.start[Math.max(0, Math.min(e.start.length - 1, dayNum(fromIso) - e.d0))]; r < e.n; r++) seen[e.sku[r]] = 1;
  const combos = new Map();
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i]) continue;
    const key = e.codes.map((c) => c[i]).join(',');
    if (!combos.has(key)) combos.set(key, e.codes.map((c, a) => e.rev[a][c[i]] ?? null));
  }
  return [...combos.values()].map(([g, c, p, sp, z, co, se]) => ({ g, c, p, sp, z, co, se }));
}

module.exports = { soldAttrs, load, current, compute, stockFor, stockRows, dayNum, dayIso, isLoaded: () => Boolean(E) };
