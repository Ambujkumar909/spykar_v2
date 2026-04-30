const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/redis');
const { canonicalizeCategory, applyCategoryFilter } = require('../utils/categoryFilter');

async function getNetworkOverview(req, res, next) {
  try {
    const data = await getOrSet('analytics:network-overview', async () => {
      const result = await query(`
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
          l.type,
          COUNT(DISTINCT l.id)::int AS locations,
          COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
          COALESCE(SUM(i.qty_available), 0)::int AS available,
          ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS stock_value,
          COUNT(*) FILTER (WHERE
            i.qty_on_hand = 0 OR
            i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
          )::int AS alerts
        FROM locations l
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id
        LEFT JOIN skus s ON s.id = i.sku_id
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        WHERE l.is_active = true
        GROUP BY l.type
      `);
      return result.rows;
    }, TTL.NETWORK_OVERVIEW);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getStockTrend(req, res, next) {
  try {
    const { days = 30, location_type } = req.query;
    const cacheKey = `analytics:trend:${days}:${location_type || 'all'}`;

    const data = await getOrSet(cacheKey, async () => {
      const conditions = ['l.is_active = true'];
      const params = [parseInt(days)];
      if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }

      const result = await query(`
        SELECT
          DATE_TRUNC('day', m.moved_at)::date AS date,
          SUM(CASE WHEN m.movement_type = 'SALE' THEN ABS(m.qty_change) ELSE 0 END)::int AS sales_qty,
          SUM(CASE WHEN m.movement_type = 'RECEIPT' THEN m.qty_change ELSE 0 END)::int AS receipt_qty,
          SUM(CASE WHEN m.movement_type = 'DISPATCH' THEN ABS(m.qty_change) ELSE 0 END)::int AS dispatch_qty
        FROM inventory_movements m
        JOIN locations l ON l.id = m.location_id
        WHERE m.moved_at >= (
            SELECT MAX(moved_at) FROM inventory_movements
          ) - ($1 || ' days')::interval
          AND ${conditions.join(' AND ')}
        GROUP BY DATE_TRUNC('day', m.moved_at)
        ORDER BY date
      `, params);
      return result.rows;
    }, TTL.SKU_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getSizeDistribution(req, res, next) {
  try {
    const {
      location_type, zone_id, category,
      // v2 universal-filter extensions — mode + multi-select SKU/location dims
      state: stateRaw, city: cityRaw, group_name: groupRaw, store_code: storeCodeRaw,
      gender, sub_product, product, style, shade, color, size: sizeMulti, season, mode = 'active',
    } = req.query;

    const multi = (v) => {
      if (v === undefined || v === null || v === '') return [];
      return (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);
    };
    const states     = multi(stateRaw),    cities    = multi(cityRaw);
    const groups     = multi(groupRaw),    storeCodes= multi(storeCodeRaw);
    const skuGenders = multi(gender),      skuSubProds=multi(sub_product), skuProducts=multi(product);
    const skuStyles  = multi(style),       skuShades = multi(shade),        skuSeasons = multi(season);
    const skuColors  = multi(color),       skuSizes  = multi(sizeMulti);

    const catKey = canonicalizeCategory(category);
    const cacheKey = `analytics:size-dist:v5:${location_type||'all'}:${zone_id||'all'}:${states.join('|')}:${cities.join('|')}:${groups.join('|')}:${storeCodes.join('|')}:${catKey||''}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:m${mode}`;

    const data = await getOrSet(cacheKey, async () => {
      const conditions = ['l.is_active = true', 's.is_active = true'];
      const params = [];
      const multiIlike = (col, arr) => {
        if (!arr.length) return null;
        const ors = arr.map(v => { params.push(`%${v}%`); return `${col} ILIKE $${params.length}`; });
        return `(${ors.join(' OR ')})`;
      };
      const multiEq = (col, arr) => {
        if (!arr.length) return null;
        if (arr.length === 1) { params.push(arr[0]); return `UPPER(${col}::text) = UPPER($${params.length})`; }
        params.push(arr.map(v => v.toUpperCase())); return `UPPER(${col}::text) = ANY($${params.length}::text[])`;
      };
      if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }
      if (zone_id)       { params.push(zone_id);        conditions.push(`l.zone_id = $${params.length}`); }
      const stP = multiIlike('l.state', states); if (stP) conditions.push(stP);
      const ctP = multiIlike('l.city',  cities); if (ctP) conditions.push(ctP);
      const gpP = multiEq(`COALESCE(l.group_name, l.type::text)`, groups); if (gpP) conditions.push(gpP);
      const scP = multiEq('l.code', storeCodes); if (scP) conditions.push(scP);
      // 3-mode lens
      const m = String(mode).toLowerCase();
      if (m === 'active')   conditions.push('l.shop_closed = false');
      if (m === 'inactive') conditions.push('l.shop_closed = true');
      // SKU-side filters
      const gP  = multiEq('s.gender_name', skuGenders);  if (gP)  conditions.push(gP);
      const spP = multiEq('s.sub_product', skuSubProds); if (spP) conditions.push(spP);
      const prP = multiEq('s.product',     skuProducts); if (prP) conditions.push(prP);
      const stySP = multiEq('s.style',     skuStyles);   if (stySP) conditions.push(stySP);
      const shP = multiEq('s.shade',       skuShades);   if (shP) conditions.push(shP);
      const clP = multiEq('s.color_name',  skuColors);   if (clP) conditions.push(clP);
      const szP = multiEq('s.size',        skuSizes);    if (szP) conditions.push(szP);
      const snP = multiEq('s.season',      skuSeasons);  if (snP) conditions.push(snP);
      // Category fast path
      const catClause = await applyCategoryFilter(category, params, 'i.sku_id', query, getOrSet);
      if (catClause) conditions.push(catClause);

      const result = await query(`
        SELECT
          s.size,
          SUM(i.qty_on_hand)::int AS total_stock,
          SUM(i.qty_available)::int AS available_stock,
          ROUND(SUM(i.qty_on_hand) * 100.0 / NULLIF(SUM(SUM(i.qty_on_hand)) OVER (), 0), 1) AS pct_of_total
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY s.size
        ORDER BY total_stock DESC
      `, params);
      return result.rows;
    }, TTL.SKU_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getColorDistribution(req, res, next) {
  try {
    const {
      location_type, category,
      state: stateRaw, city: cityRaw, group_name: groupRaw, store_code: storeCodeRaw,
      gender, sub_product, product, style, shade, color, size: sizeMulti, season, mode = 'active',
    } = req.query;

    const multi = (v) => {
      if (v === undefined || v === null || v === '') return [];
      return (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);
    };
    const states     = multi(stateRaw),    cities    = multi(cityRaw);
    const groups     = multi(groupRaw),    storeCodes= multi(storeCodeRaw);
    const skuGenders = multi(gender),      skuSubProds=multi(sub_product), skuProducts=multi(product);
    const skuStyles  = multi(style),       skuShades = multi(shade),        skuSeasons = multi(season);
    const skuColors  = multi(color),       skuSizes  = multi(sizeMulti);

    const catKey = canonicalizeCategory(category);
    const cacheKey = `analytics:color-dist:v8:${location_type||'all'}:${states.join('|')}:${cities.join('|')}:${groups.join('|')}:${storeCodes.join('|')}:${catKey||''}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:m${mode}`;

    const data = await getOrSet(cacheKey, async () => {
      const locConditions = ['l.is_active = true'];
      const params = [];
      const multiIlike = (col, arr) => {
        if (!arr.length) return null;
        const ors = arr.map(v => { params.push(`%${v}%`); return `${col} ILIKE $${params.length}`; });
        return `(${ors.join(' OR ')})`;
      };
      const multiEq = (col, arr) => {
        if (!arr.length) return null;
        if (arr.length === 1) { params.push(arr[0]); return `UPPER(${col}::text) = UPPER($${params.length})`; }
        params.push(arr.map(v => v.toUpperCase())); return `UPPER(${col}::text) = ANY($${params.length}::text[])`;
      };
      if (location_type) { params.push(location_type); locConditions.push(`l.type = $${params.length}`); }
      const stP = multiIlike('l.state', states); if (stP) locConditions.push(stP);
      const ctP = multiIlike('l.city',  cities); if (ctP) locConditions.push(ctP);
      const gpP = multiEq(`COALESCE(l.group_name, l.type::text)`, groups); if (gpP) locConditions.push(gpP);
      const scP = multiEq('l.code', storeCodes); if (scP) locConditions.push(scP);
      const m = String(mode).toLowerCase();
      if (m === 'active')   locConditions.push('l.shop_closed = false');
      if (m === 'inactive') locConditions.push('l.shop_closed = true');
      const gP  = multiEq('s.gender_name', skuGenders);  if (gP)  locConditions.push(gP);
      const spP = multiEq('s.sub_product', skuSubProds); if (spP) locConditions.push(spP);
      const prP = multiEq('s.product',     skuProducts); if (prP) locConditions.push(prP);
      const stySP = multiEq('s.style',     skuStyles);   if (stySP) locConditions.push(stySP);
      const shP = multiEq('s.shade',       skuShades);   if (shP) locConditions.push(shP);
      const clP = multiEq('s.color_name',  skuColors);   if (clP) locConditions.push(clP);
      const szP = multiEq('s.size',        skuSizes);    if (szP) locConditions.push(szP);
      const snP = multiEq('s.season',      skuSeasons);  if (snP) locConditions.push(snP);
      const catClause = await applyCategoryFilter(category, params, 'i.sku_id', query, getOrSet);
      if (catClause) locConditions.push(catClause);

      const result = await query(`
        WITH color_stock AS (
          SELECT
            s.color_code,
            s.color_name,
            COALESCE(SUM(i.qty_on_hand)::int, 0)              AS total_stock,
            COALESCE(SUM(i.qty_available)::int, 0)             AS available_stock,
            COALESCE(ROUND(SUM(i.qty_on_hand * s.mrp), 2), 0) AS stock_value
          FROM inventory_snapshot i
          JOIN skus s ON s.id = i.sku_id
          JOIN locations l ON l.id = i.location_id
          WHERE s.is_active = true
            AND s.color_name IS NOT NULL
            AND ${locConditions.join(' AND ')}
          GROUP BY s.color_code, s.color_name
        )
        SELECT
          color_code, color_name, total_stock, available_stock, stock_value,
          ROUND(total_stock * 100.0 / NULLIF(SUM(total_stock) OVER (), 0), 1) AS pct_of_total
        FROM color_stock
        ORDER BY total_stock DESC
      `, params);
      return result.rows;
    }, TTL.SKU_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getZoneHeatmap(req, res, next) {
  try {
    const data = await getOrSet('analytics:zone-heatmap', async () => {
      const result = await query(`
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
          z.name AS zone,
          l.type AS location_type,
          COUNT(DISTINCT l.id)::int AS location_count,
          COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
          ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS stock_value,
          COUNT(*) FILTER (WHERE
            i.qty_on_hand = 0 OR
            i.qty_on_hand <= CASE WHEN i.safety_stock > 0 THEN i.safety_stock
                                  ELSE GREATEST(5, ROUND(COALESCE(v.adv,1)*14)) END
          )::int AS alerts
        FROM zones z
        LEFT JOIN locations l ON l.zone_id = z.id AND l.is_active = true
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id
        LEFT JOIN skus s ON s.id = i.sku_id
        LEFT JOIN vel v ON v.location_id = i.location_id AND v.sku_id = i.sku_id
        GROUP BY z.name, l.type
        ORDER BY z.name, l.type
      `);
      return result.rows;
    }, TTL.SKU_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getFillRate(req, res, next) {
  try {
    const { days = 30 } = req.query;
    const data = await getOrSet(`analytics:fill-rate:${days}`, async () => {
      const result = await query(`
        SELECT
          l.type AS location_type,
          COUNT(*)::int AS total_dispatches,
          COUNT(*) FILTER (WHERE do.status = 'DELIVERED')::int AS delivered,
          ROUND(COUNT(*) FILTER (WHERE do.status = 'DELIVERED') * 100.0 / NULLIF(COUNT(*), 0), 1) AS fill_rate_pct,
          AVG(EXTRACT(EPOCH FROM (do.delivered_at - do.dispatched_at)) / 3600)::int AS avg_delivery_hours
        FROM dispatch_orders do
        JOIN locations l ON l.id = do.to_location_id
        WHERE do.dispatched_at >= (
            SELECT MAX(dispatched_at) FROM dispatch_orders
          ) - ($1 || ' days')::interval
        GROUP BY l.type
      `, [days]);
      return result.rows;
    }, TTL.FILL_RATE);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ─── Sales Analytics (Premium) ────────────────────────────────────────────────
// Single endpoint powering the full Sales & Returns analytics page.
// Filters: date_from, date_to, color_name, size, location_id, state, city, category
// Returns: summary, daily, by_color, by_size, by_store, by_month, stock_snapshot
async function getSalesAnalytics(req, res, next) {
  try {
    const {
      date_from, date_to, color_name, size, location_id, category,
      // v2 multi-select extensions wired through by the universal FilterBar
      gender, sub_product, product, style, shade, color, size: sizeMulti, season,
      state: stateRaw, city: cityRaw, group_name: groupRaw, store_code: storeCodeRaw,
      mode = 'active',
    } = req.query;
    const catKey = canonicalizeCategory(category); // normalized or null

    // Multi-value parser identical to location.controller — accepts CSV or array.
    const multi = (v) => {
      if (v === undefined || v === null || v === '') return [];
      if (Array.isArray(v)) return v.filter(Boolean).map(String);
      return String(v).split(',').map(s => s.trim()).filter(Boolean);
    };
    const states     = multi(stateRaw);
    const cities     = multi(cityRaw);
    const groups     = multi(groupRaw);
    const storeCodes = multi(storeCodeRaw);
    const skuGenders = multi(gender);
    const skuSubProds= multi(sub_product);
    const skuProducts= multi(product);
    const skuStyles  = multi(style);
    const skuShades  = multi(shade);
    const skuColors  = multi(color);
    const skuSizes   = multi(sizeMulti);
    const skuSeasons = multi(season);

    // Cache key — unique per filter combination (category canonicalized so
    // "Denim"/"denim"/"jeans" all hit the same cache slot)
    const cacheKey = `analytics:sales:v7:${date_from||''}:${date_to||''}:${color_name||''}:${size||''}:${location_id||''}:${states.join('|')}:${cities.join('|')}:${groups.join('|')}:${storeCodes.join('|')}:${catKey||''}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:m${mode}`;

    const data = await getOrSet(cacheKey, async () => {
    const conditions = [];
    const params     = [];

    // Multi-value predicate helpers
    const multiIlike = (col, arr) => {
      if (!arr.length) return null;
      const ors = arr.map(v => { params.push(`%${v}%`); return `${col} ILIKE $${params.length}`; });
      return `(${ors.join(' OR ')})`;
    };
    const multiEq = (col, arr) => {
      if (!arr.length) return null;
      // Case-insensitive equality so 'jeans'/'JEANS' both match.
      if (arr.length === 1) { params.push(arr[0]); return `UPPER(${col}::text) = UPPER($${params.length})`; }
      params.push(arr.map(v => v.toUpperCase())); return `UPPER(${col}::text) = ANY($${params.length}::text[])`;
    };

    // Date range — default to full available window (Apr 2024 → Jan 2026)
    const from = date_from || '2024-04-01';
    const to   = date_to   || '2026-01-31';
    params.push(from); conditions.push(`m.moved_at >= $${params.length}::date`);
    params.push(to);   conditions.push(`m.moved_at <  $${params.length}::date + interval '1 day'`);

    if (color_name)   { params.push(color_name);   conditions.push(`s.color_name ILIKE $${params.length}`); }
    if (size)         { params.push(size);          conditions.push(`s.size = $${params.length}`); }
    if (location_id)  { params.push(location_id);   conditions.push(`m.location_id = $${params.length}`); }
    // v2 multi-select location filters
    const stP = multiIlike('l.state',  states); if (stP) conditions.push(stP);
    const ctP = multiIlike('l.city',   cities); if (ctP) conditions.push(ctP);
    const gpP = multiEq(`COALESCE(l.group_name, l.type::text)`, groups); if (gpP) conditions.push(gpP);
    const scP = multiEq('l.code', storeCodes); if (scP) conditions.push(scP);
    if (String(mode).toLowerCase() === 'active') conditions.push('l.shop_closed = false');
    // v2 SKU dimension filters — direct equality on the joined skus row
    const gP  = multiEq('s.gender_name', skuGenders);  if (gP)  conditions.push(gP);
    const spP = multiEq('s.sub_product', skuSubProds); if (spP) conditions.push(spP);
    const prP = multiEq('s.product',     skuProducts); if (prP) conditions.push(prP);
    const stySP = multiEq('s.style',     skuStyles);   if (stySP) conditions.push(stySP);
    const shP = multiEq('s.shade',       skuShades);   if (shP) conditions.push(shP);
    const clP = multiEq('s.color_name',  skuColors);   if (clP) conditions.push(clP);
    const szP = multiEq('s.size',        skuSizes);    if (szP) conditions.push(szP);
    const snP = multiEq('s.season',      skuSeasons);  if (snP) conditions.push(snP);

    // Category filter — fast path. Pre-resolves category → sku_id[] (cached 24h in
    // Redis) then emits `m.sku_id = ANY($n::uuid[])`, turning the scan into an
    // indexed equality seek on inventory_movements(sku_id) rather than a per-row
    // ILIKE over the joined skus row (10–50× faster on date-filtered windows).
    const catClause = await applyCategoryFilter(category, params, 'm.sku_id', query, getOrSet);
    if (catClause) conditions.push(catClause);

    const where = `JOIN skus s ON s.id = m.sku_id
                   JOIN locations l ON l.id = m.location_id
                   WHERE ${conditions.join(' AND ')}`;

    // ── Run queries sequentially in small batches to avoid exhausting PostgreSQL
    // shared memory in Docker (/dev/shm). Running all 9 concurrently fills shm.
    // Strategy: one mega-CTE scan per "pass" — each pass hits the table once.

    // Pass 1: filter options — run sequentially to avoid competing for PostgreSQL shared memory
    const colorListRes = await query(`SELECT DISTINCT s.color_name FROM inventory_movements m JOIN skus s ON s.id = m.sku_id WHERE m.movement_type = 'SALE' AND s.color_name IS NOT NULL ORDER BY s.color_name`);
    const sizeListRes  = await query(`SELECT size FROM (SELECT DISTINCT s.size, CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END AS sort_key FROM inventory_movements m JOIN skus s ON s.id = m.sku_id WHERE m.movement_type = 'SALE' AND s.size IS NOT NULL) t ORDER BY sort_key, size`);
    const storeListRes = await query(`SELECT id, name FROM locations WHERE is_active=true ORDER BY name`);

    // Pass 2: single mega-CTE that scans inventory_movements ONCE and produces all aggregations
    // This is the key optimisation — one table scan feeds summary + daily + color + size + store + monthly
    const megaRes = await query(`
      WITH mov AS (
        SELECT
          m.moved_at,
          m.movement_type,
          ABS(m.qty_change)::int         AS qty,
          COALESCE(m.sale_value, 0)      AS val,
          m.location_id,
          m.sku_id,
          s.color_name,
          s.size,
          l.name                         AS loc_name,
          l.code                         AS loc_code,
          COALESCE(l.external_id, '')    AS external_id,
          COALESCE(l.group_name, l.type::text) AS channel,
          l.city,
          l.state
        FROM inventory_movements m
        JOIN skus s ON s.id = m.sku_id
        JOIN locations l ON l.id = m.location_id
        WHERE ${conditions.join(' AND ')}
          AND m.movement_type IN ('SALE','RETURN')
      )
      SELECT
        -- ① Summary KPIs
        (SELECT row_to_json(t) FROM (SELECT
          COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int   AS units_sold,
          COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
          COUNT(*)         FILTER (WHERE movement_type='SALE')::int        AS sales_txns,
          COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int AS return_units,
          COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
          COUNT(*)         FILTER (WHERE movement_type='RETURN')::int      AS return_txns,
          COUNT(DISTINCT location_id) FILTER (WHERE movement_type='SALE')::int AS stores_with_sales,
          COUNT(DISTINCT DATE_TRUNC('day',moved_at)) FILTER (WHERE movement_type='SALE')::int AS active_days,
          COUNT(DISTINCT sku_id) FILTER (WHERE movement_type='SALE')::int  AS unique_skus_sold
        FROM mov) t) AS summary,

        -- ② Daily trend
        (SELECT json_agg(d ORDER BY d.date) FROM (
          SELECT DATE_TRUNC('day', moved_at)::date AS date,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int  AS sales_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int AS return_qty,
            COUNT(*) FILTER (WHERE movement_type='SALE')::int AS transactions
          FROM mov GROUP BY 1
        ) d) AS daily,

        -- ③ By colour (no limit — full dataset returned, frontend handles pagination)
        (SELECT json_agg(c ORDER BY c.units_sold DESC) FROM (
          SELECT color_name,
            SUM(qty)::int    AS units_sold,
            SUM(val)::bigint AS sales_value,
            COUNT(*)::int    AS transactions,
            ROUND(SUM(val)/NULLIF(SUM(qty),0),0)::int AS avg_price
          FROM mov WHERE movement_type='SALE'
          GROUP BY color_name ORDER BY units_sold DESC
        ) c) AS by_color,

        -- ④ By size (no limit — full dataset returned, frontend handles pagination)
        (SELECT json_agg(sz ORDER BY sz.units_sold DESC) FROM (
          SELECT size,
            SUM(qty)::int    AS units_sold,
            SUM(val)::bigint AS sales_value,
            COUNT(*)::int    AS transactions,
            ROUND(SUM(val)/NULLIF(SUM(qty),0)::numeric,0)::int AS avg_price
          FROM mov WHERE movement_type='SALE'
          GROUP BY size ORDER BY units_sold DESC
        ) sz) AS by_size,

        -- ⑤ Top stores
        (SELECT json_agg(st ORDER BY st.sales_value DESC) FROM (
          SELECT loc_name AS location_name, channel, city,
            SUM(qty)::int    AS units_sold,
            SUM(val)::bigint AS sales_value,
            COUNT(*)::int    AS transactions
          FROM mov WHERE movement_type='SALE'
          GROUP BY loc_name, channel, city ORDER BY sales_value DESC LIMIT 50
        ) st) AS by_store,

        -- ⑥ Monthly trend
        (SELECT json_agg(mo ORDER BY mo.month_date) FROM (
          SELECT TO_CHAR(DATE_TRUNC('month',moved_at),'Mon YY') AS month_label,
            DATE_TRUNC('month',moved_at)::date AS month_date,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS sales_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty
          FROM mov GROUP BY 1,2
        ) mo) AS by_month,

        -- ⑦ All stores — no limit, full list respecting active filters
        (SELECT json_agg(ast ORDER BY ast.sales_value DESC) FROM (
          SELECT loc_name AS location_name, location_id::text AS location_id,
            COALESCE(loc_code,'') AS location_code, COALESCE(external_id,'') AS external_id,
            COALESCE(channel,'') AS channel, COALESCE(city,'') AS city, COALESCE(state,'') AS state,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COUNT(*) FILTER (WHERE movement_type='SALE')::int                AS transactions,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty
          FROM mov
          GROUP BY loc_name, location_id, loc_code, external_id, channel, city, state
        ) ast) AS all_stores
    `, params);

    // Pass 3: stock snapshot (separate table, no contention with pass 2)
    const stockRes = await query(`
      SELECT
        SUM(i.qty_on_hand)::int                    AS total_units,
        ROUND(SUM(i.qty_on_hand * s.mrp),0)::bigint AS total_mrp_value,
        COUNT(DISTINCT i.location_id)::int          AS locations,
        COUNT(DISTINCT i.sku_id)::int               AS unique_skus
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      JOIN locations l ON l.id = i.location_id
      WHERE l.is_active = true AND i.qty_on_hand > 0
        ${color_name  ? `AND s.color_name ILIKE '${color_name.replace(/'/g,"''")}'` : ''}
        ${size        ? `AND s.size = '${size.replace(/'/g,"''")}'`                  : ''}
        ${location_id ? `AND i.location_id = '${String(location_id).replace(/'/g,"''")}'::uuid` : ''}
    `);

    const mega = megaRes.rows[0];
    const sm   = mega.summary;
    const summaryRes  = { rows: [sm] };
    const dailyRes    = { rows: mega.daily      || [] };
    const colorRes    = { rows: mega.by_color   || [] };
    const sizeRes     = { rows: mega.by_size    || [] };
    const storeRes    = { rows: mega.by_store   || [] };
    const monthRes    = { rows: mega.by_month   || [] };
    const allStoreRes = { rows: mega.all_stores || [] };

    const s = summaryRes.rows[0];
    const netUnits = (s.units_sold || 0) - (s.return_units || 0);

      return {
        summary: {
          sales_txns:        s.sales_txns,
          units_sold:        s.units_sold,
          sales_value:       Number(s.sales_value),
          return_txns:       s.return_txns,
          return_units:      s.return_units,
          return_value:      Number(s.return_value),
          net_units:         netUnits,
          net_value:         Number(s.sales_value) - Number(s.return_value),
          avg_price:         s.units_sold > 0 ? Math.round(Number(s.sales_value) / s.units_sold) : 0,
          return_rate_pct:   s.units_sold > 0 ? Math.round((s.return_units / s.units_sold) * 1000) / 10 : 0,
          stores_with_sales: s.stores_with_sales,
          active_days:       s.active_days,
          unique_skus_sold:  s.unique_skus_sold,
        },
        stock_snapshot: stockRes.rows[0],
        daily:      dailyRes.rows,
        by_color:   colorRes.rows,
        by_size:    sizeRes.rows,
        by_store:   storeRes.rows,
        by_month:   monthRes.rows,
        all_stores: allStoreRes.rows,
        filter_options: {
          colors: colorListRes.rows.map(r => r.color_name),
          sizes:  sizeListRes.rows.map(r => r.size),
          stores: storeListRes.rows.map(r => ({ id: r.id, name: r.name })),
        },
      };
    }, TTL.SALES_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getReturnsAnalytics(req, res, next) {
  try {
    const { date_from, date_to, state, city, category } = req.query;
    const catKey = canonicalizeCategory(category);
    const cacheKey = `analytics:returns:v3:${date_from||''}:${date_to||''}:${state||''}:${city||''}:${catKey||''}`;

    const data = await getOrSet(cacheKey, async () => {
      const conditions = ["m.movement_type = 'RETURN'", 'l.is_active = true', 's.is_active = true'];
      const params = [];

      if (date_from && date_to) {
        params.push(date_from); params.push(date_to);
        conditions.push(`m.moved_at >= $${params.length - 1}::date AND m.moved_at < ($${params.length}::date + INTERVAL '1 day')`);
      }
      if (state) { params.push(state); conditions.push(`l.state ILIKE $${params.length}`); }
      if (city)  { params.push(city);  conditions.push(`l.city  ILIKE $${params.length}`); }
      // Fast path: pre-resolved sku_id[] seek against inventory_movements(sku_id)
      const catClause = await applyCategoryFilter(category, params, 'm.sku_id', query, getOrSet);
      if (catClause) conditions.push(catClause);

      const result = await query(`
        WITH mov AS (
          SELECT ABS(m.qty_change) AS qty,
                 ABS(m.qty_change) * s.mrp AS val,
                 s.color_name, s.size,
                 l.name AS loc_name, l.type AS channel, l.city, l.state
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s      ON s.id = m.sku_id
          WHERE ${conditions.join(' AND ')}
        )
        SELECT
          (SELECT json_agg(c ORDER BY c.return_units DESC) FROM (
            SELECT color_name,
              SUM(qty)::int    AS return_units,
              SUM(val)::bigint AS return_value
            FROM mov WHERE color_name IS NOT NULL
            GROUP BY color_name ORDER BY return_units DESC
          ) c) AS by_color,

          (SELECT json_agg(sz ORDER BY sz.return_units DESC) FROM (
            SELECT size,
              SUM(qty)::int    AS return_units,
              SUM(val)::bigint AS return_value
            FROM mov WHERE size IS NOT NULL
            GROUP BY size ORDER BY return_units DESC
          ) sz) AS by_size,

          (SELECT json_agg(st ORDER BY st.return_units DESC) FROM (
            SELECT loc_name AS location_name, channel, city,
              SUM(qty)::int    AS return_units,
              SUM(val)::bigint AS return_value,
              COUNT(*)::int    AS transactions
            FROM mov GROUP BY loc_name, channel, city ORDER BY return_units DESC LIMIT 50
          ) st) AS by_store
      `, params);

      const mega = result.rows[0];
      return {
        by_color: mega.by_color || [],
        by_size:  mega.by_size  || [],
        by_store: mega.by_store || [],
      };
    }, TTL.SALES_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

module.exports = {
  getNetworkOverview, getStockTrend, getSizeDistribution,
  getColorDistribution, getZoneHeatmap, getFillRate,
  getSalesAnalytics, getReturnsAnalytics,
};
