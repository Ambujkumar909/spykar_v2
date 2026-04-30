const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/redis');
const { AppError } = require('../middleware/errorHandler');
const { canonicalizeCategory, applyCategoryFilter } = require('../utils/categoryFilter');

async function list(req, res, next) {
  try {
    const { page = 1, limit = 50, search, size, color_code, fit_type } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['is_active = true'];
    const params = [];

    if (search)    { params.push(`%${search}%`); conditions.push(`(sku_code ILIKE $${params.length} OR product_name ILIKE $${params.length})`); }
    if (size)      { params.push(size);      conditions.push(`size = $${params.length}`); }
    if (color_code){ params.push(color_code);conditions.push(`color_code = $${params.length}`); }
    if (fit_type)  { params.push(fit_type);  conditions.push(`fit_type = $${params.length}`); }
    params.push(limit, offset);

    const result = await query(`
      SELECT id, sku_code, product_name, color_code, color_name, size, fit_type, mrp, barcode
      FROM skus WHERE ${conditions.join(' AND ')}
      ORDER BY CASE WHEN size ~ '^[0-9]+$' THEN size::int ELSE 9999 END ASC, size ASC, color_name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

async function getSizeColorMatrix(req, res, next) {
  try {
    const { location_id, location_type, zone_id } = req.query;
    const cacheKey = `skus:matrix:${location_id||''}:${location_type||''}:${zone_id||''}`;

    const data = await getOrSet(cacheKey, async () => {
      const conditions = ['l.is_active = true', 's.is_active = true'];
      const params = [];

      if (location_id)   { params.push(location_id);   conditions.push(`l.id = $${params.length}`); }
      if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }
      if (zone_id)       { params.push(zone_id);       conditions.push(`l.zone_id = $${params.length}`); }

      const result = await query(`
        SELECT
          s.size,
          s.color_code,
          s.color_name,
          SUM(i.qty_on_hand)::int AS total_stock,
          SUM(i.qty_available)::int AS available,
          COUNT(DISTINCT i.location_id)::int AS location_count
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY s.size, s.color_code, s.color_name
        ORDER BY CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END ASC, s.size ASC, s.color_name ASC
      `, params);
      return result.rows;
    }, TTL.SKU_ANALYTICS);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getSizes(req, res, next) {
  try {
    const { location_type, zone_id } = req.query;
    const conditions = ['s.is_active = true', 'l.is_active = true'];
    const params = [];

    if (location_type) {
      params.push(location_type);
      conditions.push(`l.type = $${params.length}`);
    }
    if (zone_id) {
      params.push(zone_id);
      conditions.push(`l.zone_id = $${params.length}`);
    }

    const result = await query(`
      SELECT s.size, SUM(i.qty_on_hand)::int AS total_stock
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      JOIN locations l ON l.id = i.location_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY s.size
      ORDER BY CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END ASC, s.size ASC
    `, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

async function getColors(req, res, next) {
  try {
    const { location_type, zone_id } = req.query;
    const conditions = ['s.is_active = true', 'l.is_active = true'];
    const params = [];

    if (location_type) {
      params.push(location_type);
      conditions.push(`l.type = $${params.length}`);
    }
    if (zone_id) {
      params.push(zone_id);
      conditions.push(`l.zone_id = $${params.length}`);
    }

    const result = await query(`
      SELECT
        s.color_code,
        s.color_name,
        SUM(i.qty_on_hand)::int AS total_stock,
        COUNT(DISTINCT i.location_id)::int AS location_count,
        ROUND(SUM(i.qty_on_hand) * 100.0 / NULLIF(SUM(SUM(i.qty_on_hand)) OVER (), 0), 1) AS pct_of_total
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      JOIN locations l ON l.id = i.location_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY s.color_code, s.color_name
      ORDER BY total_stock DESC
    `, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

async function getTopMoving(req, res, next) {
  try {
    const { n = 10, days = 30, location_type, date_from, date_to, state, city, category } = req.query;
    const catKey = canonicalizeCategory(category);
    const cacheKey = `skus:top-moving:v3:${n}:${days}:${location_type||'all'}:${date_from||''}:${date_to||''}:${state||''}:${city||''}:${catKey||''}`;
    const data = await getOrSet(cacheKey, async () => {
      const conditions = ['l.is_active = true', "m.movement_type = 'SALE'"];
      const params = [];
      if (date_from && date_to) {
        params.push(date_from); params.push(date_to);
        conditions.push(`m.moved_at >= $${params.length - 1}::date AND m.moved_at < ($${params.length}::date + INTERVAL '1 day')`);
      } else {
        params.push(days);
        conditions.push(`m.moved_at >= (SELECT COALESCE(MAX(moved_at), NOW()) FROM inventory_movements WHERE movement_type = 'SALE') - ($${params.length} || ' days')::interval`);
      }
      if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }
      if (state) { params.push(state); conditions.push(`l.state ILIKE $${params.length}`); }
      if (city)  { params.push(city);  conditions.push(`l.city  ILIKE $${params.length}`); }
      // Fast path: pre-resolved sku_id[] seek against inventory_movements(sku_id)
      const catClause = await applyCategoryFilter(category, params, 'm.sku_id', query, getOrSet);
      if (catClause) conditions.push(catClause);
      params.push(n);
      const result = await query(`
        SELECT s.sku_code, s.product_name, s.color_name, s.size,
               SUM(ABS(m.qty_change))::int AS total_sold,
               COUNT(DISTINCT m.location_id)::int AS locations_sold_from
        FROM inventory_movements m
        JOIN locations l ON l.id = m.location_id
        JOIN skus s ON s.id = m.sku_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY s.sku_code, s.product_name, s.color_name, s.size
        ORDER BY total_sold DESC
        LIMIT $${params.length}
      `, params);
      return result.rows;
    }, TTL.SKU_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getSlowMoving(req, res, next) {
  try {
    const { days = 90, location_type, state, city, category } = req.query;
    const catKey = canonicalizeCategory(category);

    const cacheKey = `skus:slow-moving:v3:${days}:${location_type||'all'}:${state||''}:${city||''}:${catKey||''}`;
    const data = await getOrSet(cacheKey, async () => {
    // Build params/filters lazily on cache miss so cache hits pay no work
    const params = [parseInt(days)];
    const extraFilters = [];
    if (location_type) { params.push(location_type); extraFilters.push(`AND l.type = $${params.length}`); }
    if (state) { params.push(state); extraFilters.push(`AND l.state ILIKE $${params.length}`); }
    if (city)  { params.push(city);  extraFilters.push(`AND l.city  ILIKE $${params.length}`); }
    // Fast path: pre-resolved sku_id[] seek against inventory_snapshot(sku_id)
    const catClause = await applyCategoryFilter(category, params, 'i.sku_id', query, getOrSet);
    if (catClause) extraFilters.push(`AND ${catClause}`);

    const result = await query(`
      WITH ref AS (
        SELECT COALESCE(MAX(moved_at), CURRENT_TIMESTAMP) AS ref_date
        FROM   inventory_movements
        WHERE  movement_type = 'SALE'
      ),
      last_sale AS (
        SELECT location_id, sku_id, MAX(moved_at) AS last_sold_at
        FROM   inventory_movements
        WHERE  movement_type = 'SALE'
        GROUP BY location_id, sku_id
      )
      SELECT
        l.name                                              AS location_name,
        COALESCE(l.group_name, l.type::text)               AS location_type,
        s.sku_code,
        s.product_name,
        s.color_name,
        s.size,
        i.qty_on_hand,
        LEAST(
          COALESCE(
            EXTRACT(DAY FROM (ref.ref_date - ls.last_sold_at))::int,
            731
          ),
          731
        )                                                   AS days_no_movement,
        CASE
          WHEN ls.last_sold_at IS NULL                                    THEN 'NEVER_SOLD'
          WHEN ls.last_sold_at < ref.ref_date - INTERVAL '180 days'      THEN 'DEAD'
          WHEN ls.last_sold_at < ref.ref_date - INTERVAL '90 days'       THEN 'AT_RISK'
          ELSE                                                                 'SLOW'
        END                                                 AS stock_status,
        i.qty_on_hand * LEAST(
          COALESCE(
            EXTRACT(DAY FROM (ref.ref_date - ls.last_sold_at))::int,
            731
          ),
          731
        )                                                   AS risk_score
      FROM  inventory_snapshot i
      CROSS JOIN ref
      JOIN  locations l  ON l.id  = i.location_id
      JOIN  skus s       ON s.id  = i.sku_id
      LEFT  JOIN last_sale ls ON ls.location_id = i.location_id
                              AND ls.sku_id      = i.sku_id
      WHERE l.is_active   = true
        AND s.is_active   = true
        AND i.qty_on_hand >= 3
        AND (
          ls.last_sold_at IS NULL
          OR ls.last_sold_at < ref.ref_date - ($1::int || ' days')::interval
        )
        ${extraFilters.join('\n        ')}
      ORDER BY risk_score DESC, i.qty_on_hand DESC
      LIMIT 200
    `, params);

      return result.rows;
    }, TTL.SKU_ANALYTICS);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const result = await query('SELECT * FROM skus WHERE id = $1', [req.params.id]);
    if (!result.rows.length) throw new AppError('SKU not found.', 404);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

async function getInventoryByLocation(req, res, next) {
  try {
    const { id } = req.params;
    const { location_type } = req.query;
    const conditions = ['i.sku_id = $1', 'l.is_active = true'];
    const params = [id];

    if (location_type) { params.push(location_type); conditions.push(`l.type = $${params.length}`); }

    const result = await query(`
      SELECT l.id, l.code, l.name, l.type, l.city, l.state,
             i.qty_on_hand, i.qty_available, i.qty_in_transit, i.safety_stock
      FROM inventory_snapshot i
      JOIN locations l ON l.id = i.location_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY i.qty_on_hand DESC
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

module.exports = { list, getSizeColorMatrix, getSizes, getColors, getTopMoving, getSlowMoving, getById, getInventoryByLocation };
