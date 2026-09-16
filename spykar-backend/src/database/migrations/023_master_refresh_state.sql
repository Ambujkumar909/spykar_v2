-- ─── Migration 023: master-refresh cadence state ─────────────────────────────
-- The SKU (Item_spykar → skus) and store (AIgetParty → locations) masters are
-- now refreshed automatically every MASTER_REFRESH_EVERY_DAYS (3) days from the
-- sync (src/services/masterRefresh.js). One row per loader remembers when it
-- last ran / succeeded so the cadence survives restarts and a failed or
-- floor-guarded run is retried at the next sync instead of waiting 3 days.
CREATE TABLE IF NOT EXISTS master_refresh_state (
  name             TEXT         PRIMARY KEY,   -- 'locations' | 'skus'
  last_run_at      TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_status      TEXT,                       -- running | success | failed | floor-guard
  last_exit_code   INTEGER,
  rows_before      BIGINT,
  rows_after       BIGINT,
  duration_ms      INTEGER,
  note             TEXT
);
