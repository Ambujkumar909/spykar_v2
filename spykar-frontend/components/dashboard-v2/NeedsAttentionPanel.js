// ─── NeedsAttentionPanel — Zone E · the right rail ──────────────────────────
// Sticky 320px column on desktop, in-flow strip below the topbar on mobile.
// Each row is one actionable signal (out-of-stock, aged inventory, etc.) —
// click → drill into the relevant page or anchor.
//
// Order arrives pre-severity-sorted from useDashboardMetrics.  No client-side
// reshuffling; the hook owns the editorial ordering.

import Link from 'next/link';
import {
  XCircle, AlertTriangle, PackageMinus, Hourglass,
  RefreshCw, RotateCcw, StoreOff, ChevronRight, CheckCircle2,
} from 'lucide-react';
import { formatCompact } from '../../lib/v2/format';

const ICON_MAP = {
  XCircle, AlertTriangle, PackageMinus, Hourglass,
  RefreshCw, RotateCcw, StoreOff,
};

const SEVERITY = {
  bad:     { fg: 'var(--v2-bad-500)',  bg: 'var(--v2-bad-50)',  rail: 'var(--v2-bad-500)'  },
  warn:    { fg: 'var(--v2-warn-500)', bg: 'var(--v2-warn-50)', rail: 'var(--v2-warn-500)' },
  neutral: { fg: 'var(--v2-info-500)', bg: 'var(--v2-paper-100)', rail: 'var(--v2-info-500)' },
};

export default function NeedsAttentionPanel({ items, loading }) {
  const list = items || [];
  const totalSev = list.some(i => i.severity === 'bad')
    ? 'bad'
    : list.some(i => i.severity === 'warn') ? 'warn' : 'neutral';

  return (
    <aside
      className="v2-needs-attn"
      style={{
        position: 'sticky',
        top: 80, // header height (64) + gap
        alignSelf: 'start',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div className="v2-card" style={{ padding: 16, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 12,
          paddingBottom: 12,
          borderBottom: '1px solid var(--v2-border)',
        }}>
          <span
            style={{
              width: 10, height: 10, borderRadius: '50%',
              background: SEVERITY[totalSev].fg,
              color: SEVERITY[totalSev].fg,
              animation: list.length > 0 ? 'v2LivePulse 2s ease-in-out infinite' : 'none',
              flexShrink: 0,
            }}
          />
          <div style={{
            fontFamily: 'var(--v2-font-display)',
            fontSize: 13, fontWeight: 800,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--v2-fg-primary)',
            flex: 1,
          }}>
            Needs Attention
          </div>
          <span
            style={{
              padding: '2px 8px', borderRadius: 999,
              background: list.length > 0 ? SEVERITY[totalSev].bg : 'var(--v2-bg-elevated)',
              color: list.length > 0 ? SEVERITY[totalSev].fg : 'var(--v2-fg-tertiary)',
              fontSize: 11, fontWeight: 700,
              border: `1px solid ${list.length > 0 ? SEVERITY[totalSev].fg : 'var(--v2-border)'}`,
            }}
          >
            {list.length}
          </span>
        </div>

        {/* Body */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[0,1,2].map(i => (
              <div key={i} style={{ height: 56, borderRadius: 8, background: 'var(--v2-bg-elevated)' }} />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: '24px 8px', textAlign: 'center' }}>
            <CheckCircle2 size={28} style={{ color: 'var(--v2-ok-500)', marginBottom: 8 }} />
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--v2-fg-primary)' }}>
              All clear
            </div>
            <div style={{ fontSize: 12, color: 'var(--v2-fg-tertiary)', marginTop: 2 }}>
              No exceptions in current window
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {list.map(item => (
              <ExceptionRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function ExceptionRow({ item }) {
  const sev = SEVERITY[item.severity] || SEVERITY.neutral;
  const Icon = ICON_MAP[item.icon] || AlertTriangle;
  const valueText = item.valueIsString
    ? `${item.count}${item.countLabel}`
    : (typeof item.count === 'number'
        ? formatCompact(item.count)
        : String(item.count));

  const inner = (
    <div
      role="button"
      tabIndex={0}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 10px 10px 14px',
        borderRadius: 8,
        background: 'var(--v2-bg-elevated)',
        border: '1px solid var(--v2-border)',
        textDecoration: 'none', color: 'inherit',
        cursor: 'pointer',
        transition: 'transform 160ms var(--v2-ease), box-shadow 160ms',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateX(-2px)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(10,11,13,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      {/* Severity rail */}
      <div style={{
        position: 'absolute', left: 0, top: 6, bottom: 6, width: 3,
        background: sev.rail, borderRadius: '0 2px 2px 0',
      }} />

      {/* Icon */}
      <div style={{
        width: 28, height: 28, borderRadius: 7,
        background: sev.bg, color: sev.fg,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={14} />
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="tabular-nums" style={{ fontFamily: 'var(--v2-font-display)', fontSize: 16, fontWeight: 800, color: sev.fg, letterSpacing: '-0.02em' }}>
            {valueText}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--v2-fg-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {item.countLabel}
          </span>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--v2-fg-primary)', lineHeight: 1.3, marginTop: 1 }}>
          {item.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--v2-fg-secondary)', lineHeight: 1.4, marginTop: 2 }}>
          {item.detail}
        </div>
      </div>

      {/* Chevron */}
      <ChevronRight size={14} style={{ color: 'var(--v2-fg-tertiary)', flexShrink: 0, marginTop: 6 }} />
    </div>
  );

  // External anchors (#aging) stay as <a>; routes use Next Link for prefetching.
  if (item.href?.startsWith('#') || item.href?.includes('#')) {
    return <a href={item.href} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</a>;
  }
  return (
    <Link href={item.href || '#'} style={{ textDecoration: 'none', color: 'inherit' }}>
      {inner}
    </Link>
  );
}
