-- ─── Migration 002: Spykar ERP column additions ──────────────────────────────
-- Adds columns required for real Spykar stored-procedure data sources.
-- Safe to run multiple times (uses IF NOT EXISTS / DO $$).

-- ── New columns on skus ───────────────────────────────────────────────────────
ALTER TABLE skus ADD COLUMN IF NOT EXISTS gender        VARCHAR(10);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS season        VARCHAR(50);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS style_code    VARCHAR(100);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS brand         VARCHAR(50);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS style_variant VARCHAR(60);

-- Index for fast sales lookup via style_variant (SalesAI returns this field)
CREATE INDEX IF NOT EXISTS idx_skus_style_variant
  ON skus(style_variant)
  WHERE style_variant IS NOT NULL;

-- ── New columns on inventory_movements ───────────────────────────────────────
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS sale_value   DECIMAL(12,2);

-- ── Idempotency index for sales/return movements ──────────────────────────────
-- Prevents duplicate rows when the daily delta sync overlaps dates.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_movements_reference'
  ) THEN
    CREATE UNIQUE INDEX uq_movements_reference
      ON inventory_movements(location_id, sku_id, movement_type, reference_no, moved_at)
      WHERE reference_no IS NOT NULL;
  END IF;
END $$;
