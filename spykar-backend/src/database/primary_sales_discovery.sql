/* ============================================================================
   PRIMARY SALES (MITTRA) — PHASE 0 DISCOVERY
   Target: SQL Server, database M3ReportdataPRD  (Infor M3 reporting copy)
   Goal:   turn "11 crore rows" into real numbers BEFORE building the loader.

   Run these top-to-bottom. Note: SQL Server 2014-safe (no STRING_AGG).
   Dates in M3 base tables are INT yyyymmdd (e.g. 20230404) — grouping below
   assumes that. If a column comes back as DATE/DATETIME, drop the /10000 math.
   ============================================================================ */

/* ── 0a. The AAA warehouses (this is your whole 'locations' set — tiny) ────── */
SELECT D.CONO, D.WHLO, D.WHNM, D.DIVI, D.FACI, D.WHTY
FROM   M3ReportdataPRD.dbo.MITWHL D
WHERE  D.CONO = 92
  AND  D.DIVI = 'AAA'
ORDER  BY D.WHLO;
-- ^ Copy the WHLO values; we filter MITTRA with WHLO IN (...) so SQL Server
--   doesn't rely on the join to prune the 110M-row scan.


/* ── 0b. Raw MITTRA count for CONO=92 (NO joins) — the true upper bound ────── */
SELECT COUNT_BIG(*) AS mittra_cono92_rows
FROM   M3ReportdataPRD.dbo.MITTRA A
WHERE  A.CONO = 92;


/* ── 0c. Filtered count, narrowed by warehouse only (cheap, no MITMAS join) ── */
--   Replace the IN list with the WHLO values from 0a.
SELECT COUNT_BIG(*) AS cono92_aaa_rows
FROM   M3ReportdataPRD.dbo.MITTRA A
WHERE  A.CONO = 92
  AND  A.WHLO IN ('011','012','013','014' /* + regional, from 0a */);


/* ── 0d. FULL filtered count — exactly what the loader will move ───────────── */
--   This is THE number that sizes the backfill. May run a few minutes.
SELECT COUNT_BIG(*) AS final_backfill_rows
FROM        M3ReportdataPRD.dbo.MITTRA A
INNER JOIN  M3ReportdataPRD.dbo.MITMAS B ON A.CONO = B.CONO AND A.ITNO = B.ITNO
INNER JOIN  M3ReportdataPRD.dbo.MITWHL D ON D.CONO = A.CONO AND D.WHLO = A.WHLO
WHERE  A.CONO = 92
  AND  B.STCD = 1
  AND  D.DIVI = 'AAA';


/* ── 0e. Volume per YEAR — how many date windows the backfill needs ────────── */
SELECT  (A.TRDT / 10000)            AS trdt_year,
        COUNT_BIG(*)                AS rows_in_year
FROM        M3ReportdataPRD.dbo.MITTRA A
INNER JOIN  M3ReportdataPRD.dbo.MITMAS B ON A.CONO = B.CONO AND A.ITNO = B.ITNO
INNER JOIN  M3ReportdataPRD.dbo.MITWHL D ON D.CONO = A.CONO AND D.WHLO = A.WHLO
WHERE  A.CONO = 92 AND B.STCD = 1 AND D.DIVI = 'AAA'
GROUP  BY (A.TRDT / 10000)
ORDER  BY trdt_year;


/* ── 0f. Date spread of TRDT vs RGDT (registration) ───────────────────────── */
--   TRDT = transaction (business) date; RGDT = when the row was registered.
--   If max(RGDT) >> max(TRDT) you have back-dated entries → DELTA must key on
--   RGDT/LMTS (arrival), NOT TRDT, or new rows get missed.
SELECT  MIN(A.TRDT) AS min_trdt, MAX(A.TRDT) AS max_trdt,
        MIN(A.RGDT) AS min_rgdt, MAX(A.RGDT) AS max_rgdt,
        MIN(A.LMTS) AS min_lmts, MAX(A.LMTS) AS max_lmts
