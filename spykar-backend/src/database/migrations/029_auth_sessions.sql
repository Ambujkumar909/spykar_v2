-- ─── Migration 029: server-side sessions + refresh-token families ───────────
-- One row per signed-in device. Every access token carries its session id
-- (sid), so ending a session takes effect on the next request, and every
-- refresh token belongs to exactly one session (its rotation family):
--   • rotation keeps the rotated-out row (rotated_at) for REUSE DETECTION —
--     a rotated token replayed after the grace window ends the whole session;
--   • idle_expires_at slides forward on every refresh (active users are never
--     cut off); absolute_expires_at caps a session's total life.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idle_expires_at      TIMESTAMPTZ NOT NULL,
  absolute_expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoke_reason        TEXT,
  ip                   TEXT,
  user_agent           TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES auth_sessions(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens (session_id);

-- Existing signed-in users keep their session: each live refresh token becomes
-- its own session (idle window = the token's remaining life; 30-day cap).
DO $$
DECLARE r RECORD; sid UUID;
BEGIN
  FOR r IN SELECT id, user_id, expires_at, created_at FROM refresh_tokens
            WHERE session_id IS NULL AND expires_at > NOW() LOOP
    INSERT INTO auth_sessions (user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, user_agent)
    VALUES (r.user_id, COALESCE(r.created_at, NOW()), NOW(), r.expires_at, NOW() + INTERVAL '30 days', 'migrated (029)')
    RETURNING id INTO sid;
    UPDATE refresh_tokens SET session_id = sid WHERE id = r.id;
  END LOOP;
END $$;
DELETE FROM refresh_tokens WHERE session_id IS NULL AND expires_at <= NOW();

-- One live row per token value; the hash is looked up on every refresh.
DROP INDEX IF EXISTS idx_refresh_tokens_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_tokens_hash ON refresh_tokens (token_hash);
