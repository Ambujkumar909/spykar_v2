-- ─── Migration 008: Multi-select filter performance ───────────────────────────
-- Targets the "scanning whole DB on multi-select" symptom users see when
-- selecting 2+ values in a dropdown OR filtering across multiple dropdowns.
--
-- Root cause: filterBuilder.js emits predicates as
--     UPPER(col) = ANY($n::text[])
-- to support case-insensitive multi-select. Postgres CANNOT use a plain
-- btree index on `col` for `UPPER(col) = …` — it falls back to a sequence
-- scan over the full table (skus ~50K, inventory_movements ~2.7M rows).
--
-- Fix: functional btree indexes on UPPER(col). Postgres uses these for both
-- `UPPER(col) = $1` (single-value) and `UPPER(col) = ANY($1::text[])`
-- (multi-select). Each predicate becomes an index seek, so adding the 2nd,
-- 3rd, Nth filter option scales O(log n) per value — flat in user
-- perception, not linear in selections.
--
-- Safe to run multiple times (IF NOT EXISTS on every index).
-- Non-destructive: read-side indexes only.

-- ── SKU dimensions (drilldown filter set — 11 dimensions) ────────────────────
-- These are the dropdowns the user clicks: gender, category, product, etc.
-- The skus table is small (~50K) but joined to inventory_movements (2.7M),
-- so a sequence scan of skus + nested loop produces millions of comparisons.

CREATE INDEX IF NOT EXISTS idx_skus_upper_gender_name
  ON skus (UPPER(gender_name)) WHERE is_active = true;

-- Used both for filter predicates AND for the category→sku_id resolver in
-- categoryFilter.js (cached 24h in Redis, but the cold scan still touches
-- this index instead of doing a full skus seq scan).
CREATE INDEX IF NOT EXISTS idx_skus_upper_category_norm
  ON skus (UPPER(category_norm)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_product
  ON skus (UPPER(product)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_sub_product
  ON skus (UPPER(sub_product)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_size
  ON skus (UPPER(size)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_color_name
  ON skus (UPPER(color_name)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_shade
  ON skus (UPPER(shade)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_style
  ON skus (UPPER(style)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_season
  ON skus (UPPER(season)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_brand
  ON skus (UPPER(brand)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_skus_upper_fit_name
  ON skus (UPPER(fit_name)) WHERE is_active = true;

-- ── Location dimensions ──────────────────────────────────────────────────────
-- Locations is small (~280 rows) but joined per-movement. Functional indexes
-- still help because the planner picks index seek over seq scan even on small
-- tables when the leading column is a function expression.

CREATE INDEX IF NOT EXISTS idx_locations_upper_state
  ON locations (UPPER(state)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_locations_upper_city
  ON locations (UPPER(city)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_locations_upper_group_name
  ON locations (UPPER(group_name)) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_locations_upper_code
  ON locations (UPPER(code)) WHERE is_active = true;

-- ── Mode lens accelerator ────────────────────────────────────────────────────
-- Every endpoint that supports Active/Inactive/All adds `l.shop_closed = $`
-- to the WHERE. Tiny table, but tab-flip latency adds up because this is the
-- final predicate and the planner re-evaluates it for every joined row when
-- shop_closed is not in any index.

CREATE INDEX IF NOT EXISTS idx_locations_shop_closed
  ON locations (shop_closed, is_active);

-- ── Update planner stats so the new indexes are picked immediately ───────────
ANALYZE skus;
ANALYZE locations;
