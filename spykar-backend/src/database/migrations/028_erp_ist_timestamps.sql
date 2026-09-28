-- ─── Migration 028: ERP movement times are IST, not UTC ──────────────────────
-- The ERP's DATE is a zone-less IST datetime; the sync stored it as if it were
-- UTC, so every TIMED movement sat 5h30m late — a return at 20:30 IST read as
-- 02:00 IST the next day ("today" showed returns with no sales → negative net).
-- syncEngine.erpDateTime() now converts timed values on the way in; this
-- shifts the rows already loaded. Date-only rows (00:00Z, every sale) keep the
-- established 00:00Z convention and are untouched, so re-synced rows match.
--
-- Uniform shift of the affected rows only; the unique key
-- (location_id, sku_id, movement_type, reference_no, moved_at) is checked first.
DO $$
DECLARE clash bigint;
BEGIN
  SELECT COUNT(*) INTO clash
    FROM inventory_movements a
    JOIN inventory_movements b
      ON b.location_id = a.location_id AND b.sku_id = a.sku_id
     AND b.movement_type = a.movement_type AND b.reference_no IS NOT DISTINCT FROM a.reference_no
     AND b.moved_at = a.moved_at - INTERVAL '5 hours 30 minutes'
   WHERE a.movement_type IN ('SALE', 'RETURN')
     AND (a.moved_at AT TIME ZONE 'UTC')::time <> '00:00:00';
  IF clash > 0 THEN
    RAISE EXCEPTION 'migration 028: % shifted rows would collide with existing rows — aborting', clash;
  END IF;
END $$;

UPDATE inventory_movements
   SET moved_at = moved_at - INTERVAL '5 hours 30 minutes'
 WHERE movement_type IN ('SALE', 'RETURN')
   AND (moved_at AT TIME ZONE 'UTC')::time <> '00:00:00';
