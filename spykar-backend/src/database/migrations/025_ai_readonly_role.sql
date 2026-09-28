-- ─── Migration 025: restricted role for AI-generated SQL ──────────────────────
-- The AI assistant turns questions into SQL and runs it. That SQL used to run
-- as the database OWNER, so a crafted question could read the users table
-- (password hashes), refresh tokens, or call server-control functions.
-- ai.controller.js now runs it in a READ ONLY transaction and, when this role
-- exists, does SET LOCAL ROLE spykar_ai first: SELECT on the business tables
-- only, nothing on users / refresh_tokens / ai_query_log / _migrations.
--
-- CREATE ROLE needs a superuser (or CREATEROLE). If the app user lacks that,
-- this migration logs a NOTICE and changes nothing; the AI still works, with
-- the read-only transaction + checks. To finish the setup, run this file once
-- as the postgres superuser (safe to re-run):
--
--   sudo -u postgres psql -d spykar_inventory -f src/database/migrations/025_ai_readonly_role.sql
DO $$
DECLARE app_owner text;
BEGIN
  SELECT pg_get_userbyid(datdba) INTO app_owner FROM pg_database WHERE datname = current_database();
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spykar_ai') THEN
      CREATE ROLE spykar_ai NOLOGIN;
    END IF;
    EXECUTE format('GRANT spykar_ai TO %I', app_owner);
    GRANT USAGE ON SCHEMA public TO spykar_ai;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO spykar_ai;
    REVOKE ALL ON users, refresh_tokens, ai_query_log, _migrations FROM spykar_ai;
    -- Tables created later by the app (future migrations) are readable too.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO spykar_ai', app_owner);
    RAISE NOTICE 'spykar_ai role ready (member of %)', app_owner;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'spykar_ai role NOT created (needs superuser). Run this file as postgres — see header.';
  END;
END $$;
