/**
 * Category → ILIKE pattern resolver
 * ──────────────────────────────────────────────────────────────────────────
 * Derives product categories from `skus.product_name` text at query time.
 * Leverages the existing GIN trgm index
 *   `idx_skus_search ON skus USING gin(product_name gin_trgm_ops)`
 * so each ILIKE scan is effectively free (<30ms on 306k rows, amortised to
 * near-zero when joined to movement tables filtered by date/location).
 *
 * Exposes three functions consumed by analytics.controller + sku.controller:
 *   - canonicalizeCategory(raw)   → normalized key or null
 *   - buildCategoryClause(raw, params, alias='s') → SQL fragment or null
 *   - CATEGORY_PATTERNS           → raw map (read-only)
 *
 * The `params` array is mutated (push) so the caller can keep one flat
 * positional-param list, consistent with the rest of the controllers.
 */

const CATEGORY_PATTERNS = {
  denim:       { include: ['%denim%', '%jean%'],                                                                exclude: [] },
  // Shirt MUST exclude t-shirt / sweatshirt variants (mutually exclusive)
  shirt:       { include: ['%shirt%'],                                                                          exclude: ['%t-shirt%', '%tshirt%', '%t shirt%', '%sweatshirt%', '%sweat shirt%'] },
  't-shirt':   { include: ['%t-shirt%', '%tshirt%', '%t shirt%'],                                               exclude: [] },
  trouser:     { include: ['%trouser%', '%chino%', '%cargo%', '%pant%'],                                        exclude: ['%innerwear%', '%jogger%'] },
  innerwear:   { include: ['%boxer%', '%brief%', '%trunk%', '%innerwear%', '%vest%'],                           exclude: [] },
  sweatshirt:  { include: ['%sweatshirt%', '%sweat shirt%', '%hoodie%', '%hooded%', '%sweater%', '%pullover%'], exclude: [] },
  jacket:      { include: ['%jacket%', '%blazer%', '%coat%'],                                                   exclude: [] },
  accessories: { include: ['%belt%', '%wallet%', '%cap%', '%bag%', '%scarf%', '%tie%', '%glove%'],              exclude: [] },
  socks:       { include: ['%sock%'],                                                                           exclude: [] },
  fragrance:   { include: ['%perfume%', '%deo%', '%fragrance%', '%cologne%'],                                   exclude: [] },
};

const ALIAS = {
  jean:         'denim',
  jeans:        'denim',
  tee:          't-shirt',
  t:            't-shirt',
  tshirt:       't-shirt',
  hoodie:       'sweatshirt',
  hoody:        'sweatshirt',
  accessory:    'accessories',
  accessorie:   'accessories',
  perfume:      'fragrance',
  deo:          'fragrance',
  sock:         'socks',
};

// Canonicalise a SINGLE category token. Internal helper.
//
// Source of truth is the `skus.category_norm` column — whatever the ETL
// writes there is what the user sees in the dropdown AND what the filter
// matches against. We no longer gate on a hardcoded pattern list, so new
// categories ('UNDERJEANS', 'KNITS', 'ALBERT EINSTEIN', 'GROOMING', etc.)
// are filterable the moment they land in the DB. Normalisation: trim,
// upper-case, collapse internal whitespace. The DB query uses UPPER() on
// the column side, so case-equivalent values match the same SKUs.
function _canonOne(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'all') return null;
  return s.replace(/\s+/g, ' ').toUpperCase();
}

// Canonicalise to an ARRAY of valid category keys (deduped, sorted for stable
// cache keys). Accepts a single string ('denim'), a CSV ('denim,shirt'), or
// an array (['denim','shirt']) — all three forms come from the FilterBar's
// multi-select. Previously a single-string-only canon silently dropped the
// whole filter the moment the user picked a 2nd value, because 'denim,shirt'
// is not a valid key and the function returned null. That looked to users
// like "category filter is broken on multi-select." Now every valid value
// is preserved and an unrecognised value is silently ignored (so a typo in
// one value doesn't nuke the whole filter).
function canonicalizeCategoryList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw).split(',');
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const k = _canonOne(t);
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out.sort();
}

// Backwards-compatible wrapper. For multi-value input it returns a stable
// `key1|key2|…` token suitable for cache-key composition (NOT a single key
// you can look up in CATEGORY_PATTERNS — that's the whole point: when more
// than one category is selected, no single pattern applies). For empty /
// invalid input returns null. Existing callers that just used this for the
// cache-key suffix continue to work unchanged.
function canonicalizeCategory(raw) {
  const keys = canonicalizeCategoryList(raw);
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  return keys.join('|');
}

