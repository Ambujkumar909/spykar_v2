-- ─── Migration 021: lean primary-sales ledger + durable ETL state ─────────────
-- The MITTRA ledger (primary_sales_movements) is ~10M rows locally and ~110M on
-- prod. The dashboard NEVER reads it — every page query reads the
-- primary_sales_daily rollup. The ledger's only access paths are:
--   • the real MITTRA key (cono,whlo,itno,rgdt,rgtm,tmsx) → delta UPSERT
--   • trdt                                                → incremental rollup,
--                                                            reconcile, ageing FIFO
-- Everything else on it was dead weight that slowed every upsert and the
-- backfill (each extra index = one more b-tree hit per row) and ate disk
-- (~3 GB of indexes locally, ~30 GB on prod). pg_stat_user_indexes showed 0
-- scans on all of them. Idempotent — safe to re-run.

-- ── 1) Ledger: drop the never-read secondary indexes ─────────────────────────
DROP INDEX IF EXISTS idx_primary_mv_warehouse_date;
DROP INDEX IF EXISTS idx_primary_mv_sku_date;
DROP INDEX IF EXISTS idx_primary_mv_type_date;
DROP INDEX IF EXISTS idx_primary_mv_trdt_ttyp;   -- 015 leftover, if it ever landed
DROP INDEX IF EXISTS idx_primary_mv_lmts;        -- 014 leftover, if it ever landed

-- The surrogate UUID primary key: nothing references primary_sales_movements.id
-- (no FKs, no code path). The real identity is the unique MITTRA key, which
-- stays as uq_primary_movement. Dropping a column is O(1) in Postgres (no table
-- rewrite) and removes a ~4 GB index on prod plus 16 bytes/row of UUID
-- generation on every insert.
ALTER TABLE primary_sales_movements DROP CONSTRAINT IF EXISTS primary_sales_movements_pkey;
ALTER TABLE primary_sales_movements DROP COLUMN IF EXISTS id;

-- ── 2) Rollup: every read is TRDT-windowed; wh/sku/ttyp indexes had 0 scans ──
-- Fewer indexes = faster incremental DELETE+INSERT per date after each sync.
DROP INDEX IF EXISTS idx_psd_wh;
DROP INDEX IF EXISTS idx_psd_sku;
DROP INDEX IF EXISTS idx_psd_ttyp;

-- ── 3) Durable ETL state (the pipeline must self-heal across crashes) ────────

-- Dates whose rollup is stale. pullMerge() marks them in the SAME transaction
-- as the ledger merge; refreshRollupFromDirty() re-aggregates and clears them
-- in the same transaction as the rollup write. A crash between the two leaves
-- the dates marked → the next run heals them. Nothing is ever "lost".
CREATE TABLE IF NOT EXISTS primary_rollup_dirty (
  trdt       DATE         PRIMARY KEY,
  marked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-day reconcile memory: source (M3) vs target (PG) counts at the last
-- check. Days whose ITNOs aren't in the SKU master are PERMANENTLY short
-- (src > pg); without this table reconcile re-pulled every such day on every
-- run — one full M3 scan per day, forever. Now a day is re-pulled only when
-- the source count CHANGED since the last check (or the target shrank).
CREATE TABLE IF NOT EXISTS primary_reconcile_state (
  trdt        DATE         PRIMARY KEY,
  src_count   BIGINT       NOT NULL,
  tgt_count   BIGINT       NOT NULL,
  checked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Resumable backfill: the full history is streamed per WHLO (the 2nd column of
-- MITTRA's clustered key, so each chunk is a range seek on M3). A completed
-- chunk is never re-streamed after a crash/VPN drop; a chunk caught mid-stream
-- is wiped and redone.
CREATE TABLE IF NOT EXISTS primary_backfill_progress (
  scope        TEXT         NOT NULL,   -- 'FULL' or 'YYYY-MM-DD..YYYY-MM-DD'
  whlo         VARCHAR(10)  NOT NULL,
  status       TEXT         NOT NULL,   -- running | done
  rows_loaded  BIGINT       NOT NULL DEFAULT 0,
  max_lmts     TIMESTAMPTZ,
  started_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  PRIMARY KEY (scope, whlo)
);

-- Which M3 item codes / warehouses could not be mapped and were skipped. This
-- turns the silent "N lookup misses" log line into an actionable list for the
-- SKU-master owner, and explains the reconcile residual.
CREATE TABLE IF NOT EXISTS primary_unmapped_items (
  itno           VARCHAR(80)  PRIMARY KEY,  -- item code, or 'WH:<whlo>' for an unknown warehouse
  rows_seen      BIGINT       NOT NULL DEFAULT 0,  -- cumulative across runs (overlap re-reads count again)
  last_run_rows  BIGINT       NOT NULL DEFAULT 0,
  first_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_label     TEXT
);

-- ── 4) Leftover from the abandoned Stock Availability daily-totals mirror ────
-- Its code + migration 020 were deleted from git, but a DB that ran the
-- migration before the revert still carries the table. Nothing reads it.
DROP TABLE IF EXISTS inventory_daily_totals;

ANALYZE primary_sales_movements;
ANALYZE primary_sales_daily;
