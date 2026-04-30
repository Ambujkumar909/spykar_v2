-- ─── Migration 007: World-class data foundation ───────────────────────────────
-- Foundations for time-travel stock, store-lifecycle awareness, and the rich
-- 11-filter dimension set demanded by the v2 dashboard.
--
-- Design principles:
--   1. 100% accuracy — every historical stock number sourced directly from
--      EXEC AIGetStock 'DD-mon-YY' (no derivation, no math, no drift).
--   2. Resumable — a load log per date lets the backfill script crash & resume
--      without losing progress or duplicating rows.
--   3. Range-partitioned by month — 800 days × ~500K rows = ~400M rows; without
--      partitioning, asOf queries would scan the whole heap. Per-month
--      partitions keep typical queries against a single ~12M-row partition.
--   4. Idempotent — every ALTER uses IF NOT EXISTS, every CREATE TABLE checks
--      pg_class. Safe to run repeatedly during development.
--
-- This migration is non-destructive: no existing column is dropped or renamed.

-- ============================================================================
-- 1. inventory_daily_snapshot — historical stock per (date, location, sku)
-- ============================================================================
-- Source of truth: EXEC AIGetStock 'DD-mon-YY' run once per historical date.
-- We store it raw (qty_on_hand only, no derived columns) so reconciling against
-- the ERP is a one-line equality check.
--
-- Range-partitioned by snapshot_date, monthly. Each partition is created
-- explicitly below — Postgres won't auto-create partitions on insert and the
-- planner needs them present at query time for partition pruning.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'inventory_daily_snapshot') THEN
    CREATE TABLE inventory_daily_snapshot (
      snapshot_date  DATE        NOT NULL,
      location_id    UUID        NOT NULL,
      sku_id         UUID        NOT NULL,
      qty_on_hand    INTEGER     NOT NULL DEFAULT 0,
      source         VARCHAR(20) NOT NULL DEFAULT 'AIGetStock',
      loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (snapshot_date, location_id, sku_id)
    ) PARTITION BY RANGE (snapshot_date);
  END IF;
END $$;

-- ── Monthly partitions Jan 2024 → Feb 2026 (covers full ERP history window) ──
-- Pattern: one CREATE per month. Idempotent via IF NOT EXISTS on each.
DO $$
DECLARE
  yr INT;
  mo INT;
  pfrom DATE;
  pto   DATE;
  pname TEXT;
BEGIN
  FOR yr IN 2024..2026 LOOP
    FOR mo IN 1..12 LOOP
      pfrom := make_date(yr, mo, 1);
      pto   := pfrom + INTERVAL '1 month';
      pname := format('inventory_daily_snapshot_%s_%s', yr, lpad(mo::text, 2, '0'));
      -- Cap at Feb 2026 — ERP data ceiling per syncEngine.js comments
      IF pfrom > DATE '2026-02-28' THEN EXIT; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF inventory_daily_snapshot FOR VALUES FROM (%L) TO (%L)',
          pname, pfrom, pto
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ── Indexes (created on the parent — Postgres propagates to all partitions) ──
-- Composite (date, location) is the hot path for "stock at store X on day Y".
CREATE INDEX IF NOT EXISTS idx_ids_date_loc
  ON inventory_daily_snapshot (snapshot_date, location_id);

-- (location, sku, date) for SKU-centric history queries (stock of SKU X over time).
CREATE INDEX IF NOT EXISTS idx_ids_loc_sku_date
  ON inventory_daily_snapshot (location_id, sku_id, snapshot_date DESC);

-- (sku, date) for cross-store SKU views.
CREATE INDEX IF NOT EXISTS idx_ids_sku_date
  ON inventory_daily_snapshot (sku_id, snapshot_date);

-- ============================================================================
-- 2. stock_history_load_log — checkpoint table for the backfill script
-- ============================================================================
-- One row per date attempted. The loader skips any date marked SUCCESS so a
-- crashed run resumes exactly where it left off. PG_FAILED rows can be retried.

