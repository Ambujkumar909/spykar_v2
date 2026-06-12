// ─── FilterDrawer — slide-in filter panel from the right ─────────────────────
// Replaces the giant on-page filter strip from the existing /  Overview.
// Phase 4 ships Time / Mode / Valuation — the operationally most-used set.
// Phase 5 will add Network (zone/state/store/party) and Product (gender/
// sub-product/category/style/shade/colour/size/season) sections, wired to
// the existing useFilters/MultiSelect components.

import { motion, AnimatePresence } from 'framer-motion';
import { X, RotateCcw, Check, ChevronDown } from 'lucide-react';
import { PRESETS } from '../../lib/v2/useTimeRange';

const PRESET_LABELS = {
  today: 'Today', wtd: 'Week to date', mtd: 'Month to date',
  qtd: 'Quarter to date', ytd: 'Year to date', custom: 'Custom range',
};

const MODE_OPTIONS = [
  { key: 'active',   label: 'Active stores',   desc: 'Currently-open locations only' },
  { key: 'inactive', label: 'Inactive stores', desc: 'Closed locations only' },
  { key: 'all',      label: 'All stores',      desc: 'Every location regardless of status' },
];

const VALUATION_OPTIONS = [
  { key: 'gross',    label: 'Gross (with GST)' },
  { key: 'ex_gst',   label: 'Ex-GST revenue' },
  { key: 'gst',      label: 'GST collected' },
  { key: 'mrp',      label: 'At MRP' },
  { key: 'discount', label: 'Discount given' },
];

export default function FilterDrawer({
  open,
  onClose,
  preset, onPresetChange,
  mode, onModeChange,
  valuation, onValuationChange,
  onResetAll,
  activeFilterCount = 0,
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            style={{
              position: 'fixed', inset: 0,
              background: 'rgba(10,11,13,0.40)',
              backdropFilter: 'blur(2px)',
              zIndex: 200,
            }}
          />

          {/* Drawer */}
          <motion.aside
            role="dialog" aria-modal="true" aria-label="Filters"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 36, mass: 0.7 }}
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0,
              width: 'min(420px, 90vw)',
              background: 'var(--v2-bg-card)',
              borderLeft: '1px solid var(--v2-border)',
              boxShadow: '-12px 0 40px rgba(10,11,13,0.18)',
              zIndex: 201,
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* Header */}
            <header style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '16px 20px',
              borderBottom: '1px solid var(--v2-border)',
              flexShrink: 0,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: 'var(--v2-font-display)',
                  fontSize: 16, fontWeight: 800,
                  color: 'var(--v2-fg-primary)',
                  letterSpacing: '-0.01em',
                }}>
                  Filters
                </div>
                <div style={{ fontSize: 12, color: 'var(--v2-fg-tertiary)', marginTop: 2 }}>
                  {activeFilterCount > 0 ? `${activeFilterCount} active` : 'Default view'}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close filters"
                style={{
                  width: 34, height: 34, border: '1px solid var(--v2-border)',
                  borderRadius: 8, background: 'var(--v2-bg-card)',
                  color: 'var(--v2-fg-secondary)',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <X size={16} />
              </button>
            </header>

            {/* Body — scrollable */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <Section title="Time" hint="Window for sales, units, and the heatmap">
                <Pillset
                  options={PRESETS}
                  value={preset}
                  onChange={onPresetChange}
                  labelFor={k => PRESET_LABELS[k] || k}
                />
              </Section>

              <Section title="Store Mode" hint="Which subset of the network to count">
                <Dropdown
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={onModeChange}
                />
              </Section>

              <Section title="Valuation Basis" hint="What ₹ figure each money number reports">
                <RadioList
                  options={VALUATION_OPTIONS}
                  value={valuation}
                  onChange={onValuationChange}
                />
              </Section>

              <Section title="Network · Product" hint="Multi-select filters" comingSoon />
            </div>

            {/* Footer — sticky reset / apply */}
            <footer style={{
              display: 'flex', gap: 10,
              padding: '14px 20px',
              borderTop: '1px solid var(--v2-border)',
              background: 'var(--v2-bg-card)',
              flexShrink: 0,
            }}>
              <button
                type="button"
                onClick={onResetAll}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 38, padding: '0 14px',
                  background: 'transparent',
                  border: '1px solid var(--v2-border-strong)',
                  borderRadius: 10,
                  color: 'var(--v2-fg-secondary)',
                  fontFamily: 'var(--v2-font-body)',
                  fontSize: 12, fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <RotateCcw size={13} />
                Reset
              </button>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  height: 38, padding: '0 16px',
                  background: 'var(--v2-brand-500)',
                  border: '1px solid var(--v2-brand-500)',
                  borderRadius: 10,
                  color: '#FFFFFF',
                  fontFamily: 'var(--v2-font-body)',
                  fontSize: 12, fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(225,29,46,0.20)',
                }}
              >
                <Check size={14} />
                {activeFilterCount > 0 ? `Apply (${activeFilterCount})` : 'Done'}
              </button>
            </footer>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Section({ title, hint, children, comingSoon }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{
          fontSize: 11, fontWeight: 800,
          letterSpacing: '0.10em', textTransform: 'uppercase',
          color: 'var(--v2-fg-tertiary)',
        }}>
          {title}
        </div>
        {comingSoon && (
          <span style={{
            padding: '1px 6px', borderRadius: 999,
            background: 'var(--v2-bg-elevated)',
            border: '1px solid var(--v2-border)',
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--v2-fg-tertiary)',
          }}>Phase 5</span>
        )}
      </div>
      {hint && (
        <div style={{ fontSize: 11.5, color: 'var(--v2-fg-tertiary)', marginBottom: 10 }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

function Pillset({ options, value, onChange, labelFor }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map(o => {
        const active = o === value;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange?.(o)}
            style={{
              padding: '7px 12px',
              background: active ? 'var(--v2-fg-primary)' : 'var(--v2-bg-elevated)',
              border: `1px solid ${active ? 'var(--v2-fg-primary)' : 'var(--v2-border)'}`,
              borderRadius: 999,
              fontFamily: 'var(--v2-font-body)',
              fontSize: 12, fontWeight: 700,
              color: active ? 'var(--v2-fg-inverse)' : 'var(--v2-fg-primary)',
              cursor: 'pointer',
              transition: 'background 120ms, border-color 120ms',
            }}
          >
            {labelFor ? labelFor(o) : o}
          </button>
        );
      })}
    </div>
  );
}

