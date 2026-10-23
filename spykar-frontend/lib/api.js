import axios from 'axios';

import { getAccessToken, expiresSoon, refreshSession, endSession, hasSessionHint, userIsActive, SessionEndedError } from './session';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

const isAuthEndpoint = (url = '') => /\/auth\/(login|refresh)\b/.test(url);

// A refresh is only allowed for someone actually using the app: background
// polling must not keep an abandoned session alive (see lib/session.js).
async function freshToken() {
  if (!userIsActive()) throw new SessionEndedError('SESSION_IDLE', 'Signed out after a period of inactivity.');
  return refreshSession();
}

// ─── Request interceptor: attach a token that is not about to expire ─────────
api.interceptors.request.use(async (config) => {
  if (!isAuthEndpoint(config.url) && hasSessionHint() && expiresSoon(getAccessToken(), 30000)) {
    try { await freshToken(); } catch (e) { if (e.sessionEnded) { endSession(e.code); throw e; } /* transient: send anyway */ }
  }
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─── Response interceptor ────────────────────────────────────────────────────
// 401 codes: TOKEN_EXPIRED / TOKEN_MISSING / TOKEN_INVALID → refresh once and
// retry; SESSION_REVOKED / ACCOUNT_DISABLED → the session is over, no retry.
// Login/refresh 401s ("wrong password", "no session") pass straight through.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config || {};
    const status = error.response && error.response.status;
    const code = error.response && error.response.data && error.response.data.code;

    if (status === 401 && !isAuthEndpoint(originalRequest.url)) {
      if (['SESSION_REVOKED', 'ACCOUNT_DISABLED', 'LICENSE_EXPIRED', 'LICENSE_MISSING', 'NO_SEAT'].includes(code) || originalRequest._retry) {
        endSession(code || 'SESSION_INVALID');
        return Promise.reject(error);
      }
      originalRequest._retry = true;
      try {
        await freshToken();
        originalRequest.headers.Authorization = `Bearer ${getAccessToken()}`;
        return api(originalRequest);
      } catch (e) {
        if (e.sessionEnded) endSession(e.code);
        return Promise.reject(e.sessionEnded ? error : e);
      }
    }

    // Quiet automatic retry for transient failures of READ requests: no
    // response (network blip, API restarting), a gateway error, or a timeout.
    // Two retries with a growing wait before the caller ever sees a failure,
    // so a one-off blip never reaches the screen. A timed-out heavy query is
    // usually still running on the server and cached by the time we retry.
    const cfg = error.config;
    const canceled = axios.isCancel?.(error) || error.code === 'ERR_CANCELED' || cfg?.signal?.aborted;
    // 429 (rate limited) is transient too: wait what the server asks for
    // (Retry-After, capped at 15 s) instead of flashing an error.
    const limited = error.response?.status === 429;
    const transient = limited || !error.response || [502, 503, 504].includes(error.response.status) || error.code === 'ECONNABORTED';
    if (cfg && !canceled && transient && (cfg.method || 'get').toLowerCase() === 'get') {
      cfg.__retries = (cfg.__retries || 0) + 1;
      if (cfg.__retries <= 2) {
        const retryAfterS = Number(error.response?.headers?.['retry-after']) || Number(error.response?.data?.retryAfter) || 0;
        const waitMs = limited ? Math.min(15000, Math.max(1000, retryAfterS * 1000)) : (cfg.__retries === 1 ? 1500 : 4000);
        await new Promise((r) => setTimeout(r, waitMs));
        if (!cfg.signal?.aborted) return api(cfg);
      }
    }

    return Promise.reject(error);
  }
);

export function clearAuth(code = 'LOGOUT') {
  endSession(code);
}

export default api;
