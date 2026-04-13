-- ─── Migration 005: Performance indexes for missing critical paths ────────────
-- Non-destructive: adds indexes on existing data, no sync or data migration needed.
-- Safe to run multiple times (all use IF NOT EXISTS).

-- ── inventory_movements: composite (movement_type, moved_at) ─────────────────
-- Every AI sales/return query: WHERE movement_type='SALE' AND moved_at >= X AND moved_at < Y
CREATE INDEX IF NOT EXISTS idx_movements_type_date
  ON inventory_movements(movement_type, moved_at DESC);

-- ── inventory_movements: composite (sku_id, movement_type, moved_at) ─────────
-- Colour/size/SKU-specific queries: WHERE sku_id=X AND movement_type='SALE' AND moved_at ...
CREATE INDEX IF NOT EXISTS idx_movements_sku_type_date
  ON inventory_movements(sku_id, movement_type, moved_at DESC);

-- ── inventory_movements: composite (location_id, movement_type, moved_at) ────
-- Location-specific sales/return queries
CREATE INDEX IF NOT EXISTS idx_movements_location_type_date
  ON inventory_movements(location_id, movement_type, moved_at DESC);

-- ── skus: GIN trigram index on color_name ────────────────────────────────────
-- All colour queries use ILIKE '%BLACK%' — leading % makes btree useless, needs trgm
-- pg_trgm extension already enabled in schema.sql
CREATE INDEX IF NOT EXISTS idx_skus_color_name_trgm
  ON skus USING gin(color_name gin_trgm_ops);

-- ── locations: state and city individual indexes ──────────────────────────────
-- Table filters, analytics endpoints all filter l.state ILIKE 'X' / l.city ILIKE 'X'
CREATE INDEX IF NOT EXISTS idx_locations_state
  ON locations(state)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_locations_city
  ON locations(city)
  WHERE is_active = true;

-- ── locations: GIN trigram index on name ─────────────────────────────────────
-- Location search uses name ILIKE '%query%' — leading % needs trgm
CREATE INDEX IF NOT EXISTS idx_locations_name_trgm
  ON locations USING gin(name gin_trgm_ops);

-- ── stock_ageing: sku_id and ageing_date ─────────────────────────────────────
-- SKU-level ageing queries had no index support
CREATE INDEX IF NOT EXISTS idx_ageing_sku
  ON stock_ageing(sku_id);

CREATE INDEX IF NOT EXISTS idx_ageing_date
  ON stock_ageing(ageing_date DESC);

-- ── dispatch_orders: composite (status, dispatched_at) ───────────────────────
-- "Pending dispatches older than N days" queries
CREATE INDEX IF NOT EXISTS idx_dispatch_status_date
  ON dispatch_orders(status, dispatched_at DESC);
