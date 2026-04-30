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
};

// ─── Inventory ────────────────────────────────────────────────────────────────
export const inventoryService = {
  getExecutiveSummary: () => api.get('/inventory/executive-summary'),
  getSnapshot: (params = {}) => api.get('/inventory/snapshot', { params }),
  getAlerts: () => api.get('/inventory/alerts'),
  getAlertsSummary: () => api.get('/inventory/alerts/summary'),
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
  list: (params = {}) => api.get('/locations', { params }),
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
  getSalesAnalytics: (params = {}) => api.get('/analytics/sales', { params }),
  getReturnsAnalytics: (params = {}) => api.get('/analytics/returns', { params }),
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
