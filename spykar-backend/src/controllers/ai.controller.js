'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { query } = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');

// Optional Redis — gracefully degrade if unavailable
let getCache, setCache;
try {
  const redis = require('../config/redis');
  getCache = redis.get;
  setCache = redis.set;
} catch (_) {}

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not configured');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const PRIMARY_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
const FORBIDDEN_SQL   = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/i;
const CACHE_TTL       = 300; // 5 minutes

// ─── Dynamic date helpers ─────────────────────────────────────────────────────
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getCurrentFY() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  if (month >= 4) return { start: `${year}-04-01`, end: `${year + 1}-03-31`, label: `FY${year}-${year + 1}` };
  return { start: `${year - 1}-04-01`, end: `${year}-03-31`, label: `FY${year - 1}-${year}` };
}

// ─── Schema Context ───────────────────────────────────────────────────────────
function buildSchemaContext() {
  const today = getToday();
  const fy = getCurrentFY();

  return `You are the world's most accurate PostgreSQL analyst for Spykar Jeans — India's leading denim brand. Convert business questions to precise SQL. Return ONLY valid JSON: {"sql":"...","explanation":"...","intent":"..."}
intent must be one of: SALES_ANALYSIS | STOCK_QUERY | TREND_ANALYSIS | TOP_N | COMPARISON | RETURN_ANALYSIS | AGEING_QUERY | DISPATCH_QUERY

TODAY: ${today} | CURRENT FY: ${fy.label} (${fy.start} to ${fy.end}) | DATA RANGE: 2024-04-01 to 2026-01-31

TABLES:
inventory_movements(id,location_id,sku_id,movement_type ENUM[SALE,DISPATCH,RECEIPT,RETURN,TRANSFER_OUT,TRANSFER_IN,ADJUSTMENT],qty_change INT,moved_at TIMESTAMPTZ,reference_no VARCHAR,sale_value DECIMAL)
inventory_snapshot(location_id,sku_id,qty_on_hand,qty_reserved,qty_in_transit,qty_available,safety_stock,reorder_point,updated_at)
skus(id,sku_code,external_id,product_name,color_code,color_name,size,fit_type,mrp,gender,season,style_code,brand,is_active)
locations(id,code,name,type ENUM[WAREHOUSE,DISTRIBUTOR,COCO,FOFO],group_name,zone_id,city,state,external_id,is_active)
zones(id,code,name) -- codes: NORTH,SOUTH,EAST,WEST,CENTRAL
dispatch_orders(id,dispatch_no,from_location_id,to_location_id,status,total_qty,total_value,dispatched_at,expected_at,delivered_at)
dispatch_line_items(id,dispatch_id,sku_id,qty_ordered,qty_dispatched,qty_received)
stock_ageing(location_id,sku_id,qty_0_30,qty_31_60,qty_61_90,qty_91_180,qty_180_plus,ageing_date)

SPYKAR CHANNEL TYPES (group_name in locations):
- "EBO - SOR": Exclusive Brand Outlets SOR billing — 72.5% of total stock
- "Alternate - SOR": Multi-brand SOR outlets
- "MBO - SOR": Multi-Brand Outlets SOR
- "Alternate - Outright": Outright purchase multi-brand
- "Alternate - RT": Return Transfer channel
- "EBO - OR": Exclusive Brand Outlet outright

CHANNEL INTENT MAPPING:
- "EBO / company stores / exclusive" → l.group_name ILIKE '%EBO%'
- "SOR stores" → l.group_name ILIKE '%-SOR%'
- "outright" → l.group_name ILIKE '%Outright%' OR l.group_name ILIKE '%-OR%'
- "alternate / franchise / MBO" → l.group_name ILIKE '%Alternate%' OR l.group_name ILIKE '%MBO%'

TABLE SELECTION — CRITICAL:
- "current stock / in stock / stock now / inventory / on hand / stock by X / stock analysis / stock position" → inventory_snapshot
- "sold / sales / revenue / performance / top selling" → inventory_movements WHERE movement_type='SALE'
- "return / returned / returns" → inventory_movements WHERE movement_type='RETURN'
- "dispatched / dispatch / in transit / shipment" → dispatch_orders + dispatch_line_items
- "dead stock / ageing / slow moving / old stock" → stock_ageing
- "low stock / below safety / reorder" → inventory_snapshot WHERE qty_available < safety_stock

PRODUCT CONTEXT:
- Seasons: SS25/SS26=Summer Spring Apr-Sep; AW24/AW25=Autumn Winter Oct-Mar
- Denim sizes: 28,30,32,34,36,38,40 | Tops: S,M,L,XL,XXL | FREE=one size
- gender: MENS or WOMENS
- fit_type values: JEANS, SHIRTS, T-SHIRTS, TROUSERS, SWEATER, JACKET, SWEATSHIRT
- "slim" → fit_type='JEANS' AND product_name ILIKE '%SLIM%'
- "casual" → fit_type IN ('SHIRTS','T-SHIRTS')

COLOR MATCHING:
- Exact color name → uppercase exact: s.color_name='BLACK'
- Color family → ILIKE: s.color_name ILIKE '%BLUE%'
- "black jeans" → s.color_name ILIKE '%BLACK%' (covers JET BLACK, CHARCOAL BLACK, etc.)
- Blue family: MID BLUE, DARK BLUE, LIGHT BLUE, RAW BLUE, VINTAGE BLUE
- Brown family: BISON BROWN, SEPIA BROWN, SAND
- Green family: OLIVE GREEN, AVOCADO GREEN, VINTAGE OLIVE

FESTIVAL DATE INTELLIGENCE:
You have complete knowledge of all Indian festival dates. Resolve confidently from your own knowledge — never ask for clarification.
Known dates: Holi 2025=Mar14, Holi 2026=Mar17, Diwali 2025=Oct20, Diwali 2026=Oct8, Navratri 2025=Oct2-12, Eid 2025=Mar31, Onam 2025=Sep5
Resolution rules:
- "N days of [festival] [YEAR]" → N days ENDING on festival day (e.g. 5 days of Holi 2025 → Mar10 to Mar14, SQL: >=2025-03-10 AND <2025-03-15)
- "during [festival]" → 2 days before + day + 2 days after
- "[festival] week" → 7 days ending on festival day
- "festive season" → Sep 1 to Nov 30; "pre-festive" → Aug 1 to Sep 30
- Year not specified → most recent within data range

RELATIVE DATES (compute from TODAY=${today}):
- "last N days" → (today - N days) to today
- "last week" → Mon to Sun of previous week
- "last month" → full previous calendar month
- "this month" → month start to today
- "last quarter" → Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar
- "summer YYYY" → Apr 1 to Sep 30; "winter YYYY" → Oct 1 to Mar 31 next year
- "FY YYYY" → Apr 1 YYYY to Mar 31 YYYY+1

ABSOLUTE SQL RULES — NEVER VIOLATE:
1. SALE qty_change NEGATIVE → always ABS(qty_change) for units sold
2. RETURN qty_change POSITIVE → SUM(qty_change) directly, NEVER ABS() or qty_change<0
3. Always COALESCE(SUM(...),0) — never bare SUM
4. Always l.is_active=true AND s.is_active=true
5. Half-open date ranges: >= 'X'::date AND < 'Y'::date
6. Default LIMIT 50 unless user says "all" or a number
7. Never SELECT * — always name columns with clear aliases
8. Revenue: SUM(ABS(im.qty_change) * s.mrp) AS revenue
9. Stock value: SUM(i.qty_on_hand * s.mrp) AS stock_value
10. Aliases: im=movements, i=snapshot, s=skus, l=locations, z=zones
11. IST dates: DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') AS sale_date
12. inventory_snapshot queries: NO date filter, NO AT TIME ZONE

INTENT → SQL PATTERN:
SALES_ANALYSIS: GROUP BY day or color or store. Include: grouping_col + units_sold + revenue + stores_active
TREND_ANALYSIS: DATE_TRUNC by day/week/month + ORDER BY time ASC
TOP_N: ORDER BY metric DESC LIMIT N, include ROW_NUMBER() if rank matters
COMPARISON: FILTER clause or CTEs — show segments as columns
STOCK_QUERY: inventory_snapshot only. qty_on_hand=total, qty_available=sellable
AGEING_QUERY: latest ageing_date. GROUP BY location or sku
RETURN_ANALYSIS: movement_type='RETURN', SUM(qty_change) POSITIVE, never ABS()
DISPATCH_QUERY: join dispatch_orders + dispatch_line_items on dispatch_id=id

EXAMPLES:
Q:"current analysis of black jeans in stock"
→ {"sql":"SELECT s.size, s.color_name, COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock, COUNT(DISTINCT i.location_id) AS stores FROM inventory_snapshot i JOIN skus s ON s.id=i.sku_id JOIN locations l ON l.id=i.location_id WHERE s.color_name ILIKE '%BLACK%' AND l.is_active=true AND s.is_active=true GROUP BY s.size,s.color_name ORDER BY total_stock DESC LIMIT 200","explanation":"Current black jeans stock by size and colour variant","intent":"STOCK_QUERY"}

Q:"how was sales during diwali 2025"
→ Diwali 2025=Oct20. "during"=2 days before+day+2 after=Oct18-22.
→ {"sql":"SELECT DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') AS sale_date, COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue, COUNT(DISTINCT im.location_id) AS stores_active FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='SALE' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-10-18'::date AND im.moved_at<'2025-10-23'::date GROUP BY DATE(im.moved_at AT TIME ZONE 'Asia/Kolkata') ORDER BY sale_date","explanation":"Daily sales breakdown during Diwali 2025 (Oct 18-22)","intent":"SALES_ANALYSIS"}

Q:"return of size 32 jeans july 2025"
→ {"sql":"SELECT COALESCE(SUM(im.qty_change),0) AS units_returned FROM inventory_movements im JOIN skus s ON s.id=im.sku_id JOIN locations l ON l.id=im.location_id WHERE im.movement_type='RETURN' AND s.size='32' AND l.is_active=true AND s.is_active=true AND im.moved_at>='2025-07-01'::date AND im.moved_at<'2025-08-01'::date","explanation":"Size 32 returns in July 2025","intent":"RETURN_ANALYSIS"}

Q:"total network stock right now"
→ {"sql":"SELECT COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock, COALESCE(SUM(i.qty_on_hand*s.mrp),0) AS stock_value, COUNT(DISTINCT i.location_id) AS active_stores, COUNT(DISTINCT i.sku_id) AS sku_count FROM inventory_snapshot i JOIN locations l ON l.id=i.location_id JOIN skus s ON s.id=i.sku_id WHERE l.is_active=true AND s.is_active=true","explanation":"Total current network inventory snapshot","intent":"STOCK_QUERY"}

Return ONLY valid JSON. No markdown. No text outside JSON.`;
}

