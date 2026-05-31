-- ─── Migration 012: switch UUID defaults to native gen_random_uuid() ──────────
--
-- ROOT CAUSE (measured): the uuid-ossp uuid_generate_v4() function is
-- catastrophically slow on this Windows PostgreSQL 18 build — it blocks on a
-- slow OS entropy source. Benchmarked on the live DB:
--
--     uuid_generate_v4()  (uuid-ossp):  10,000 UUIDs = 11,852 ms  (1.19 ms each)
--     gen_random_uuid()   (core/pgcrypto): 10,000 UUIDs =    12 ms  (0.0012 ms each)
--
--   → uuid_generate_v4() is ~1,000× SLOWER.
--
-- Impact on the ETL sync: inventory_snapshot is rebuilt every sync (484K rows)
-- and inventory_movements is bulk-loaded (millions of rows on a FULL sync).
-- Each row's id DEFAULT called uuid_generate_v4(), so:
--     • snapshot rebuild  : 484K × 1.19ms ≈ 9.6 min  (was a "mystery" CPU spin)
--     • full movement load : millions × 1.19ms ≈ HOURS
--
-- gen_random_uuid() is built into PostgreSQL 13+ core, produces an identical
-- v4 UUID, needs no extension, and is ~1,000× faster. Switching the column
-- DEFAULT changes ONLY how new rows get their id — existing ids are untouched,
-- no data is rewritten, FKs/PKs/values all stay valid.
--
-- Safe + idempotent: ALTER ... SET DEFAULT is instant (catalog-only) and can
-- run repeatedly. Non-destructive.

ALTER TABLE inventory_snapshot   ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE inventory_movements  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE stock_ageing         ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE dispatch_orders      ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE dispatch_line_items  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE locations            ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE skus                 ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE sync_logs            ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE refresh_tokens       ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE users                ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ai_query_log         ALTER COLUMN id SET DEFAULT gen_random_uuid();
