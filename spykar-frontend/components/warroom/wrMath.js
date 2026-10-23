// ─── War Room maths — every number on the page comes from here ──────────────
// The board (GET /war-room/board) carries, per store and period, the four
// ADDITIVE measures [units, net ₹, MRP ₹, bills]. Totals are sums of those;
// ratios are always recomputed from the summed parts (never averaged):
//   UPT = units / bills   ASP = ₹ / units   ATV = ₹ / bills
//   Disc = 1 − ₹ / MRP    GoLY = TY / LY − 1   Ach = actual / target
// so a filtered total, a store, and the exported workbook always agree.

export const PERIODS = ['cw', 'pw', 'ly', 'pwly', 'mtd', 'mtdly', 'ytd', 'ytdly'];
const Z = () => [0, 0, 0, 0];

export function sumPeriods(stores) {
  const out = Object.fromEntries(PERIODS.map((p) => [p, Z()]));
  let billsKnown = true;
  for (const s of stores) {
    for (const p of PERIODS) {
      const a = s.m[p]; const o = out[p];
      o[0] += a[0]; o[1] += a[1]; o[2] += a[2];
      if (a[3] == null) billsKnown = false; else o[3] += a[3];
    }
  }
  if (!billsKnown) for (const p of PERIODS) out[p][3] = null;
  return out;
}

export const growth = (ty, ly) => (ly ? ty / ly - 1 : null);
export const ratio = (a, b) => (b ? a / b : null);
export function kpis([q, v, mrp, b]) {
  return { qty: q, val: v, mrp, bills: b, upt: b ? q / b : null, asp: q ? v / q : null, atv: b ? v / b : null, disc: mrp ? 1 - v / mrp : null };
}

// Targets of the stores in view, per window [units, ₹] (cw / pw / mtd / ytd
// to date; week / month / fy whole). `cover` = stores in view with a target.
export const TARGET_KEYS = ['cw', 'pw', 'mtd', 'ytd', 'week', 'month', 'fy'];
export function sumTargets(stores) {
  const t = Object.fromEntries(TARGET_KEYS.map((k) => [k, [0, 0]])); let cover = 0;
  for (const s of stores) {
    if (!s.t) continue; cover++;
    for (const k of TARGET_KEYS) if (s.t[k]) { t[k][0] += s.t[k][0]; t[k][1] += s.t[k][1]; }
  }
  return { ...t, cover };
}
export const achTone = (a) => (a == null ? 'mute' : a >= 1 ? 'pos' : a >= 0.9 ? 'warn' : 'neg');
// Month run-rate: target still to sell ÷ days left, vs the pace so far.
export function runRate(monthTgt, mtdVal, P) {
  if (!monthTgt || !P) return null;
  const d = (s) => new Date(`${s}T00:00:00Z`);
  const end = d(P.mtd[0]); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const left = Math.round((end - d(P.mtd[1])) / 864e5); const done = Math.round((d(P.mtd[1]) - d(P.mtd[0])) / 864e5) + 1;
  return { left, need: monthTgt - mtdVal, perDay: left > 0 ? (monthTgt - mtdVal) / left : null, pace: mtdVal / done, ach: mtdVal / monthTgt };
}

// Weekly ₹ series (TY and LY) of the stores in view.
export function sumWeeks(stores, n) {
  const ty = new Array(n).fill(0); const ly = new Array(n).fill(0);
  for (const s of stores) for (let i = 0; i < n; i++) { ty[i] += s.wk[i] || 0; ly[i] += s.wkly[i] || 0; }
  return { ty, ly };
}

// Daily ₹ of the month (TY and LY, by day of month) of the stores in view.
export function sumDays(stores) {
  const n = stores.length ? stores[0].dy.length : 0;
  const ty = new Array(n).fill(0); const ly = new Array(n).fill(0);
  for (const s of stores) for (let i = 0; i < n; i++) { ty[i] += s.dy[i] || 0; ly[i] += s.dyly[i] || 0; }
  return { ty, ly };
}

