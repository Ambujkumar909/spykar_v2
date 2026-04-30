'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║       FILTER BUILDER  —  The single SQL primitive every endpoint shares      ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║  Every dashboard query that filters by SKU dimensions, location dimensions, ║
 * ║  store lifecycle, or category goes through this builder. One canonical      ║
 * ║  predicate generator means filter logic never diverges across endpoints,    ║
 * ║  and every filter combination uses the same indexes.                        ║
 * ║                                                                              ║
 * ║  Supported filters (matching the v2 dashboard spec):                        ║
 * ║    SKU side       : style, shade, gender, sub_product, season, product,     ║
 * ║                     category, brand, fit                                    ║
 * ║    Location side  : state, city, group_name, store_code, location_type      ║
 * ║    Store lifecycle: mode = 'active' | 'all' (default 'active')              ║
 * ║                                                                              ║
 * ║  Filters accept either a single string or an array (multi-select). Empty   ║
 * ║  / null / 'all' values are treated as "no filter on that dimension".        ║
 * ║                                                                              ║
 * ║  Returns:                                                                    ║
 * ║    {                                                                         ║
 * ║      skuConditions      : [],   // predicates referencing s.* columns      ║
 * ║      locationConditions : [],   // predicates referencing l.* columns      ║
 * ║      params             : [],   // bind params (caller appends own at end) ║
 * ║      hasSkuFilters      : bool, // hint: do we need to JOIN skus?          ║
 * ║      hasLocationFilters : bool,                                             ║
 * ║    }                                                                         ║
 * ║                                                                              ║
 * ║  Caller composes the final SQL by .join(' AND ') of the relevant array     ║
 * ║  alongside their own date / aggregation predicates.                         ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

// Multi-select helper — emits a case-insensitive equality predicate so
// 'denim'/'DENIM'/'Denim' all match, and trims whitespace so '  MENS  '
// behaves like 'MENS'. Single bind param covers any number of selected
// values via UPPER(...) on both sides; the column is indexed btree, and
// PG can still leverage the index thanks to a function-on-constant pattern
// equivalent to a transparent equality check at small selectivity.
//
// Why not ILIKE: ILIKE matches substrings ('denim' would match 'pre-denim'),
// which would break the dependency-narrow contract. We need exact equality
// modulo case + whitespace.
function pushMulti(conditions, params, col, value) {
  if (value === undefined || value === null || value === '' || value === 'all') return false;
  const arr = (Array.isArray(value) ? value : String(value).split(','))
    .map(s => String(s).trim())
    .filter(Boolean);
  if (!arr.length) return false;
  if (arr.length === 1) {
    params.push(arr[0]);
    conditions.push(`UPPER(${col}) = UPPER($${params.length})`);
  } else {
    // Normalise both sides to upper-case for case-insensitive multi match.
    params.push(arr.map(v => v.toUpperCase()));
    conditions.push(`UPPER(${col}) = ANY($${params.length}::text[])`);
  }
  return true;
}

// ILIKE helper for substring search (used by city/state when the user types
// a partial; the dropdown sends exact matches, but the search box uses ILIKE)
function pushIlike(conditions, params, col, value) {
  if (!value) return false;
  params.push(`%${value}%`);
  conditions.push(`${col} ILIKE $${params.length}`);
  return true;
}

/**
 * Build the canonical filter predicates from a request's query/body.
 *
 * @param {Object} f — filter object (typically req.query)
 * @param {Object} aliases — column-prefix aliases (default skus=s, locations=l)
 * @returns {{skuConditions: string[], locationConditions: string[], params: any[], hasSkuFilters: boolean, hasLocationFilters: boolean}}
 */
function buildFilters(f = {}, aliases = {}) {
  const s = aliases.skus      || 's';
  const l = aliases.locations || 'l';

  const skuConditions      = [];
  const locationConditions = [];
  const params             = [];
  let hasSkuFilters        = false;
  let hasLocationFilters   = false;

  // ── SKU dimensions (drill-down filter set) ────────────────────────────────
  if (pushMulti(skuConditions, params, `${s}.style`,         f.style))       hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.shade`,         f.shade))       hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.color_name`,    f.color || f.color_name)) hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.gender_name`,   f.gender || f.gender_name)) hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.sub_product`,   f.sub_product || f.subProduct)) hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.season`,        f.season))      hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.product`,       f.product))     hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.category_norm`, f.category || f.category_norm)) hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.brand`,         f.brand))       hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.fit_name`,      f.fit || f.fit_name)) hasSkuFilters = true;
  if (pushMulti(skuConditions, params, `${s}.size`,          f.size))        hasSkuFilters = true;

  // ── Location dimensions ───────────────────────────────────────────────────
  if (pushMulti(locationConditions, params, `${l}.state`,       f.state))       hasLocationFilters = true;
  if (pushMulti(locationConditions, params, `${l}.city`,        f.city))        hasLocationFilters = true;
  if (pushMulti(locationConditions, params, `${l}.group_name`,  f.group_name || f.groupName)) hasLocationFilters = true;
  if (pushMulti(locationConditions, params, `${l}.code`,        f.store_code || f.storeCode)) hasLocationFilters = true;
  if (pushMulti(locationConditions, params, `${l}.type::text`,  f.type || f.location_type))   hasLocationFilters = true;

  // ── 3-mode lens ─────────────────────────────────────────────────────────
  // 'active'   → only currently-open stores (shop_closed=false)
  // 'inactive' → only currently-closed stores (shop_closed=true)
  // 'all'      → no lifecycle filter
  // Drives the Party (group_name) dropdown narrowing — if the user picked
  // Active, the dropdown should only list channels with active stores (2).
  // If Inactive, only channels with closed stores (6 here since every legacy
  // channel has at least one closed store).
  const mode = (f.mode || 'active').toLowerCase();
  if (mode === 'active') {
    locationConditions.push(`${l}.shop_closed = false`);
    hasLocationFilters = true;
  } else if (mode === 'inactive') {
    locationConditions.push(`${l}.shop_closed = true`);
    hasLocationFilters = true;
  }
  // mode === 'all' → no extra predicate; everything visible.

  return { skuConditions, locationConditions, params, hasSkuFilters, hasLocationFilters };
}

/**
 * Build a single combined WHERE clause string for callers that just want the
 * fully-AND-ed predicate. Returns the empty string if no filters are active,
 * so callers can do `WHERE 1=1 ${buildWhere(...)}` safely.
 */
function buildWhere(f = {}, aliases = {}) {
  const r = buildFilters(f, aliases);
  const all = [...r.skuConditions, ...r.locationConditions];
  if (!all.length) return { sql: '', params: [] };
  return { sql: ' AND ' + all.join(' AND '), params: r.params };
}

module.exports = { buildFilters, buildWhere, pushMulti, pushIlike };
