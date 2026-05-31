// location.controller.js
const { query } = require('../config/database');
const { getOrSet, TTL } = require('../config/cache');
const { AppError } = require('../middleware/errorHandler');
const { canonicalizeCategory, applyCategoryFilter } = require('../utils/categoryFilter');

// Multi-value parser — accepts CSV strings or arrays, trims whitespace.
// Used to extend the controller from single-value (legacy) to multi-select v2.
function multi(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(','))
    .map(s => String(s).trim())
    .filter(Boolean);
}
// Multi-value ILIKE predicate (for free-text columns like state/city).
// ILIKE is already case-insensitive on Postgres.
function multiIlike(col, arr, params) {
  if (!arr.length) return null;
  const ors = arr.map(v => { params.push(`%${v}%`); return `${col} ILIKE $${params.length}`; });
  return `(${ors.join(' OR ')})`;
}
// Multi-value EQUALITY predicate, case-insensitive via UPPER(both-sides).
// 'denim'/'DENIM'/'Denim' all match the same row. Exact equality (modulo
// case) — does NOT match substrings, so the dependency-narrowing contract
// holds (picking 'JEAN' won't match 'JEANS-V2').
function multiEq(col, arr, params) {
  if (!arr.length) return null;
  if (arr.length === 1) {
    params.push(arr[0]);
    return `UPPER(${col}::text) = UPPER($${params.length})`;
  }
  params.push(arr.map(v => v.toUpperCase()));
  return `UPPER(${col}::text) = ANY($${params.length}::text[])`;
}

