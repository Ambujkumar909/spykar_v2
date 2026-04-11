import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  LayoutDashboard, Globe, TrendingUp, RefreshCw, LogOut,
  UserCog,
} from 'lucide-react';
import { useAuth } from '../../lib/auth-context';

const NAV = [
  {
    section: 'Main',
    items: [
      { label: 'Overview', href: '/',         icon: LayoutDashboard, color: '#C0392B', glow: 'rgba(192,57,43,0.12)' },
      { label: 'Network',        href: '/network',  icon: Globe,           color: '#0284C7', glow: 'rgba(2,132,199,0.12)' },
      { label: 'Sales & Returns', href: '/sales',    icon: TrendingUp,      color: '#059669', glow: 'rgba(5,150,105,0.12)' },
    ],
  },
  {
    section: 'System',
    items: [
      { label: 'Sync Status',     href: '/sync',  icon: RefreshCw, color: '#ffb347', glow: 'rgba(255,179,71,0.10)', roles: ['SUPER_ADMIN', 'ADMIN'] },
      { label: 'User Management', href: '/users', icon: UserCog,   color: '#C0392B', glow: 'rgba(192,57,43,0.08)', roles: ['SUPER_ADMIN', 'ADMIN'] },
    ],
  },
];

export default function Sidebar() {
  const router = useRouter();
  const { user, logout } = useAuth();

  const isActive = (href) => {
    if (href === '/') return router.pathname === '/';
    return router.pathname.startsWith(href);
  };

  return (
    <aside style={{
      position: 'fixed',
      top: 0, left: 0, bottom: 0,
      width: 'var(--sidebar-width)',
      background: '#FFFFFF',
      borderRight: '1px solid rgba(15,23,42,0.08)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
      overflow: 'hidden',
      boxShadow: '1px 0 0 rgba(15,23,42,0.04)',
    }}>
      {/* ── Logo ── */}
      <div style={{
        padding: '18px 20px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <img
            src="/spykar-logo.png"
            alt="Spykar"
            style={{ height: 38, width: 'auto', maxWidth: 160, objectFit: 'contain', objectPosition: 'left center', display: 'block' }}
            onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
          />
          {/* Fallback */}
          <div style={{ display: 'none', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, color: 'var(--text-primary)' }}>Spykar IQ</div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.13em', fontWeight: 700, textTransform: 'uppercase' }}>
            Inventory Intelligence
          </div>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '14px 10px' }}>
        {NAV.map((group) => (
          <div key={group.section} style={{ marginBottom: 28 }}>
            <div style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--text-muted)',
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              padding: '0 10px',
              marginBottom: 8,
              fontFamily: 'var(--font-body)',
            }}>
              {group.section}
            </div>

            {group.items.filter((item) => !item.roles || item.roles.includes(user?.role)).map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);

              return (
                <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 10px',
                      borderRadius: 10,
                      marginBottom: 3,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: active ? item.glow : 'transparent',
                      color: active ? item.color : 'var(--text-secondary)',
                      border: active ? `1px solid ${item.color}28` : '1px solid transparent',
                      position: 'relative',
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
                        e.currentTarget.style.color = 'var(--text-secondary)';
                      }
                    }}
                  >
                    {/* Active left bar */}
                    {active && (
                      <div style={{
                        position: 'absolute',
                        left: 0, top: '18%', bottom: '18%',
                        width: 3,
                        borderRadius: '0 3px 3px 0',
                        background: item.color,
                        boxShadow: `0 0 8px ${item.color}`,
                      }} />
                    )}

                    {/* Icon box */}
                    <div style={{
                      width: 28, height: 28,
                      borderRadius: 8,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: active ? `${item.color}20` : 'transparent',
                      transition: 'background 0.15s',
                      flexShrink: 0,
                    }}>
                      <Icon size={14} strokeWidth={active ? 2.5 : 2} />
                    </div>

                    <span style={{
                      fontSize: 14,
                      fontWeight: active ? 600 : 500,
                      flex: 1,
                      fontFamily: 'var(--font-body)',
                      letterSpacing: '-0.01em',
                    }}>
                      {item.label}
                    </span>

                    {item.badge && (
                      <span style={{
                        background: '#ff6b6b',
                        color: '#fff',
                        fontSize: 9,
                        fontWeight: 800,
                        padding: '2px 6px',
                        borderRadius: 100,
                        boxShadow: '0 0 8px rgba(255,107,107,0.5)',
                      }}>
                        {item.badge}
                      </span>
                    )}

                    {item.special && !active && (
                      <Zap size={11} style={{ color: '#e879f9', opacity: 0.6 }} />
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── User footer ── */}
      <div style={{
        padding: '12px 10px',
        borderTop: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 10px', borderRadius: 10,
        }}>
          {/* Avatar with gradient */}
          <div style={{
            width: 34, height: 34,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #C0392B, #E74C3C)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: '#fff',
            flexShrink: 0,
            fontFamily: 'var(--font-display)',
            boxShadow: '0 2px 8px rgba(192,57,43,0.24)',
          }}>
            {user?.name?.[0]?.toUpperCase() || 'S'}
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{
              fontSize: 14, fontWeight: 600,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-body)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {user?.name || 'User'}
            </div>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)',
              fontFamily: 'var(--font-body)',
              fontWeight: 500, letterSpacing: '0.03em',
            }}>
              {user?.role?.replace(/_/g, ' ') || 'Viewer'}
            </div>
          </div>
          <button
            onClick={logout}
            title="Logout"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', padding: 6, borderRadius: 8,
              display: 'flex', alignItems: 'center',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = '#ff6b6b';
              e.currentTarget.style.background = 'rgba(255,107,107,0.10)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'var(--text-muted)';
              e.currentTarget.style.background = 'none';
            }}
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
