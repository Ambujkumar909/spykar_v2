-- ─── Migration 018: primary-sales daily rollup (the speed layer) ─────────────
-- Aggregating the 9.66M-row (110M on prod) MITTRA ledger per dashboard request
-- takes ~60s — over the API's 45s timeout. This rollup pre-aggregates to grain
-- (trdt, warehouse_id, sku_id, ttyp) — 9.66M → 3.6M for the FY — with measures
-- pre-summed, so every dashboard query reads a narrow, indexed table and returns
-- in ~1s. Mirrors the srd_store/srd_sku pattern used by the sales page.
--
-- Rebuilt by primarySales.rebuildRollup() after every backfill/delta.

CREATE TABLE IF NOT EXISTS primary_sales_daily (
  trdt          DATE          NOT NULL,
  warehouse_id  UUID          NOT NULL,
  sku_id        UUID          NOT NULL,
  ttyp          VARCHAR(10),
  qty           NUMERIC(20,3) NOT NULL,   -- Σ trqt (signed)
  gross         NUMERIC(22,2) NOT NULL,   -- Σ qty×price (signed net value)
  gross_abs     NUMERIC(22,2) NOT NULL,   -- Σ |qty×price| (throughput)
  cost          NUMERIC(22,2) NOT NULL,   -- Σ qty×purchase price
  txns          INTEGER       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_psd_trdt          ON primary_sales_daily (trdt);
CREATE INDEX IF NOT EXISTS idx_psd_trdt_brin     ON primary_sales_daily USING BRIN (trdt) WITH (pages_per_range = 32);
CREATE INDEX IF NOT EXISTS idx_psd_wh            ON primary_sales_daily (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_psd_sku           ON primary_sales_daily (sku_id);
CREATE INDEX IF NOT EXISTS idx_psd_ttyp          ON primary_sales_daily (ttyp);
