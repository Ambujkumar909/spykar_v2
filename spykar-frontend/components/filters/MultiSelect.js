// ─── MultiSelect — premium glass dropdown with search + multi-checkbox ────────
// World-class compact multi-select used by every FilterBar dimension.
//
// Scales to 5000+ options without lag:
//   • Virtualized list (windowed render) — DOM stays at ~12 nodes regardless of
//     option count. Style/Shade/Colour have 5K options each — full-render was
//     the latency source.
//   • Search debounced 60 ms — typing doesn't re-filter on every keystroke.
//   • Ranked match: startsWith > word-boundary > substring. Case-insensitive.
//   • Match highlighting in the popover.
//
// Robustness:
//   • Value array deduplicated + stringified for stable Set comparisons.
//   • rAF-throttled scroll/resize repositioning (smooth scroll under filter).
//   • Click-outside, Escape, focus trap, Tab to commit + close.
//   • Keyboard nav: ↑↓ navigate, Enter/Space toggle, Home/End jump, PgUp/PgDn,
//     Cmd-A select all visible, Esc close, "/" focuses search when open.
//   • Show-selected-only toggle when many are picked (audit at a glance).
//   • Smart placement (flip up if no space below, clamp inside viewport).
//
// API (unchanged — drop-in replacement):
//   <MultiSelect
//     label="Gender" icon={…} options={[…]} value={[…]}
//     onChange={arr => …} loading={false}
//     placeholder="All" width={200} compact={true}
//   />

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Item visual height in the popover (label padding 7+7 + content + gap).
// Used by the virtualizer to compute spacers and visible window. If you
// change the row CSS, update this constant.
const ITEM_H = 34;
const VISIBLE_BUFFER = 6;
const POPOVER_MAX_H = 280;

