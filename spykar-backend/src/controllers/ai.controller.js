const { GoogleGenerativeAI } = require('@google/generative-ai');
const { query } = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not configured');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-pro'];
// Pro is the "big gun" used when flash stumbles (self-heal 2nd retry, hard
// questions). Explicit ref so we don't re-derive it each call.
const STRONG_MODEL = 'gemini-2.5-pro';

// ─── Compact Schema Context (minimal tokens, maximum signal) ──────────────────
function buildSchemaContext() {
  const today = new Date().toISOString().split('T')[0];
  return `You are a senior PostgreSQL analyst for Spykar Jeans inventory intelligence. Convert any business question about inventory, sales, returns, dispatches, distributors, stores, SKUs, colours, sizes, zones, ageing, or performance into a correct, efficient SQL query and return JSON only: {"sql":"...","explanation":"..."}.

TABLES (full column list — use any of these):
- inventory_movements(id UUID, location_id UUID, sku_id UUID, movement_type ENUM[SALE,DISPATCH,RECEIPT,RETURN,TRANSFER_OUT,TRANSFER_IN,ADJUSTMENT], qty_change INT, qty_before INT, qty_after INT, reference_id UUID, reference_type VARCHAR, notes TEXT, moved_at TIMESTAMPTZ, synced_from VARCHAR)
- inventory_snapshot(id, location_id, sku_id, qty_on_hand INT, qty_reserved INT, qty_in_transit INT, qty_available INT GENERATED, safety_stock INT, reorder_point INT, last_movement_at TIMESTAMPTZ, snapshot_date DATE, updated_at)
- skus(id UUID, sku_code VARCHAR, product_name VARCHAR, category VARCHAR default 'Jeans', sub_category VARCHAR, color_code VARCHAR, color_name VARCHAR, size VARCHAR, fit_type VARCHAR [Slim/Regular/Skinny/Bootcut], fabric VARCHAR, mrp NUMERIC, cost_price NUMERIC, barcode VARCHAR, hsn_code VARCHAR, is_active BOOL, external_id VARCHAR)
  -- product_name = internal style code (e.g. 'ACTIFS W16'), NOT category
  -- All SKUs are jeans — NEVER filter product_name for 'jeans','denim','trouser','shirt'
  -- Filter by color_name, size, fit_type, sub_category, fabric only
- locations(id UUID, code VARCHAR, name VARCHAR, type ENUM[WAREHOUSE,DISTRIBUTOR,COCO,FOFO,TRANSIT], zone_id INT, city VARCHAR, state VARCHAR, pincode VARCHAR, address TEXT, gstin VARCHAR, contact_name, contact_phone, contact_email, credit_limit NUMERIC, group_name TEXT, is_active BOOL, external_id VARCHAR)
  -- group_name = real channel: 'EBO - SOR','EBO - OR','Alternate - SOR','Alternate - Outright','Alternate - RT','MBO - SOR'
  -- ALWAYS SELECT l.group_name AS channel for display. NEVER display l.type directly.
  -- COCO=company-owned store, FOFO=franchise store, EBO=exclusive brand outlet, MBO=multi-brand outlet
- zones(id INT, code VARCHAR [NORTH/SOUTH/EAST/WEST/CENTRAL], name VARCHAR, is_active)
- dispatch_orders(id UUID, dispatch_no VARCHAR, from_location_id UUID, to_location_id UUID, status ENUM[PENDING,DISPATCHED,IN_TRANSIT,DELIVERED,CANCELLED,PARTIAL], total_skus INT, total_qty INT, total_value NUMERIC, dispatched_at, expected_at, delivered_at TIMESTAMPTZ, courier_name, tracking_no, notes, external_id)
- dispatch_line_items(id, dispatch_id, sku_id, qty_ordered, qty_dispatched, qty_received, unit_cost NUMERIC)
- stock_ageing(id, location_id, sku_id, qty_0_30, qty_31_60, qty_61_90, qty_91_180, qty_180_plus, ageing_date DATE)
- users(id UUID, name, email, role ENUM[SUPER_ADMIN,ADMIN,MANAGER,VIEWER], is_active, last_login_at, created_at)
- sync_logs(id, sync_type, status, source, records_fetched, records_inserted, records_updated, records_failed, started_at, completed_at, duration_ms)
- ai_query_log(id, user_id, question, generated_sql, row_count, answer, created_at)

VIEWS (pre-joined — use when convenient):
- v_inventory_full — (location_id, location_code, location_name, location_type, zone_name, city, state, sku_id, sku_code, product_name, color_code, color_name, size, fit_type, mrp, qty_on_hand, qty_reserved, qty_in_transit, qty_available, safety_stock, reorder_point, is_below_safety, last_movement_at, updated_at) already filtered to active loc+sku.
- v_executive_summary — (location_type, location_count, active_skus, total_stock, total_in_transit, total_stock_value, low_stock_alerts) grouped by location_type.
- v_top_distributors — distributors ranked by total_stock, already filtered to DISTRIBUTOR type.

KEY RULES:
- SALE qty_change is NEGATIVE → use ABS(qty_change) for units sold
- RETURN qty_change is POSITIVE
- Always: COALESCE(SUM(...),0) — never bare SUM/COUNT
- Always filter: l.is_active=true AND s.is_active=true
- Always JOIN skus s ON s.id=im.sku_id, locations l ON l.id=im.location_id
- Date filter: moved_at>='YYYY-MM-DD'::date AND moved_at<'YYYY-MM-DD'::date (half-open)
- Default LIMIT 50 unless user says "all"
- COCO=company stores, FOFO=franchise stores
- CHANNEL DISPLAY: always use l.group_name AS channel — NEVER select l.type for display to users
- Dead stock = qty_180_plus; Low stock = qty_available < safety_stock

COLOR MATCHING:
- Exact color (black,white,navy) → s.color_name ILIKE 'BLACK' (case-insensitive, no wildcards for exact names)
- Color family (brown,blue shades) → s.color_name ILIKE '%BROWN%'

STATE/CITY MATCHING:
- ALWAYS use ILIKE for state and city — never exact equality (=)
- State: l.state ILIKE 'Bihar' (case-insensitive, no wildcards needed for exact state names)
- City: l.city ILIKE 'Patna'
- If ambiguous partial name: l.state ILIKE '%bihar%'

TODAY: ${today}
DATA RANGE: 2024-04-01 to ${today} (use TODAY as the upper bound for all "last N days/months" queries)

FESTIVAL DATES (use your knowledge, resolve to exact dates BEFORE writing SQL):
PRIORITY ORDER — apply the FIRST matching rule:
1. "during N days of [festival] YYYY" OR "N days of [festival] YYYY" OR "during [festival] N days" → N days ENDING ON festival day
   e.g. "during 10 days of Holi 2025" → Holi 2025=Mar 14 → start=Mar 5 → SQL: >=2025-03-05 AND <2025-03-15
   e.g. "5 days of Diwali 2025" → Diwali 2025=Oct 20 → start=Oct 16 → SQL: >=2025-10-16 AND <2025-10-21
2. "during [festival] week" OR "[festival] week" → 7 days ending on festival day
3. "during [festival] YYYY" (no N specified) → 2 days before + festival day + 2 days after (5 days total)
   e.g. "during Holi 2025" → >=2025-03-12 AND <2025-03-17
4. "during [festival]" (no year) → assume current or most recent occurrence, same 5-day window
- "festive season YYYY" → Sep 1 to Nov 30
- "summer YYYY" → Apr 1 to Jun 30; "winter YYYY" → Nov 1 to Jan 31; "monsoon YYYY" → Jul 1 to Sep 30
- "last N days" → relative to ${today}; "last month" → full prev calendar month; "this month" → month start to ${today}
- "FY YYYY" → Apr 1 YYYY to Mar 31 YYYY+1
IMPORTANT: Always resolve festival dates yourself — never leave date as a placeholder in SQL.

QUERY TYPE RULES — CRITICAL:
- "how was sales / how did X perform / sales overview / sales analysis" → ALWAYS return a multi-row breakdown by colour OR by day (DATE(moved_at)), NEVER a single aggregate. Include: units_sold, revenue (units*mrp), and a grouping column.
- "total / count / how many" (single metric) → single aggregate is fine
- "top N" → GROUP BY dimension ORDER BY metric DESC LIMIT N
- "compare / vs / before vs after" → use FILTER or UNION to show multiple periods as columns/rows

EXAMPLES:
Q:"sales analysis of black jeans during 10 days of holi 2025"
→ Holi 2025=Mar 14. 10 days ending Mar 14 → start=Mar 5. "jeans" is ignored (all SKUs are jeans). Breakdown by day.
→ {"sql":"SELECT DATE(im.moved_at) AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND s.color_name ILIKE 'BLACK' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-03-05'::date AND im.moved_at<'2025-03-15'::date GROUP BY DATE(im.moved_at) ORDER BY sale_date","explanation":"Daily black sales during 10 days of Holi 2025 (Mar 5-14)"}

Q:"black units sold during 5 days holi 2025"
→ Holi 2025=Mar 14. 5 days ending Mar 14 → start=Mar 10.
→ {"sql":"SELECT COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND s.color_name ILIKE 'BLACK' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-03-10'::date AND im.moved_at<'2025-03-15'::date","explanation":"Black units sold in 5 days of Holi 2025"}

Q:"how was sales during holi 2025"
→ Holi 2025=Mar 14. "during" with no N → 5-day window: Mar 12–16.
→ {"sql":"SELECT DATE(im.moved_at) AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue, COUNT(DISTINCT im.location_id) AS stores_active FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-03-12'::date AND im.moved_at<'2025-03-17'::date GROUP BY DATE(im.moved_at) ORDER BY sale_date","explanation":"Daily sales breakdown during Holi 2025 (Mar 12-16)"}

Q:"top 5 colours sold during diwali 2025"
→ Diwali 2025=Oct 20. "during" with no N → 5-day window: Oct 18–22.
→ {"sql":"SELECT s.color_name,COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-10-18'::date AND im.moved_at<'2025-10-23'::date GROUP BY s.color_name ORDER BY units_sold DESC LIMIT 5","explanation":"Top 5 colours by sales during Diwali 2025 (Oct 18-22)"}

Q:"sales analysis last 30 days"
→ {"sql":"SELECT DATE(im.moved_at) AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='${today}'::date - INTERVAL '30 days' AND im.moved_at<'${today}'::date + INTERVAL '1 day' GROUP BY DATE(im.moved_at) ORDER BY sale_date","explanation":"Daily sales for last 30 days"}

Q:"top 10 stores in Bihar by sales in last 6 months"
→ {"sql":"SELECT l.name AS store_name, l.group_name AS channel, l.city, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND l.state ILIKE 'Bihar' AND im.moved_at>='${today}'::date - INTERVAL '6 months' AND im.moved_at<'${today}'::date + INTERVAL '1 day' GROUP BY l.id, l.name, l.group_name, l.city ORDER BY units_sold DESC LIMIT 10","explanation":"Top 10 Bihar stores by units sold in last 6 months"}

Q:"dead stock older than 180 days by location"
→ {"sql":"SELECT l.name AS store_name, l.group_name AS channel, l.city, l.state, COALESCE(SUM(sa.qty_180_plus),0) AS dead_units FROM stock_ageing sa JOIN locations l ON l.id=sa.location_id JOIN skus s ON s.id=sa.sku_id WHERE l.is_active=true AND s.is_active=true AND sa.qty_180_plus>0 GROUP BY l.id, l.name, l.group_name, l.city, l.state ORDER BY dead_units DESC LIMIT 50","explanation":"Dead stock (180+ days) aggregated by store"}

Q:"ageing bucket summary across network"
→ {"sql":"SELECT COALESCE(SUM(sa.qty_0_30),0) AS days_0_30, COALESCE(SUM(sa.qty_31_60),0) AS days_31_60, COALESCE(SUM(sa.qty_61_90),0) AS days_61_90, COALESCE(SUM(sa.qty_91_180),0) AS days_91_180, COALESCE(SUM(sa.qty_180_plus),0) AS days_180_plus FROM stock_ageing sa JOIN locations l ON l.id=sa.location_id JOIN skus s ON s.id=sa.sku_id WHERE l.is_active=true AND s.is_active=true","explanation":"Total units across ageing buckets network-wide"}

Q:"pending dispatches older than 5 days"
→ {"sql":"SELECT d.dispatch_no, fl.name AS from_location, tl.name AS to_location, tl.group_name AS channel, d.status, d.total_qty, d.total_value, d.dispatched_at, d.expected_at FROM dispatch_orders d JOIN locations fl ON fl.id=d.from_location_id JOIN locations tl ON tl.id=d.to_location_id WHERE d.status IN ('PENDING','DISPATCHED','IN_TRANSIT') AND d.dispatched_at < '${today}'::date - INTERVAL '5 days' ORDER BY d.dispatched_at ASC LIMIT 50","explanation":"Pending/in-transit dispatches older than 5 days"}

Q:"fill rate by channel last 30 days"
→ {"sql":"SELECT l.group_name AS channel, COALESCE(SUM(dli.qty_dispatched),0) AS dispatched_units, COALESCE(SUM(dli.qty_ordered),0) AS ordered_units, ROUND((COALESCE(SUM(dli.qty_dispatched),0)::numeric / NULLIF(SUM(dli.qty_ordered),0))*100, 2) AS fill_rate_pct FROM dispatch_orders d JOIN dispatch_line_items dli ON dli.dispatch_id=d.id JOIN locations l ON l.id=d.to_location_id WHERE l.is_active=true AND d.dispatched_at>='${today}'::date - INTERVAL '30 days' GROUP BY l.group_name ORDER BY fill_rate_pct DESC","explanation":"Fill rate (dispatched/ordered) by channel for last 30 days"}

Q:"stock alerts — out of stock SKUs"
→ {"sql":"SELECT l.name AS store_name, l.group_name AS channel, l.city, s.sku_code, s.product_name, s.color_name, s.size, i.qty_on_hand, i.safety_stock, i.reorder_point FROM inventory_snapshot i JOIN locations l ON l.id=i.location_id JOIN skus s ON s.id=i.sku_id WHERE l.is_active=true AND s.is_active=true AND i.qty_on_hand=0 ORDER BY l.name, s.sku_code LIMIT 50","explanation":"Out-of-stock SKUs across active locations"}

Q:"top distributors by stock value"
→ {"sql":"SELECT location_name, zone_name, city, total_stock, total_stock_value FROM v_top_distributors ORDER BY total_stock_value DESC NULLS LAST LIMIT 10","explanation":"Top distributors ranked by stock value (using pre-joined view)"}

Q:"returns vs sales last 90 days by colour"
→ {"sql":"SELECT s.color_name, COALESCE(SUM(CASE WHEN im.movement_type='SALE' THEN ABS(im.qty_change) ELSE 0 END),0) AS units_sold, COALESCE(SUM(CASE WHEN im.movement_type='RETURN' THEN im.qty_change ELSE 0 END),0) AS units_returned, ROUND((COALESCE(SUM(CASE WHEN im.movement_type='RETURN' THEN im.qty_change ELSE 0 END),0)::numeric / NULLIF(SUM(CASE WHEN im.movement_type='SALE' THEN ABS(im.qty_change) ELSE 0 END),0))*100, 2) AS return_rate_pct FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE l.is_active=true AND s.is_active=true AND im.moved_at>='${today}'::date - INTERVAL '90 days' AND im.movement_type IN ('SALE','RETURN') GROUP BY s.color_name ORDER BY units_sold DESC LIMIT 20","explanation":"Return rate per colour for last 90 days"}

Q:"slim fit size 32 black stock across COCO stores"
→ {"sql":"SELECT l.name AS store_name, l.city, l.state, COALESCE(SUM(i.qty_on_hand),0) AS units_on_hand, COALESCE(SUM(i.qty_available),0) AS units_available FROM inventory_snapshot i JOIN locations l ON l.id=i.location_id JOIN skus s ON s.id=i.sku_id WHERE l.is_active=true AND s.is_active=true AND l.type='COCO' AND s.fit_type ILIKE 'Slim' AND s.size='32' AND s.color_name ILIKE 'BLACK' GROUP BY l.id, l.name, l.city, l.state ORDER BY units_on_hand DESC LIMIT 50","explanation":"Slim fit size-32 black stock at COCO stores"}

Return ONLY valid JSON. No markdown, no extra text.`;
}

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|REPLACE)\b/i;