async function list(req, res, next) {
  try {
    const {
      page = 1, limit = 50, type, search, sort_by, category,
      // v1 single-value (still supported for legacy callers)
      city: cityRaw, state: stateRaw, group_name: groupRaw,
      // v2 multi-select (CSV) extensions wired by the universal FilterBar
      gender, sub_product, product, style, shade, color, size, season, store_code, mode = 'active',
    } = req.query;

    // Normalize legacy single-value filters into arrays so we can use a
    // unified multi-select predicate path.
    const cities      = multi(cityRaw);
    const states      = multi(stateRaw);
    const groupNames  = multi(groupRaw);
    const storeCodes  = multi(store_code);
    const skuGenders  = multi(gender);
    const skuSubProds = multi(sub_product);
    const skuProducts = multi(product);
    const skuStyles   = multi(style);
    const skuShades   = multi(shade);
    const skuColors   = multi(color);
    const skuSizes    = multi(size);
    const skuSeasons  = multi(season);

    const catKey = canonicalizeCategory(category);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offset = (pageNum - 1) * limitNum;
    const baseConditions = [
      "l.is_active = true",
      "l.type != 'WAREHOUSE'",
      "NULLIF(TRIM(l.group_name), '') IS NOT NULL",
    ];
    // 3-mode lens: 'active' (default, shop_closed=false), 'inactive'
    // (shop_closed=true), 'all' (no filter). Drives table results.
    const m = String(mode).toLowerCase();
    if (m === 'active')   baseConditions.push('l.shop_closed = false');
    if (m === 'inactive') baseConditions.push('l.shop_closed = true');

    const conditions = [...baseConditions];
    const params = [];

    if (type) { params.push(type); conditions.push(`l.type = $${params.length}`); }
    // v2 multi-select predicates
    const cityPred  = multiIlike('l.city',  cities, params); if (cityPred)  conditions.push(cityPred);
    const statePred = multiIlike('l.state', states, params); if (statePred) conditions.push(statePred);
    const groupPred = multiEq(`COALESCE(l.group_name, l.type::text)`, groupNames, params); if (groupPred) conditions.push(groupPred);
    const codePred  = multiEq('l.code', storeCodes, params); if (codePred)  conditions.push(codePred);
    if (search) { params.push(`%${search}%`); conditions.push(`(l.name ILIKE $${params.length} OR l.code ILIKE $${params.length} OR l.city ILIKE $${params.length} OR l.state ILIKE $${params.length})`); }

    // Snapshot location-only filter params BEFORE appending category UUID[]
    // and SKU-side joins. Queries that don't touch inventory_snapshot
    // (countResult, statesResult, citiesResult) reference exactly these
    // positions, and PG rejects binds that carry extra unreferenced params.
    const locFilterParams = [...params];

    // Category filter — applied in the LEFT JOIN ON clause (not WHERE) so
    // locations without any matching-category SKUs still appear in the list
    // with total_stock = 0 instead of being dropped.
    let catJoinClause = '';
    if (catKey) {
      const frag = await applyCategoryFilter(category, params, 'i.sku_id', query, getOrSet);
      if (frag === 'FALSE')  catJoinClause = ' AND FALSE';
      else if (frag)         catJoinClause = ` AND ${frag}`;
    }

    // ── v2 SKU-side filters → pre-resolve to sku_id[] ─────────────────────
    // Same fast-path as applyCategoryFilter: resolve once via a small SELECT
    // on the indexed SKU columns, cache the resulting UUID list in Redis
    // (5 min — this combo of dimensions changes far less than per-request),
    // then add `i.sku_id = ANY($::uuid[])` to the inventory_snapshot ON
    // clause. Avoids joining the 307K-row skus table on every page render.
    let skuJoinClause = '';
    const hasSkuFilter = skuGenders.length || skuSubProds.length || skuProducts.length || skuStyles.length || skuShades.length || skuColors.length || skuSizes.length || skuSeasons.length;
    if (hasSkuFilter) {
      const skuKey = `skuids:v3:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}`;
      const ids = await getOrSet(skuKey, async () => {
        const p2 = [];
        const conds2 = ['s.is_active = true'];
        const add = (col, arr) => {
          if (!arr.length) return;
          if (arr.length === 1) { p2.push(arr[0]);                  conds2.push(`UPPER(${col}::text) = UPPER($${p2.length})`); }
          else                  { p2.push(arr.map(x=>x.toUpperCase())); conds2.push(`UPPER(${col}::text) = ANY($${p2.length}::text[])`); }
        };
        add('s.gender_name', skuGenders);
        add('s.sub_product', skuSubProds);
        add('s.product',     skuProducts);
        add('s.style',       skuStyles);
        add('s.shade',       skuShades);
        add('s.color_name',  skuColors);
        add('s.size',        skuSizes);
        add('s.season',      skuSeasons);
        const r = await query(`SELECT id FROM skus s WHERE ${conds2.join(' AND ')}`, p2);
        return r.rows.map(x => x.id);
      }, 300);
      if (!ids || !ids.length) {
        skuJoinClause = ' AND FALSE'; // valid filter but zero matches → empty stock
      } else {
        params.push(ids);
        skuJoinClause = ` AND i.sku_id = ANY($${params.length}::uuid[])`;
      }
    }

    params.push(limitNum, offset);

    const baseFilterParams = params.slice(0, params.length - 2);
    const optionConditions = [...baseConditions];
    const optionParams = [];

    if (type) { optionParams.push(type); optionConditions.push(`l.type = $${optionParams.length}`); }
    const optGroupPred = multiEq(`COALESCE(l.group_name, l.type::text)`, groupNames, optionParams); if (optGroupPred) optionConditions.push(optGroupPred);
    const optCodePred  = multiEq('l.code', storeCodes, optionParams); if (optCodePred) optionConditions.push(optCodePred);
    if (search) { optionParams.push(`%${search}%`); optionConditions.push(`(l.name ILIKE $${optionParams.length} OR l.code ILIKE $${optionParams.length} OR l.city ILIKE $${optionParams.length} OR l.state ILIKE $${optionParams.length})`); }

    const cityOptionConditions = [...optionConditions];
    const cityOptionParams = [...optionParams];
    const cityStatePred = multiIlike('l.state', states, cityOptionParams); if (cityStatePred) cityOptionConditions.push(cityStatePred);

    const cacheKey = `locations:list:v5:${type||'all'}:${cities.join('|')||'all'}:${states.join('|')||'all'}:${groupNames.join('|')||'all'}:${storeCodes.join('|')||'all'}:${search||''}:p${pageNum}:l${limitNum}:s${sort_by||'default'}:${catKey||''}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:m${mode}`;
    const data = await getOrSet(cacheKey, async () => {
      const baseFrom = `
        FROM locations l
        LEFT JOIN inventory_snapshot i ON i.location_id = l.id${catJoinClause}${skuJoinClause}
        WHERE ${conditions.join(' AND ')}
      `;

      const [rowsResult, countResult, summaryResult, groupsResult, statesResult, citiesResult] = await Promise.all([
        // Per-row table query — adds LEFT JOIN skus s_v inline so we can
        // emit total_value (qty × MRP). baseFrom is reused by the other
        // sub-queries (groups, summary, count) and intentionally doesn't
        // include this join — they don't need ₹ values, and avoiding the
        // join there saves a 5L+ row hash on every page render.
        query(`
          SELECT l.id, l.code, l.name, l.type, l.group_name, l.city, l.state, l.pincode,
                 l.contact_name, l.contact_phone, l.is_active,
                 COALESCE(SUM(i.qty_on_hand), 0)::int                                  AS total_stock,
                 COALESCE(SUM(i.qty_on_hand * COALESCE(s_v.mrp,0)), 0)::bigint         AS total_value,
                 CASE
                   WHEN COALESCE(l.group_name,'') ILIKE '%outright%' THEN 'OUTRIGHT'
                   WHEN COALESCE(l.group_name,'') ILIKE '%- or'      THEN 'OUTRIGHT'
                   WHEN COALESCE(l.group_name,'') ILIKE '% - or'     THEN 'OUTRIGHT'
                   WHEN COALESCE(l.group_name,'') ILIKE '%- rt'       THEN 'OUTRIGHT'
                   ELSE 'SOR'
                 END AS billing_model
          FROM locations l
          LEFT JOIN inventory_snapshot i ON i.location_id = l.id${catJoinClause}${skuJoinClause}
          LEFT JOIN skus s_v ON s_v.id = i.sku_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY l.id
          ORDER BY ${
            sort_by === 'total_value' ? 'COALESCE(SUM(i.qty_on_hand * COALESCE(s_v.mrp,0)),0) DESC NULLS LAST, l.name' :
            sort_by === 'total_stock' ? 'COALESCE(SUM(i.qty_on_hand),0) DESC NULLS LAST, l.name' :
            'COALESCE(l.group_name, l.type::text), l.name'
          }
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params),
        query(`
          SELECT COUNT(*)::int AS total
          FROM locations l
          WHERE ${conditions.join(' AND ')}
        `, locFilterParams),
        // Summary KPI block — counts + stock + ₹ value with Active/Closed split.
        // The split is computed in a single pass by FILTERing aggregates on
        // l.shop_closed, so toggling Active/All in the FilterBar doesn't
        // require a second round-trip — the KPIs always return both numbers
        // and the frontend picks which to highlight. This is the "always show
        // full picture, drill in only when asked" UX cornerstone.
        // Stock value = SUM(qty × MRP) — joins skus on the LEFT JOIN row;
        // when the SKU isn't loaded (rare orphans), falls back to NULL=0.
        query(`
          WITH src AS (
            SELECT l.id, l.shop_closed, l.state, i.sku_id, i.qty_on_hand,
                   COALESCE(s.mrp, 0)::numeric AS mrp
            FROM locations l
            LEFT JOIN inventory_snapshot i ON i.location_id = l.id${catJoinClause}${skuJoinClause}
            LEFT JOIN skus s ON s.id = i.sku_id
            WHERE ${conditions.join(' AND ')}
          )
          SELECT
            COUNT(DISTINCT id)::int                                                       AS total_locations,
            COUNT(DISTINCT id) FILTER (WHERE shop_closed = false)::int                    AS active_locations,
            COUNT(DISTINCT id) FILTER (WHERE shop_closed = true)::int                     AS closed_locations,
            COALESCE(SUM(qty_on_hand), 0)::bigint                                         AS total_stock,
            COALESCE(SUM(qty_on_hand) FILTER (WHERE shop_closed = false), 0)::bigint      AS active_stock,
            COALESCE(SUM(qty_on_hand) FILTER (WHERE shop_closed = true), 0)::bigint       AS closed_stock,
            COALESCE(SUM(qty_on_hand * mrp), 0)::bigint                                   AS total_value,
            COALESCE(SUM(qty_on_hand * mrp) FILTER (WHERE shop_closed = false), 0)::bigint AS active_value,
            COALESCE(SUM(qty_on_hand * mrp) FILTER (WHERE shop_closed = true), 0)::bigint  AS closed_value,
            COUNT(DISTINCT sku_id) FILTER (WHERE qty_on_hand > 0)::int                    AS unique_skus,
            COUNT(DISTINCT state)::int                                                    AS state_count
          FROM src
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
