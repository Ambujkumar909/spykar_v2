-- ─── Migration 034: ESales stock (partner month-end stock files) ────────────
-- Source: the "Consolidate" sheet of each E-Sales workbook in the OneDrive
-- ESales_Stock folder — four columns: Partner, barcode, Qty, Date. Each
-- workbook is ONE stock snapshot (every row carries the same Date).
--
-- The files hold quantities only. SKU attributes and MRP come from skus at
-- query time (skus.external_id = barcode), so they always follow the item
-- master; a barcode the master does not know stays in the totals as
-- "Unmatched barcode" — units always tie back to the files. A barcode written
-- as a master EAN plus a marketplace suffix ("8907966850859_2") resolves to
-- that EAN.
--
-- Loaded by `npm run esales:load` (src/services/esalesStock.js). A changed
-- workbook (different sha256) replaces its snapshot in one transaction.

CREATE TABLE IF NOT EXISTS esales_files (
  id            SERIAL       PRIMARY KEY,
  file_name     TEXT         NOT NULL UNIQUE,
  sha256        CHAR(64)     NOT NULL,
  -- UNIQUE: a second workbook claiming an already-loaded date is refused
  -- rather than double counted.
  snapshot_date DATE         NOT NULL UNIQUE,
  lines         INTEGER      NOT NULL,   -- data rows read from the sheet
  units         BIGINT       NOT NULL,   -- Σ Qty of those rows
  loaded_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS esales_partners (
  id       SMALLSERIAL PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,         -- as written in the files (whitespace collapsed)
  channel  TEXT NOT NULL                 -- marketplace grouping; set on first sight, editable
);

-- One row per snapshot × partner × barcode. A file may list the same
-- partner+barcode on several rows; qty is their sum and `lines` their count.
CREATE TABLE IF NOT EXISTS esales_stock (
  snapshot_date DATE     NOT NULL REFERENCES esales_files (snapshot_date) ON DELETE CASCADE ON UPDATE CASCADE,
  partner_id    SMALLINT NOT NULL REFERENCES esales_partners (id),
  barcode       TEXT     COLLATE "C" NOT NULL,   -- bytewise: sorts/distinct counts 10× faster than locale order
  qty           INTEGER  NOT NULL,
  lines         INTEGER  NOT NULL,
  PRIMARY KEY (snapshot_date, partner_id, barcode)
);

-- The item master narrowed to the barcodes ESales stock actually holds (~60k of
-- 332k SKUs), so page queries never hash the whole master. Rebuilt by the
-- loader after every load, and by the API when skus has been refreshed since
-- (esales_meta.items_built_at vs master_refresh_state) — it cannot go stale.
CREATE TABLE IF NOT EXISTS esales_items (
  barcode       TEXT          COLLATE "C" PRIMARY KEY,   -- as written in the files
  sku           TEXT          COLLATE "C" NOT NULL,      -- the item-master EAN it resolves to
  mrp           NUMERIC(10,2) NOT NULL,
  category_norm VARCHAR(80),
  gender_name   VARCHAR(20),
  product       VARCHAR(80),
  sub_product   VARCHAR(80),
  size          VARCHAR(30),
  color_name    VARCHAR(50),
  shade         VARCHAR(50),
  style         VARCHAR(100),
  season        VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS esales_meta (
  id             BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),   -- single row
  items_built_at TIMESTAMPTZ,
  files_md5      TEXT                                               -- the set of workbooks the derived data was built from
);

-- What the page reads: stock ⋈ partner ⋈ item, pre-joined and stored in date
-- order, so a query for one or two snapshots touches a few hundred contiguous
-- blocks and needs no join (3–5× faster than joining per request). sku_key is
-- a dense integer per SKU (item-master EAN, or the raw barcode when unmatched)
-- for cheap distinct-SKU counts. Refreshed together with esales_items; after
-- editing esales_partners.channel by hand run `npm run esales:load -- --rebuild`.
CREATE MATERIALIZED VIEW IF NOT EXISTS esales_stock_wide AS
SELECT * FROM (
  SELECT r.snapshot_date, r.partner_id, r.barcode, r.qty, r.lines, p.name AS partner_name, p.channel,
         i.barcode AS item_barcode, i.sku, i.mrp, i.category_norm, i.gender_name, i.product, i.sub_product,
         i.size, i.color_name, i.shade, i.style, i.season,
         DENSE_RANK() OVER (ORDER BY COALESCE(i.sku, r.barcode))::int AS sku_key
    FROM esales_stock r
    JOIN esales_partners p ON p.id = r.partner_id
    LEFT JOIN esales_items i ON i.barcode = r.barcode) x
 ORDER BY snapshot_date, partner_id;
CREATE INDEX IF NOT EXISTS idx_esales_wide_date ON esales_stock_wide (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_esales_wide_barcode ON esales_stock_wide (barcode);   -- the SKU detail panel
