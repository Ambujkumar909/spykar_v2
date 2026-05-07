DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'state'
  ) THEN
    ALTER TABLE users ADD COLUMN state VARCHAR(100);
  END IF;
END $$;
