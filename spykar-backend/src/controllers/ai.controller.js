// ─────────────────────────────────────────────────────────────────────────────
// Spykar Conversational Inventory Intelligence
//   • Claude-first (Sonnet 4.5 for SQL, Haiku 4.5 for everything else)
//   • Anthropic prompt caching → ~90% input-token reduction on schema
//   • 5-stage pipeline with parallel cache+memory loads
//   • Semantic + exact-match Redis caching → sub-1s on hits
//   • Multilingual (English / Hindi / Hinglish) with native-language synthesis
//   • Self-healing SQL, soft synthesis budget, anomaly + comparative context
//   • Follow-up resolution from session memory, prompt-injection guard
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');

// ─── Optional Anthropic SDK ──────────────────────────────────────────────────
let Anthropic = null;
let anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
  if (process.env.ANTHROPIC_API_KEY && !/your-anthropic-api-key-here/i.test(process.env.ANTHROPIC_API_KEY)) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (e) {
  logger.warn('@anthropic-ai/sdk not installed yet — falling back to Gemini only');
}

// ─── Optional Gemini fallback ────────────────────────────────────────────────
let geminiClient = null;
try {
  if (process.env.GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
} catch (e) {
  logger.warn('Gemini fallback unavailable:', e.message);
}

// ─── Optional Redis ──────────────────────────────────────────────────────────
let cacheMod = null;
try { cacheMod = require('../config/cache'); } catch (_) { /* optional */ }

// ─── Provider switch (default: Gemini; flip to 'anthropic' when key is live) ─
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const SONNET = process.env.ANTHROPIC_SONNET_MODEL || 'claude-sonnet-4-5';
const HAIKU = process.env.ANTHROPIC_HAIKU_MODEL || 'claude-haiku-4-5';
// Gemini model split: Flash for SQL/heavy reasoning, Flash-Lite for fast tasks
const GEMINI_HEAVY = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FAST  = process.env.GEMINI_FAST_MODEL || 'gemini-2.5-flash-lite';

// Resolve which provider is actually usable right now
function activeProvider() {
  if (AI_PROVIDER === 'anthropic' && anthropic) return 'anthropic';
  if (AI_PROVIDER === 'gemini' && geminiClient) return 'gemini';
  // Fallbacks: prefer whatever is configured
  if (geminiClient) return 'gemini';
  if (anthropic) return 'anthropic';
  return null;
}

// Cache version — bump this whenever the response shape or formatting
// changes so stale entries are invalidated automatically.
const CACHE_VERSION = 'v5';
const CACHE_PREFIX = `ai:${CACHE_VERSION}:q:`;
const CACHE_LOOSE_PREFIX = `ai:${CACHE_VERSION}:l:`;   // semantic cache
const SQL_RESULT_PREFIX = `ai:${CACHE_VERSION}:r:`;    // sql → rows cache
const SESSION_PREFIX = 'ai:sess:';
const CACHE_TTL = 300;                    // 5 min query cache
const SQL_RESULT_TTL = 300;               // 5 min result cache
const SESSION_TTL = 1800;                 // 30 min memory
const MAX_ROWS = 1000;
const SQL_TIMEOUT_MS = 10000;
const SYNTHESIS_BUDGET_MS = 1500;         // hard race deadline for synthesis

// ─── Rate limiting (in-process, 30/min/user) ─────────────────────────────────
const rateBuckets = new Map();
function rateLimit(userId) {
  const now = Date.now();
  const bucket = rateBuckets.get(userId) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
  bucket.count += 1;
  rateBuckets.set(userId, bucket);
  return bucket.count <= 30;
}

// ─── Cache safe wrappers ─────────────────────────────────────────────────────
// Back the AI response cache with the in-process cache (config/cache.js).
// Values stored here are plain strings; get() returns the string or null.
async function rGet(key) {
  try {
    if (!cacheMod) return null;
    return await cacheMod.get(key);
  } catch { return null; }
}
async function rSet(key, val, ttl) {
  try {
    if (!cacheMod) return;
    await cacheMod.set(key, val, ttl);
  } catch { /* ignore */ }
}
async function rDel(key) {
  try {
    if (!cacheMod) return;
    await cacheMod.del(key);
  } catch { /* ignore */ }
}

// ─── Security guards ─────────────────────────────────────────────────────────
const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|REPLACE|EXEC|EXECUTE|COPY|VACUUM)\b/i;
const PROMPT_INJECTION = /(ignore (all |the )?(previous|above|prior)|disregard (all |the )?(previous|prior)|system prompt|you are now|forget (your|all)|reveal your prompt|print your instructions)/i;

// ─── Normalization & hashing ─────────────────────────────────────────────────
function normalizeStrict(q) {
  return (q || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeLoose(q) {
  // Collapse numbers and dates so "top 5 / top 10" hit same loose bucket
  return normalizeStrict(q)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, '<mon>');
}
function hashKey(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24);
}

// ─── Indian number formatting ────────────────────────────────────────────────
function fmt(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(1)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(n);
}

