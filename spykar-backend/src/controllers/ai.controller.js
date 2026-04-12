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

// ─── Universal Schema Context ─────────────────────────────────────────────────
function buildSchemaContext() {
  const today = new Date().toISOString().split('T')[0];
  return `You are a senior PostgreSQL analyst for Spykar Jeans. Convert ANY business question to SQL. Return JSON only: {"sql":"...","explanation":"..."}.

TABLES:
- inventory_movements(id,location_id,sku_id,movement_type ENUM[SALE,DISPATCH,RECEIPT,RETURN,TRANSFER_OUT,TRANSFER_IN,ADJUSTMENT],qty_change INT,moved_at TIMESTAMPTZ)
- inventory_snapshot(location_id,sku_id,qty_on_hand,qty_reserved,qty_in_transit,qty_available,safety_stock,reorder_point,updated_at)
- skus(id,sku_code,product_name,color_code,color_name,size,fit_type,mrp,is_active)
- locations(id,code,name,type ENUM[WAREHOUSE,DISTRIBUTOR,COCO,FOFO],group_name,zone_id,city,state,is_active)
- zones(id,code,name)
- dispatch_orders(id,dispatch_no,from_location_id,to_location_id,status,total_qty,total_value,dispatched_at,expected_at,delivered_at)
- dispatch_line_items(id,dispatch_id,sku_id,qty_ordered,qty_dispatched,qty_received)
- stock_ageing(location_id,sku_id,qty_0_30,qty_31_60,qty_61_90,qty_91_180,qty_180_plus,ageing_date)

═══ TABLE SELECTION — MOST CRITICAL RULE ═══
"current stock / in stock / stock now / stock analysis / stock position / how much stock / inventory / on hand / available / stock by X / stock overview / network stock / store stock"
→ USE inventory_snapshot (alias i) JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id
→ NO date filter, NO AT TIME ZONE — snapshot is always current/live
→ qty_on_hand = total physical stock | qty_available = sellable stock

"sold / sales / revenue / how many sold / selling / performance / how was sales / sales analysis"
→ USE inventory_movements im WHERE movement_type='SALE'

"return / returned / returns"
→ USE inventory_movements im WHERE movement_type='RETURN'

"dispatched / dispatch / in transit / shipment / pending"
→ USE dispatch_orders / dispatch_line_items

"dead stock / ageing / old stock / slow moving"
→ USE stock_ageing JOIN locations l ON l.id=sa.location_id JOIN skus s ON s.id=sa.sku_id

"low stock / below safety / reorder / replenishment needed"
→ USE inventory_snapshot WHERE qty_available < safety_stock

═══ INVENTORY MOVEMENTS RULES ═══
- SALE qty_change is NEGATIVE → use ABS(qty_change) for units sold
- RETURN qty_change is POSITIVE → SUM(qty_change) directly, NEVER ABS() or qty_change<0
- RECEIPT/TRANSFER_IN qty_change POSITIVE; TRANSFER_OUT/ADJUSTMENT can be either
- Date filter: moved_at>='YYYY-MM-DD'::date AND moved_at<'YYYY-MM-DD'::date
- IST grouping: DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') AS sale_date

═══ GENERAL RULES ═══
- Always COALESCE(SUM(...),0) — never bare SUM
- Always filter l.is_active=true AND s.is_active=true
- LIMIT: breakdown GROUP BY → LIMIT 200; top-N → LIMIT N; single aggregate → no LIMIT; "all" → no LIMIT
- COLOR: always use ILIKE '%COLOR%' (e.g. black → s.color_name ILIKE '%BLACK%', covers JET BLACK, CHARCOAL BLACK etc.)

TODAY: ${today}
DATA RANGE: 2024-04-01 to 2026-01-31

═══ DATE SHORTCUTS ═══
- "last N days" → ${today}::date - INTERVAL 'N days' to ${today}
- "last month" → full previous calendar month
- "this month" → month start to ${today}
- "FY YYYY" → Apr 1 YYYY to Mar 31 YYYY+1
- "summer" → Apr–Jun; "monsoon" → Jul–Sep; "winter" → Nov–Jan; "festive season" → Sep–Nov
- Festival dates → resolve to exact calendar dates (Holi 2025=Mar14, Diwali 2025=Oct20, etc.)
- "N days of [festival]" → N days ending ON festival day

═══ QUERY SHAPE RULES ═══
- "analysis / overview / breakdown / how is / how are / what is the stock" → multi-row GROUP BY (size, colour, store, city)
- "by colour / colour-wise" → GROUP BY s.color_name
- "by size / size-wise" → GROUP BY s.size
- "by store / store-wise / which stores" → GROUP BY l.id, l.name, l.city, l.type
- "by city / city-wise" → GROUP BY l.city
- "by day / daily" → GROUP BY DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata')
- "total / count / how many" (no breakdown) → single aggregate
- "top N" → ORDER BY metric DESC LIMIT N
- "compare / vs" → UNION or FILTER

═══ EXAMPLES ═══
Q:"current analysis of black jeans in stock"
→ Stock query → inventory_snapshot. Analysis = GROUP BY size.
→ {"sql":"SELECT s.size, s.color_name, COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock, COUNT(DISTINCT i.location_id) AS stores FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE s.color_name ILIKE '%BLACK%' AND l.is_active=true AND s.is_active=true GROUP BY s.size, s.color_name ORDER BY total_stock DESC LIMIT 200","explanation":"Current black jeans stock broken down by size and colour variant"}

Q:"stock by colour"
→ {"sql":"SELECT s.color_name, COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock, COUNT(DISTINCT i.location_id) AS stores FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE l.is_active=true AND s.is_active=true GROUP BY s.color_name ORDER BY total_stock DESC LIMIT 200","explanation":"Current stock split by colour"}

Q:"which stores have highest black jeans stock"
→ {"sql":"SELECT l.name AS store_name, l.city, l.state, l.group_name, COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE s.color_name ILIKE '%BLACK%' AND l.is_active=true AND s.is_active=true GROUP BY l.id, l.name, l.city, l.state, l.group_name ORDER BY total_stock DESC LIMIT 10","explanation":"Top 10 stores by current black jeans stock"}

Q:"total network stock right now"
→ {"sql":"SELECT COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock, COUNT(DISTINCT i.location_id) AS active_stores, COUNT(DISTINCT i.sku_id) AS sku_count FROM inventory_snapshot i JOIN locations l ON l.id=i.location_id JOIN skus s ON s.id=i.sku_id WHERE l.is_active=true AND s.is_active=true","explanation":"Total current network inventory"}

Q:"what is the return of size 32 jeans in july 2025"
→ {"sql":"SELECT COALESCE(SUM(im.qty_change),0) AS units_returned FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='RETURN' AND s.size='32' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-07-01'::date AND im.moved_at<'2025-08-01'::date","explanation":"Total size 32 jeans returned in July 2025"}

Q:"top 5 colours sold during diwali 2025"
→ {"sql":"SELECT s.color_name, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-10-18'::date AND im.moved_at<'2025-10-23'::date GROUP BY s.color_name ORDER BY units_sold DESC LIMIT 5","explanation":"Top 5 colours by sales during Diwali 2025"}

Q:"how was sales during first week of holi 2025"
→ {"sql":"SELECT DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue, COUNT(DISTINCT im.location_id) AS stores_active FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-03-08'::date AND im.moved_at<'2025-03-15'::date GROUP BY DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') ORDER BY sale_date","explanation":"Daily sales for first week of Holi 2025"}

Q:"sales analysis last 30 days"
→ {"sql":"SELECT DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='${today}'::date - INTERVAL '30 days' AND im.moved_at<'${today}'::date + INTERVAL '1 day' GROUP BY DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') ORDER BY sale_date","explanation":"Daily sales for last 30 days"}

Q:"low stock sizes across network"
→ {"sql":"SELECT s.size, COALESCE(SUM(i.qty_available),0)::int AS available_stock, COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COUNT(DISTINCT CASE WHEN i.qty_available < i.safety_stock THEN i.location_id END) AS stores_low FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE l.is_active=true AND s.is_active=true GROUP BY s.size ORDER BY available_stock ASC LIMIT 200","explanation":"Stock levels by size highlighting low stock"}

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

  // Strip markdown code fences
  let clean = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  // Extract first JSON object boundaries
  const jsonStart = clean.indexOf('{');
  const jsonEnd = clean.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    clean = clean.slice(jsonStart, jsonEnd + 1);
  } else if (jsonStart !== -1) {
    // Truncated — no closing brace found, try to repair
    clean = clean.slice(jsonStart);
  }

  // Attempt 1: parse as-is
  try { return JSON.parse(clean); } catch (_) {}

  // Attempt 2: flatten newlines + remove trailing commas
  const pass2 = clean.replace(/[\r\n\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(pass2); } catch (_) {}

  // Attempt 3: auto-repair truncated JSON
  // Close any open string, then close open braces
  let repaired = pass2.trimEnd();
  // Count open vs closed braces/brackets
  let openBraces = 0, inString = false, escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
    }
  }
  // If still inside a string, close it
  if (inString) repaired += '"';
  // Remove trailing comma before we close
  repaired = repaired.replace(/,\s*$/, '');
  // Close open braces
  while (openBraces > 0) { repaired += '}'; openBraces--; }

  try { return JSON.parse(repaired); } catch (e) {
    throw new Error(`Invalid JSON from AI: ${e.message}`);
  }
}

function formatMetric(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return String(value);
  if (Math.abs(value) >= 10000000) return `${(value / 10000000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100000) return `${(value / 100000).toFixed(1)}L`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
}

function prettifyColumnName(name) { return name.replace(/_/g, ' '); }

function isNumericValue(v) {
  if (typeof v === 'number') return !isNaN(v);
  if (typeof v === 'string' && v !== '') return !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v);
  return false;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  return Number(v);
}