// ─── Sleep ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRateLimitError(err) {
  return /quota|rate.?limit|resource_exhausted|429|too many/i.test(err?.message || '');
}
function isModelNotFoundError(err) {
  return /not found|404|model.*unavail/i.test(err?.message || '');
}

// ─── generateWithFallback ─────────────────────────────────────────────────────
async function generateWithFallback(prompt, systemInstruction, generationConfig) {
  const candidates = [...new Set([PRIMARY_MODEL, ...FALLBACK_MODELS])];
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const modelName = candidates[i];
    try {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction, generationConfig });
      const result = await model.generateContent(prompt);
      return { result, modelName };
    } catch (err) {
      lastError = err;
      logger.warn(`Gemini [${modelName}] failed: ${String(err?.message).substring(0, 120)}`);
      if (isRateLimitError(err)) {
        const wait = Math.min(2000 * Math.pow(2, i), 10000);
        logger.info(`Rate limit on ${modelName}, waiting ${wait}ms`);
        await sleep(wait);
      }
      // model not found → try next immediately
    }
  }
  throw lastError || new Error('All Gemini models exhausted');
}

// ─── extractJsonPayload ───────────────────────────────────────────────────────
function extractJsonPayload(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Empty AI response');
  let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s !== -1 && e > s) clean = clean.slice(s, e + 1);
  else if (s !== -1) clean = clean.slice(s);

  try { return JSON.parse(clean); } catch (_) {}

  const p2 = clean.replace(/[\r\n\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(p2); } catch (_) {}

  // Repair truncated JSON
  let rep = p2.trimEnd();
  let open = 0; let inStr = false; let esc = false;
  for (const ch of rep) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) { if (ch === '{') open++; else if (ch === '}') open--; }
  }
  if (inStr) rep += '"';
  rep = rep.replace(/,\s*$/, '');
  while (open > 0) { rep += '}'; open--; }
  try { return JSON.parse(rep); } catch (e2) {
    throw new Error(`Invalid JSON from AI: ${e2.message}`);
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function formatMetric(v) {
  if (typeof v !== 'number' || isNaN(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 10000000) return `${(v / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000)   return `${(v / 100000).toFixed(2)}L`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(v);
}

function isNumeric(v) {
  if (typeof v === 'number') return !isNaN(v);
  if (typeof v === 'string' && v !== '') return !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v);
  return false;
}

function toNum(v) { return typeof v === 'number' ? v : Number(v); }

// ─── Coerce pg numeric strings ────────────────────────────────────────────────
function coerceRows(rows) {
  if (!rows.length) return rows;
  const numKeys = Object.keys(rows[0]).filter(k => {
    const v = rows[0][k];
    return typeof v === 'string' && v !== '' && !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v);
  });
  if (!numKeys.length) return rows;
  return rows.map(r => {
    const f = { ...r };
    numKeys.forEach(k => { f[k] = Number(f[k]); });
    return f;
  });
}

// ─── isWeakAnswer ─────────────────────────────────────────────────────────────
function isWeakAnswer(answer) {
  if (!answer) return true;
  const t = answer.trim();
  if (t.length < 40) return true;
  if (t.split(/\s+/).length < 8) return true;
  if (/^(i (cannot|can't|don't|am unable)|sorry|unfortunately)/i.test(t)) return true;
  if (/\b(SELECT|FROM|WHERE|postgresql|database error)\b/.test(t)) return true;
  return false;
}

// ─── buildFallbackSummary ─────────────────────────────────────────────────────
function buildFallbackSummary(question, rows) {
  if (!rows.length) return 'No matching records found for this query. The data may not exist for the selected filters or the values may be zero.';

  const numCols = Object.keys(rows[0]).filter(k => isNumeric(rows[0][k]));
  const lblCol  = (() => {
    const pref = ['store_name','color_name','size','location_name','name','city','sku_code','status','sale_date'];
    for (const c of pref) if (rows[0][c] !== undefined) return c;
    return Object.keys(rows[0]).find(k => typeof rows[0][k] === 'string') || null;
  })();

  if (!numCols.length) return `Found ${rows.length} matching record${rows.length !== 1 ? 's' : ''}.`;

  const col = numCols[0];
  const valid = rows.filter(r => isNumeric(r[col]));
  if (!valid.length) return `Found ${rows.length} record${rows.length !== 1 ? 's' : ''}.`;

  const total  = valid.reduce((s, r) => s + toNum(r[col]), 0);
  const sorted = [...valid].sort((a, b) => toNum(b[col]) - toNum(a[col]));
  const top    = sorted[0];
  const bot    = sorted[sorted.length - 1];
  const metric = col.replace(/_/g, ' ');
  const isRev  = /revenue|value|mrp|amount|price/i.test(col);

  if (valid.length === 1) {
    const allM = Object.entries(top)
      .filter(([, v]) => isNumeric(v))
      .map(([k, v]) => {
        const isR = /revenue|value|mrp|amount|price/i.test(k);
        return `${k.replace(/_/g, ' ')}: ${isR ? '₹' : ''}${formatMetric(toNum(v))}`;
      }).join(' | ');
    return allM || `${metric}: ${isRev ? '₹' : ''}${formatMetric(toNum(top[col]))}`;
  }

  const topLbl = lblCol ? top[lblCol] : 'top entry';
  const botLbl = lblCol ? bot[lblCol] : 'lowest entry';
  const revCol = valid[0].revenue !== undefined ? 'revenue' : valid[0].total_value !== undefined ? 'total_value' : null;
  const revTotal = revCol ? valid.reduce((s, r) => s + toNum(r[revCol] || 0), 0) : null;
  const revStr = revTotal !== null ? ` generating ₹${formatMetric(revTotal)} revenue.` : '.';

  return `Across ${valid.length} results, total ${metric}: ${isRev ? '₹' : ''}${formatMetric(total)}${revStr} ${topLbl} leads with ${formatMetric(toNum(top[col]))}, ${botLbl} has the lowest at ${formatMetric(toNum(bot[col]))}.`;
}

// ─── toUserFacingMessage ──────────────────────────────────────────────────────
function toUserFacingMessage(err) {
  const msg = err?.message || '';
  if (/api.?key/i.test(msg))                                 return 'AI service error: invalid API key. Contact support.';
  if (/quota|rate.?limit|resource_exhausted|429/i.test(msg)) return 'AI is temporarily busy. Wait a moment and retry.';
  if (/not found|404/i.test(msg))                            return 'AI model unavailable. Retrying shortly.';
  if (/permission|forbidden|403/i.test(msg))                 return 'AI access denied. Contact support.';
  return `AI request failed: ${msg.substring(0, 100)}`;
}

// ─── Redis helpers ────────────────────────────────────────────────────────────
function cacheKey(question) {
  const normalized = question.toLowerCase().trim();
  return `ai:q:${Buffer.from(normalized).toString('base64').substring(0, 64)}`;
}

async function tryReadCache(key) {
  try {
    if (!getCache) return null;
    const cached = await getCache(key);
    if (!cached) return null;
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  } catch (e) {
    logger.warn('AI cache read error:', e?.message);
    return null;
  }
}

async function tryWriteCache(key, data) {
  try {
    if (!setCache) return;
    await setCache(key, JSON.stringify(data), CACHE_TTL);
  } catch (e) {
    logger.warn('AI cache write error:', e?.message);
  }
}

// ─── Main Query Handler ───────────────────────────────────────────────────────
async function queryInventory(req, res, next) {
  try {
    const { question } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
      throw new AppError('Question is required.', 400);
    }

    logger.info(`AI Query [${req.user?.email}]: ${question}`);
    const startTime = Date.now();
    const ck = cacheKey(question);

    // ── Cache check ───────────────────────────────────────────────────────────
    const cached = await tryReadCache(ck);
    if (cached) {
      logger.info(`AI cache hit for: ${question.substring(0, 60)}`);
      return res.json({ ...cached, cached: true });
    }

    // ── Step 1: Generate SQL ──────────────────────────────────────────────────
    let parsed, rawContent = '', sqlModelUsed = PRIMARY_MODEL;
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
      logger.error('SQL generation failed', { error: parseErr?.message, raw: rawContent.substring(0, 300) });
      throw new AppError(toUserFacingMessage(parseErr), 422);
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

    // ── Step 2: Execute SQL (with self-heal) ──────────────────────────────────
    let queryResult;
    try {
      queryResult = await query(sqlTrimmed);
      if (queryResult.rows.length > 0) queryResult.rows = coerceRows(queryResult.rows);
    } catch (sqlErr) {
      logger.error('SQL execution failed', { sql: sqlTrimmed, error: sqlErr.message });
      try {
        const { result: fixResult } = await generateWithFallback(
          `Fix this SQL that failed.\nError: ${sqlErr.message}\nSQL: ${sqlTrimmed}\nOriginal question: ${question}\nReturn corrected JSON only: {"sql":"...","explanation":"...","intent":"..."}`,
          buildSchemaContext(),
          { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 2000 }
        );
        const fixedParsed = extractJsonPayload(fixResult.response.text()?.trim() || '');
        if (!fixedParsed?.sql?.toUpperCase().startsWith('SELECT') || FORBIDDEN_SQL.test(fixedParsed.sql)) {
          throw new Error('Fixed SQL failed safety check');
        }
        queryResult = await query(fixedParsed.sql.trim());
        if (queryResult.rows.length > 0) queryResult.rows = coerceRows(queryResult.rows);
        parsed = fixedParsed;
        logger.info('AI self-healed SQL successfully');
      } catch (fixErr) {
        logger.error('AI self-heal failed', { error: fixErr?.message });
        throw new AppError(`Could not execute query: ${sqlErr.message}`, 422);
      }
    }

    // ── Step 3: Auto-breakdown for single aggregates ──────────────────────────
    let displayRows = queryResult.rows;
    let breakdownContext = '';

    const isSingleAggregate = queryResult.rows.length === 1 &&
      !Object.values(queryResult.rows[0]).some(v => typeof v === 'string' && v.length > 2);

    if (isSingleAggregate) {
      try {
        const aggregate = queryResult.rows[0];
        const numKeys = Object.keys(aggregate).filter(k => typeof aggregate[k] === 'number');
        const metricCol = numKeys[0] || 'value';
        const usesSnapshot = /inventory_snapshot/i.test(sqlTrimmed);

        const bdMetric = usesSnapshot
          ? 'COALESCE(SUM(i.qty_on_hand),0)::int AS total_stock, COALESCE(SUM(i.qty_available),0)::int AS available_stock'
          : metricCol === 'units_returned'
            ? 'COALESCE(SUM(im.qty_change),0) AS units_returned'
            : 'COALESCE(SUM(ABS(im.qty_change)),0) AS units_sold, COALESCE(SUM(ABS(im.qty_change)*s.mrp),0) AS revenue';

        const { result: bdResult } = await generateWithFallback(
          `Question: "${question}"
Original SQL: ${sqlTrimmed}
Total aggregate: ${JSON.stringify(aggregate)}
Generate a store-level breakdown SQL using the EXACT SAME filters and table joins as the original SQL.
GROUP BY l.id, l.name AS store_name, l.city, l.state.
Select: l.name AS store_name, l.city, l.state, ${bdMetric}.
Keep all WHERE conditions identical. ORDER BY the primary metric DESC LIMIT 10.
Return JSON: {"sql":"...","explanation":"...","intent":"TOP_N"}`,
          buildSchemaContext(),
          { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 800 }
        );
        const bdParsed = extractJsonPayload(bdResult.response.text()?.trim() || '');
        if (bdParsed?.sql?.toUpperCase().startsWith('SELECT') && !FORBIDDEN_SQL.test(bdParsed.sql)) {
          const bdQuery = await query(bdParsed.sql.trim());
          if (bdQuery.rows.length > 0) {
            displayRows = coerceRows(bdQuery.rows);
            const top3 = displayRows.slice(0, 3);
            breakdownContext = `\nTop stores: ${top3.map(r => `${r.store_name || r.name}(${r.city || ''}): ${Object.values(r).find(v => typeof v === 'number') ?? ''}`).join('; ')}`;
          }
        }
      } catch (bdErr) {
        logger.warn('Auto-breakdown failed (non-critical):', bdErr?.message);
      }
    }

    // ── Step 4: Premium insight generation ────────────────────────────────────
    const fallbackSummary = buildFallbackSummary(question, displayRows.length > 0 ? displayRows : queryResult.rows);
    let humanAnswer = fallbackSummary;

    if (queryResult.rows.length > 0) {
      try {
        const numericCols = Object.keys(queryResult.rows[0]).filter(k => typeof queryResult.rows[0][k] === 'number');
        const totals = numericCols.map(col => {
          const sum = queryResult.rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
          const isRev = /revenue|value|mrp|price|amount/i.test(col);
          return `${col}: ${isRev ? '₹' : ''}${formatMetric(sum)}`;
        }).join(', ');

        const aggLine = isSingleAggregate ? `Aggregate: ${JSON.stringify(queryResult.rows[0])}\n` : '';
        const top30   = displayRows.slice(0, 30);

        const insightPrompt = `You are Chief Analytics Officer at Spykar Jeans — India's leading denim brand.

User asked: "${question}"
${aggLine}Totals: ${totals}${breakdownContext}
Top ${top30.length} breakdown: ${JSON.stringify(top30)}

Deliver 4-6 sentences of premium business intelligence:
SENTENCE 1 — HEADLINE: single most important metric with exact number in Indian format (L/Cr/₹)
SENTENCE 2 — TOP PERFORMER: exact name + number + % of total
SENTENCE 3 — KEY TREND OR PATTERN: most interesting business observation with specific number
SENTENCE 4 — BOTTOM PERFORMER OR OPPORTUNITY GAP: specific number
SENTENCE 5 — ONE CLEAR ACTIONABLE RECOMMENDATION

Rules:
- Indian number format: ≥1Cr → "X.XXCr", ≥1L → "X.XXL", prefix ₹ for revenue
- Flowing prose — no bullets, no markdown, no headers
- Start directly with the headline number — no greetings
- Every sentence must contain at least one specific number
- Never say "data shows", "the SQL", "database", "rows", "JSON", "query"
- Sound like a C-suite briefing, not a data scientist report
- End with a full stop`;

        const { result: answerResult } = await generateWithFallback(
          insightPrompt,
          'You are a senior business analyst delivering C-suite insights for Spykar Jeans. Use Indian number formats. Never mention technical terms. Always write complete sentences ending with periods.',
          { temperature: 0.25, maxOutputTokens: 500 }
        );
        const candidate = answerResult.response.text().trim();
        humanAnswer = isWeakAnswer(candidate) ? fallbackSummary : candidate;
      } catch (insightErr) {
        logger.warn('Insight generation failed, using fallback:', insightErr?.message);
        humanAnswer = fallbackSummary;
      }
    }

    // ── Step 5: Non-blocking log ──────────────────────────────────────────────
    query(
      `INSERT INTO ai_query_log (user_id, question, generated_sql, row_count, answer) VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, question, parsed.sql, queryResult.rows.length, humanAnswer]
    ).catch(e => logger.warn('ai_query_log insert failed:', e.message));

    // ── Step 6: Build response ────────────────────────────────────────────────
    const processingMs = Date.now() - startTime;
    const responsePayload = {
      success: true,
      data: {
        question,
        answer:       humanAnswer,
        explanation:  parsed.explanation || '',
        intent:       parsed.intent      || 'UNKNOWN',
        rows:         displayRows,
        rowCount:     queryResult.rows.length,
        model:        sqlModelUsed,
        processingMs,
        cached:       false,
        ...(process.env.NODE_ENV === 'development' && { sql: parsed.sql }),
      },
    };

    // ── Step 7: Write cache ───────────────────────────────────────────────────
    await tryWriteCache(ck, responsePayload);

    return res.json(responsePayload);

  } catch (err) {
    next(err);
  }
}

