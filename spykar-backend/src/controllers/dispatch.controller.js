const { query, transaction } = require('../config/database');
const { invalidatePattern } = require('../config/cache');
const { AppError } = require('../middleware/errorHandler');

async function list(req, res, next) {
  try {
    const { page = 1, limit = 50, status, from_location_id, to_location_id, date_from, date_to, search, courier } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    const params = [];

    if (status)           { params.push(status);           conditions.push(`d.status = $${params.length}`); }
    if (from_location_id) { params.push(from_location_id); conditions.push(`d.from_location_id = $${params.length}`); }
    if (to_location_id)   { params.push(to_location_id);   conditions.push(`d.to_location_id = $${params.length}`); }
    if (date_from)        { params.push(date_from);         conditions.push(`d.dispatched_at >= $${params.length}`); }
    if (date_to)          { params.push(date_to);           conditions.push(`d.dispatched_at <= $${params.length}::date + interval '1 day'`); }
    if (courier)          { params.push(courier);           conditions.push(`d.courier_name = $${params.length}`); }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(d.dispatch_no) LIKE $${params.length} OR LOWER(d.tracking_no) LIKE $${params.length} OR LOWER(d.courier_name) LIKE $${params.length} OR LOWER(fl.name) LIKE $${params.length} OR LOWER(tl.name) LIKE $${params.length})`);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limitNum, offset);

    const [result, countResult] = await Promise.all([
      query(`
        SELECT
          d.id, d.dispatch_no, d.status,
          COALESCE(li.total_qty, 0)::int AS total_qty,
          COALESCE(li.total_value, 0) AS total_value,
          d.dispatched_at, d.expected_at, d.delivered_at,
          d.courier_name, d.tracking_no,
          fl.name AS from_location, fl.type AS from_type,
          tl.name AS to_location, tl.type AS to_type,
          tl.city AS to_city
        FROM dispatch_orders d
        JOIN locations fl ON fl.id = d.from_location_id
        JOIN locations tl ON tl.id = d.to_location_id
        LEFT JOIN (
          SELECT dli.dispatch_id,
            SUM(COALESCE(dli.qty_dispatched, dli.qty_ordered, 0))::int AS total_qty,
            ROUND(SUM(COALESCE(dli.qty_dispatched, dli.qty_ordered, 0) * COALESCE(s.mrp, 0)), 2) AS total_value
          FROM dispatch_line_items dli
          JOIN skus s ON s.id = dli.sku_id
          GROUP BY dli.dispatch_id
        ) li ON li.dispatch_id = d.id
        ${whereClause}
        ORDER BY d.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      query(`
        SELECT COUNT(*)::int AS total
        FROM dispatch_orders d
        JOIN locations fl ON fl.id = d.from_location_id
        JOIN locations tl ON tl.id = d.to_location_id
        ${whereClause}
      `, params.slice(0, -2)),
    ]);

    const total = countResult.rows[0]?.total || 0;

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) { next(err); }
}

