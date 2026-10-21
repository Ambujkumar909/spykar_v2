-- ─── Migration 036: War Room ────────────────────────────────────────────────
-- The weekly store review of the EBO network (the business's "SS26 War Room"
-- workbook, now live from the ERP): this week vs previous week vs the same
-- week last year, MTD and YTD vs LY and vs target, bills / UPT / ASP / ATV,
-- category sales, closing stock mix, and the ASM's reason / action per store.
--
-- Sales, value and MRP come from srd_store (migration 013). Two things the
-- War Room needs that srd_store does not carry are rolled up here, built in
-- the same transaction as srd_store (salesRollup.js) so they can never drift:
--
--   wr_store_day — bills per store per day. NOB = DISTINCT bill numbers, sale
--                  AND return bills (reproduces the workbook's NOB exactly).
--                  srd_store.s_txn counts invoice LINES, not bills.
--   wr_cat_day   — net units / value / MRP per store × day × product, so the
--                  page can split sales by category and filter by product.
--
-- wr_stock_cat is the closing stock per store × product for one day, taken
-- from inventory_daily_snapshot and materialised the first time a date is
-- asked for (one day is ~480k snapshot rows; the page needs two days at once).
--
-- Everything shown comes from the ERP data already in the database. The one
-- thing the page writes is wr_notes: the ASM's reason / action per store per
-- week.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wr_store_day (
  sale_date   date NOT NULL,
  location_id uuid NOT NULL,
  bills       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (sale_date, location_id)
);

CREATE TABLE IF NOT EXISTS wr_cat_day (
  sale_date   date NOT NULL,
  location_id uuid NOT NULL,
  gender      text NOT NULL,          -- skus.gender_name ('' when the master has none)
  category    text NOT NULL,          -- skus.category_norm
  product     text NOT NULL,          -- skus.product without its price-band suffix ('JEANS<' → 'JEANS')
  qty         integer NOT NULL,       -- net: sold − returned
  val         numeric NOT NULL,       -- net sale value
  mrp         numeric NOT NULL,       -- net MRP value
  PRIMARY KEY (sale_date, location_id, gender, category, product)
);

CREATE TABLE IF NOT EXISTS wr_stock_cat (
  snapshot_date date NOT NULL,
  location_id   uuid NOT NULL,
  gender        text NOT NULL,
  category      text NOT NULL,
  product       text NOT NULL,
  qty           integer NOT NULL,
  mrp           numeric NOT NULL,
  PRIMARY KEY (snapshot_date, location_id, gender, category, product)
);
-- Which days wr_stock_cat holds, and from how many snapshot rows (a later load
-- of that day's snapshot is noticed and the day is rebuilt).
CREATE TABLE IF NOT EXISTS wr_stock_dates (
  snapshot_date date PRIMARY KEY,
  source_rows   bigint NOT NULL,
  built_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wr_notes (
  week_start  date NOT NULL,          -- Monday of the reviewed week
  external_id text NOT NULL,
  asm         text,
  reason      text,
  action      text,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (week_start, external_id)
);