/**
 * Build a SQL fragment that restricts rows to a category match against
 * <alias>.product_name (default alias = 's'). Pushes bind params onto
 * the caller's array.
 *
 * Emits OR-expanded ILIKE predicates (NOT `ILIKE ANY (array)`) because
 * Postgres cannot use the GIN trgm index for `ScalarArrayOpExpr`.
 * BitmapOr over independent ILIKE scans DOES use `idx_skus_search`.
 *
 * Returns null if the category is empty/invalid so the caller can simply
 * `if (clause) conditions.push(clause)`.
 */
// Filter directly on the `category_norm` column — same column the dropdown
// reads from, so what the user picks is exactly what gets matched. No more
// pattern-on-product_name guesswork, no more silent drops for categories
// that aren't in a hardcoded list.
function buildCategoryClause(raw, params, alias = 's') {
  const keys = canonicalizeCategoryList(raw);
  if (keys.length === 0) return null;
  const col = `UPPER(${alias}.category_norm)`;
  if (keys.length === 1) {
    params.push(keys[0]);
    return `${col} = $${params.length}`;
  }
  params.push(keys);
  return `${col} = ANY($${params.length}::text[])`;
}

/**
 * Resolve a category key → sku UUID list, using the GIN trgm index on
 * skus.product_name. Result is cached in Redis with a 24-hour TTL so
 * subsequent lookups are sub-millisecond (the mapping is effectively
 * static — new SKUs rarely invalidate category assignments).
 *
 * Consumers pass the raw user-supplied category string and the query +
 * getOrSet helpers from the controller (kept as injection to avoid a
 * circular dep between utils and config).
 *
 *   const ids = await resolveCategorySkuIds(category, query, getOrSet);
 *   if (ids && ids.length) conditions.push(`m.sku_id = ANY($${i}::uuid[])`);
 *
 * Returns null when the category is empty/invalid, or an array of UUIDs.
 */
async function resolveCategorySkuIds(raw, query, getOrSet) {
  const keys = canonicalizeCategoryList(raw);
  if (keys.length === 0) return null;

  // Resolve EACH category key independently (each cached under its own
  // 24h slot in Redis), then union the resulting SKU id lists. This lets
  // a multi-select like ['denim','shirt'] reuse the per-key caches that
  // single-select ['denim'] / ['shirt'] populate, instead of needing a
  // separate cache slot for every combination of categories.
  // Cache key bumped to v3 — old v2 entries were keyed by hardcoded
  // pattern names ('denim', 'shirt', …) that no longer apply. v3 keys are
  // the actual UPPER category_norm values from the DB, so one normalised
  // value = one cache slot, reused across single- and multi-select.
  const idLists = await Promise.all(keys.map(key =>
    getOrSet(
      `category:sku-ids:v3:${key}`,
      async () => {
        const r = await query(
          `SELECT id FROM skus WHERE is_active = true AND UPPER(category_norm) = $1`,
          [key]
        );
        return r.rows.map(x => x.id);
      },
      24 * 60 * 60
    )
  ));

  // Union (dedupe) — a SKU may match multiple categories (rare, but
  // possible thanks to the trigram patterns), and Postgres `= ANY(uuid[])`
  // doesn't care about duplicates anyway.
  const seen = new Set();
  const out = [];
  for (const list of idLists) {
    for (const id of list) {
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

/**
 * Fast path: resolve category → sku_id[] once (cached 24h in Redis), then
 * emit `<column> = ANY($n::uuid[])`. The indexed equality seek on
 * inventory_movements(sku_id) / inventory_snapshot(sku_id) is 10–50× faster
 * than doing ILIKE over a joined skus row per movement.
 *
 * Usage:
 *   const catClause = await applyCategoryFilter(category, params, 'm.sku_id', query, getOrSet);
 *   if (catClause) conditions.push(catClause);
 *
 * Returns:
 *   null    → no category filter (empty/invalid input)
 *   'FALSE' → valid category but zero matching SKUs (forces empty result set)
 *   string  → SQL predicate (and params is mutated with the UUID array)
 */
async function applyCategoryFilter(raw, params, column, query, getOrSet) {
  const ids = await resolveCategorySkuIds(raw, query, getOrSet);
  if (ids === null) return null;
  if (ids.length === 0) return 'FALSE';
  params.push(ids);
  return `${column} = ANY($${params.length}::uuid[])`;
}

module.exports = {
  CATEGORY_PATTERNS,
  canonicalizeCategory,
  canonicalizeCategoryList,
  buildCategoryClause,
  resolveCategorySkuIds,
  applyCategoryFilter,
};
