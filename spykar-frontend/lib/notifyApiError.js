// ─── notifyApiError — background data-load failures ──────────────────────────
// Product rule: a failing or slow BACKGROUND request (a chart, a table, a KPI
// refresh) must never flash an error toast in the corner — it disturbs the
// experience. Such failures are logged to the console only; the widget shows
// its own empty/loading state and the next navigation or sync retries.
//
// Failures the user caused directly (wrong password, "create user" rejected,
// sync trigger refused) are NOT routed here — those pages answer the user's
// own action explicitly.
//
// Canceled requests (navigation races, StrictMode, AbortController) and auth
// errors (handled by the AuthProvider) are ignored entirely.

function isCanceled(err) {
  if (!err) return false;
  if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return true;
  if (err.name === 'AbortError') return true;
  return false;
}

export function notifyApiError(err, fallbackMessage) {
  if (isCanceled(err)) return;
  const status = err?.response?.status;
  if (status === 401 || status === 403) return;
  const msg = err?.response?.data?.message || fallbackMessage || 'Request failed';
  // eslint-disable-next-line no-console
  console.warn(`[api] ${msg}`, err?.code === 'ECONNABORTED' ? '(timed out)' : (status || err?.message || ''));
}
