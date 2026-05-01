// Compat shim — the v2 dashboard imported its own scoped useTheme before
// the portal-wide theme system existed.  Both now share state via
// localStorage key `spykar-theme`, so the v2 page automatically follows
// the sidebar toggle and vice versa.
//
// Kept as a separate file so existing imports in components/dashboard-v2/*
// don't need to be rewritten.
export { useTheme, getTheme } from '../useTheme';
