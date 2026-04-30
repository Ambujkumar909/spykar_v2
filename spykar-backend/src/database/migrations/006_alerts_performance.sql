-- ─── Migration 006: Stock Alerts query performance ─────────────────────────────
-- Targets the 10-11s latency on /inventory/alerts (570K+ rows).
-- Safe to run multiple times (IF NOT EXISTS on every index).
-- Non-destructive: read-side indexes only, no schema change.

-- ── 1. Velocity CTE accelerator ──────────────────────────────────────────────
-- The alerts query scans 180 days of inventory_movements WHERE movement_type='SALE'
-- and GROUP BY (location_id, sku_id). Existing idx_movements_location_type_date
-- lacks sku_id in the index, forcing a sort+aggregate. Full composite enables
-- index-only scan for the GROUP BY.
CREATE INDEX IF NOT EXISTS idx_movements_sale_loc_sku_date
  ON inventory_movements(movement_type, moved_at DESC, location_id, sku_id)
  WHERE movement_type = 'SALE';

-- ── 2. inventory_snapshot join accelerator ───────────────────────────────────
-- Alerts query joins inventory_snapshot i → thresholds t on (location_id, sku_id).
-- A composite index covers the join; existing idx_snapshot_location / idx_snapshot_sku
-- are single-column and force a merge/hash join with extra sort.
CREATE INDEX IF NOT EXISTS idx_snapshot_loc_sku
  ON inventory_snapshot(location_id, sku_id);

-- ── 3. locations.is_active partial filter ────────────────────────────────────
-- WHERE l.is_active = true AND s.is_active = true appears in every alert / analytics
-- query. Partial index skips inactive rows entirely (typically <5% of table).
CREATE INDEX IF NOT EXISTS idx_locations_active
  ON locations(id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_active
  ON skus(id)
  WHERE is_active = true;

-- ── 4. Shortfall-sort covering index ─────────────────────────────────────────
-- Alerts output is ordered by alert_level then shortfall_pct DESC. Composite index
-- on (qty_on_hand, safety_stock) helps the CASE/ELSE classification and avoids
-- sorting from disk.
CREATE INDEX IF NOT EXISTS idx_snapshot_qty_safety
  ON inventory_snapshot(qty_on_hand, safety_stock);

-- ── 5. Analyze to refresh planner statistics ─────────────────────────────────
ANALYZE inventory_movements;
ANALYZE inventory_snapshot;
ANALYZE locations;
ANALYZE skus;
