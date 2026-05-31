-- ─── Migration 011: drop junk notes index (sync-merge performance) ────────────
-- The uq_inv_movements_notes UNIQUE index on inventory_movements(notes) was never
-- created by any prior migration, indexes a free-text column nothing queries
-- (idx_scan = 0), and forced an extra unique-index probe on every one of the
-- millions of rows a FULL sync inserts. Dropping it removes pure merge overhead.
--
-- Safe to run multiple times (IF EXISTS). Non-destructive: drops an index only,
-- no data change.
DROP INDEX IF EXISTS uq_inv_movements_notes;
