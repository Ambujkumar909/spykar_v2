-- ─── Migration 037: War Room targets ─────────────────────────────────────────
-- Day-wise sales targets per store from the planner's "DaywiseTarget" workbook
-- (dtlake's OneDrive › QlickSense/EBO-Data/Master Files/DaywiseTarget, synced
-- every 3 days at 01:00 by onedrive_pull.sh Target). One row per store × day:
-- target units and target net value (₹). Loaded by load_war_room_targets.js
-- when the file changes (jobs/targetWatcher.js); a load replaces the table in
-- one transaction, so the War Room never sees half a file.

CREATE TABLE IF NOT EXISTS wr_targets (
  external_id text    NOT NULL,          -- the store code (locations.external_id)
  target_date date    NOT NULL,
  qty         numeric NOT NULL DEFAULT 0,
  val         numeric NOT NULL DEFAULT 0, -- ₹
  PRIMARY KEY (external_id, target_date)
);
CREATE INDEX IF NOT EXISTS idx_wr_targets_date ON wr_targets (target_date);

-- What the loaded targets came from (one row per load).
CREATE TABLE IF NOT EXISTS wr_target_loads (
  id          serial PRIMARY KEY,
  files       text        NOT NULL,      -- file name(s)
  sha256      text        NOT NULL,      -- of the file(s) as loaded
  rows_read   integer     NOT NULL,
  store_days  integer     NOT NULL,
  stores      integer     NOT NULL,
  date_from   date,
  date_to     date,
  skipped     jsonb,                     -- rows with no usable store code / date, duplicates
  loaded_at   timestamptz NOT NULL DEFAULT NOW()
);