// ── B · what moved sales: ₹ = bills × UPT × ASP ───────────────────────────────
// Each factor's ratio TY/LY; their log-shares split the ₹ change exactly
// (the parts add up to TY − LY).
export function drivers(ty, ly) {
  const a = kpis(ty); const b = kpis(ly);
  if (!(a.bills > 0 && b.bills > 0 && a.qty > 0 && b.qty > 0 && ty[1] > 0 && ly[1] > 0)) return null;   // logs need positive parts
  const f = [['Bills', a.bills / b.bills], ['UPT', a.upt / b.upt], ['ASP', a.asp / b.asp]];
  const total = ty[1] / ly[1]; const lnT = Math.log(total); const d = ty[1] - ly[1];
  return { total: total - 1, delta: d, parts: f.map(([k, r]) => ({ k, g: r - 1, rs: Math.abs(lnT) > 1e-9 ? d * (Math.log(r) / lnT) : 0 })) };
}

// ── F · weeks in a row below LY (full weeks only, newest first) ──────────────
export function streak(s) {
  let n = 0;
  for (let i = s.wk.length - 2; i >= 0; i--) { if (s.wkly[i] > 0 && s.wk[i] < s.wkly[i]) n++; else break; }
  return n;
}

// ── G · rank by week ₹ GoLY, this week vs last week ──────────────────────────
export function weekRanks(stores) {
  const ok = stores.filter((s) => s.m.ly[1] > 0 && s.m.pwly[1] > 0 && isActive(s));
  const by = (f) => [...ok].sort((a, b) => f(b) - f(a)).reduce((m, s, i) => { m[s.code] = i + 1; return m; }, {});
  const now = by((s) => s.m.cw[1] / s.m.ly[1]); const was = by((s) => s.m.pw[1] / s.m.pwly[1]);
  return Object.fromEntries(ok.map((s) => [s.code, { now: now[s.code], was: was[s.code], move: was[s.code] - now[s.code] }]));
}

// ── C · growth bridge: LY → TY by group (store dims or category) ─────────────
// → { ly, ty, rows: [{ key, ly, ty, d, share }] } sorted by contribution.
export function bridge(stores, by, period, cats, measure = 'val') {
  const LY = { cw: 'ly', mtd: 'mtdly', ytd: 'ytdly' }[period];
  const I = measure === 'qty' ? 0 : 1; let rows;
  if (by === 'category') {
    const ci = { ytd: [0, 1], mtd: [2, 3], cw: [4, 5] }[period].map((x) => (measure === 'qty' ? x : x + 6));
    const C = sumCats(stores, cats);
    rows = cats.map((c) => ({ key: c, ty: C[c][ci[0]], ly: C[c][ci[1]] }));
  } else {
    rows = groupStores(stores, by).map((g) => { const A = sumPeriods(g.stores); return { key: g.key, ty: A[period][I], ly: A[LY][I] }; });
  }
  rows = rows.filter((r) => r.ty || r.ly).map((r) => ({ ...r, d: r.ty - r.ly }));
  const ly = rows.reduce((a, r) => a + r.ly, 0); const ty = rows.reduce((a, r) => a + r.ty, 0); const D = ty - ly;
  rows.forEach((r) => { r.share = D ? r.d / Math.abs(D) : null; r.g = growth(r.ty, r.ly); });
  rows.sort((a, b) => b.d - a.d);
  return { ly, ty, rows };
}

// Category arrays per store: [ytdQ, ytdlyQ, mtdQ, mtdlyQ, cwQ, lyQ, ytdV, ytdlyV, mtdV, mtdlyV, cwV, lyV]
export function sumCats(stores, cats) {
  const out = Object.fromEntries(cats.map((c) => [c, new Array(12).fill(0)]));
  for (const s of stores) for (const [k, a] of Object.entries(s.cat || {})) { const o = out[k]; if (o) for (let i = 0; i < 12; i++) o[i] += a[i]; }
  return out;
}
// Stock per store: [qtyTY, qtyLY, mrpTY, mrpLY]
export function sumStock(stores, cats) {
  const out = Object.fromEntries(cats.map((c) => [c, [0, 0, 0, 0]]));
  for (const s of stores) for (const [k, a] of Object.entries(s.stk || {})) { const o = out[k]; if (o) for (let i = 0; i < 4; i++) o[i] += a[i]; }
  return out;
}

