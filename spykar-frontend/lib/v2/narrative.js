// ─── narrative.js — rule-based one-line story for the executive banner ──────
// Templated until Phase 5 swaps in an LLM call.  Every sentence references a
// real number from the metrics so the MD can sanity-check it.
//
// Emphasis: bolded fragments come back as <strong> in the banner via the
// {bold: ['8.2%', '₹3.2 Cr']} sidecar.  Click handlers in NarrativeBanner
// scroll to the matching zone-D card.

import { formatINR, formatPct } from './format';

// Returns { text: string, bold: string[], tone: 'ok'|'warn'|'bad'|'neutral' }
export function generateNarrative({ kpis, asOf }) {
  if (!kpis) {
    return {
      text: 'Loading the latest snapshot of the network…',
      bold: [],
      tone: 'neutral',
    };
  }

  const ns = kpis.netSales;
  const us = kpis.unitsSold;
  const rr = kpis.returnRate;
  const inv = kpis.inventoryValuation;

  const parts = [];
  const bold  = [];
  let worstTone = 'ok';

  // 1. Sales vs LY — the headline most CEOs read first.
  if (ns?.delta != null) {
    const deltaPct = ns.delta;
    const dir = deltaPct >= 0 ? 'tracking' : 'down';
    const trail = deltaPct >= 0 ? 'above last year' : 'against last year';
    const dStr = `${Math.abs(deltaPct).toFixed(1)}%`;
    parts.push(`Net sales ${dir} ${dStr} ${trail}`);
    bold.push(dStr);
    if (deltaPct < -5) worstTone = 'bad';
    else if (deltaPct < 0) worstTone = worse(worstTone, 'warn');
  } else if (ns?.value != null) {
    parts.push(`Net sales at ${formatINR(ns.value)}`);
    bold.push(formatINR(ns.value));
  }

  // 2. Return-rate flag — operationally meaningful when > 4%.
  if (rr?.value != null && rr.value > 4) {
    parts.push(`return rate ${formatPct(rr.value)} — review fit & quality`);
    bold.push(formatPct(rr.value));
    worstTone = worse(worstTone, rr.value > 7 ? 'bad' : 'warn');
  }

  // 3. Inventory exposure — flag when > ₹200 Cr (Spykar-scale alarm).
  if (inv?.value != null && inv.value > 200_00_00_000) {
    parts.push(`${formatINR(inv.value)} of inventory across the network`);
    bold.push(formatINR(inv.value));
  }

  // 4. Units delta — only mention if meaningful and not duplicating the sales tone.
  if (us?.delta != null && Math.abs(us.delta) >= 8 && parts.length < 3) {
    const dir = us.delta >= 0 ? 'up' : 'down';
    const dStr = `${Math.abs(us.delta).toFixed(0)}%`;
    parts.push(`units ${dir} ${dStr} vs LY`);
    bold.push(dStr);
  }

  // Fallback if every signal was null.
  if (parts.length === 0) {
    parts.push('Awaiting first sync of the day');
    worstTone = 'neutral';
  }

  return {
    text: parts.join(' · ') + '.',
    bold,
    tone: worstTone,
    asOf,
  };
}

function worse(a, b) {
  const order = { ok: 0, neutral: 1, warn: 2, bad: 3 };
  return order[b] > order[a] ? b : a;
}
