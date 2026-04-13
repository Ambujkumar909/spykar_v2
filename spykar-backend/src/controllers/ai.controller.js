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

// ─── Compact Schema Context (minimal tokens, maximum signal) ──────────────────
function buildSchemaContext() {
  const today = new Date().toISOString().split('T')[0];
  return `You are a PostgreSQL expert for Spykar Jeans inventory. Convert questions to SQL and return JSON only: {"sql":"...","explanation":"..."}.

TABLES:
- inventory_movements(id,location_id,sku_id,movement_type ENUM[SALE,DISPATCH,RECEIPT,RETURN,TRANSFER_OUT,TRANSFER_IN,ADJUSTMENT],qty_change INT,moved_at TIMESTAMPTZ)
- inventory_snapshot(location_id,sku_id,qty_on_hand,qty_reserved,qty_in_transit,qty_available,safety_stock,reorder_point,updated_at)
- skus(id,sku_code,product_name,color_code,color_name,size,fit_type,mrp,is_active)
- locations(id,code,name,type ENUM[WAREHOUSE,DISTRIBUTOR,COCO,FOFO],group_name TEXT,zone_id,city,state,is_active)
  -- group_name has the real channel name: 'EBO - SOR','EBO - OR','Alternate - SOR','Alternate - Outright','Alternate - RT','MBO - SOR'
  -- ALWAYS select l.group_name AS channel — NEVER use l.type for display
- zones(id,code,name)
- dispatch_orders(id,dispatch_no,from_location_id,to_location_id,status,total_qty,total_value,dispatched_at,expected_at,delivered_at)
- dispatch_line_items(id,dispatch_id,sku_id,qty_ordered,qty_dispatched,qty_received)
- stock_ageing(location_id,sku_id,qty_0_30,qty_31_60,qty_61_90,qty_91_180,qty_180_plus,ageing_date)

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

FESTIVAL DATES (use your knowledge, resolve to exact dates before SQL):
- "N days of [festival] YYYY" → N days ENDING ON festival day (e.g. "5 days of Holi 2025" → Holi=Mar14 → 2025-03-10 to 2025-03-14, SQL: >=2025-03-10 AND <2025-03-15)
- "during [festival]" → 2 days before + day + 2 days after
- "[festival] week" → 7 days ending on festival day
- "festive season YYYY" → Sep 1 to Nov 30
- "summer YYYY" → Apr 1 to Jun 30; "winter YYYY" → Nov 1 to Jan 31; "monsoon YYYY" → Jul 1 to Sep 30
- "last N days" → relative to ${today}; "last month" → full prev calendar month; "this month" → month start to ${today}
- "FY YYYY" → Apr 1 YYYY to Mar 31 YYYY+1

QUERY TYPE RULES — CRITICAL:
- "how was sales / how did X perform / sales overview / sales analysis" → ALWAYS return a multi-row breakdown by colour OR by day (DATE(moved_at)), NEVER a single aggregate. Include: units_sold, revenue (units*mrp), and a grouping column.
- "total / count / how many" (single metric) → single aggregate is fine
- "top N" → GROUP BY dimension ORDER BY metric DESC LIMIT N
- "compare / vs / before vs after" → use FILTER or UNION to show multiple periods as columns/rows

EXAMPLES:
Q:"black units sold during 5 days holi 2025"
→ {"sql":"SELECT COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND s.color_name='BLACK' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-03-10'::date AND im.moved_at<'2025-03-15'::date","explanation":"Black units sold in 5 days of Holi 2025"}

Q:"how was sales during first week of holi 2025"
→ Holi 2025=Mar14. First week=Mar8-14. Return daily breakdown.
→ {"sql":"SELECT DATE(im.moved_at) AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue, COUNT(DISTINCT im.location_id) AS stores_active FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-03-08'::date AND im.moved_at<'2025-03-15'::date GROUP BY DATE(im.moved_at) ORDER BY sale_date","explanation":"Daily sales breakdown for first week of Holi 2025 (Mar 8-14)"}

Q:"top 5 colours sold during diwali 2025"
→ {"sql":"SELECT s.color_name,COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-10-18'::date AND im.moved_at<'2025-10-23'::date GROUP BY s.color_name ORDER BY units_sold DESC LIMIT 5","explanation":"Top 5 colours by sales during Diwali 2025"}

Q:"sales analysis last 30 days"
→ {"sql":"SELECT DATE(im.moved_at) AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='${today}'::date - INTERVAL '30 days' AND im.moved_at<'${today}'::date + INTERVAL '1 day' GROUP BY DATE(im.moved_at) ORDER BY sale_date","explanation":"Daily sales for last 30 days"}

Q:"top 10 stores in Bihar by sales in last 6 months"
→ {"sql":"SELECT l.name AS store_name, l.group_name AS channel, l.city, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND l.state ILIKE 'Bihar' AND im.moved_at>='${today}'::date - INTERVAL '6 months' AND im.moved_at<'${today}'::date + INTERVAL '1 day' GROUP BY l.id, l.name, l.group_name, l.city ORDER BY units_sold DESC LIMIT 10","explanation":"Top 10 Bihar stores by units sold in last 6 months"}

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
    } catch (sqlErr) {
      logger.error('AI SQL execution failed', { sql: sqlTrimmed, error: sqlErr.message });
      try {
        const { result: fixResult } = await generateWithFallback(
          `Fix this SQL that failed.\nError: ${sqlErr.message}\nSQL: ${sqlTrimmed}\nOriginal question: ${question}\nReturn corrected JSON only.`,
          buildSchemaContext(),
          { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 600 }
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

    // Step 3: Generate human answer (skip Gemini call if no rows — use fallback directly)
    const fallbackSummary = buildFallbackSummary(question, queryResult.rows);
    let humanAnswer = fallbackSummary;

    if (queryResult.rows.length > 0) {
      try {
        const previewRows = queryResult.rows.slice(0, 15);
        const totalRows = queryResult.rows.length;
        const columns = Object.keys(queryResult.rows[0]).join(', ');

        // Compute totals for context
        const numericCols = Object.keys(queryResult.rows[0]).filter(k => typeof queryResult.rows[0][k] === 'number');
        const totals = numericCols.map(col => {
          const sum = queryResult.rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
          return `${col}: ${formatMetric(sum)}`;
        }).join(', ');

        const answerPrompt = `You are a senior inventory analyst at Spykar Jeans.

User asked: "${question}"
Columns returned: ${columns}
Total rows: ${totalRows} | Aggregated totals: ${totals}
Data (top ${previewRows.length} rows): ${JSON.stringify(previewRows)}

Write a sharp 3-5 sentence business insight:
- Lead with the single most important number (total units sold, revenue, or top performer)
- Mention the top and bottom performers if it's a ranking/breakdown
- Highlight any notable trend, spike, or pattern in the data
- Use Indian number format: ≥1Cr as "X.X Cr", ≥1L as "X.X L"
- DO NOT mention SQL, database, rows, columns, tables, JSON, or "the data shows"
- Sound like a business analyst briefing a senior manager — confident, direct, insight-driven`;

        const { result: answerResult } = await generateWithFallback(
          answerPrompt,
          'You are a senior business analyst for Spykar Jeans. Give sharp, data-driven insights in plain English. Never mention technical terms.',
          { temperature: 0.3, maxOutputTokens: 350 }
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
