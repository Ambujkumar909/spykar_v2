-- ─── Migration 015: Primary-sales query performance ──────────────────────────
-- The dashboard aggregates primary_sales_movements over a TRDT date window,
-- optionally narrowed by warehouse / transaction-type / SKU dimension. The
-- indexes from 014 lead with warehouse_id or sku_id, so a pure date-range scan
-- (every-warehouse KPIs / trend) couldn't use them well. These add the missing
-- date-first access paths so the heaviest query — "sum the whole network over a
-- date range" — is index-driven, not a seq scan over the full ledger.
--
-- Idempotent (IF NOT EXISTS). Separate migration so it applies even if 014 was
-- already run on a target DB.

-- BRIN on trdt: the ledger is loaded month-by-month and is naturally clustered
-- by transaction date, which is exactly the access pattern BRIN excels at. It
-- is ~thousands of bytes (vs a multi-MB btree) yet prunes date ranges hard on a
-- large append-only table — ideal for the unbounded-warehouse YTD/QTD scans.
CREATE INDEX IF NOT EXISTS idx_primary_mv_trdt_brin
  ON primary_sales_movements USING BRIN (trdt) WITH (pages_per_range = 32);

-- Btree on trdt for small/precise windows (Today/WTD) where BRIN's block-range
-- granularity is coarser than a tight range deserves. The planner picks whichever
-- fits the window width.
CREATE INDEX IF NOT EXISTS idx_primary_mv_trdt
  ON primary_sales_movements (trdt);

-- Covering composite for the most common grouped scan: a date window grouped by
-- transaction type with the signed quantity summed. INCLUDE keeps trqt in the
-- leaf so the aggregate is index-only for the type pivot.
CREATE INDEX IF NOT EXISTS idx_primary_mv_trdt_ttyp
  ON primary_sales_movements (trdt, ttyp) INCLUDE (trqt);

ANALYZE primary_sales_movements;
