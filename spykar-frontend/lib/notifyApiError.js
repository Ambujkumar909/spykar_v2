// ─── notifyApiError — one-line replacement for `toast.error('Failed to …')` ─
// Filters out the noise that pollutes user-visible toasts:
//
//   • axios canceled / aborted requests          (navigation races, StrictMode)
//   • request timeouts that retry & succeed      (transient)
//   • 401 Unauthorized                            (AuthProvider handles redirect)
//   • duplicate toasts within DEDUPE_WINDOW_MS    (so a refetch loop shows once)
//
// Usage:
//   try { ... }
//   catch (err) { notifyApiError(err, 'Failed to load sales analytics'); }
//
// Anything genuinely user-actionable (5xx, network down, unexpected) still
// surfaces — but only once per message per 6 s.

import toast from 'react-hot-toast';

const DEDUPE_WINDOW_MS = 6000;
const lastShown = new Map(); // message → timestamp

function isCanceled(err) {
  if (!err) return false;
  // axios v1 sets `code: 'ERR_CANCELED'` and `name: 'CanceledError'`.
  if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return true;
  // AbortController-driven cancellations.
  if (err.name === 'AbortError') return true;
  // axios timeout that the response interceptor already retried.
  if (err.code === 'ECONNABORTED') return true;
  return false;
}

function isAuthError(err) {
  return err?.response?.status === 401 || err?.response?.status === 403;
}

export function notifyApiError(err, fallbackMessage) {
  // Silent for benign errors — they're not user-facing failures.
  if (isCanceled(err) || isAuthError(err)) return;

  // Prefer the server's own message when it sent one.
  const msg = err?.response?.data?.message || fallbackMessage;
  if (!msg) return;

  // Dedupe: same message within 6 s is suppressed (and the previous toast
  // stays on screen, so the user still sees one).
  const now = Date.now();
  const prev = lastShown.get(msg);
  if (prev && now - prev < DEDUPE_WINDOW_MS) return;
  lastShown.set(msg, now);

  // Stable id so react-hot-toast replaces in place rather than stacking.
  toast.error(msg, { id: `api-err:${msg}` });
}
