import { useState, useEffect, useRef } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import { syncService } from '../lib/services';
import { formatNumber, formatDateTime, timeAgo } from '../lib/utils';
import { RefreshCw, CheckCircle, XCircle, Clock, PlayCircle, Database, Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const STATUS_CONFIG = {
  SUCCESS: { color: '#059669', icon: CheckCircle, badge: 'badge-success', label: 'Success' },
  FAILED:  { color: '#DC2626', icon: XCircle,     badge: 'badge-danger',  label: 'Failed'  },
  RUNNING: { color: '#D97706', icon: Loader2,      badge: 'badge-warning', label: 'Running' },
  PENDING: { color: '#0284C7', icon: Clock,        badge: 'badge-info',    label: 'Pending' },
};

export default function SyncStatus() {
  const [status, setStatus]       = useState(null);
  const [logs, setLogs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [triggering, setTriggering] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    fetchAll();
    // Auto-refresh every 15s
    intervalRef.current = setInterval(fetchAll, 15000);
    return () => clearInterval(intervalRef.current);
  }, []);

  async function fetchAll() {
    try {
      const [statusRes, logsRes] = await Promise.allSettled([
        syncService.getStatus(),
        syncService.getLogs(),
      ]);
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value.data);
      if (logsRes.status   === 'fulfilled') setLogs(logsRes.value.data.data || []);
    } catch {}
    finally { setLoading(false); }
  }

  async function triggerSync() {
    setTriggering(true);
    try {
      await syncService.trigger();
      toast.success('Sync started! Refresh in a few minutes to see results.');
      setTimeout(fetchAll, 3000);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to trigger sync');
    } finally {
      setTriggering(false);
    }
  }

  const last = status?.data;
  const isRunning = status?.isRunning;
  const cfg = last ? STATUS_CONFIG[last.status] || STATUS_CONFIG.PENDING : null;
  const isLocalRebuild = last?.source === 'LOCAL_REBUILD';

  // Chart: last 20 syncs duration trend
  const chartLogs = [...logs].reverse().slice(-20);
  const durationOptions = {
    chart: { type: 'area', background: 'transparent', toolbar: { show: false }, fontFamily: "'Inter', sans-serif", sparkline: { enabled: false } },
    stroke: { curve: 'smooth', width: 2 },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.20, opacityTo: 0.02, stops: [0, 100] } },
    colors: ['#0284C7'],
    xaxis: {
      categories: chartLogs.map(l => new Date(l.started_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })),
      labels: { style: { colors: '#94A3B8', fontSize: '10px' } },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { colors: '#94A3B8', fontSize: '10px' }, formatter: v => `${(v / 1000).toFixed(0)}s` } },
    grid: { borderColor: 'rgba(15,23,42,0.06)', strokeDashArray: 4 },
    dataLabels: { enabled: false },
    markers: { size: 3, colors: ['#0284C7'], strokeWidth: 0 },
    tooltip: { theme: 'light', y: { formatter: v => `${(v / 1000).toFixed(1)}s` } },
    theme: { mode: 'light' },
  };

  // Records chart
  const recordsOptions = {
    chart: { type: 'bar', background: 'transparent', toolbar: { show: false }, fontFamily: "'Inter', sans-serif", stacked: true },
    plotOptions: { bar: { borderRadius: 2, columnWidth: '65%' } },
    colors: ['#059669', '#0284C7', '#DC2626'],
    xaxis: {
      categories: chartLogs.map(l => new Date(l.started_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })),
      labels: { style: { colors: '#94A3B8', fontSize: '10px' } },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { colors: '#94A3B8', fontSize: '10px' } } },
    grid: { borderColor: 'rgba(15,23,42,0.06)', strokeDashArray: 4 },
    dataLabels: { enabled: false },
    legend: { position: 'top', labels: { colors: '#64748B' } },
    tooltip: { theme: 'light' },
    theme: { mode: 'light' },
  };

  return (
    <DashboardLayout title="Sync Status" subtitle="ETL pipeline monitoring — SQL Server → PostgreSQL delta sync" allowedRoles={['SUPER_ADMIN', 'ADMIN']}>

      {/* Last sync status card */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, marginBottom: 24, alignItems: 'start' }}>
        <div className="card" style={{ borderColor: cfg ? `${cfg.color}33` : '' }}>
          <div className="card-body" style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
            {loading ? <div className="skeleton" style={{ height: 60, width: '100%' }} /> : (
              <>
                <div style={{
                  width: 64, height: 64, borderRadius: 16, flexShrink: 0,
                  background: cfg ? `${cfg.color}18` : 'var(--bg-elevated)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: cfg?.color,
                }}>
                  {isRunning
                    ? <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
                    : cfg ? <cfg.icon size={28} /> : <Database size={28} style={{ color: 'var(--text-muted)' }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}>
                      {isRunning ? 'Sync Running…' : last ? `Last Sync — ${last.sync_type}` : 'No Sync Run Yet'}
                    </span>
                    {last && <span className={`badge ${cfg?.badge || 'badge-neutral'}`}>{cfg?.label}</span>}
                  </div>
                  {last && (
                    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)' }}>
                      <span>⏱ {timeAgo(last.completed_at || last.started_at)}</span>
                      <span>📦 {formatNumber(last.records_fetched)} fetched</span>
                      <span style={{ color: 'var(--success)' }}>✓ {formatNumber(last.records_updated)} updated</span>
                      {last.records_failed > 0 && <span style={{ color: 'var(--danger)' }}>✗ {formatNumber(last.records_failed)} failed</span>}
                      {last.duration_ms && <span>⚡ {(last.duration_ms / 1000).toFixed(1)}s</span>}
                    </div>
                  )}
                  {isLocalRebuild && (
                    <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,179,71,0.1)', border: '1px solid rgba(255,179,71,0.3)', borderRadius: 8, fontSize: 12, color: 'var(--warning)', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Database size={13} />
                      <span><strong>ERP Not Connected</strong> — SQL Server unreachable. Inventory snapshot rebuilt from local data. Real-time sync will resume once ERP connection is restored.</span>
                    </div>
                  )}
                  {last?.error_message && (
                    <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,77,109,0.1)', border: '1px solid rgba(255,77,109,0.3)', borderRadius: 8, fontSize: 12, color: 'var(--danger)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <XCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                      <span>{last.error_message}</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <button className="btn btn-primary" style={{ padding: '14px 20px', fontSize: 14, gap: 8 }}
          onClick={triggerSync} disabled={triggering || isRunning}>
          {triggering ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <PlayCircle size={16} />}
          {triggering ? 'Starting…' : 'Trigger Sync'}
        </button>
      </div>

      {/* Charts */}
      {logs.length > 2 && (
        <div className="grid-2" style={{ marginBottom: 24 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">Sync Duration Trend</span><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Last 20 runs</span></div>
            <div className="card-body" style={{ paddingTop: 8 }}>
              <Chart
                options={durationOptions}
                series={[{ name: 'Duration', data: chartLogs.map(l => l.duration_ms || 0) }]}
                type="area" height={180}
              />
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Records per Run</span></div>
            <div className="card-body" style={{ paddingTop: 8 }}>
              <Chart
                options={recordsOptions}
                series={[
                  { name: 'Updated',  data: chartLogs.map(l => l.records_updated  || 0) },
                  { name: 'Inserted', data: chartLogs.map(l => l.records_inserted || 0) },
                  { name: 'Failed',   data: chartLogs.map(l => l.records_failed   || 0) },
                ]}
                type="bar" height={180}
              />
            </div>
          </div>
        </div>
      )}

      {/* Sync logs table */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Sync History (Last 50 Runs)</span>
          <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={fetchAll}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>Status</th><th>Type</th><th>Source</th><th>Started</th><th>Duration</th><th>Fetched</th><th>Updated</th><th>Failed</th><th>Error</th></tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 8 }).map((_, j) => (
                    <td key={j}><div className="skeleton" style={{ height: 13, width: '80%' }} /></td>
                  ))}</tr>
                ))
                : logs.map((log, i) => {
                  const lc = STATUS_CONFIG[log.status] || STATUS_CONFIG.PENDING;
                  const Icon = lc.icon;
                  return (
                    <tr key={i}>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Icon size={13} style={{ color: lc.color, ...(log.status === 'RUNNING' ? { animation: 'spin 1s linear infinite' } : {}) }} />
                          <span className={`badge ${lc.badge}`}>{lc.label}</span>
                        </span>
                      </td>
                      <td><span className="badge badge-neutral">{log.sync_type}</span></td>
                      <td>
                        <span className={`badge ${log.source === 'LOCAL_REBUILD' ? 'badge-warning' : log.source === 'SQL_SERVER' ? 'badge-success' : 'badge-neutral'}`}
                          title={log.source === 'LOCAL_REBUILD' ? 'ERP unreachable — local data rebuild only' : 'Live ERP sync'}>
                          {log.source === 'LOCAL_REBUILD' ? 'Local' : log.source === 'SQL_SERVER' ? 'ERP Live' : log.source || '—'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDateTime(log.started_at)}</td>
                      <td style={{ color: log.duration_ms > 60000 ? 'var(--warning)' : 'var(--text-secondary)' }}>
                        {log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td>{formatNumber(log.records_fetched)}</td>
                      <td style={{ color: 'var(--success)' }}>{formatNumber(log.records_updated)}</td>
                      <td style={{ color: log.records_failed > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                        {log.records_failed > 0 ? formatNumber(log.records_failed) : '—'}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--danger)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {log.error_message || '—'}
                      </td>
                    </tr>
                  );
                })
              }
              {!loading && !logs.length && (
                <tr><td colSpan={9}><div className="empty-state"><Database size={32} /><p>No sync runs yet. Trigger your first sync above.</p></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}

SyncStatus.getLayout = (page) => page;
