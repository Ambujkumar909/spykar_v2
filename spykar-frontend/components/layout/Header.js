import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { RefreshCw, Bell, Clock, Wifi } from 'lucide-react';
import { inventoryService, syncService } from '../../lib/services';
import { timeAgo } from '../../lib/utils';
import { useAuth } from '../../lib/auth-context';

export default function Header({ title, subtitle }) {
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncing, setSyncing]       = useState(false);
  const [criticalAlertCount, setCriticalAlertCount] = useState(0);

  useEffect(() => {
    if (isAdmin) {
      syncService.getStatus().then(r => setSyncStatus(r.data.data)).catch(() => {});
    }
    inventoryService.getAlerts()
      .then((response) => {
        const alerts = response.data.data || [];
        setCriticalAlertCount(alerts.filter((alert) => alert.alert_level === 'OUT_OF_STOCK').length);
      })
      .catch(() => {});
  }, [isAdmin]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncService.trigger();
      setTimeout(() => {
        syncService.getStatus().then(r => setSyncStatus(r.data.data));
        setSyncing(false);
      }, 2000);
    } catch { setSyncing(false); }
  };

  return (
    <header style={{
      position: 'fixed',
      top: 0, left: 'var(--sidebar-width)', right: 0,
      height: 'var(--header-height)',
      background: 'rgba(245,247,252,0.92)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderBottom: '1px solid rgba(15,23,42,0.08)',
      display: 'flex', alignItems: 'center',
      padding: '0 32px',
      zIndex: 90, gap: 16,
      boxShadow: '0 1px 0 rgba(15,23,42,0.06)',
    }}>

      {/* Page title */}
      <div style={{ flex: 1 }}>
        {title && (
          <div style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800, fontSize: 20,
            letterSpacing: '-0.03em',
            background: 'linear-gradient(135deg, #0F172A 30%, #C0392B 120%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            lineHeight: 1.2,
          }}>{title}</div>
        )}
        {subtitle && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'var(--font-body)', fontWeight: 400, lineHeight: 1.4 }}>{subtitle}</div>
        )}
      </div>

      {/* Live indicator */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 12, color: '#059669',
        background: '#ECFDF5',
        border: '1px solid #A7F3D0',
        padding: '5px 12px', borderRadius: 100,
        fontFamily: 'var(--font-body)',
        fontWeight: 700,
        letterSpacing: '0.05em',
      }}>
        <Wifi size={11} />
        <span>LIVE</span>
      </div>

      {/* Last sync */}
      {syncStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          fontSize: 13, color: 'var(--text-secondary)',
          background: 'var(--bg-elevated)',
          padding: '6px 14px', borderRadius: 100,
          border: '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
        }}>
          <Clock size={11} color="var(--text-muted)" />
          <span>Synced {timeAgo(syncStatus?.completed_at)}</span>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: syncStatus?.status === 'SUCCESS' ? '#059669' : '#DC2626',
            boxShadow: syncStatus?.status === 'SUCCESS' ? '0 0 6px #059669' : '0 0 6px #DC2626',
          }} />
        </div>
      )}

      {/* Sync button — admin only */}
      {isAdmin && <button onClick={handleSync} disabled={syncing}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '7px 16px', borderRadius: 100,
          background: 'transparent',
          border: '1px solid var(--border-default)',
          color: 'var(--text-secondary)',
          cursor: 'pointer', fontSize: 13, fontWeight: 600,
          fontFamily: 'var(--font-body)',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = '#C0392B';
          e.currentTarget.style.color = '#C0392B';
          e.currentTarget.style.background = 'rgba(192,57,43,0.06)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--border-default)';
          e.currentTarget.style.color = 'var(--text-secondary)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <RefreshCw size={12} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
        {syncing ? 'Syncing…' : 'Sync'}
      </button>}

      {/* Notifications */}
      <button
        onClick={() => router.push('/')}
        title="View stock alerts on Overview"
        style={{
          width: 38, height: 38,
          border: '1px solid var(--border-default)',
          borderRadius: '50%',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)',
          position: 'relative',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#DC2626'; e.currentTarget.style.color = '#DC2626'; e.currentTarget.style.background = '#FFF1F2'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = 'transparent'; }}
      >
        <Bell size={14} />
        {criticalAlertCount > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            minWidth: 16, height: 16,
            padding: '0 4px',
            background: '#DC2626',
            borderRadius: 999,
            border: '2px solid #FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            fontFamily: 'var(--font-body)',
          }}>{criticalAlertCount}</span>
        )}
      </button>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </header>
  );
}
