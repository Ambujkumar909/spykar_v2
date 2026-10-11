-- ─── Migration 031: gross units + per-row direction in the primary rollups ──
-- The rollups stored only the NET qty of each group, so the overview derived
-- "units moved" as |net| per group and Inbound/Outbound from the group's net
-- sign. A group holding both receipts and issues cancelled out: MTD Sep-2026
-- showed 29.5 L units moved against 59.6 L in the ledger, and ~5.9 L
-- transactions fell into "Neutral". These columns carry the per-ROW truth:
--   qty_abs              Σ |trqt|
--   in_*  / out_*        rows with trqt > 0 / trqt < 0 (out_qty is positive)
-- Existing rows default to 0 until `npm run primary:rollup` rebuilds them.

ALTER TABLE primary_sales_daily
  ADD COLUMN IF NOT EXISTS qty_abs       NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_txns       BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_qty        NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_gross_abs  NUMERIC(22,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_txns      BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_qty       NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_gross_abs NUMERIC(22,2) NOT NULL DEFAULT 0;

ALTER TABLE primary_sales_daily_wh
  ADD COLUMN IF NOT EXISTS qty_abs       NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_txns       BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_qty        NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_gross_abs  NUMERIC(22,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_txns      BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_qty       NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_gross_abs NUMERIC(22,2) NOT NULL DEFAULT 0;
