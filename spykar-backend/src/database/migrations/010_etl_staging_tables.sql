-- ─── Migration 010: ETL streaming staging tables ─────────────────────────────
-- Purpose: enable the syncEngine's new streaming+COPY pipeline. Postgres COPY
-- does NOT support ON CONFLICT, so the ETL pattern becomes:
--
--   SQL Server stream  →  COPY into staging  →  INSERT … SELECT … ON CONFLICT
--
-- These tables hold raw, untyped, un-deduplicated rows for the duration of a
-- single sync stage. They are TRUNCATEd at the start of each stage so they
-- never grow unbounded — they're scratch space, not durable data.
--
-- UNLOGGED  → no WAL writes during COPY (≈ 3× faster, OK because data is
--             re-derivable from the ERP if the server crashes mid-sync).
-- No PK / no indexes → COPY is sequential write only; we want it to be as
--                       cheap as possible. Indexes for the merge step are on
--                       the destination tables, which the planner already uses.
--
-- Safe to run multiple times (IF NOT EXISTS on every CREATE).
-- Non-destructive: brand-new tables, never referenced by existing controllers.

-- ── stg_stock — raw AIGetStock rows before per-(loc,sku) aggregation ─────────
-- A single AIGetStock pull may emit multiple rows per (loc, sku) when the ERP
-- splits stock across bins. The merge GROUP BYs (loc, sku) and SUMs qty before
-- upserting into inventory_snapshot, preserving today's aggregation semantics
-- (previously done in JS via the qtyByKey Map).
CREATE UNLOGGED TABLE IF NOT EXISTS stg_stock (
  location_id  UUID    NOT NULL,
  sku_id       UUID    NOT NULL,
  qty          INTEGER NOT NULL
);

-- ── stg_movements — raw SalesAI / SalesReturnAI rows ─────────────────────────
-- Movements are NOT pre-aggregated; each ERP row becomes one inventory_movements
-- row. The merge uses the existing unique partial index
--   (location_id, sku_id, movement_type, reference_no, moved_at)
--   WHERE reference_no IS NOT NULL
-- to dedupe via ON CONFLICT DO NOTHING — same semantics as the previous
-- batched INSERT path.
CREATE UNLOGGED TABLE IF NOT EXISTS stg_movements (
  location_id    UUID         NOT NULL,
  sku_id         UUID         NOT NULL,
  movement_type  VARCHAR(20)  NOT NULL,
  qty_change     INTEGER      NOT NULL,
  reference_no   TEXT,
  sale_value     NUMERIC(15,2),
  moved_at       TIMESTAMPTZ  NOT NULL
);
