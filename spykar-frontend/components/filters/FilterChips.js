// ─── FilterChips — active filter pills below the FilterBar ────────────────────
// Premium "what's currently filtering" indicator. Each active filter renders
// as a removable pill — click the × to instantly drop that one filter.
//
// Why this exists when the FilterBar already shows a count:
//   • Power BI / Zoho hide active filters in a side panel — users forget
//     what's filtering and get confused by "no data" results.
//   • Our chips make it obvious at a glance, and one click drops a filter.
//   • This is the single biggest UX upgrade over enterprise BI tools.
//
// Visual language:
//   • Glass pill, accent border, value-first labels (Gender: MENS, WOMENS)
//   • Multi-value chip shows count (Gender: 2)
//   • Smooth enter/exit animations — chips appear and dismiss elegantly
//   • Mode pill is shown ONLY when "all" — "active" is the default and
//     doesn't deserve visual weight

import { useMemo } from 'react';

const DIM_LABELS = {
  gender_name: 'Gender',
  sub_product: 'Sub-product',
  product:     'Product',
  category:    'Category',
  style:       'Style',
  shade:       'Shade',
  color:       'Colour',
  size:        'Size',
  season:      'Season',
  state:       'State',
  city:        'City',
  group_name:  'Party',
  store_code:  'Store',
  brand:       'Brand',
  size:        'Size',
};

export default function FilterChips({ filters, setFilter, clearAll }) {
  const chips = useMemo(() => {
    const out = [];
    Object.entries(filters || {}).forEach(([k, v]) => {
      if (k === 'mode' || k === 'asOfDate' || k === 'page' || k === 'limit') return;
      if (v === undefined || v === null || v === '') return;
      const arr = Array.isArray(v) ? v : [v];
      if (arr.length === 0) return;
      out.push({
        key:   k,
        label: DIM_LABELS[k] || k.replace(/_/g, ' '),
        value: arr.length === 1 ? arr[0] : `${arr.length} selected`,
        full:  arr.join(', '),
      });
    });
    // Mode chip — only show when 'all' (active is default, no weight needed)
    if (filters?.mode === 'all') {
      out.push({ key: '__mode', label: 'Mode', value: 'All stores (incl. closed)', full: 'all' });
    }
    return out;
  }, [filters]);

  if (!chips.length) return null;

  return (
    <div
      style={{
        display: 'flex', flexWrap: 'wrap', gap: 6,
        padding: '8px 24px 14px',
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 16, marginTop: -16,
      }}
    >
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'var(--text-muted)',
        padding: '6px 0',
        marginRight: 4,
      }}>Showing</span>
      {chips.map(chip => (
        <Chip
          key={chip.key}
          label={chip.label}
          value={chip.value}
          full={chip.full}
          onRemove={() => {
            if (chip.key === '__mode') setFilter('mode', 'active');
            else setFilter(chip.key, undefined);
          }}
        />
      ))}
      <button
        type="button"
        onClick={clearAll}
        style={{
          padding: '6px 12px',
          background: 'transparent', border: 'none',
          color: 'var(--text-muted)', cursor: 'pointer',
          fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.04em',
          borderRadius: 999,
          transition: 'all 140ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent-primary)'; e.currentTarget.style.background = 'var(--accent-glow)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
      >Reset all</button>
    </div>
  );
}

function Chip({ label, value, full, onRemove }) {
  return (
    <div
      title={full}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 28, padding: '0 4px 0 12px',
        background: '#fff',
        border: '1px solid var(--accent-border)',
        borderRadius: 999,
        boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
        animation: 'chipIn 220ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}>{label}</span>
      <span style={{
        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
        maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        style={{
          width: 22, height: 22, marginLeft: 2,
          padding: 0, border: 'none', cursor: 'pointer',
          background: 'transparent', color: 'var(--text-muted)',
          borderRadius: 999,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 140ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-glow)'; e.currentTarget.style.color = 'var(--accent-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent';        e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
      </button>
      <style jsx>{`
        @keyframes chipIn {
          from { opacity: 0; transform: translateY(-3px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