// ─── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(error) {
  const msg = error?.message || '';
  return /quota|rate.?limit|resource_exhausted|429|too many/i.test(msg);
}

function isModelNotFoundError(error) {
  const msg = error?.message || '';
  return /not found|404|model.*unavailable/i.test(msg);
}

// ─── generateWithFallback — retries with backoff on rate-limit ─────────────────
async function generateWithFallback(prompt, systemInstruction, generationConfig) {
  const candidates = [...new Set([PRIMARY_MODEL, ...FALLBACK_MODELS])];
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const modelName = candidates[i];
    try {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction, generationConfig });
      const result = await model.generateContent(prompt);
      return { result, modelName };
    } catch (error) {
      lastError = error;
      logger.warn(`Gemini [${modelName}] failed: ${error?.message?.substring(0, 120)}`);

      if (isRateLimitError(error)) {
        // Exponential backoff: 2s, 4s, 8s between models
        const waitMs = Math.min(2000 * Math.pow(2, i), 10000);
        logger.info(`Rate limit on ${modelName}, waiting ${waitMs}ms before next model`);
        await sleep(waitMs);
      }
      // Model not found → try next immediately (no point waiting)
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

function extractJsonPayload(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') throw new Error('Empty AI response');

  // Strip markdown code fences and leading/trailing whitespace
  let clean = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  // Gemini 2.5 sometimes wraps with extra text — extract the first JSON object
  const jsonStart = clean.indexOf('{');
  const jsonEnd = clean.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    clean = clean.slice(jsonStart, jsonEnd + 1);
  }

  try {
    return JSON.parse(clean);
  } catch (e) {
    // Last resort: try to fix common issues (trailing commas, unescaped newlines in strings)
    const fixed = clean
      .replace(/,\s*([}\]])/g, '$1')           // remove trailing commas
      .replace(/[\r\n]+/g, ' ')                 // flatten newlines
      .replace(/\\'/g, "'");                    // fix escaped single quotes
    try {
      return JSON.parse(fixed);
    } catch {
      throw new Error(`Invalid JSON from AI: ${e.message}`);
    }
  }
}

