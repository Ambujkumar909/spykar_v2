import axios from 'axios';
import Cookies from 'js-cookie';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001/api/v1';

const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Request interceptor: attach access token ─────────────────────────────────
api.interceptors.request.use(
  (config) => {
    const token = Cookies.get('accessToken');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response interceptor: handle 401, refresh token ─────────────────────────
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // A 401 from the auth endpoints themselves is NOT an expired session — it's
    // "wrong credentials" (login) or "bad refresh token" (refresh). Those must
    // pass straight through to the caller so the login page can show the error.
    // Without this guard, a wrong-password 401 hit the refresh/clearAuth path
    // below → clearAuth() did window.location.href='/login' (a full reload),
    // which wiped the error toast before the user ever saw it.
    const reqUrl = originalRequest?.url || '';
    const isAuthEndpoint = reqUrl.includes('/auth/login') || reqUrl.includes('/auth/refresh');

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return api(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = Cookies.get('refreshToken');
      if (!refreshToken) {
        isRefreshing = false;
        clearAuth();
        return Promise.reject(error);
      }

      try {
        const res = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
        const { accessToken, refreshToken: newRefreshToken } = res.data.data;

        Cookies.set('accessToken', accessToken, { expires: 1/96 }); // 15min
        Cookies.set('refreshToken', newRefreshToken, { expires: 7 });

        api.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
        processQueue(null, accessToken);
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Two tabs share one cookie jar: if the other tab rotated the refresh
        // token first, ours is now spent (401) but its fresh tokens are already
        // in the cookies. Use those instead of logging both tabs out.
        if (refreshError.response?.status === 401) {
          await new Promise((r) => setTimeout(r, 800));
          const rotated = Cookies.get('refreshToken');
          const current = Cookies.get('accessToken');
          if (rotated && rotated !== refreshToken && current) {
            api.defaults.headers.common.Authorization = `Bearer ${current}`;
            processQueue(null, current);
            originalRequest.headers.Authorization = `Bearer ${current}`;
            return api(originalRequest);
          }
        }
        processQueue(refreshError, null);
        // Only a rejected refresh token ends the session; a network blip or a
        // 5xx during refresh leaves the cookies for the next attempt.
        if (refreshError.response?.status === 401) clearAuth();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // Quiet automatic retry for transient failures of READ requests: no
    // response (network blip, API restarting), a gateway error, or a timeout.
    // Two retries with a growing wait before the caller ever sees a failure,
    // so a one-off blip never reaches the screen. A timed-out heavy query is
    // usually still running on the server and cached by the time we retry.
    const cfg = error.config;
    const canceled = axios.isCancel?.(error) || error.code === 'ERR_CANCELED' || cfg?.signal?.aborted;
    const transient = !error.response || [502, 503, 504].includes(error.response.status) || error.code === 'ECONNABORTED';
    if (cfg && !canceled && transient && (cfg.method || 'get').toLowerCase() === 'get') {
      cfg.__retries = (cfg.__retries || 0) + 1;
      if (cfg.__retries <= 2) {
        await new Promise((r) => setTimeout(r, cfg.__retries === 1 ? 1500 : 4000));
        if (!cfg.signal?.aborted) return api(cfg);
      }
    }

    return Promise.reject(error);
  }
);

export function clearAuth() {
  Cookies.remove('accessToken');
  Cookies.remove('refreshToken');
  Cookies.remove('user');
  if (typeof window !== 'undefined') {
    // Purge the optimistic-paint profile (see auth-context) so the reload to
    // /login can't briefly render the app shell for a now-logged-out user.
    try { window.localStorage.removeItem('spykar-user'); } catch {}
    window.location.href = '/login';
  }
}

export default api;
