const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');
const { canonicalizeCategory, applyCategoryFilter } = require('../utils/categoryFilter');

// Today as 'YYYY-MM-DD' (server local time). Used as the default upper bound
// for date filters so the data window tracks the wall clock — never hardcode.
const todayISO = () => new Date().toISOString().slice(0, 10);

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
    const cacheKey = `analytics:sales:v18:${date_from||''}:${date_to||''}:${color_name||''}:${size||''}:${location_id||''}:${states.join('|')}:${cities.join('|')}:${groups.join('|')}:${storeCodes.join('|')}:${catKey||''}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:m${mode}`;

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

    // Date range — default to full available window (Apr 2024 → today)
    const from = date_from || '2024-04-01';
    const to   = date_to   || todayISO();
    params.push(from); conditions.push(`m.moved_at >= $${params.length}::date`);
    params.push(to);   conditions.push(`m.moved_at <  $${params.length}::date + interval '1 day'`);

    if (color_name)   { params.push(color_name);   conditions.push(`s.color_name ILIKE $${params.length}`); }
    // Legacy single-value `size` shares the same query-string key as the v2
    // multi-select. When the user picks Size 8,32 the FilterBar sends
    // `size=8,32` and destructuring populates BOTH `size` and `sizeMulti` to
    // the same string. Without this guard, `s.size = '8,32'` (literal) was
    // AND-joined with `s.size IN ('8','32')`, killing the result set to 0.
    // Skip the legacy filter whenever a multi-select payload is present.
    if (size && skuSizes.length === 0) {
      params.push(size); conditions.push(`s.size = $${params.length}`);
    }
    // ── Location-only conditions are pushed to a PARALLEL array. They feed
    // a separate `loc_filtered` CTE used by `all_stores` to LEFT JOIN
    // movements — that's how stores with zero activity in the window still
    // appear in the table (transparency: "275 / 284" becomes "284 with 9
    // showing 0 sales"). The conditions reference $N param indexes shared
    // with the main params array, so no value duplication.
    const locConditions = ['l.is_active = true'];
    if (location_id)  {
      params.push(location_id);
      conditions.push(`m.location_id = $${params.length}`);
      locConditions.push(`l.id = $${params.length}::uuid`);
    }
    const stP = multiIlike('l.state',  states); if (stP) { conditions.push(stP); locConditions.push(stP); }
    const ctP = multiIlike('l.city',   cities); if (ctP) { conditions.push(ctP); locConditions.push(ctP); }
    const gpP = multiEq(`COALESCE(l.group_name, l.type::text)`, groups); if (gpP) { conditions.push(gpP); locConditions.push(gpP); }
    const scP = multiEq('l.code', storeCodes); if (scP) { conditions.push(scP); locConditions.push(scP); }
    // 3-mode lens — 'active' = open today; 'inactive' = closed; 'all' = any.
    // Strict allow-list: any unknown value collapses to 'active' (the safest
    // default that doesn't accidentally widen the dataset). Same defensive
    // shape used by inventory.controller.js so every Overview-driving
    // endpoint accepts identical mode semantics.
    const _mRaw = String(mode || 'active').toLowerCase();
    const _m = ['active','inactive','all'].includes(_mRaw) ? _mRaw : 'active';
    if (_m === 'active')   { conditions.push('l.shop_closed = false'); locConditions.push('l.shop_closed = false'); }
    if (_m === 'inactive') { conditions.push('l.shop_closed = true');  locConditions.push('l.shop_closed = true'); }
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

    // ── Pass 1: filter-option lookups ──────────────────────────────────────
    // These three are independent of each other AND independent of the mega-CTE.
    // Previously they ran serially "to protect /dev/shm" — but they're tiny
    // (DISTINCT scans on indexes), nowhere near the shm pressure that kicks in
    // for the mega-CTE. Running them in parallel saves 300-800ms cold per call.
    //
    // The store list is also cached at the request layer with a 30-min TTL —
    // it changes only when locations are added/closed (rare).
    const [colorListRes, sizeListRes, storeListRes] = await Promise.all([
      query(`SELECT DISTINCT s.color_name FROM inventory_movements m JOIN skus s ON s.id = m.sku_id WHERE m.movement_type = 'SALE' AND s.color_name IS NOT NULL ORDER BY s.color_name`),
      query(`SELECT size FROM (SELECT DISTINCT s.size, CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END AS sort_key FROM inventory_movements m JOIN skus s ON s.id = m.sku_id WHERE m.movement_type = 'SALE' AND s.size IS NOT NULL) t ORDER BY sort_key, size`),
      getOrSet('analytics:sales:store-list:v1', async () =>
        (await query(`SELECT id, name FROM locations WHERE is_active=true ORDER BY name`)).rows
      , 1800).then(rows => ({ rows })),
    ]);

    // Pass 2: single mega-CTE that scans inventory_movements ONCE and produces all aggregations
    // This is the key optimisation — one table scan feeds summary + daily + color + size + store + monthly
    const megaRes = await query(`
      WITH mov AS (
        SELECT
          m.moved_at,
          m.movement_type,
          ABS(m.qty_change)::int         AS qty,
          COALESCE(m.sale_value, 0)      AS val,
          -- Valuation augmentations — computed per movement row so every
          -- aggregate below can pick the right ₹ basis without re-querying.
          -- gst_rate defaults to 12% when missing (apparel median) so legacy
          -- rows don't poison the GST split. cost_price defaults to 45% MRP
          -- (also the load_item_master.js convention).
          (ABS(m.qty_change)::numeric * COALESCE(s.mrp, 0))                     AS mrp_val,
          (ABS(m.qty_change)::numeric * COALESCE(s.cost_price, COALESCE(s.mrp,0)*0.45)) AS cost_val,
          (COALESCE(m.sale_value, 0)::numeric * COALESCE(s.gst_rate, 12)
            / NULLIF(100 + COALESCE(s.gst_rate, 12), 0))                        AS gst_val,
          (COALESCE(m.sale_value, 0)::numeric
            - COALESCE(m.sale_value, 0)::numeric * COALESCE(s.gst_rate, 12)
              / NULLIF(100 + COALESCE(s.gst_rate, 12), 0))                      AS ex_gst_val,
          m.location_id,
          m.sku_id,
          s.sku_code,
          s.product_name,
          s.fit_type,
          s.mrp                          AS sku_mrp,
          s.color_code,
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
      ),
      -- Per-SKU rollup over the full universe of SKUs in the filtered window.
      -- Top sellers (head) and slow movers (tail) both read from this CTE so
      -- "Slow Movers" really means slowest of the WHOLE universe (~48K SKUs),
      -- not slowest of the top-200 head.
      sku_agg AS (
        SELECT
          sku_id::text                                                   AS sku_id,
          sku_code,
          product_name,
          COALESCE(fit_type,'')                                          AS fit_type,
          color_code,
          color_name,
          size,
          MAX(sku_mrp)                                                   AS mrp,
          COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int  AS units_sold,
          COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
          COUNT(*)         FILTER (WHERE movement_type='SALE')::int      AS transactions,
          COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int AS return_qty,
          COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
          COUNT(DISTINCT location_id) FILTER (WHERE movement_type='SALE')::int AS stores_count,
          COUNT(DISTINCT DATE_TRUNC('day', moved_at))
            FILTER (WHERE movement_type='SALE')::int                     AS days_sold,
          MIN(moved_at) FILTER (WHERE movement_type='SALE')              AS first_sold_at,
          MAX(moved_at) FILTER (WHERE movement_type='SALE')              AS last_sold_at,
          COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
          COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint AS cogs_value,
          COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
          COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value
        FROM mov
        GROUP BY sku_id, sku_code, product_name, fit_type, color_code, color_name, size
        HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)
             + COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0) > 0
      )
      SELECT
        -- ① Summary KPIs (with full valuation lens columns).
        -- For each lens we ship sale_*, return_*, and the consumer derives net
        -- = sale - return. Names mirror existing keys (sales_value) so legacy
        -- code keeps working while new lens-aware code reads the lens-suffixed
        -- variants.
        (SELECT row_to_json(t) FROM (SELECT
          COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
          COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
          COUNT(*)         FILTER (WHERE movement_type='SALE')::int        AS sales_txns,
          COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_units,
          COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
          COUNT(*)         FILTER (WHERE movement_type='RETURN')::int      AS return_txns,
          COUNT(DISTINCT location_id) FILTER (WHERE movement_type='SALE')::int AS stores_with_sales,
          COUNT(DISTINCT DATE_TRUNC('day',moved_at)) FILTER (WHERE movement_type='SALE')::int AS active_days,
          COUNT(DISTINCT sku_id) FILTER (WHERE movement_type='SALE')::int  AS unique_skus_sold,
          -- Valuation lenses — aggregated raw, frontend picks which to display
          COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint   AS sales_mrp_value,
          COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint   AS sales_cogs_value,
          COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint   AS sales_gst_collected,
          COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint   AS sales_ex_gst_value,
          COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
          COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_cogs_value,
          COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
          COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
        FROM mov) t) AS summary,

        -- ② Daily trend (with lens columns so charts can flip valuation)
        (SELECT json_agg(d ORDER BY d.date) FROM (
          SELECT DATE_TRUNC('day', moved_at)::date AS date,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int  AS sales_qty,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int AS return_qty,
            COUNT(*) FILTER (WHERE movement_type='SALE')::int AS transactions
          FROM mov GROUP BY 1
        ) d) AS daily,

        -- ③ By colour — sale + return aggregates with full lens columns on
        -- BOTH sides so the Top tables can rank by Sale, Return, or Net.
        (SELECT json_agg(c ORDER BY c.units_sold DESC) FROM (
          SELECT color_name,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COUNT(*)         FILTER (WHERE movement_type='SALE')::int        AS transactions,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint AS cogs_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value,
            ROUND(COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)
              / NULLIF(SUM(qty) FILTER (WHERE movement_type='SALE'),0),0)::int AS avg_price
          FROM mov GROUP BY color_name
        ) c) AS by_color,

        -- ④ By size — same shape as by_color + lens columns on both sides.
        (SELECT json_agg(sz ORDER BY sz.units_sold DESC) FROM (
          SELECT size,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COUNT(*)         FILTER (WHERE movement_type='SALE')::int        AS transactions,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint AS cogs_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value,
            ROUND(COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)
              / NULLIF(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::numeric,0)::int AS avg_price
          FROM mov GROUP BY size
        ) sz) AS by_size,

        -- ⑤ Top stores (sale + return aggregates so the Top Stores widget
        -- flips by Sale/Return/Net lens AND by valuation). Removing the
        -- WHERE movement_type='SALE' filter so RETURN rows are included in
        -- the aggregation; FILTER clauses split them per-side.
        (SELECT json_agg(st ORDER BY st.sales_value DESC) FROM (
          SELECT loc_name AS location_name, channel, city,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COUNT(*)         FILTER (WHERE movement_type='SALE')::int        AS transactions,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint AS cogs_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
          FROM mov
          GROUP BY loc_name, channel, city ORDER BY sales_value DESC LIMIT 50
        ) st) AS by_store,

        -- ⑥ Monthly trend (with lens columns so the monthly bars can flip)
        (SELECT json_agg(mo ORDER BY mo.month_date) FROM (
          SELECT TO_CHAR(DATE_TRUNC('month',moved_at),'Mon YY') AS month_label,
            DATE_TRUNC('month',moved_at)::date AS month_date,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS sales_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty
          FROM mov GROUP BY 1,2
        ) mo) AS by_month,

        -- ⑦b By channel — group by location.group_name, billing-model
        -- classified. Powers the Channels widget on the Sales Pulse so
        -- "EBO - SOR / Alternate - SOR / MBO - SOR" sales mix is visible.
        -- Carries return-side lens columns too for Net/Return ranking.
        (SELECT json_agg(ch ORDER BY ch.sales_value DESC) FROM (
          SELECT
            COALESCE(channel,'(unassigned)')::text AS channel,
            COUNT(DISTINCT location_id)::int                                 AS stores,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS value,
            COUNT(*)         FILTER (WHERE movement_type='SALE')::int        AS transactions,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint AS cogs_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value,
            CASE
              WHEN COALESCE(channel,'') ILIKE '%outright%' OR COALESCE(channel,'') ILIKE '%- or' OR COALESCE(channel,'') ILIKE '% - or' OR COALESCE(channel,'') ILIKE '%- rt' THEN 'OUTRIGHT'
              ELSE 'SOR'
            END AS billing_model
          FROM mov GROUP BY 1, billing_model
          HAVING COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0) > 0
        ) ch) AS by_channel,

        -- ⑦ All stores with at least one SALE/RETURN in the window.
        -- Silent stores (eligible but zero-activity) are merged in by the
        -- JS layer below — keeping the mega-CTE single-pass on the mov
        -- table avoids re-materialising the 2.7M-row CTE 11x (which made
        -- the LEFT JOIN variant push active-mode cold latency to 40+ s).
        (SELECT json_agg(ast ORDER BY ast.sales_value DESC) FROM (
          SELECT loc_name AS location_name, location_id::text AS location_id,
            COALESCE(loc_code,'') AS location_code, COALESCE(external_id,'') AS external_id,
            COALESCE(channel,'') AS channel, COALESCE(city,'') AS city, COALESCE(state,'') AS state,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
            COUNT(*) FILTER (WHERE movement_type='SALE')::int                AS transactions,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
            COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
            COALESCE(SUM(cost_val)   FILTER (WHERE movement_type='SALE'),0)::bigint AS cogs_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
          FROM mov
          GROUP BY loc_name, location_id, loc_code, external_id, channel, city, state
        ) ast) AS all_stores,

        -- ⑧ Per-SKU performance — head (top sellers) + tail (slow movers) in
        -- two passes over the same per-SKU aggregation. The sku_agg CTE
        -- groups every SKU once; we then take TOP 200 by sales_value DESC for
        -- best-sellers AND BOTTOM 200 by sales_value ASC for slow-movers. This
        -- way "Slow Movers" really means the slowest of the full universe
        -- (~48K SKUs) — not the slowest of the top 200.
        -- Includes every lens column so the page valuation dropdown flips ₹
        -- figures here too. days_sold = distinct days with at least one sale
        -- in the filter window; velocity is computed client-side.
        (SELECT json_agg(sk ORDER BY sk.sales_value DESC) FROM (
          SELECT * FROM sku_agg ORDER BY sales_value DESC LIMIT 200
        ) sk) AS by_sku,

        (SELECT json_agg(sk ORDER BY sk.sales_value ASC) FROM (
          SELECT * FROM sku_agg ORDER BY sales_value ASC, units_sold ASC LIMIT 200
        ) sk) AS by_sku_slow,

        (SELECT COUNT(*)::int FROM sku_agg) AS sku_universe_count
    `, params);

    // Pass 3: stock snapshot — anchored at the latest AIGetStock pull
    // (today, refreshed nightly) and now narrowed by the FULL v2 filter set so picking gender=
    // MENS shows MENS-only stock, mode=inactive shows closed-store stock,
    // etc. Previously this query only honoured 3 legacy single-value filters
    // and ignored every v2 dimension — so the Stock KPI didn't track with
    // the rest of the page when filters were applied.
    const stockParams = [];
    const stockConds = ['l.is_active = true', 'i.qty_on_hand > 0'];
    const stockML = (col, arr) => {
      if (!arr.length) return null;
      const ors = arr.map(v => { stockParams.push(`%${v}%`); return `${col} ILIKE $${stockParams.length}`; });
      return `(${ors.join(' OR ')})`;
    };
    const stockMEq = (col, arr) => {
      if (!arr.length) return null;
      if (arr.length === 1) { stockParams.push(arr[0]); return `UPPER(${col}::text) = UPPER($${stockParams.length})`; }
      stockParams.push(arr.map(v => v.toUpperCase()));
      return `UPPER(${col}::text) = ANY($${stockParams.length}::text[])`;
    };
    // Location-side
    const _ss = stockML('l.state', states);  if (_ss) stockConds.push(_ss);
    const _sc = stockML('l.city',  cities);  if (_sc) stockConds.push(_sc);
    const _sg = stockMEq(`COALESCE(l.group_name, l.type::text)`, groups); if (_sg) stockConds.push(_sg);
    const _sx = stockMEq('l.code', storeCodes); if (_sx) stockConds.push(_sx);
    const _sm = String(mode).toLowerCase();
    if (_sm === 'active')   stockConds.push('l.shop_closed = false');
    if (_sm === 'inactive') stockConds.push('l.shop_closed = true');
    // SKU-side
    const _sgn = stockMEq('s.gender_name', skuGenders);  if (_sgn) stockConds.push(_sgn);
    const _ssp = stockMEq('s.sub_product', skuSubProds); if (_ssp) stockConds.push(_ssp);
    const _spr = stockMEq('s.product',     skuProducts); if (_spr) stockConds.push(_spr);
    const _sst = stockMEq('s.style',       skuStyles);   if (_sst) stockConds.push(_sst);
    const _ssh = stockMEq('s.shade',       skuShades);   if (_ssh) stockConds.push(_ssh);
    const _scl = stockMEq('s.color_name',  skuColors);   if (_scl) stockConds.push(_scl);
    const _ssz = stockMEq('s.size',        skuSizes);    if (_ssz) stockConds.push(_ssz);
    const _ssn = stockMEq('s.season',      skuSeasons);  if (_ssn) stockConds.push(_ssn);
    if (color_name)  { stockParams.push(color_name); stockConds.push(`s.color_name ILIKE $${stockParams.length}`); }
    // Same destructuring trap as the sales query above — guard the legacy
    // single-value size against the v2 multi-select sharing the same key.
    if (size && skuSizes.length === 0) {
      stockParams.push(size); stockConds.push(`s.size = $${stockParams.length}`);
    }
    if (location_id) { stockParams.push(location_id); stockConds.push(`i.location_id = $${stockParams.length}::uuid`); }
    // Category fast path (sku_id[] seek)
    const _scat = await applyCategoryFilter(category, stockParams, 'i.sku_id', query, getOrSet);
    if (_scat === 'FALSE') stockConds.push('FALSE');
    else if (_scat) stockConds.push(_scat);

    const stockRes = await query(`
      SELECT
        SUM(i.qty_on_hand)::int                    AS total_units,
        ROUND(SUM(i.qty_on_hand * s.mrp),0)::bigint AS total_mrp_value,
        COUNT(DISTINCT i.location_id)::int          AS locations,
        COUNT(DISTINCT i.sku_id)::int               AS unique_skus
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      JOIN locations l ON l.id = i.location_id
      WHERE ${stockConds.join(' AND ')}
    `, stockParams);

    const mega = megaRes.rows[0];
    const sm   = mega.summary;
    const summaryRes  = { rows: [sm] };
    const dailyRes    = { rows: mega.daily      || [] };
    const colorRes    = { rows: mega.by_color   || [] };
    const sizeRes     = { rows: mega.by_size    || [] };
    const storeRes    = { rows: mega.by_store   || [] };
    const monthRes    = { rows: mega.by_month   || [] };
    const channelRes  = { rows: mega.by_channel || [] };
    const skuRes      = { rows: mega.by_sku       || [] };
    const skuSlowRes  = { rows: mega.by_sku_slow  || [] };
    const skuUniverse = Number(mega.sku_universe_count || 0);

    // ── Eligible-stores small query — STANDALONE so it doesn't share the
    // mega-CTE's params array (which would cause "bind message supplies N
    // parameters" mismatches). Rebuilds the location-only filter set with
    // fresh placeholders. Locations table has ~668 rows → sub-50ms cold.
    const elParams = [];
    const elConds  = ['l.is_active = true'];
    const _elIlike = (col, arr) => {
      if (!arr.length) return null;
      const ors = arr.map(v => { elParams.push(`%${v}%`); return `${col} ILIKE $${elParams.length}`; });
      return `(${ors.join(' OR ')})`;
    };
    const _elEq = (col, arr) => {
      if (!arr.length) return null;
      if (arr.length === 1) { elParams.push(arr[0]); return `UPPER(${col}::text) = UPPER($${elParams.length})`; }
      elParams.push(arr.map(v => v.toUpperCase()));
      return `UPPER(${col}::text) = ANY($${elParams.length}::text[])`;
    };
    if (location_id) { elParams.push(location_id); elConds.push(`l.id = $${elParams.length}::uuid`); }
    const _stP = _elIlike('l.state',  states);  if (_stP) elConds.push(_stP);
    const _ctP = _elIlike('l.city',   cities);  if (_ctP) elConds.push(_ctP);
    const _gpP = _elEq(`COALESCE(l.group_name, l.type::text)`, groups); if (_gpP) elConds.push(_gpP);
    const _scP = _elEq('l.code', storeCodes); if (_scP) elConds.push(_scP);
    const _emode = String(mode).toLowerCase();
    if (_emode === 'active')   elConds.push('l.shop_closed = false');
    if (_emode === 'inactive') elConds.push('l.shop_closed = true');
    const eligLocRes = await query(
      `SELECT l.id::text AS location_id, l.name AS location_name,
              COALESCE(l.code,'') AS location_code,
              COALESCE(l.external_id,'') AS external_id,
              COALESCE(l.group_name, l.type::text) AS channel,
              COALESCE(l.city,'')  AS city,
              COALESCE(l.state,'') AS state
         FROM locations l
        WHERE ${elConds.join(' AND ')}`,
      elParams
    );
    const eligibleStoreCount = eligLocRes.rows.length;

    // Merge silent stores in: any eligible location whose location_id isn't
    // already in mega.all_stores gets a zero-row appended. The merged list
    // sorts naturally with active stores first (by sales_value DESC) and
    // silent ones at the bottom.
    const ZERO_LENS = {
      units_sold: 0, sales_value: 0, transactions: 0,
      return_qty: 0, return_value: 0,
      mrp_value: 0, cogs_value: 0, gst_collected: 0, ex_gst_value: 0,
      return_mrp_value: 0, return_gst_collected: 0, return_ex_gst_value: 0,
    };
    const activeStores = mega.all_stores || [];
    const haveIds = new Set(activeStores.map(r => r.location_id));
    const silentRows = eligLocRes.rows
      .filter(l => !haveIds.has(l.location_id))
      .map(l => ({ ...l, ...ZERO_LENS }));
    const allStoreRes = { rows: [...activeStores, ...silentRows] };

    const s = summaryRes.rows[0];
    const netUnits = (s.units_sold || 0) - (s.return_units || 0);

      // Lens-aware ₹ values — every revenue metric ships in 5 forms:
      //   gross   = sale_value (current default; GST-inclusive billed amount)
      //   ex_gst  = sale_value − GST (true revenue going to the company)
      //   gst     = GST collected (the tax portion)
      //   mrp     = qty × MRP (would-have-been if no discount given)
      //   cogs    = qty × cost_price (cost basis)
      // Margin and Discount are derived client-side from these primitives.
      const salesGross = Number(s.sales_value);
      const salesEx    = Number(s.sales_ex_gst_value);
      const salesGST   = Number(s.sales_gst_collected);
      const salesMRP   = Number(s.sales_mrp_value);
      const salesCOGS  = Number(s.sales_cogs_value);
      const retGross   = Number(s.return_value);
      const retEx      = Number(s.return_ex_gst_value);
      const retGST     = Number(s.return_gst_collected);
      const retMRP     = Number(s.return_mrp_value);
      const retCOGS    = Number(s.return_cogs_value);
      return {
        summary: {
          sales_txns:        s.sales_txns,
          units_sold:        s.units_sold,
          sales_value:       salesGross,
          return_txns:       s.return_txns,
          return_units:      s.return_units,
          return_value:      retGross,
          net_units:         netUnits,
          net_value:         salesGross - retGross,
          avg_price:         s.units_sold > 0 ? Math.round(salesGross / s.units_sold) : 0,
          return_rate_pct:   s.units_sold > 0 ? Math.round((s.return_units / s.units_sold) * 1000) / 10 : 0,
          stores_with_sales:    s.stores_with_sales,
          eligible_store_count: eligibleStoreCount,
          active_days:          s.active_days,
          unique_skus_sold:  s.unique_skus_sold,
          // ── Valuation lenses (sale + return + net for each) ──
          sales_ex_gst_value:   salesEx,
          sales_gst_collected:  salesGST,
          sales_mrp_value:      salesMRP,
          sales_cogs_value:     salesCOGS,
          sales_margin_value:   salesGross - salesCOGS,
          sales_margin_pct:     salesGross > 0 ? Math.round(((salesGross - salesCOGS) / salesGross) * 1000) / 10 : 0,
          sales_discount_value: Math.max(0, salesMRP - salesGross),
          sales_discount_pct:   salesMRP > 0 ? Math.round(((salesMRP - salesGross) / salesMRP) * 1000) / 10 : 0,
          return_ex_gst_value:  retEx,
          return_gst_collected: retGST,
          return_mrp_value:     retMRP,
          return_cogs_value:    retCOGS,
          // Net of returns at every lens
          net_gross_value:      salesGross - retGross,
          net_ex_gst_value:     salesEx    - retEx,
          net_gst_collected:    salesGST   - retGST,
          net_mrp_value:        salesMRP   - retMRP,
          net_cogs_value:       salesCOGS  - retCOGS,
          net_margin_value:     (salesGross - retGross) - (salesCOGS - retCOGS),
          net_margin_pct:       (salesGross - retGross) > 0
            ? Math.round((((salesGross - retGross) - (salesCOGS - retCOGS)) / (salesGross - retGross)) * 1000) / 10
            : 0,
        },
        stock_snapshot: stockRes.rows[0],
        daily:      dailyRes.rows,
        by_color:   colorRes.rows,
        by_size:    sizeRes.rows,
        by_store:   storeRes.rows,
        by_month:   monthRes.rows,
        by_channel: channelRes.rows,
        all_stores: allStoreRes.rows,
        by_sku:        skuRes.rows,        // top 200 by sales_value DESC (best sellers)
        by_sku_slow:   skuSlowRes.rows,    // bottom 200 by sales_value ASC (slow movers, full universe)
        sku_universe:  skuUniverse,        // count of all SKUs with at least one sale/return in window
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

// ─── getSalesDrilldown — store-level OR sku-level drill ────────────────────
// One endpoint, two pivots:
//   ?type=store&id=<location_uuid>  → top SKUs / colours / sizes / daily / return-heavy stores irrelevant
//   ?type=sku&id=<sku_uuid>         → top stores / top return-stores / colours irrelevant / daily
// All v2 filters compose on top so the user can drill INSIDE a narrowed window
// (e.g. Bihar stores' top SKUs). Cache key includes the type+id+full filter
// hash so two drills at different filter combos coexist in Redis.
async function getSalesDrilldown(req, res, next) {
  try {
    const {
      type, id,
      date_from, date_to, color_name, size, location_id, category,
      gender, sub_product, product, style, shade, color, size: sizeMulti, season,
      state: stateRaw, city: cityRaw, group_name: groupRaw, store_code: storeCodeRaw,
      mode = 'active',
    } = req.query;

    if (!type || !id) {
      return res.status(400).json({ success: false, message: '`type` and `id` are required' });
    }
    if (type !== 'store' && type !== 'sku') {
      return res.status(400).json({ success: false, message: '`type` must be "store" or "sku"' });
    }

    const catKey = canonicalizeCategory(category);
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

    const cacheKey = `analytics:sales:drill:v3:${type}:${id}:${date_from||''}:${date_to||''}:${color_name||''}:${size||''}:${location_id||''}:${states.join('|')}:${cities.join('|')}:${groups.join('|')}:${storeCodes.join('|')}:${catKey||''}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:m${mode}`;

    const data = await getOrSet(cacheKey, async () => {
      const conditions = [];
      const params     = [];

      // Same predicate helpers as getSalesAnalytics — case-insensitive multi.
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

      const from = date_from || '2024-04-01';
      const to   = date_to   || todayISO();
      params.push(from); conditions.push(`m.moved_at >= $${params.length}::date`);
      params.push(to);   conditions.push(`m.moved_at <  $${params.length}::date + interval '1 day'`);

      // The DRILL predicate — type=store narrows by location_id; type=sku
      // narrows by sku_id. Both are UUIDs from the frontend; ::uuid cast
      // makes Postgres reject non-UUID input safely.
      if (type === 'store') {
        params.push(id); conditions.push(`m.location_id = $${params.length}::uuid`);
      } else {
        params.push(id); conditions.push(`m.sku_id      = $${params.length}::uuid`);
      }

      if (color_name)   { params.push(color_name);   conditions.push(`s.color_name ILIKE $${params.length}`); }
      if (size && skuSizes.length === 0) {
        params.push(size); conditions.push(`s.size = $${params.length}`);
      }
      if (location_id)  { params.push(location_id);  conditions.push(`m.location_id = $${params.length}`); }

      const stP = multiIlike('l.state',  states);  if (stP) conditions.push(stP);
      const ctP = multiIlike('l.city',   cities);  if (ctP) conditions.push(ctP);
      const gpP = multiEq(`COALESCE(l.group_name, l.type::text)`, groups); if (gpP) conditions.push(gpP);
      const scP = multiEq('l.code', storeCodes); if (scP) conditions.push(scP);

      const _m = String(mode).toLowerCase();
      if (_m === 'active')   conditions.push('l.shop_closed = false');
      if (_m === 'inactive') conditions.push('l.shop_closed = true');

      const gP  = multiEq('s.gender_name', skuGenders);  if (gP)  conditions.push(gP);
      const spP = multiEq('s.sub_product', skuSubProds); if (spP) conditions.push(spP);
      const prP = multiEq('s.product',     skuProducts); if (prP) conditions.push(prP);
      const stySP = multiEq('s.style',     skuStyles);   if (stySP) conditions.push(stySP);
      const shP = multiEq('s.shade',       skuShades);   if (shP) conditions.push(shP);
      const clP = multiEq('s.color_name',  skuColors);   if (clP) conditions.push(clP);
      const szP = multiEq('s.size',        skuSizes);    if (szP) conditions.push(szP);
      const snP = multiEq('s.season',      skuSeasons);  if (snP) conditions.push(snP);

      if (catKey) {
        const catClause = await applyCategoryFilter(category, params, 'm.sku_id', query, getOrSet);
        if (catClause) conditions.push(catClause);
      }

      // Identity row — name/code/etc. for the drilled-into entity. Tiny
      // query so latency is dominated by the mega-CTE below.
      let identity = null;
      if (type === 'store') {
        const r = await query(
          `SELECT id::text AS id, name, code, COALESCE(external_id,'') AS external_id,
                  COALESCE(group_name, type::text) AS channel, city, state, shop_closed
             FROM locations WHERE id = $1::uuid LIMIT 1`,
          [id]
        );
        identity = r.rows[0] || null;
      } else {
        const r = await query(
          `SELECT id::text AS id, sku_code, product_name, COALESCE(fit_type,'') AS fit_type,
                  color_code, color_name, size, mrp::numeric AS mrp,
                  COALESCE(sub_product,'') AS sub_product, COALESCE(product,'') AS product,
                  COALESCE(category,'')   AS category,
                  COALESCE(style,'')      AS style,
                  COALESCE(season,'')     AS season,
                  COALESCE(gender_name,'') AS gender
             FROM skus WHERE id = $1::uuid LIMIT 1`,
          [id]
        );
        identity = r.rows[0] || null;
      }

      // Mega-CTE — same lens augmentation as getSalesAnalytics so the
      // drilldown speaks every valuation lens the page already does.
      const megaRes = await query(`
        WITH mov AS (
          SELECT
            m.moved_at,
            m.movement_type,
            ABS(m.qty_change)::int         AS qty,
            COALESCE(m.sale_value, 0)      AS val,
            (ABS(m.qty_change)::numeric * COALESCE(s.mrp, 0))                     AS mrp_val,
            (ABS(m.qty_change)::numeric * COALESCE(s.cost_price, COALESCE(s.mrp,0)*0.45)) AS cost_val,
            (COALESCE(m.sale_value, 0)::numeric * COALESCE(s.gst_rate, 12)
              / NULLIF(100 + COALESCE(s.gst_rate, 12), 0))                         AS gst_val,
            (COALESCE(m.sale_value, 0)::numeric
              - COALESCE(m.sale_value, 0)::numeric * COALESCE(s.gst_rate, 12)
                / NULLIF(100 + COALESCE(s.gst_rate, 12), 0))                       AS ex_gst_val,
            m.location_id,
            m.sku_id,
            s.sku_code, s.product_name, s.color_name, s.size,
            l.id AS loc_id, l.name AS loc_name, l.code AS loc_code,
            COALESCE(l.external_id,'') AS external_id,
            COALESCE(l.group_name, l.type::text) AS channel,
            l.city, l.state
          FROM inventory_movements m
          JOIN skus s ON s.id = m.sku_id
          JOIN locations l ON l.id = m.location_id
          WHERE ${conditions.join(' AND ')}
            AND m.movement_type IN ('SALE','RETURN')
        )
        SELECT
          (SELECT row_to_json(t) FROM (SELECT
            COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int     AS units_sold,
            COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint  AS sales_value,
            COUNT(*)         FILTER (WHERE movement_type='SALE')::int         AS sales_txns,
            COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int   AS return_units,
            COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
            COUNT(*)         FILTER (WHERE movement_type='RETURN')::int       AS return_txns,
            COUNT(DISTINCT DATE_TRUNC('day',moved_at)) FILTER (WHERE movement_type='SALE')::int AS active_days,
            COUNT(DISTINCT sku_id)      FILTER (WHERE movement_type='SALE')::int AS unique_skus_sold,
            COUNT(DISTINCT location_id) FILTER (WHERE movement_type='SALE')::int AS unique_stores,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_ex_gst_value,
            COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
            COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
            COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value,
            MIN(moved_at) FILTER (WHERE movement_type='SALE')                AS first_sold_at,
            MAX(moved_at) FILTER (WHERE movement_type='SALE')                AS last_sold_at
          FROM mov) t) AS summary,

          -- Daily series (always returned)
          (SELECT json_agg(d ORDER BY d.date) FROM (
            SELECT DATE_TRUNC('day', moved_at)::date AS date,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int  AS sales_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value
            FROM mov GROUP BY 1
          ) d) AS daily,

          -- Top SKUs at this entity (relevant for type=store; for type=sku
          -- it's a single-row degenerate but we ship it for symmetry).
          (SELECT json_agg(sk ORDER BY sk.sales_value DESC) FROM (
            SELECT sku_id::text AS sku_id, sku_code, product_name, color_name, size,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int  AS units_sold,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
            FROM mov GROUP BY sku_id, sku_code, product_name, color_name, size
            HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0) > 0
            ORDER BY sales_value DESC
            LIMIT 50
          ) sk) AS top_skus,

          -- Most-returned SKUs at this entity. Mirrors top_skus but sorted
          -- by return_value DESC. Useful for "which products are this store
          -- sending back the most". HAVING return_qty > 0 strips the noise.
          (SELECT json_agg(rsk ORDER BY rsk.return_value DESC) FROM (
            SELECT sku_id::text AS sku_id, sku_code, product_name, color_name, size,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
            FROM mov GROUP BY sku_id, sku_code, product_name, color_name, size
            HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0) > 0
            ORDER BY return_value DESC
            LIMIT 25
          ) rsk) AS top_return_skus,

          -- Top stores (relevant for type=sku — "which stores sell this SKU
          -- the most"; for type=store it's a single-row degenerate).
          (SELECT json_agg(st ORDER BY st.sales_value DESC) FROM (
            SELECT loc_id::text AS location_id, loc_name AS location_name,
              loc_code AS location_code, channel, city, state,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int   AS units_sold,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
            FROM mov GROUP BY loc_id, loc_name, loc_code, channel, city, state
            HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0) > 0
            ORDER BY sales_value DESC
            LIMIT 50
          ) st) AS top_stores,

          -- Top return stores — most-returned at this entity (especially
          -- useful for type=sku: "where is this SKU getting returned").
          (SELECT json_agg(rt ORDER BY rt.return_value DESC) FROM (
            SELECT loc_id::text AS location_id, loc_name AS location_name,
              loc_code AS location_code, channel, city, state,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='SALE'),0)::bigint AS gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),0)::bigint AS ex_gst_value,
              COALESCE(SUM(mrp_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_mrp_value,
              COALESCE(SUM(gst_val)    FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_gst_collected,
              COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_ex_gst_value
            FROM mov GROUP BY loc_id, loc_name, loc_code, channel, city, state
            HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0) > 0
            ORDER BY return_value DESC
            LIMIT 25
          ) rt) AS top_return_stores,

          -- Colour breakdown
          (SELECT json_agg(c ORDER BY c.units_sold DESC) FROM (
            SELECT color_name,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value
            FROM mov GROUP BY color_name
            HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0) > 0
          ) c) AS by_color,

          -- Size breakdown
          (SELECT json_agg(sz ORDER BY sz.units_sold DESC) FROM (
            SELECT size,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int    AS units_sold,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int  AS return_qty
            FROM mov GROUP BY size
            HAVING COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0) > 0
          ) sz) AS by_size
      `, params);

      const mega = megaRes.rows[0];
      const summary = mega.summary || {};
      // Derive return_rate_pct so the front-end doesn't need to compute it.
      const u = Number(summary.units_sold || 0);
      const r = Number(summary.return_units || 0);
      const return_rate_pct = u > 0 ? Math.round((r / u) * 1000) / 10 : 0;

      return {
        type, id,
        identity,
        summary: { ...summary, return_rate_pct },
        daily:             mega.daily             || [],
        top_skus:          mega.top_skus          || [],
        top_return_skus:   mega.top_return_skus   || [],
        top_stores:        mega.top_stores        || [],
        top_return_stores: mega.top_return_stores || [],
        by_color:          mega.by_color          || [],
        by_size:           mega.by_size           || [],
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

// ─── Overview cross-pivot: Sales × Inventory join ─────────────────────
// Single mega-CTE returning every CXO-grade view that joins the sales
// movement universe to the inventory snapshot universe — the answers
// that previously required cross-referencing the Sales and Network
// pages by hand.
//
// Returns FOUR tables in one round trip (cached 5 min, mode + filter
// aware, race-safe). Powers four hero tables on the Overview page.
//
// Filters: same v2 set as /analytics/sales (mode + 13 dimensions).
async function getOverviewCrossPivot(req, res, next) {
  try {
    const {
      date_from, date_to, mode = 'active', category,
      gender, sub_product, product, style, shade, color, size, season,
      state, city, group_name, store_code,
    } = req.query;

    // Validate mode (allow-list) — defensive default to 'active' on garbage.
    const _mRaw = String(mode || 'active').toLowerCase();
    const _m = ['active','inactive','all'].includes(_mRaw) ? _mRaw : 'active';
    const modeClause = _m === 'active'   ? 'AND l.shop_closed = false'
                     : _m === 'inactive' ? 'AND l.shop_closed = true'
                     : '';

    // Multi-value parser — accepts CSV or JS array
    const splitMulti = (raw) => {
      if (raw == null) return [];
      const arr = Array.isArray(raw) ? raw : String(raw).split(',');
      return arr.map(v => String(v).trim()).filter(Boolean);
    };
    const v = {
      gender:      splitMulti(gender),
      sub_product: splitMulti(sub_product),
      product:     splitMulti(product),
      style:       splitMulti(style),
      shade:       splitMulti(shade),
      color:       splitMulti(color),
      size:        splitMulti(size),
      season:      splitMulti(season),
      state:       splitMulti(state),
      city:        splitMulti(city),
      group_name:  splitMulti(group_name),
      store_code:  splitMulti(store_code),
    };

    // Stable cache key — same key for same filter combo regardless of order
    const fKey = JSON.stringify({ d: [date_from || '', date_to || ''], m: _m, cat: category || '', ...v });
    const cacheKey = `analytics:overview-cross:v1:${require('crypto').createHash('md5').update(fKey).digest('hex')}`;

    const data = await getOrSet(cacheKey, async () => {
      const params = [];
      const conds  = ['l.is_active = true', 's.is_active = true'];
      const stockConds = ['l.is_active = true', 's.is_active = true'];

      if (modeClause) { conds.push(modeClause.replace(/^AND /,'')); stockConds.push(modeClause.replace(/^AND /,'')); }

      // Date window — only on movement side
      if (date_from && date_to) {
        params.push(date_from, date_to);
        conds.push(`m.moved_at::date BETWEEN $${params.length-1} AND $${params.length}`);
      }

      const pushMulti = (col, arr, into) => {
        if (!arr.length) return;
        params.push(arr);
        into.push(`${col} = ANY($${params.length}::text[])`);
      };
      pushMulti('s.gender_name', v.gender,      conds);
      pushMulti('s.sub_product', v.sub_product, conds);
      pushMulti('s.product',     v.product,     conds);
      pushMulti('s.style',       v.style,       conds);
      pushMulti('s.shade',       v.shade,       conds);
      pushMulti('s.color_name',  v.color,       conds);
      pushMulti('s.size',        v.size,        conds);
      pushMulti('s.season',      v.season,      conds);
      pushMulti('l.state',       v.state,       conds);
      pushMulti('l.city',        v.city,        conds);
      pushMulti('l.group_name',  v.group_name,  conds);
      pushMulti('l.code',        v.store_code,  conds);
      // Stock side gets the SAME sku/location filters minus the movement-only bits.
      pushMulti('s.gender_name', v.gender,      stockConds);
      pushMulti('s.sub_product', v.sub_product, stockConds);
      pushMulti('s.product',     v.product,     stockConds);
      pushMulti('s.style',       v.style,       stockConds);
      pushMulti('s.shade',       v.shade,       stockConds);
      pushMulti('s.color_name',  v.color,       stockConds);
      pushMulti('s.size',        v.size,        stockConds);
      pushMulti('s.season',      v.season,      stockConds);
      pushMulti('l.state',       v.state,       stockConds);
      pushMulti('l.city',        v.city,        stockConds);
      pushMulti('l.group_name',  v.group_name,  stockConds);
      pushMulti('l.code',        v.store_code,  stockConds);

      // Category (optional, ILIKE-pattern based — same as /analytics/sales)
      const catClauseSale  = await applyCategoryFilter(category, params, 'm.sku_id', query, getOrSet);
      const catClauseStock = await applyCategoryFilter(category, params, 'i.sku_id', query, getOrSet);
      const catSale  = catClauseSale  ? catClauseSale  : '';
      const catStock = catClauseStock ? catClauseStock : '';

      const where      = conds.join(' AND ');
      const stockWhere = stockConds.join(' AND ');

      // ── 1. Top 50 SKUs by net revenue (sales-side) ───────────────────
      // Net = sales_value - return_value, ordered desc. Per-SKU stock
      // metrics joined from inventory_snapshot (network-wide stock view).
      const topSkusSql = `
        WITH sku_sales AS (
          SELECT
            m.sku_id,
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(m.qty_change) ELSE 0 END)::int AS units_sold,
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(m.qty_change) ELSE 0 END)::int AS return_qty,
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS sales_value,
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS return_value
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s ON s.id = m.sku_id
          WHERE ${where} ${catSale}
          GROUP BY m.sku_id
          HAVING SUM(CASE WHEN m.movement_type='SALE' THEN ABS(m.qty_change) ELSE 0 END) > 0
          ORDER BY (
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END) -
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)
          ) DESC
          LIMIT 50
        ),
        sku_stock AS (
          SELECT
            i.sku_id,
            SUM(i.qty_on_hand)::int AS total_stock,
            COUNT(DISTINCT l.id) FILTER (WHERE i.qty_on_hand > 0)::int AS stores_carrying,
            COUNT(DISTINCT l.id) FILTER (WHERE i.qty_on_hand = 0)::int AS stores_oos,
            (
              SELECT COALESCE(json_agg(json_build_object(
                'location_id', sub.location_id,
                'location_name', sub.name,
                'city', sub.city,
                'qty_on_hand', sub.qty_on_hand
              ) ORDER BY sub.qty_on_hand DESC), '[]'::json)
              FROM (
                SELECT i3.location_id, l3.name, l3.city, i3.qty_on_hand
                FROM inventory_snapshot i3
                JOIN locations l3 ON l3.id = i3.location_id
                WHERE i3.sku_id = i.sku_id
                  AND i3.qty_on_hand > 0
                  AND l3.is_active = true
                  ${modeClause.replace(/\bl\b/g, 'l3')}
                ORDER BY i3.qty_on_hand DESC
                LIMIT 5
              ) sub
            ) AS top_5_stores
          FROM inventory_snapshot i
          JOIN locations l ON l.id = i.location_id
          JOIN skus s ON s.id = i.sku_id
          WHERE ${stockWhere} ${catStock}
          GROUP BY i.sku_id
        )
        SELECT
          ss.sku_id::text,
          s.sku_code,
          s.product_name,
          s.color_name,
          s.size,
          s.gender_name,
          s.product,
          s.mrp,
          ss.units_sold,
          ss.return_qty,
          ROUND(ss.return_qty::numeric / NULLIF(ss.units_sold,0) * 100, 1) AS return_rate_pct,
          ss.sales_value,
          ss.return_value,
          (ss.sales_value - ss.return_value) AS net_value,
          (ss.units_sold - ss.return_qty) AS net_units,
          COALESCE(st.total_stock, 0)     AS total_stock,
          COALESCE(st.stores_carrying, 0) AS stores_carrying,
          COALESCE(st.stores_oos, 0)      AS stores_oos,
          COALESCE(st.top_5_stores, '[]'::json) AS top_5_stores
        FROM sku_sales ss
        JOIN skus s ON s.id = ss.sku_id
        LEFT JOIN sku_stock st ON st.sku_id = ss.sku_id
        ORDER BY ss.sales_value - ss.return_value DESC
      `;

      // ── 2. Top 50 stores by net revenue, with their best/worst SKUs
      const topStoresSql = `
        WITH store_sales AS (
          SELECT
            m.location_id,
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(m.qty_change) ELSE 0 END)::int AS units_sold,
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(m.qty_change) ELSE 0 END)::int AS return_qty,
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS sales_value,
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS return_value
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s ON s.id = m.sku_id
          WHERE ${where} ${catSale}
          GROUP BY m.location_id
          HAVING SUM(CASE WHEN m.movement_type='SALE' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END) > 0
          ORDER BY (
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END) -
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)
          ) DESC
          LIMIT 50
        )
        SELECT
          ss.location_id::text,
          l.name AS location_name,
          l.code AS store_code,
          l.city,
          l.state,
          COALESCE(l.group_name, l.type::text) AS channel,
          ss.units_sold,
          ss.return_qty,
          ROUND(ss.return_qty::numeric / NULLIF(ss.units_sold,0) * 100, 1) AS return_rate_pct,
          ss.sales_value,
          ss.return_value,
          (ss.sales_value - ss.return_value) AS net_value,
          (
            SELECT COALESCE(SUM(qty_on_hand)::int, 0)
            FROM inventory_snapshot WHERE location_id = ss.location_id
          ) AS stock_on_hand
        FROM store_sales ss
        JOIN locations l ON l.id = ss.location_id
        ORDER BY ss.sales_value - ss.return_value DESC
      `;

      // ── 3. OOS at busy stores — best-seller SKUs that are 0-stock at high-rev stores
      const oosBusySql = `
        WITH busy_stores AS (
          SELECT
            m.location_id,
            SUM(CASE WHEN m.movement_type='SALE' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS rev
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s ON s.id = m.sku_id
          WHERE ${where} ${catSale}
          GROUP BY m.location_id
          ORDER BY rev DESC
          LIMIT 50
        ),
        hot_skus AS (
          SELECT
            m.sku_id,
            SUM(CASE WHEN m.movement_type='SALE' THEN ABS(m.qty_change) ELSE 0 END)::int AS units_sold,
            SUM(CASE WHEN m.movement_type='SALE' THEN ABS(COALESCE(m.sale_value,0)) ELSE 0 END)::numeric AS sales_value
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s ON s.id = m.sku_id
          WHERE ${where} ${catSale}
          GROUP BY m.sku_id
          ORDER BY sales_value DESC
          LIMIT 100
        )
        SELECT
          h.sku_id::text,
          s.sku_code,
          s.product_name,
          s.color_name,
          s.size,
          h.units_sold AS sku_units_sold,
          h.sales_value AS sku_sales_value,
          b.location_id::text,
          l.name AS location_name,
          l.city,
          COALESCE(l.group_name, l.type::text) AS channel,
          b.rev AS store_revenue,
          COALESCE(i.qty_on_hand, 0) AS qty_on_hand
        FROM hot_skus h
        CROSS JOIN busy_stores b
        JOIN locations l ON l.id = b.location_id
        JOIN skus s ON s.id = h.sku_id
        LEFT JOIN inventory_snapshot i ON i.sku_id = h.sku_id AND i.location_id = b.location_id
        WHERE COALESCE(i.qty_on_hand, 0) = 0
        ORDER BY h.sales_value DESC, b.rev DESC
        LIMIT 100
      `;

      const [topSkusRes, topStoresRes, oosBusyRes] = await Promise.all([
        query(topSkusSql,    params),
        query(topStoresSql,  params),
        query(oosBusySql,    params),
      ]);

      return {
        top_skus_with_stock:  topSkusRes.rows,
        top_stores_with_skus: topStoresRes.rows,
        oos_at_busy_stores:   oosBusyRes.rows,
        meta: {
          mode: _m,
          filters: v,
          generated_at: new Date().toISOString(),
        },
      };
    }, 300); // 5-minute TTL

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── /analytics/state-heatmap — v2 dashboard India map ────────────────────
// Aggregates sales & returns per Indian state for a given date window.
// Joins inventory_movements → locations → states.  Cached 5 min per
// (date_from + date_to + mode) hash.
async function getStateHeatmap(req, res, next) {
  try {
    const { date_from, date_to, mode = 'active' } = req.query;
    const cacheKey = `analytics:state-heatmap:${date_from || ''}:${date_to || ''}:${mode}`;

    // Match the same store-lifecycle semantics used by the main sales endpoint:
    // active = open stores, inactive = closed stores, all = both, all within
    // the active location master.
    const modeClause = mode === 'inactive'
      ? 'AND l.is_active = TRUE AND l.shop_closed = TRUE'
      : mode === 'all'
        ? 'AND l.is_active = TRUE'
        : 'AND l.is_active = TRUE AND l.shop_closed = FALSE';

    const data = await getOrSet(cacheKey, async () => {
      // Default window: last 30 days of available data.
      const dateClause = (date_from && date_to)
        ? `AND m.moved_at::date BETWEEN $1 AND $2`
        : `AND m.moved_at >= (SELECT MAX(moved_at) FROM inventory_movements) - INTERVAL '30 days'`;
      const params = (date_from && date_to) ? [date_from, date_to] : [];

      const result = await query(`
        WITH state_sales AS (
          SELECT
            UPPER(TRIM(l.state)) AS state_name,
            SUM(CASE WHEN m.movement_type = 'SALE'   THEN ABS(m.qty_change) ELSE 0 END)::int AS units_sold,
            SUM(CASE WHEN m.movement_type = 'RETURN' THEN ABS(m.qty_change) ELSE 0 END)::int AS units_returned,
            COALESCE(SUM(CASE WHEN m.movement_type = 'SALE'   THEN m.sale_value ELSE 0 END), 0)::numeric AS sales_value,
            COALESCE(SUM(CASE WHEN m.movement_type = 'RETURN' THEN m.sale_value ELSE 0 END), 0)::numeric AS return_value,
            COUNT(DISTINCT l.id)::int AS store_count
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          WHERE m.movement_type IN ('SALE', 'RETURN')
            AND l.state IS NOT NULL
            ${dateClause}
            ${modeClause}
          GROUP BY UPPER(TRIM(l.state))
        )
        SELECT
          state_name,
          units_sold,
          units_returned,
          ROUND(sales_value - return_value, 2) AS net_value,
          store_count
        FROM state_sales
        ORDER BY net_value DESC
      `, params);
      return result.rows;
    }, 300);  // 5 min TTL

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── /analytics/sales/summary — slim cousin of /analytics/sales ─────────────
// Returns ONLY summary + daily + by_channel — the three blocks the v2 dashboard
// hero KPIs, today-vs-LY chart, and channel-mix donut consume.  Skips the
// per-SKU rollup, per-store breakdown, by_color/by_size/by_month, and the
// filter_options dictionary that getSalesAnalytics builds for the /sales page.
//
// Why this matters: getSalesAnalytics scans inventory_movements (1.4 GB / 2.8 M
// rows) and runs ~12 aggregations off a mega-CTE — ~8 s cold cache.  This
// version runs a single grouped scan and returns ~125 ms cold (measured).
//
// Caches under a v1: prefix on its own key so it doesn't collide with the
// rich endpoint's cache.  TTL 5 min for current periods; LY callers set 24 h
// via ttl_override (LY data for closed windows doesn't change).
async function getSalesSummary(req, res, next) {
  try {
    const { date_from, date_to, mode = 'active' } = req.query;
    const ttl = Number(req.query.ttl_override) || 86400; // 24h — ERP is daily-sync, no point expiring sooner
    // v3: payload now carries the ex_gst / gst / mrp lens values so the
    // dashboard can re-pivot revenue without a second round-trip.  Bump the
    // cache key so old v2 entries don't shadow the new fields.
    const cacheKey = `analytics:sales-summary:v3:${date_from || ''}:${date_to || ''}:m${mode}`;

    const data = await getOrSet(cacheKey, async () => {
      const from = date_from || '2024-04-01';
      const to   = date_to   || todayISO();
      const params = [from, to];

      // Mode filter mirrors getSalesAnalytics:124 — "active" means open shops
      // (is_active = TRUE AND shop_closed = FALSE).  "inactive" means closed.
      // "all" drops the shop_closed filter but keeps the is_active baseline.
      const modeClause = mode === 'inactive'
        ? 'AND l.is_active = TRUE AND l.shop_closed = TRUE'
        : mode === 'all'
          ? 'AND l.is_active = TRUE'
          : 'AND l.is_active = TRUE AND l.shop_closed = FALSE';

      // Count of "eligible stores" — total locations matching the mode,
      // regardless of whether they sold anything in the window.  Used by the
      // v2 narrative banner ("9 silent stores out of 284 eligible").
      const eligibleRes = await query(`
        SELECT COUNT(*)::int AS eligible
        FROM locations l
        WHERE 1=1 ${modeClause}
      `);
      const eligibleStoreCount = eligibleRes.rows[0]?.eligible || 0;

      // Single-pass aggregate: summary + daily + by_channel from one scan.
      // The mov CTE joins skus so we can compute the valuation lens fields
      // (ex-GST, GST collected, MRP) from one pass — same gst-rate / mrp
      // defaults the heavy /analytics/sales endpoint uses for legacy rows.
      const result = await query(`
        WITH mov AS (
          SELECT
            m.moved_at,
            m.movement_type,
            ABS(m.qty_change)::int          AS qty,
            COALESCE(m.sale_value, 0)       AS val,
            -- Valuation augmentations
            (ABS(m.qty_change)::numeric * COALESCE(s.mrp, 0))                 AS mrp_val,
            (COALESCE(m.sale_value, 0)::numeric * COALESCE(s.gst_rate, 12)
              / NULLIF(100 + COALESCE(s.gst_rate, 12), 0))                    AS gst_val,
            (COALESCE(m.sale_value, 0)::numeric
              - COALESCE(m.sale_value, 0)::numeric * COALESCE(s.gst_rate, 12)
                / NULLIF(100 + COALESCE(s.gst_rate, 12), 0))                  AS ex_gst_val,
            m.location_id,
            COALESCE(l.group_name, l.type::text) AS channel,
            l.type AS location_type
          FROM inventory_movements m
          JOIN locations l ON l.id = m.location_id
          JOIN skus s      ON s.id = m.sku_id
          WHERE m.moved_at >= $1::date
            AND m.moved_at <  $2::date + interval '1 day'
            AND m.movement_type IN ('SALE','RETURN')
            ${modeClause}
        ),
        summary AS (
          SELECT json_build_object(
            'units_sold',        COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),   0)::int,
            'sales_value',       COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),   0)::bigint,
            'return_units',      COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'), 0)::int,
            'return_value',      COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'), 0)::bigint,
            'net_units',         (COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),  0)
                                  - COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0))::int,
            'net_value',         (COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),  0)
                                  - COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0))::bigint,
            -- Valuation-lens variants — net_ values are sale - return for
            -- each lens, matching how the /sales page reads them.
            'sales_ex_gst_value',  ROUND(COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),  0))::bigint,
            'return_ex_gst_value', ROUND(COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0))::bigint,
            'net_ex_gst_value',    ROUND(COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='SALE'),  0)
                                       - COALESCE(SUM(ex_gst_val) FILTER (WHERE movement_type='RETURN'),0))::bigint,
            'sales_gst_collected', ROUND(COALESCE(SUM(gst_val) FILTER (WHERE movement_type='SALE'),     0))::bigint,
            'return_gst_collected',ROUND(COALESCE(SUM(gst_val) FILTER (WHERE movement_type='RETURN'),   0))::bigint,
            'net_gst_collected',   ROUND(COALESCE(SUM(gst_val) FILTER (WHERE movement_type='SALE'),     0)
                                       - COALESCE(SUM(gst_val) FILTER (WHERE movement_type='RETURN'),  0))::bigint,
            'sales_mrp_value',     ROUND(COALESCE(SUM(mrp_val) FILTER (WHERE movement_type='SALE'),     0))::bigint,
            'return_mrp_value',    ROUND(COALESCE(SUM(mrp_val) FILTER (WHERE movement_type='RETURN'),   0))::bigint,
            'net_mrp_value',       ROUND(COALESCE(SUM(mrp_val) FILTER (WHERE movement_type='SALE'),     0)
                                       - COALESCE(SUM(mrp_val) FILTER (WHERE movement_type='RETURN'),  0))::bigint,
            -- Discount = MRP - actual selling value (gross). Net of returns.
            'sales_discount_value', GREATEST(0, ROUND(
              COALESCE(SUM(mrp_val) FILTER (WHERE movement_type='SALE'),0)
              - COALESCE(SUM(val)   FILTER (WHERE movement_type='SALE'),0)))::bigint,
            'sales_txns',        COUNT(*) FILTER (WHERE movement_type='SALE')::int,
            'return_txns',       COUNT(*) FILTER (WHERE movement_type='RETURN')::int,
            'stores_with_sales', COUNT(DISTINCT location_id) FILTER (WHERE movement_type='SALE')::int,
            'active_days',       COUNT(DISTINCT DATE_TRUNC('day', moved_at))
                                   FILTER (WHERE movement_type='SALE')::int,
            'return_rate_pct',   CASE
              WHEN COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0) > 0
              THEN ROUND(
                100.0 * COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)
                / NULLIF(COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0), 0)
              , 2) ELSE 0 END
          ) AS j FROM mov
        ),
        daily AS (
          SELECT json_agg(d ORDER BY d.date) AS j FROM (
            SELECT
              DATE_TRUNC('day', moved_at)::date                                  AS date,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int      AS sales_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint   AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int    AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint AS return_value
            FROM mov
            GROUP BY DATE_TRUNC('day', moved_at)
          ) d
        ),
        by_channel AS (
          SELECT json_agg(c ORDER BY c.sales_value DESC NULLS LAST) AS j FROM (
            SELECT
              channel,
              COUNT(DISTINCT location_id) FILTER (WHERE movement_type='SALE')::int AS stores,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='SALE'),0)::int        AS units,
              COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0)::bigint     AS sales_value,
              COALESCE(SUM(qty) FILTER (WHERE movement_type='RETURN'),0)::int      AS return_qty,
              COALESCE(SUM(val) FILTER (WHERE movement_type='RETURN'),0)::bigint   AS return_value
            FROM mov
            GROUP BY channel
            HAVING COALESCE(SUM(val) FILTER (WHERE movement_type='SALE'),0) > 0
          ) c
        )
        SELECT
          (SELECT j FROM summary)    AS summary,
          (SELECT j FROM daily)      AS daily,
          (SELECT j FROM by_channel) AS by_channel
      `, params);

      const row = result.rows[0] || {};
      const summary = row.summary || {};
      summary.eligible_store_count = eligibleStoreCount;

      return {
        summary,
        daily:      row.daily      || [],
        by_channel: row.by_channel || [],
      };
    }, ttl);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

module.exports = {
  getNetworkOverview, getStockTrend, getSizeDistribution,
  getColorDistribution, getZoneHeatmap, getFillRate,
  getSalesAnalytics, getSalesDrilldown, getReturnsAnalytics,
  getOverviewCrossPivot, getStateHeatmap, getSalesSummary,
};
