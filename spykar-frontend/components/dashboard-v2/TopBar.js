// ─── TopBar — Zone A of the v2 dashboard ────────────────────────────────────
// Left:    Spykar logo + wordmark
// Center:  TimeRangeControl segmented pill
// Right:   Sync pill (single source of truth — no LIVE/synced 6h contradiction),
//          Saved Views dropdown, Filter button, theme toggle, avatar
//
// Keep it horizontally tight — execs will resent vertical real-estate stolen.

import { useEffect, useState } from 'react';
import { Sun, Moon, ChevronDown } from 'lucide-react';
import TimeRangeControl from './TimeRangeControl';

// Inline header filters — same model as the /sales header (a labelled capsule
// with a borderless select). Replaces the old Saved-Views dropdown + Filters
// drawer button so the dashboard's filters live right in the bar.
const MODE_OPTIONS = [
  { key: 'active',   label: 'Active Stores'   },
  { key: 'inactive', label: 'Inactive Stores' },
  { key: 'all',      label: 'All Stores'      },
];
const VALUATION_OPTIONS = [
  { key: 'gross',    label: 'Gross (with GST)' },
  { key: 'ex_gst',   label: 'Ex-GST (revenue)' },
  { key: 'gst',      label: 'GST collected'    },
  { key: 'mrp',      label: 'At MRP'           },
  { key: 'discount', label: 'Discount given'   },
];

function FieldSelect({ label, value, onChange, options, minWidth = 120, title }) {
  return (
    <label
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, height: 34,
        padding: '0 6px 0 12px', borderRadius: 10,
        background: 'var(--v2-bg-card)', border: '1px solid var(--v2-border)',
        cursor: 'pointer', transition: 'border-color 160ms var(--v2-ease)',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--v2-border-strong)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--v2-border)'; }}
    >
      <span style={{
        fontSize: 9.5, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--v2-fg-tertiary)',
        whiteSpace: 'nowrap', fontFamily: 'var(--v2-font-body)',
      }}>{label}</span>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select
          value={value}
          onChange={e => onChange?.(e.target.value)}
          style={{
            height: 28, padding: '0 22px 0 4px',
            background: 'transparent', border: 'none',
            fontFamily: 'var(--v2-font-body)', fontSize: 12, fontWeight: 700,
            color: 'var(--v2-fg-primary)', cursor: 'pointer',
            appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
            outline: 'none', minWidth,
          }}
        >
          {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <ChevronDown size={13} style={{ position: 'absolute', right: 5, pointerEvents: 'none', color: 'var(--v2-fg-tertiary)' }} />
      </div>
    </label>
  );
}

function IconButton({ children, onClick, title, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel || title}
      style={{
        width: 34, height: 34,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--v2-bg-card)',
        border: '1px solid var(--v2-border)',
        borderRadius: 10,
        color: 'var(--v2-fg-secondary)',
        cursor: 'pointer',
        transition: 'all 160ms var(--v2-ease)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--v2-border-strong)';
        e.currentTarget.style.color = 'var(--v2-fg-primary)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--v2-border)';
        e.currentTarget.style.color = 'var(--v2-fg-secondary)';
      }}
    >
      {children}
    </button>
  );
}

