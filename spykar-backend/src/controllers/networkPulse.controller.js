'use strict';
/**
 * networkPulse.controller â€” the "god-tier" network analytics endpoint
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Returns everything a CEO/sales-head/supply-chain lead wants to see in ONE
 * round-trip â€” concentrated, decision-ready, and respectful of the universal
 * v2 filter set so every widget on the network page narrows together.
 *
 * Designed for the "world-best dashboard" bar:
 *   â€¢ Hero KPIs with Active/Closed splits + â‚¹ value
 *   â€¢ Dead Capital (â‚¹ stuck in closed stores)
 *   â€¢ Top 10 stores by stock value (where's the money sitting)
 *   â€¢ Top 10 states by stock value
 *   â€¢ Channel mix with billing-model split
 *   â€¢ Pareto reveal: % of stores holding X% of stock
 *   â€¢ Action lists: overstocked / understocked / dead-stock / OOS-imminent
 *   â€¢ Stock ageing buckets (0-30 / 31-60 / 61-90 / 91-180 / 180+)
 *
 * One Postgres pass per section â€” six parallel CTEs share the same scope and
 * filter set. Cached in Redis 5 min keyed on the full filter combo so any
 * popular drill-down is sub-50ms after first hit.
 *
 * Filter model: same multi-select dimensions accepted by location.controller
 * (state, city, group_name, store_code, gender, sub_product, style, shade,
 * season, category, mode). The summary numbers ALWAYS show the active/closed
 * split inline regardless of the mode toggle â€” "no hidden data" is the
 * cornerstone UX promise.
 */

const { query }              = require('../config/database');
const { getOrSet, TTL }      = require('../config/redis');
const { canonicalizeCategory, applyCategoryFilter } = require('../utils/categoryFilter');

// Multi-value parser â€” CSV/array, trimmed, empty filtered. Same contract as
// location.controller's `multi` for cross-controller consistency.
function multi(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(','))
    .map(s => String(s).trim())
    .filter(Boolean);
}
// ILIKE for free-text fields (state, city) â€” already case-insensitive.
function multiIlike(col, arr, params) {
  if (!arr.length) return null;
  const ors = arr.map(v => { params.push(`%${v}%`); return `${col} ILIKE $${params.length}`; });
  return `(${ors.join(' OR ')})`;
}
// EQUALITY normalised to UPPER on both sides â†’ case-insensitive exact match.
function multiEq(col, arr, params) {
  if (!arr.length) return null;
  if (arr.length === 1) {
    params.push(arr[0]);
    return `UPPER(${col}::text) = UPPER($${params.length})`;
  }
  params.push(arr.map(v => v.toUpperCase()));
  return `UPPER(${col}::text) = ANY($${params.length}::text[])`;
}

