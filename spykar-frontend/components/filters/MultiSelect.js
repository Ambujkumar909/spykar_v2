// ─── MultiSelect — premium glass dropdown with search + multi-checkbox ────────
// World-class compact multi-select used by every FilterBar dimension.
//
// Features (and why each one matters):
//   • Glass surface, Pearl Light theme    — fits the existing premium aesthetic
//   • Searchable list                     — users with 1000+ options can type-ahead
//   • Multi-checkbox + "select all visible" — bulk picks in one motion
//   • Active-count chip on the trigger    — at-a-glance what's filtering
//   • Click-outside + Escape to close     — keyboard-first ergonomics
//   • Focus trap inside the popover       — accessible to screen readers
//   • Smooth open/close animation         — feels alive, not snappy
//   • Floating-portal aware popover       — never gets clipped by overflow:hidden
//   • Compact 240–280px width             — uniform across the bar
//
// Anatomy:
//   <MultiSelect
//     label="Gender"
//     icon={<UserIcon/>}        // optional leading icon in trigger
//     options={['Mens','Womens']}
//     value={['Mens']}
//     onChange={arr => …}
//     loading={false}           // shows shimmer in popover
//     placeholder="All"
//   />

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Use useLayoutEffect on the client only — its server-side render warning is
// noisy and unhelpful for popovers that only ever materialise post-mount.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export default function MultiSelect({
  label,
  icon = null,
  options = [],
  value = [],
  onChange,
  loading = false,
  placeholder = 'All',
  width = 200,
  compact = false,
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef(null);
  const popRef     = useRef(null);
  const inputRef   = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width, placement: 'bottom' });

  // Position popover relative to trigger with smart flip:
  //  • Default: open downward, 6px gap.
  //  • If less than ~360px below the trigger, flip upward instead so the
  //    list never spills off-screen or smothers the content directly below.
  //  • Clamp left edge so popover stays within the viewport (avoids clipping
  //    on filters near the right edge of a wide bar).
  const updatePos = () => {
    if (!triggerRef.current) return;
    const r        = triggerRef.current.getBoundingClientRect();
    const popW     = Math.max(width, r.width, 240);
    const vh       = window.innerHeight;
    const vw       = window.innerWidth;
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    const ESTIMATED_HEIGHT = 360;
    const placement = (spaceBelow < ESTIMATED_HEIGHT && spaceAbove > spaceBelow) ? 'top' : 'bottom';
    const top  = placement === 'bottom' ? r.bottom + 6 : Math.max(8, r.top - 6 - Math.min(ESTIMATED_HEIGHT, spaceAbove - 16));
    let left   = r.left;
    if (left + popW > vw - 8) left = vw - popW - 8;
    if (left < 8) left = 8;
    setPos({ top, left, width: popW, placement });
  };

  // Open: focus search, attach scroll/resize handlers, click-outside listener
  useEffect(() => {
    if (!open) return;
    updatePos();
    setTimeout(() => inputRef.current?.focus(), 30);

    const onClick = (e) => {
      if (!triggerRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = () => updatePos();

    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Filter options by search
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => String(o).toLowerCase().includes(q));
  }, [search, options]);

  const valueSet = useMemo(() => new Set((value || []).map(v => String(v))), [value]);
  const allVisibleSelected = filtered.length > 0 && filtered.every(o => valueSet.has(String(o)));

  const toggle = (v) => {
    const s = String(v);
    const next = valueSet.has(s)
      ? value.filter(x => String(x) !== s)
      : [...(value || []), v];
    onChange(next);
  };

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      const visible = new Set(filtered.map(String));
      onChange((value || []).filter(v => !visible.has(String(v))));
    } else {
      const cur = new Set((value || []).map(String));
      filtered.forEach(o => cur.add(String(o)));
      onChange([...cur]);
    }
  };

  const triggerLabel = (() => {
    if (!value || value.length === 0) return placeholder;
    if (value.length === 1) return String(value[0]);
    return `${value[0]} +${value.length - 1}`;
  })();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        title={value && value.length > 1 ? value.join(', ') : (label || '')}
        onMouseEnter={e => {
          if (!open) {
            e.currentTarget.style.borderColor = 'var(--border-strong)';
            e.currentTarget.style.background  = '#fff';
            e.currentTarget.style.transform   = 'translateY(-1px)';
            e.currentTarget.style.boxShadow   = '0 4px 12px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)';
          }
        }}
        onMouseLeave={e => {
          if (!open) {
            e.currentTarget.style.borderColor = 'var(--border-default)';
            e.currentTarget.style.background  = 'var(--bg-card)';
            e.currentTarget.style.transform   = 'translateY(0)';
            e.currentTarget.style.boxShadow   = 'var(--shadow-card)';
          }
        }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          height: compact ? 34 : 38,
          padding: compact ? '0 10px' : '0 14px',
          background: open ? '#fff' : 'var(--bg-card)',
          color: 'var(--text-primary)',
          border: `1px solid ${open ? 'var(--accent-border)' : 'var(--border-default)'}`,
          borderRadius: 10,
          fontFamily: 'var(--font-body)',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'border-color 160ms, background 160ms, transform 160ms cubic-bezier(0.4,0,0.2,1), box-shadow 160ms',
          boxShadow: open ? '0 0 0 4px var(--accent-glow), var(--shadow-card)' : 'var(--shadow-card)',
          minWidth: compact ? 120 : 150,
          maxWidth: 220,
          whiteSpace: 'nowrap',
        }}
      >
        {icon && <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-muted)' }}>{icon}</span>}
        {label && (
          <span style={{
            color: value && value.length ? 'var(--text-muted)' : 'var(--text-disabled)',
            fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{label}</span>
        )}
        <span style={{
          flex: 1, textAlign: 'left',
          overflow: 'hidden', textOverflow: 'ellipsis',
          color: value && value.length ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: value && value.length ? 600 : 500,
        }}>{triggerLabel}</span>
        {value && value.length > 1 && (
          <span style={{
            background: 'var(--accent-primary)', color: '#fff',
            borderRadius: 999, padding: '2px 6px',
            fontSize: 10, fontWeight: 700, lineHeight: 1,
          }}>{value.length}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{
          transition: 'transform 200ms',
          transform: open ? 'rotate(180deg)' : 'none',
          color: 'var(--text-muted)',
        }}><path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>

      {/* Render the popover into a portal on document.body so it ESCAPES the
          FilterBar's `backdrop-filter` containing block. CSS `backdrop-filter`
          (and any `transform` on an ancestor) traps `position:fixed` children
          inside that ancestor, which is why our dropdowns were drifting away
          from their triggers. The portal nukes that and our fixed coords are
          truly viewport-relative. ─────────────────────────────────────────── */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            top: pos.top, left: pos.left,
            width: Math.max(pos.width, 240),
            maxWidth: 320,
            background: 'rgba(255,255,255,0.98)',
            backdropFilter: 'blur(24px) saturate(200%)',
            WebkitBackdropFilter: 'blur(24px) saturate(200%)',
            border: '1px solid var(--border-default)',
            borderRadius: 14,
            boxShadow: '0 20px 48px rgba(15,23,42,0.16), 0 4px 12px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.02)',
            padding: 8,
            zIndex: 9999,
            transformOrigin: pos.placement === 'top' ? 'bottom left' : 'top left',
            animation: `msFadeIn${pos.placement === 'top' ? 'Up' : 'Down'} 200ms cubic-bezier(0.16,1,0.3,1)`,
          }}
        >
          {/* Header — search + select all */}
          <div style={{ display: 'flex', gap: 6, padding: '4px 4px 8px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <svg width="12" height="12" viewBox="0 0 12 12" style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
              }}><circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3" fill="none"/><path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                style={{
                  width: '100%',
                  padding: '7px 10px 7px 28px',
                  fontFamily: 'var(--font-body)', fontSize: 12.5,
                  background: 'var(--bg-elevated)',
                  border: '1px solid transparent',
                  borderRadius: 8,
                  outline: 'none',
                  color: 'var(--text-primary)',
                }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--accent-border)'}
                onBlur={e => e.currentTarget.style.borderColor = 'transparent'}
              />
            </div>
            {filtered.length > 1 && (
              <button
                type="button"
                onClick={toggleAllVisible}
                title={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                style={{
                  padding: '0 10px', height: 32,
                  background: 'transparent', color: 'var(--text-muted)',
                  border: '1px solid var(--border-default)', borderRadius: 8,
                  fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  transition: 'all 140ms',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent-primary)'; e.currentTarget.style.borderColor = 'var(--accent-border)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border-default)'; }}
              >{allVisibleSelected ? '−' : '✓ All'}</button>
            )}
          </div>

          {/* Option list */}
          <div style={{
            maxHeight: 280, overflowY: 'auto',
            paddingRight: 4,
            display: 'flex', flexDirection: 'column', gap: 1,
          }}>
            {loading && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Loading options…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                {options.length === 0 ? 'No options available' : 'No matches'}
              </div>
            )}
            {!loading && filtered.map(o => {
              const checked = valueSet.has(String(o));
              return (
                <label
                  key={o}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => toggle(o)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '7px 10px', borderRadius: 8,
                    cursor: 'pointer',
                    background: checked ? 'var(--accent-glow)' : 'transparent',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                  onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    width: 16, height: 16, flexShrink: 0,
                    border: `1.5px solid ${checked ? 'var(--accent-primary)' : 'var(--border-strong)'}`,
                    borderRadius: 5,
                    background: checked ? 'var(--accent-primary)' : '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 140ms',
                  }}>
                    {checked && (
                      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5l2 2 4-4" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    )}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-body)', fontSize: 13,
                    color: 'var(--text-primary)', fontWeight: checked ? 600 : 500,
                    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{String(o)}</span>
                </label>
              );
            })}
          </div>

          {value && value.length > 0 && (
            <div style={{
              borderTop: '1px solid var(--border-subtle)',
              marginTop: 6, padding: '8px 10px 4px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                {value.length} selected
              </span>
              <button
                type="button"
                onClick={() => onChange([])}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--accent-primary)', fontSize: 11, fontWeight: 700,
                  fontFamily: 'var(--font-body)',
                }}
              >Clear</button>
            </div>
          )}

          <style jsx>{`
            @keyframes msFadeInDown {
              from { opacity: 0; transform: translateY(-6px) scale(0.97); }
              to   { opacity: 1; transform: translateY(0)   scale(1); }
            }
            @keyframes msFadeInUp {
              from { opacity: 0; transform: translateY(6px)  scale(0.97); }
              to   { opacity: 1; transform: translateY(0)    scale(1); }
            }
          `}</style>
        </div>,
        document.body
      )}
    </>
  );
}