// ─── Suggested Queries ────────────────────────────────────────────────────────
async function getSuggestedQueries(req, res) {
  const suggestions = [
    // Sales Intelligence
    { category: 'Sales Intelligence', question: 'How was sales during Diwali 2025?' },
    { category: 'Sales Intelligence', question: 'Monthly sales trend for FY 2025-26' },
    { category: 'Sales Intelligence', question: 'Compare EBO-SOR vs Alternate-SOR sales last 3 months' },
    { category: 'Sales Intelligence', question: 'Top 10 stores by revenue in last 30 days' },
    { category: 'Sales Intelligence', question: 'Sales by colour during Holi 2025' },
    // Product Performance
    { category: 'Product Performance', question: 'Which colours sell best in North zone?' },
    { category: 'Product Performance', question: 'Top 5 sizes sold in winter 2025' },
    { category: 'Product Performance', question: 'Best performing womens products last quarter' },
    { category: 'Product Performance', question: 'Compare summer vs winter 2025 sales by fit type' },
    // Stock Intelligence
    { category: 'Stock Intelligence', question: 'Which stores are critically low on size 32?' },
    { category: 'Stock Intelligence', question: 'Total stock value across all locations right now' },
    { category: 'Stock Intelligence', question: 'Show ageing breakdown for North zone' },
    { category: 'Stock Intelligence', question: 'Current black jeans stock analysis by size' },
    { category: 'Stock Intelligence', question: 'Which SKUs have zero stock everywhere?' },
    // Returns Analysis
    { category: 'Returns Analysis', question: 'Which stores have highest returns in last 6 months?' },
    { category: 'Returns Analysis', question: 'Most returned colours in winter 2025' },
    { category: 'Returns Analysis', question: 'Return rate comparison EBO-SOR vs Alternate-SOR' },
    { category: 'Returns Analysis', question: 'Total returns by size last quarter' },
    // Dispatch & Network
    { category: 'Dispatch & Network', question: 'Show pending dispatches older than 7 days' },
    { category: 'Dispatch & Network', question: 'Total units dispatched to EBO stores last month' },
  ];
  res.json({ success: true, data: suggestions });
}

// ─── Query History ────────────────────────────────────────────────────────────
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
