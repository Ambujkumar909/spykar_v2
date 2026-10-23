-- Licence: every key the platform owner issued and someone applied here.
-- The licence (seats, expiry) is worked out from these signed keys alone, so
-- editing a row can only break that key, never add seats or days.
CREATE TABLE IF NOT EXISTS license_keys (
  key_id      text PRIMARY KEY,
  kind        text NOT NULL,
  token       text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT NOW(),
  applied_by  text
);

-- Latest time the server has seen, so winding the clock back does not undo an expiry.
CREATE TABLE IF NOT EXISTS license_clock (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seen  timestamptz NOT NULL
);
