// ─── useTheme — portal-wide light / dark theme manager ─────────────────────
// Single source of truth for the app's theme.  Persists to localStorage,
// applies the correct class to <html>, and exposes a simple toggle that
// every page can call.
//
// CSS contract: globals.css declares `:root` as DARK defaults and
// `html.theme-light` as the light override.  This hook flips the class.
// The dark mode also writes `color-scheme: dark` so native widgets
// (scrollbars, calendar pickers) render in dark by default.

import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'spykar-theme';   // 'dark' | 'light'

function readInitial() {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  // No explicit pref — honour the OS so first-time visitors get a sensible
  // mode without us choosing for them.
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyClass(theme) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (theme === 'light') html.classList.add('theme-light');
  else                   html.classList.remove('theme-light');
}

export function useTheme() {
  const [theme, setTheme] = useState('dark');

  // Initial sync — runs once on mount.  Reads localStorage / system pref
  // and pushes the class to <html> so the page paints the right theme.
  useEffect(() => {
    const t = readInitial();
    setTheme(t);
    applyClass(t);
  }, []);

  // Persist + reflect every change.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, theme);
    applyClass(theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  return { theme, setTheme, toggle, isDark: theme === 'dark', isLight: theme === 'light' };
}

// Public helpers for callers that need to set/read theme without subscribing
// to React state (e.g. server-rendered hint at the very top of <html>).
export function getTheme() {
  if (typeof window === 'undefined') return 'dark';
  return window.localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
}
