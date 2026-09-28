-- ─── Migration 024: unique external_id on the two masters ───────────────────
-- load_party_master.js and load_item_master.js upsert with
-- ON CONFLICT (external_id), which Postgres only accepts when a UNIQUE index
-- covers exactly that column. schema.sql created plain indexes, so a FRESH
-- database failed the first master load ("no unique or exclusion constraint
-- matching the ON CONFLICT specification"); older databases had the index
-- added by hand. Idempotent: skipped when any unique index on (external_id)
-- already exists, whatever its name. NULLs stay allowed (NULLs never collide).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'skus'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = t::regclass AND i.indisunique
         AND i.indnkeyatts = 1 AND a.attname = 'external_id' AND i.indpred IS NULL
    ) THEN
      EXECUTE format('CREATE UNIQUE INDEX uq_%s_external_id ON %I (external_id)', t, t);
    END IF;
  END LOOP;
END $$;
