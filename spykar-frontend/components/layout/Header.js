import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { RefreshCw, Bell, Clock, Zap } from 'lucide-react';
import { inventoryService, syncService } from '../../lib/services';
import { timeAgo } from '../../lib/utils';
import { useAuth } from '../../lib/auth-context';

export default function Header({ title, subtitle }) {
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
  const [syncStatus, setSyncStatus]           = useState(null);
  const [syncing, setSyncing]                 = useState(false);
  const [criticalAlertCount, setCriticalCount] = useState(0);
  const [now, setNow]                          = useState(new Date());

  useEffect(() => {
    if (isAdmin) {
      syncService.getStatus().then(r => setSyncStatus(r.data.data)).catch(() => {});
    }
    inventoryService.getAlerts()
      .then(r => {
        const alerts = r.data.data || [];
        setCriticalCount(alerts.filter(a => a.alert_level === 'OUT_OF_STOCK').length);
      })
      .catch(() => {});
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
        syncService.getStatus().then(r => setSyncStatus(r.data.data));
        setSyncing(false);
      }, 2000);
    } catch { setSyncing(false); }
  };

  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <header style={{
      position: 'fixed',
      top: 0,
      left: 'var(--sidebar-width)',
      right: 0,
      height: 'var(--header-height)',
      background: 'rgba(7,12,24,0.92)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 28px',
      zIndex: 90,
      gap: 14,
      boxShadow: '0 1px 0 rgba(255,255,255,0.04)',
    }}>

      {/* Page title */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: 17,
            letterSpacing: '-0.03em',
            color: '#F1F5F9',
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>{title}</div>
        )}
        {subtitle && (
          <div style={{
            fontSize: 11,
            color: '#475569',
            marginTop: 1,
            fontFamily: 'var(--font-body)',
            fontWeight: 500,
            lineHeight: 1.4,
          }}>{subtitle}</div>
        )}
      </div>

      {/* Date / time */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        color: '#475569',
        fontFamily: 'var(--font-body)',
        fontSize: 12, fontWeight: 600,
        letterSpacing: '0.02em',
      }}>
        <Clock size={12} color="#334155" />
        <span>{dateStr}</span>
        <span style={{ color: '#1E293B' }}>·</span>
        <span style={{ color: '#64748B', fontVariantNumeric: 'tabular-nums' }}>{timeStr}</span>
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)' }} />

      {/* Live indicator */}
      <div style={{
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
        <div style={{
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
            border: '1px solid rgba(255,255,255,0.09)',
            color: '#64748B',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
            fontFamily: 'var(--font-body)',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.40)';
            e.currentTarget.style.color = '#93C5FD';
            e.currentTarget.style.background = 'rgba(59,130,246,0.10)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)';
            e.currentTarget.style.color = '#64748B';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <RefreshCw size={12} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      )}

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)' }} />

      {/* Notifications */}
      <button
        onClick={() => router.push('/')}
        title="View stock alerts"
        style={{
          width: 36, height: 36,
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: '50%',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#64748B',
          position: 'relative',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'rgba(239,68,68,0.40)';
          e.currentTarget.style.color = '#FCA5A5';
          e.currentTarget.style.background = 'rgba(239,68,68,0.10)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)';
          e.currentTarget.style.color = '#64748B';
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
            border: '2px solid #070C18',
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
