import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  LayoutDashboard, Globe, TrendingUp, RefreshCw, LogOut, UserCog, Menu, X,
} from 'lucide-react';
import { useAuth } from '../../lib/auth-context';
import PremiumFilterBar from './PremiumFilterBar';

const NAV = [
  {
    section: 'Main',
    items: [
      { label: 'Overview',      href: '/',        icon: LayoutDashboard, color: '#EF4444', glow: 'rgba(239,68,68,0.15)' },
      { label: 'EBO Network',   href: '/network', icon: Globe,           color: '#3B82F6', glow: 'rgba(59,130,246,0.15)' },
      { label: 'Sales & Returns', href: '/sales', icon: TrendingUp,      color: '#10B981', glow: 'rgba(16,185,129,0.15)' },
    ],
  },
  {
    section: 'System',
    items: [
      { label: 'Sync Status',     href: '/sync',  icon: RefreshCw, color: '#F59E0B', glow: 'rgba(245,158,11,0.12)', roles: ['SUPER_ADMIN'] },
      { label: 'User Management', href: '/users', icon: UserCog,   color: '#A855F7', glow: 'rgba(168,85,247,0.12)', roles: ['SUPER_ADMIN', 'ADMIN'] },
    ],
  },
];

// Routes that carry the Lens filter cluster (mirrors PremiumFilterBar's own
// FILTER_ROUTES). Used to decide whether the mobile drawer shows the filters.
const FILTER_ROUTES = new Set(['/network', '/sales']);

// matchMedia-driven mobile flag. SSR-safe: starts false (so the server and the
// first client render agree → no hydration mismatch), then corrects on mount.
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mq.matches);
    update();
    // addEventListener('change') is the modern API; addListener is the
    // Safari < 14 fallback.
    if (mq.addEventListener) mq.addEventListener('change', update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', update);
      else mq.removeListener(update);
    };
  }, []);
  return isMobile;
}

