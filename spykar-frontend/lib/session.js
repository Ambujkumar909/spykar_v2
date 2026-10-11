// ─── Client session engine ───────────────────────────────────────────────────
//
// The refresh token lives in an httpOnly cookie this code cannot read (set by
// the API, scoped to /api/v1/auth). Only the 15-min access token is visible.
//
//  • ONE refresh at a time across ALL tabs (Web Locks; in-tab promise as
//    fallback). Inside the lock a tab first checks whether another tab already
//    refreshed — so tabs never race and never log each other out.
//  • PROACTIVE: refreshes ~60 s before the access token expires, and when the
//    tab becomes visible again (laptop wake), so requests don't fail first.
//  • ACTIVITY-AWARE: a person using the app (keys, mouse, touch, scroll — any
//    tab) is never signed out. An abandoned tab stops refreshing; the server
//    then ends the session after its idle window, even if dashboards poll.
//  • A session that truly ended (idle, revoked, reuse, deactivated) signs out
//    every tab together and shows the reason on the login page, returning the
//    user to where they were after signing in.
import axios from 'axios';
import Cookies from 'js-cookie';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
const ACCESS = 'accessToken';
const LEGACY_REFRESH = 'refreshToken';          // pre-cookie builds kept it in JS
const USER_KEY = 'spykar-user';
const ACTIVITY_KEY = 'spk-last-activity';
const IDLE_KEY = 'spk-idle-sec';
const isBrowser = typeof window !== 'undefined';

// ── access token ─────────────────────────────────────────────────────────────
const cookieAttrs = () => ({ expires: 1 / 96, sameSite: 'strict', secure: isBrowser && window.location.protocol === 'https:' });
export const getAccessToken = () => Cookies.get(ACCESS) || null;
function expMs(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { return 0; }
}
export const expiresSoon = (t, withinMs = 60000) => !t || expMs(t) - Date.now() < withinMs;

// ── activity (shared by all tabs through localStorage) ──────────────────────
const idleMs = () => { try { return (Number(localStorage.getItem(IDLE_KEY)) || 86400) * 1000; } catch { return 86400000; } };
const lastActivity = () => { try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return Date.now(); } };
let lastWrite = 0;
export function markActivity() {
  const now = Date.now();
  if (now - lastWrite < 15000) return;            // throttle writes
  lastWrite = now;
  try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch { /* private mode */ }
}
export const userIsActive = () => Date.now() - lastActivity() < idleMs();

// Some session evidence is on this device → worth asking the server.
export const hasSessionHint = () => {
  if (!isBrowser) return false;
  if (getAccessToken() || Cookies.get(LEGACY_REFRESH)) return true;
  try { return !!localStorage.getItem(USER_KEY); } catch { return false; }
};

// ── cross-tab messages ──────────────────────────────────────────────────────
const channel = isBrowser && 'BroadcastChannel' in window ? new BroadcastChannel('spykar-session') : null;
const broadcast = (msg) => { try { channel && channel.postMessage(msg); } catch { /* closed */ } };

// ── refresh (single-flight, cross-tab) ──────────────────────────────────────
export class SessionEndedError extends Error {
  constructor(code, message) { super(message || 'Session ended'); this.code = code || 'SESSION_INVALID'; this.sessionEnded = true; }
}
let inflight = null;
export function refreshSession() {
  if (inflight) return inflight;
  const before = getAccessToken();
  const work = async () => {
    const current = getAccessToken();
    if (current && current !== before && !expiresSoon(current)) return current;   // another tab just did it
    const legacy = Cookies.get(LEGACY_REFRESH);
    try {
      const res = await axios.post(`${API_URL}/auth/refresh`,
        legacy && legacy !== 'undefined' ? { refreshToken: legacy } : {},
        { withCredentials: true, timeout: 20000 });
      applySession(res.data.data);
      if (legacy) Cookies.remove(LEGACY_REFRESH);
      broadcast({ type: 'refreshed' });
      return res.data.data.accessToken;
    } catch (e) {
      if (e.response && e.response.status === 401) throw new SessionEndedError(e.response.data && e.response.data.code, e.response.data && e.response.data.message);
      throw e;                                    // network / 429 / 5xx: session kept, caller may retry
    }
  };
  const run = isBrowser && navigator.locks && navigator.locks.request
    ? navigator.locks.request('spykar-session-refresh', work)
    : work();
  inflight = run.finally(() => { inflight = null; });
  return inflight;
}

// Store what login / refresh returned, and plan the next proactive refresh.
export function applySession({ accessToken, session }) {
  if (accessToken) Cookies.set(ACCESS, accessToken, cookieAttrs());
  if (session && session.idleTimeoutSec) { try { localStorage.setItem(IDLE_KEY, String(session.idleTimeoutSec)); } catch { /* */ } }
  schedule();
}

// ── proactive timer ─────────────────────────────────────────────────────────
let timer = null;
function schedule() {
  if (!isBrowser) return;
  clearTimeout(timer);
  const t = getAccessToken();
  if (!t) return;
  const wait = Math.max(5000, expMs(t) - Date.now() - 60000);
  timer = setTimeout(backgroundRefresh, wait);
}
function backgroundRefresh() {
  if (!hasSessionHint()) return;
  if (!userIsActive()) return;                    // abandoned: let the server's idle window run out
  refreshSession().then(schedule).catch((e) => {
    if (e.sessionEnded) endSession(e.code);
    else timer = setTimeout(backgroundRefresh, 30000);   // transient: try again shortly
  });
}

// ── end of session ──────────────────────────────────────────────────────────
function clearLocal() {
  Cookies.remove(ACCESS); Cookies.remove(LEGACY_REFRESH);
  try { localStorage.removeItem(USER_KEY); } catch { /* */ }
  clearTimeout(timer);
}
export function endSession(code = 'SESSION_INVALID', { notify = true } = {}) {
  clearLocal();
  if (notify) broadcast({ type: 'ended', code });
  if (!isBrowser) return;
  const path = window.location.pathname + window.location.search;
  if (window.location.pathname.startsWith('/login')) return;
  const q = new URLSearchParams({ reason: code });
  if (code !== 'LOGOUT' && path && path !== '/') q.set('next', path);   // come back here after signing in
  window.location.href = `/login?${q.toString()}`;
}

// ── wiring (once per tab) ───────────────────────────────────────────────────
let started = false;
export function startSessionEngine() {
  if (!isBrowser || started) return;
  started = true;
  ['keydown', 'pointerdown', 'mousemove', 'wheel', 'touchstart', 'scroll'].forEach((ev) =>
    window.addEventListener(ev, markActivity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !hasSessionHint()) return;
    markActivity();                               // coming back to the tab is activity
    if (expiresSoon(getAccessToken(), 120000)) backgroundRefresh(); else schedule();
  });
  if (channel) channel.onmessage = ({ data }) => {
    if (!data) return;
    if (data.type === 'refreshed') schedule();
    if (data.type === 'ended') endSession(data.code, { notify: false });
    if (data.type === 'logged-in' && window.location.pathname.startsWith('/login')) window.location.href = '/';
  };
  markActivity();
  schedule();
}
export const announceLogin = () => broadcast({ type: 'logged-in' });