// ─── World-class schema prompt — grounded in actual DB profile ───────────────
// Every claim below is verified against the live database. Cached via
// Anthropic prompt caching (90% input-token reduction).
function schemaContext() {
  const today = new Date().toISOString().split('T')[0];
  return `You are the senior PostgreSQL analyst for Spykar India — apparel & accessories retail across 668 stores in India. Convert any natural-language business question into ONE valid SELECT/WITH SQL query and return STRICT JSON: {"sql":"...","explanation":"..."}.

═══════ DATABASE GROUND TRUTH ═══════

CORE TABLES (sizes verified):
• skus (307,182 rows, all is_active=true)
    id UUID, sku_code, product_name, color_code, color_name, size, mrp, cost_price, is_active
    + RICH COLUMNS (use these instead of unreliable ones):
      gender_name → 'MENS' | 'WOMENS' | 'UNISEX' | 'NOT DEFINED'
      product → 'JEANS','JEANS<','SHIRTS','SHIRTS<','T-SHIRTS<','JACKETS','TROUSERS','TROUSERS<','SWEATSHIRT','BELT','TRUNK - UJ','BRIEF - UJ','VEST - UJ', etc.  ← USE FOR PRODUCT-TYPE QUERIES
      category_norm → 'DENIM','NON DENIM','KNITS','UNDERJEANS','ACCESSORIES','INNERWEAR','GROOMING'  ← USE FOR CATEGORY QUERIES
      style → 'SKINNY','SLIM','REGULAR','RICO','RENEGADE','RECRUIT','STERN','MENS_BASIC', etc.  ← USE FOR FIT/STYLE
      shade → mirror of color_name (use color_name)
      season → 'WINTER - 2024','SUMMER - 2026','ALL SEASON' (note: format varies — sometimes 'WINTER - YYYY' or 'WINTER-YYYY')
    UNRELIABLE / IGNORE (always NULL or single-valued — never filter on these):
      category (always 'Jeans' for every row), sub_category (NULL), fit_type (NULL), fabric (NULL), fit_name (NULL), hit_name (NULL), brand (always 'SPYKAR')

• locations (668 rows, all is_active=true)
    id, code, name, type ENUM[FOFO, DISTRIBUTOR]  ← only these two types exist
    zone_id INT, city, state (all UPPERCASE: 'MAHARASHTRA','BIHAR','DELHI', etc.)
    group_name → channel: 'EBO - SOR' (493), 'Alternate - SOR' (141), 'EBO - OR' (13), 'Alternate - Outright' (10), 'MBO - SOR' (8), 'Alternate - RT' (3)
    shop_closed BOOL → 384 of 668 are closed (THIS is real "inactive")
    closed_on DATE
    NEVER use l.type='COCO'/'WAREHOUSE'/'TRANSIT' — those don't exist.
    "Active store" = shop_closed=false (284 stores). "Inactive/closed" = shop_closed=true (384 stores).

• inventory_snapshot (574,514 rows, snapshot_date=${today})
    location_id, sku_id, qty_on_hand, qty_reserved, qty_in_transit, qty_available
    safety_stock & reorder_point are 0 on every row → use velocity defaults: safety=GREATEST(5,daily_sales*7), reorder=GREATEST(2,daily_sales*3)

• inventory_movements (2.83M rows, range 2024-03-31 → ${today})
    movement_type ENUM only has 'SALE' and 'RETURN' in actual data (DISPATCH/RECEIPT/TRANSFER never logged)
    qty_change INT (SALE is NEGATIVE, RETURN is POSITIVE)
    sale_value NUMERIC ← PRE-COMPUTED revenue per row (avg ₹1,531.76). Always prefer SUM(sale_value) over SUM(ABS(qty_change)*mrp) — sale_value reflects discounts, mrp doesn't.
    moved_at TIMESTAMPTZ

• stock_ageing (2.50M rows)
    location_id, sku_id, qty_0_30, qty_31_60, qty_61_90, qty_91_180, qty_180_plus, ageing_date
    Network ageing currently: 248K @ 0-30 / 166K @ 31-60 / 93K @ 61-90 / 207K @ 91-180 / 3.21M @ 180+
    Dead stock = qty_180_plus

EMPTY TABLES (never query):
• dispatch_orders (0 rows) • dispatch_line_items (0 rows) • zones (0 rows — but locations.zone_id exists for grouping)

VIEWS available:
• v_executive_summary — pre-aggregated by location_type
• v_inventory_full — pre-joined snapshot + skus + locations
• v_top_distributors — pre-ranked distributors by stock value

═══════ PRODUCT-TYPE INTELLIGENCE (CRITICAL) ═══════

The user will ask about 'belt', 'shirt', 'fragrance', 't-shirt', 'jacket', 'jeans', 'innerwear' etc.
USE the s.product column — it has real values:
  belt          → s.product = 'BELT'
  jeans/denim   → s.product IN ('JEANS','JEANS<') OR s.category_norm='DENIM'
  shirt         → s.product IN ('SHIRTS','SHIRTS<')
  t-shirt/tee   → s.product = 'T-SHIRTS<'
  trouser/pant  → s.product IN ('TROUSERS','TROUSERS<')
  jacket        → s.product = 'JACKETS'
  sweatshirt    → s.product = 'SWEATSHIRT'
  innerwear/brief/trunk/vest → s.category_norm IN ('INNERWEAR','UNDERJEANS') OR s.product LIKE '%- UJ'
  fragrance/perfume/deo → s.category_norm = 'GROOMING'
  accessory     → s.category_norm = 'ACCESSORIES'
NEVER refuse a product-type question saying "only jeans" — Spykar sells the full apparel + accessories range.

═══════ ABSOLUTE QUERY RULES ═══════

1. JOIN PATTERN (movements queries):
   FROM inventory_movements im
   JOIN skus s ON s.id = im.sku_id
   JOIN locations l ON l.id = im.location_id

2. SALES METRIC (always use sale_value, not mrp×qty):
   units_sold = COALESCE(SUM(ABS(im.qty_change)),0)        -- when movement_type='SALE'
   revenue    = COALESCE(SUM(im.sale_value),0)             -- already net of discount
   Fallback when sale_value is NULL: COALESCE(SUM(ABS(im.qty_change)*s.mrp),0)

3. RETURN METRIC:
   units_returned = COALESCE(SUM(im.qty_change),0)         -- positive for RETURN

4. ACTIVE FILTER (default unless user says otherwise):
   AND l.is_active = true AND s.is_active = true AND l.shop_closed = false

5. DATES (ALWAYS half-open intervals):
   WHERE im.moved_at >= 'YYYY-MM-DD'::date
     AND im.moved_at <  'YYYY-MM-DD'::date

6. RELATIVE TIME (today=${today}):
   "today"        → ['${today}'::date, '${today}'::date + INTERVAL '1 day')
   "yesterday"    → today - 1 to today
   "last 7 days"  → today - 7 to today + 1
   "last 30 days" → today - 30 to today + 1
   "last month"   → date_trunc('month', today - INTERVAL '1 month') to date_trunc('month', today)
   "this month"   → date_trunc('month', today) to today + 1
   "FY YYYY"      → Apr 1 YYYY to Apr 1 YYYY+1
   Data range: 2024-04-01 → 2026-01-30 (movements cap at 2026-01-30; if user says "last 30 days" use that as reference end-date when needed)

7. FESTIVALS (resolve dates yourself, NEVER leave placeholder):
   "Holi 2025"   → 2025-03-14
   "Diwali 2025" → 2025-10-20
   "Diwali 2024" → 2024-11-01
   "Holi 2026"   → 2026-03-04
   "during N days of [festival] YYYY" → N days ENDING ON festival day
     e.g. "5 days of Diwali 2025" → 2025-10-16 to 2025-10-21
   "during [festival] YYYY" (no N) → 5-day window centered: -2 to +3
     e.g. "during Holi 2025" → 2025-03-12 to 2025-03-17
   "festive season YYYY" → Sep 1 → Nov 30
   "summer YYYY" → Apr 1 → Jun 30 (also matches season='SUMMER - YYYY')
   "winter YYYY" → Nov 1 → Jan 31 (also matches season='WINTER - YYYY')

8. STRING MATCHING (case-insensitive):
   States/cities: ILIKE always (e.g. l.state ILIKE 'Bihar' or l.state ILIKE '%bihar%' for partial). DB stores them in UPPERCASE but ILIKE handles it.
   color_name: exact for common colors (ILIKE 'BLACK', ILIKE 'WHITE', ILIKE 'NAVY')
               family for variants (ILIKE '%BLUE%' covers DARK BLUE, MID BLUE, NAVY BLUE, MIDBLUE, LT.BLUE, NAVYBLUE, etc.)
               family for browns (ILIKE '%BROWN%')
   product_name typos: handle "blck"→"black", "jens"→"jeans", "tshrt"→"t-shirt" by inferring intent

9. AGGREGATION DEFAULTS:
   COALESCE(SUM(...),0) — never bare SUM
   COALESCE(COUNT(...),0)
   ROUND(avg, 2) for any computed average
   LIMIT 50 default · LIMIT N where user specifies "top N"

10. CHANNEL DISPLAY: SELECT l.group_name AS channel — NEVER l.type to user-facing output.

11. ZONES: zones table is empty. Group by zone_id directly: l.zone_id, or build a CASE on state names if needed.

═══════ QUERY TYPE DECISIONS ═══════

User says "how was sales / sales overview / performance / analysis":
  → MULTI-ROW breakdown — group by DATE(im.moved_at) OR by s.color_name OR by l.group_name
  → ALWAYS include units_sold AND revenue columns
  → Order chronologically or by revenue DESC

User says "total / count / how many / what's the":
  → Single aggregate row is fine

User says "top N / best N / leading":
  → GROUP BY <dimension> ORDER BY <metric> DESC LIMIT N
  → If user says "top stores" use l.name; "top colours" use s.color_name; "top SKUs" use s.sku_code

User says "compare X vs Y" or "X vs Y":
  → Use FILTER (WHERE …) per metric in a single SELECT, OR UNION ALL with a label column

User says "trend / over time / month over month / yoy":
  → GROUP BY DATE_TRUNC('day'/'week'/'month', moved_at)

User says "stock / available / on hand":
  → Use inventory_snapshot, NOT movements
  → SELECT location, sku, qty_on_hand, qty_available

User says "out of stock / oos":
  → inventory_snapshot WHERE qty_on_hand=0

User says "low stock / reorder":
  → Use velocity-based thresholds: WHERE i.qty_on_hand <= GREATEST(5, ROUND(daily_sales*7))

User says "ageing / dead stock / slow":
  → Use stock_ageing table; dead stock = qty_180_plus

User says "men's / women's / mens / womens":
  → s.gender_name = 'MENS' (or 'WOMENS' or 'UNISEX')

User says "skinny / slim / regular fit":
  → s.style ILIKE '%SKINNY%' (or 'SLIM','REGULAR'). NEVER use s.fit_type — it's NULL.

User asks vague greeting / meta:
  → Skip SQL — but you won't see those (handled upstream).

═══════ EXAMPLES ═══════

Q: "tell me the stock of black belt"
→ {"sql":"SELECT l.name AS store_name, l.group_name AS channel, l.city, COALESCE(SUM(i.qty_on_hand),0) AS units_on_hand FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE s.product='BELT' AND s.color_name ILIKE 'BLACK' AND l.is_active=true AND s.is_active=true AND l.shop_closed=false GROUP BY l.id, l.name, l.group_name, l.city ORDER BY units_on_hand DESC LIMIT 50","explanation":"Black belts on hand by store"}

Q: "sales of blue jeans last 3 months"
→ {"sql":"SELECT DATE_TRUNC('day', im.moved_at)::date AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(im.sale_value),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND s.product IN ('JEANS','JEANS<') AND s.color_name ILIKE '%BLUE%' AND l.is_active=true AND s.is_active=true AND l.shop_closed=false AND im.moved_at >= '${today}'::date - INTERVAL '90 days' AND im.moved_at < '${today}'::date + INTERVAL '1 day' GROUP BY 1 ORDER BY 1","explanation":"Daily blue jeans sales for last 90 days"}

Q: "top 5 stores in Bihar by revenue last 6 months"
→ {"sql":"SELECT l.name AS store_name, l.group_name AS channel, l.city, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(im.sale_value),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.state ILIKE 'Bihar' AND l.is_active=true AND s.is_active=true AND l.shop_closed=false AND im.moved_at >= '${today}'::date - INTERVAL '6 months' AND im.moved_at < '${today}'::date + INTERVAL '1 day' GROUP BY l.id, l.name, l.group_name, l.city ORDER BY revenue DESC LIMIT 5","explanation":"Top 5 Bihar stores by revenue, last 6 months"}

Q: "mens skinny fit jeans stock across COCO" → there's no COCO; use FOFO
→ {"sql":"SELECT l.name AS store_name, l.city, COALESCE(SUM(i.qty_on_hand),0) AS units FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE l.type='FOFO' AND s.gender_name='MENS' AND s.style ILIKE '%SKINNY%' AND (s.product='JEANS' OR s.product='JEANS<' OR s.category_norm='DENIM') AND l.is_active=true AND s.is_active=true AND l.shop_closed=false GROUP BY l.id, l.name, l.city ORDER BY units DESC LIMIT 50","explanation":"Men's skinny denim stock at FOFO stores"}

Q: "top 10 colours sold during Diwali 2025"
→ Diwali=Oct 20, 5-day window Oct 18-22
→ {"sql":"SELECT s.color_name, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(im.sale_value),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND l.shop_closed=false AND im.moved_at >= '2025-10-18'::date AND im.moved_at < '2025-10-23'::date GROUP BY s.color_name ORDER BY units_sold DESC LIMIT 10","explanation":"Top 10 colours by units sold during Diwali 2025 (Oct 18-22)"}

Q: "ageing summary network wide"
→ {"sql":"SELECT COALESCE(SUM(qty_0_30),0) AS days_0_30, COALESCE(SUM(qty_31_60),0) AS days_31_60, COALESCE(SUM(qty_61_90),0) AS days_61_90, COALESCE(SUM(qty_91_180),0) AS days_91_180, COALESCE(SUM(qty_180_plus),0) AS days_180_plus FROM stock_ageing sa JOIN locations l ON l.id=sa.location_id JOIN skus s ON s.id=sa.sku_id WHERE l.is_active=true AND s.is_active=true AND l.shop_closed=false","explanation":"Network ageing buckets (active open stores)"}

Q: "fragrance stock available"
→ {"sql":"SELECT s.sku_code, s.product_name, s.color_name, s.size, l.name AS store_name, COALESCE(SUM(i.qty_on_hand),0) AS units FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE s.category_norm='GROOMING' AND l.is_active=true AND s.is_active=true AND l.shop_closed=false GROUP BY s.id, s.sku_code, s.product_name, s.color_name, s.size, l.id, l.name ORDER BY units DESC LIMIT 50","explanation":"Available fragrance/grooming stock by SKU and store"}

Q: "returns vs sales last 90 days by colour"
→ {"sql":"SELECT s.color_name, COALESCE(SUM(CASE WHEN im.movement_type='SALE' THEN ABS(im.qty_change) ELSE 0 END),0) AS units_sold, COALESCE(SUM(CASE WHEN im.movement_type='RETURN' THEN im.qty_change ELSE 0 END),0) AS units_returned, ROUND((COALESCE(SUM(CASE WHEN im.movement_type='RETURN' THEN im.qty_change ELSE 0 END),0)::numeric / NULLIF(SUM(CASE WHEN im.movement_type='SALE' THEN ABS(im.qty_change) ELSE 0 END),0))*100, 2) AS return_rate_pct FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE l.is_active=true AND s.is_active=true AND l.shop_closed=false AND im.moved_at >= '${today}'::date - INTERVAL '90 days' GROUP BY s.color_name ORDER BY units_sold DESC LIMIT 20","explanation":"Return rate per colour for last 90 days"}

═══════ FINAL DIRECTIVES ═══════

• ABSOLUTELY NEVER fabricate a fake-row SQL like SELECT '...message...' AS message. Always run a real query.
• ABSOLUTELY NEVER refuse with "no data" because of the category='Jeans' quirk — use product / category_norm.
• ABSOLUTELY NEVER use l.type values other than 'FOFO' or 'DISTRIBUTOR'.
• ABSOLUTELY NEVER reference dispatch_orders, dispatch_line_items, or zones (empty tables).
• ALWAYS prefer im.sale_value over qty×mrp for revenue.
• ALWAYS include the active filter unless user explicitly asks for closed/inactive stores.
• Output JSON only. No markdown, no commentary, no code fences.

TODAY: ${today}`;
}

