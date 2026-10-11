import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authService } from '../lib/services';
import { applySession, startSessionEngine, hasSessionHint, endSession, announceLogin, markActivity } from './session';

const AuthContext = createContext(null);

// ─── Cached user profile (display data only — never the token) ────────────────
// The token lives in an httpOnly-ish cookie; this is just the name/role/email
// the UI needs to render the shell. Persisting it lets AuthProvider paint the
// app IMMEDIATELY on a hard reload instead of blocking every page behind a
// full-screen "Loading…" gate while /auth/me makes a network round-trip.
// The session is still validated against the server in the background on every
// load, so a revoked/expired session is caught within one request.
const USER_KEY = 'spykar-user';

function readCachedUser() {
  if (typeof window === 'undefined') return null;
  try { return JSON.parse(window.localStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
}
function writeCachedUser(u) {
  if (typeof window === 'undefined') return;
  try {
    if (u) window.localStorage.setItem(USER_KEY, JSON.stringify(u));
    else   window.localStorage.removeItem(USER_KEY);
  } catch { /* private mode / quota — degrade to network-gated auth */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    startSessionEngine();
    const cached = readCachedUser();

    // Nothing on this device suggests a session → logged out; skip the network.
    // (The refresh token is an httpOnly cookie we cannot see, so the access
    // token / cached profile / a pre-cookie refresh token are the hints.)
    if (!hasSessionHint()) {
      writeCachedUser(null);
      setLoading(false);
      return;
    }

    // OPTIMISTIC PAINT with the cached profile; revalidate in the background.
    // (Can't seed useState without a hydration mismatch against the static
    // shell, hence the one-frame defer.)
    if (cached) {
      setUser(cached);
      setLoading(false);
    }

    // /me goes through the API client, which refreshes an expired / missing
    // access token from the httpOnly cookie first. Only a 401 ends things; a
    // network error / 5xx / 429 keeps the optimistic user and retries later.
    authService.me()
      .then(res => {
        setUser(res.data.data);
        writeCachedUser(res.data.data);
      })
      .catch((err) => {
        if (err?.response?.status !== 401 && !err?.sessionEnded) return;
        writeCachedUser(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await authService.login(email, password);
    const { user: userData } = res.data.data;
    applySession(res.data.data);          // access token + idle window; refresh token is the httpOnly cookie
    markActivity();
    setUser(userData);
    writeCachedUser(userData);
    announceLogin();                      // other tabs sitting on /login move on too
    return userData;
  }, []);

  // This device only; `everywhere` ends every session of this user.
  const logout = useCallback(async ({ everywhere = false } = {}) => {
    try { await (everywhere ? authService.logoutAll() : authService.logout()); } catch {}
    setUser(null);
    endSession('LOGOUT');                 // clears this tab + tells the other tabs
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