export default function TopBar({
  preset,
  onPresetChange,
  // Custom date range — only used when preset === 'custom'
  fromISO,
  toISO,
  onCustomRangeChange,
  isDark,
  onToggleTheme,
  mode,
  onModeChange,
  valuation,
  onValuationChange,
  user,
}) {
  const showCustomPickers = preset === 'custom';
  return (
    <header
      className="v2-topbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        // When the custom date row is visible, header grows from 64 to 96
        // so the pickers sit cleanly below the time control without
        // floating over the page content.
        minHeight: 64,
        padding: showCustomPickers ? '10px 24px' : '0 24px',
        background: 'var(--v2-bg-card)',
        borderBottom: '1px solid var(--v2-border)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        flexWrap: 'wrap',
        rowGap: 10,
      }}
    >
      {/* Left — brand */}
      <div className="v2-topbar__brand" style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, var(--v2-brand-500), var(--v2-brand-600))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 800, fontSize: 14,
          fontFamily: 'var(--v2-font-display)',
          boxShadow: '0 2px 6px rgba(225, 29, 46, 0.30)',
        }}>S</div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{
            fontFamily: 'var(--v2-font-display)',
            fontWeight: 700, fontSize: 14,
            color: 'var(--v2-fg-primary)',
            letterSpacing: '-0.01em',
          }}>
            Spykar IQ
          </div>
          <div style={{
            fontFamily: 'var(--v2-font-body)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--v2-fg-tertiary)',
          }}>
            Inventory Intelligence
          </div>
        </div>
      </div>

      {/* Center — time control */}
      <div className="v2-topbar__range" style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <TimeRangeControl preset={preset} onChange={onPresetChange} />
      </div>

      {/* Right — controls. Inline filters (same pattern as /sales): a Status
          and a Valuation capsule, no drawer/button, no saved-views. */}
      <div className="v2-topbar__actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <FieldSelect
          label="Status"
          value={mode}
          onChange={onModeChange}
          options={MODE_OPTIONS}
          minWidth={96}
          title="Which subset of the network to count"
        />
        <FieldSelect
          label="Valuation"
          value={valuation}
          onChange={onValuationChange}
          options={VALUATION_OPTIONS}
          minWidth={130}
          title="What ₹ basis each money figure reports"
        />

        <IconButton
          onClick={onToggleTheme}
          title={`${isDark ? 'Switch to light mode' : 'Switch to boardroom (dark) mode'} (D)`}
        >
          {isDark ? <Sun size={15} /> : <Moon size={15} />}
        </IconButton>

      </div>

      {/* Custom range pickers — only render when the user has chosen
          "Custom" in the time pill.  Sits on its own line below the
          rest of the header so it never crowds the existing controls. */}
      {showCustomPickers && (
        <div
          style={{
            flexBasis: '100%',
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 0 0',
            borderTop: '1px solid var(--v2-border)',
            marginTop: 6,
          }}
        >
          <span style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--v2-fg-tertiary)',
            paddingRight: 6,
          }}>
            Custom range
          </span>
          <DateField
            label="From"
            value={fromISO}
            max={toISO}
            onChange={(v) => onCustomRangeChange?.(v, toISO)}
          />
          <span style={{ color: 'var(--v2-fg-tertiary)', fontSize: 13 }}>→</span>
          <DateField
            label="To"
            value={toISO}
            min={fromISO}
            onChange={(v) => onCustomRangeChange?.(fromISO, v)}
          />
          <span style={{
            marginLeft: 'auto',
            fontSize: 11, fontWeight: 600,
            color: 'var(--v2-fg-tertiary)',
          }}>
            Pick a from-date and to-date — every KPI, chart and the right rail re-fetches
          </span>
        </div>
      )}
    </header>
  );
}

// Tight date-field used by the custom range row.  Native <input type="date">
// keeps keyboard accessibility + OS calendar popup free; we just style the
// chrome to match the rest of the TopBar.
function DateField({ label, value, min, max, onChange }) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: 34, padding: '0 10px',
      background: 'var(--v2-bg-elevated)',
      border: '1px solid var(--v2-border)',
      borderRadius: 10,
      cursor: 'pointer',
    }}>
      <span style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--v2-fg-tertiary)',
      }}>
        {label}
      </span>
      <input
        type="date"
        value={value || ''}
        min={min || undefined}
        max={max || undefined}
        onChange={(e) => onChange?.(e.target.value)}
        style={{
          background: 'transparent',
          border: 'none', outline: 'none',
          fontFamily: 'var(--v2-font-body)',
          fontSize: 12, fontWeight: 600,
          color: 'var(--v2-fg-primary)',
          padding: 0,
          minWidth: 110,
        }}
      />
    </label>
  );
}
