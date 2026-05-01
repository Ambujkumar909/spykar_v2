// ─── Health colors — derive ok/warn/bad/neutral from a delta or value ───────
// Every KPI card gets a health that drives the top-rail color, the delta-pill
// background, and the sparkline tint.  Centralising the logic keeps the
// thresholds tunable in one place.

// For "higher is better" metrics (sales, units, sell-through).
//   ▲ ≥ +5%   → ok
//   −2% .. 5% → neutral
//   ≤ −2%     → bad   (.. ≤ −10% bad-strong, but bad covers it)
export function healthFromDelta(delta) {
  if (delta == null || Number.isNaN(delta)) return 'neutral';
  if (delta >= 5) return 'ok';
  if (delta >= -2) return 'neutral';
  if (delta >= -10) return 'warn';
  return 'bad';
}

// For "lower is better" metrics (return rate, days-of-holding).
// Same magnitudes, inverted polarity.
export function inverseHealthFromDelta(delta) {
  if (delta == null || Number.isNaN(delta)) return 'neutral';
  if (delta <= -5) return 'ok';
  if (delta <= 2) return 'neutral';
  if (delta <= 10) return 'warn';
  return 'bad';
}

// Resolve a health key to its CSS-var color set.  These map to the v2 token
// system in globals.css under .v2-app — both light and dark mode pull from
// the same vars so the call site doesn't need to branch on theme.
export const HEALTH_TOKENS = {
  ok:      { fg: 'var(--v2-ok-500)',   bg: 'var(--v2-ok-50)',   solid: 'var(--v2-ok-500)' },
  warn:    { fg: 'var(--v2-warn-500)', bg: 'var(--v2-warn-50)', solid: 'var(--v2-warn-500)' },
  bad:     { fg: 'var(--v2-bad-500)',  bg: 'var(--v2-bad-50)',  solid: 'var(--v2-bad-500)' },
  neutral: { fg: 'var(--v2-fg-secondary)', bg: 'var(--v2-bg-elevated)', solid: 'var(--v2-info-500)' },
};
