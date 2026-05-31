'use strict';
/**
 * filters.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Powers the universal FilterBar's dropdown population. One endpoint per
 * dimension; each accepts the *other* active filters as query params and
 * returns only the values still reachable in the data.
 *
 * Example: ?gender=Mens&state=Maharashtra → /filters/sub-product returns only
 *   sub_products that exist for at least one Mens SKU sold/stocked at any
 *   Maharashtra location.
 *
 * Why server-side & cached:
 *   - Source of truth: the dropdown options never go out of sync with what
 *     the analytics endpoints will actually filter on.
 *   - Latency: 5-min Redis cache keyed on the filter combo means re-opening
 *     a dropdown is sub-millisecond.
 *   - Correctness: dependency narrowing prevents the user from selecting
 *     impossible combos (e.g. "Mens" + "Womens-only sub_product").
 */

const { query }              = require('../config/database');
const { getOrSet, TTL }      = require('../config/cache');
const { buildFilters }       = require('../utils/filterBuilder');

// Default 5-min TTL for option lists. Override via TTL.FILTER_OPTIONS if defined.
const OPTIONS_TTL = TTL.FILTER_OPTIONS || 300;

// Stable serialization for cache keys — sort keys + arrays so equivalent filter
// combos hit the same cache entry regardless of param order.
function cacheKey(prefix, f) {
  const norm = {};
  Object.keys(f || {}).sort().forEach(k => {
    const v = f[k];
    if (v === undefined || v === '' || v === null) return;
    norm[k] = Array.isArray(v) ? [...v].sort().join(',') : String(v);
  });
  return `${prefix}:v2:${JSON.stringify(norm)}`;
}

/**
 * Generic distinct-values fetcher.
 *
 * @param {string} dimension      — column on either skus (s) or locations (l)
 * @param {string} table          — 'skus' | 'locations'
 * @param {string} sourceCol      — column for SELECT DISTINCT
 * @param {Object} filters        — req.query (excluding the dimension itself)
 */
async function fetchOptions(dimension, table, sourceCol, filters) {
  // Strip self-filter so the dropdown shows ALL values reachable under the
  // *other* filters (don't auto-narrow the dimension being populated).
  const f = { ...filters };
  delete f[dimension];

  const { skuConditions, locationConditions, params } = buildFilters(f);
  const conds = [];

  if (table === 'skus') {
    conds.push(`s.is_active = true`);
    conds.push(`${sourceCol} IS NOT NULL`);
    conds.push(`TRIM(${sourceCol}) <> ''`);
    if (skuConditions.length) conds.push(...skuConditions);

    // Only join locations if a location filter is active (avoids 200M-row scan)
    const joinLoc = locationConditions.length > 0;

    // ── Colour & Size: cap the dropdown to the TOP 50 by stock volume ──────
    // The colour/size CHARTS are already capped to top 50; the filter dropdown
    // must match, otherwise it lists all ~1,200 distinct colours (unusable and
    // inconsistent). Rank by SUM(qty_on_hand) so the 50 most significant
    // values surface (not an alphabetical slice). Always joins
    // inventory_snapshot for the ranking — cached 4h, so the cost is paid once
    // per filter combo.
    if (dimension === 'color' || dimension === 'size') {
      const rankedSql = `
        SELECT ${sourceCol} AS v
          FROM skus s
          JOIN inventory_snapshot i ON i.sku_id = s.id
          ${joinLoc ? `JOIN locations l ON l.id = i.location_id` : ''}
         WHERE ${conds.join(' AND ')}
          ${joinLoc && locationConditions.length ? ' AND ' + locationConditions.join(' AND ') : ''}
         GROUP BY ${sourceCol}
         ORDER BY SUM(i.qty_on_hand) DESC NULLS LAST
         LIMIT 50
      `;
      const rr = await query(rankedSql, params);
      return rr.rows.map(x => x.v).filter(Boolean);
    }

    const sql = `
      SELECT DISTINCT ${sourceCol} AS v
        FROM skus s
        ${joinLoc ? `JOIN inventory_snapshot i ON i.sku_id = s.id` : ''}
        ${joinLoc ? `JOIN locations l ON l.id = i.location_id`     : ''}
       WHERE ${conds.join(' AND ')}
        ${joinLoc && locationConditions.length ? ' AND ' + locationConditions.join(' AND ') : ''}
       ORDER BY 1
       LIMIT 5000
    `;
    const r = await query(sql, params);
    return r.rows.map(x => x.v).filter(Boolean);
  }

  // table === 'locations'
  conds.push(`l.is_active = true`);
  conds.push(`${sourceCol} IS NOT NULL`);
  conds.push(`TRIM(${sourceCol}) <> ''`);
  if (locationConditions.length) conds.push(...locationConditions);

  const joinSku = skuConditions.length > 0;
  const sql = `
    SELECT DISTINCT ${sourceCol} AS v
      FROM locations l
      ${joinSku ? `JOIN inventory_snapshot i ON i.location_id = l.id` : ''}
      ${joinSku ? `JOIN skus s ON s.id = i.sku_id`                    : ''}
     WHERE ${conds.join(' AND ')}
      ${joinSku && skuConditions.length ? ' AND ' + skuConditions.join(' AND ') : ''}
     ORDER BY 1
     LIMIT 5000
  `;
  const r = await query(sql, params);
  return r.rows.map(x => x.v).filter(Boolean);
}

