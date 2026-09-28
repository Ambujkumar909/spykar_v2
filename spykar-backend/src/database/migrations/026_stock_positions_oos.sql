-- ─── Migration 026: carried positions → one out-of-stock definition ──────────
-- Business rule (confirmed by the owner): OUT OF STOCK = the SKU is in the
-- master and the store carries it, but its stock is 0 now.
--
-- inventory_snapshot holds only POSITIVE stock (the sync deletes a position
-- when it sells out), so "0 now" = no positive snapshot row. There is no
-- store-level assortment master, so "the store carries it" = the ERP has listed
-- that SKU in that store's stock (any AIGetStock row, including zero-qty bins)
-- or the store has sold / returned it. stock_positions remembers every such
-- pair; the sync adds today's pairs on every run (syncEngine.js).
--
-- v_oos_positions is the ONE definition every out-of-stock number reads.

CREATE TABLE IF NOT EXISTS stock_positions (
  location_id  UUID  NOT NULL REFERENCES locations(id),
  sku_id       UUID  NOT NULL REFERENCES skus(id),
  first_seen   DATE  NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (location_id, sku_id)
);

-- Seed from everything already known (idempotent).
INSERT INTO stock_positions (location_id, sku_id)
SELECT location_id, sku_id FROM inventory_snapshot
UNION
SELECT DISTINCT location_id, sku_id FROM inventory_movements WHERE movement_type IN ('SALE', 'RETURN')
UNION
SELECT DISTINCT location_id, sku_id FROM inventory_daily_snapshot
ON CONFLICT DO NOTHING;

CREATE OR REPLACE VIEW v_oos_positions AS
SELECT p.location_id, p.sku_id
  FROM stock_positions p
  JOIN locations l ON l.id = p.location_id AND l.is_active = true
  JOIN skus s      ON s.id = p.sku_id      AND s.is_active = true
 WHERE NOT EXISTS (SELECT 1 FROM inventory_snapshot i
                    WHERE i.location_id = p.location_id AND i.sku_id = p.sku_id AND i.qty_on_hand > 0);

CREATE INDEX IF NOT EXISTS idx_stock_positions_sku ON stock_positions (sku_id);

ANALYZE stock_positions;
