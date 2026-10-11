-- ─── Migration 035: ESales stock ageing ─────────────────────────────────────
-- Third source for the Inventory Ageing page (beside warehouse FIFO and store
-- continuous-on-hand): how long the units in the LATEST partner stock file
-- have been sitting at the partner.
--
-- The feed is one stock file per month, so age is proven the same way as for
-- stores — continuous on hand — applied first-in-first-out per partner × barcode:
--   walking back through that partner's files, the units held continuously
--   since a file are the MINIMUM quantity seen from that file to the latest
--   one; what the minimum loses at each step back are the units that arrived
--   after that older file. Each such layer is aged from the first file it
--   appears in (`since`). The layers of a position always add up to its
--   quantity in the latest file.
-- A partner missing from a whole file was not reported that month (it is not
-- "zero stock"), so that file is skipped for that partner. Zero / negative
-- quantities count as nothing on hand.
--
-- Age is counted in whole calendar months between `since` and the latest file
-- and mapped onto the page's day bands: 0 months → 0–30 d, 1 → 31–60, 2 → 61–90,
-- 3–5 → 91–180, 6–11 → 181–365, 12+ → 365+ (month-end files are 28–31 days
-- apart, so day counts would leave bands empty at random).
--
-- Pre-joined with partner + item attributes like esales_stock_wide; refreshed
-- with it (services/esalesStock.js → rebuildItems). value_cost stays 0: the
-- files carry no cost and ESales stock is valued at MRP.

CREATE MATERIALIZED VIEW IF NOT EXISTS esales_ageing AS
WITH latest AS (SELECT MAX(snapshot_date) AS d0 FROM esales_files),
reported AS (SELECT DISTINCT partner_id, snapshot_date AS d FROM esales_stock),
cur AS (SELECT r.partner_id, r.barcode FROM esales_stock r, latest WHERE r.snapshot_date = latest.d0 AND r.qty > 0),
grid AS (
  SELECT c.partner_id, c.barcode, rp.d, GREATEST(COALESCE(r.qty, 0), 0) AS q
    FROM cur c
    JOIN reported rp ON rp.partner_id = c.partner_id
    LEFT JOIN esales_stock r ON r.snapshot_date = rp.d AND r.partner_id = c.partner_id AND r.barcode = c.barcode),
run AS (SELECT g.*, MIN(q) OVER (PARTITION BY partner_id, barcode ORDER BY d DESC) AS m FROM grid g),
lay AS (
  SELECT partner_id, barcode, d AS since,
         m - COALESCE(LEAD(m) OVER (PARTITION BY partner_id, barcode ORDER BY d DESC), 0) AS units
    FROM run),
aged AS (
  SELECT l.*, latest.d0,
         ((EXTRACT(YEAR FROM latest.d0) * 12 + EXTRACT(MONTH FROM latest.d0))
        - (EXTRACT(YEAR FROM l.since) * 12 + EXTRACT(MONTH FROM l.since)))::int AS months
    FROM lay l, latest
   WHERE l.units > 0)
SELECT 'esales'::text AS source, a.partner_id, p.name AS partner_name, p.channel, a.barcode, a.since, a.d0 AS as_of, a.months,
       (CASE WHEN a.months <= 0 THEN 0 WHEN a.months = 1 THEN 1 WHEN a.months = 2 THEN 2
             WHEN a.months <= 5 THEN 3 WHEN a.months <= 11 THEN 4 ELSE 5 END)::smallint AS age_bucket,
       a.units::int AS units, ROUND(a.units * COALESCE(i.mrp, 0))::bigint AS value_gross, 0::bigint AS value_cost,
       i.category_norm, i.gender_name, i.product, i.sub_product, i.size, i.color_name, i.season
  FROM aged a
  JOIN esales_partners p ON p.id = a.partner_id
  LEFT JOIN esales_items i ON i.barcode = a.barcode;
