import { useState, useEffect } from 'react';
import { RefreshCw, Clock, Sun, Moon, TrendingUp, Globe, Sparkles, UserCog, LayoutDashboard } from 'lucide-react';
import { syncService } from '../../lib/services';
import { setDataVersion } from '../../lib/dashboardCache';
import { timeAgo } from '../../lib/utils';
import { useAuth } from '../../lib/auth-context';
import { useTheme } from '../../lib/useTheme';

export default function Header({ title, subtitle, headerSlot, hideSync }) {
  const { user } = useAuth();
  const { isDark, toggle: toggleTheme } = useTheme();
  const isAdmin = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
  const [syncStatus, setSyncStatus]           = useState(null);
  const [syncing, setSyncing]                 = useState(false);
  const [now, setNow]                          = useState(new Date());

  // Apply a sync-status payload AND propagate the data version. When a sync
  // SUCCEEDS, completed_at advances the global DATA_VERSION, which makes every
  // page's cached dashboard data stale-on-next-mount (see dashboardCache.js).
  // This is what makes "after sync, fresh data appears" actually work — without
  // it, the client keeps serving its <10-min localStorage copy and never
  // refetches the freshly-synced numbers.
  const applySyncStatus = (s) => {
    setSyncStatus(s);
    if (s && s.status === 'SUCCESS' && s.completed_at) {
      setDataVersion(new Date(s.completed_at).getTime());
    }
  };

  // Poll sync status on mount AND every 60s, so an open tab notices a
  // background (scheduled or detached) sync completing and refreshes data.
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    const poll = () => syncService.getStatus()
      .then(r => { if (alive) applySyncStatus(r.data.data); })
      .catch(() => {});
    poll();
    const t = setInterval(poll, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isAdmin]);

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncService.trigger();
      setTimeout(() => {
        syncService.getStatus().then(r => applySyncStatus(r.data.data));
        setSyncing(false);
      }, 2000);
    } catch { setSyncing(false); }
  };

  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const lowerTitle = (title || '').toLowerCase();
  let PageIcon = LayoutDashboard;
  let themeColor = '#EF4444'; // default to spykar red
  let glowColor = 'rgba(239, 68, 68, 0.15)';
  let iconBorderColor = 'rgba(239, 68, 68, 0.3)';
  let isSales = false;
  let isNetwork = false;
  let isAi = false;
  let isSync = false;
  let isUser = false;

  if (lowerTitle.includes('sales') || lowerTitle.includes('return')) {
    isSales = true;
    PageIcon = TrendingUp;
    themeColor = '#EF4444'; // Spykar Red
    glowColor = 'rgba(239, 68, 68, 0.15)';
    iconBorderColor = 'rgba(239, 68, 68, 0.3)';
  } else if (lowerTitle.includes('network')) {
    isNetwork = true;
    PageIcon = Globe;
    themeColor = '#3B82F6';
    glowColor = 'rgba(59, 130, 246, 0.15)';
    iconBorderColor = 'rgba(59, 130, 246, 0.3)';
  } else if (lowerTitle.includes('ai') || lowerTitle.includes('query')) {
    isAi = true;
    PageIcon = Sparkles;
    themeColor = '#A855F7';
    glowColor = 'rgba(168, 85, 247, 0.15)';
    iconBorderColor = 'rgba(168, 85, 247, 0.3)';
  } else if (lowerTitle.includes('sync')) {
    isSync = true;
    PageIcon = RefreshCw;
    themeColor = '#F59E0B';
    glowColor = 'rgba(245, 158, 11, 0.15)';
    iconBorderColor = 'rgba(245, 158, 11, 0.3)';
  } else if (lowerTitle.includes('user') || lowerTitle.includes('manage')) {
    isUser = true;
    PageIcon = UserCog;
    themeColor = '#8B5CF6';
    glowColor = 'rgba(139, 92, 246, 0.15)';
    iconBorderColor = 'rgba(139, 92, 246, 0.3)';
  }

  return (
    <header className="app-header" style={{
      position: 'fixed',
      top: 0,
      left: 'var(--sidebar-width)',
      right: 0,
      height: 'var(--header-height)',
      background: isDark ? 'rgba(7,12,24,0.92)' : 'rgba(255,255,255,0.92)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderBottom: '1px solid var(--border-subtle)',
      zIndex: 90,
      boxShadow: isDark
        ? '0 1px 0 rgba(255,255,255,0.04)'
        : '0 1px 0 rgba(15,23,42,0.04)',
      transition: 'left 280ms cubic-bezier(0.16, 1, 0.3, 1), background-color var(--transition-fast), border-color var(--transition-fast)',
    }}>
      {/* Inner content runs at the global --ui-scale density so the header
          matches the zoomed page body. The fixed <header> frame itself stays
          at 1:1 — zooming it would distort its sidebar-offset (left/right)
          viewport anchoring. */}
      <div className="app-header__inner" style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 28px',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        zoom: 'var(--ui-scale)',
      }}>

      {/* Page title container - styled beyond madness */}
      {title && (
        <div className="app-header__title-container" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
          marginRight: 28,
          padding: '5px 14px 5px 8px',
          borderRadius: '12px',
          background: isDark ? 'rgba(255, 255, 255, 0.02)' : 'rgba(15, 23, 42, 0.02)',
          border: '1px solid var(--border-subtle)',
          boxShadow: isDark 
            ? '0 2px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.02)' 
            : '0 2px 6px rgba(15,23,42,0.02)',
          transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(15, 23, 42, 0.04)';
          e.currentTarget.style.borderColor = 'var(--border-default)';
          e.currentTarget.style.boxShadow = isDark 
            ? `0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05), 0 0 15px ${glowColor}` 
            : '0 8px 18px rgba(15,23,42,0.06)';
          const iconCard = e.currentTarget.querySelector('.app-header__title-icon-card');
          if (iconCard) {
            iconCard.style.transform = 'scale(1.06) rotate(-3deg)';
            iconCard.style.boxShadow = `0 0 20px ${glowColor}`;
          }
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = isDark ? 'rgba(255, 255, 255, 0.02)' : 'rgba(15, 23, 42, 0.02)';
          e.currentTarget.style.borderColor = 'var(--border-subtle)';
          e.currentTarget.style.boxShadow = isDark 
            ? '0 2px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.02)' 
            : '0 2px 6px rgba(15,23,42,0.02)';
          const iconCard = e.currentTarget.querySelector('.app-header__title-icon-card');
          if (iconCard) {
            iconCard.style.transform = 'scale(1) rotate(0deg)';
            iconCard.style.boxShadow = `0 0 12px ${glowColor}`;
          }
        }}
        >
          {/* Glowing Icon Card */}
          <div className="app-header__title-icon-card" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: '9px',
            background: isDark ? `rgba(255,255,255,0.03)` : `rgba(15,23,42,0.03)`,
            border: `1px solid ${iconBorderColor}`,
            boxShadow: `0 0 12px ${glowColor}`,
            position: 'relative',
            transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          }}>
            {/* Pulsating Indicator */}
            <span style={{
              position: 'absolute',
              top: -1,
              right: -1,
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: themeColor,
              boxShadow: `0 0 8px ${themeColor}`,
              animation: 'pulse-dot 2.5s infinite',
            }} />
            <PageIcon size={16} style={{ color: themeColor, filter: `drop-shadow(0 2px 4px ${glowColor})` }} />
          </div>

          {/* Text Stack */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 900,
                fontSize: 16,
                letterSpacing: '-0.02em',
                backgroundImage: 'linear-gradient(135deg, var(--text-primary) 40%, var(--text-secondary) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                lineHeight: 1.1,
                whiteSpace: 'nowrap',
              }}>
                {title}
              </div>

              {isAi && (
                <span style={{
                  background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.15) 0%, rgba(236, 72, 153, 0.15) 100%)',
                  border: '1px solid rgba(168, 85, 247, 0.35)',
                  color: '#C084FC',
                  borderRadius: 6,
                  padding: '1px 6px',
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  boxShadow: '0 0 12px rgba(168, 85, 247, 0.2)',
                  fontFamily: 'var(--font-display)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                }}>
                  <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#C084FC', boxShadow: '0 0 6px #C084FC' }} />
                  Gemini
                </span>
              )}
            </div>
            {subtitle && (
              <div style={{
                fontSize: '10px',
                color: 'var(--text-muted)',
                marginTop: 2,
                fontFamily: 'var(--font-body)',
                fontWeight: 500,
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 380,
              }}>{subtitle}</div>
            )}
          </div>
        </div>
      )}

      {/* Page-supplied slot — sits between title and date/time so each page
          can inject a control (e.g. TimeRangeControl on /sales) directly into
          the persistent header bar. Matches the dashboard's TopBar layout
          where the time-range pill is centered next to the page brand. */}
      {headerSlot && (
        <div className="app-header__slot" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {headerSlot}
        </div>
      )}

      {/* Spacer to push controls to the right */}
      <div style={{ flex: 1 }} />

      {/* Date / time — single line, never wraps */}
      <div className="app-header__clock" style={{
        display: 'flex', alignItems: 'center', gap: 6,
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-body)',
        fontSize: 12, fontWeight: 600,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        <Clock size={12} style={{ flexShrink: 0 }} />
        <span style={{ whiteSpace: 'nowrap' }}>{dateStr} · <span style={{ fontVariantNumeric: 'tabular-nums' }}>{timeStr}</span></span>
      </div>

      {/* Divider */}
      <div className="app-header__divider" style={{ width: 1, height: 20, background: 'var(--border-default)' }} />



      {/* Last sync */}
      {syncStatus && !hideSync && (
        <div className="app-header__sync" style={{
          display: 'flex', alignItems: 'center', gap: 7,
          fontSize: 12, color: '#64748B',
          background: 'rgba(255,255,255,0.04)',
          padding: '5px 12px', borderRadius: 100,
          border: '1px solid rgba(255,255,255,0.07)',
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
        }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: syncStatus?.status === 'SUCCESS' ? '#10B981' : '#EF4444',
            boxShadow: syncStatus?.status === 'SUCCESS' ? '0 0 6px #10B981' : '0 0 6px #EF4444',
            flexShrink: 0,
          }} />
          <span>Synced {timeAgo(syncStatus?.completed_at)}</span>
        </div>
      )}

      {/* Sync button */}
      {isAdmin && !hideSync && (
        <button
          onClick={handleSync}
          disabled={syncing}
          title="Trigger data sync"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 100,
            background: 'transparent',
            border: '1px solid var(--border-default)',
            color: 'var(--text-muted)',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
            fontFamily: 'var(--font-body)',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.40)';
            e.currentTarget.style.color = 'var(--info)';
            e.currentTarget.style.background = 'rgba(59,130,246,0.10)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-default)';
            e.currentTarget.style.color = 'var(--text-muted)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <RefreshCw size={12} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      )}



      {/* Divider */}
      <div className="app-header__divider" style={{ width: 1, height: 20, background: 'var(--border-default)' }} />

      {/* Theme toggle — same source of truth as the v2 dashboard's toggle.
          Sun in dark mode, Moon in light mode (icon shows the destination). */}
      <button
        onClick={toggleTheme}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={`${isDark ? 'Switch to light mode' : 'Switch to dark mode'} (D)`}
        style={{
          width: 36, height: 36,
          border: '1px solid var(--border-default)',
          borderRadius: '50%',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--accent-border)';
          e.currentTarget.style.color = 'var(--accent-primary)';
          e.currentTarget.style.background = 'var(--accent-glow)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--border-default)';
          e.currentTarget.style.color = 'var(--text-muted)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        {isDark ? <Sun size={14} /> : <Moon size={14} />}
      </button>

      {/* Notification bell removed per request */}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse-dot {
          0% { opacity: 0.4; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
          100% { opacity: 0.4; transform: scale(0.85); }
        }
      `}</style>
    </header>
  );
}
