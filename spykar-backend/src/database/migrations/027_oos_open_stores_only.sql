-- ─── Migration 027: out of stock = OPEN stores only ──────────────────────────
-- Owner's rule: out-of-stock and alerts are for active stores only. A store's
-- closure lives in locations.shop_closed (is_active stays true so closed stores
-- keep their history), so v_oos_positions must exclude shop_closed stores —
-- otherwise every SKU a closed store ever sold reads as "out of stock" there.
CREATE OR REPLACE VIEW v_oos_positions AS
SELECT p.location_id, p.sku_id
  FROM stock_positions p
  JOIN locations l ON l.id = p.location_id AND l.is_active = true AND l.shop_closed = false
  JOIN skus s      ON s.id = p.sku_id      AND s.is_active = true
 WHERE NOT EXISTS (SELECT 1 FROM inventory_snapshot i
                    WHERE i.location_id = p.location_id AND i.sku_id = p.sku_id AND i.qty_on_hand > 0);
