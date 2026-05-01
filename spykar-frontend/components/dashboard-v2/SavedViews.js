// ─── SavedViews — pre-baked filter/timeRange combinations the execs reach for ─
// Phase 4 ships hardcoded views (CEO, Buying, Regional, Aging Risk).  Phase 5
// will persist user-defined views to the backend.
//
// Each view is a recipe { name, description, preset, mode, filters, anchor }
// — applying it just calls the corresponding setter on the page hooks.

import { useEffect, useRef, useState } from 'react';
import { Bookmark, ChevronDown, Check, Plus } from 'lucide-react';

export const VIEWS = [
  {
    id:    'ceo',
    name:  'CEO View',
    desc:  'All India · MTD · top-line numbers only',
    preset: 'mtd',
  },
  {
    id:    'buying',
    name:  'Buying View',
    desc:  'All channels · MTD · category × aging focus',
    preset: 'mtd',
    anchor: '#aging',
  },
  {
    id:    'regional',
    name:  'Regional Head View',
    desc:  'Filtered to your assigned region',
    preset: 'mtd',
    requiresUser: true,
  },
  {
    id:    'aging',
    name:  'Aging Risk',
    desc:  '90+ day inventory across the network',
    preset: 'ytd',
    anchor: '#aging',
  },
];

export default function SavedViews({ currentViewId, onApply }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const popRef     = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!triggerRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = VIEWS.find(v => v.id === currentViewId) || VIEWS[0];

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 34, padding: '0 12px',
          background: open ? 'var(--v2-bg-elevated)' : 'var(--v2-bg-card)',
          border: '1px solid var(--v2-border)',
          borderRadius: 10,
          fontFamily: 'var(--v2-font-body)',
          fontSize: 12, fontWeight: 600,
          color: 'var(--v2-fg-primary)',
          cursor: 'pointer',
          transition: 'background 160ms, border-color 160ms',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.borderColor = 'var(--v2-border-strong)'; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.borderColor = 'var(--v2-border)'; }}
      >
        <Bookmark size={13} />
        {current.name}
        <ChevronDown size={12} style={{
          color: 'var(--v2-fg-tertiary)',
          transition: 'transform 200ms',
          transform: open ? 'rotate(180deg)' : 'none',
        }} />
      </button>

      {open && (
        <div
          ref={popRef}
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0,
            width: 280,
            background: 'var(--v2-bg-card)',
            border: '1px solid var(--v2-border-strong)',
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(10,11,13,0.16), 0 0 0 1px rgba(10,11,13,0.04)',
            padding: 6,
            zIndex: 60,
            animation: 'v2FadeInUp 200ms var(--v2-ease) both',
          }}
        >
          <div style={{ padding: '6px 10px 8px', borderBottom: '1px solid var(--v2-border)' }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--v2-fg-tertiary)' }}>
              Saved Views
            </div>
            <div style={{ fontSize: 11, color: 'var(--v2-fg-tertiary)', marginTop: 2 }}>
              One-click recipe of time range + filters
            </div>
          </div>

          {VIEWS.map(v => (
            <button
              key={v.id}
              type="button"
              role="menuitem"
              onClick={() => { onApply?.(v); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                width: '100%', textAlign: 'left',
                padding: '10px 10px',
                background: v.id === current.id ? 'var(--v2-bg-elevated)' : 'transparent',
                border: 'none', borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'var(--v2-font-body)',
                color: 'inherit',
                transition: 'background 120ms',
              }}
              onMouseEnter={e => { if (v.id !== current.id) e.currentTarget.style.background = 'var(--v2-bg-elevated)'; }}
              onMouseLeave={e => { if (v.id !== current.id) e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ width: 18, paddingTop: 2, flexShrink: 0 }}>
                {v.id === current.id && <Check size={14} style={{ color: 'var(--v2-brand-500)' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--v2-fg-primary)' }}>
                  {v.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--v2-fg-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                  {v.desc}
                </div>
              </div>
            </button>
          ))}

          <div style={{ borderTop: '1px solid var(--v2-border)', marginTop: 4, padding: '6px 4px 2px' }}>
            <button
              type="button"
              disabled
              title="User-defined views land in Phase 5"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '8px 10px',
                background: 'transparent', border: 'none', borderRadius: 8,
                cursor: 'not-allowed', opacity: 0.55,
                fontSize: 12, fontWeight: 600, color: 'var(--v2-fg-secondary)',
              }}
            >
              <Plus size={13} />
              Save current view
              <span style={{
                marginLeft: 'auto',
                fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--v2-fg-tertiary)',
              }}>Soon</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