// ── status — the workbook's ladder on MTD ₹ GoLY ─────────────────────────────
export const STATUS = ['Growth', 'Stable', 'Soft', 'Degrowth', 'Critical', 'New', 'Closed'];
export const STATUS_TONE = { Growth: 'pos', Stable: 'info', Soft: 'warn', Degrowth: 'neg', Critical: 'crit', New: 'violet', Closed: 'mute' };
export function statusOf(s) {
  if (s.type === 'Closed' || s.closed) return 'Closed';
  if (s.type === 'New') return 'New';
  const g = growth(s.m.mtd[1], s.m.mtdly[1]);
  if (g == null) return s.m.mtd[1] > 0 ? 'New' : 'Closed';
  if (g >= 0.10) return 'Growth';
  if (g >= 0) return 'Stable';
  if (g >= -0.10) return 'Soft';
  if (g >= -0.25) return 'Degrowth';
  return 'Critical';
}
export const isActive = (s) => statusOf(s) !== 'Closed';
export const reviewed = (s) => Boolean(s.note && (s.note.reason || s.note.action));
export const typeLabel = (t) => String(t || '—');

// ── store-side Lens filters (applied in the browser) ─────────────────────────
const arr = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []);
export const STORE_DIMS = {
  wr_channel: (s) => s.channel, wr_region: (s) => s.region, wr_type: (s) => s.type,
  wr_status: (s) => statusOf(s), wr_asm: (s) => s.asm, wr_review: (s) => (reviewed(s) ? 'Reviewed' : 'Pending'),
  state: (s) => s.state, city: (s) => s.city, store_code: (s) => s.code,
};
export function filterStores(stores, lens, search) {
  const active = Object.entries(STORE_DIMS).map(([k, f]) => [f, arr(lens[k])]).filter(([, v]) => v.length);
  const q = (search || '').trim().toLowerCase();
  return stores.filter((s) => active.every(([f, v]) => v.includes(String(f(s) ?? '')))
    && (!q || `${s.code} ${s.name} ${s.city} ${s.asm}`.toLowerCase().includes(q)));
}

// Group stores (Snap view): → [{ key, stores }] sorted by key.
export function groupStores(stores, by) {
  const f = STORE_DIMS[by] || ((s) => s[by]);
  const m = new Map();
  for (const s of stores) { const k = f(s) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
  return [...m.entries()].map(([key, list]) => ({ key, stores: list })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

// ── formatting ───────────────────────────────────────────────────────────────
// ₹ in full with Indian grouping (₹2,77,75,140) — every KPI and table.
// { compact: true } only for chart axes / tight labels (₹2.78 Cr, ₹19.4 L).
export function inr(v, { compact = false, decimals } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v); const sign = v < 0 ? '−' : '';
  if (!compact || a < 1e5) return `${sign}₹${Math.round(a).toLocaleString('en-IN')}`;
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(decimals ?? (a >= 1e9 ? 0 : 2))} Cr`;
  return `${sign}₹${(a / 1e5).toFixed(decimals ?? (a >= 1e6 ? 1 : 2))} L`;
}
export const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
export const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d)}%`);
export const share = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
export const pts = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d)} pts`);
export function tone(g, { good = 0.05, bad = -0.10 } = {}) {
  if (g == null || !Number.isFinite(g)) return 'mute';
  if (g >= good) return 'pos';
  if (g <= bad) return 'neg';
  return g < 0 ? 'warn' : 'flat';
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const d0 = (s) => new Date(`${s}T00:00:00Z`);
export const fmtDay = (s, y) => { if (!s) return '—'; const d = d0(s); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}${y ? ` ’${String(d.getUTCFullYear()).slice(2)}` : ''}`; };
export const fmtDow = (s) => (s ? DOW[d0(s).getUTCDay()] : '');
export function fmtRange([a, b] = [], y) {
  if (!a) return '—';
  if (a === b) return fmtDay(a, y);
  const A = d0(a); const B = d0(b);
  if (A.getUTCMonth() === B.getUTCMonth() && A.getUTCFullYear() === B.getUTCFullYear()) return `${A.getUTCDate()}–${B.getUTCDate()} ${MON[B.getUTCMonth()]}${y ? ` ’${String(B.getUTCFullYear()).slice(2)}` : ''}`;
  return `${fmtDay(a)} – ${fmtDay(b, y)}`;
}
export const addDays = (s, n) => { const d = d0(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
