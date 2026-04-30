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

function canonicalizeCategory(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'all') return null;
  // collapse whitespace → hyphen and strip trailing 's' for plural handling
  const k = trimmed.replace(/\s+/g, '-').replace(/s$/, '');
  const key = ALIAS[k] || k;
  return CATEGORY_PATTERNS[key] ? key : null;
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
function buildCategoryClause(raw, params, alias = 's') {
  const key = canonicalizeCategory(raw);
  if (!key) return null;
  const { include, exclude } = CATEGORY_PATTERNS[key];
  const parts = [];
  const col = `${alias}.product_name`;

  if (include.length) {
    const ors = include.map(pat => { params.push(pat); return `${col} ILIKE $${params.length}`; });
    parts.push(`(${ors.join(' OR ')})`);
  }
  if (exclude.length) {
    const ors = exclude.map(pat => { params.push(pat); return `${col} ILIKE $${params.length}`; });
    parts.push(`NOT (${ors.join(' OR ')})`);
  }
  return parts.length ? '(' + parts.join(' AND ') + ')' : null;
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
  const key = canonicalizeCategory(raw);
  if (!key) return null;
  return getOrSet(
    `category:sku-ids:v2:${key}`,
    async () => {
      const p = [];
      // buildCategoryClause defaults to alias `s`, so the FROM clause must
      // alias skus as `s` — otherwise Postgres throws
      // "missing FROM-clause entry for table s" and the whole request fails.
      const clause = buildCategoryClause(raw, p, 's');
      if (!clause) return [];
      // Standalone scan over `skus` only — fully driven by idx_skus_search
      const r = await query(`SELECT s.id FROM skus s WHERE ${clause}`, p);
      return r.rows.map(x => x.id);
    },
    24 * 60 * 60  // 24h — category mapping is static
  );
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
  buildCategoryClause,
  resolveCategorySkuIds,
  applyCategoryFilter,
};
