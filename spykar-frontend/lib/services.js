import api from './api';

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authService = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  refresh: (refreshToken) => api.post('/auth/refresh', { refreshToken }),
  listUsers: (params = {}) => api.get('/users', { params }),
  createUser: (data) => api.post('/users', data),
  updateUser: (id, data) => api.patch(`/users/${id}`, data),
  toggleUser: (id) => api.patch(`/users/${id}/toggle`),
  resetUserPassword: (id, newPassword) => api.patch(`/users/${id}/password`, { newPassword }),
};

// ─── Inventory ────────────────────────────────────────────────────────────────
export const inventoryService = {
  getExecutiveSummary: (params = {}) => api.get('/inventory/executive-summary', { params }),
  getSnapshot: (params = {}) => api.get('/inventory/snapshot', { params }),
  getAlerts: (params = {}) => api.get('/inventory/alerts', { params }),
  getAlertsSummary: (params = {}) => api.get('/inventory/alerts/summary', { params }),
  getMovements: (params = {}) => api.get('/inventory/movements', { params }),
  getAgeing: (params = {}) => api.get('/inventory/ageing', { params }),
  exportSnapshot: (params = {}) => api.get('/inventory/snapshot/export', {
    params,
    responseType: 'blob',
  }),
  getLocationInventory: (locationId, params = {}) =>
    api.get(`/inventory/location/${locationId}`, { params }),
  getSkuInventory: (skuId) => api.get(`/inventory/sku/${skuId}`),
};

// ─── Distributors ─────────────────────────────────────────────────────────────
export const distributorService = {
  list: (params = {}) => api.get('/distributors', { params }),
  getTop: (params = {}) => api.get('/distributors/top', { params }),
  compare: (ids = []) => api.get('/distributors/comparison', {
    params: { ids: ids.join(',') },
  }),
  getById: (id) => api.get(`/distributors/${id}`),
  getInventory: (id, params = {}) => api.get(`/distributors/${id}/inventory`, { params }),
  getMovements: (id, params = {}) => api.get(`/distributors/${id}/movements`, { params }),
  getAgeing: (id) => api.get(`/distributors/${id}/ageing`),
};

// ─── Locations ────────────────────────────────────────────────────────────────
export const locationService = {
  list: (params = {}, config = {}) => api.get('/locations', { params, ...config }),
  listZones: () => api.get('/locations/zones'),
  getById: (id) => api.get(`/locations/${id}`),
  getSummary: (id) => api.get(`/locations/${id}/summary`),
  create: (data) => api.post('/locations', data),
  update: (id, data) => api.patch(`/locations/${id}`, data),
  // v2 god-tier network analytics — single round-trip for every hero widget
  getNetworkPulse: (params = {}) => api.get('/locations/network-pulse', { params }),
};

// ─── SKUs ─────────────────────────────────────────────────────────────────────
export const skuService = {
  list: (params = {}) => api.get('/skus', { params }),
  getSizeColorMatrix: (params = {}) => api.get('/skus/matrix', { params }),
  getSizes: (params = {}) => api.get('/skus/sizes', { params }),
  getColors: (params = {}) => api.get('/skus/colors', { params }),
  getTopMoving: (params = {}) => api.get('/skus/top-moving', { params }),
  getSlowMoving: (params = {}) => api.get('/skus/slow-moving', { params }),
  getById: (id) => api.get(`/skus/${id}`),
  getInventoryByLocation: (id, params = {}) =>
    api.get(`/skus/${id}/inventory-by-location`, { params }),
};

// ─── Dispatch ─────────────────────────────────────────────────────────────────
export const dispatchService = {
  list: (params = {}) => api.get('/dispatch', { params }),
  getInTransit: () => api.get('/dispatch/in-transit'),
  getSummary: () => api.get('/dispatch/summary'),
  getCouriers: () => api.get('/dispatch/couriers'),
  getById: (id) => api.get(`/dispatch/${id}`),
  getLineItems: (id) => api.get(`/dispatch/${id}/line-items`),
  create: (data) => api.post('/dispatch', data),
  updateStatus: (id, data) => api.patch(`/dispatch/${id}/status`, data),
};

// ─── Analytics ────────────────────────────────────────────────────────────────
export const analyticsService = {
  getNetworkOverview: () => api.get('/analytics/network-overview'),
  getStockTrend: (params = {}) => api.get('/analytics/stock-trend', { params }),
  getSizeDistribution: (params = {}) => api.get('/analytics/size-distribution', { params }),
  getColorDistribution: (params = {}) => api.get('/analytics/color-distribution', { params }),
  getZoneHeatmap: () => api.get('/analytics/zone-heatmap'),
  getFillRate: (params = {}) => api.get('/analytics/fill-rate', { params }),
  getSalesAnalytics: (params = {}, config = {}) => api.get('/analytics/sales', { params, ...config }),
  // v2 dashboard — slim version: only summary + daily + by_channel.  ~240 ms
  // cold vs ~8 s for /analytics/sales.  See backend controller for the why.
  getSalesSummary:  (params = {}) => api.get('/analytics/sales/summary', { params }),
  // Sales drilldown — store-level OR sku-level pivot. Pass ?type=store|sku
  // and ?id=<uuid>, plus the same v2 filter set as getSalesAnalytics so the
  // drill scopes to whatever window the user is viewing.
  getSalesDrilldown: (params = {}) => api.get('/analytics/sales/drilldown', { params }),
  getReturnsAnalytics: (params = {}) => api.get('/analytics/returns', { params }),
  // Overview cross-pivot — sales × inventory join at SKU + store grain.
  // Powers the Overview page's hero tables that answer "which store has
  // SKU X in stock?", "which SKUs is store Y doing best on?", and
  // "what's OOS at our busiest stores?". Mode + filter aware.
  getOverviewCrossPivot: (params = {}) => api.get('/analytics/overview/cross-pivot', { params }),
  // v2 dashboard — state-wise sales for the India heatmap.  Added in
  // Phase 3 alongside the new backend route.
  getStateHeatmap: (params = {}) => api.get('/analytics/state-heatmap', { params }),
};

// ─── AI Query ─────────────────────────────────────────────────────────────────
export const aiService = {
  query: (question) => api.post('/ai/query', { question }),
  getHistory: () => api.get('/ai/history'),
  getSuggestedQueries: () => api.get('/ai/suggested-queries'),
};

// ─── Sync ─────────────────────────────────────────────────────────────────────
export const syncService = {
  getStatus: () => api.get('/sync/status'),
  getLogs: () => api.get('/sync/logs'),
  trigger: () => api.post('/sync/trigger'),
};

// ─── Filters (universal v2 dashboard filter bar) ──────────────────────────────
// Bulk fetches every drill-down dropdown in one round-trip; single-dimension
// fetch is used when the user re-opens a dropdown so we can re-narrow under
// the latest cross-filter state.
export const filterService = {
  getAllOptions:    (params = {}) => api.get('/filters/options', { params }),
  getDimensionOptions: (dimension, params = {}) =>
    api.get(`/filters/options/${dimension}`, { params }),
};
