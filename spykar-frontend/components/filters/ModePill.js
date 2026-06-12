// ─── ModePill — Active / Inactive / All store-status selector ───────────────
// Rendered as a compact dropdown (was a sliding segmented pill). A native
// <select> keeps keyboard + OS-popup accessibility for free; we hide the
// default arrow (appearance:none) and paint our own chevron so it matches the
// rest of the app's pill-shaped controls. Same `{ mode, onChange }` API as
// before, so every caller (/network, /sales) works unchanged.

const OPTS = [
  { key: 'active',   label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'all',      label: 'All' },
];

// Inline chevron (slate-500) as a background-image — same technique the sales
// SelectChip / page filterSelect use, so the popup chrome themes correctly.
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%2364748b' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

export default function ModePill({ mode, onChange }) {
  return (
    <select
      aria-label="Store status"
      value={mode}
      onChange={(e) => onChange?.(e.target.value)}
      style={{
        height: 32,
        padding: '0 30px 0 14px',
        background: 'var(--bg-elevated)',
        backgroundImage: CHEVRON,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 11px center',
        border: '1px solid var(--border-default)',
        borderRadius: 999,
        fontFamily: 'var(--font-body)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        appearance: 'none',
        WebkitAppearance: 'none',
        MozAppearance: 'none',
        outline: 'none',
        transition: 'border-color 180ms cubic-bezier(0.4,0,0.2,1)',
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-border)'; }}
      onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
    >
      {OPTS.map((o) => (
        <option key={o.key} value={o.key}>{o.label}</option>
      ))}
    </select>
  );
}