// ─── Per-dimension handlers ───────────────────────────────────────────────────

const dimensions = {
  style:        { table: 'skus',      col: 's.style' },
  shade:        { table: 'skus',      col: 's.shade' },
  color:        { table: 'skus',      col: 's.color_name' },
  gender:       { table: 'skus',      col: 's.gender_name' },
  sub_product:  { table: 'skus',      col: 's.sub_product' },
  product:      { table: 'skus',      col: 's.product' },
  category:     { table: 'skus',      col: 's.category_norm' },
  brand:        { table: 'skus',      col: 's.brand' },
  season:       { table: 'skus',      col: 's.season' },
  size:         { table: 'skus',      col: 's.size' },
  state:        { table: 'locations', col: 'l.state' },
  city:         { table: 'locations', col: 'l.city' },
  group_name:   { table: 'locations', col: 'l.group_name' },
  store_code:   { table: 'locations', col: 'l.code' },
};

async function getOptionsForDimension(req, res, next) {
  try {
    const { dimension } = req.params;
    const def = dimensions[dimension];
    if (!def) {
      return res.status(400).json({ success: false, message: `Unknown dimension: ${dimension}` });
    }
    const filters = { ...req.query };
    const key     = cacheKey(`filters:${dimension}`, filters);
    const data    = await getOrSet(key, async () => {
      const values = await fetchOptions(dimension, def.table, def.col, filters);
      return values;
    }, OPTIONS_TTL);
    res.json({ success: true, dimension, count: data.length, options: data });
  } catch (err) { next(err); }
}

/**
 * Bulk endpoint — returns ALL filter dimensions in one round-trip. Used by the
 * FilterBar on initial mount so we don't fire 11 parallel requests.
 */
async function getAllOptions(req, res, next) {
  try {
    const filters = { ...req.query };
    const key     = cacheKey('filters:all', filters);
    const data    = await getOrSet(key, async () => {
      const out = {};
      const dims = Object.entries(dimensions);
      // Run in parallel — each runs against an indexed column set, so cumulative
      // load is well under the connection-pool ceiling.
      const results = await Promise.all(dims.map(async ([dim, def]) => {
        try {
          const v = await fetchOptions(dim, def.table, def.col, filters);
          return [dim, v];
        } catch { return [dim, []]; }
      }));
      results.forEach(([dim, values]) => { out[dim] = values; });
      return out;
    }, OPTIONS_TTL);
    res.json({ success: true, options: data });
  } catch (err) { next(err); }
}

/**
 * Pre-warm the default (no-filter) cache key for `/filters/options`.
 * Called from services/cacheWarmup at startup so the FIRST user landing on
 * /network or /sales doesn't pay the ~2 s cold-path cost of running 14
 * parallel SELECT DISTINCTs against the movements/skus/locations tables.
 *
 * Hits the exact same cache key the HTTP handler uses (`filters:all:v1:{}`),
 * so the first request reads pre-warmed Redis.
 */
async function warmAllOptionsDefault() {
  // Match the params the FilterBar sends on first mount.  v2 universal filter
  // bar always emits mode/sale_mode/valuation regardless of user input, so
  // the empty-filters cache key includes those three.
  const filters = { mode: 'active', sale_mode: 'net', valuation: 'gross' };
  const key     = cacheKey('filters:all', filters);
  return getOrSet(key, async () => {
    const out = {};
    const dims = Object.entries(dimensions);
    const results = await Promise.all(dims.map(async ([dim, def]) => {
      try {
        const v = await fetchOptions(dim, def.table, def.col, filters);
        return [dim, v];
      } catch { return [dim, []]; }
    }));
    results.forEach(([dim, values]) => { out[dim] = values; });
    return out;
  }, OPTIONS_TTL);
}

module.exports = { getOptionsForDimension, getAllOptions, warmAllOptionsDefault };