FROM   M3ReportdataPRD.dbo.MITTRA A
WHERE  A.CONO = 92;


/* ── 0g. INDEXES on MITTRA — the #1 backfill-speed risk ────────────────────── */
--   We need an index on the column we window/delta by (TRDT, RGDT, or LMTS).
--   Without one, every window full-scans 110M rows.
EXEC sp_helpindex 'M3ReportdataPRD.dbo.MITTRA';

--   Same for the join partners:
EXEC sp_helpindex 'M3ReportdataPRD.dbo.MITMAS';
EXEC sp_helpindex 'M3ReportdataPRD.dbo.MITWHL';


/* ── 0h. Natural-key check — is REPN unique enough for idempotent re-runs? ─── */
--   We need a stable key for ON CONFLICT DO NOTHING/UPDATE so re-runs and
--   delta overlaps never double-count. Candidate: (CONO, WHLO, ITNO, REPN).
SELECT  COUNT_BIG(*)                          AS total_rows,
        COUNT_BIG(DISTINCT A.REPN)            AS distinct_repn,
        COUNT_BIG(*) - COUNT_BIG(DISTINCT
          CONCAT(A.CONO,'|',A.WHLO,'|',A.ITNO,'|',A.REPN)) AS dup_composite_keys
FROM   M3ReportdataPRD.dbo.MITTRA A
WHERE  A.CONO = 92
  AND  A.WHLO IN ('011','012','013','014' /* from 0a */);
-- dup_composite_keys = 0  → (CONO,WHLO,ITNO,REPN) is a safe unique key.
-- If > 0, inspect a sample (below) to find what else makes the row unique
-- (likely + RIDN/RIDL/RIDX or the LMTS).
SELECT TOP 50 A.CONO, A.WHLO, A.ITNO, A.REPN, A.RIDN, A.RIDL, A.RIDX, A.LMTS,
              A.TRDT, A.TTYP, A.TRTP, A.TRQT
FROM   M3ReportdataPRD.dbo.MITTRA A
WHERE  A.CONO = 92
  AND  A.WHLO IN ('011','012','013','014' /* from 0a */)
ORDER  BY A.REPN;


/* ── 0i. Transaction-type spread — "all movements" vs "sales only" ─────────── */
--   TTYP / TRTP classify the movement (receipt, issue, transfer, adjust…).
--   This tells us whether to store everything and classify in the UI, or
--   filter to sale types at source.
SELECT  A.TTYP, A.TRTP, COUNT_BIG(*) AS rows_cnt, SUM(CAST(A.TRQT AS BIGINT)) AS net_qty
FROM        M3ReportdataPRD.dbo.MITTRA A
INNER JOIN  M3ReportdataPRD.dbo.MITWHL D ON D.CONO = A.CONO AND D.WHLO = A.WHLO
WHERE  A.CONO = 92 AND D.DIVI = 'AAA'
GROUP  BY A.TTYP, A.TRTP
ORDER  BY rows_cnt DESC;


/* ── 0j. ITNO → Item_spykar mapping coverage (run on the Item_spykar server) ─ */
--   How many MITTRA item codes actually resolve via Item_spykar.InforItemCode?
--   Unmapped ITNOs become lookup misses in the loader (like your stock feed).
--   NOTE: if Item_spykar lives on a different server (10.11.0.21), run the
--   DISTINCT ITNO list here, export it, and check coverage there.
SELECT DISTINCT A.ITNO
FROM        M3ReportdataPRD.dbo.MITTRA A
INNER JOIN  M3ReportdataPRD.dbo.MITMAS B ON A.CONO = B.CONO AND A.ITNO = B.ITNO
INNER JOIN  M3ReportdataPRD.dbo.MITWHL D ON D.CONO = A.CONO AND D.WHLO = A.WHLO
WHERE  A.CONO = 92 AND B.STCD = 1 AND D.DIVI = 'AAA';
