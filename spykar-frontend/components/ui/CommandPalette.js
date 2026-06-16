// ─── CommandPalette — ⌘K / Ctrl+K elite navigation overlay ────────────────────
// One keystroke jumps to any page or runs any common action. This is the
// single biggest UX move that separates Linear/Stripe/Notion from Power BI/
// Zoho — and now from this dashboard, too.
//
// Why it's elite UX:
//   • No mouse needed — power users live in the keyboard
//   • Fuzzy search — typing "ven" finds "Inventory"
//   • Recent commands surfaced first — muscle memory wins
//   • Visual hint visible on Header so new users discover it
//
// Activation:
//   • ⌘K (mac) / Ctrl+K (Windows) — global shortcut
//   • Esc to dismiss
//   • Enter to execute, ↑↓ to navigate

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';

const COMMANDS = [
  { id: 'go-overview',     section: 'Navigate', label: 'Overview',          hint: 'Executive summary',           keys: 'g o', path: '/' },
  { id: 'go-network',      section: 'Navigate', label: 'EBO Network',       hint: 'All locations + filters',     keys: 'g n', path: '/network' },
  { id: 'go-sales',        section: 'Navigate', label: 'Sales Analytics',   hint: 'Velocity, returns, trends',    keys: 'g s', path: '/sales' },
  { id: 'go-locations',    section: 'Navigate', label: 'Locations',         hint: 'Per-store deep-dive',          keys: 'g l', path: '/locations' },
  { id: 'go-distributors', section: 'Navigate', label: 'Distributors',      hint: 'Channel partners',             keys: 'g d', path: '/distributors' },
  { id: 'go-alerts',       section: 'Navigate', label: 'Stock Alerts',      hint: 'Low/out-of-stock SKUs',        keys: 'g a', path: '/alerts' },
  { id: 'go-movements',    section: 'Navigate', label: 'Movements',         hint: 'Sales & return ledger',        keys: 'g m', path: '/movements' },
  { id: 'go-ai',           section: 'Navigate', label: 'AI Query',          hint: 'Ask anything in plain English',keys: 'g q', path: '/ai-query' },
  { id: 'go-sync',         section: 'Navigate', label: 'Sync',              hint: 'ETL status & logs',            keys: 'g y', path: '/sync' },
  { id: 'go-users',        section: 'Navigate', label: 'Users',             hint: 'Admin: roles & access',        keys: 'g u', path: '/users' },

  { id: 'filter-mens',     section: 'Quick filters', label: 'Filter: MENS only',         hint: 'Shows men\'s SKUs everywhere',     keys: '',     path: '/network?gender=MENS' },
  { id: 'filter-womens',   section: 'Quick filters', label: 'Filter: WOMENS only',       hint: 'Shows women\'s SKUs everywhere',   keys: '',     path: '/network?gender=WOMENS' },
  { id: 'filter-denim',    section: 'Quick filters', label: 'Filter: Denim only',        hint: 'Jeans + denim across stores',      keys: '',     path: '/network?category=denim' },
  { id: 'filter-tshirts',  section: 'Quick filters', label: 'Filter: T-Shirts only',     hint: 'T-shirt category',                 keys: '',     path: '/network?category=t-shirt' },
  { id: 'filter-mh',       section: 'Quick filters', label: 'Maharashtra stores',        hint: 'All stores in MH',                 keys: '',     path: '/network?state=MAHARASHTRA' },
  { id: 'filter-closed',   section: 'Quick filters', label: 'Show closed stores too',    hint: 'Mode = All',                       keys: '',     path: '/network?mode=all' },
];

function fuzzy(q, s) {
  if (!q) return true;
  const ql = q.toLowerCase().replace(/\s+/g, '');
  const sl = s.toLowerCase();
  let i = 0;
  for (const ch of sl) {
    if (ch === ql[i]) i++;
    if (i >= ql.length) return true;
  }
  return false;
}