// ─── Claude wrapper with prompt caching + retry+backoff ──────────────────────
async function claudeCall({ model, system, messages, max_tokens = 600, temperature = 0.2, cacheSystem = false }) {
  if (!anthropic) throw new Error('Anthropic client unavailable');

  // Anthropic prompt caching: passing system as an array of blocks with
  // cache_control:{type:'ephemeral'} caches the entire schema for ~5 min.
  // Same conversation → 90% cheaper input tokens + ~50% lower TTFT.
  const sys = cacheSystem && typeof system === 'string'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await anthropic.messages.create({
        model,
        ...(sys ? { system: sys } : {}),
        messages,
        max_tokens,
        temperature,
      });
      const text = (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
      return { text, usage: res.usage };
    } catch (e) {
      lastErr = e;
      const msg = e?.message || '';
      const transient = /429|rate|overload|timeout|ECONN|fetch|503|502/i.test(msg);
      if (!transient || attempt === 2) break;
      await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// ─── Gemini call with retry+backoff and per-call model selection ─────────────
async function geminiCall({ system, prompt, json = false, temperature = 0.2, maxTokens = 800, modelName = GEMINI_HEAVY }) {
  if (!geminiClient) throw new Error('No LLM available');
  let lastErr = null;
  // Try requested model, then degrade to faster model on rate-limit
  const candidates = [...new Set([modelName, GEMINI_FAST, 'gemini-2.5-flash'])];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    try {
      const model = geminiClient.getGenerativeModel({
        model: m,
        systemInstruction: system,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(json ? { responseMimeType: 'application/json' } : {}),
        },
      });
      const r = await model.generateContent(prompt);
      return { text: r.response.text().trim(), modelName: m };
    } catch (e) {
      lastErr = e;
      const msg = e?.message || '';
      const transient = /429|quota|rate|resource_exhausted|503|timeout|ECONN/i.test(msg);
      if (!transient || i === candidates.length - 1) break;
      await new Promise(r => setTimeout(r, 200 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error('Gemini failed');
}

// ─── Tolerant JSON extraction ────────────────────────────────────────────────
function extractJson(s) {
  if (!s) throw new Error('Empty AI response');
  let c = s.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const a = c.indexOf('{'), b = c.lastIndexOf('}');
  if (a !== -1 && b > a) c = c.slice(a, b + 1);
  try { return JSON.parse(c); }
  catch {
    const fixed = c.replace(/,\s*([}\]])/g, '$1').replace(/[\r\n]+/g, ' ');
    return JSON.parse(fixed);
  }
}

// ─── Stage 1: Language detection (rule-based, free) ──────────────────────────
const HINDI_RE = /[ऀ-ॿ]/;
const HINGLISH_HINTS = /\b(kitna|kaise|kaisa|batao|dikhao|kitni|hai|hain|kya|mera|hamara|aaj|kal|stock|bikri|bechna|bika|bike|ka|ki|ke|mein|sabse|zyada|kam|mujhe|hume)\b/i;

function detectLanguageFast(text) {
  if (HINDI_RE.test(text)) return 'hi';
  if (HINGLISH_HINTS.test(text)) return 'hinglish';
  return 'en';
}

async function translateIfNeeded(text, lang) {
  if (lang === 'en') return text;
  const provider = activeProvider();
  if (!provider) return text;
  const sys = 'Translate the user message to concise English. Keep entity names (cities, brands, sizes, colors, festivals, channels like COCO/FOFO/EBO/MBO) verbatim. Output only the translation.';
  try {
    if (provider === 'anthropic') {
      const { text: out } = await claudeCall({
        model: HAIKU, system: sys,
        messages: [{ role: 'user', content: text }],
        max_tokens: 200, temperature: 0,
      });
      return out || text;
    }
    const { text: out } = await geminiCall({
      system: sys, prompt: text, temperature: 0, maxTokens: 200, modelName: GEMINI_FAST,
    });
    return out || text;
  } catch (e) {
    logger.warn('Translation failed, using original:', e.message);
    return text;
  }
}

// ─── Stage 3: Intent classification (rule-based, no LLM cost) ────────────────
const INTENTS = {
  GREETING: /^(hi|hello|hey|namaste|good (morning|afternoon|evening)|kaise ho|namaskar)[\s!.?,]*$/i,
  META: /\b(who are you|what can you|capabilit|how do (i|you) use|what (is|are) (your|the))/i,
  TOP_N: /\btop\s+\d+|best\s+\d+|highest|leading|most\b/i,
  STOCK_QUERY: /\b(stock|inventory|qty|quantity|available|on.?hand|out of stock|low stock|safety stock|replenish)\b/i,
  SALES_ANALYSIS: /\b(sales|sold|sell|revenue|performance|how (was|did)|analysis|overview|bikri)\b/i,
  RETURN: /\b(return|returned|return rate|wapsi)\b/i,
  DISPATCH: /\b(dispatch|in.?transit|delivery|delivered|fill rate|courier)\b/i,
  AGEING: /\b(ageing|aging|dead stock|180.*days|stale|liquidat)\b/i,
  COMPARISON: /\b(compare|vs|versus|against|difference between|comparison)\b/i,
  TREND: /\b(trend|growth|decline|over time|month.over.month|year.over.year|yoy|mom|wow)\b/i,
};

function classifyIntent(q) {
  for (const [k, re] of Object.entries(INTENTS)) if (re.test(q)) return k;
  return 'VAGUE';
}

function computeConfidence(q, intent) {
  if (intent === 'GREETING' || intent === 'META') return 100;
  let score = 50;
  if (intent !== 'VAGUE') score += 20;
  if (/\b(today|yesterday|last (week|month|\d+ (days|months|weeks)|year)|this (week|month|year)|fy\s*\d|holi|diwali|festive|summer|winter|monsoon)\b/i.test(q)) score += 15;
  if (/\b(north|south|east|west|central|delhi|mumbai|bihar|kolkata|chennai|bangalore|pune|coco|fofo|ebo|mbo|warehouse|distributor)\b/i.test(q)) score += 10;
  if (/\b(black|white|navy|blue|brown|red|grey|green|slim|regular|skinny|bootcut|size\s*\d+)\b/i.test(q)) score += 10;
  if (q.length < 12) score -= 20;
  return Math.max(0, Math.min(100, score));
}

// ─── Follow-up detection ─────────────────────────────────────────────────────
const FOLLOWUP_RE = /^\s*(now |and |but |what about |how about |compare (with|to)|same for|also for|kya |aur |phir )/i;
function isFollowUp(q) { return FOLLOWUP_RE.test(q) || q.trim().split(/\s+/).length <= 5; }

// ─── Quick replies & follow-up prediction ────────────────────────────────────
function buildQuickReplies(intent, lang) {
  const en = {
    SALES_ANALYSIS: ['Top 10 stores', 'By colour', 'Last 7 days', 'vs last month'],
    STOCK_QUERY: ['Out of stock SKUs', 'Below safety stock', 'By zone', 'Top distributors'],
    TOP_N: ['Bottom 10', 'By revenue', 'By units', 'Last quarter'],
    AGEING: ['Dead stock by store', '90-180 day bucket', 'By zone', 'Liquidation candidates'],
    RETURN: ['Return rate by colour', 'By store', 'Last 30 days', 'Top return SKUs'],
    DISPATCH: ['Pending >5 days', 'Fill rate by channel', 'In-transit', 'By distributor'],
    COMPARISON: ['vs last month', 'vs last year', 'YTD comparison', 'By zone'],
    TREND: ['Last 7 days', 'Last 30 days', 'Last quarter', 'YoY'],
    VAGUE: ['Sales overview', 'Stock alerts', 'Top performers', 'Dead stock'],
    GREETING: ['Sales today', 'Stock alerts', 'Top distributors', 'Pending dispatches'],
    META: ['Sales analysis', 'Stock check', 'Dispatch status', 'Ageing report'],
  };
  // Language localization (concise, business terms English ok in Hinglish)
  if (lang === 'hi') {
    return {
      SALES_ANALYSIS: ['टॉप 10 स्टोर', 'रंग के अनुसार', 'पिछले 7 दिन', 'पिछले महीने से तुलना'],
      STOCK_QUERY: ['आउट ऑफ स्टॉक', 'सेफ्टी स्टॉक से नीचे', 'ज़ोन के अनुसार', 'टॉप डिस्ट्रिब्यूटर'],
      AGEING: ['डेड स्टॉक', '90-180 दिन', 'ज़ोन के अनुसार', 'लिक्विडेशन'],
      VAGUE: ['सेल्स ओवरव्यू', 'स्टॉक अलर्ट', 'टॉप परफॉर्मर', 'डेड स्टॉक'],
    }[intent] || ['सेल्स', 'स्टॉक', 'डिस्पैच', 'एजिंग'];
  }
  return en[intent] || en.VAGUE;
}

// ─── Smart-default assumptions ───────────────────────────────────────────────
function buildAssumptions(question) {
  const a = [];
  if (!/\b(last|today|yesterday|this|days|weeks|months|year|fy|holi|diwali|festive|summer|winter|monsoon|\d{4})\b/i.test(question)) a.push('last 30 days');
  if (!/\b(coco|fofo|ebo|mbo|warehouse|distributor|north|south|east|west|central|delhi|mumbai|bihar|kolkata|chennai|bangalore|pune)\b/i.test(question)) a.push('all India, all channels');
  if (/\btop\b/i.test(question) && !/\btop\s+\d+/i.test(question)) a.push('top 10');
  return a;
}

// ─── Pull rich context from the question for diagnostic empty-data responses
function extractContext(question) {
  const q = question || '';
  const ctx = {};
  // Colour
  const colorMatch = q.match(/\b(black|white|navy|blue|brown|red|grey|gray|green|beige|olive|maroon|charcoal|indigo)\b/i);
  if (colorMatch) ctx.color = colorMatch[1].toLowerCase();
  // Fit
  const fitMatch = q.match(/\b(slim|regular|skinny|bootcut|straight|relaxed|tapered)\b/i);
  if (fitMatch) ctx.fit = fitMatch[1].toLowerCase();
  // Size
  const sizeMatch = q.match(/\bsize\s*(\d{2})\b/i) || q.match(/\b(28|30|32|34|36|38|40|42)\b/);
  if (sizeMatch) ctx.size = sizeMatch[1];
  // Time period
  let period = null;
  const lastN = q.match(/\blast\s+(\d{1,3})\s+(day|days|week|weeks|month|months|year|years)\b/i);
  if (lastN) period = `last ${lastN[1]} ${lastN[2].toLowerCase()}`;
  else if (/\blast\s+month\b/i.test(q)) period = 'last month';
  else if (/\blast\s+week\b/i.test(q)) period = 'last week';
  else if (/\blast\s+year\b/i.test(q)) period = 'last year';
  else if (/\btoday\b/i.test(q)) period = 'today';
  else if (/\byesterday\b/i.test(q)) period = 'yesterday';
  else if (/\bthis\s+month\b/i.test(q)) period = 'this month';
  else if (/\bthis\s+year\b/i.test(q)) period = 'this year';
  else if (/\bdiwali\b/i.test(q)) period = 'Diwali window';
  else if (/\bholi\b/i.test(q)) period = 'Holi window';
  else if (/\bfestive\b/i.test(q)) period = 'festive season';
  if (period) ctx.period = period;
  // Channel
  const ch = q.match(/\b(coco|fofo|ebo|mbo|warehouse|distributor)\b/i);
  if (ch) ctx.channel = ch[1].toUpperCase();
  // Geography
  const geo = q.match(/\b(north|south|east|west|central|delhi|mumbai|bihar|kolkata|chennai|bangalore|pune|hyderabad|ahmedabad|jaipur|patna|lucknow|gurgaon|noida)\b/i);
  if (geo) ctx.geo = geo[1].charAt(0).toUpperCase() + geo[1].slice(1).toLowerCase();
  return ctx;
}

function describeContext(ctx, lang) {
  const parts = [];
  if (lang === 'hi') {
    if (ctx.color) parts.push(`रंग: ${ctx.color}`);
    if (ctx.fit) parts.push(`फिट: ${ctx.fit}`);
    if (ctx.size) parts.push(`साइज़: ${ctx.size}`);
    if (ctx.period) parts.push(`अवधि: ${ctx.period}`);
    if (ctx.channel) parts.push(`चैनल: ${ctx.channel}`);
    if (ctx.geo) parts.push(`क्षेत्र: ${ctx.geo}`);
  } else {
    if (ctx.color) parts.push(`Colour: ${ctx.color}`);
    if (ctx.fit) parts.push(`Fit: ${ctx.fit}`);
    if (ctx.size) parts.push(`Size: ${ctx.size}`);
    if (ctx.period) parts.push(`Period: ${ctx.period}`);
    if (ctx.channel) parts.push(`Channel: ${ctx.channel}`);
    if (ctx.geo) parts.push(`Region: ${ctx.geo}`);
  }
  return parts;
}

// ─── Anomaly detection (z-score on numeric columns) ──────────────────────────
function detectAnomalies(rows) {
  if (!rows.length || rows.length < 4) return [];
  const out = [];
  const cols = Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number');
  const lblCol = Object.keys(rows[0]).find(k => typeof rows[0][k] === 'string');
  for (const col of cols) {
    const vals = rows.map(r => Number(r[col])).filter(v => !Number.isNaN(v));
    if (vals.length < 4) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const sd = Math.sqrt(variance);
    if (sd === 0) continue;
    rows.forEach(r => {
      const z = (Number(r[col]) - mean) / sd;
      if (Math.abs(z) >= 2.2) {
        const lbl = lblCol ? r[lblCol] : 'entry';
        out.push(`${lbl} on ${col.replace(/_/g, ' ')} is ${z > 0 ? 'unusually high' : 'unusually low'} (${fmt(Number(r[col]))})`);
      }
    });
  }
  return out.slice(0, 3);
}

// ─── Conversation memory ─────────────────────────────────────────────────────
async function loadMemory(userId) {
  if (!userId) return null;
  const raw = await rGet(SESSION_PREFIX + userId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function saveMemory(userId, mem) {
  if (!userId) return;
  await rSet(SESSION_PREFIX + userId, JSON.stringify(mem), SESSION_TTL);
}

// ─── Stage 4: SQL generation (Sonnet, with prompt caching) ───────────────────
async function generateSql(englishQuestion, memory, isFollowUpQ) {
  const memBlock = isFollowUpQ && memory?.recent?.length
    ? `\n\nRECENT CONTEXT (resolve follow-up references like "compare with X", "what about Y", "and last year"):\n${memory.recent.slice(-3).map((x, i) => `${i + 1}. Q:"${x.q}" cols:${x.cols || 'n/a'}`).join('\n')}`
    : '';
  const userMsg = englishQuestion + memBlock;
  const provider = activeProvider();
  if (!provider) throw new Error('No LLM provider available');

  if (provider === 'anthropic') {
    const { text } = await claudeCall({
      model: SONNET,
      system: schemaContext(),
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 900,
      temperature: 0.05,
      cacheSystem: true,
    });
    return extractJson(text);
  }
  const { text } = await geminiCall({
    system: schemaContext(),
    prompt: userMsg,
    json: true,
    temperature: 0.05,
    maxTokens: 900,
    modelName: GEMINI_HEAVY,
  });
  return extractJson(text);
}

async function selfHealSql(originalSql, errorMsg, question) {
  const prompt = `Fix this PostgreSQL. Output ONLY {"sql":"...","explanation":"..."}.\nERROR: ${errorMsg}\nSQL: ${originalSql}\nQ: ${question}`;
  const sys = 'You fix broken PostgreSQL. Output JSON only {"sql","explanation"}. Single SELECT/WITH.';
  const provider = activeProvider();
  if (provider === 'anthropic') {
    const { text } = await claudeCall({
      model: SONNET, system: sys,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500, temperature: 0.05,
    });
    return extractJson(text);
  }
  const { text } = await geminiCall({
    system: sys, prompt, json: true, temperature: 0.05, maxTokens: 500, modelName: GEMINI_HEAVY,
  });
  return extractJson(text);
}

// ─── Stage 5: Synthesis (Haiku, with budget race) ────────────────────────────
// Beautifully formatted deterministic fallback (matches the executive
// structure of the LLM prompt: headline → bullets → action). Used when the
// LLM hallucinates, fails, or is bypassed.
function buildFallbackAnswer(rows) {
  if (!rows.length) return 'No matching records found. Try widening the time window or removing a filter.';
  const numeric = Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number');
  if (!numeric.length) return `Found ${rows.length} matching record${rows.length !== 1 ? 's' : ''}.`;

  const isMoney = (c) => /revenue|value|amount|total_value|stock_value|price|mrp|cost/i.test(c);
  const col = numeric.find(c => /revenue|units_sold|qty_on_hand|total_qty|stock|count|total/i.test(c)) || numeric[0];
  const moneyPrefix = isMoney(col) ? '₹' : '';

  const total = rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
  const sorted = [...rows].sort((a, b) => (b[col] || 0) - (a[col] || 0));
  const top = sorted[0];
  const bot = sorted[sorted.length - 1];
  const lblCol = Object.keys(top).find(k => typeof top[k] === 'string');
  const metricName = col.replace(/_/g, ' ');

  // Single-row: produce a clean summary card
  if (rows.length === 1) {
    const lines = numeric.map(k => `▸ ${k.replace(/_/g, ' ')}: ${isMoney(k) ? '₹' : ''}${fmt(top[k])}`);
    return [
      `Headline: ${moneyPrefix}${fmt(top[col])} ${metricName}.`,
      '',
      ...lines,
      '',
      '→ Drill down further by zone, channel, or time window for sharper insight.',
    ].join('\n');
  }

  // Multi-row: headline + ranked bullets + action
  const topLbl = lblCol ? top[lblCol] : 'Top entry';
  const botLbl = lblCol ? bot[lblCol] : 'Lowest entry';
  const topShare = total > 0 ? ` (${((top[col] / total) * 100).toFixed(1)}% of total)` : '';
  const gap = top[col] - bot[col];
  const lines = [
    `${moneyPrefix}${fmt(total)} total ${metricName} across ${rows.length} entries.`,
    '',
    `▸ Top: ${topLbl} at ${moneyPrefix}${fmt(top[col])}${topShare}`,
    `▸ Bottom: ${botLbl} at ${moneyPrefix}${fmt(bot[col])} — gap of ${moneyPrefix}${fmt(gap)} versus the leader`,
  ];
  if (rows.length >= 3) {
    const second = sorted[1];
    const secondLbl = lblCol ? second[lblCol] : 'Runner-up';
    lines.push(`▸ Runner-up: ${secondLbl} at ${moneyPrefix}${fmt(second[col])}`);
  }
  lines.push('', `→ Focus replenishment and incentives on ${botLbl} to close the gap with ${topLbl}.`);
  return lines.join('\n');
}

// ─── Helpers: zero-data detection, markdown strip, hallucination verifier ────
function isAllZero(rows) {
  if (!rows.length) return true;
  const numCols = Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number');
  if (!numCols.length) return false;
  return rows.every(r => numCols.every(c => !r[c] || Number(r[c]) === 0));
}

// Strip ALL markdown / formatting noise so the UI gets clean, presentable
// prose. Runs in passes so nested patterns (e.g. "***word***", "**`x`**") all
// collapse correctly. Also normalises whitespace and inline-numbered lists.
function stripMarkdown(s) {
  if (!s) return s;
  let out = String(s);

  // Strip code fences first
  out = out.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?|```/g, ''));
  out = out.replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1');

  // Inline emphasis — run multiple passes for nested cases (***x***)
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/___([^_]+)___/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1');
  }

  // Headings, blockquotes
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');

  // Links/images: [text](url) → text   ![alt](url) → alt
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Bullets — convert any markdown bullet to our executive bullet "▸"
  out = out.replace(/^\s*[-*+]\s+/gm, '▸ ');
  // Some models emit unicode bullets — normalise all to "▸"
  out = out.replace(/^\s*[•●◆◇■□▪▫]\s+/gm, '▸ ');

  // Horizontal rules
  out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');

  // Any remaining stray formatting characters that survived (DON'T touch ▸ → ₹)
  out = out.replace(/\*{1,3}/g, '');
  out = out.replace(/(^|\s)_{1,3}(?=\s|$)/g, '$1');

  // Inline numbered lists "1. foo 2. bar 3. baz" → convert to "▸ " bullets
  const inlineCount = (out.match(/(?:^|\s)\d{1,2}\.\s/g) || []).length;
  if (inlineCount >= 3) {
    // First, put each item on its own line if not already
    if (!/\n\d{1,2}\.\s/.test(out)) {
      out = out.replace(/\s+(\d{1,2}\.\s)/g, '\n$1');
    }
    // Then convert "1. " "2. " ... at line starts to "▸ "
    out = out.replace(/^\s*\d{1,2}\.\s+/gm, '▸ ');
  }

  // Ensure a blank line before "→" action lines (visual breathing room)
  out = out.replace(/([^\n])\n(→\s)/g, '$1\n\n$2');
  // Ensure a blank line between the headline and the first "▸" bullet block
  out = out.replace(/([^\n])\n(▸\s)/g, '$1\n\n$2');
  // But DON'T add blank lines between consecutive "▸" bullets — collapse them
  out = out.replace(/(▸[^\n]*)\n\n(▸\s)/g, '$1\n$2');

  // Normalise whitespace
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/[ \t]{2,}/g, ' ');

  return out.trim();
}

// Anti-hallucination check: pull every numeric token from the LLM answer and
// ensure each one plausibly appears in the actual data (or is one of the
// safe cross-row aggregates we computed). If the answer contains numbers
// that aren't in the data, throw — synthesis falls back to the deterministic
// summary built from the rows.
function verifyAnswerGrounded(answer, rows) {
  if (!rows.length) return true;
  // Collect every numeric value in rows + their common aggregates
  const allowed = new Set();
  const numCols = Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number');
  for (const r of rows) for (const c of numCols) {
    const v = Number(r[c]);
    if (!Number.isNaN(v)) allowed.add(roundForCompare(v));
  }
  // Add row count + zero
  allowed.add(roundForCompare(rows.length));
  allowed.add(0);
  // Add column-level aggregates (total/avg) — rounded
  for (const c of numCols) {
    const vals = rows.map(r => Number(r[c]) || 0);
    const sum = vals.reduce((s, v) => s + v, 0);
    const avg = sum / vals.length;
    allowed.add(roundForCompare(sum));
    allowed.add(roundForCompare(avg));
    allowed.add(roundForCompare(Math.max(...vals)));
    allowed.add(roundForCompare(Math.min(...vals)));
  }

  // Extract numbers from the answer text (incl. Cr/L/% notations)
  const re = /([0-9]+(?:[.,][0-9]+)?)\s*(cr|crore|l|lakh|lakhs|lac|%)?/gi;
  let m;
  let suspicious = 0;
  let total = 0;
  while ((m = re.exec(answer)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'cr' || unit === 'crore') n *= 1e7;
    else if (unit.startsWith('l') || unit.startsWith('lac')) n *= 1e5;
    else if (unit === '%') {
      // percentages are derived — accept range 0-100
      if (n >= 0 && n <= 100) continue;
    }
    total += 1;
    if (!hasMatchingValue(n, allowed)) suspicious += 1;
  }
  // Allow up to 1 suspicious number IF total is small (rounding tolerance);
  // anything more aggressive is treated as fabrication.
  if (total === 0) return true;
  return suspicious / total < 0.25;
}

function roundForCompare(n) {
  // Round to 2 sig figs for comparison so "12000" matches "12K" formatted
  if (!isFinite(n)) return 0;
  const a = Math.abs(n);
  if (a < 1) return Math.round(n * 100) / 100;
  if (a < 100) return Math.round(n);
  if (a < 10000) return Math.round(n / 10) * 10;
  if (a < 1e7) return Math.round(n / 1000) * 1000;
  return Math.round(n / 1e5) * 1e5;
}
function hasMatchingValue(n, allowed) {
  // ±5% tolerance to absorb rounding/format
  const target = roundForCompare(n);
  if (allowed.has(target)) return true;
  for (const a of allowed) {
    if (a === 0 && n === 0) return true;
    if (a === 0) continue;
    if (Math.abs(n - a) / Math.max(Math.abs(a), 1) <= 0.05) return true;
  }
  return false;
}

// ─── Synthesis (with hallucination guards) ───────────────────────────────────
async function synthesizeAnswer({ question, rows, lang, assumptions, anomalies }) {
  const ctx = extractContext(question);
  const ctxLines = describeContext(ctx, lang);
  const focus = [ctx.color, ctx.fit, ctx.size && `size ${ctx.size}`].filter(Boolean).join(' ');
  const periodLbl = ctx.period || 'the selected period';

  // No rows → executive-grade diagnostic (never just "no data")
  if (!rows.length) {
    const filterBlock = ctxLines.length ? ctxLines.map(l => `▸ ${l}`).join('\n') : '▸ Default filters applied (last 30 days, all India, all channels)';
    if (lang === 'hi') {
      return [
        `${focus ? focus + ' की ' : ''}खोज में कोई रिकॉर्ड नहीं मिला — ${periodLbl}.`,
        '', '▸ लागू किए गए फ़िल्टर:', filterBlock,
        '', 'संभावित कारण:',
        '▸ इस अवधि में संबंधित बिक्री नहीं हुई',
        '▸ रंग/साइज़ का स्टॉक खत्म हो चुका है',
        '▸ ERP सिंक में देरी',
        '', `→ अनुशंसा: "${ctx.period ? `top selling colours ${ctx.period}` : 'top selling colours last 3 months'}" पूछें ताकि देख सकें कि वास्तव में क्या बिक रहा है।`,
      ].join('\n');
    }
    if (lang === 'hinglish') {
      return [
        `${focus ? focus + ' ke liye ' : ''}koi record nahi mila — ${periodLbl}.`,
        '', '▸ Applied filters:', filterBlock,
        '', 'Possible reasons:',
        '▸ Is period mein matching sales nahi hui',
        '▸ Colour/size ka stock zero ho chuka hai',
        '▸ ERP sync gap',
        '', `→ Recommendation: "top selling colours ${ctx.period || 'last 3 months'}" puchhein — dekhein actually kya bik raha hai.`,
      ].join('\n');
    }
    return [
      `No matching records found${focus ? ' for ' + focus : ''} in ${periodLbl}.`,
      '',
      '▸ Filters applied:',
      filterBlock,
      '',
      'Likely reasons:',
      '▸ No qualifying sales recorded in this window',
      `▸ ${ctx.color || 'This category'} inventory may have been zero or out-of-stock`,
      '▸ ERP sync gap — check the last sync timestamp on the dashboard',
      '',
      `→ Recommendation: ask "top selling colours ${ctx.period || 'last 3 months'}" first to see what IS moving, then drill into the gap.`,
    ].join('\n');
  }

  // All-zero numeric data → richest possible diagnostic. NEVER call LLM here.
  if (isAllZero(rows)) {
    const filterBlock = ctxLines.length ? ctxLines.map(l => `▸ ${l}`).join('\n') : '▸ Default filters (last 30 days, all India, all channels)';
    if (lang === 'hi') {
      return [
        `₹0 राजस्व — ${focus ? focus + ' की ' : ''}${periodLbl} में कोई बिक्री दर्ज नहीं हुई।`,
        '', '▸ लागू किए गए फ़िल्टर:', filterBlock,
        '', 'व्यावसायिक संदर्भ:',
        `▸ ${ctx.color || 'इस श्रेणी'} में या तो स्टॉक नहीं है, या मांग समाप्त हो गई है`,
        '▸ अन्य रंग/फिट तेज़ी से बिक रहे होंगे',
        '▸ ERP सिंक की देरी भी संभव कारण है',
        '', `→ तुरंत अनुशंसा: "top 5 colours sold ${ctx.period || 'last 3 months'}" से वास्तविक मांग देखें, फिर ${ctx.color || 'इस'} श्रेणी पर निर्णय लें।`,
      ].join('\n');
    }
    if (lang === 'hinglish') {
      return [
        `₹0 revenue — ${focus ? focus + ' ki ' : ''}${periodLbl} mein koi sale record nahi hui.`,
        '', '▸ Applied filters:', filterBlock,
        '', 'Business context:',
        `▸ ${ctx.color || 'Is category'} mein ya to stock nahi hai, ya demand ruk gayi hai`,
        '▸ Doosre colours/fits zyada bik rahe ho sakte hain',
        '▸ ERP sync delay bhi possible hai',
        '', `→ Immediate recommendation: "top 5 colours sold ${ctx.period || 'last 3 months'}" puchhein — actual demand dekhein, phir ${ctx.color || 'is'} category par decision lein.`,
      ].join('\n');
    }
    return [
      `₹0 revenue — no ${focus || 'matching'} sales recorded in ${periodLbl}.`,
      '',
      '▸ Filters applied:',
      filterBlock,
      '',
      'Business context:',
      `▸ ${ctx.color ? `${ctx.color.charAt(0).toUpperCase() + ctx.color.slice(1)} jeans` : 'This category'} either has no inventory, or demand has dried up`,
      '▸ Other colours or fits may be absorbing the demand',
      '▸ ERP sync delay is also a possible cause — verify the last sync on the dashboard',
      '',
      `→ Recommended next step: ask "top 5 colours sold ${ctx.period || 'last 3 months'}" to see what IS moving, then decide on ${ctx.color || 'this category'}.`,
    ].join('\n');
  }

  const preview = rows.slice(0, 30);
  const cols = Object.keys(rows[0]).join(', ');
  const numericCols = Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number');
  const totals = numericCols.map(c => `${c}: ${fmt(rows.reduce((s, r) => s + (Number(r[c]) || 0), 0))}`).join(' | ');

  const langDirective = lang === 'hi'
    ? 'Reply in natural Hindi (Devanagari). Keep numeric formatting (Cr, L) in Latin script.'
    : lang === 'hinglish'
      ? 'Reply in Hinglish (Roman script Hindi mixed with English business terms — natural code-switch).'
      : 'Reply in concise English.';

  // Executive-grade prompt: CEO/MD audience, richly structured plain text,
  // strict grounding, no markdown (UI does not render it).
  const sys = `You are the senior inventory & retail-strategy analyst briefing the CEO and MD of Spykar Jeans. ${langDirective}

AUDIENCE: CEO/MD. Every line must be sharp, decision-ready, and visually clean.

STRICT OUTPUT FORMAT (this is what the user sees verbatim — no renderer):
Produce richly structured plain text using ONLY these visual elements:
  • Line breaks (single \\n between sections, double \\n between major blocks)
  • The bullet character "▸" for key data points (not "*" or "-")
  • The arrow "→" to introduce the action recommendation
  • Indian numeric formatting: values ≥ 1 crore → "X.X Cr", values ≥ 1 lakh → "X.X L", otherwise comma-separated
  • Currency prefix "₹" for revenue/value figures
ABSOLUTELY FORBIDDEN: asterisks (*, **, ***), underscores (_, __), backticks, hash signs (#), square brackets links, "1." "2." numbered lists, emoji, ALL-CAPS section labels, HTML, tables.

REQUIRED STRUCTURE (4 short blocks separated by blank lines):

  Block 1 — Headline (1 sentence): the single biggest number that answers the question, in plain prose.

  Block 2 — Performance breakdown (2-3 lines, each starting with "▸ "):
    ▸ Top performer with its number and share of total
    ▸ Bottom / under-performer with its number and the gap
    ▸ One additional notable data point if relevant (concentration, surge, dip, channel split)

  Block 3 — Insight (1 sentence): one trend, anomaly, or business implication drawn strictly from the data.

  Block 4 — Action (1 sentence starting with "→ "): one specific, time-bound recommendation a CEO can act on this week.

GROUNDING (violations are fatal):
- Use ONLY numbers, names, colours, sizes, stores, dates that appear EXPLICITLY in the data below. Never invent.
- If a dimension isn't in the columns (e.g. "men's vs women's", "YoY growth", "slim fit share"), do NOT mention it.
- If totals are zero or missing, say so plainly — never manufacture revenue, units, or growth rates.
- Do NOT cite percentages unless directly derivable from the totals shown.
- NEVER mention SQL, database, columns, tables, rows, JSON, "the data shows", "according to".

Length: 6-9 lines total. Tone: confident, concise, board-room calibre.`;

  const anomalyLine = anomalies?.length ? `\nAnomalies detected: ${anomalies.join('; ')}` : '';
  const assumLine = assumptions?.length ? `\nDefaults applied: ${assumptions.join(', ')}` : '';
  const user = `User question: "${question}"
Available columns: ${cols}
Total rows: ${rows.length}
Column totals (sum across all rows): ${totals}
Row sample (first ${preview.length}): ${JSON.stringify(preview)}${anomalyLine}${assumLine}

Write the analyst response now. Use ONLY the numbers above.`;

  const fallback = buildFallbackAnswer(rows);

  const llmPromise = (async () => {
    try {
      const provider = activeProvider();
      let raw;
      if (provider === 'anthropic') {
        const { text } = await claudeCall({
          model: HAIKU, system: sys,
          messages: [{ role: 'user', content: user }],
          max_tokens: 450, temperature: 0.2,
        });
        raw = text;
      } else {
        const { text } = await geminiCall({
          system: sys, prompt: user, temperature: 0.2, maxTokens: 450, modelName: GEMINI_FAST,
        });
        raw = text;
      }
      const cleaned = stripMarkdown(raw || '');
      if (!cleaned) return fallback;
      // Hallucination verifier — if the LLM made up numbers, drop to fallback
      if (!verifyAnswerGrounded(cleaned, rows)) {
        logger.warn('Synthesis output failed grounding check — using deterministic fallback');
        return fallback;
      }
      return cleaned;
    } catch (e) {
      logger.warn('Synthesis LLM failed, using fallback:', e.message);
      return fallback;
    }
  })();

  const timed = new Promise(resolve => setTimeout(() => resolve(null), SYNTHESIS_BUDGET_MS));
  const winner = await Promise.race([llmPromise, timed]);
  return winner || fallback;
}

// ─── General/meta path ───────────────────────────────────────────────────────
async function answerGeneral(question, lang) {
  const langDirective = lang === 'hi'
    ? 'Reply in Hindi (Devanagari).'
    : lang === 'hinglish'
      ? 'Reply in Hinglish.'
      : 'Reply in English.';
  const sys = `Spykar Jeans Inventory Intelligence assistant. ${langDirective} 2-4 sentences. You answer sales, stock, dispatch, ageing, distributor and fill-rate questions across COCO/FOFO/EBO/MBO and zones (North/South/East/West/Central). Suggest a concrete example question. Never mention SQL/internals.`;
  try {
    const provider = activeProvider();
    if (provider === 'anthropic') {
      const { text } = await claudeCall({
        model: HAIKU, system: sys,
        messages: [{ role: 'user', content: question }],
        max_tokens: 250, temperature: 0.4,
      });
      return stripMarkdown(text);
    }
    const { text } = await geminiCall({
      system: sys, prompt: question, temperature: 0.4, maxTokens: 250, modelName: GEMINI_FAST,
    });
    return stripMarkdown(text);
  } catch {
    return 'I am the Spykar inventory intelligence assistant. Ask me about sales, stock, ageing, dispatches, distributors or store performance — across any zone, channel, colour or size.';
  }
}

// ─── Friendly error mapper ───────────────────────────────────────────────────
function friendly(err) {
  const m = err?.message || '';
  if (/api.?key/i.test(m)) return 'AI service misconfigured. Please contact support.';
  if (/429|rate.?limit|overload/i.test(m)) return 'AI is briefly busy. Please retry in a few seconds.';
  if (/timeout/i.test(m)) return 'Query took too long. Try a tighter filter.';
  return 'Something went wrong while answering. Please rephrase and try again.';
}

// ─── runSqlWithTimeout ───────────────────────────────────────────────────────
async function runSqlWithTimeout(sql, ms) {
  const exec = query(sql);
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('SQL timeout')), ms));
  const result = await Promise.race([exec, timer]);
  return result.rows || [];
}

// ─── Cached SQL execution (cross-user reuse) ─────────────────────────────────
async function runSqlCached(sql) {
  const k = SQL_RESULT_PREFIX + crypto.createHash('sha1').update(sql).digest('hex').slice(0, 24);
  const hit = await rGet(k);
  if (hit) {
    try { return JSON.parse(hit); } catch { /* corrupted */ }
  }
  const rows = await runSqlWithTimeout(sql, SQL_TIMEOUT_MS);
  const capped = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  rSet(k, JSON.stringify(capped), SQL_RESULT_TTL).catch(() => {});
  return capped;
}

// ─── Audit log (non-blocking) ────────────────────────────────────────────────
function logQueryAsync(userId, question, sql, rowCount, answer) {
  if (!userId) return;
  query(
    `INSERT INTO ai_query_log (user_id, question, generated_sql, row_count, answer) VALUES ($1,$2,$3,$4,$5)`,
    [userId, question.slice(0, 500), (sql || '').slice(0, 4000), rowCount, (answer || '').slice(0, 4000)]
  ).catch(err => logger.warn('ai_query_log insert failed:', err.message));
}

// ─── Main: queryInventory ────────────────────────────────────────────────────
async function queryInventory(req, res, next) {
  const t0 = Date.now();
  try {
    const { question } = req.body;
    const userId = req.user?.id;
    const userEmail = req.user?.email;

    if (!question || typeof question !== 'string') {
      throw new AppError('Question is required.', 400);
    }
    if (PROMPT_INJECTION.test(question)) {
      throw new AppError('Question contains disallowed instructions. Please rephrase.', 400);
    }
    if (userId && !rateLimit(userId)) {
      throw new AppError('Rate limit reached (30/min). Please slow down.', 429);
    }

    const sanitizedQ = question.replace(/[\r\n]+/g, ' ').slice(0, 500);
    logger.info(`AI Query [${userEmail}]: ${sanitizedQ}`);

    // STAGE 1: Language (rule-based, free)
    const lang = detectLanguageFast(sanitizedQ);

    // STAGE 2: Cache lookups (parallel: exact, loose-semantic, memory)
    const strictKey = CACHE_PREFIX + hashKey([normalizeStrict(sanitizedQ), lang, userId || 'anon']);
    const looseKey = CACHE_LOOSE_PREFIX + hashKey([normalizeLoose(sanitizedQ), lang]);

    const [strictHit, looseHit, memory] = await Promise.all([
      rGet(strictKey),
      rGet(looseKey),
      loadMemory(userId),
    ]);

    if (strictHit) {
      try {
        const cached = JSON.parse(strictHit);
        cached.cached = true;
        cached.processingMs = Date.now() - t0;
        return res.json({ success: true, data: cached });
      } catch { /* corrupted */ }
    }
    // Loose-semantic hit only valid for non-followup queries (avoids
    // returning a stale answer when user is iterating in a session).
    if (looseHit && !isFollowUp(sanitizedQ)) {
      try {
        const cached = JSON.parse(looseHit);
        cached.cached = 'semantic';
        cached.processingMs = Date.now() - t0;
        return res.json({ success: true, data: cached });
      } catch { /* corrupted */ }
    }

    // STAGE 3: Intent + confidence (rule-based)
    const intent = classifyIntent(sanitizedQ);
    const confidence = computeConfidence(sanitizedQ, intent);
    const followUp = isFollowUp(sanitizedQ);

    // GREETING / META → tiny general path
    if (intent === 'GREETING' || intent === 'META') {
      const answer = await answerGeneral(sanitizedQ, lang);
      const data = {
        question: sanitizedQ,
        answer,
        rows: [],
        rowCount: 0,
        quickReplies: buildQuickReplies(intent, lang),
        assumptions: [],
        confidence: 'high',
        needsClarification: false,
        clarifyingQuestion: null,
        language: lang,
        sourceTimestamp: new Date().toISOString(),
        cached: false,
        processingMs: Date.now() - t0,
      };
      logQueryAsync(userId, sanitizedQ, '', 0, answer);
      return res.json({ success: true, data });
    }

    // VERY LOW confidence + not a follow-up → 1 clarifying question
    if (confidence < 40 && !followUp) {
      const data = {
        question: sanitizedQ,
        answer: lang === 'hi'
          ? 'मुझे थोड़ी और जानकारी चाहिए — आप क्या देखना चाहेंगे?'
          : lang === 'hinglish'
            ? 'Aap kya specifically dekhna chahte hain?'
            : 'What aspect would you like to focus on?',
        rows: [],
        rowCount: 0,
        quickReplies: lang === 'hi'
          ? ['राजस्व', 'स्टॉक', 'टॉप परफॉर्मर', 'डेड स्टॉक']
          : ['Revenue', 'Stock health', 'Top performers', 'Dead stock'],
        assumptions: [],
        confidence: 'low',
        needsClarification: true,
        clarifyingQuestion: 'What aspect would you like to focus on?',
        language: lang,
        sourceTimestamp: new Date().toISOString(),
        cached: false,
        processingMs: Date.now() - t0,
      };
      return res.json({ success: true, data });
    }

    // Translate to English for SQL generation if needed
    const englishQ = lang === 'en' ? sanitizedQ : await translateIfNeeded(sanitizedQ, lang);

    // STAGE 4: SQL generation (Sonnet + prompt caching)
    let parsed;
    try {
      parsed = await generateSql(englishQ, memory, followUp);
    } catch (e) {
      logger.error('SQL generation failed:', e?.message);
      throw new AppError(friendly(e), 422);
    }
    if (!parsed?.sql || typeof parsed.sql !== 'string') {
      throw new AppError('Could not formulate a query. Please rephrase.', 422);
    }

    let sql = parsed.sql.trim();
    const upper = sql.toUpperCase();
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      throw new AppError('Only read queries are allowed.', 400);
    }
    if (FORBIDDEN_SQL.test(sql)) {
      throw new AppError('Query blocked for security reasons.', 403);
    }
    if (!/\bLIMIT\s+\d+/i.test(sql)) {
      sql = sql.replace(/;?\s*$/, ` LIMIT ${MAX_ROWS}`);
    }

    // Execute (cached cross-user) with self-heal retry
    let rows;
    try {
      rows = await runSqlCached(sql);
    } catch (e1) {
      logger.warn('SQL attempt 1 failed:', e1.message);
      try {
        const healed = await selfHealSql(sql, e1.message, englishQ);
        const sql2 = (healed?.sql || '').trim();
        if (!sql2 || !/^(SELECT|WITH)\b/i.test(sql2) || FORBIDDEN_SQL.test(sql2)) {
          throw new Error('Self-heal output failed safety check');
        }
        sql = sql2;
        rows = await runSqlCached(sql);
        parsed = healed;
      } catch (e2) {
        logger.error('SQL self-heal failed:', e2.message);
        throw new AppError(friendly(e1), 422);
      }
    }

    // Anomaly + assumptions context for synthesis
    const anomalies = detectAnomalies(rows);
    const assumptions = buildAssumptions(sanitizedQ);

    // STAGE 5: Synthesis with strict budget race
    const answer = await synthesizeAnswer({ question: sanitizedQ, rows, lang, assumptions, anomalies });

    const confLabel = confidence >= 70 ? 'high' : confidence >= 40 ? 'medium' : 'low';

    // Empty / all-zero results → diagnostic quick-replies tailored to the
    // actual question (so the user gets one-tap follow-ups even when the
    // direct answer was empty). Otherwise → intent-based replies.
    let quickReplies;
    const isEmpty = rows.length === 0 || isAllZero(rows);
    if (isEmpty) {
      const ctx2 = extractContext(sanitizedQ);
      const period = ctx2.period || 'last 3 months';
      const en = [
        `Top selling colours ${period}`,
        ctx2.color ? `${ctx2.color.charAt(0).toUpperCase() + ctx2.color.slice(1)} stock across all stores` : 'Out of stock SKUs',
        `Sales by channel ${period}`,
        'Recent ERP sync status',
      ];
      const hi = [
        `सबसे ज़्यादा बिकने वाले रंग ${period}`,
        ctx2.color ? `${ctx2.color} स्टॉक स्थिति` : 'आउट ऑफ स्टॉक SKUs',
        `चैनल अनुसार बिक्री ${period}`,
        'ERP सिंक स्थिति',
      ];
      const hinglish = [
        `Top colours ${period}`,
        ctx2.color ? `${ctx2.color} stock status` : 'Out of stock SKUs',
        `Channel-wise sales ${period}`,
        'ERP sync status',
      ];
      quickReplies = lang === 'hi' ? hi : lang === 'hinglish' ? hinglish : en;
    } else {
      quickReplies = buildQuickReplies(intent, lang);
    }

    const data = {
      question: sanitizedQ,
      answer,
      rows,
      rowCount: rows.length,
      quickReplies,
      assumptions,
      anomalies,
      confidence: confLabel,
      needsClarification: false,
      clarifyingQuestion: null,
      language: lang,
      sourceTimestamp: new Date().toISOString(),
      cached: false,
      processingMs: Date.now() - t0,
      ...(process.env.NODE_ENV === 'development' && { sql, explanation: parsed.explanation || '' }),
    };

    // Cache writes (non-blocking) + memory update
    rSet(strictKey, JSON.stringify({ ...data, cached: false }), CACHE_TTL).catch(() => {});
    rSet(looseKey, JSON.stringify({ ...data, cached: false }), CACHE_TTL).catch(() => {});
    const newMem = memory || { recent: [] };
    newMem.recent = [...(newMem.recent || []).slice(-4), { q: sanitizedQ, cols: Object.keys(rows[0] || {}).join(',') }];
    newMem.lang = lang;
    saveMemory(userId, newMem).catch(() => {});
    logQueryAsync(userId, sanitizedQ, sql, rows.length, answer);

    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ─── Suggested queries ───────────────────────────────────────────────────────
async function getSuggestedQueries(req, res) {
  const suggestions = [
    { category: 'Sales', query: 'Sales analysis last 30 days by colour' },
    { category: 'Sales', query: 'Top 10 stores in Bihar by revenue last 6 months' },
    { category: 'Sales', query: 'How was sales during Diwali 2025' },
    { category: 'Distributors', query: 'Top 5 distributors by total stock for size 34' },
    { category: 'Distributors', query: 'Compare stock levels between Delhi and Mumbai distributors' },
    { category: 'Stock Alerts', query: 'Which COCO stores need urgent replenishment?' },
    { category: 'Stock Alerts', query: 'Show all SKUs below safety stock threshold' },
    { category: 'Ageing', query: 'Dead stock older than 180 days by location' },
    { category: 'Ageing', query: 'Ageing bucket summary across network' },
    { category: 'Dispatch', query: 'Pending dispatches older than 5 days' },
    { category: 'Dispatch', query: 'Fill rate by channel last 30 days' },
    { category: 'Returns', query: 'Returns vs sales last 90 days by colour' },
    { category: 'Colour', query: 'Top 5 colours sold during Holi 2025' },
    { category: 'Size', query: 'Slim fit size 32 black stock across COCO stores' },
    { category: 'Network', query: 'Stock by zone for slim fit jeans' },
  ];
  res.json({ success: true, data: suggestions });
}

// ─── History ─────────────────────────────────────────────────────────────────
async function getHistory(req, res, next) {
  try {
    const result = await query(
      `SELECT question, answer, row_count, created_at FROM ai_query_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
}

// ─── Clear conversation memory ───────────────────────────────────────────────
async function clearMemory(req, res, next) {
  try {
    const userId = req.user?.id;
    if (userId) await rDel(SESSION_PREFIX + userId);
    res.json({ success: true, data: { cleared: true } });
  } catch (err) { next(err); }
}

module.exports = {
  queryInventory,
  getSuggestedQueries,
  getHistory,
  clearMemory,
};
