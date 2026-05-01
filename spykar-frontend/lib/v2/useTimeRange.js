import { useState, useMemo, useCallback } from 'react';

// Single source of truth for the time-window every v2 component reads.
// Six presets + custom.  fromISO/toISO are the only fields downstream
// hooks should consume — preset is for UI highlight + analytics labels.
export const PRESETS = ['today', 'wtd', 'mtd', 'qtd', 'ytd', 'custom'];

const PRESET_LABELS = {
  today:  'Today',
  wtd:    'WTD',
  mtd:    'MTD',
  qtd:    'QTD',
  ytd:    'YTD',
  custom: 'Custom',
};

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Spykar ERP feed currently ends 2026-01-31. Anchoring "today" to the last
// data date keeps MTD/YTD/QTD computations meaningful — otherwise every
// preset reads zero because real-now is past the data window.
// TODO: replace with /sync/status.last_sync_at once Phase 4 wires it up.
const DATA_ANCHOR_ISO = '2026-01-31';

function rangeFor(preset, customFrom, customTo) {
  const today = new Date(DATA_ANCHOR_ISO + 'T00:00:00');
  const to = fmt(today);

  switch (preset) {
    case 'today': return { from: to, to };
    case 'wtd': {
      // Week-to-date — Monday as first day (Indian retail convention)
      const d = new Date(today);
      const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
      d.setDate(d.getDate() - dow);
      return { from: fmt(d), to };
    }
    case 'mtd': {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: fmt(d), to };
    }
    case 'qtd': {
      const q = Math.floor(today.getMonth() / 3) * 3;
      const d = new Date(today.getFullYear(), q, 1);
      return { from: fmt(d), to };
    }
    case 'ytd': {
      // Indian FY: Apr 1 → today.  Defaults to current FY.
      const fyStart = today.getMonth() >= 3
        ? new Date(today.getFullYear(), 3, 1)
        : new Date(today.getFullYear() - 1, 3, 1);
      return { from: fmt(fyStart), to };
    }
    case 'custom':
      return { from: customFrom || to, to: customTo || to };
    default:
      return { from: to, to };
  }
}

export function useTimeRange(initialPreset = 'mtd') {
  const [preset, setPreset]         = useState(initialPreset);
  const [customFrom, setCustomFrom] = useState(null);
  const [customTo, setCustomTo]     = useState(null);

  const range = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  const setCustom = useCallback((from, to) => {
    setCustomFrom(from);
    setCustomTo(to);
    setPreset('custom');
  }, []);

  return {
    preset,
    setPreset,
    setCustom,
    label: PRESET_LABELS[preset] || preset,
    fromISO: range.from,
    toISO:   range.to,
    PRESET_LABELS,
  };
}