function formatMetric(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return String(value);
  if (Math.abs(value) >= 10000000) return `${(value / 10000000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100000) return `${(value / 100000).toFixed(1)}L`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
}

function prettifyColumnName(name) { return name.replace(/_/g, ' '); }

function findNumericColumn(rows) {
  if (!rows.length) return null;
  const preferred = ['units_sold','units_returned','total_stock','stock_value','qty_on_hand','qty_available','total_qty','revenue','count'];
  for (const col of preferred) if (typeof rows[0][col] === 'number') return col;
  return Object.keys(rows[0]).find((col) => typeof rows[0][col] === 'number') || null;
}

function findLabelColumn(rows) {
  if (!rows.length) return null;
  const preferred = ['color_name','size','location_name','name','city','sku_code','status'];
  for (const col of preferred) if (typeof rows[0][col] === 'string') return col;
  return Object.keys(rows[0]).find((col) => typeof rows[0][col] === 'string') || null;
}

function buildFallbackSummary(question, rows) {
  if (!rows.length) return 'No matching records found for this query. The data may not exist for the specified filters or the stock may be zero.';
  const numericCol = findNumericColumn(rows);
  const labelCol = findLabelColumn(rows);
  if (!numericCol) return `Found ${rows.length} matching record${rows.length !== 1 ? 's' : ''}.`;

  const validRows = rows.filter((r) => typeof r[numericCol] === 'number' && !Number.isNaN(r[numericCol]));
  if (!validRows.length) return `Found ${rows.length} matching record${rows.length !== 1 ? 's' : ''}.`;

  const total = validRows.reduce((s, r) => s + r[numericCol], 0);
  const sorted = [...validRows].sort((a, b) => b[numericCol] - a[numericCol]);
  const top = sorted[0];
  const bot = sorted[sorted.length - 1];
  const metric = prettifyColumnName(numericCol);

  if (validRows.length === 1) {
    const lbl = labelCol ? ` for ${top[labelCol]}` : '';
    // For single-value aggregates, give full context
    const allMetrics = Object.entries(top)
      .filter(([, v]) => typeof v === 'number' && !Number.isNaN(v))
      .map(([k, v]) => `${prettifyColumnName(k)}: ${formatMetric(v)}`)
      .join(' | ');
    return allMetrics ? `${allMetrics}${lbl}.` : `${metric} is ${formatMetric(top[numericCol])}${lbl}.`;
  }
  const topLbl = labelCol ? top[labelCol] : 'top entry';
  const botLbl = labelCol ? bot[labelCol] : 'lowest entry';
  return `Across ${validRows.length} results, total ${metric} is ${formatMetric(total)}. ${topLbl} leads with ${formatMetric(top[numericCol])}, while ${botLbl} has the lowest at ${formatMetric(bot[numericCol])}.`;
}

function isWeakAnswer(answer) {
  if (!answer) return true;
  const t = answer.trim();
  if (t.length < 40) return true;
  if (t.split(/\s+/).length < 8) return true;
  if (/^(i (cannot|can't|don't)|sorry|unfortunately)/i.test(t)) return true;
  if (/\b(sql|query|database|table|column|json)\b/i.test(t)) return true;
  return false;
}

function toUserFacingGeminiMessage(error) {
  const msg = error?.message || '';
  if (/api.?key/i.test(msg)) return 'AI service error: invalid API key. Please contact support.';
  if (/quota|rate.?limit|resource_exhausted|429/i.test(msg)) return 'AI is temporarily busy. Please wait a few seconds and try again.';
  if (/not found|404/i.test(msg)) return 'AI model unavailable. Please try again shortly.';
  if (/permission|forbidden|403/i.test(msg)) return 'AI access denied. Please contact support.';
  return `AI request failed: ${msg.substring(0, 100)}`;
}

// ─── Intent classification ────────────────────────────────────────────────────
// Fast pre-filter: questions that are almost certainly NOT SQL data pulls get
// routed to the general-knowledge path instead of wasting a Gemini call trying
// to force a SELECT. Precision matters more than recall here — if in doubt,
// fall through to the SQL path (the existing pipeline handles that well).
const GENERAL_PATTERNS = [
  /^(hi|hello|hey|namaste|good (morning|afternoon|evening))[\s!.?,]*$/i,
  /^(thanks|thank you|thx|ok|okay|cool|great|nice)[\s!.?,]*$/i,
  /\bwho (are|r) (you|u)\b/i,
  /\bwhat can you (do|help)\b/i,
  /\bhow do (i|you) use\b/i,
  /\bwhat (is|are) (your|the) (capabilit|feature)/i,
  /\b(explain|define|what does .* mean|meaning of)\b.*\b(reorder point|safety stock|dead stock|fill rate|ageing|sell.?through|stock turn|COCO|FOFO|EBO|MBO|SOR|outright)\b/i,
  /\bhow (should|do|can) (i|we) (handle|reduce|manage|improve|analyz)/i,
  /\b(best practice|recommend|suggestion|advice|tips?)\b/i,
  /\b(spykar|platform|dashboard|system)\b.*\b(about|overview|work|does)\b/i,
];

function looksLikeGeneralQuestion(question) {
  if (!question || typeof question !== 'string') return false;
  const q = question.trim();
  if (q.length < 3) return true;
  return GENERAL_PATTERNS.some((re) => re.test(q));
}

async function answerGeneralQuestion(question) {
  const system = `You are the Spykar Jeans Inventory Intelligence assistant — a senior retail analyst and supply-chain expert who also knows this platform inside out.

Platform overview:
- Spykar is an Indian denim brand. This platform tracks inventory, sales, dispatches, ageing, stock alerts and distributor performance across COCO (company-owned), FOFO (franchise), EBO (exclusive brand outlet) and MBO (multi-brand outlet) channels.
- Pages available: Overview (KPIs, stock alerts, ageing drill-down), Sales (colour/day/store breakdowns), Network (store-level stock by zone/state/city), Dispatches, Distributors, SKU analytics.
- Ask me natural-language questions about inventory, sales, dispatch, ageing, dead stock, fill rate, reorder needs, distributor rankings, colour/size/fit breakdowns, store performance, festival/seasonal analysis, etc. — I will run live SQL and return insights.

Retail domain expertise you should draw on:
- Safety stock = buffer to absorb demand variability; reorder point = when to raise a PO; dead stock = SKUs with 180+ days of no movement; fill rate = dispatched qty / ordered qty; sell-through = units sold / units received.
- Channel economics: SOR (sale-or-return) lets retailer return unsold stock; Outright = retailer owns risk.

Answer the user's question in 3-6 sentences, concrete and helpful. If they are asking what you can do, give a crisp list of 4-6 capabilities with example questions. If they are asking a retail-domain concept, explain it plainly and say how it shows up in this platform. Never mention SQL, tables, columns, JSON or internals.`;

  const { result } = await generateWithFallback(
    question,
    system,
    { temperature: 0.4, maxOutputTokens: 500 }
  );
  return result.response.text().trim();
}