async function getInTransit(req, res, next) {
  try {
    const { getOrSet } = require('../config/cache');
    const data = await getOrSet('dispatch:in-transit', async () => {
      const result = await query(`
        SELECT
          d.dispatch_no, d.dispatched_at, d.expected_at,
          d.courier_name, d.tracking_no,
          COALESCE(li.total_qty, 0)::int AS total_qty,
          fl.name AS from_location, tl.name AS to_location, tl.type AS to_type, tl.city,
          EXTRACT(DAY FROM NOW() - d.dispatched_at)::int AS days_in_transit,
          CASE WHEN d.expected_at < NOW() THEN true ELSE false END AS is_delayed
        FROM dispatch_orders d
        JOIN locations fl ON fl.id = d.from_location_id
        JOIN locations tl ON tl.id = d.to_location_id
        LEFT JOIN (
          SELECT dli.dispatch_id,
            SUM(COALESCE(dli.qty_dispatched, dli.qty_ordered, 0))::int AS total_qty
          FROM dispatch_line_items dli
          GROUP BY dli.dispatch_id
        ) li ON li.dispatch_id = d.id
        WHERE d.status IN ('DISPATCHED', 'IN_TRANSIT')
        ORDER BY d.expected_at ASC
      `);
      return result.rows;
    }, 120); // 2 min — dispatch status changes frequently
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getSummary(req, res, next) {
  try {
    const result = await query(`
      SELECT
        d.status,
        COUNT(*)::int AS count,
        COALESCE(SUM(li.total_qty), 0)::int AS total_qty,
        ROUND(COALESCE(SUM(li.total_value), 0), 2) AS total_value
      FROM dispatch_orders d
      LEFT JOIN (
        SELECT dli.dispatch_id,
          SUM(COALESCE(dli.qty_dispatched, dli.qty_ordered, 0))::int AS total_qty,
          SUM(COALESCE(dli.qty_dispatched, dli.qty_ordered, 0) * COALESCE(s.mrp, 0)) AS total_value
        FROM dispatch_line_items dli
        JOIN skus s ON s.id = dli.sku_id
        GROUP BY dli.dispatch_id
      ) li ON li.dispatch_id = d.id
      GROUP BY d.status
      ORDER BY d.status
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const result = await query(`
      SELECT d.*, fl.name AS from_location_name, tl.name AS to_location_name
      FROM dispatch_orders d
      JOIN locations fl ON fl.id = d.from_location_id
      JOIN locations tl ON tl.id = d.to_location_id
      WHERE d.id = $1
    `, [req.params.id]);
    if (!result.rows.length) throw new AppError('Dispatch not found.', 404);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

async function getLineItems(req, res, next) {
  try {
    const result = await query(`
      SELECT dli.*, s.sku_code, s.product_name, s.color_name, s.size, s.mrp
      FROM dispatch_line_items dli
      JOIN skus s ON s.id = dli.sku_id
      WHERE dli.dispatch_id = $1
      ORDER BY CASE WHEN s.size ~ '^[0-9]+$' THEN s.size::int ELSE 9999 END ASC, s.size ASC
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { from_location_id, to_location_id, items, expected_at, notes } = req.body;

    const result = await transaction(async (client) => {
      const dispatchNo = `DISP-${Date.now()}`;
      const totalQty = items.reduce((s, i) => s + i.qty_ordered, 0);

      const dispatchResult = await client.query(`
        INSERT INTO dispatch_orders (dispatch_no, from_location_id, to_location_id, total_qty, expected_at, notes, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7) RETURNING id
      `, [dispatchNo, from_location_id, to_location_id, totalQty, expected_at, notes, req.user.id]);

      const dispatchId = dispatchResult.rows[0].id;

      for (const item of items) {
        await client.query(`
          INSERT INTO dispatch_line_items (dispatch_id, sku_id, qty_ordered) VALUES ($1,$2,$3)
        `, [dispatchId, item.sku_id, item.qty_ordered]);
      }

      return dispatchResult.rows[0];
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function updateStatus(req, res, next) {
  try {
    const { status, tracking_no, courier_name } = req.body;
    const updates = ['status = $1', 'updated_at = NOW()'];
    const params = [status];

    if (status === 'DISPATCHED') { updates.push(`dispatched_at = NOW()`); }
    if (status === 'DELIVERED')  { updates.push(`delivered_at = NOW()`); }
    if (tracking_no)  { params.push(tracking_no);  updates.push(`tracking_no = $${params.length}`); }
    if (courier_name) { params.push(courier_name); updates.push(`courier_name = $${params.length}`); }

    params.push(req.params.id);
    await query(`UPDATE dispatch_orders SET ${updates.join(',')} WHERE id = $${params.length}`, params);
    await invalidatePattern('inventory:*');

    res.json({ success: true, message: 'Dispatch status updated.' });
  } catch (err) { next(err); }
}

async function getCouriers(req, res, next) {
  try {
    const result = await query(`
      SELECT DISTINCT courier_name
      FROM dispatch_orders
      WHERE courier_name IS NOT NULL
      ORDER BY courier_name
    `);
    res.json({ success: true, data: result.rows.map(r => r.courier_name) });
  } catch (err) { next(err); }
}

module.exports = { list, getInTransit, getSummary, getById, getLineItems, create, updateStatus, getCouriers };