export default function Sidebar() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', expanded ? '240px' : '64px');
  }, [expanded]);

  // Navigating (tap a nav item) closes the drawer.
  useEffect(() => { setDrawerOpen(false); }, [router.asPath]);

  // Lock the page behind the drawer while it's open so the body doesn't
  // scroll under the overlay on touch.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  // Escape closes the drawer (hardware keyboards / accessibility).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const isActive = (href) => {
    if (href === '/') return router.pathname === '/';
    return router.pathname.startsWith(href);
  };

  // ── Mobile: a beautiful slide-in drawer that IS the sidebar ──────────────
  if (isMobile) {
    return (
      <MobileNav
        user={user}
        logout={logout}
        isActive={isActive}
        open={drawerOpen}
        onOpen={() => setDrawerOpen(true)}
        onClose={() => setDrawerOpen(false)}
        showFilters={FILTER_ROUTES.has(router.pathname)}
      />
    );
  }

  // ── Desktop: the hover-to-expand rail (unchanged) ────────────────────────
  const W_CLOSED = 64;
  const W_OPEN   = 240;

  return (
    <aside
      className="app-sidebar"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      style={{
        position: 'fixed',
        top: 0, left: 0, bottom: 0,
        width: expanded ? W_OPEN : W_CLOSED,
        background: 'linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-canvas) 100%)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        overflow: 'hidden',
        transition: 'width 280ms cubic-bezier(0.16,1,0.3,1)',
        boxShadow: expanded ? '4px 0 32px rgba(15,23,42,0.16)' : 'none',
      }}
    >
      {/* ── Logo ── */}
      <div style={{
        height: 64,
        padding: '0 16px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
        overflow: 'hidden',
      }}>
        {/* Icon-mark (always visible) */}
        <div style={{
          width: 32, height: 32,
          borderRadius: 10,
          background: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          boxShadow: '0 4px 12px rgba(239,68,68,0.35)',
        }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: 14, fontWeight: 900,
            color: '#fff', letterSpacing: '-0.02em',
          }}>S</span>
        </div>

        {/* Full name — visible only when expanded */}
        <div style={{
          opacity: expanded ? 1 : 0,
          transform: expanded ? 'translateX(0)' : 'translateX(-8px)',
          transition: 'opacity 200ms ease, transform 200ms ease',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}>
          <img
            className="brand-logo-img"
            src="/spykar-logo.png"
            alt="Spykar"
            style={{ height: 26, width: 'auto', maxWidth: 120, objectFit: 'contain', objectPosition: 'left center', display: 'block' }}
            onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
          />
          <div style={{ display: 'none', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, color: 'var(--text-primary)' }}>Spykar IQ</div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.12em', fontWeight: 700, textTransform: 'uppercase', marginTop: 2 }}>
            Intelligence
          </div>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '12px 8px' }}>
        {NAV.map((group) => (
          <div key={group.section} style={{ marginBottom: 24 }}>
            {/* Section label — visible only when expanded */}
            <div style={{
              fontSize: 9, fontWeight: 800,
              color: 'var(--text-disabled)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '0 8px',
              marginBottom: 6,
              fontFamily: 'var(--font-body)',
              opacity: expanded ? 1 : 0,
              height: expanded ? 20 : 0,
              overflow: 'hidden',
              transition: 'opacity 180ms ease, height 200ms ease',
              whiteSpace: 'nowrap',
            }}>
              {group.section}
            </div>

            {group.items
              .filter((item) => !item.roles || item.roles.includes(user?.role))
              .map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);

                return (
                  <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                    <div
                      className="nav-item"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '0 8px',
                        height: 40,
                        borderRadius: 10,
                        marginBottom: 2,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        background: active ? item.glow : 'transparent',
                        color: active ? item.color : 'var(--text-muted)',
                        border: active ? `1px solid ${item.color}30` : '1px solid transparent',
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                      onMouseEnter={e => {
                        if (!active) {
                          e.currentTarget.style.background = item.glow;
                          e.currentTarget.style.color = item.color;
                        }
                      }}
                      onMouseLeave={e => {
                        if (!active) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = '#64748B';
                        }
                      }}
                    >
                      {/* Active left bar */}
                      {active && (
                        <div style={{
                          position: 'absolute',
                          left: 0, top: '20%', bottom: '20%',
                          width: 3,
                          borderRadius: '0 3px 3px 0',
                          background: item.color,
                          boxShadow: `0 0 10px ${item.color}`,
                        }} />
                      )}

                      {/* Icon — always visible, centered when collapsed */}
                      <div style={{
                        width: 30, height: 30,
                        borderRadius: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: active ? `${item.color}22` : 'transparent',
                        transition: 'background 0.15s',
                        flexShrink: 0,
                        marginLeft: expanded ? 0 : 'auto',
                        marginRight: expanded ? 0 : 'auto',
                      }}>
                        <Icon size={15} strokeWidth={active ? 2.5 : 2} />
                      </div>

                      {/* Label — slides in when expanded */}
                      <span style={{
                        fontSize: 13,
                        fontWeight: active ? 700 : 500,
                        fontFamily: 'var(--font-body)',
                        letterSpacing: '-0.01em',
                        whiteSpace: 'nowrap',
                        opacity: expanded ? 1 : 0,
                        transform: expanded ? 'translateX(0)' : 'translateX(-6px)',
                        transition: 'opacity 180ms ease, transform 180ms ease',
                        color: 'inherit',
                      }}>
                        {item.label}
                      </span>

                      {/* NEW badge — flag the v2 dashboard while it's behind the feature flag */}
                      {item.badge && expanded && (
                        <span style={{
                          marginLeft: 'auto',
                          padding: '2px 6px',
                          background: 'rgba(240,58,74,0.18)',
                          color: '#F03A4A',
                          border: '1px solid rgba(240,58,74,0.35)',
                          borderRadius: 999,
                          fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
                          fontFamily: 'var(--font-body)',
                          opacity: expanded ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}>{item.badge}</span>
                      )}

                      {/* Tooltip when collapsed */}
                      {!expanded && (
                        <div className="nav-tooltip">{item.label}{item.badge ? ' · NEW' : ''}</div>
                      )}
                    </div>
                  </Link>
                );
              })}
          </div>
        ))}

        {/* ─── Luxury filter cluster ───────────────────────────────────
            Sits at the BOTTOM of the nav rail, below every nav item
            (including User Management).  Visible only on /network and
            /sales (the panel returns null elsewhere) and only when the
            rail is hovered open.  Mounts on hover / unmounts on leave
            so the heavy MultiSelects don't pay a render cost when the
            rail is collapsed and any open dropdown closes naturally
            when the cursor leaves the sidebar. ─────────────────────── */}
        <div className="app-sidebar__filters">
          <PremiumFilterBar isOpen={expanded} />
        </div>
      </nav>

      {/* ── User footer ── */}
      <div style={{
        padding: '10px 8px',
        borderTop: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 8px', borderRadius: 10,
          overflow: 'hidden',
        }}>
          {/* Avatar */}
          <div style={{
            width: 30, height: 30,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #EF4444, #DC2626)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 800, color: '#fff',
            flexShrink: 0,
            fontFamily: 'var(--font-display)',
            boxShadow: '0 2px 8px rgba(239,68,68,0.30)',
            marginLeft: expanded ? 0 : 'auto',
            marginRight: expanded ? 0 : 'auto',
          }}>
            {user?.name?.[0]?.toUpperCase() || 'S'}
          </div>

          {/* Name + role */}
          <div style={{
            flex: 1, overflow: 'hidden',
            opacity: expanded ? 1 : 0,
            transform: expanded ? 'translateX(0)' : 'translateX(-6px)',
            transition: 'opacity 180ms ease, transform 180ms ease',
            whiteSpace: 'nowrap',
          }}>
            <div style={{
              fontSize: 13, fontWeight: 600,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-body)',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {user?.name || 'User'}
            </div>
            <div style={{
              fontSize: 10, color: 'var(--text-muted)',
              fontFamily: 'var(--font-body)',
              fontWeight: 600, letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              {user?.role?.replace(/_/g, ' ') || 'Viewer'}
            </div>
          </div>

          {expanded && (
            <button
              onClick={logout}
              title="Logout"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', padding: 6, borderRadius: 8,
                display: 'flex', alignItems: 'center',
                transition: 'all 0.15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'var(--accent-primary)';
                e.currentTarget.style.background = 'var(--accent-glow)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'var(--text-muted)';
                e.currentTarget.style.background = 'none';
              }}
            >
              <LogOut size={14} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── MobileNav — the sidebar, reborn as a slide-in drawer ────────────────────
// Touch devices have no hover, so the desktop expand-on-hover rail can never
// open. On phones we instead render a floating launcher pill (always visible,
// bottom-left) that opens a full-height drawer carrying the SAME nav items and
// the SAME Lens filter cluster. Everything here is self-contained inline /
// scoped styled-jsx — it never touches the desktop `.app-sidebar` rules.
function MobileNav({ user, logout, isActive, open, onOpen, onClose, showFilters }) {
  // Current section label for the launcher pill — turns the floating button
  // into a "you are here + tap to navigate" affordance instead of a mystery
  // hamburger.
  const allItems = NAV.flatMap(g => g.items);
  const current  = allItems.find(i => isActive(i.href));
  const CurrentIcon = current?.icon || LayoutDashboard;
  const currentColor = current?.color || '#EF4444';

  return (
    <>
      {/* ── Floating launcher ── */}
      <button
        type="button"
        className="mnav-trigger"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={onOpen}
      >
        <span className="mnav-trigger__mark" style={{ '--mk': currentColor }}>
          <CurrentIcon size={16} strokeWidth={2.4} />
        </span>
        <span className="mnav-trigger__label">{current?.label || 'Menu'}</span>
        <span className="mnav-trigger__bars" aria-hidden><Menu size={18} strokeWidth={2.4} /></span>
      </button>

      {/* ── Scrim ── */}
      <div
        className={`mnav-scrim${open ? ' is-open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />

      {/* ── Drawer ── */}
      <aside className={`mnav-drawer${open ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-label="Navigation">
        {/* Header — brand + close */}
        <div className="mnav-head">
          <div className="mnav-brand">
            <span className="mnav-brand__mark">S</span>
            <span className="mnav-brand__txt">
              <span className="mnav-brand__name">Spykar IQ</span>
              <span className="mnav-brand__sub">Intelligence</span>
            </span>
          </div>
          <button type="button" className="mnav-close" aria-label="Close navigation" onClick={onClose}>
            <X size={18} strokeWidth={2.4} />
          </button>
        </div>

        {/* Scrollable body — nav + filters */}
        <div className="mnav-body">
          {NAV.map((group) => {
            const items = group.items.filter((item) => !item.roles || item.roles.includes(user?.role));
            if (items.length === 0) return null;
            return (
              <div key={group.section} className="mnav-group">
                <div className="mnav-group__label">{group.section}</div>
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link key={item.href} href={item.href} className="mnav-link" style={{ textDecoration: 'none' }}>
                      <span
                        className={`mnav-item${active ? ' is-active' : ''}`}
                        style={{ '--c': item.color, '--glow': item.glow }}
                      >
                        <span className="mnav-item__icon"><Icon size={18} strokeWidth={active ? 2.5 : 2} /></span>
                        <span className="mnav-item__label">{item.label}</span>
                        {active && <span className="mnav-item__dot" />}
                      </span>
                    </Link>
                  );
                })}
              </div>
            );
          })}

          {/* Lens filters — only on routes that carry them. PremiumFilterBar
              returns null elsewhere, but gating keeps the heavy Panel from
              mounting until the drawer is actually open. */}
          {showFilters && (
            <div className="mnav-filters">
              <div className="mnav-group__label">Refine</div>
              <PremiumFilterBar isOpen={open} />
            </div>
          )}
        </div>

        {/* Footer — user + logout */}
        <div className="mnav-foot">
          <div className="mnav-foot__avatar">{user?.name?.[0]?.toUpperCase() || 'S'}</div>
          <div className="mnav-foot__id">
            <div className="mnav-foot__name">{user?.name || 'User'}</div>
            <div className="mnav-foot__role">{user?.role?.replace(/_/g, ' ') || 'Viewer'}</div>
          </div>
          <button type="button" className="mnav-foot__logout" onClick={logout} aria-label="Logout">
            <LogOut size={16} strokeWidth={2.2} />
          </button>
        </div>
      </aside>

      <style jsx>{`
        /* ── Launcher pill ───────────────────────────────────────────── */
        .mnav-trigger {
          position: fixed;
          left: 14px;
          bottom: calc(16px + env(safe-area-inset-bottom));
          z-index: 240;
          display: inline-flex;
          align-items: center;
          gap: 9px;
          height: 52px;
          padding: 0 14px 0 7px;
          border: 1px solid var(--border-default);
          border-radius: 999px;
          background: var(--bg-surface);
          background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
          -webkit-backdrop-filter: blur(18px);
          backdrop-filter: blur(18px);
          box-shadow: 0 14px 34px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.06);
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          transition: transform 200ms cubic-bezier(0.16,1,0.3,1), box-shadow 200ms ease;
        }
        .mnav-trigger:active { transform: scale(0.96); }
        .mnav-trigger__mark {
          width: 38px; height: 38px;
          flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 50%;
          color: #fff;
          background: linear-gradient(135deg, var(--mk), color-mix(in srgb, var(--mk) 62%, #000));
          box-shadow: 0 4px 12px color-mix(in srgb, var(--mk) 45%, transparent);
        }
        .mnav-trigger__label {
          font-family: var(--font-body);
          font-size: 13px; font-weight: 800;
          letter-spacing: -0.01em;
          color: var(--text-primary);
          white-space: nowrap;
          max-width: 42vw;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mnav-trigger__bars {
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--text-muted);
          margin-left: 2px;
        }

        /* ── Scrim ───────────────────────────────────────────────────── */
        .mnav-scrim {
          position: fixed;
          inset: 0;
          z-index: 300;
          background: rgba(2,6,23,0.56);
          -webkit-backdrop-filter: blur(3px);
          backdrop-filter: blur(3px);
          opacity: 0;
          pointer-events: none;
          transition: opacity 280ms cubic-bezier(0.4,0,0.2,1);
        }
        .mnav-scrim.is-open { opacity: 1; pointer-events: auto; }

        /* ── Drawer ──────────────────────────────────────────────────── */
        .mnav-drawer {
          position: fixed;
          top: 0; left: 0; bottom: 0;
          z-index: 301;
          width: min(87vw, 352px);
          display: flex;
          flex-direction: column;
          background: linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-canvas) 100%);
          border-right: 1px solid var(--border-subtle);
          box-shadow: 18px 0 60px rgba(0,0,0,0.42);
          transform: translateX(-104%);
          transition: transform 380ms cubic-bezier(0.16,1,0.3,1);
          will-change: transform;
          padding-top: env(safe-area-inset-top);
          padding-bottom: env(safe-area-inset-bottom);
        }
        .mnav-drawer.is-open { transform: translateX(0); }

        /* ── Drawer header ───────────────────────────────────────────── */
        .mnav-head {
          flex-shrink: 0;
          height: 64px;
          padding: 0 12px 0 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border-subtle);
        }
        .mnav-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
        .mnav-brand__mark {
          width: 34px; height: 34px;
          flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 10px;
          background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%);
          color: #fff;
          font-family: var(--font-display);
          font-size: 15px; font-weight: 900; letter-spacing: -0.02em;
          box-shadow: 0 4px 12px rgba(239,68,68,0.35);
        }
        .mnav-brand__txt { display: flex; flex-direction: column; min-width: 0; }
        .mnav-brand__name {
          font-family: var(--font-display);
          font-size: 15px; font-weight: 800;
          color: var(--text-primary);
          line-height: 1.15;
        }
        .mnav-brand__sub {
          font-size: 9px; font-weight: 700;
          letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--text-muted);
        }
        .mnav-close {
          width: 38px; height: 38px;
          flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border: 1px solid var(--border-default);
          border-radius: 10px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          transition: color 160ms ease, border-color 160ms ease, background 160ms ease;
        }
        .mnav-close:active { background: var(--bg-card-hover); color: var(--text-primary); }

        /* ── Drawer body ─────────────────────────────────────────────── */
        .mnav-body {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          padding: 14px 12px 20px;
        }
        .mnav-group { margin-bottom: 18px; }
        .mnav-group__label {
          font-size: 9px; font-weight: 800;
          letter-spacing: 0.16em; text-transform: uppercase;
          color: var(--text-disabled);
          padding: 0 8px;
          margin-bottom: 8px;
          font-family: var(--font-body);
        }
        .mnav-link { display: block; }
        .mnav-item {
          position: relative;
          display: flex;
          align-items: center;
          gap: 13px;
          height: 52px;
          padding: 0 14px;
          margin-bottom: 6px;
          border-radius: 14px;
          border: 1px solid transparent;
          color: var(--text-secondary);
          background: transparent;
          transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
          -webkit-tap-highlight-color: transparent;
        }
        .mnav-item:active { background: var(--bg-card-hover); }
        .mnav-item.is-active {
          background: var(--glow);
          color: var(--c);
          border-color: color-mix(in srgb, var(--c) 28%, transparent);
        }
        .mnav-item__icon {
          width: 36px; height: 36px;
          flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 10px;
          background: rgba(148,163,184,0.10);
          transition: background 160ms ease;
        }
        .mnav-item.is-active .mnav-item__icon {
          background: color-mix(in srgb, var(--c) 18%, transparent);
        }
        .mnav-item__label {
          font-family: var(--font-body);
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: inherit;
        }
        .mnav-item__dot {
          margin-left: auto;
          width: 8px; height: 8px;
          border-radius: 50%;
          background: var(--c);
          box-shadow: 0 0 10px var(--c);
        }

        .mnav-filters {
          margin-top: 6px;
          padding-top: 14px;
          border-top: 1px solid var(--border-subtle);
        }

        /* ── Drawer footer ───────────────────────────────────────────── */
        .mnav-foot {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: 11px;
          padding: 12px 14px;
          border-top: 1px solid var(--border-subtle);
        }
        .mnav-foot__avatar {
          width: 38px; height: 38px;
          flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 50%;
          background: linear-gradient(135deg, #EF4444, #DC2626);
          color: #fff;
          font-family: var(--font-display);
          font-size: 14px; font-weight: 800;
          box-shadow: 0 2px 8px rgba(239,68,68,0.30);
        }
        .mnav-foot__id { flex: 1; min-width: 0; }
        .mnav-foot__name {
          font-family: var(--font-body);
          font-size: 14px; font-weight: 600;
          color: var(--text-primary);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .mnav-foot__role {
          font-size: 10px; font-weight: 600;
          letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--text-muted);
        }
        .mnav-foot__logout {
          width: 40px; height: 40px;
          flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border: 1px solid var(--border-default);
          border-radius: 10px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          transition: color 160ms ease, border-color 160ms ease, background 160ms ease;
        }
        .mnav-foot__logout:active {
          color: var(--accent-primary);
          border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
          background: var(--accent-glow);
        }
      `}</style>
    </>
  );
}
