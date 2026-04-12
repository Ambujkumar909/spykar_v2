// location.controller.js
const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/redis');
const { AppError } = require('../middleware/errorHandler');

async function list(req, res, next) {
  try {
    const { page = 1, limit = 50, type, city, state, search, group_name, sort_by } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offset = (pageNum - 1) * limitNum;
    const baseConditions = [
      "l.is_active = true",
      "l.type != 'WAREHOUSE'",
      "NULLIF(TRIM(l.group_name), '') IS NOT NULL",
    ];
    const conditions = [...baseConditions];
    const params = [];

    if (type)   { params.push(type);         conditions.push(`l.type = $${params.length}`); }
    if (city)   { params.push(`%${city}%`);  conditions.push(`l.city ILIKE $${params.length}`); }
    if (state)  { params.push(`%${state}%`); conditions.push(`l.state ILIKE $${params.length}`); }
    if (group_name) { params.push(group_name); conditions.push(`COALESCE(l.group_name, l.type::text) = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(l.name ILIKE $${params.length} OR l.code ILIKE $${params.length} OR l.city ILIKE $${params.length} OR l.state ILIKE $${params.length})`); }
    params.push(limitNum, offset);

    const baseFilterParams = params.slice(0, params.length - 2);
    const optionConditions = [...baseConditions];
    const optionParams = [];

    if (type) { optionParams.push(type); optionConditions.push(`l.type = $${optionParams.length}`); }
    if (group_name) { optionParams.push(group_name); optionConditions.push(`COALESCE(l.group_name, l.type::text) = $${optionParams.length}`); }
    if (search) { optionParams.push(`%${search}%`); optionConditions.push(`(l.name ILIKE $${optionParams.length} OR l.code ILIKE $${optionParams.length} OR l.city ILIKE $${optionParams.length} OR l.state ILIKE $${optionParams.length})`); }

    const cityOptionConditions = [...optionConditions];
    const cityOptionParams = [...optionParams];
    if (state) { cityOptionParams.push(`%${state}%`); cityOptionConditions.push(`l.state ILIKE $${cityOptionParams.length}`); }

    const cacheKey = `locations:list:${type||'all'}:${city||'all'}:${state||'all'}:${group_name||'all'}:${search||''}:p${pageNum}:l${limitNum}:s${sort_by||'default'}`;
    const data = await getOrSet(cacheKey, async () => {
      const baseFrom = `
        FROM locations l
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id
        WHERE ${conditions.join(' AND ')}
      `;

      const [rowsResult, countResult, summaryResult, groupsResult, statesResult, citiesResult] = await Promise.all([
        query(`
          SELECT l.id, l.code, l.name, l.type, l.group_name, l.city, l.state, l.pincode,
                 l.contact_name, l.contact_phone, l.is_active,
                 COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
                 CASE
                   WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
                   WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
                   WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
                   WHEN COALESCE(l.group_name,'') ILIKE '%- rt'       THEN 'OUTRIGHT'
                   ELSE 'SOR'
                 END AS billing_model
          ${baseFrom}
          GROUP BY l.id
          ORDER BY ${sort_by === 'total_stock' ? 'COALESCE(SUM(i.qty_on_hand),0) DESC NULLS LAST, l.name' : 'COALESCE(l.group_name, l.type::text), l.name'}
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params),
        query(`
          SELECT COUNT(*)::int AS total
          FROM locations l
          WHERE ${conditions.join(' AND ')}
        `, baseFilterParams),
        query(`
          SELECT
            COUNT(DISTINCT l.id)::int AS total_locations,
            COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock
          ${baseFrom}
        `, baseFilterParams),
        query(`
          SELECT
            COALESCE(l.group_name, l.type::text) AS group_name,
            COUNT(DISTINCT l.id)::int AS count,
            COALESCE(SUM(i.qty_on_hand), 0)::int AS stock,
            CASE
              WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
              WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
              WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
              WHEN COALESCE(l.group_name,'') ILIKE '%- rt'       THEN 'OUTRIGHT'
              ELSE 'SOR'
            END AS billing_model
          ${baseFrom}
          GROUP BY COALESCE(l.group_name, l.type::text),
            CASE
              WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
              WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
              WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
              WHEN COALESCE(l.group_name,'') ILIKE '%- rt'       THEN 'OUTRIGHT'
              ELSE 'SOR'
            END
          ORDER BY COALESCE(l.group_name, l.type::text)
        `, baseFilterParams),
        query(`
          SELECT DISTINCT l.state
          FROM locations l
          WHERE ${optionConditions.join(' AND ')} AND COALESCE(NULLIF(TRIM(l.state), ''), '') <> ''
          ORDER BY l.state
        `, optionParams),
        query(`
          SELECT DISTINCT l.city
          FROM locations l
          WHERE ${cityOptionConditions.join(' AND ')} AND COALESCE(NULLIF(TRIM(l.city), ''), '') <> ''
          ORDER BY l.city
        `, cityOptionParams),
      ]);

      return {
        rows: rowsResult.rows,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: countResult.rows[0]?.total || 0,
          totalPages: Math.max(1, Math.ceil((countResult.rows[0]?.total || 0) / limitNum)),
        },
        summary: summaryResult.rows[0] || { total_locations: 0, total_stock: 0 },
        groups: groupsResult.rows,
        states: statesResult.rows.map((row) => row.state).filter(Boolean),
        cities: citiesResult.rows.map((row) => row.city).filter(Boolean),
      };
    }, TTL.LOCATION_MASTER);

    res.json({
      success: true,
      data: data.rows,
      pagination: data.pagination,
      summary: data.summary,
      groups: data.groups,
      states: data.states,
      cities: data.cities,
    });
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const result = await query(
      'SELECT l.id, l.code, l.name, l.type, l.group_name, l.city, l.state, l.pincode, l.contact_name, l.contact_phone, l.contact_email, l.gstin, l.external_id, l.is_active FROM locations l WHERE l.id = $1',
      [req.params.id]
    );
    if (!result.rows.length) throw new AppError('Location not found.', 404);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

async function getSummary(req, res, next) {
  try {
    const result = await query(`
      SELECT
        COALESCE(SUM(i.qty_on_hand), 0)::int AS total_stock,
        COALESCE(SUM(i.qty_available), 0)::int AS available,
        COALESCE(SUM(i.qty_in_transit), 0)::int AS in_transit,
        ROUND(COALESCE(SUM(i.qty_on_hand * s.mrp), 0), 2) AS stock_value,
        COUNT(DISTINCT i.sku_id)::int AS sku_count,
        COUNT(*) FILTER (WHERE i.qty_on_hand = 0)::int AS alerts
      FROM inventory_snapshot i
      JOIN skus s ON s.id = i.sku_id
      WHERE i.location_id = $1
    `, [req.params.id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { code, name, type, zone_id, city, state, pincode, contact_name, contact_phone, contact_email, gstin } = req.body;
    const result = await query(`
      INSERT INTO locations (code, name, type, zone_id, city, state, pincode, contact_name, contact_phone, contact_email, gstin)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [code, name, type, zone_id, city, state, pincode, contact_name, contact_phone, contact_email, gstin]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const fields = ['name','city','state','pincode','contact_name','contact_phone','is_active'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
    });
    if (!updates.length) return res.json({ success: true, message: 'No fields to update.' });
    params.push(req.params.id);
    const result = await query(`UPDATE locations SET ${updates.join(',')} WHERE id = $${params.length} RETURNING *`, params);
    if (!result.rows.length) throw new AppError('Location not found.', 404);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

async function listZones(req, res, next) {
  try {
    const result = await query(
      'SELECT id, code, name FROM zones WHERE is_active = true ORDER BY id'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

module.exports = { list, getById, getSummary, create, update, listZones };
