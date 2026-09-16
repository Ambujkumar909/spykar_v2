-- ─── Migration 022: warehouse-grain rollup — the dashboard's instant layer ────
-- Measured on the full-FY local rollup (3.74M sku-grain rows): the /overview
-- KPI query took 10.4s cold and /summary 11.8s — three COUNT(DISTINCT …) over
-- millions of rows, with eight such window scans running in parallel per page
-- load. Yet only the SKU-attribute views (colour / size / product pivots and
-- Lens filters) need SKU grain. Everything the page shows by default — KPIs,
-- daily throughput, flow, monthly, top warehouses, top categories, txn types,
-- warehouse/type/category pivots and trends — needs only
-- (trdt, warehouse, ttyp, category): 16,571 rows for the FY, i.e. 226× smaller.
--
-- primary_sales_daily_wh is DERIVED from primary_sales_daily by the engine in
-- the same transactions (full rebuild: built from the side table and swapped in
-- together; incremental: DELETE+INSERT for the same dirty dates), so the two
-- can never disagree. sku_rows records how many sku-grain rows were folded
-- (diagnostic). Idempotent.

CREATE TABLE IF NOT EXISTS primary_sales_daily_wh (
  trdt           DATE          NOT NULL,
  warehouse_id   UUID          NOT NULL,
  ttyp           VARCHAR(10),
  category_norm  TEXT,
  qty            NUMERIC(20,3) NOT NULL,
  gross          NUMERIC(22,2) NOT NULL,
  gross_abs      NUMERIC(22,2) NOT NULL,
  cost           NUMERIC(22,2) NOT NULL,
  txns           BIGINT        NOT NULL,
  sku_rows       INTEGER       NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psdw_trdt ON primary_sales_daily_wh (trdt);

-- SKU-grain rollup: the only thing it must answer fast that the small table
-- cannot is COUNT(DISTINCT sku_id) over a date window → a (trdt, sku_id) index
-- makes that an index-only scan. The BRIN goes: the heap is written in
-- hash-aggregate order, so its block ranges never prune anything.
CREATE INDEX IF NOT EXISTS idx_psd_trdt_sku ON primary_sales_daily (trdt, sku_id);
DROP INDEX IF EXISTS idx_psd_trdt;
DROP INDEX IF EXISTS idx_psd_trdt_brin;

-- Seed from the existing sku-grain rollup so the dashboard is instant right
-- after migrating (no full re-aggregation of the ledger needed).
TRUNCATE primary_sales_daily_wh;
INSERT INTO primary_sales_daily_wh (trdt, warehouse_id, ttyp, category_norm, qty, gross, gross_abs, cost, txns, sku_rows)
SELECT r.trdt, r.warehouse_id, r.ttyp, s.category_norm,
       SUM(r.qty)::numeric(20,3), SUM(r.gross)::numeric(22,2), SUM(r.gross_abs)::numeric(22,2),
       SUM(r.cost)::numeric(22,2), SUM(r.txns)::bigint, COUNT(*)::int
  FROM primary_sales_daily r
  JOIN skus s ON s.id = r.sku_id
 GROUP BY r.trdt, r.warehouse_id, r.ttyp, s.category_norm;

ANALYZE primary_sales_daily_wh;
ANALYZE primary_sales_daily;
