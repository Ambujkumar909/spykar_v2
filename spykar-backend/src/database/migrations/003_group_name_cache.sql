-- ─── Migration 003: Add group_name to locations, performance indexes ──────────
-- group_name stores the original ERP GGroupName (EBO-SOR, Alternate-SOR, etc.)
-- so the frontend can show the actual ERP terminology instead of internal types.

ALTER TABLE locations ADD COLUMN IF NOT EXISTS group_name VARCHAR(100);

-- Index for fast group_name lookups / filters
CREATE INDEX IF NOT EXISTS idx_locations_group_name
  ON locations(group_name)
  WHERE group_name IS NOT NULL;

-- Index for type + city combined filter (used on locations page)
CREATE INDEX IF NOT EXISTS idx_locations_type_city
  ON locations(type, city)
  WHERE is_active = true;

-- Index for distributor list sort (total_stock computed via inventory_snapshot)
CREATE INDEX IF NOT EXISTS idx_inventory_snapshot_location
  ON inventory_snapshot(location_id)
  INCLUDE (qty_on_hand, qty_available, qty_in_transit);
