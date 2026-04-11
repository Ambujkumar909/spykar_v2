// ─── Number formatting ────────────────────────────────────────────────────────

export function formatNumber(n) {
  if (n == null) return '—';
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000)      return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

export function formatCurrency(n) {
  if (n == null) return '—';
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `₹${(n / 100_000).toFixed(2)}L`;
  if (n >= 1_000)      return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${Number(n).toLocaleString('en-IN')}`;
}

export function formatPct(n) {
  if (n == null) return '—';
  return `${Number(n).toFixed(1)}%`;
}

// ─── Date formatting ──────────────────────────────────────────────────────────

export function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function timeAgo(d) {
  if (!d) return '—';
  const seconds = Math.floor((Date.now() - new Date(d)) / 1000);
  if (seconds < 60)      return 'just now';
  if (seconds < 3600)    return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400)   return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  // For dates > 30 days old, show formatted date instead of "366d ago"
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export const JEWEL_TONE_COLORS = ['#6D28D9','#059669','#D97706','#DC2626','#0284C7','#9333EA','#EA580C','#0D9488'];

export function getMovementLabel(type) {
  const map = {
    SALE:         'Outbound Sale',
    DISPATCH:     'Outbound Dispatch',
    RECEIPT:      'Inbound Receipt',
    RETURN:       'Inbound Return',
    TRANSFER_OUT: 'Outbound Transfer',
    TRANSFER_IN:  'Inbound Transfer',
    ADJUSTMENT:   'Stock Adjustment',
  };
  return map[type] || type;
}

export function locationTypeBadge(type) {
  const map = {
    WAREHOUSE: 'badge-violet',
    DISTRIBUTOR: 'badge-success',
    COCO: 'badge-warning',
    FOFO: 'badge-info',
  };
  return map[type] || 'badge-neutral';
}

// ─── Color helpers ────────────────────────────────────────────────────────────

export function stockLevelColor(qty, safetyStock) {
  if (qty === 0)              return 'var(--danger)';
  if (qty <= safetyStock)     return 'var(--warning)';
  return 'var(--success)';
}

export function changeColor(val) {
  if (val > 0)  return 'var(--success)';
  if (val < 0)  return 'var(--danger)';
  return 'var(--text-muted)';
}

// ─── Heatmap intensity ────────────────────────────────────────────────────────

export function heatmapBg(value, max, min = 0) {
  if (value === 0) return 'rgba(255,77,109,0.18)';
  if (max === 0)   return 'rgba(15,23,42,0.03)';
  // min-max normalise so the full colour range is used regardless of data spread
  const range     = max - min > 0 ? max - min : max;
  const intensity = Math.min(1, Math.max(0, (value - min) / range));
  if (intensity < 0.15) return 'rgba(255,179,71,0.20)';
  if (intensity < 0.35) return 'rgba(255,179,71,0.38)';
  if (intensity < 0.55) return 'rgba(99,179,237,0.28)';
  if (intensity < 0.75) return 'rgba(192,132,252,0.35)';
  return 'rgba(192,132,252,0.60)';
}

export function heatmapText(value, max, min = 0) {
  if (max === 0 || value === 0) return 'var(--text-disabled)';
  const range     = max - min > 0 ? max - min : max;
  const intensity = Math.min(1, Math.max(0, (value - min) / range));
  if (intensity < 0.35) return 'var(--warning)';
  return 'var(--text-primary)';
}

// ─── Dispatch status ──────────────────────────────────────────────────────────

export function dispatchStatusBadge(status) {
  const map = {
    PENDING:     'badge-neutral',
    DISPATCHED:  'badge-info',
    IN_TRANSIT:  'badge-warning',
    DELIVERED:   'badge-success',
    CANCELLED:   'badge-danger',
    PARTIAL:     'badge-warning',
  };
  return map[status] || 'badge-neutral';
}

// ─── Location type label ──────────────────────────────────────────────────────

export function locationTypeLabel(type) {
  const map = {
    WAREHOUSE:   'Warehouse',
    DISTRIBUTOR: 'Distributor',
    COCO:        'COCO Store',
    FOFO:        'FOFO Store',
  };
  return map[type] || type;
}

// ─── ApexCharts default theme config ─────────────────────────────────────────

export const apexTheme = {
  theme:   { mode: 'light' },
  chart: {
    background: 'transparent',
    fontFamily: "'Inter', sans-serif",
    toolbar: { show: false },
    animations: { enabled: true, speed: 600 },
  },
  grid: {
    borderColor: 'rgba(15,23,42,0.06)',
    strokeDashArray: 4,
  },
  tooltip: {
    theme: 'light',
    style: { fontSize: '12px', fontFamily: "'Inter', sans-serif" },
  },
  colors: ['#6D28D9','#059669','#D97706','#DC2626','#0284C7','#9333EA','#EA580C','#0D9488'],
  xaxis: {
    labels: { style: { colors: '#94A3B8', fontSize: '11px' } },
    axisBorder: { color: 'rgba(15,23,42,0.06)' },
    axisTicks: { color: 'rgba(15,23,42,0.06)' },
  },
  yaxis: {
    labels: { style: { colors: '#94A3B8', fontSize: '11px' } },
  },
};
