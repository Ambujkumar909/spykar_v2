// ─── LoadError — calm inline "couldn't load" state ───────────────────────────
// Shown IN PLACE of a section only when its data failed to load after the API
// client's automatic retries AND there is nothing (not even older data) to
// show. Never a toast, never a flash: it stays put until the user retries.
import { RefreshCw } from 'lucide-react';

export default function LoadError({ label = "Couldn't load this section", onRetry, minHeight = 160 }) {
  return (
    <div role="status" style={{
      minHeight, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 10, color: 'var(--text-muted)', textAlign: 'center', padding: 16,
    }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px',
          borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
          color: 'var(--text-primary)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}>
          <RefreshCw size={13} strokeWidth={2.2} /> Retry
        </button>
      )}
    </div>
  );
}
