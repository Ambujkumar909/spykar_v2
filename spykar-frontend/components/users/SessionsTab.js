// Super Admin only: who is signed in, from which device — one row per user.
// One device per login is enforced by the API (a new sign-in ends the older
// one), so many sign-ins / IPs in 7 days hint that a login is being shared.
import { useCallback, useEffect, useState } from 'react';
import { LogOut, MonitorSmartphone, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { authService } from '../../lib/services';
import { formatDateTime, formatNumber, timeAgo } from '../../lib/utils';

const ACTIVE_MS = 20 * 60 * 1000;   // a signed-in tab refreshes its token every ~15 min

export function deviceName(ua) {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  return `${browser} on ${os}`;
}

export default function SessionsTab({ currentUserId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await authService.allSessions()).data.data);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to load sessions', { id: 'sessions-load' });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function signOut(row) {
    setBusy(row.id);
    try {
      toast.success((await authService.signOutUser(row.id)).data.message || 'User signed out');
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to sign the user out');
    } finally {
      setBusy(null);
    }
  }

  const signedIn = rows.filter((r) => r.signed_in_at).length;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Sessions</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {formatNumber(signedIn)} of {formatNumber(rows.length)} users signed in · one device per login
          </span>
          <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Status</th>
              <th>Device</th>
              <th>IP</th>
              <th>Signed in</th>
              <th>Last active</th>
              <th style={{ textAlign: 'right' }} title="Sign-ins in the last 7 days">Sign-ins 7d</th>
              <th style={{ textAlign: 'right' }} title="Different IP addresses in the last 7 days">IPs 7d</th>
              <th style={{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}><td colSpan={9}><div className="skeleton" style={{ height: 40 }} /></td></tr>
            ))}
            {rows.map((r) => {
              const live = Boolean(r.signed_in_at);
              const activeNow = live && Date.now() - new Date(r.last_seen_at).getTime() < ACTIVE_MS;
              return (
                <tr key={r.id}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                        {r.name}{r.id === currentUserId && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (you)</span>}
                      </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.email} · {r.role.replace(/_/g, ' ')}</span>
                    </div>
                  </td>
                  <td>
                    {!r.is_active ? <span className="badge badge-danger">Inactive</span>
                      : activeNow ? <span className="badge badge-success">Active now</span>
                      : live ? <span className="badge badge-warning">Signed in</span>
                      : <span className="badge badge-neutral">Signed out</span>}
                  </td>
                  <td title={r.user_agent || undefined}>
                    {live ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><MonitorSmartphone size={13} />{deviceName(r.user_agent)}</span> : '—'}
                  </td>
                  <td>{live ? r.ip || '—' : '—'}</td>
                  <td>{live ? formatDateTime(r.signed_in_at) : r.last_login_at ? <span style={{ color: 'var(--text-muted)' }}>last {formatDateTime(r.last_login_at)}</span> : 'Never'}</td>
                  <td>{live ? timeAgo(r.last_seen_at) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{formatNumber(r.logins_7d || 0)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={r.ips_7d >= 3 ? 'badge badge-warning' : undefined} title={r.ips_7d >= 3 ? 'Signed in from 3+ places this week. The login may be shared.' : undefined}>
                      {formatNumber(r.ips_7d || 0)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {live && r.id !== currentUserId && (
                      <button type="button" className="btn btn-danger" onClick={() => signOut(r)} disabled={busy === r.id}>
                        <LogOut size={14} />
                        Sign out
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
