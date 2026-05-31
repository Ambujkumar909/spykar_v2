-- Fast full-snapshot rebuild from stg_stock (proves the optimized path).
-- Safe: full replace (matches ERP full-snapshot semantics); GROUP BY
-- guarantees (location_id, sku_id) uniqueness; the FK constraints are
-- re-added at the end, which bulk-validates referential integrity (a strong
-- data-quality gate) instead of paying a per-row check on all 5M inserts.
BEGIN;
SET LOCAL work_mem = '2GB';
SET LOCAL maintenance_work_mem = '2GB';
SET LOCAL synchronous_commit = off;

TRUNCATE inventory_snapshot;

-- Remove per-row FK validation during the trusted bulk load.
ALTER TABLE inventory_snapshot DROP CONSTRAINT inventory_snapshot_location_id_fkey;
ALTER TABLE inventory_snapshot DROP CONSTRAINT inventory_snapshot_sku_id_fkey;

-- Drop the 8 secondary indexes (keep pkey + unique constraint).
DROP INDEX idx_inventory_snapshot_location;
DROP INDEX idx_snapshot_date;
DROP INDEX idx_snapshot_loc_sku;
DROP INDEX idx_snapshot_location;
DROP INDEX idx_snapshot_low;
DROP INDEX idx_snapshot_qty;
DROP INDEX idx_snapshot_qty_safety;
DROP INDEX idx_snapshot_sku;

-- Bulk insert — no ON CONFLICT (table is empty; GROUP BY dedupes).
INSERT INTO inventory_snapshot (location_id, sku_id, qty_on_hand, last_movement_at, updated_at)
SELECT location_id, sku_id, SUM(qty)::int, NOW(), NOW()
FROM   stg_stock
GROUP BY location_id, sku_id;

-- Recreate the secondary indexes in bulk (parallel, uses maintenance_work_mem).
CREATE INDEX idx_inventory_snapshot_location ON public.inventory_snapshot USING btree (location_id) INCLUDE (qty_on_hand, qty_available, qty_in_transit);
CREATE INDEX idx_snapshot_date ON public.inventory_snapshot USING btree (snapshot_date);
CREATE INDEX idx_snapshot_loc_sku ON public.inventory_snapshot USING btree (location_id, sku_id);
CREATE INDEX idx_snapshot_location ON public.inventory_snapshot USING btree (location_id);
CREATE INDEX idx_snapshot_low ON public.inventory_snapshot USING btree (qty_on_hand) WHERE (qty_on_hand <= safety_stock);
CREATE INDEX idx_snapshot_qty ON public.inventory_snapshot USING btree (qty_on_hand);
CREATE INDEX idx_snapshot_qty_safety ON public.inventory_snapshot USING btree (qty_on_hand, safety_stock);
CREATE INDEX idx_snapshot_sku ON public.inventory_snapshot USING btree (sku_id);

-- Re-add FK constraints — bulk-validates referential integrity in one pass.
ALTER TABLE inventory_snapshot ADD CONSTRAINT inventory_snapshot_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
ALTER TABLE inventory_snapshot ADD CONSTRAINT inventory_snapshot_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES skus(id);

COMMIT;