CREATE TABLE IF NOT EXISTS stock_history_load_log (
  snapshot_date   DATE        PRIMARY KEY,
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- PENDING|RUNNING|SUCCESS|FAILED
  erp_rows        INTEGER,                                  -- raw rows from AIGetStock
  resolved_rows   INTEGER,                                  -- rows after store/sku lookup
  lookup_misses   INTEGER     DEFAULT 0,
  duration_ms     INTEGER,
  error_message   TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stock_load_log_status
  ON stock_history_load_log (status, snapshot_date);

-- ============================================================================
-- 3. SKU master — additional Spykar ERP columns (per latest source schema)
-- ============================================================================
-- The screenshot shared by the user lists: Style, Shade, Gender, SubProduct,
-- Product, Category, HSN, HitName, BRANDNAME, GENDERNAME, FITNAME, Season,
-- InforItemCode, InforStyle, Barcode, MRP. Existing columns we keep as-is:
--   - color_code / color_name (use these for shade)
--   - size, fit_type, mrp, barcode, hsn_code, gender, season, brand, style_variant
-- New columns added below for the v2 dashboard's drill-down filter set.

ALTER TABLE skus ADD COLUMN IF NOT EXISTS style          VARCHAR(100);  -- e.g. SP1052
ALTER TABLE skus ADD COLUMN IF NOT EXISTS shade          VARCHAR(50);   -- shade text from ERP
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sub_product    VARCHAR(80);   -- e.g. JEAN, SHIRT, T-SHIRT
ALTER TABLE skus ADD COLUMN IF NOT EXISTS product        VARCHAR(80);   -- e.g. BOTTOM, TOP
ALTER TABLE skus ADD COLUMN IF NOT EXISTS category_norm  VARCHAR(80);   -- normalized from ERP Category
ALTER TABLE skus ADD COLUMN IF NOT EXISTS hit_name       VARCHAR(120);  -- HitName from ERP (style+shade composite)
ALTER TABLE skus ADD COLUMN IF NOT EXISTS gender_name    VARCHAR(20);   -- GENDERNAME (Men/Women/Boys/Girls)
ALTER TABLE skus ADD COLUMN IF NOT EXISTS fit_name       VARCHAR(40);   -- FITNAME (Slim/Regular/Skinny/...)
ALTER TABLE skus ADD COLUMN IF NOT EXISTS infor_item_code VARCHAR(60);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS infor_style    VARCHAR(60);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS gst_rate       NUMERIC(5,2);  -- derived from HSN at ETL time

-- ── Drill-down filter indexes ────────────────────────────────────────────────
-- Most-common drill: Gender → SubProduct → Style. Composite covers all 3.
CREATE INDEX IF NOT EXISTS idx_skus_drill_gender_sub_style
  ON skus (gender_name, sub_product, style)
  WHERE is_active = true;

-- Single-column indexes for filter dropdown population.
CREATE INDEX IF NOT EXISTS idx_skus_style       ON skus (style)         WHERE style       IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skus_shade       ON skus (shade)         WHERE shade       IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skus_sub_product ON skus (sub_product)   WHERE sub_product IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skus_season_v2   ON skus (season)        WHERE season      IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skus_category_norm ON skus (category_norm) WHERE category_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skus_gender_name ON skus (gender_name)   WHERE gender_name IS NOT NULL;

-- ============================================================================
-- 4. Locations master — store lifecycle (active vs closed)
-- ============================================================================
-- ShopClosed flag (1 = closed, 0 = active) and best-effort closed_on date.
-- closed_on is populated by ETL: for any location where shop_closed flips to
-- true, we set closed_on = MAX(moved_at) from inventory_movements as the
-- most reliable proxy for "when did this store stop trading".

ALTER TABLE locations ADD COLUMN IF NOT EXISTS shop_closed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS closed_on   DATE;

-- Composite index for the Active/All mode predicate. Both modes hit this index.
CREATE INDEX IF NOT EXISTS idx_locations_lifecycle
  ON locations (shop_closed, closed_on)
  WHERE is_active = true;

-- Drill-down indexes for State → City and Group filter dropdowns.
CREATE INDEX IF NOT EXISTS idx_locations_state_city
  ON locations (state, city)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_locations_group_v2
  ON locations (group_name)
  WHERE is_active = true AND group_name IS NOT NULL;

-- ============================================================================
-- 5. Refresh planner statistics
-- ============================================================================
ANALYZE skus;
ANALYZE locations;
-- inventory_daily_snapshot intentionally NOT analyzed — empty until backfill.
