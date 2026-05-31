import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { RefreshCw, Bell, Clock, Sun, Moon } from 'lucide-react';
import { syncService } from '../../lib/services';
import { useAlerts } from '../../lib/useAlerts';
import { setDataVersion } from '../../lib/dashboardCache';
import { timeAgo } from '../../lib/utils';
import { useAuth } from '../../lib/auth-context';
import { useTheme } from '../../lib/useTheme';

export default function Header({ title, subtitle, headerSlot }) {
  const router = useRouter();
  const { user } = useAuth();
  const { isDark, toggle: toggleTheme } = useTheme();
  const isAdmin = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
  const [syncStatus, setSyncStatus]           = useState(null);
  const [syncing, setSyncing]                 = useState(false);
  const [now, setNow]                          = useState(new Date());

  // Shared fetch — ExceptionAlertStrip uses the same hook, so the network
  // request fires once per page load (was 2× before, plus dev StrictMode).
  const { alerts } = useAlerts();
  const criticalAlertCount = useMemo(
    () => alerts.filter(a => a.alert_level === 'OUT_OF_STOCK').length,
    [alerts]
  );

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
      display: 'flex',
      alignItems: 'center',
      padding: '0 28px',
      zIndex: 90,
      gap: 14,
      boxShadow: isDark
        ? '0 1px 0 rgba(255,255,255,0.04)'
        : '0 1px 0 rgba(15,23,42,0.04)',
    }}>

      {/* Page title */}
      <div className="app-header__title" style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: 17,
            letterSpacing: '-0.03em',
            color: 'var(--text-primary)',
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>{title}</div>
        )}
        {subtitle && (
          <div style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginTop: 1,
            fontFamily: 'var(--font-body)',
            fontWeight: 500,
            lineHeight: 1.4,
          }}>{subtitle}</div>
        )}
      </div>

      {/* Page-supplied slot — sits between title and date/time so each page
          can inject a control (e.g. TimeRangeControl on /sales) directly into
          the persistent header bar. Matches the dashboard's TopBar layout
          where the time-range pill is centered next to the page brand. */}
      {headerSlot && (
        <div className="app-header__slot" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {headerSlot}
        </div>
      )}

      {/* Date / time */}
      <div className="app-header__clock" style={{
        display: 'flex', alignItems: 'center', gap: 8,
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-body)',
        fontSize: 12, fontWeight: 600,
        letterSpacing: '0.02em',
      }}>
        <Clock size={12} />
        <span>{dateStr}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{timeStr}</span>
      </div>

      {/* Divider */}
      <div className="app-header__divider" style={{ width: 1, height: 20, background: 'var(--border-default)' }} />

      {/* Live indicator */}
      <div className="app-header__live" style={{
        display: 'flex', alignItems: 'center', gap: 7,
        fontSize: 11, color: '#10B981',
        background: 'rgba(16,185,129,0.10)',
        border: '1px solid rgba(16,185,129,0.20)',
        padding: '5px 12px', borderRadius: 100,
        fontFamily: 'var(--font-body)',
        fontWeight: 800,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}>
        <div className="live-dot" />
        <span>Live</span>
      </div>

      {/* Last sync */}
      {syncStatus && (
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
      {isAdmin && (
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

      {/* Notifications */}
      <button
        onClick={() => router.push('/')}
        title="View stock alerts"
        style={{
          width: 36, height: 36,
          border: '1px solid var(--border-default)',
          borderRadius: '50%',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)',
          position: 'relative',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'rgba(239,68,68,0.40)';
          e.currentTarget.style.color = 'var(--accent-primary)';
          e.currentTarget.style.background = 'rgba(239,68,68,0.10)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--border-default)';
          e.currentTarget.style.color = 'var(--text-muted)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <Bell size={14} />
        {criticalAlertCount > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3,
            minWidth: 16, height: 16,
            padding: '0 4px',
            background: '#EF4444',
            borderRadius: 999,
            border: `2px solid ${isDark ? '#070C18' : '#FFFFFF'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff',
            fontSize: 9, fontWeight: 800,
            fontFamily: 'var(--font-body)',
            boxShadow: '0 0 8px rgba(239,68,68,0.50)',
          }}>{criticalAlertCount}</span>
        )}
      </button>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </header>
  );
}