// Clean native-select dropdown, styled to match the drawer. Native <select>
// keeps keyboard + OS popup accessibility for free; we only restyle the closed
// control and overlay our own chevron (appearance:none hides the default one).
function Dropdown({ options, value, onChange }) {
  return (
    <div style={{ position: 'relative' }}>
      <select
        value={value}
        onChange={e => onChange?.(e.target.value)}
        style={{
          width: '100%',
          appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
          height: 40, padding: '0 38px 0 12px',
          background: 'var(--v2-bg-elevated)',
          border: '1px solid var(--v2-border-strong)',
          borderRadius: 10,
          color: 'var(--v2-fg-primary)',
          fontFamily: 'var(--v2-font-body)',
          fontSize: 12.5, fontWeight: 700,
          cursor: 'pointer', outline: 'none',
          transition: 'border-color 140ms var(--v2-ease)',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--v2-brand-500)'; }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--v2-border-strong)'; }}
      >
        {options.map(o => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      <ChevronDown
        size={16}
        style={{
          position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
          pointerEvents: 'none', color: 'var(--v2-fg-tertiary)',
        }}
      />
    </div>
  );
}

function RadioList({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map(o => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange?.(o.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              width: '100%', textAlign: 'left',
              padding: '10px 12px',
              background: active ? 'var(--v2-bg-elevated)' : 'transparent',
              border: `1px solid ${active ? 'var(--v2-border-strong)' : 'var(--v2-border)'}`,
              borderRadius: 10,
              cursor: 'pointer', color: 'inherit',
              fontFamily: 'var(--v2-font-body)',
              transition: 'background 120ms, border-color 120ms',
            }}
          >
            <span style={{
              width: 16, height: 16, borderRadius: '50%',
              border: `2px solid ${active ? 'var(--v2-brand-500)' : 'var(--v2-border-strong)'}`,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {active && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--v2-brand-500)' }} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--v2-fg-primary)' }}>
                {o.label}
              </div>
              {o.desc && (
                <div style={{ fontSize: 11, color: 'var(--v2-fg-tertiary)', marginTop: 2 }}>
                  {o.desc}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
