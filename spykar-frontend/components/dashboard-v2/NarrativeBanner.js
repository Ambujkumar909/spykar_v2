// ─── NarrativeBanner — Zone B of the v2 dashboard ───────────────────────────
// One-sentence editorial story of the business.  Bolded fragments are the
// numbers that matter; clicking one scrolls to the relevant zone-D card.
//
// Source: lib/v2/narrative.js — rule-based templates for now.  Phase 5
// swaps generateNarrative() for an LLM call without touching this component.

import { Sparkles } from 'lucide-react';
import { generateNarrative } from '../../lib/v2/narrative';
import { useTheme } from '../../lib/useTheme';

const TONE_BG = {
  ok:      'linear-gradient(120deg, var(--v2-ok-50)   0%, var(--v2-bg-card) 70%)',
  warn:    'linear-gradient(120deg, var(--v2-warn-50) 0%, var(--v2-bg-card) 70%)',
  bad:     'linear-gradient(120deg, var(--v2-bad-50)  0%, var(--v2-bg-card) 70%)',
  neutral: 'linear-gradient(120deg, var(--v2-paper-100) 0%, var(--v2-bg-card) 70%)',
};

export default function NarrativeBanner({ kpis, asOf, loading }) {
  const { isDark } = useTheme();

  if (loading) {
    return (
      <div
        className="v2-card"
        style={{ padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <Sparkles size={16} style={{ color: 'var(--v2-fg-tertiary)', flexShrink: 0 }} />
        <div style={{
          flex: 1, height: 18, borderRadius: 4,
          background: 'linear-gradient(90deg, var(--v2-bg-elevated), var(--v2-paper-100), var(--v2-bg-elevated))',
          backgroundSize: '200% 100%',
          animation: 'v2NarrShimmer 1.6s linear infinite',
        }} />
        <style jsx>{`
          @keyframes v2NarrShimmer {
            from { background-position: 200% 0; }
            to   { background-position: -200% 0; }
          }
        `}</style>
      </div>
    );
  }

  const { text, bold, tone } = generateNarrative({ kpis, asOf });

  // Tone → accent color for bold metric fragments.  These mid-saturation hues
  // have enough contrast against BOTH the light gradient start (--v2-ok-50 etc.)
  // and the dark card end (--v2-ink-800) so numbers pop in every theme variant.
  const TONE_ACCENT = {
    ok:      'var(--v2-ok-500)',
    warn:    'var(--v2-warn-500)',
    bad:     'var(--v2-bad-500)',
    neutral: 'var(--v2-brand-500)',
  };
  const accentColor = TONE_ACCENT[tone] || TONE_ACCENT.neutral;

  // Render text with bolded spans.  Single-pass split on bold tokens; each
  // token becomes <strong>.  We escape regex chars so "₹3.2 Cr" works.
  const renderRich = () => {
    if (!bold.length) return text;
    const escaped = bold.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`);
    return text.split(re).map((chunk, i) =>
      bold.includes(chunk)
        ? <strong key={i} style={{ color: accentColor, fontWeight: 800, letterSpacing: '-0.01em' }}>{chunk}</strong>
        : <span key={i}>{chunk}</span>
    );
  };

  return (
    <div
      className="v2-card"
      style={{
        padding: '18px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: TONE_BG[tone] || TONE_BG.neutral,
        borderLeft: `3px solid ${tone === 'bad' ? 'var(--v2-bad-500)'
                              : tone === 'warn' ? 'var(--v2-warn-500)'
                              : tone === 'ok'   ? 'var(--v2-ok-500)'
                              : 'var(--v2-info-500)'}`,
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: 'var(--v2-bg-elevated)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        color: 'var(--v2-fg-secondary)',
      }}>
        <Sparkles size={15} />
      </div>
      <div
        style={{
          flex: 1,
          fontFamily: 'var(--v2-font-serif)',
          fontSize: 18,
          lineHeight: 1.45,
          letterSpacing: '-0.005em',
          // Dark mode: gradient runs #ECFDF5 (near-white) → #171A20 (near-black).
          // No single solid color is readable on both extremes.  White text with a
          // dark multi-shadow gives sharp letterforms on the light part while
          // remaining clear on the dark part — classic broadcast/photo overlay
          // technique.  Light mode: gradient stays pale throughout, so dark text
          // without any shadow has sufficient contrast.
          color: isDark ? 'rgba(250,250,250,0.95)' : 'var(--v2-fg-primary)',
          textShadow: isDark
            ? '0 1px 3px rgba(10,11,13,0.60), 0 0 10px rgba(10,11,13,0.45)'
            : 'none',
        }}
      >
        {renderRich()}
      </div>
      <span
        title="Auto-generated from current metrics. Refreshes with each data sync."
        style={{
          flexShrink: 0,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--v2-fg-tertiary)',
          padding: '4px 10px',
          background: 'var(--v2-bg-elevated)',
          border: '1px solid var(--v2-border)',
          borderRadius: 999,
        }}
      >
        AI · Auto
      </span>
    </div>
  );
}
