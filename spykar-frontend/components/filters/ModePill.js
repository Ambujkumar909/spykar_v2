// ─── ModePill — Active / Inactive / All sliding-pill segmented control ─────
// Reusable across /network and /sales (and anywhere else mode lives on the
// page).  Brand-red gradient indicator, spring-eased slide, no radio-button
// chrome — just the elegant segmented pill the rest of the app already uses.

export default function ModePill({ mode, onChange }) {
  const OPTS = [
    { key: 'active',   label: 'Active',   title: 'Currently-open stores only' },
    { key: 'inactive', label: 'Inactive', title: 'Currently-closed stores only' },
    { key: 'all',      label: 'All',      title: 'Every store regardless of status' },
  ];
  const idx = Math.max(0, OPTS.findIndex(o => o.key === mode));
  const segPct = 100 / OPTS.length;

  return (
    <div className="mode-pill" role="tablist" aria-label="Store status">
      <span
        className="mode-pill__indicator"
        style={{
          left:  `calc(${idx * segPct}% + 3px)`,
          width: `calc(${segPct}% - 6px)`,
        }}
      />
      {OPTS.map(opt => (
        <button
          key={opt.key}
          type="button"
          role="tab"
          aria-selected={mode === opt.key}
          onClick={() => onChange?.(opt.key)}
          title={opt.title}
          className={`mode-pill__btn${mode === opt.key ? ' is-active' : ''}`}
        >
          {opt.label}
        </button>
      ))}

      <style jsx>{`
        .mode-pill {
          position: relative;
          display: inline-flex;
          align-items: center;
          height: 32px;
          padding: 3px;
          border-radius: 999px;
          background: var(--bg-elevated);
          border: 1px solid var(--border-default);
          box-shadow: inset 0 1px 2px rgba(15,23,42,0.06);
        }
        .mode-pill__indicator {
          position: absolute;
          top: 3px;
          bottom: 3px;
          background: linear-gradient(135deg, var(--accent-primary) 0%, #B91020 100%);
          border-radius: 999px;
          box-shadow:
            0 2px 6px rgba(225,29,46,0.32),
            inset 0 1px 0 rgba(255,255,255,0.20);
          transition:
            left 320ms cubic-bezier(0.16,1,0.3,1),
            width 320ms cubic-bezier(0.16,1,0.3,1);
        }
        .mode-pill__btn {
          position: relative;
          z-index: 1;
          background: transparent;
          border: none;
          cursor: pointer;
          height: 100%;
          padding: 0 14px;
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted);
          transition: color 240ms cubic-bezier(0.4,0,0.2,1);
        }
        .mode-pill__btn:hover { color: var(--text-primary); }
        .mode-pill__btn.is-active {
          color: #ffffff;
          text-shadow: 0 1px 2px rgba(0,0,0,0.20);
        }
      `}</style>
    </div>
  );
}
