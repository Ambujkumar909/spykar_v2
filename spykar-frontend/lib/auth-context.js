import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import Cookies from 'js-cookie';
import { authService } from '../lib/services';

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
    const accessToken  = Cookies.get('accessToken');
    const refreshToken = Cookies.get('refreshToken');
    const cached = readCachedUser();

    // No credentials at all → definitively logged out. Don't even try /me.
    if (!accessToken && !refreshToken) {
      writeCachedUser(null);
      setLoading(false);
      return;
    }

    // OPTIMISTIC PAINT: we have a credential AND a cached profile, so render the
    // app right now. This runs in the first post-hydration effect, so the
    // blocking "Loading Spykar IQ…" gate is gone after a single frame instead of
    // a network round-trip. (We can't seed this in useState without a hydration
    // mismatch against the static-prerendered shell, hence the one-frame defer.)
    if (cached) {
      setUser(cached);
      setLoading(false);
    }

    // BACKGROUND REVALIDATE: confirm the session is still good. The api response
    // interceptor transparently refreshes an expired access token using the
    // refresh token, so this succeeds as long as the refresh token is valid —
    // which also fixes spurious logouts when only the 15-min access token had
    // expired on reload.
    authService.me()
      .then(res => {
        setUser(res.data.data);
        writeCachedUser(res.data.data);
      })
      .catch(() => {
        // Reaching here means even the refresh attempt failed — the session is
        // truly dead. Clear everything so we don't keep an optimistic user on
        // screen for a logged-out person.
        Cookies.remove('accessToken');
        Cookies.remove('refreshToken');
        writeCachedUser(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await authService.login(email, password);
    const { accessToken, refreshToken, user: userData } = res.data.data;
    Cookies.set('accessToken', accessToken, { expires: 1/96 });
    Cookies.set('refreshToken', refreshToken, { expires: 7 });
    setUser(userData);
    writeCachedUser(userData);
    return userData;
  }, []);

  const logout = useCallback(async () => {
    try { await authService.logout(); } catch {}
    Cookies.remove('accessToken');
    Cookies.remove('refreshToken');
    writeCachedUser(null);
    setUser(null);
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
