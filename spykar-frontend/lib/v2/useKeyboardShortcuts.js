// ─── Keyboard shortcuts for the v2 dashboard ────────────────────────────────
//   T → jump to Today preset
//   M → jump to MTD preset (default)
//   Y → jump to YTD preset
//   F → toggle Filter drawer
//   D → toggle dark / light mode
//   ? → no-op (reserved for help overlay in Phase 5+)
//
// All shortcuts ignore key presses while focus is in an input/textarea/select
// so typing in the search input doesn't accidentally toggle the dashboard.

import { useEffect } from 'react';

const SHORTCUTS = {
  t: 'today',
  m: 'mtd',
  y: 'ytd',
};

export function useKeyboardShortcuts({ setPreset, toggleTheme, toggleDrawer }) {
  useEffect(() => {
    const onKey = (e) => {
      // Don't hijack typing.
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.activeElement?.isContentEditable) return;
      // Ignore when modifier keys are held — that's the OS / browser realm.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (SHORTCUTS[key]) {
        e.preventDefault();
        setPreset?.(SHORTCUTS[key]);
        return;
      }
      if (key === 'f') {
        e.preventDefault();
        toggleDrawer?.();
        return;
      }
      if (key === 'd') {
        e.preventDefault();
        toggleTheme?.();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPreset, toggleTheme, toggleDrawer]);
}
