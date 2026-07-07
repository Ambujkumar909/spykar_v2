-- ─── Migration 016: correct the Primary-sales schema to the REAL MITTRA shape ─
-- Phase 0 discovery against the live M3 server (10.2.0.6) revealed the loader's
-- assumptions from 014/015 were wrong:
--   • TRDT / RGDT are real DATE columns (not int yyyymmdd)
--   • LMTS is DATETIME2 (not a bigint sequence) — the true delta high-water
--   • the real MITTRA primary key is (CONO,WHLO,ITNO,RGDT,RGTM,TMSX);
--     (cono,whlo,itno,repn) had 102M dupes across 110M rows — NOT unique.
--   • TTYP is an int (stored here as text, which is fine)
-- The 014 tables are empty, so we DROP + recreate them cleanly with the correct
-- columns, unique key, and index set (superseding 014 + 015 for these objects).

DROP TABLE IF EXISTS stg_primary_sales;
DROP TABLE IF EXISTS primary_sales_movements;

CREATE TABLE primary_sales_movements (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  UUID          NOT NULL REFERENCES primary_warehouses(id),
  sku_id        UUID          NOT NULL REFERENCES skus(id),
  cono          SMALLINT      NOT NULL,
  whlo          VARCHAR(10)   NOT NULL,
  itno          VARCHAR(60)   NOT NULL,
  trdt          DATE,                       -- transaction (business) date
  rgdt          DATE          NOT NULL,      -- registration date  ┐ real M3 PK
  rgtm          INTEGER       NOT NULL,      -- registration time  │ (CONO,WHLO,
  tmsx          INTEGER       NOT NULL,      -- ts sequence        ┘  ITNO,RGDT,RGTM,TMSX)
  nstt          NUMERIC(18,3),               -- on-hand qty after txn
  ttyp          VARCHAR(10),                 -- transaction type (int in source)
  trtp          VARCHAR(10),
  whsl          VARCHAR(20),
  trpr          NUMERIC(18,4),
  pupr          NUMERIC(18,4),
  trqt          NUMERIC(18,3) NOT NULL,      -- SIGNED transaction quantity
  repn          BIGINT,
  stas          VARCHAR(10),
  lmts          TIMESTAMPTZ,                 -- M3 row timestamp — the delta high-water
  synced_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- True natural key. Declared as a UNIQUE INDEX (not a table constraint) so the
-- backfill can drop it for a fast index-light bulk COPY and rebuild it after.
CREATE UNIQUE INDEX uq_primary_movement
  ON primary_sales_movements (cono, whlo, itno, rgdt, rgtm, tmsx);

CREATE INDEX idx_primary_mv_warehouse_date ON primary_sales_movements (warehouse_id, trdt DESC);
CREATE INDEX idx_primary_mv_sku_date       ON primary_sales_movements (sku_id, trdt DESC);
CREATE INDEX idx_primary_mv_type_date      ON primary_sales_movements (ttyp, trdt DESC);
CREATE INDEX idx_primary_mv_trdt           ON primary_sales_movements (trdt);
CREATE INDEX idx_primary_mv_trdt_brin      ON primary_sales_movements USING BRIN (trdt) WITH (pages_per_range = 32);

-- Staging mirrors the data columns (no id / synced_at). UNLOGGED for fast COPY.
CREATE UNLOGGED TABLE stg_primary_sales (
  warehouse_id  UUID          NOT NULL,
  sku_id        UUID          NOT NULL,
  cono          SMALLINT      NOT NULL,
  whlo          VARCHAR(10)   NOT NULL,
  itno          VARCHAR(60)   NOT NULL,
  trdt          DATE,
  rgdt          DATE          NOT NULL,
  rgtm          INTEGER       NOT NULL,
  tmsx          INTEGER       NOT NULL,
  nstt          NUMERIC(18,3),
  ttyp          VARCHAR(10),
  trtp          VARCHAR(10),
  whsl          VARCHAR(20),
  trpr          NUMERIC(18,4),
  pupr          NUMERIC(18,4),
  trqt          NUMERIC(18,3) NOT NULL,
  repn          BIGINT,
  stas          VARCHAR(10),
  lmts          TIMESTAMPTZ
);

-- High-water is now a timestamp (LMTS is datetime2). Add the column; keep the
-- legacy bigint column harmless.
ALTER TABLE primary_sync_state ADD COLUMN IF NOT EXISTS last_lmts_ts TIMESTAMPTZ;
