-- ─── Migration 032: distinct-SKU count independent of window width ──────────
-- COUNT(DISTINCT sku_id) over primary_sales_daily scanned every row in the
-- window: 2.3 s YTD, 17.6 s all-time, >40 s (statement timeout → the tile
-- never loaded) all-time with a type filter. The count is now one EXISTS probe
-- per SKU (primarySales.controller distinctSkus): these two indexes make each
-- probe a direct seek, unfiltered / by type, and within given warehouses.
-- Built CONCURRENTLY on the live DB (1–2 min each); rebuildRollup recreates them.
CREATE INDEX IF NOT EXISTS idx_psd_sku_trdt    ON primary_sales_daily (sku_id, trdt) INCLUDE (warehouse_id, ttyp);
CREATE INDEX IF NOT EXISTS idx_psd_wh_sku_trdt ON primary_sales_daily (warehouse_id, sku_id, trdt) INCLUDE (ttyp);
