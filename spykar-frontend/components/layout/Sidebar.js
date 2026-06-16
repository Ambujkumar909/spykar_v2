import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  LayoutDashboard, Globe, TrendingUp, RefreshCw, LogOut, UserCog,
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

export default function Sidebar() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', expanded ? '240px' : '64px');
  }, [expanded]);

  const isActive = (href) => {
    if (href === '/') return router.pathname === '/';
    return router.pathname.startsWith(href);
  };

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
