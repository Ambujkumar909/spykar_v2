const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');
const { AppError } = require('../middleware/errorHandler');

async function list(req, res, next) {
  try {
    const { page = 1, limit = 50, state, city, search, sort_by = 'total_stock', sort_order = 'DESC' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offset = (pageNum - 1) * limitNum;
    const conditions = ["l.is_active = true", "l.type != 'WAREHOUSE'", "NULLIF(TRIM(l.group_name), '') IS NOT NULL"];
    const params = [];

    if (state)  { params.push(`%${state}%`);  conditions.push(`l.state ILIKE $${params.length}`); }
    if (city)   { params.push(`%${city}%`);   conditions.push(`l.city ILIKE $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(l.name ILIKE $${params.length} OR l.code ILIKE $${params.length} OR l.city ILIKE $${params.length} OR l.state ILIKE $${params.length})`); }

    const allowedSorts = {
      total_stock: 'SUM(i.qty_on_hand)',
      stock_value: 'SUM(i.qty_on_hand * s.mrp)',
      name: 'l.name',
      sku_count: 'COUNT(DISTINCT i.sku_id)',
    };
    const orderBy = `${allowedSorts[sort_by] || allowedSorts.total_stock} ${sort_order === 'ASC' ? 'ASC' : 'DESC'}`;
    params.push(limitNum, offset);

    const cacheKey = `distributors:list:${state||'all'}:${city||'all'}:${search||''}:${sort_by}:${sort_order}:p${pageNum}:l${limitNum}`;
    const data = await getOrSet(cacheKey, async () => {
      const baseFrom = `
        FROM locations l
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id
        LEFT JOIN skus s ON s.id = i.sku_id
        WHERE ${conditions.join(' AND ')}
      `;

      const [rowsResult, countResult, totalsResult] = await Promise.all([
        query(`
          SELECT
            l.id, l.code, l.name, l.group_name, l.city, l.state, l.pincode,
            l.contact_name, l.contact_phone,
            COALESCE(SUM(i.qty_on_hand), 0)::int           AS total_stock,
            COALESCE(SUM(i.qty_available), 0)::int         AS available_stock,
            COALESCE(SUM(i.qty_in_transit), 0)::int        AS in_transit,
            ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS stock_value,
            COUNT(DISTINCT i.sku_id)::int                  AS sku_count,
            COUNT(*) FILTER (WHERE i.qty_on_hand = 0)::int AS low_stock_alerts,
            MAX(i.updated_at) AS last_updated
            ${baseFrom}
          GROUP BY l.id, l.code, l.name, l.group_name, l.city, l.state, l.pincode, l.contact_name, l.contact_phone
          ORDER BY ${orderBy}
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params),
        query(`
          SELECT COUNT(*)::int AS total
          FROM locations l
          WHERE ${conditions.filter((condition) => !condition.includes('s.')).join(' AND ')}
        `, params.slice(0, params.length - 2)),
        query(`
          SELECT
            COUNT(DISTINCT l.id)::int AS total_distributors,
            COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
            COALESCE(SUM(i.qty_available), 0)::int AS total_available,
            COALESCE(SUM(i.qty_in_transit), 0)::int AS total_in_transit,
            ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS total_stock_value
            ${baseFrom}
        `, params.slice(0, params.length - 2)),
      ]);

      return {
        rows: rowsResult.rows,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: countResult.rows[0]?.total || 0,
          totalPages: Math.max(1, Math.ceil((countResult.rows[0]?.total || 0) / limitNum)),
        },
        summary: totalsResult.rows[0] || {
          total_distributors: 0,
          total_stock: 0,
          total_available: 0,
          total_in_transit: 0,
          total_stock_value: 0,
        },
      };
    }, TTL.DISTRIBUTOR_LIST);

    res.json({ success: true, data: data.rows, pagination: data.pagination, summary: data.summary });
  } catch (err) {
    next(err);
  }
}

async function getTop(req, res, next) {
  try {
    const { n = 10, size, color_code, metric = 'qty_on_hand' } = req.query;
    const cacheKey = `distributors:top:${n}:${size||'all'}:${color_code||'all'}:${metric}`;

    const data = await getOrSet(cacheKey, async () => {
      const conditions = ['l.is_active = true', "l.type != 'WAREHOUSE'", "NULLIF(TRIM(l.group_name), '') IS NOT NULL", 's.is_active = true'];
      const params = [];

      if (size)       { params.push(size);       conditions.push(`s.size = $${params.length}`); }
      if (color_code) { params.push(color_code); conditions.push(`s.color_code = $${params.length}`); }

      const metricCol = metric === 'stock_value' ? 'SUM(i.qty_on_hand * s.mrp)' :
                        metric === 'qty_available' ? 'SUM(i.qty_available)' : 'SUM(i.qty_on_hand)';
      params.push(n);

      const result = await query(`
        SELECT
          l.id, l.code, l.name, l.group_name, l.city, l.state,
          ${metricCol}::int AS metric_value,
          SUM(i.qty_on_hand)::int AS total_stock,
          ROUND(SUM(i.qty_on_hand * s.mrp), 2) AS stock_value,
          COUNT(DISTINCT i.sku_id)::int AS sku_count
        FROM inventory_snapshot i
        JOIN locations l ON l.id = i.location_id
        JOIN skus s ON s.id = i.sku_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY l.id, l.code, l.name, l.group_name, l.city, l.state
        ORDER BY metric_value DESC
        LIMIT $${params.length}
      `, params);

      return { filters: { size, color_code, metric, n }, distributors: result.rows };
    }, TTL.DISTRIBUTOR_LIST);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function compare(req, res, next) {
  try {
    const ids = req.query.ids.split(',').slice(0, 5); // max 5 at a time
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');

    const result = await query(`
      SELECT
        l.id, l.name, l.code, l.city, l.state, z.name AS zone,
        COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
        ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS stock_value,
        COUNT(DISTINCT i.sku_id)::int AS sku_count,
        json_agg(DISTINCT jsonb_build_object('size', s.size, 'qty', i.qty_on_hand)) AS size_breakdown
      FROM locations l
      LEFT JOIN inventory_snapshot i ON i.location_id = l.id
      LEFT JOIN skus s ON s.id = i.sku_id
      LEFT JOIN zones z ON z.id = l.zone_id
      WHERE l.id IN (${placeholders}) AND l.is_active = true AND l.type != 'WAREHOUSE' AND NULLIF(TRIM(l.group_name), '') IS NOT NULL
      GROUP BY l.id, l.name, l.code, l.city, l.state, z.name
    `, ids);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const result = await query(`
      SELECT l.id, l.code, l.name, l.type, l.group_name, l.city, l.state, l.pincode,
             l.contact_name, l.contact_phone, l.contact_email, l.gstin, l.external_id, l.is_active,
        COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
        ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS stock_value,
        COUNT(DISTINCT i.sku_id)::int AS sku_count
      FROM locations l
      LEFT JOIN inventory_snapshot i ON i.location_id = l.id
      LEFT JOIN skus s ON s.id = i.sku_id
      WHERE l.id = $1 AND l.is_active = true AND l.type != 'WAREHOUSE' AND NULLIF(TRIM(l.group_name), '') IS NOT NULL
      GROUP BY l.id
    `, [req.params.id]);

    if (!result.rows.length) throw new AppError('Distributor not found.', 404);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function getInventory(req, res, next) {
  try {
    const { id } = req.params;
    const { size, color_code, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['i.location_id = $1', 's.is_active = true'];
    const params = [id];

    if (size)       { params.push(size);       conditions.push(`s.size = $${params.length}`); }
    if (color_code) { params.push(color_code); conditions.push(`s.color_code = $${params.length}`); }
    params.push(limit, offset);

    const result = await query(`
      SELECT s.sku_code, s.product_name, s.color_code, s.color_name, s.size, s.mrp,
             i.qty_on_hand, i.qty_available, i.qty_reserved, i.qty_in_transit, i.safety_stock,
             ROUND(i.qty_on_hand * s.mrp, 2) AS stock_value,
             CASE WHEN i.qty_on_hand = 0 THEN true ELSE false END AS is_below_safety
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END ASC, s.size ASC, s.color_name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

async function getMovements(req, res, next) {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const result = await query(`
      SELECT m.movement_type, m.qty_change, m.qty_before, m.qty_after, m.moved_at, m.notes,
             s.sku_code, s.color_name, s.size
      FROM inventory_movements m
      JOIN skus s ON s.id = m.sku_id
      WHERE m.location_id = $1
      ORDER BY m.moved_at DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

async function getAgeing(req, res, next) {
  try {
    const result = await query(`
      SELECT s.sku_code, s.color_name, s.size,
             a.qty_0_30, a.qty_31_60, a.qty_61_90, a.qty_91_180, a.qty_180_plus
      FROM stock_ageing a
      JOIN skus s ON s.id = a.sku_id
      WHERE a.location_id = $1 AND a.ageing_date = (SELECT MAX(ageing_date) FROM stock_ageing)
      ORDER BY a.qty_180_plus DESC
    `, [req.params.id]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getTop, compare, getById, getInventory, getMovements, getAgeing };