function findNumericColumn(rows) {
  if (!rows.length) return null;
  const preferred = ['units_sold','units_returned','total_stock','stock_value','qty_on_hand','qty_available','total_qty','revenue','count'];
  for (const col of preferred) if (isNumericValue(rows[0][col])) return col;
  return Object.keys(rows[0]).find((col) => isNumericValue(rows[0][col])) || null;
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

  const validRows = rows.filter((r) => isNumericValue(r[numericCol]));
  if (!validRows.length) return `Found ${rows.length} matching record${rows.length !== 1 ? 's' : ''}.`;

  const total = validRows.reduce((s, r) => s + toNumber(r[numericCol]), 0);
  const sorted = [...validRows].sort((a, b) => toNumber(b[numericCol]) - toNumber(a[numericCol]));
  const top = sorted[0];
  const bot = sorted[sorted.length - 1];
  const metric = prettifyColumnName(numericCol);

  // Check if there's also a revenue column alongside units
  const revenueCol = validRows[0].revenue !== undefined ? 'revenue'
    : validRows[0].total_value !== undefined ? 'total_value' : null;
  const totalRevenue = revenueCol
    ? validRows.reduce((s, r) => s + toNumber(r[revenueCol] || 0), 0) : null;

  if (validRows.length === 1) {
    const lbl = labelCol ? ` for ${top[labelCol]}` : '';
    const allMetrics = Object.entries(top)
      .filter(([, v]) => isNumericValue(v))
      .map(([k, v]) => `${prettifyColumnName(k)}: ${/revenue|value|mrp|amount|price/i.test(k) ? '₹' : ''}${formatMetric(toNumber(v))}`)
      .join(' | ');
    return allMetrics ? `${allMetrics}${lbl}.` : `${metric} is ${formatMetric(toNumber(top[numericCol]))}${lbl}.`;
  }

  const topLbl = labelCol ? top[labelCol] : 'top entry';
  const botLbl = labelCol ? bot[labelCol] : 'lowest entry';
  const revSummary = totalRevenue !== null
    ? ` generating ₹${formatMetric(totalRevenue)} in revenue.` : '.';
  return `Across ${validRows.length} results, total ${metric} is ${formatMetric(total)}${revSummary} ${topLbl} leads with ${formatMetric(toNumber(top[numericCol]))}, while ${botLbl} has the lowest at ${formatMetric(toNumber(bot[numericCol]))}.`;
}

