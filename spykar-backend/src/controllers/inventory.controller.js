const { query, transaction } = require('../config/database');
const { getOrSet, getOrSetRawJson, invalidatePattern, TTL } = require('../config/cache');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../config/logger');

// ─── Executive Summary ─────────────────────────────────────────────────────────
//
// Mode lens — narrows EVERY figure on the Overview hero by shop_closed flag:
//   active   → l.shop_closed = false (open shops actively trading)
//   inactive → l.shop_closed = true  (shut shops with residual stock)
//   all      → no shop_closed filter (entire active-flag network)
//
// Cache key bumped per mode so the three lens variants don't clobber each other.
async function getExecutiveSummary(req, res, next) {
  try {
    const mode = ['active','inactive','all'].includes(req.query.mode) ? req.query.mode : 'active';
    const modeClause = mode === 'active'   ? 'AND l.shop_closed = false'
                     : mode === 'inactive' ? 'AND l.shop_closed = true'
                     : '';
    const data = await getOrSet(`inventory:executive-summary:v2:${mode}`, async () => {
      // Per-location-type breakdown
      const typeBreakdown = await query(`
        WITH vel AS (
          SELECT location_id, sku_id,
            GREATEST(1, ROUND(
              SUM(ABS(qty_change))::numeric /
              GREATEST(1, EXTRACT(EPOCH FROM (MAX(moved_at)-MIN(moved_at)))/86400), 2
            )) AS adv
          FROM inventory_movements
          WHERE movement_type = 'SALE'
            AND moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY location_id, sku_id
        )
        SELECT
          COALESCE(l.group_name, l.type::TEXT) AS location_type,
          COUNT(DISTINCT l.id)::int           AS location_count,
          COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
          COALESCE(SUM(i.qty_available), 0)::int AS available_stock,
          COALESCE(SUM(i.qty_in_transit), 0)::int AS in_transit,
          COALESCE(SUM(i.qty_on_hand * s.mrp), 0)::numeric AS stock_value,
          COUNT(i.location_id) FILTER (WHERE
            i.qty_on_hand = 0 OR
            i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
          )::int AS low_stock_alerts,
          CASE
            WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- rt'       THEN 'OUTRIGHT'
            ELSE 'SOR'
          END AS billing_model
        FROM locations l
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id
        LEFT JOIN skus s ON s.id = i.sku_id AND s.is_active = true
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        WHERE l.is_active = true
          ${modeClause}
          AND l.type != 'WAREHOUSE'
          AND NULLIF(TRIM(COALESCE(l.group_name, '')), '') IS NOT NULL
        GROUP BY
          COALESCE(l.group_name, l.type::TEXT),
          CASE
            WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
            WHEN COALESCE(l.group_name,'') ILIKE '%- rt'       THEN 'OUTRIGHT'
            ELSE 'SOR'
          END
        ORDER BY total_stock DESC NULLS LAST
      `);

      // Network totals
      const totals = await query(`
        WITH vel AS (
          SELECT location_id, sku_id,
            GREATEST(1, ROUND(
              SUM(ABS(qty_change))::numeric /
              GREATEST(1, EXTRACT(EPOCH FROM (MAX(moved_at)-MIN(moved_at)))/86400), 2
            )) AS adv
          FROM inventory_movements
          WHERE movement_type = 'SALE'
            AND moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY location_id, sku_id
        )
        SELECT
          COALESCE(SUM(i.qty_on_hand), 0)::int           AS total_stock,
          COALESCE(SUM(i.qty_available), 0)::int         AS available_stock,
          COALESCE(SUM(i.qty_in_transit), 0)::int        AS in_transit,
          COALESCE(SUM(i.qty_on_hand * s.mrp), 0)::numeric AS total_stock_value,
          COUNT(DISTINCT l.id)::int                      AS active_locations,
          COUNT(DISTINCT i.sku_id)::int                  AS active_skus,
          COUNT(*) FILTER (WHERE
            i.qty_on_hand = 0 OR
            i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
          )::int AS total_alerts
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        WHERE l.is_active = true AND s.is_active = true
          ${modeClause}
      `);

      // Critical low-stock alerts (top 10)
      const alerts = await query(`
        WITH vel AS (
          SELECT location_id, sku_id,
            GREATEST(1, ROUND(
              SUM(ABS(qty_change))::numeric /
              GREATEST(1, EXTRACT(EPOCH FROM (MAX(moved_at)-MIN(moved_at)))/86400), 2
            )) AS adv
          FROM inventory_movements
          WHERE movement_type = 'SALE'
            AND moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY location_id, sku_id
        )
        SELECT
          l.name AS location_name, l.type AS location_type,
          s.sku_code, s.product_name, s.color_name, s.size,
          i.qty_on_hand,
          CASE WHEN i.safety_stock > 0 THEN i.safety_stock
               ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END AS safety_stock,
          ROUND(((CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                       ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
                  - i.qty_on_hand)::numeric /
                 NULLIF(CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                             ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END, 0)) * 100, 1) AS shortfall_pct
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        WHERE (i.qty_on_hand = 0 OR
               i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                     ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END)
          AND l.is_active = true AND s.is_active = true
          ${modeClause}
        ORDER BY shortfall_pct DESC
        LIMIT 10
      `);

      // Last sync time
      const lastSync = await query(`
        SELECT started_at, completed_at, status, records_updated
        FROM sync_logs
        WHERE status = 'SUCCESS'
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      return {
        totals: totals.rows[0],
        byLocationType: typeBreakdown.rows,
        criticalAlerts: alerts.rows,
        lastSync: lastSync.rows[0] || null,
        generatedAt: new Date().toISOString(),
      };
    }, TTL.EXECUTIVE_SUMMARY);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ─── Inventory Snapshot with Filters ─────────────────────────────────────────
async function getSnapshot(req, res, next) {
  try {
    const {
      page = 1, limit = 50,
      location_type, zone_id, size, color_code, sku_code,
      min_qty, max_qty, below_safety,
      date_from, date_to,
      sort_by = 'qty_on_hand', sort_order = 'DESC',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(parseInt(limit) || 50, 100);
    const offset = (pageNum - 1) * limitNum;
    const conditions = ['l.is_active = true', 's.is_active = true'];
    const params = [];

    if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }
    if (zone_id)        { params.push(zone_id);       conditions.push(`l.zone_id = $${params.length}`); }
    if (size)           { params.push(size);           conditions.push(`s.size = $${params.length}`); }
    if (color_code)     { params.push(color_code);     conditions.push(`s.color_code = $${params.length}`); }
    if (sku_code)       { params.push(`%${sku_code}%`);conditions.push(`s.sku_code ILIKE $${params.length}`); }
    if (min_qty != null){ params.push(min_qty);        conditions.push(`i.qty_on_hand >= $${params.length}`); }
    if (max_qty != null){ params.push(max_qty);        conditions.push(`i.qty_on_hand <= $${params.length}`); }
    if (below_safety)   { conditions.push('i.qty_on_hand = 0'); }

    const whereClause = conditions.join(' AND ');
    const allowedSorts = { qty_on_hand: 'i.qty_on_hand', qty_available: 'i.qty_available', stock_value: 'i.qty_on_hand * s.mrp', location_name: 'l.name' };
    const orderBy = `${allowedSorts[sort_by] || 'i.qty_on_hand'} ${sort_order === 'ASC' ? 'ASC' : 'DESC'}`;

    params.push(limitNum, offset);

    const [dataResult, countResult] = await Promise.all([
      query(`
        SELECT
          i.id, l.id AS location_id, l.code AS location_code, l.name AS location_name,
          l.type AS location_type, z.name AS zone, l.city, l.state,
          s.id AS sku_id, s.sku_code, s.product_name, s.color_code, s.color_name,
          s.size, s.fit_type, s.mrp,
          i.qty_on_hand, i.qty_reserved, i.qty_in_transit, i.qty_available,
          i.safety_stock, i.reorder_point,
          ROUND(i.qty_on_hand * s.mrp, 2) AS stock_value,
          CASE WHEN i.qty_on_hand = 0 THEN true ELSE false END AS is_below_safety,
          i.last_movement_at, i.updated_at
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        LEFT JOIN zones z ON z.id = l.zone_id
        JOIN skus s ON s.id = i.sku_id
        WHERE ${whereClause}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      query(`
        SELECT COUNT(*)::int AS total
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        WHERE ${whereClause}
      `, params.slice(0, -2)),
    ]);

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page: pageNum, limit: limitNum, total: countResult.rows[0].total,
        totalPages: Math.ceil(countResult.rows[0].total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Export Snapshot as CSV ────────────────────────────────────────────────────
async function exportSnapshot(req, res, next) {
  try {
    const { location_type, zone_id, size, color_code, below_safety } = req.query;
    const conditions = ['l.is_active = true', 's.is_active = true'];
    const params = [];

    if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }
    if (zone_id)        { params.push(zone_id);       conditions.push(`l.zone_id = $${params.length}`); }
    if (size)           { params.push(size);           conditions.push(`s.size = $${params.length}`); }
    if (color_code)     { params.push(color_code);     conditions.push(`s.color_code = $${params.length}`); }
    if (below_safety)   { conditions.push('i.qty_on_hand = 0'); }

    const result = await query(`
      SELECT l.code, l.name, l.type, l.city, l.state, z.name AS zone,
             s.sku_code, s.product_name, s.color_name, s.size, s.fit_type, s.mrp,
             i.qty_on_hand, i.qty_reserved, i.qty_in_transit, i.qty_available, i.safety_stock,
             ROUND(i.qty_on_hand * s.mrp, 2) AS stock_value, i.updated_at
      FROM inventory_snapshot i
      JOIN locations l ON l.id = i.location_id
      LEFT JOIN zones z ON z.id = l.zone_id
      JOIN skus s ON s.id = i.sku_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.type, l.name, s.size
      LIMIT 100000
    `, params);

    const headers = ['Location Code','Location Name','Type','City','State','Zone','SKU Code','Product','Color','Size','Fit','MRP','On Hand','Reserved','In Transit','Available','Safety Stock','Stock Value','Last Updated'];
    const rows = result.rows.map(r => [
      r.code, r.name, r.type, r.city, r.state, r.zone,
      r.sku_code, r.product_name, r.color_name, r.size, r.fit_type, r.mrp,
      r.qty_on_hand, r.qty_reserved, r.qty_in_transit, r.qty_available, r.safety_stock,
      r.stock_value, r.updated_at,
    ].map(v => `"${v ?? ''}"`).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const filename = `spykar_inventory_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

// ─── Location Inventory ────────────────────────────────────────────────────────
async function getLocationInventory(req, res, next) {
  try {
    const { locationId } = req.params;
    const { size, color_code, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['i.location_id = $1', 's.is_active = true'];
    const params = [locationId];

    if (size)       { params.push(size);       conditions.push(`s.size = $${params.length}`); }
    if (color_code) { params.push(color_code); conditions.push(`s.color_code = $${params.length}`); }

    const [locationResult, inventoryResult] = await Promise.all([
      query('SELECT * FROM locations WHERE id = $1', [locationId]),
      query(`
        SELECT s.sku_code, s.product_name, s.color_code, s.color_name, s.size,
               s.fit_type, s.mrp, i.qty_on_hand, i.qty_available, i.qty_reserved,
               i.qty_in_transit, i.safety_stock, ROUND(i.qty_on_hand * s.mrp, 2) AS stock_value,
               CASE WHEN i.qty_on_hand = 0 THEN true ELSE false END AS is_below_safety,
               i.last_movement_at
        FROM inventory_snapshot i
        JOIN skus s ON s.id = i.sku_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END ASC, s.size ASC, s.color_name ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]),
    ]);

    if (!locationResult.rows.length) throw new AppError('Location not found.', 404);

    res.json({
      success: true,
      data: {
        location: locationResult.rows[0],
        inventory: inventoryResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── SKU Inventory across all locations ──────────────────────────────────────
async function getSkuInventory(req, res, next) {
  try {
    const { skuId } = req.params;
    const cacheKey = `inventory:sku:${skuId}`;

    const data = await getOrSet(cacheKey, async () => {
      const [skuResult, inventoryResult] = await Promise.all([
        query('SELECT * FROM skus WHERE id = $1', [skuId]),
        query(`
          SELECT l.id, l.code, l.name, l.type, l.city, l.state, z.name AS zone,
                 i.qty_on_hand, i.qty_available, i.qty_reserved, i.qty_in_transit,
                 i.safety_stock, ROUND(i.qty_on_hand * s.mrp, 2) AS stock_value,
                 i.last_movement_at
          FROM inventory_snapshot i
          JOIN locations l ON l.id = i.location_id
          LEFT JOIN zones z ON z.id = l.zone_id
          JOIN skus s ON s.id = i.sku_id
          WHERE i.sku_id = $1 AND l.is_active = true
          ORDER BY i.qty_on_hand DESC
        `, [skuId]),
      ]);

      if (!skuResult.rows.length) return null;

      return {
        sku: skuResult.rows[0],
        locations: inventoryResult.rows,
        summary: {
          total_stock: inventoryResult.rows.reduce((s, r) => s + r.qty_on_hand, 0),
          total_available: inventoryResult.rows.reduce((s, r) => s + r.qty_available, 0),
          location_count: inventoryResult.rows.length,
        },
      };
    }, TTL.INVENTORY_SNAPSHOT);

    if (!data) throw new AppError('SKU not found.', 404);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ─── Alerts ───────────────────────────────────────────────────────────────────
// Uses explicit safety_stock when set; falls back to dynamic thresholds based
// on avg daily sales so alerts fire even before thresholds are manually configured.
async function getAlerts(req, res, next) {
  try {
    // Active / Inactive / All filter — drives the WHERE on locations + skus.
    // 'active'  → only is_active=true (default; matches operational intent)
    // 'inactive'→ only is_active=false (audit / archive view)
    // 'all'     → no is_active filter (true full-network view)
    const modeRaw = (req.query.mode || 'active').toLowerCase();
    const mode = ['active', 'inactive', 'all'].includes(modeRaw) ? modeRaw : 'active';

    // Mode semantics — aligned with the rest of the platform (dashboard's
    // Needs Attention, NetworkPulse, AllLocationsTable all interpret mode the
    // same way, so toggling Active / Inactive / All on the page-level ModePill
    // gives consistent counts everywhere).
    //
    //   active   → master-active records at OPEN stores (shop_closed=false)
    //   inactive → master-active records at CLOSED stores (shop_closed=true)
    //   all      → every master-active record regardless of shop_closed
    //
    // is_active=true is always required because rows with is_active=false are
    // either deleted or archived master records that shouldn't ever surface
    // as live alerts. (Verified DB-side: 0 rows currently have is_active=false.)
    const activeFilter = mode === 'inactive'
      ? 'AND l.is_active = true AND s.is_active = true AND l.shop_closed = true'
      : mode === 'all'
        ? 'AND l.is_active = true AND s.is_active = true'
        : 'AND l.is_active = true AND s.is_active = true AND l.shop_closed = false';

    // Cache the already-serialized response body, scoped per mode. v10 = new
    // shape with mode + true summary even at zero rows (cache key bump
    // automatically invalidates v9 entries). On cache hit we stream the raw
    // JSON string directly with res.send(), skipping both JSON.parse on read
    // and res.json()'s re-stringify on write.
    const cacheKey = `inventory:alerts:v12:${mode}`;
    const body = await getOrSetRawJson(cacheKey, async () => {
      // Two queries instead of one CROSS-JOINed monster:
      //   (1) summary — counts the FULL alerts_base (no row cap, this is the
      //       authoritative network total shown on the cards).
      //   (2) detail — same alerts_base, ORDER BY severity, LIMIT 5000 for
      //       the drill list. The cap exists ONLY on detail rows because
      //       sending 570K objects to the browser would freeze the page;
      //       counts are never affected.
      // Splitting them is faster than CROSS JOIN (no 570K × duplication of
      // 4 summary columns) AND keeps the cards honest at any scale.
      const baseSQL = `
        WITH velocity AS (
          SELECT
            m.location_id, m.sku_id,
            GREATEST(1,
              ROUND(
                SUM(ABS(m.qty_change))::numeric /
                GREATEST(1, EXTRACT(EPOCH FROM (MAX(m.moved_at) - MIN(m.moved_at))) / 86400),
                2
              )
            ) AS avg_daily_sales
          FROM inventory_movements m
          WHERE m.movement_type = 'SALE'
            AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY m.location_id, m.sku_id
        ),
        thresholds AS (
          SELECT
            i.location_id, i.sku_id,
            CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                 ELSE GREATEST(5, ROUND(COALESCE(v.avg_daily_sales,1) * 7))
            END AS effective_safety,
            CASE WHEN i.reorder_point > 0 THEN i.reorder_point
                 ELSE GREATEST(2, ROUND(COALESCE(v.avg_daily_sales,1) * 3))
            END AS effective_reorder
          FROM inventory_snapshot i
          LEFT JOIN velocity v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        ),
        alerts_base AS (
          SELECT
            l.is_active AS loc_active, s.is_active AS sku_active,
            l.name AS location_name, COALESCE(l.group_name, l.type::text) AS location_type, l.city, l.state,
            s.sku_code, s.product_name, s.color_name, s.size,
            i.qty_on_hand,
            t.effective_safety  AS safety_stock,
            t.effective_reorder AS reorder_point,
            ROUND(((t.effective_safety - i.qty_on_hand)::numeric / NULLIF(t.effective_safety,0)) * 100, 1) AS shortfall_pct,
            CASE
              WHEN i.qty_on_hand = 0                    THEN 'OUT_OF_STOCK'
              WHEN i.qty_on_hand <= t.effective_reorder THEN 'REORDER_NOW'
              ELSE                                           'LOW_STOCK'
            END AS alert_level
          FROM inventory_snapshot i
          JOIN thresholds t ON t.location_id = i.location_id AND t.sku_id = i.sku_id
          JOIN locations l ON l.id = i.location_id
          JOIN skus s ON s.id = i.sku_id
          WHERE (
            i.qty_on_hand = 0
            OR i.qty_on_hand <= t.effective_safety
          )
          ${activeFilter}
        )`;

      // (1) TRUE network counts — no LIMIT, scanned once, cached.
      const summaryResult = await query(`
        ${baseSQL}
        SELECT
          COUNT(*) FILTER (WHERE alert_level = 'OUT_OF_STOCK')::bigint AS out_of_stock,
          COUNT(*) FILTER (WHERE alert_level = 'REORDER_NOW')::bigint  AS reorder_now,
          COUNT(*) FILTER (WHERE alert_level = 'LOW_STOCK')::bigint    AS low_stock,
          COUNT(*)::bigint                                              AS total,
          COUNT(*) FILTER (WHERE loc_active=true  AND sku_active=true )::bigint AS active_count,
          COUNT(*) FILTER (WHERE loc_active=false OR  sku_active=false)::bigint AS inactive_count
        FROM alerts_base
      `);
      const s = summaryResult.rows[0] || {};
      const toNum = v => (v == null ? 0 : Number(v));
      const summary = {
        out_of_stock:    toNum(s.out_of_stock),
        reorder_now:     toNum(s.reorder_now),
        low_stock:       toNum(s.low_stock),
        total:           toNum(s.total),
        active_count:    toNum(s.active_count),
        inactive_count:  toNum(s.inactive_count),
        mode,
      };

      // (2) Detail rows — capped for browser memory + JSON safety.
      // Configurable via ?detail_limit (max 50K). Default 5K matches the
      // existing UI's drill-list, which only renders the top few critical
      // SKUs anyway.
      const requestedLimit = parseInt(req.query.detail_limit, 10);
      const detailLimit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 5000, 0), 50000);

      const detailResult = detailLimit === 0
        ? { rows: [] }
        : await query(`
            ${baseSQL}
            SELECT
              location_name, location_type, city, state,
              sku_code, product_name, color_name, size,
              qty_on_hand, safety_stock, reorder_point, shortfall_pct,
              alert_level,
              loc_active AS location_active, sku_active AS sku_active
            FROM alerts_base
            ORDER BY
              CASE alert_level
                WHEN 'OUT_OF_STOCK' THEN 0
                WHEN 'REORDER_NOW'  THEN 1
                ELSE                     2
              END,
              shortfall_pct DESC NULLS LAST
            LIMIT ${detailLimit}
          `);

      return {
        success: true,
        data: detailResult.rows,
        summary,
        count: summary.total,           // TRUE network total — used by UI cards
        rowsReturned: detailResult.rows.length,
        rowCap: detailLimit,
      };
    }, TTL.STOCK_ALERTS);

    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
  } catch (err) {
    next(err);
  }
}

// ─── Alerts Summary (tiny payload — just the 4 counts) ────────────────────────
// Used by the Overview page KPI cards so the initial render is never blocked by
// the 570K-row full alerts response. The full /alerts endpoint is unchanged.
async function getAlertsSummary(req, res, next) {
  try {
    // Same mode lens as executive-summary so the Stock Alerts tile narrows
    // when the user flips the Active/Inactive/All pill on the Overview page.
    const mode = ['active','inactive','all'].includes(req.query.mode) ? req.query.mode : 'active';
    const modeClause = mode === 'active'   ? 'AND l.shop_closed = false'
                     : mode === 'inactive' ? 'AND l.shop_closed = true'
                     : '';
    const summary = await getOrSet(`inventory:alerts:summary:v2:${mode}`, async () => {
      const result = await query(`
        WITH velocity AS (
          SELECT
            m.location_id, m.sku_id,
            GREATEST(1,
              ROUND(
                SUM(ABS(m.qty_change))::numeric /
                GREATEST(1, EXTRACT(EPOCH FROM (MAX(m.moved_at) - MIN(m.moved_at))) / 86400),
                2
              )
            ) AS avg_daily_sales
          FROM inventory_movements m
          WHERE m.movement_type = 'SALE'
            AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '180 days'
          GROUP BY m.location_id, m.sku_id
        ),
        thresholds AS (
          SELECT
            i.location_id, i.sku_id, i.qty_on_hand,
            CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                 ELSE GREATEST(5, ROUND(COALESCE(v.avg_daily_sales,1) * 7))
            END AS effective_safety,
            CASE WHEN i.reorder_point > 0 THEN i.reorder_point
                 ELSE GREATEST(2, ROUND(COALESCE(v.avg_daily_sales,1) * 3))
            END AS effective_reorder
          FROM inventory_snapshot i
          LEFT JOIN velocity v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
          JOIN locations l ON l.id = i.location_id AND l.is_active = true
          JOIN skus s ON s.id = i.sku_id AND s.is_active = true
          WHERE 1=1 ${modeClause}
        )
        SELECT
          COUNT(*) FILTER (WHERE qty_on_hand = 0)::int                                           AS out_of_stock,
          COUNT(*) FILTER (WHERE qty_on_hand > 0 AND qty_on_hand <= effective_reorder)::int      AS reorder_now,
          COUNT(*) FILTER (WHERE qty_on_hand > effective_reorder AND qty_on_hand <= effective_safety)::int AS low_stock,
          COUNT(*) FILTER (WHERE qty_on_hand = 0 OR qty_on_hand <= effective_safety)::int        AS total
        FROM thresholds
      `);
      const r = result.rows[0] || { out_of_stock: 0, reorder_now: 0, low_stock: 0, total: 0 };
      return {
        out_of_stock: r.out_of_stock || 0,
        reorder_now:  r.reorder_now  || 0,
        low_stock:    r.low_stock    || 0,
        total:        r.total        || 0,
      };
    }, TTL.STOCK_ALERTS);
    res.json({ success: true, summary });
  } catch (err) {
    next(err);
  }
}

// ─── Movements Ledger ──────────────────────────────────────────────────────────
async function getMovements(req, res, next) {
  try {
    const { page = 1, limit = 50, location_id, sku_id, movement_type, date_from, date_to } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(parseInt(limit) || 50, 100);
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    const params = [];

    if (location_id)   { params.push(location_id);   conditions.push(`m.location_id = $${params.length}`); }
    if (sku_id)        { params.push(sku_id);         conditions.push(`m.sku_id = $${params.length}`); }
    if (movement_type) { params.push(movement_type);  conditions.push(`m.movement_type = $${params.length}`); }
    if (date_from)     { params.push(date_from);      conditions.push(`m.moved_at >= $${params.length}`); }
    if (date_to)       { params.push(date_to);        conditions.push(`m.moved_at <= $${params.length}::date + interval '1 day'`); }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limitNum, offset);

    const filterParams = params.slice(0, -2); // params without LIMIT/OFFSET

    const [result, countResult, typeStatsResult] = await Promise.all([
      // Paginated rows
      query(`
        SELECT m.id, m.movement_type, m.qty_change, m.qty_before, m.qty_after,
               m.notes, m.moved_at, m.synced_from,
               l.name AS location_name, l.type AS location_type,
               s.sku_code, s.product_name, s.color_name, s.size
        FROM inventory_movements m
        JOIN locations l ON l.id = m.location_id
        JOIN skus s ON s.id = m.sku_id
        ${whereClause}
        ORDER BY m.moved_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      // Total row count (for pagination)
      query(`
        SELECT COUNT(*)::int AS total
        FROM inventory_movements m
        JOIN locations l ON l.id = m.location_id
        JOIN skus s ON s.id = m.sku_id
        ${whereClause}
      `, filterParams),
      // Total counts + qty per movement type (for KPI cards — full dataset, not just this page)
      query(`
        SELECT
          movement_type,
          COUNT(*)::int             AS record_count,
          SUM(ABS(qty_change))::int AS total_qty
        FROM inventory_movements m
        JOIN locations l ON l.id = m.location_id
        JOIN skus s ON s.id = m.sku_id
        ${whereClause}
        GROUP BY movement_type
      `, filterParams),
    ]);

    const total = countResult.rows[0]?.total || 0;

    // Build type stats map: { SALE: { count, qty }, RETURN: { count, qty }, ... }
    const typeStats = {};
    for (const r of typeStatsResult.rows) {
      typeStats[r.movement_type] = { count: r.record_count, qty: r.total_qty };
    }

    // ── Reconstruct real qty_before / qty_after for ERP-synced movements ─────────
    // SalesAI / SalesReturnAI return only qty_change — no stock levels.
    // We reconstruct them using:
    //   qty_after(T) = snapshot_qty + SUM(all movements of same item AFTER time T)
    //   qty_before(T) = qty_after(T) - qty_change
    //
    // This is mathematically exact because:
    //   snapshot (Feb 1) = starting state
    //   rewinding each movement backwards gives the stock at any prior point in time
    // ──────────────────────────────────────────────────────────────────────────────
    const pageRows = result.rows;
    let rows = pageRows;

    const synced = pageRows.filter(r =>
      r.synced_from === 'SQL_SERVER_SYNC' && r.qty_before === 0 && r.qty_after === 0
    );

    if (synced.length > 0) {
      // Collect exact (location_id, sku_id) pairs from this page
      const pairKeys   = [];
      const pairSet    = new Set();
      const locIdArr   = [];
      const skuIdArr   = [];

      for (const r of synced) {
        const k = `${r.location_id}:${r.sku_id}`;
        if (!pairSet.has(k)) {
          pairSet.add(k);
          pairKeys.push(k);
          locIdArr.push(r.location_id);
          skuIdArr.push(r.sku_id);
        }
      }

      // Use string-key matching to avoid cross-product from ANY+ANY
      const pairKeysSql = pairKeys.map(k => `'${k}'`).join(',');

      const [snapResult, allMovsResult] = await Promise.all([
        // Current snapshot qtys for these exact pairs
        query(`
          SELECT location_id, sku_id, COALESCE(qty_on_hand, 0) AS qty_on_hand
          FROM inventory_snapshot
          WHERE (location_id::text || ':' || sku_id::text) IN (${pairKeysSql})
        `),
        // ALL historical movements for these exact pairs (needed to rewind accurately)
        query(`
          SELECT location_id, sku_id, id, qty_change, moved_at
          FROM inventory_movements
          WHERE (location_id::text || ':' || sku_id::text) IN (${pairKeysSql})
          ORDER BY location_id, sku_id, moved_at DESC, id DESC
        `),
      ]);

      // Build snapshot lookup: "locId:skuId" → current qty
      const snapMap = new Map();
      for (const r of snapResult.rows) {
        snapMap.set(`${r.location_id}:${r.sku_id}`, Number(r.qty_on_hand));
      }

      // Group all movements by pair, sorted newest → oldest (already ordered above)
      const movsByPair = new Map();
      for (const m of allMovsResult.rows) {
        const k = `${m.location_id}:${m.sku_id}`;
        if (!movsByPair.has(k)) movsByPair.set(k, []);
        movsByPair.get(k).push(m);
      }

      // Walk each pair backwards from the snapshot to assign qty_after to every movement
      const qtyAfterById = new Map(); // movement id → qty_on_hand right after that movement
      for (const [k, movs] of movsByPair.entries()) {
        let running = snapMap.get(k) || 0; // start at current snapshot (Feb 1 2026)
        for (const m of movs) {
          // running is the stock AFTER this movement (before we undo it)
          qtyAfterById.set(String(m.id), Math.max(0, running));
          running -= Number(m.qty_change); // undo this movement → stock before it
        }
      }

      // Enrich page rows with reconstructed before/after
      rows = pageRows.map(r => {
        if (r.synced_from !== 'SQL_SERVER_SYNC' || r.qty_before !== 0 || r.qty_after !== 0) {
          return r; // MANUAL / ADJUSTMENT rows already have correct values
        }
        const qa = qtyAfterById.get(String(r.id));
        if (qa === undefined) return { ...r, qty_before: null, qty_after: null };
        return {
          ...r,
          qty_after:  qa,
          qty_before: Math.max(0, qa - Number(r.qty_change)),
        };
      });
    }

    res.json({
      success: true,
      data: rows,
      stats: typeStats,       // ← full-dataset totals by movement type
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Stock Ageing ──────────────────────────────────────────────────────────────
// Returns two payloads in a single response:
//   summary  — one row per location_type with total bucket sums (for KPI chart)
//   top_dead — top 20 locations by dead stock qty (for drilldown table)
async function getAgeing(req, res, next) {
  try {
    const { location_type, zone_id } = req.query;
    // Same mode lens — ageing buckets narrow with Active/Inactive/All pill.
    const mode = ['active','inactive','all'].includes(req.query.mode) ? req.query.mode : 'active';
    const cacheKey = `inventory:ageing:v2:${mode}:${location_type||'all'}:${zone_id||'all'}`;
    const data = await getOrSet(cacheKey, async () => {
    const conditions = ['l.is_active = true'];
    const params = [];

    if (mode === 'active')   conditions.push('l.shop_closed = false');
    if (mode === 'inactive') conditions.push('l.shop_closed = true');
    if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }
    if (zone_id)       { params.push(zone_id);        conditions.push(`l.zone_id = $${params.length}`); }

    const summaryResult = await query(`
      SELECT
        l.id          AS location_id,
        l.name        AS location_name,
        l.type        AS location_type,
        COALESCE(l.group_name, l.type::text) AS channel,
        l.city,
        SUM(a.qty_0_30)::int     AS qty_0_30,
        SUM(a.qty_31_60)::int    AS qty_31_60,
        SUM(a.qty_61_90)::int    AS qty_61_90,
        SUM(a.qty_91_180)::int   AS qty_91_180,
        SUM(a.qty_180_plus)::int AS qty_180_plus,
        (SUM(a.qty_0_30)+SUM(a.qty_31_60)+SUM(a.qty_61_90)+SUM(a.qty_91_180)+SUM(a.qty_180_plus))::int AS total_qty,
        ROUND(
          SUM(a.qty_180_plus)::numeric /
          NULLIF(SUM(a.qty_0_30+a.qty_31_60+a.qty_61_90+a.qty_91_180+a.qty_180_plus), 0) * 100, 1
        ) AS dead_stock_pct
      FROM stock_ageing a
      JOIN locations l ON l.id = a.location_id
      WHERE ${conditions.join(' AND ')}
        AND a.ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
      GROUP BY l.id, l.name, l.type, l.group_name, l.city
      ORDER BY dead_stock_pct DESC NULLS LAST
    `, params);
      return summaryResult.rows;
    }, TTL.STOCK_AGEING);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ─── Manual Stock Adjustment ───────────────────────────────────────────────────
async function adjustStock(req, res, next) {
  try {
    const { location_id, sku_id, qty_change, reason } = req.body;

    await transaction(async (client) => {
      const current = await client.query(
        'SELECT qty_on_hand FROM inventory_snapshot WHERE location_id = $1 AND sku_id = $2 FOR UPDATE',
        [location_id, sku_id]
      );
      if (!current.rows.length) throw new AppError('Inventory record not found.', 404);

      const qtyBefore = current.rows[0].qty_on_hand;
      const qtyAfter = qtyBefore + parseInt(qty_change);
      if (qtyAfter < 0) throw new AppError('Adjustment would result in negative stock.', 400);

      await client.query(
        'UPDATE inventory_snapshot SET qty_on_hand = $1, updated_at = NOW() WHERE location_id = $2 AND sku_id = $3',
        [qtyAfter, location_id, sku_id]
      );

      await client.query(
        `INSERT INTO inventory_movements (location_id, sku_id, movement_type, qty_change, qty_before, qty_after, notes, synced_from)
         VALUES ($1, $2, 'ADJUSTMENT', $3, $4, $5, $6, 'MANUAL')`,
        [location_id, sku_id, qty_change, qtyBefore, qtyAfter, reason]
      );
    });

    await invalidatePattern('inventory:*');
    res.json({ success: true, message: 'Stock adjusted successfully.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getExecutiveSummary, getSnapshot, exportSnapshot,
  getLocationInventory, getSkuInventory, getAlerts, getAlertsSummary,
  getMovements, getAgeing, adjustStock,
};