export default function CommandPalette() {
  const router    = useRouter();
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [active, setActive]   = useState(0);
  const [recent, setRecent]   = useState([]);
  const inputRef              = useRef(null);
  const listRef               = useRef(null);

  // ── Keyboard: ⌘K / Ctrl+K to open, Esc to close ───────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
      const cmdK  = (isMac ? e.metaKey : e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (cmdK) { e.preventDefault(); setOpen(o => !o); return; }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus input on open, reset state on close
  useEffect(() => {
    if (open) {
      setQuery(''); setActive(0);
      setTimeout(() => inputRef.current?.focus(), 50);
      try { setRecent(JSON.parse(localStorage.getItem('cmdk:recent') || '[]')); } catch {}
    }
  }, [open]);

  // Filtered, ordered list — recents first, then sectioned
  const items = useMemo(() => {
    const filtered = COMMANDS.filter(c => fuzzy(query, c.label + ' ' + c.hint));
    if (!query && recent.length) {
      const recentSet = new Set(recent);
      const recentItems = recent.map(id => COMMANDS.find(c => c.id === id)).filter(Boolean);
      const rest        = filtered.filter(c => !recentSet.has(c.id));
      return [...recentItems.map(c => ({ ...c, section: 'Recent' })), ...rest];
    }
    return filtered;
  }, [query, recent]);

  const execute = (cmd) => {
    if (!cmd) return;
    // Save to recents
    try {
      const next = [cmd.id, ...recent.filter(id => id !== cmd.id)].slice(0, 5);
      localStorage.setItem('cmdk:recent', JSON.stringify(next));
    } catch {}
    setOpen(false);
    if (cmd.path) router.push(cmd.path);
  };

  // Keyboard navigation in the list
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
      if (e.key === 'Enter')     { e.preventDefault(); execute(items[active]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, active]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-cmd-idx="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(15,23,42,0.45)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        paddingTop: '14vh',
        animation: 'paletteFadeIn 220ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)',
          background: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(28px) saturate(200%)',
          WebkitBackdropFilter: 'blur(28px) saturate(200%)',
          border: '1px solid var(--border-default)',
          borderRadius: 18,
          boxShadow: '0 32px 96px rgba(15,23,42,0.24), 0 8px 24px rgba(15,23,42,0.10)',
          overflow: 'hidden',
          animation: 'paletteSlideIn 320ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Search input */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <svg width="18" height="18" viewBox="0 0 18 18" style={{ color: 'var(--text-muted)' }}>
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.6" fill="none"/>
            <path d="M12 12l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            placeholder="Search pages, filters, actions..."
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 500,
              color: 'var(--text-primary)',
            }}
          />
          <Kbd>esc</Kbd>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ maxHeight: '54vh', overflowY: 'auto', padding: '8px 0' }}>
          {items.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
              No matches for "<strong>{query}</strong>"
            </div>
          )}
          {(() => {
            const rendered = [];
            let lastSection = null;
            items.forEach((c, i) => {
              if (c.section !== lastSection) {
                rendered.push(
                  <div key={`sec-${i}`} style={{
                    padding: '10px 20px 4px', fontSize: 10, fontWeight: 800,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                  }}>{c.section}</div>
                );
                lastSection = c.section;
              }
              const isActive = i === active;
              rendered.push(
                <div
                  key={c.id}
                  data-cmd-idx={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => execute(c)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 20px',
                    cursor: 'pointer',
                    background: isActive ? 'var(--accent-glow)' : 'transparent',
                    borderLeft: `3px solid ${isActive ? 'var(--accent-primary)' : 'transparent'}`,
                    transition: 'background 100ms',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600,
                      color: 'var(--text-primary)',
                    }}>{c.label}</div>
                    {c.hint && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>
                        {c.hint}
                      </div>
                    )}
                  </div>
                  {c.keys && (
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {c.keys.split(' ').map((k, j) => <Kbd key={j}>{k}</Kbd>)}
                    </span>
                  )}
                </div>
              );
            });
            return rendered;
          })()}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 20px',
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--bg-elevated)',
          fontSize: 11, color: 'var(--text-muted)',
        }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <span><Kbd>↑↓</Kbd> navigate</span>
            <span><Kbd>↵</Kbd> select</span>
          </div>
          <span style={{ fontWeight: 600 }}>Spykar IQ</span>
        </div>
      </div>

      <style jsx global>{`
        @keyframes paletteFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes paletteSlideIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

function Kbd({ children }) {
  return (
    <kbd style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 22, height: 22, padding: '0 6px',
      background: '#fff',
      border: '1px solid var(--border-default)',
      borderRadius: 5,
      boxShadow: '0 1px 0 rgba(15,23,42,0.05)',
      fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700,
      color: 'var(--text-muted)',
      letterSpacing: '0.02em',
    }}>{children}</kbd>
  );
}