function isWeakAnswer(answer) {
  if (!answer) return true;
  const t = answer.trim();
  if (t.length < 40) return true;
  if (t.split(/\s+/).length < 8) return true;
  if (/^(i (cannot|can't|don't)|sorry|unfortunately)/i.test(t)) return true;
  if (/\b(sql|query|database|table|column|json)\b/i.test(t)) return true;
  // Detect mid-sentence truncation: ends with a preposition, article, or no punctuation
  const lastChar = t[t.length - 1];
  if (!/[.!?]/.test(lastChar)) {
    // Ends without sentence-ending punctuation — could be truncated
    const lastWord = t.split(/\s+/).pop().toLowerCase();
    if (/^(to|the|a|an|and|or|of|in|at|on|for|with|by|from|as|that|which|is|was|has|have|had)$/.test(lastWord)) return true;
  }
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

// ─── Main Query Handler ────────────────────────────────────────────────────────
async function queryInventory(req, res, next) {
  try {
    const { question } = req.body;
    logger.info(`AI Query [${req.user?.email}]: ${question}`);

    let parsed;
    let rawContent = '';
    let sqlModelUsed = PRIMARY_MODEL;

    // Step 1: Generate SQL
    try {
      const { result: sqlResult, modelName } = await generateWithFallback(
        question,
        buildSchemaContext(),
        { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 2000 }
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
    if (!sqlTrimmed.toUpperCase().startsWith('SELECT')) {
      throw new AppError('AI returned a non-SELECT query. Blocked for safety.', 400);
    }
    if (FORBIDDEN_SQL.test(sqlTrimmed)) {
      throw new AppError('Query blocked for security reasons.', 403);
    }

    // Step 2: Execute SQL (with self-heal on failure)
    let queryResult;
    try {
      queryResult = await query(sqlTrimmed);
      // ── Fix: pg driver returns NUMERIC/BIGINT/SUM results as strings ──────────
      // Cast any numeric-looking string values to JS numbers across all rows
      if (queryResult.rows.length > 0) {
        const numericStringKeys = Object.keys(queryResult.rows[0]).filter(k => {
          const v = queryResult.rows[0][k];
          return typeof v === 'string' && v !== '' && !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v);
        });
        if (numericStringKeys.length > 0) {
          queryResult.rows = queryResult.rows.map(row => {
            const fixed = { ...row };
            numericStringKeys.forEach(k => { fixed[k] = Number(fixed[k]); });
            return fixed;
          });
        }
      }
    } catch (sqlErr) {
      logger.error('AI SQL execution failed', { sql: sqlTrimmed, error: sqlErr.message });
      try {
        const { result: fixResult } = await generateWithFallback(
          `Fix this SQL that failed.\nError: ${sqlErr.message}\nSQL: ${sqlTrimmed}\nOriginal question: ${question}\nReturn corrected JSON only.`,
          buildSchemaContext(),
          { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 2000 }
        );
        const fixedParsed = extractJsonPayload(fixResult.response.text()?.trim() || '');
        if (!fixedParsed.sql?.toUpperCase().startsWith('SELECT') || FORBIDDEN_SQL.test(fixedParsed.sql)) {
          throw new Error('Fixed SQL failed safety check');
        }
        queryResult = await query(fixedParsed.sql.trim());
        parsed = fixedParsed;
        logger.info('AI self-healed SQL successfully');
      } catch (fixErr) {
        logger.error('AI self-heal failed', { error: fixErr?.message });
        throw new AppError(`Could not execute query: ${sqlErr.message}`, 422);
      }
    }

    // ── Helper: coerce pg numeric strings to JS numbers ──────────────────────
    function coerceRows(rows) {
      if (!rows.length) return rows;
      const numKeys = Object.keys(rows[0]).filter(k => {
        const v = rows[0][k];
        return typeof v === 'string' && v !== '' && !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v);
      });
      if (!numKeys.length) return rows;
      return rows.map(r => { const f = { ...r }; numKeys.forEach(k => { f[k] = Number(f[k]); }); return f; });
    }

    // Step 2.5: Auto-breakdown when main result is a single aggregate
    // Generate top-10 store breakdown to enrich the answer
    let displayRows = queryResult.rows;
    let breakdownContext = '';

    if (queryResult.rows.length === 1) {
      try {
        const aggregate = queryResult.rows[0];
        const metricKeys = Object.keys(aggregate).filter(k => typeof aggregate[k] === 'number');
        const metricCol = metricKeys[0] || 'value';

        const usesSnapshot = /inventory_snapshot/i.test(sqlTrimmed);
        const breakdownMetric = usesSnapshot
          ? 'COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock'
          : metricCol === 'units_returned'
            ? 'COALESCE(SUM(im.qty_change),0) AS units_returned'
            : 'COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue';

        const { result: bdResult } = await generateWithFallback(
          `Question: "${question}"
Original SQL: ${sqlTrimmed}
Total aggregate: ${JSON.stringify(aggregate)}
Generate a store-level breakdown SQL with the EXACT SAME filters and table joins as the original SQL above, but GROUP BY l.id, l.name AS store_name, l.city, l.state.
Select: l.name AS store_name, l.city, l.state, ${breakdownMetric}.
Keep all WHERE conditions and SKU filters identical. ORDER BY the primary metric DESC LIMIT 10.
Return JSON: {"sql":"..."}`,
          buildSchemaContext(),
          { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 800 }
        );
        const bdParsed = extractJsonPayload(bdResult.response.text()?.trim() || '');
        if (bdParsed?.sql?.toUpperCase().startsWith('SELECT') && !FORBIDDEN_SQL.test(bdParsed.sql)) {
          const bdQuery = await query(bdParsed.sql.trim());
          if (bdQuery.rows.length > 0) {
            displayRows = coerceRows(bdQuery.rows);
            // Build context string for answer prompt
            const top3 = displayRows.slice(0, 3);
            breakdownContext = `\nTop stores breakdown: ${top3.map(r => `${r.store_name || r.name} (${r.city || ''}): ${Object.values(r).find(v => typeof v === 'number') ?? ''}`).join('; ')}`;
          }
        }
      } catch (bdErr) {
        logger.warn('Auto-breakdown failed (non-critical):', bdErr?.message);
        // silently continue — displayRows stays as original single-row aggregate
      }
    }

    // Step 3: Generate human answer
    const fallbackSummary = buildFallbackSummary(question, displayRows.length > 0 ? displayRows : queryResult.rows);
    let humanAnswer = fallbackSummary;

    if (queryResult.rows.length > 0) {
      try {
        const isSingleAggregate = queryResult.rows.length === 1;
        const aggSummary = isSingleAggregate ? `Aggregate total: ${JSON.stringify(queryResult.rows[0])}` : '';
        const previewRows = displayRows.slice(0, 10);
        const totalRows = displayRows.length;
        const columns = Object.keys(displayRows[0] || queryResult.rows[0]).join(', ');

        const numericCols = Object.keys(queryResult.rows[0]).filter(k => typeof queryResult.rows[0][k] === 'number' && !isNaN(queryResult.rows[0][k]));
        const totals = numericCols.map(col => {
          const sum = queryResult.rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
          return `${col}: ${formatMetric(sum)}`;
        }).join(', ');

        const answerPrompt = `You are a senior inventory analyst at Spykar Jeans.

User asked: "${question}"
${aggSummary ? aggSummary + '\n' : ''}Totals: ${totals}${breakdownContext}
Top ${previewRows.length} breakdown rows: ${JSON.stringify(previewRows)}

Write 4-5 complete analytical sentences:
1. State the TOTAL metric value upfront (e.g. "432 units of size 32 jeans were returned in July 2025")
2. Name the #1 store/location and its exact value from the breakdown
3. Name the #2 and #3 stores with their values
4. Give a pattern or observation (concentration, spread, outlier)
5. Give 1 specific actionable recommendation

Rules:
- Indian numbers: ≥1Cr → "X.XX Cr", ≥1L → "X.XX L", prefix ₹ for revenue
- Flowing sentences — no bullets, no markdown
- End with a period. No greetings. Start immediately with the key number
- Never mention SQL, database, tables, rows, or columns`;

        const { result: answerResult } = await generateWithFallback(
          answerPrompt,
          'You are a senior business analyst for Spykar Jeans. Give complete, elaborate, data-driven insights in plain English. Always write full sentences and always end with a period. Never mention technical terms like SQL, database, query, table, or column.',
          { temperature: 0.4, maxOutputTokens: 600 }
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
        rows: displayRows,           // rich breakdown rows (or original if no breakdown)
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
