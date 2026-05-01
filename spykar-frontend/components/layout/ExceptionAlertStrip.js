import { useMemo, useRef } from 'react';
import { AlertTriangle, XCircle, CheckCircle, Zap } from 'lucide-react';
import { useAlerts } from '../../lib/useAlerts';

/* Maps alert_level → visual config */
const LEVEL_CONFIG = {
  OUT_OF_STOCK:   { color: '#EF4444', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.25)',   icon: XCircle,       label: 'CRITICAL' },
  LOW_STOCK:      { color: '#F59E0B', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.22)',  icon: AlertTriangle, label: 'LOW STOCK' },
  EXCESS_STOCK:   { color: '#3B82F6', bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.22)', icon: Zap,           label: 'EXCESS' },
  HEALTHY:        { color: '#10B981', bg: 'rgba(16,185,129,0.10)',  border: 'rgba(16,185,129,0.22)',  icon: CheckCircle,   label: 'OK' },
};

export default function ExceptionAlertStrip() {
  // Shared with Header — single fetch per page load, deduped at module scope.
  const { alerts: rawAlerts, loading } = useAlerts();
  const trackRef = useRef(null);

  // Strip only shows critical + low stock — same filter as before.
  const alerts = useMemo(
    () => rawAlerts
      .filter(a => ['OUT_OF_STOCK', 'LOW_STOCK'].includes(a.alert_level))
      .slice(0, 40),
    [rawAlerts]
  );

  const criticalCount = alerts.filter(a => a.alert_level === 'OUT_OF_STOCK').length;
  const lowCount      = alerts.filter(a => a.alert_level === 'LOW_STOCK').length;
  const hasAlerts     = alerts.length > 0;

  if (loading) {
    return (
      <div style={{
        position: 'fixed',
        top: 'var(--header-height)',
        left: 'var(--sidebar-width)',
        right: 0,
        height: 'var(--alert-strip-height)',
        background: 'rgba(7,12,24,0.95)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 20,
        gap: 8,
        zIndex: 88,
      }}>
        <div className="sx-shimmer" style={{ height: 12, width: 200, borderRadius: 4 }} />
      </div>
    );
  }

  if (!hasAlerts) {
    return (
      <div style={{
        position: 'fixed',
        top: 'var(--header-height)',
        left: 'var(--sidebar-width)',
        right: 0,
        height: 'var(--alert-strip-height)',
        background: 'rgba(7,12,24,0.95)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 8,
        zIndex: 88,
      }}>
        <CheckCircle size={12} color="#10B981" />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#10B981', fontFamily: 'var(--font-body)', letterSpacing: '0.04em' }}>
          All stock levels healthy — no critical alerts
        </span>
      </div>
    );
  }

  /* Build ticker items — duplicate for infinite loop */
  const tickerItems = [...alerts, ...alerts];

  return (
    <div style={{
      position: 'fixed',
      top: 'var(--header-height)',
      left: 'var(--sidebar-width)',
      right: 0,
      height: 'var(--alert-strip-height)',
      background: 'rgba(7,12,24,0.96)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      display: 'flex',
      alignItems: 'center',
      zIndex: 88,
      overflow: 'hidden',
    }}>
      {/* Left badge — critical count */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 16px',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        height: '100%',
        background: 'rgba(239,68,68,0.06)',
      }}>
        {criticalCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 18, height: 18, borderRadius: 5,
              background: 'rgba(239,68,68,0.20)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <XCircle size={11} color="#EF4444" />
            </div>
            <span style={{
              fontSize: 12, fontWeight: 800,
              color: '#EF4444',
              fontFamily: 'var(--font-body)',
              letterSpacing: '0.03em',
            }}>
              {criticalCount} critical
            </span>
          </div>
        )}
        {lowCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 18, height: 18, borderRadius: 5,
              background: 'rgba(245,158,11,0.18)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <AlertTriangle size={11} color="#F59E0B" />
            </div>
            <span style={{
              fontSize: 12, fontWeight: 800,
              color: '#F59E0B',
              fontFamily: 'var(--font-body)',
              letterSpacing: '0.03em',
            }}>
              {lowCount} low
            </span>
          </div>
        )}
      </div>

      {/* Scrolling ticker */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Fade edges */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 40,
          background: 'linear-gradient(to right, rgba(7,12,24,0.96), transparent)',
          zIndex: 2, pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 40,
          background: 'linear-gradient(to left, rgba(7,12,24,0.96), transparent)',
          zIndex: 2, pointerEvents: 'none',
        }} />

        <div
          ref={trackRef}
          className="alert-ticker-track"
          style={{ paddingLeft: 20 }}
        >
          {tickerItems.map((alert, i) => {
            const cfg = LEVEL_CONFIG[alert.alert_level] || LEVEL_CONFIG.LOW_STOCK;
            const Icon = cfg.icon;
            return (
              <span
                key={i}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  marginRight: 32,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: cfg.bg,
                  border: `1px solid ${cfg.border}`,
                  cursor: 'default',
                }}
              >
                <Icon size={10} color={cfg.color} />
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  color: cfg.color,
                  fontFamily: 'var(--font-body)',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  marginRight: 3,
                }}>
                  {cfg.label}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', fontFamily: 'var(--font-body)' }}>
                  {alert.store_name || alert.store_code || 'Unknown store'}
                  {alert.product && ` · ${alert.product}`}
                  {alert.qty !== undefined && ` · ${Number(alert.qty).toLocaleString('en-IN')} units`}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