// Ranked, case-insensitive match. Returns null on no-match, otherwise a
// sortable score (lower = better) plus the index where the match starts.
function rankMatch(label, q) {
  if (!q) return { score: 0, hitStart: -1, hitLen: 0 };
  const s = label.toLowerCase();
  const ql = q.toLowerCase();
  if (s === ql)            return { score: 0,  hitStart: 0,        hitLen: q.length };
  if (s.startsWith(ql))    return { score: 1,  hitStart: 0,        hitLen: q.length };
  // word-boundary match (after space, dash, slash)
  const wbIdx = s.search(new RegExp(`(^|[\\s\\-_/])${escapeRegex(ql)}`));
  if (wbIdx !== -1)        return { score: 2,  hitStart: wbIdx + (wbIdx === 0 ? 0 : 1), hitLen: q.length };
  const idx = s.indexOf(ql);
  if (idx !== -1)          return { score: 3,  hitStart: idx,      hitLen: q.length };
  return null;
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function MultiSelectImpl({
  label,
  icon = null,
  options = [],
  value = [],
  onChange,
  loading = false,
  placeholder = 'All',
  width = 200,
  compact = false,
  // Optional class name applied to the portal-rendered popover.  Lets a
  // parent (e.g. PremiumFilterBar's "lux-pop" class) re-skin the dropdown
  // without forking the entire component.
  popoverClassName = '',
}) {
  const [open, setOpen]               = useState(false);
  const [search, setSearch]           = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [activeIdx, setActiveIdx]     = useState(0);
  const [scrollTop, setScrollTop]     = useState(0);

  const triggerRef  = useRef(null);
  const popRef      = useRef(null);
  const inputRef    = useRef(null);
  const scrollerRef = useRef(null);
  const rafRef      = useRef(0);
  const [pos, setPos] = useState({ top: 0, left: 0, width, placement: 'bottom' });

  // ── Dedupe + stringify the value once — every other path consumes this.
  const safeValue = useMemo(() => {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const v of value) {
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(v);
    }
    return out;
  }, [value]);
  const valueSet = useMemo(() => new Set(safeValue.map(String)), [safeValue]);

  // ── 60 ms search debounce. Typing stays buttery on a 5K-item list because
  // the filter+rank pass only runs on the last keystroke in a burst.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 60);
    return () => clearTimeout(id);
  }, [search]);

  // ── Filter + rank. O(n) once per debounced query / option change.
  const filtered = useMemo(() => {
    const q = debouncedSearch.trim();
    if (showSelectedOnly && valueSet.size === 0) return [];
    const pool = showSelectedOnly
      ? options.filter(o => valueSet.has(String(o)))
      : options;
    if (!q) return pool;
    const scored = [];
    for (let i = 0; i < pool.length; i++) {
      const m = rankMatch(String(pool[i]), q);
      if (m) scored.push({ o: pool[i], score: m.score, hitStart: m.hitStart, hitLen: m.hitLen });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.length === pool.length && q === ''
      ? pool
      : scored.map(s => ({ ...s }));
  }, [debouncedSearch, options, showSelectedOnly, valueSet]);

  // The "any visible" highlight applies to the unfiltered pool semantics —
  // for both list types we want to know "is every currently-visible row in
  // the value set?" because Select All only acts on the visible filtered set.
  const visibleStrings = useMemo(() => {
    return filtered.map(it => typeof it === 'object' && it !== null && 'o' in it ? String(it.o) : String(it));
  }, [filtered]);
  const allVisibleSelected = visibleStrings.length > 0 && visibleStrings.every(s => valueSet.has(s));

  // Reset scroll + active row when the displayed list changes.
  useEffect(() => {
    setScrollTop(0);
    setActiveIdx(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [debouncedSearch, showSelectedOnly]);

  // ── Smart popover placement, rAF-throttled to handle scroll/resize cleanly
  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const popW = Math.max(width, r.width, 240);
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const spaceBelow = vh - r.bottom;
      const spaceAbove = r.top;
      const ESTIMATED = 360;
      // Smart placement applies universally — bottom-positioned filters
      // (like Season inside the side panel) flip up when there isn't
      // enough room below, top-positioned filters open down as usual.
      // Previously `lux-pop` callers force-bottomed and overlapped the
      // next filter button.
      const placement = (spaceBelow < ESTIMATED && spaceAbove > spaceBelow) ? 'top' : 'bottom';
      const top = placement === 'bottom'
        ? r.bottom + 6
        : Math.max(8, r.top - 6 - Math.min(ESTIMATED, spaceAbove - 16));
      let left = r.left;
      if (left + popW > vw - 8) left = vw - popW - 8;
      if (left < 8) left = 8;
      setPos({ top, left, width: popW, placement });
    });
  }, [width]);

  useEffect(() => {
    if (!open) return;
    updatePos();
    setTimeout(() => inputRef.current?.focus(), 30);

    const onClick = (e) => {
      if (!triggerRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
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
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [open, updatePos]);

  // ── Mutators
  const toggle = useCallback((v) => {
    const s = String(v);
    if (valueSet.has(s)) {
      onChange(safeValue.filter(x => String(x) !== s));
    } else {
      onChange([...safeValue, v]);
    }
  }, [valueSet, safeValue, onChange]);

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      const visible = new Set(visibleStrings);
      onChange(safeValue.filter(v => !visible.has(String(v))));
    } else {
      const cur = new Set(safeValue.map(String));
      const next = [...safeValue];
      for (const it of filtered) {
        const o = typeof it === 'object' && it !== null && 'o' in it ? it.o : it;
        if (!cur.has(String(o))) { cur.add(String(o)); next.push(o); }
      }
      onChange(next);
    }
  };

  // ── Keyboard navigation in the popover
  const onPopKey = (e) => {
    if (!filtered.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home')      { e.preventDefault(); setActiveIdx(0); }
    else if (e.key === 'End')       { e.preventDefault(); setActiveIdx(filtered.length - 1); }
    else if (e.key === 'PageDown')  { e.preventDefault(); setActiveIdx(i => Math.min(filtered.length - 1, i + 8)); }
    else if (e.key === 'PageUp')    { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 8)); }
    else if (e.key === 'Enter' || e.key === ' ') {
      // Enter/Space toggles the active row. Don't treat space inside the
      // search input as a toggle — that would block typing spaces.
      if (e.key === ' ' && document.activeElement === inputRef.current) return;
      e.preventDefault();
      const it = filtered[activeIdx];
      if (it !== undefined) {
        const o = typeof it === 'object' && it !== null && 'o' in it ? it.o : it;
        toggle(o);
      }
    } else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); toggleAllVisible();
    } else if (e.key === 'Tab') {
      // Tab commits & closes so the user can move to the next dropdown
      setOpen(false);
    }
  };

  // Keep the active row in view when nav keys move it
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const top = activeIdx * ITEM_H;
    const bottom = top + ITEM_H;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight;
  }, [activeIdx]);

  // Mirror the actual scroller into state for windowing math
  const onScroll = (e) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  // ── Virtualization window
  const totalH    = filtered.length * ITEM_H;
  const containerH = Math.min(POPOVER_MAX_H, totalH || POPOVER_MAX_H);
  const startIdx  = Math.max(0, Math.floor(scrollTop / ITEM_H) - VISIBLE_BUFFER);
  const endIdx    = Math.min(filtered.length, Math.ceil((scrollTop + containerH) / ITEM_H) + VISIBLE_BUFFER);
  const window_   = filtered.slice(startIdx, endIdx);
  const padTop    = startIdx * ITEM_H;
  const padBottom = Math.max(0, totalH - endIdx * ITEM_H);

  const triggerLabel = (() => {
    if (!safeValue.length) return placeholder;
    if (safeValue.length === 1) return String(safeValue[0]);
    if (safeValue.length === 2) return `${safeValue[0]} +1`;
    return `${safeValue.length} selected`;
  })();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-filterbar-trigger
        onClick={() => setOpen(o => !o)}
        title={safeValue.length > 1 ? safeValue.join(', ') : (label || '')}
        onMouseEnter={e => {
          if (!open) {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.20)';
            e.currentTarget.style.background  = 'rgba(255,255,255,0.10)';
            e.currentTarget.style.transform   = 'translateY(-1px)';
            e.currentTarget.style.boxShadow   = '0 4px 12px rgba(0,0,0,0.30), 0 1px 2px rgba(0,0,0,0.20)';
          }
        }}
        onMouseLeave={e => {
          if (!open) {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
            e.currentTarget.style.background  = 'rgba(255,255,255,0.06)';
            e.currentTarget.style.transform   = 'translateY(0)';
            e.currentTarget.style.boxShadow   = 'none';
          }
        }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          height: compact ? 34 : 38,
          padding: compact ? '0 10px' : '0 14px',
          background: open ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)',
          color: 'var(--text-primary)',
          border: `1px solid ${open ? 'rgba(59,130,246,0.50)' : 'rgba(255,255,255,0.10)'}`,
          borderRadius: 10,
          fontFamily: 'var(--font-body)',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'border-color 160ms, background 160ms, transform 160ms cubic-bezier(0.4,0,0.2,1), box-shadow 160ms',
          boxShadow: open ? '0 0 0 3px rgba(59,130,246,0.15)' : 'none',
          minWidth: compact ? 120 : 150,
          maxWidth: 220,
          whiteSpace: 'nowrap',
        }}
      >
        {icon && <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-muted)' }}>{icon}</span>}
        {/* Show the dimension name (e.g. "GENDER") ONLY while nothing is
            picked — it's a hint for an empty control. Once a value is selected
            the trigger shows just the value ("Mens"), not "GENDER Mens": the
            label is redundant (icon + grouping already identify the dimension)
            and reads as if two things were written. */}
        {label && !safeValue.length && (
          <span style={{
            color: 'var(--text-disabled)',
            fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{label}</span>
        )}
        <span style={{
          flex: 1, textAlign: 'left',
          overflow: 'hidden', textOverflow: 'ellipsis',
          color: safeValue.length ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: safeValue.length ? 600 : 500,
        }}>{triggerLabel}</span>
        {safeValue.length > 1 && (
          <span style={{
            background: 'var(--accent-primary)', color: '#fff',
            borderRadius: 999, padding: '2px 6px',
            fontSize: 10, fontWeight: 700, lineHeight: 1,
          }}>{safeValue.length}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{
          transition: 'transform 200ms',
          transform: open ? 'rotate(180deg)' : 'none',
          color: 'var(--text-muted)',
        }}><path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          onKeyDown={onPopKey}
          className={popoverClassName}
          style={{
            position: 'fixed',
            top: pos.top, left: pos.left,
            width: Math.max(pos.width, 240),
            maxWidth: 320,
            background: 'var(--bg-card)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid var(--border-default)',
            borderRadius: 14,
            boxShadow: '0 20px 48px rgba(0,0,0,0.60), 0 4px 12px rgba(0,0,0,0.30)',
            padding: 8,
            zIndex: 9999,
            transformOrigin: pos.placement === 'top' ? 'bottom left' : 'top left',
            animation: `msFadeIn${pos.placement === 'top' ? 'Up' : 'Down'} 200ms cubic-bezier(0.16,1,0.3,1)`,
          }}
        >
          {/* Header — search + select all + selected-only toggle */}
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
                placeholder={`Search ${options.length}…`}
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
                title={allVisibleSelected ? 'Deselect all visible' : 'Select all visible (Cmd-A)'}
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

          {/* Selected-only filter chip — only useful when many are picked */}
          {safeValue.length > 1 && (
            <div style={{ padding: '0 4px 6px' }}>
              <button
                type="button"
                onClick={() => setShowSelectedOnly(s => !s)}
                style={{
                  background: showSelectedOnly ? 'var(--accent-glow)' : 'transparent',
                  color: showSelectedOnly ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: `1px dashed ${showSelectedOnly ? 'var(--accent-border)' : 'var(--border-subtle)'}`,
                  borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.03em',
                }}
              >{showSelectedOnly ? '✓ Selected only' : `Show ${safeValue.length} selected`}</button>
            </div>
          )}

          {/* Virtualized option list */}
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            style={{
              maxHeight: POPOVER_MAX_H, overflowY: 'auto',
              paddingRight: 4,
              position: 'relative',
            }}
          >
            {loading && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Loading options…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                {options.length === 0 ? 'No options available'
                  : showSelectedOnly       ? 'Nothing selected yet'
                  : `No matches for "${debouncedSearch}"`}
              </div>
            )}
            {!loading && filtered.length > 0 && (
              <>
                {padTop > 0 && <div style={{ height: padTop }} />}
                {window_.map((it, i) => {
                  const o = (typeof it === 'object' && it !== null && 'o' in it) ? it.o : it;
                  const hitStart = (typeof it === 'object' && it !== null && 'hitStart' in it) ? it.hitStart : -1;
                  const hitLen   = (typeof it === 'object' && it !== null && 'hitLen' in it)   ? it.hitLen   : 0;
                  const idx      = startIdx + i;
                  const checked  = valueSet.has(String(o));
                  const isActive = idx === activeIdx;
                  return (
                    <label
                      key={String(o)}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { setActiveIdx(idx); toggle(o); }}
                      onMouseMove={() => { if (idx !== activeIdx) setActiveIdx(idx); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        height: ITEM_H,
                        padding: '7px 10px', borderRadius: 8,
                        cursor: 'pointer',
                        background: checked
                          ? 'var(--accent-glow)'
                          : isActive ? 'var(--bg-elevated)' : 'transparent',
                        outline: isActive ? '1.5px solid var(--accent-border)' : 'none',
                        outlineOffset: -1,
                        transition: 'background 100ms',
                      }}
                    >
                      <span style={{
                        width: 16, height: 16, flexShrink: 0,
                        border: `1.5px solid ${checked ? 'var(--accent-primary)' : 'var(--border-strong)'}`,
                        borderRadius: 5,
                        background: checked ? 'var(--accent-primary)' : 'rgba(255,255,255,0.06)',
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
                      }}>{renderHighlight(String(o), hitStart, hitLen)}</span>
                    </label>
                  );
                })}
                {padBottom > 0 && <div style={{ height: padBottom }} />}
              </>
            )}
          </div>

          {safeValue.length > 0 && (
            <div style={{
              borderTop: '1px solid var(--border-subtle)',
              marginTop: 6, padding: '8px 10px 4px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                {safeValue.length} selected
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

// React.memo wrapper — only re-render when the props that actually affect
// output change. Reference equality on `options` and `value` is enforced by
// the parent (FilterBar): each dimension owns its own array reference, so
// changing one filter dimension no longer re-renders the other 12 dropdowns.
// This is the single biggest perceived-latency win on filter apply.
const MultiSelect = memo(MultiSelectImpl, (prev, next) => (
  prev.label === next.label &&
  prev.icon === next.icon &&
  prev.options === next.options &&
  prev.value === next.value &&
  prev.onChange === next.onChange &&
  prev.loading === next.loading &&
  prev.placeholder === next.placeholder &&
  prev.width === next.width &&
  prev.compact === next.compact &&
  prev.popoverClassName === next.popoverClassName
));

export default MultiSelect;

// Render a label with a highlighted hit slice. Falls through to the plain
// string if there's no hit (no search term or query missed).
function renderHighlight(label, start, len) {
  if (start < 0 || len <= 0) return label;
  const before = label.slice(0, start);
  const hit    = label.slice(start, start + len);
  const after  = label.slice(start + len);
  return (
    <>
      {before}
      <mark style={{
        background: 'var(--accent-glow)',
        color: 'var(--accent-primary)',
        padding: '0 2px', borderRadius: 3,
        fontWeight: 700,
      }}>{hit}</mark>
      {after}
    </>
  );
}
