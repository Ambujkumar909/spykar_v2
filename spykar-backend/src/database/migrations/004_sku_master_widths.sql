-- Preserve full SQL Server item-master values without truncation.
-- Must drop and recreate v_inventory_full because it references skus.size.

DROP VIEW IF EXISTS v_inventory_full;

ALTER TABLE skus ALTER COLUMN size   TYPE VARCHAR(30);
ALTER TABLE skus ALTER COLUMN gender TYPE VARCHAR(20);

CREATE OR REPLACE VIEW v_inventory_full AS
SELECT
  i.id,
  l.id   AS location_id,
  l.code AS location_code,
  l.name AS location_name,
  l.type AS location_type,
  z.name AS zone_name,
  l.city,
  l.state,
  s.id           AS sku_id,
  s.sku_code,
  s.product_name,
  s.color_code,
  s.color_name,
  s.size,
  s.fit_type,
  s.mrp,
  i.qty_on_hand,
  i.qty_reserved,
  i.qty_in_transit,
  i.qty_available,
  i.safety_stock,
  i.reorder_point,
  CASE WHEN i.qty_on_hand <= i.safety_stock THEN true ELSE false END AS is_below_safety,
  i.last_movement_at,
  i.updated_at
FROM inventory_snapshot i
JOIN locations l ON l.id = i.location_id
LEFT JOIN zones z ON z.id = l.zone_id
JOIN skus s ON s.id = i.sku_id
WHERE l.is_active = true AND s.is_active = true;
