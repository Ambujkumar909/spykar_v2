import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'v2-theme';

function readInitial() {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState('light');

  useEffect(() => { setTheme(readInitial()); }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, setTheme, toggle, isDark: theme === 'dark' };
}