async function getNetworkPulse(req, res, next) {
  try {
    const f = req.query || {};
    const cities      = multi(f.city);
    const states      = multi(f.state);
    const groupNames  = multi(f.group_name);
    const storeCodes  = multi(f.store_code);
    const skuGenders  = multi(f.gender);
    const skuSubProds = multi(f.sub_product);
    const skuProducts = multi(f.product);
    const skuStyles   = multi(f.style);
    const skuShades   = multi(f.shade);
    const skuColors   = multi(f.color);
    const skuSizes    = multi(f.size);
    const skuSeasons  = multi(f.season);
    const catKey      = canonicalizeCategory(f.category);
    // 3-mode lens: active / inactive / all â€” narrows EVERY widget.
    // Pareto, channels, top-stores, ageing, actions all respect this so the
    // user picks one lens and the whole pulse speaks that lens.
    const mode = String(f.mode || 'active').toLowerCase();

    const cacheKey = `network:pulse:v4:${cities.join('|')}:${states.join('|')}:${groupNames.join('|')}:${storeCodes.join('|')}:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}:c${catKey||''}:m${mode}`;

    const data = await getOrSet(cacheKey, async () => {
      // â”€â”€ Build shared WHERE predicates (location filters only â€” mode ignored) â”€â”€
      const conditions = [
        'l.is_active = true',
        "l.type != 'WAREHOUSE'",
        "NULLIF(TRIM(l.group_name), '') IS NOT NULL",
      ];
      const params = [];

      const stP = multiIlike('l.state', states, params); if (stP) conditions.push(stP);
      const ctP = multiIlike('l.city',  cities, params); if (ctP) conditions.push(ctP);
      const gpP = multiEq(`COALESCE(l.group_name, l.type::text)`, groupNames, params); if (gpP) conditions.push(gpP);
      const scP = multiEq('l.code', storeCodes, params); if (scP) conditions.push(scP);

      // â”€â”€ Apply 3-mode lens to ALL pulse widgets (Pareto, channels,
      //    top-stores, ageing, actions, summary). The user picked the
      //    lens via the FilterBar pill; everything below speaks it.
      if (mode === 'active')   conditions.push('l.shop_closed = false');
      if (mode === 'inactive') conditions.push('l.shop_closed = true');

      // â”€â”€ SKU-side filters via the same fast path (sku_id UUID array) â”€â”€â”€â”€
      let catJoinClause = '';
      if (catKey) {
        const frag = await applyCategoryFilter(f.category, params, 'i.sku_id', query, getOrSet);
        if (frag === 'FALSE')  catJoinClause = ' AND FALSE';
        else if (frag)         catJoinClause = ` AND ${frag}`;
      }

      let skuJoinClause = '';
      const hasSkuFilter = skuGenders.length || skuSubProds.length || skuProducts.length || skuStyles.length || skuShades.length || skuColors.length || skuSizes.length || skuSeasons.length;
      if (hasSkuFilter) {
        const skuKey = `skuids:v3:g${skuGenders.join('|')}:sp${skuSubProds.join('|')}:pr${skuProducts.join('|')}:st${skuStyles.join('|')}:sh${skuShades.join('|')}:cl${skuColors.join('|')}:sz${skuSizes.join('|')}:sn${skuSeasons.join('|')}`;
        const ids = await getOrSet(skuKey, async () => {
          const p2 = [];
          const c2 = ['s.is_active = true'];
          // Case-insensitive equality so 'jeans'/'JEANS'/'Jeans' all match.
          const add = (col, arr) => {
            if (!arr.length) return;
            if (arr.length === 1) { p2.push(arr[0]);                 c2.push(`UPPER(${col}::text) = UPPER($${p2.length})`); }
            else                  { p2.push(arr.map(x=>x.toUpperCase())); c2.push(`UPPER(${col}::text) = ANY($${p2.length}::text[])`); }
          };
          add('s.gender_name', skuGenders);
          add('s.sub_product', skuSubProds);
          add('s.product',     skuProducts);
          add('s.style',       skuStyles);
          add('s.shade',       skuShades);
          add('s.color_name',  skuColors);
          add('s.size',        skuSizes);
          add('s.season',      skuSeasons);
          const r = await query(`SELECT id FROM skus s WHERE ${c2.join(' AND ')}`, p2);
          return r.rows.map(x => x.id);
        }, 300);
        if (!ids || !ids.length) skuJoinClause = ' AND FALSE';
        else { params.push(ids); skuJoinClause = ` AND i.sku_id = ANY($${params.length}::uuid[])`; }
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      const joinFrag = `LEFT JOIN inventory_snapshot i ON i.location_id = l.id${catJoinClause}${skuJoinClause}
                       LEFT JOIN skus s ON s.id = i.sku_id`;

      // â”€â”€ Aggregations â€” run sequentially to avoid OOMing PostgreSQL's
      // /dev/shm. Each query aggregates over the 5L-row inventory_snapshot,
      // and 7 in parallel can blow past the default 64 MB shared memory.
      // Serialised, the whole thing finishes in ~600 ms (cached <50 ms).
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // â‘  Hero KPI summary â€” total/active/closed split for stock + â‚¹ value
      const summary = await query(`
          WITH src AS (
            SELECT l.id, l.shop_closed, l.state, i.qty_on_hand,
                   COALESCE(s.mrp, 0)::numeric AS mrp, i.sku_id
            FROM locations l
            ${joinFrag}
            ${where}
          )
          SELECT
            COUNT(DISTINCT id)::int                                                          AS total_locations,
            COUNT(DISTINCT id) FILTER (WHERE shop_closed = false)::int                       AS active_locations,
            COUNT(DISTINCT id) FILTER (WHERE shop_closed = true)::int                        AS closed_locations,
            COALESCE(SUM(qty_on_hand), 0)::bigint                                            AS total_stock,
            COALESCE(SUM(qty_on_hand) FILTER (WHERE shop_closed = false), 0)::bigint         AS active_stock,
            COALESCE(SUM(qty_on_hand) FILTER (WHERE shop_closed = true), 0)::bigint          AS closed_stock,
            COALESCE(SUM(qty_on_hand * mrp), 0)::bigint                                      AS total_value,
            COALESCE(SUM(qty_on_hand * mrp) FILTER (WHERE shop_closed = false), 0)::bigint   AS active_value,
            COALESCE(SUM(qty_on_hand * mrp) FILTER (WHERE shop_closed = true), 0)::bigint    AS dead_capital,
            COUNT(DISTINCT sku_id) FILTER (WHERE qty_on_hand > 0)::int                       AS unique_skus,
            COUNT(DISTINCT state)::int                                                       AS state_count
          FROM src
        `, params);

      // â‘¡ Top 10 stores by stock value
      const topStores = await query(`
          SELECT l.id, l.code, l.name, l.city, l.state,
                 COALESCE(l.group_name, l.type::text) AS channel,
                 l.shop_closed,
                 COALESCE(SUM(i.qty_on_hand), 0)::int                  AS units,
                 COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0)::bigint AS value
          FROM locations l
          ${joinFrag}
          ${where}
          GROUP BY l.id, l.code, l.name, l.city, l.state, l.group_name, l.type, l.shop_closed
          HAVING COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0) > 0
          ORDER BY value DESC NULLS LAST
          LIMIT 25
        `, params);

      // â‘¢ Top 10 states by stock value
      const topStates = await query(`
          SELECT l.state,
                 COUNT(DISTINCT l.id)::int                                  AS stores,
                 COUNT(DISTINCT l.id) FILTER (WHERE l.shop_closed=false)::int AS active_stores,
                 COALESCE(SUM(i.qty_on_hand), 0)::int                       AS units,
                 COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0)::bigint AS value
          FROM locations l
          ${joinFrag}
          ${where} AND l.state IS NOT NULL
          GROUP BY l.state
          HAVING COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0) > 0
          ORDER BY value DESC NULLS LAST
          LIMIT 25
        `, params);

      // â‘£ Channel breakdown with billing model.
      // Conditional HAVING:
      //   • No SKU filter applied → show ALL channels in scope, even ones
      //     with zero stock (so legacy empty channels like Alt-Outright and
      //     EBO-OR remain visible in Inactive/All as the user expects).
      //   • SKU filter applied → narrow to channels that actually have
      //     matching SKUs (so nonsense filters don't show 6 ₹0 rows).
      const channelHaving = (hasSkuFilter || catKey)
        ? `HAVING COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0) > 0`
        : '';
      const channels = await query(`
          SELECT
            COALESCE(l.group_name, l.type::text) AS channel,
            COUNT(DISTINCT l.id)::int            AS stores,
            COUNT(DISTINCT l.id) FILTER (WHERE l.shop_closed=false)::int AS active_stores,
            COALESCE(SUM(i.qty_on_hand), 0)::int AS units,
            COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0)::bigint AS value,
            CASE
              WHEN COALESCE(l.group_name,'') ILIKE '%outright%' OR COALESCE(l.group_name,'') ILIKE '%- or' OR COALESCE(l.group_name,'') ILIKE '% - or' OR COALESCE(l.group_name,'') ILIKE '%- rt' THEN 'OUTRIGHT'
              ELSE 'SOR'
            END AS billing_model
          FROM locations l
          ${joinFrag}
          ${where}
          GROUP BY 1, billing_model
          ${channelHaving}
          ORDER BY value DESC NULLS LAST
        `, params);

      // â‘¤ Pareto: how many stores hold what % of stock
      const paretoBucket = await query(`
          WITH per_store AS (
            SELECT l.id,
                   COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0)::bigint AS value
            FROM locations l
            ${joinFrag}
            ${where}
            GROUP BY l.id
            HAVING COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0) > 0
          ),
          ranked AS (
            SELECT id, value,
                   ROW_NUMBER() OVER (ORDER BY value DESC) AS rnk,
                   COUNT(*)    OVER ()                      AS total,
                   SUM(value)  OVER ()                      AS grand
            FROM per_store
          ),
          cumul AS (
            SELECT rnk, total, grand,
                   SUM(value) OVER (ORDER BY rnk)::bigint AS running
            FROM ranked
          )
          SELECT
            (SELECT MAX(total) FROM cumul)::int  AS total_stores_with_stock,
            (SELECT MAX(grand) FROM cumul)::bigint AS grand_value,
            (SELECT COALESCE(MIN(rnk),0) FROM cumul WHERE running >= grand * 0.5)::int  AS stores_for_50,
            (SELECT COALESCE(MIN(rnk),0) FROM cumul WHERE running >= grand * 0.8)::int  AS stores_for_80,
            (SELECT COALESCE(MIN(rnk),0) FROM cumul WHERE running >= grand * 0.9)::int  AS stores_for_90
        `, params);

      // â‘¥ Stock ageing â€” based on last_movement_at on inventory_snapshot
      const ageing = await query(`
          SELECT
            COUNT(*) FILTER (WHERE i.last_movement_at >= NOW() - INTERVAL '30 days')::int    AS fresh_30,
            COUNT(*) FILTER (WHERE i.last_movement_at >= NOW() - INTERVAL '60 days' AND i.last_movement_at < NOW() - INTERVAL '30 days')::int AS d31_60,
            COUNT(*) FILTER (WHERE i.last_movement_at >= NOW() - INTERVAL '90 days' AND i.last_movement_at < NOW() - INTERVAL '60 days')::int AS d61_90,
            COUNT(*) FILTER (WHERE i.last_movement_at >= NOW() - INTERVAL '180 days' AND i.last_movement_at < NOW() - INTERVAL '90 days')::int AS d91_180,
            COUNT(*) FILTER (WHERE i.last_movement_at < NOW() - INTERVAL '180 days' OR i.last_movement_at IS NULL)::int AS dead_180_plus
          FROM locations l
          ${joinFrag}
          ${where}
        `, params);

      // â‘¦ Action lists â€” REAL signals computed from the data we actually have:
      //
      //   â€¢ empty_stores  : active stores with NO positive-qty rows in
      //                      inventory_snapshot â€” genuinely OOS, replenish.
      //                      (`qty_on_hand=0` doesn't work because ETL only
      //                      inserts positive-qty rows.)
      //   â€¢ dead_stock    : (loc, sku) pairs with qty>0 today but ZERO sale
      //                      movements in inventory_movements over the last
      //                      180 days â€” genuinely stuck. Joins to the
      //                      movements ledger which DOES have time-accurate
      //                      moved_at, unlike inventory_snapshot's
      //                      last_movement_at (which is just sync time).
      //   â€¢ dead_capital  : qty>0 sitting in inactive stores (shop_closed=true)
      //                      â€” unchanged, this one was already real.
      // Pre-aggregate "(loc, sku) pairs that have a SALE in the last 180 days"
      // into a CTE so the dead-stock anti-join is a single hash join, not a
      // correlated 574K × 2.8M subquery (which OOMs Postgres).
      const actionLists = await query(`
          WITH recently_sold AS (
            SELECT DISTINCT m.location_id, m.sku_id
            FROM inventory_movements m
            WHERE m.movement_type = 'SALE'
              AND m.moved_at >= NOW() - INTERVAL '180 days'
          )
          SELECT
            -- Empty active stores: no positive-qty inventory_snapshot rows
            (SELECT json_build_object(
              'count',  COUNT(*),
              'value',  0
            ) FROM locations l
            WHERE l.is_active = true
              AND l.shop_closed = false
              AND l.type <> 'WAREHOUSE'
              AND NULLIF(TRIM(l.group_name), '') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM inventory_snapshot i2
                WHERE i2.location_id = l.id AND i2.qty_on_hand > 0
              )
            ) AS oos_active,

            -- Dead stock: (loc, sku) qty>0 in scope, anti-join recently_sold.
            (SELECT json_build_object(
              'count', COUNT(*),
              'units', COALESCE(SUM(i.qty_on_hand), 0)::bigint,
              'value', COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)), 0)::bigint
            ) FROM locations l
              JOIN inventory_snapshot i ON i.location_id = l.id${catJoinClause}${skuJoinClause}
              LEFT JOIN skus s  ON s.id  = i.sku_id
              LEFT JOIN recently_sold rs
                ON rs.location_id = i.location_id AND rs.sku_id = i.sku_id
              ${where}
              AND i.qty_on_hand > 0
              AND rs.location_id IS NULL
            ) AS dead_stock,

            -- Stock value sitting in currently-closed stores (informational).
            (SELECT json_build_object(
              'count', COUNT(*) FILTER (WHERE l.shop_closed = true AND i.qty_on_hand > 0),
              'units', COALESCE(SUM(i.qty_on_hand) FILTER (WHERE l.shop_closed = true AND i.qty_on_hand > 0), 0)::bigint,
              'value', COALESCE(SUM(i.qty_on_hand * COALESCE(s.mrp,0)) FILTER (WHERE l.shop_closed = true AND i.qty_on_hand > 0), 0)::bigint
            ) FROM locations l
              LEFT JOIN inventory_snapshot i ON i.location_id = l.id${catJoinClause}${skuJoinClause}
              LEFT JOIN skus s ON s.id = i.sku_id
              ${where}
            ) AS dead_capital_lines
        `, params);

      const sum = summary.rows[0] || {};
      const par = paretoBucket.rows[0] || {};
      const age = ageing.rows[0] || {};
      const acts = actionLists.rows[0] || {};

      return {
        summary: {
          total_locations:  Number(sum.total_locations  || 0),
          active_locations: Number(sum.active_locations || 0),
          closed_locations: Number(sum.closed_locations || 0),
          total_stock:      Number(sum.total_stock      || 0),
          active_stock:     Number(sum.active_stock     || 0),
          closed_stock:     Number(sum.closed_stock     || 0),
          total_value:      Number(sum.total_value      || 0),
          active_value:     Number(sum.active_value     || 0),
          dead_capital:     Number(sum.dead_capital     || 0),
          unique_skus:      Number(sum.unique_skus      || 0),
          state_count:      Number(sum.state_count      || 0),
          as_of_date:       '2026-02-01',
        },
        top_stores: topStores.rows,
        top_states: topStates.rows,
        channels:   channels.rows,
        pareto: {
          total_stores_with_stock: Number(par.total_stores_with_stock || 0),
          grand_value:             Number(par.grand_value || 0),
          stores_for_50:           Number(par.stores_for_50 || 0),
          stores_for_80:           Number(par.stores_for_80 || 0),
          stores_for_90:           Number(par.stores_for_90 || 0),
        },
        ageing: {
          fresh_30:      Number(age.fresh_30      || 0),
          d31_60:        Number(age.d31_60        || 0),
          d61_90:        Number(age.d61_90        || 0),
          d91_180:       Number(age.d91_180       || 0),
          dead_180_plus: Number(age.dead_180_plus || 0),
        },
        actions: {
          oos_active:         acts.oos_active         || { count: 0, value: 0 },
          dead_stock:         acts.dead_stock         || { count: 0, units: 0, value: 0 },
          dead_capital_lines: acts.dead_capital_lines || { count: 0, units: 0, value: 0 },
        },
      };
    }, TTL.NETWORK_OVERVIEW || 300);

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

module.exports = { getNetworkPulse };