// ─── Main Query Handler ────────────────────────────────────────────────────────
async function queryInventory(req, res, next) {
  try {
    const { question } = req.body;
    logger.info(`AI Query [${req.user?.email}]: ${question}`);

    // Step 0: Route greetings / meta / domain-concept questions to a tiny
    // general-knowledge path. This skips the ~3KB schema prompt entirely for
    // non-data questions — big token saving on the "what can you do" traffic.
    if (looksLikeGeneralQuestion(question)) {
      try {
        const answer = await answerGeneralQuestion(question);
        query(
          `INSERT INTO ai_query_log (user_id, question, generated_sql, row_count, answer) VALUES ($1,$2,$3,$4,$5)`,
          [req.user.id, question, '', 0, answer]
        ).catch((err) => logger.warn('ai_query_log insert failed:', err.message));
        return res.json({
          success: true,
          data: {
            question,
            answer,
            explanation: '',
            rows: [],
            rowCount: 0,
            model: PRIMARY_MODEL,
          },
        });
      } catch (genErr) {
        // Fall through to SQL path if general answer fails — still useful.
        logger.warn('General-answer path failed, falling back to SQL:', genErr?.message);
      }
    }

    let parsed;
    let rawContent = '';
    let sqlModelUsed = PRIMARY_MODEL;

    // Step 1: Generate SQL
    try {
      const { result: sqlResult, modelName } = await generateWithFallback(
        question,
        buildSchemaContext(),
        { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 1200 }
      );
      sqlModelUsed = modelName;
      rawContent = sqlResult.response.text()?.trim() || '';
      parsed = extractJsonPayload(rawContent);
    } catch (parseErr) {
      logger.error('Gemini SQL generation failed', { error: parseErr?.message, raw: rawContent.substring(0, 300) });
      throw new AppError(toUserFacingGeminiMessage(parseErr), 422);
    }

    if (!parsed?.sql || typeof parsed.sql !== 'string') {
      throw new AppError('AI did not return a valid query. Please rephrase and try again.', 422);
    }

    const sqlTrimmed = parsed.sql.trim();
    const sqlUpper = sqlTrimmed.toUpperCase();
    if (!sqlUpper.startsWith('SELECT') && !sqlUpper.startsWith('WITH')) {
      throw new AppError('AI returned a non-SELECT query. Blocked for safety.', 400);
    }
    if (FORBIDDEN_SQL.test(sqlTrimmed)) {
      throw new AppError('Query blocked for security reasons.', 403);
    }

    // Step 2: Execute SQL (with 2-attempt self-heal on failure)
    // Attempt 1: lean retry on same model with compact "fix" prompt (no full
    //            schema resend — just the SQL + error, which is all Gemini
    //            actually needs for typo/column-name fixes).
    // Attempt 2: escalate to STRONG_MODEL (Pro) with the full schema — this is
    //            the "big gun" for structurally wrong queries.
    let queryResult;
    let currentSql = sqlTrimmed;
    let healedOn = null;
    try {
      queryResult = await query(sqlTrimmed);
    } catch (sqlErr1) {
      logger.warn('AI SQL attempt-1 failed, lean retry:', sqlErr1.message);

      // ── Attempt 1: lean fix, same model, NO schema resend ───────────────
      try {
        const leanPrompt = `The SQL below failed. Return ONLY {"sql":"...","explanation":"..."} with a corrected single SELECT/WITH statement.\nERROR: ${sqlErr1.message}\nSQL: ${currentSql}\nQUESTION: ${question}`;
        const { result: fix1 } = await generateWithFallback(
          leanPrompt,
          'You fix broken PostgreSQL. Only output JSON {"sql","explanation"}. No markdown.',
          { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 500 }
        );
        const fixed1 = extractJsonPayload(fix1.response.text()?.trim() || '');
        const sql1 = (fixed1?.sql || '').trim();
        if (!sql1 || !/^(SELECT|WITH)\b/i.test(sql1) || FORBIDDEN_SQL.test(sql1)) {
          throw new Error('Attempt-1 output failed safety check');
        }
        queryResult = await query(sql1);
        parsed = fixed1;
        currentSql = sql1;
        healedOn = sqlModelUsed + '+lean';
      } catch (sqlErr2) {
        logger.warn('AI SQL attempt-2 (escalate to Pro) after:', sqlErr2.message);

        // ── Attempt 2: escalate to STRONG_MODEL with full schema ─────────
        try {
          const model = genAI.getGenerativeModel({
            model: STRONG_MODEL,
            systemInstruction: buildSchemaContext(),
            generationConfig: { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 800 },
          });
          const escalatePrompt = `Previous attempts failed.\nATTEMPT-1 ERROR: ${sqlErr1.message}\nATTEMPT-1 SQL: ${sqlTrimmed}\nATTEMPT-2 ERROR: ${sqlErr2.message}\nATTEMPT-2 SQL: ${currentSql}\nQUESTION: ${question}\nReturn corrected JSON only.`;
          const proResult = await model.generateContent(escalatePrompt);
          const fixed2 = extractJsonPayload(proResult.response.text()?.trim() || '');
          const sql2 = (fixed2?.sql || '').trim();
          if (!sql2 || !/^(SELECT|WITH)\b/i.test(sql2) || FORBIDDEN_SQL.test(sql2)) {
            throw new Error('Attempt-2 output failed safety check');
          }
          queryResult = await query(sql2);
          parsed = fixed2;
          currentSql = sql2;
          sqlModelUsed = STRONG_MODEL;
          healedOn = STRONG_MODEL + '+escalated';
        } catch (finalErr) {
          logger.error('AI self-heal exhausted', { error: finalErr?.message });
          throw new AppError(`Could not execute query: ${sqlErr1.message}`, 422);
        }
      }
      if (healedOn) logger.info(`AI self-healed SQL via ${healedOn}`);
    }

    // Step 3: Generate human answer (skip Gemini call if no rows — use fallback directly)
    const fallbackSummary = buildFallbackSummary(question, queryResult.rows);
    let humanAnswer = fallbackSummary;

    if (queryResult.rows.length > 0) {
      try {
        // Preview sizing: 1 row → just send it; ranking/breakdown → top 25
        // (token-friendly vs 50) to give enough context for top/bottom calls.
        const previewRows = queryResult.rows.slice(0, 25);
        const totalRows = queryResult.rows.length;
        const columns = Object.keys(queryResult.rows[0]).join(', ');

        // Compute totals for context (helps the LLM lead with the big number)
        const numericCols = Object.keys(queryResult.rows[0]).filter(k => typeof queryResult.rows[0][k] === 'number');
        const totals = numericCols.map(col => {
          const sum = queryResult.rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
          return `${col}: ${formatMetric(sum)}`;
        }).join(', ');

        const answerPrompt = `User asked: "${question}"
Columns: ${columns}
Rows: ${totalRows} | Totals: ${totals}
Top ${previewRows.length}: ${JSON.stringify(previewRows)}

Write a sharp 3-5 sentence business insight:
- Lead with the biggest number (total units, revenue, or top performer)
- Call out top and bottom performers for rankings/breakdowns
- Flag any notable spike, trend, concentration or anomaly
- Indian number format: ≥1Cr → "X.X Cr", ≥1L → "X.X L"
- Never say SQL/database/rows/columns/tables/JSON/"the data shows"
- Tone: senior analyst briefing management — direct, insight-driven`;

        const { result: answerResult } = await generateWithFallback(
          answerPrompt,
          'Senior Spykar Jeans inventory analyst. Output plain-English insights only. No technical terms.',
          { temperature: 0.3, maxOutputTokens: 500 }
        );
        const candidate = answerResult.response.text().trim();
        humanAnswer = isWeakAnswer(candidate) ? fallbackSummary : candidate;
      } catch (answerErr) {
        logger.warn('Answer generation failed, using fallback:', answerErr?.message);
        humanAnswer = fallbackSummary;
      }
    }

    // Step 4: Log (non-blocking)
    query(
      `INSERT INTO ai_query_log (user_id, question, generated_sql, row_count, answer) VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, question, parsed.sql, queryResult.rows.length, humanAnswer]
    ).catch((err) => logger.warn('ai_query_log insert failed:', err.message));

    res.json({
      success: true,
      data: {
        question,
        answer: humanAnswer,
        explanation: parsed.explanation || '',
        rows: queryResult.rows,
        rowCount: queryResult.rows.length,
        model: sqlModelUsed,
        ...(process.env.NODE_ENV === 'development' && { sql: parsed.sql }),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Suggested Queries ─────────────────────────────────────────────────────────
async function getSuggestedQueries(req, res) {
  const suggestions = [
    { category: 'Distributors', query: 'Show top 5 distributors by total stock for size 34' },
    { category: 'Distributors', query: 'Which distributors in North zone have less than 100 units?' },
    { category: 'Distributors', query: 'Compare stock levels between Delhi and Mumbai distributors' },
    { category: 'Stock Alerts', query: 'Which locations are out of stock for size 32?' },
    { category: 'Stock Alerts', query: 'Show all SKUs below safety stock threshold' },
    { category: 'Stock Alerts', query: 'Which COCO stores need urgent replenishment?' },
    { category: 'Size Analysis', query: 'What is the total stock distribution across all sizes?' },
    { category: 'Size Analysis', query: 'Which size is running critically low across all distributors?' },
    { category: 'Color Analysis', query: 'Show inventory split by color for slim fit jeans' },
    { category: 'Color Analysis', query: 'Which color has the highest stock in warehouses?' },
    { category: 'Dispatch', query: 'How many units are currently in transit to COCO stores?' },
    { category: 'Dispatch', query: 'Show pending dispatches older than 5 days' },
    { category: 'Ageing', query: 'Which locations have the highest dead stock older than 180 days?' },
    { category: 'COCO', query: 'Show all COCO store inventory ranked by total stock' },
    { category: 'Warehouses', query: 'What is the total available stock in each warehouse?' },
  ];
  res.json({ success: true, data: suggestions });
}

// ─── Query History ─────────────────────────────────────────────────────────────
async function getHistory(req, res, next) {
  try {
    const result = await query(
      `SELECT question, answer, row_count, created_at FROM ai_query_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { queryInventory, getSuggestedQueries, getHistory };
