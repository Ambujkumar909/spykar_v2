-- ─── Migration 030: primary warehouse stock on hand ─────────────────────────
-- The Primary Inventory headline is STOCK × COGS, not movement throughput.
-- MITTRA.NSTT is the on-hand balance after each transaction (verified: it
-- equals the running Σ trqt per warehouse × item), so the latest row of each
-- (cono, whlo, itno) is that position's stock now. Finding it over the ~118M-row
-- ledger takes minutes, so it is kept here and refreshed per sync for only the
-- keys a merge touched (primary_stock_dirty, marked in the merge transaction).
--
-- COGS = MITMAS.PUPR (item purchase price, stored on each ledger row as pupr).
-- NOT skus.cost_price — that is a placeholder MRP × 0.45 from the item loader.
--
-- Populated by `npm run primary:stock` (full build, ~3–5 min); the sync then
-- keeps it current. An empty table is rebuilt in full on the next sync.

CREATE TABLE IF NOT EXISTS primary_stock (
  cono          SMALLINT      NOT NULL,
  whlo          VARCHAR(10)   NOT NULL,
  itno          VARCHAR(60)   NOT NULL,
  warehouse_id  UUID          NOT NULL,
  sku_id        UUID          NOT NULL,
  qty           NUMERIC(18,3) NOT NULL,
  pupr          NUMERIC(18,4),
  last_trdt     DATE,
  refreshed_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cono, whlo, itno)
);
CREATE INDEX IF NOT EXISTS idx_primary_stock_wh ON primary_stock (warehouse_id);

CREATE TABLE IF NOT EXISTS primary_stock_dirty (
  cono  SMALLINT     NOT NULL,
  whlo  VARCHAR(10)  NOT NULL,
  itno  VARCHAR(60)  NOT NULL,
  PRIMARY KEY (cono, whlo, itno)
);
