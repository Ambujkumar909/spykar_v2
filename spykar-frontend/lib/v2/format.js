// ─── Number formatting — Indian locale, executive readability ───────────────
// Every metric on the dashboard flows through one of these.  Tabular figures
// are required at the call site (`className="tabular-nums"`); these helpers
// don't add styling.

const N = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ₹ figure — 1 Cr threshold.  Prefer crores for the executive eye.
export function formatINR(value) {
  const n = N(value);
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
}

// Plain compact (units, store counts) — same crore thresholds, no ₹.
export function formatCompact(value) {
  const n = N(value);
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(abs).toLocaleString('en-IN')}`;
}

// Percentage with one decimal — used by sell-through, return rate, deltas.
export function formatPct(value, { decimals = 1 } = {}) {
  const n = N(value);
  if (n == null) return '—';
  return `${n.toFixed(decimals)}%`;
}

// Delta pill text — "▲ 8.2%" / "▼ 0.4 pp" / "—".  Caller decides
// the unit (% vs pp); this just shapes the arrow + abs value.
export function formatDelta(pct, { unit = '%', decimals = 1 } = {}) {
  const n = N(pct);
  if (n == null) return '—';
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '·';
  return `${arrow} ${Math.abs(n).toFixed(decimals)}${unit}`;
}

// % delta between two raw values.  Returns null if last-year base is 0/missing
// so the caller can render "—" instead of an infinite/NaN delta.
export function pctDelta(current, base) {
  const c = N(current); const b = N(base);
  if (c == null || b == null || b === 0) return null;
  return ((c - b) / Math.abs(b)) * 100;
}
