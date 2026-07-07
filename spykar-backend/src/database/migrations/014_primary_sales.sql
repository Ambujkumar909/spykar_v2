-- ─── Migration 014: Primary sales (MITTRA) feed ──────────────────────────────
-- A NEW, isolated feed — does NOT touch the store-level inventory_snapshot /
-- inventory_movements pipeline. Source is the raw Infor M3 reporting tables
-- (M3ReportdataPRD.dbo.MITTRA ⋈ MITMAS ⋈ MITWHL), filtered to CONO=92,
-- DIVI='AAA', STCD=1. Warehouses are the "locations" of this feed; ITNO maps
-- to skus via Item_spykar.InforItemCode (skus.infor_item_code / style_variant).
--
-- Safe to run multiple times (IF NOT EXISTS / idempotent).

-- ── primary_warehouses — the AAA warehouse master (from MITWHL) ───────────────
-- Tiny (handful of rows: WHLO 011/012/013/014 + regional). whlo is the natural
-- key within CONO; we keep cono explicit in case a second company is added.
CREATE TABLE IF NOT EXISTS primary_warehouses (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cono        SMALLINT     NOT NULL,
  whlo        VARCHAR(10)  NOT NULL,
  whnm        VARCHAR(120),
  divi        VARCHAR(10),
  faci        VARCHAR(10),
  whty        VARCHAR(10),
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_primary_warehouse UNIQUE (cono, whlo)
);

-- ── primary_sales_movements — one row per MITTRA transaction ──────────────────
-- Stores EVERY movement (we classify by ttyp/trtp in the UI rather than
-- filtering at source — matches the agreed query, which has no type filter).
-- Natural key for idempotent re-runs / delta overlap: (cono, whlo, itno, repn).
--   ⚠ CONFIRM via discovery 0h before trusting this — if (cono,whlo,itno,repn)
--     is not unique, extend the unique index with ridn/ridl/ridx or lmts.
CREATE TABLE IF NOT EXISTS primary_sales_movements (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  UUID         NOT NULL REFERENCES primary_warehouses(id),
  sku_id        UUID         NOT NULL REFERENCES skus(id),
  cono          SMALLINT     NOT NULL,
  whlo          VARCHAR(10)  NOT NULL,
  itno          VARCHAR(60)  NOT NULL,   -- raw M3 item code (kept even after mapping)
  trdt          DATE,                    -- transaction (business) date
  nstt          NUMERIC(18,3),           -- on-hand qty after the transaction
  ttyp          VARCHAR(10),             -- transaction type
  trtp          VARCHAR(10),             -- transaction sub-type
  whsl          VARCHAR(20),             -- stock location within warehouse
  trpr          NUMERIC(18,4),           -- transaction price
  pupr          NUMERIC(18,4),           -- purchase price (from MITMAS.PUPR)
  trqt          NUMERIC(18,3) NOT NULL,  -- transaction quantity (SIGNED — keep sign)
  repn          BIGINT,                  -- M3 transaction sequence (dedup key part)
  stas          VARCHAR(10),             -- status
  lmts          BIGINT,                  -- M3 row timestamp — the DELTA high-water column
  synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_primary_movement UNIQUE (cono, whlo, itno, repn)
);

-- Secondary indexes mirror the dashboard's expected access paths. Dropped during
-- the FULL backfill and rebuilt after (index-light bulk load), like the
-- inventory_movements pattern in syncEngine.js.
CREATE INDEX IF NOT EXISTS idx_primary_mv_warehouse_date ON primary_sales_movements(warehouse_id, trdt DESC);
CREATE INDEX IF NOT EXISTS idx_primary_mv_sku_date       ON primary_sales_movements(sku_id, trdt DESC);
CREATE INDEX IF NOT EXISTS idx_primary_mv_type_date      ON primary_sales_movements(ttyp, trdt DESC);
CREATE INDEX IF NOT EXISTS idx_primary_mv_lmts           ON primary_sales_movements(lmts);

-- ── stg_primary_sales — UNLOGGED scratch for the streaming COPY pipeline ──────
-- Backfill windows run in parallel, so the loader actually uses a per-worker
-- TEMP table (see load_primary_sales.js). This persistent UNLOGGED table is the
-- single-stream (delta) staging target. TRUNCATEd at the start of each use.
CREATE UNLOGGED TABLE IF NOT EXISTS stg_primary_sales (
  warehouse_id  UUID          NOT NULL,
  sku_id        UUID          NOT NULL,
  cono          SMALLINT      NOT NULL,
  whlo          VARCHAR(10)   NOT NULL,
  itno          VARCHAR(60)   NOT NULL,
  trdt          DATE,
  nstt          NUMERIC(18,3),
  ttyp          VARCHAR(10),
  trtp          VARCHAR(10),
  whsl          VARCHAR(20),
  trpr          NUMERIC(18,4),
  pupr          NUMERIC(18,4),
  trqt          NUMERIC(18,3) NOT NULL,
  repn          BIGINT,
  stas          VARCHAR(10),
  lmts          BIGINT
);

-- ── primary_sync_state — the delta high-water mark ───────────────────────────
-- Single-row-per-feed table. last_lmts = the MAX(MITTRA.LMTS) we have ingested.
-- The daily delta pulls WHERE LMTS > last_lmts, then advances this value.
CREATE TABLE IF NOT EXISTS primary_sync_state (
  feed         VARCHAR(40)  PRIMARY KEY,
  last_lmts    BIGINT       NOT NULL DEFAULT 0,
  last_trdt    DATE,
  last_run_at  TIMESTAMPTZ,
  rows_total   BIGINT       NOT NULL DEFAULT 0
);

INSERT INTO primary_sync_state (feed, last_lmts)
VALUES ('mittra_primary_sales', 0)
ON CONFLICT (feed) DO NOTHING;
