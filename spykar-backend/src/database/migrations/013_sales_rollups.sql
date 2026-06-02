-- ─────────────────────────────────────────────────────────────────────────────
-- 013_sales_rollups.sql — Phase 1: daily sales rollup tables
--
-- WHY: the /analytics/sales mega-CTE re-scans inventory_movements (3.58M rows)
-- + 2 joins + per-row valuation on every novel date range. Measured: 12.2 s for
-- 1 year, 33.5 s for the full 2.4-year range (spilling 341 MB to disk). Sales
-- history is IMMUTABLE, so we pre-aggregate each day ONCE into two narrow
-- rollups and sum over them. Any date range then becomes an indexed range-sum
-- over a tiny table.
--
-- WHICH GRAINS (measured collapse vs 3.58M raw):
--   srd_store: (sale_date, location_id)            → ~236K rows  (15× smaller)
--   srd_sku:   (sale_date, shop_closed, sku_id)    → ~2.3M rows  (1.7× smaller)
-- The (date,store,sku) grain was rejected — it only collapses 2.7% (useless).
--
-- WHAT THEY SERVE (the date+mode-only "no deep filter" fast path):
--   srd_store → summary (additive + stores_with_sales + active_days), daily,
--               by_month, by_store, all_stores, by_channel
--   srd_sku   → by_color, by_size, by_sku (+slow), sku_universe, unique_skus.
--               Per-SKU stores_count (non-additive) is enriched for only the
--               ~400 displayed SKUs via an indexed raw seek in the controller.
--
-- MODE: 'active'/'inactive'/'all' filters on a store's shop_closed flag.
--   srd_store carries shop_closed as a column (functional from location_id).
--   srd_sku carries shop_closed IN THE GRAIN (a SKU sells in both open and
--   closed stores on the same day, so it must split — otherwise mode filtering
--   would be wrong).
--
-- VALUATION: the lens columns (mrp/cogs/gst/exgst) are frozen at build time
-- from the skus master row, exactly like the live mov CTE computes them. The
-- primary measures (sale_qty, sale_val) come straight from immutable ERP rows.
-- DELTA syncs refresh the touched dates; a FULL sync rebuilds everything.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Per-store daily rollup ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS srd_store (
  sale_date     date    NOT NULL,
  location_id   uuid    NOT NULL,
  loc_name      text,
  loc_code      text,
  external_id   text,
  channel       text,                 -- COALESCE(group_name, type) frozen
  city          text,
  state         text,
  shop_closed   boolean NOT NULL DEFAULT false,
  -- SALE measures
  s_qty   integer NOT NULL DEFAULT 0,
  s_val   numeric NOT NULL DEFAULT 0,
  s_txn   integer NOT NULL DEFAULT 0,
  s_mrp   numeric NOT NULL DEFAULT 0,
  s_cogs  numeric NOT NULL DEFAULT 0,
  s_gst   numeric NOT NULL DEFAULT 0,
  s_exgst numeric NOT NULL DEFAULT 0,
  -- RETURN measures
  r_qty   integer NOT NULL DEFAULT 0,
  r_val   numeric NOT NULL DEFAULT 0,
  r_txn   integer NOT NULL DEFAULT 0,
  r_mrp   numeric NOT NULL DEFAULT 0,
  r_cogs  numeric NOT NULL DEFAULT 0,
  r_gst   numeric NOT NULL DEFAULT 0,
  r_exgst numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (sale_date, location_id)
);
CREATE INDEX IF NOT EXISTS idx_srd_store_date ON srd_store (sale_date);

-- ── Per-SKU daily rollup (split by shop_closed for correct mode filtering) ────
CREATE TABLE IF NOT EXISTS srd_sku (
  sale_date     date    NOT NULL,
  shop_closed   boolean NOT NULL DEFAULT false,
  sku_id        uuid    NOT NULL,
  sku_code      text,
  product_name  text,
  fit_type      text,
  color_code    text,
  color_name    text,
  size          text,
  mrp           numeric,
  s_qty   integer NOT NULL DEFAULT 0,
  s_val   numeric NOT NULL DEFAULT 0,
  s_txn   integer NOT NULL DEFAULT 0,
  s_mrp   numeric NOT NULL DEFAULT 0,
  s_cogs  numeric NOT NULL DEFAULT 0,
  s_gst   numeric NOT NULL DEFAULT 0,
  s_exgst numeric NOT NULL DEFAULT 0,
  r_qty   integer NOT NULL DEFAULT 0,
  r_val   numeric NOT NULL DEFAULT 0,
  r_txn   integer NOT NULL DEFAULT 0,
  r_mrp   numeric NOT NULL DEFAULT 0,
  r_cogs  numeric NOT NULL DEFAULT 0,
  r_gst   numeric NOT NULL DEFAULT 0,
  r_exgst numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (sale_date, shop_closed, sku_id)
);
CREATE INDEX IF NOT EXISTS idx_srd_sku_date ON srd_sku (sale_date);
-- Supports the targeted days_sold / first_sold / last_sold enrichment seek for
-- only the ~400 displayed SKUs (sku_id = ANY(...)) — keeps those non-additive
-- distinct/min/max fields OUT of the full-table pass (which would force a slow
-- sorted GroupAggregate instead of a parallel HashAggregate).
CREATE INDEX IF NOT EXISTS idx_srd_sku_sku ON srd_sku (sku_id);
