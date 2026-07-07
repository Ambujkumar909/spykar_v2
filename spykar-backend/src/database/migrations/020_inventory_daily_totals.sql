-- ─── Migration 020: inventory_daily_totals (the sparkline speed layer) ───────
-- The Stock Availability "recent history" sparkline and /range endpoint need the
-- per-day NETWORK total on-hand. Computing that live meant SUM(qty) across the
-- ENTIRE inventory_daily_snapshot on every page load — a full scan that crawls
-- once prod carries real history. This one-row-per-date rollup makes it a
-- few-hundred-row read. Refreshed incrementally by archiveCurrentSnapshot() each
-- sync; seeded here for all existing dates.

CREATE TABLE IF NOT EXISTS inventory_daily_totals (
  snapshot_date DATE PRIMARY KEY,
  total_units   BIGINT      NOT NULL DEFAULT 0,
  value_gross   BIGINT      NOT NULL DEFAULT 0,
  value_cost    BIGINT      NOT NULL DEFAULT 0,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed from whatever snapshots already exist (one-time; idempotent).
INSERT INTO inventory_daily_totals (snapshot_date, total_units, value_gross, value_cost)
SELECT d.snapshot_date,
       SUM(d.qty_on_hand)::bigint,
       SUM(d.qty_on_hand * COALESCE(s.mrp, 0))::bigint,
       SUM(d.qty_on_hand * COALESCE(s.cost_price, 0))::bigint
  FROM inventory_daily_snapshot d
  LEFT JOIN skus s ON s.id = d.sku_id
 GROUP BY d.snapshot_date
ON CONFLICT (snapshot_date) DO UPDATE SET
  total_units = EXCLUDED.total_units,
  value_gross = EXCLUDED.value_gross,
  value_cost  = EXCLUDED.value_cost,
  computed_at = now();
