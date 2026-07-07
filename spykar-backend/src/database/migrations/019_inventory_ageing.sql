-- ─── Migration 019: inventory ageing (the precompute layer) ──────────────────
-- "How old is the stock we're holding?" There is NO receipt feed at store level
-- and reconstructing FIFO per (warehouse,sku) over the MITTRA ledger takes ~36s,
-- so ageing is PRECOMPUTED into this table by load_inventory_ageing.js and read
-- back instantly. Two independent engines write here:
--
--   • source='warehouse' — TRUE FIFO on the M3 MITTRA ledger
--       (primary_sales_movements). Current on-hand per (warehouse,sku) = Σtrqt;
--       the remaining units are the NEWEST receipts (FIFO consumes oldest first),
--       so each in-stock unit is dated by the receipt it belongs to. ref_id =
--       warehouse_id.
--   • source='store' — CONTINUOUS-ON-HAND on inventory_daily_snapshot. Units
--       that stayed on hand across the whole trailing D-day window are ≥D days
--       old (min on-hand over the window). Only buckets whose window is fully
--       covered by loaded snapshots are credited; the rest fall into the
--       'undetermined' bucket until history deepens. ref_id = location_id.
--
-- Grain is per-SKU per-ref so the read layer can aggregate/filter by ANY Lens
-- dimension (join skus + locations/warehouses), exactly like the pivots.
-- Idempotent: the loader DELETEs the (as_of_date, source) slice, then re-inserts.

CREATE TABLE IF NOT EXISTS inventory_ageing (
  as_of_date   DATE          NOT NULL,
  source       TEXT          NOT NULL CHECK (source IN ('warehouse', 'store')),
  ref_id       UUID          NOT NULL,          -- warehouse_id | location_id
  sku_id       UUID          NOT NULL,
  age_bucket   SMALLINT      NOT NULL,          -- 0:0-30 1:31-60 2:61-90 3:91-180 4:181-365 5:365+ 9:undetermined
  units        NUMERIC(20,3) NOT NULL,
  value_gross  NUMERIC(22,2) NOT NULL,          -- units × mrp
  value_cost   NUMERIC(22,2) NOT NULL,          -- units × cost_price
  PRIMARY KEY (as_of_date, source, ref_id, sku_id, age_bucket)
);

CREATE INDEX IF NOT EXISTS idx_ageing_src_sku ON inventory_ageing (source, sku_id);
CREATE INDEX IF NOT EXISTS idx_ageing_src_ref ON inventory_ageing (source, ref_id);
CREATE INDEX IF NOT EXISTS idx_ageing_asof    ON inventory_ageing (as_of_date);

-- Bookkeeping: what the loader computed + how deep the history reached (so the
-- UI can honestly say "store ageing is only proven to N days so far").
CREATE TABLE IF NOT EXISTS inventory_ageing_meta (
  source          TEXT PRIMARY KEY,
  as_of_date      DATE,
  covered_days    INTEGER,          -- store: as_of − earliest snapshot; warehouse: as_of − earliest movement
  rows_written    BIGINT,
  computed_at     TIMESTAMPTZ DEFAULT now()
);
