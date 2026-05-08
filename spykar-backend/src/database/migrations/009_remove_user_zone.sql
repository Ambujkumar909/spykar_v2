DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'zone_id'
  ) THEN
    ALTER TABLE users DROP COLUMN zone_id;
  END IF;
END $$;
