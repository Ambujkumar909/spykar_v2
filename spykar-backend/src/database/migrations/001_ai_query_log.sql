CREATE TABLE IF NOT EXISTS ai_query_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  generated_sql TEXT,
  row_count     INTEGER DEFAULT 0,
  answer        TEXT,
  execution_ms  INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_log_user ON ai_query_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_date ON ai_query_log(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN
    ALTER TABLE users ADD COLUMN phone VARCHAR(15);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='zone_id') THEN
    ALTER TABLE users ADD COLUMN zone_id INTEGER REFERENCES zones(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='location_id') THEN
    ALTER TABLE users ADD COLUMN location_id UUID REFERENCES locations(id);
  END IF;
END $$;