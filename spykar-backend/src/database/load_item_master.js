/**
 * load_item_master.js
 * One-time bulk load of Item_spykar (SQL Server) → skus (PostgreSQL)
 *
 * Run: node src/database/load_item_master.js
 * Force re-run: node src/database/load_item_master.js --force
 *
 * Data source: PRIMARY (Spykar ERP SQL Server)
 * Designed so a SECONDARY source can be plugged in later by replacing
 * the fetchRows() function — the PostgreSQL upsert logic stays unchanged.
 */

'use strict';

require('dotenv').config();
const sql    = require('mssql');
const { Pool } = require('pg');

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 1000;   // rows per INSERT statement
const FORCE      = process.argv.includes('--force');

const sqlConfig = {
  server:   process.env.MSSQL_HOST,
  port:     parseInt(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt:                process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    requestTimeout:         120000,
    connectionTimeout:      15000,
  },
  pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
};

const pgPool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'spykar_inventory',
  user:     process.env.PG_USER     || 'spykar_app',
  password: process.env.PG_PASSWORD,
  ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max:      5,
});

// ─── Migration: ensure new columns exist ──────────────────────────────────────

async function runMigration(client) {
  console.log('  Applying column migrations...');
  await client.query('DROP VIEW IF EXISTS v_inventory_full');
  const cols = [
    `ALTER TABLE skus ALTER COLUMN size TYPE VARCHAR(30)`,
    `ALTER TABLE skus ADD COLUMN IF NOT EXISTS gender        VARCHAR(10)`,
    `ALTER TABLE skus ALTER COLUMN gender TYPE VARCHAR(20)`,
    `ALTER TABLE skus ADD COLUMN IF NOT EXISTS season        VARCHAR(50)`,
    `ALTER TABLE skus ADD COLUMN IF NOT EXISTS style_code    VARCHAR(100)`,
    `ALTER TABLE skus ADD COLUMN IF NOT EXISTS brand         VARCHAR(50)`,
    `ALTER TABLE skus ADD COLUMN IF NOT EXISTS style_variant VARCHAR(60)`,
    `CREATE INDEX IF NOT EXISTS idx_skus_style_variant
       ON skus(style_variant) WHERE style_variant IS NOT NULL`,
  ];
  for (const ddl of cols) await client.query(ddl);
  await client.query(`
    CREATE OR REPLACE VIEW v_inventory_full AS
    SELECT
      i.id,
      l.id           AS location_id,
      l.code         AS location_code,
      l.name         AS location_name,
      l.type         AS location_type,
      z.name         AS zone_name,
      l.city,
      l.state,
      s.id           AS sku_id,
      s.sku_code,
      s.product_name,
      s.color_code,
      s.color_name,
      s.size,
      s.fit_type,
      s.mrp,
      i.qty_on_hand,
      i.qty_reserved,
      i.qty_in_transit,
      i.qty_available,
      i.safety_stock,
      i.reorder_point,
      CASE WHEN i.qty_on_hand <= i.safety_stock THEN true ELSE false END AS is_below_safety,
      i.last_movement_at,
      i.updated_at
    FROM inventory_snapshot i
    JOIN locations l ON l.id = i.location_id
    LEFT JOIN zones z ON z.id = l.zone_id
    JOIN skus s ON s.id = i.sku_id
    WHERE l.is_active = true AND s.is_active = true
  `);
  console.log('  ✓ Columns ready');
}

// ─── Flexible column reader — tries multiple casing variants ─────────────────
function col(row, ...names) {
  for (const name of names) {
    if (row[name]               !== undefined && row[name] !== null) return row[name];
    if (row[name.toUpperCase()] !== undefined && row[name.toUpperCase()] !== null) return row[name.toUpperCase()];
    if (row[name.toLowerCase()] !== undefined && row[name.toLowerCase()] !== null) return row[name.toLowerCase()];
  }
  return '';
}

// ─── Row transformer ──────────────────────────────────────────────────────────
// Column names confirmed from Item_spykar:
//   Barcode, MRP, style, Shade, Size1, subproduct, product, Category,
//   HSN, hitname, BRANDNAME, GENDERNAME, FITNAME, season, InforItemCode, InforStyle
function buildSkuCode(row) {
  const barcode = String(row.Barcode || '').trim();
  const color = String(row.Shade || '').trim();
  const size = String(row.Size1 || '').trim();
  const styleBase = String(row.InforStyle || '').trim();
  const colorCode = color.replace(/\s+/g, '_').toUpperCase();
  const skuCode = styleBase
    ? `${styleBase}-${colorCode}-${size}`
    : `SPY-${colorCode}-${size}`;

  return { barcode, skuCode };
}

function transformRow(row, skuCodeCounts) {
  const barcode      = String(row.Barcode      || '').trim();
  const mrpRaw       = row.MRP;
  const styleCode    = String(row.style        || '').trim();   // e.g. SPY/PRHP/W15-01
  const color        = String(row.Shade        || '').trim();   // e.g. BLACK
  const size         = String(row.Size1        || '').trim();   // e.g. FREE / 30 / 32
  const subproduct   = String(row.subproduct   || '').trim();   // e.g. HEADPHONE
  const product      = String(row.product      || '').trim();   // e.g. PROMOTIONAL ITEMS
  const category     = String(row.Category     || '').trim();   // e.g. ACCESSORIES / DENIM
  const hsnCode      = String(row.HSN          || '').trim();
  const brand        = String(row.BRANDNAME    || 'SPYKAR').trim();
  const gender       = String(row.GENDERNAME   || '').trim();
  const fitType      = String(row.FITNAME      || '').replace(/<+/g, '').trim();
  const season       = String(row.season       || '').trim();
  const styleVariant = String(row.InforItemCode || '').trim();  // e.g. SPYPRHPW1501001 — used by SalesAI
  const styleBase    = String(row.InforStyle   || '').trim();   // e.g. SPYPRHPW1501

  if (!barcode) return null; // skip rows with no barcode

  const colorCode = color.replace(/\s+/g, '_').toUpperCase();
  const baseSkuCode = styleBase
    ? `${styleBase}-${colorCode}-${size}`
    : `SPY-${colorCode}-${size}`;
  const skuCode = skuCodeCounts.get(baseSkuCode) > 1
    ? `${baseSkuCode}-${barcode}`
    : baseSkuCode;
  const mrp       = mrpRaw ? parseFloat(mrpRaw) : null;
  const costPrice = mrp    ? mrp * 0.45          : null;

  // productName: prefer subproduct, fallback to product
  const productName = subproduct || product || category;

  return {
    skuCode,
    barcode,
    productName,
    colorCode,
    colorName:    color,
    size,
    fitType,
    mrp,
    costPrice,
    hsnCode,
    gender,
    season,
    styleCode,
    brand,
    styleVariant, // InforItemCode — critical for SalesAI SKU lookup
  };
}

// ─── Batch upsert (1000 rows → 1 INSERT statement) ────────────────────────────

async function upsertBatch(client, rows) {
  if (!rows.length) return { newRows: 0, updated: 0 };

  // 15 columns per row
  const placeholders = rows.map((_, i) => {
    const base = i * 15;
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15})`;
  }).join(',\n  ');

  const values = rows.flatMap(r => [
    r.skuCode, r.barcode, r.productName, r.colorCode, r.colorName,
    r.size, r.fitType, r.mrp, r.costPrice, r.hsnCode,
    r.gender, r.season, r.styleCode, r.brand, r.styleVariant,
  ]);

  const text = `
    INSERT INTO skus
      (sku_code, external_id, product_name, color_code, color_name,
       size, fit_type, mrp, cost_price, hsn_code,
       gender, season, style_code, brand, style_variant)
    VALUES
      ${placeholders}
    ON CONFLICT (external_id) DO UPDATE SET
      product_name   = EXCLUDED.product_name,
      color_code     = EXCLUDED.color_code,
      color_name     = EXCLUDED.color_name,
      size           = EXCLUDED.size,
      fit_type       = EXCLUDED.fit_type,
      mrp            = EXCLUDED.mrp,
      cost_price     = EXCLUDED.cost_price,
      hsn_code       = EXCLUDED.hsn_code,
      gender         = EXCLUDED.gender,
      season         = EXCLUDED.season,
      style_code     = EXCLUDED.style_code,
      brand          = EXCLUDED.brand,
      style_variant  = EXCLUDED.style_variant,
      updated_at     = NOW()
    RETURNING (xmax = 0) AS is_new
  `;

  const result = await client.query(text, values);
  const newRows = result.rows.filter(r => r.is_new).length;
  return { newRows, updated: result.rows.length - newRows };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function loadItemMaster() {
  const startTime = Date.now();
  const pgClient  = await pgPool.connect();

  try {
    // ── Safety check ──────────────────────────────────────────────────────────
    if (!FORCE) {
      const { rows } = await pgClient.query('SELECT COUNT(*) AS cnt FROM skus');
      const existing = parseInt(rows[0].cnt);
      if (existing > 1000) {
        console.warn(`\n⚠️  skus table already has ${existing.toLocaleString()} rows.`);
        console.warn('   This script will UPDATE existing items and INSERT new ones.');
        console.warn('   To proceed: node src/database/load_item_master.js --force\n');
        process.exit(1);
      }
    }

    await runMigration(pgClient);

    // ── Fetch from SQL Server ─────────────────────────────────────────────────
    console.log('\nConnecting to SQL Server (PRIMARY source)...');
    const sqlPool = await sql.connect(sqlConfig);
    console.log('✅ Connected to SQL Server');

    console.log('Fetching Item_spykar (large table — may take several minutes)...');
    const result = await sqlPool.request()
      .query('SELECT * FROM Item_spykar');
    const allRows = result.recordset;
    console.log(`   Fetched ${allRows.length.toLocaleString()} rows\n`);

    // Print actual column names from first row — critical for field mapping
    if (allRows.length > 0) {
      console.log('Column names from Item_spykar (first row):');
      console.log(' ', Object.keys(allRows[0]).join(', '));
      console.log('');
    }

    await sqlPool.close();

    const skuCodeCounts = new Map();
    for (const raw of allRows) {
      const { barcode, skuCode } = buildSkuCode(raw);
      if (!barcode) continue;
      skuCodeCounts.set(skuCode, (skuCodeCounts.get(skuCode) || 0) + 1);
    }

    // ── Batch upsert into PostgreSQL ──────────────────────────────────────────
    let totalNew     = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    const totalBatches = Math.ceil(allRows.length / BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
      const rawBatch = allRows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

      // Transform and filter
      const batch = [];
      for (const raw of rawBatch) {
        const row = transformRow(raw, skuCodeCounts);
        if (row) batch.push(row);
        else totalSkipped++;
      }

      if (batch.length > 0) {
        try {
          const { newRows, updated } = await upsertBatch(pgClient, batch);
          totalNew     += newRows;
          totalUpdated += updated;
        } catch (err) {
          // Row-level retry on batch failure
          for (const row of batch) {
            try {
              const { newRows, updated } = await upsertBatch(pgClient, [row]);
              totalNew     += newRows;
              totalUpdated += updated;
            } catch {
              totalSkipped++;
            }
          }
        }
      }

      // Progress every 10 batches
      if ((b + 1) % 10 === 0 || b === totalBatches - 1) {
        const done = Math.min((b + 1) * BATCH_SIZE, allRows.length);
        const pct  = ((done / allRows.length) * 100).toFixed(1);
        process.stdout.write(`\r  Loaded ${done.toLocaleString()} / ${allRows.length.toLocaleString()} rows (${pct}%)`);
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins    = Math.floor(elapsed / 60);
    const secs    = elapsed % 60;
    const time    = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    console.log(`\n\n✅ Item master loaded: ${(totalNew + totalUpdated).toLocaleString()} rows in ${time}`);
    console.log(`   New items:              ${totalNew.toLocaleString()}`);
    console.log(`   Updated:                ${totalUpdated.toLocaleString()}`);
    console.log(`   Skipped (no barcode):   ${totalSkipped.toLocaleString()}`);
    console.log('\nNext step: node src/database/load_party_master.js');

  } finally {
    pgClient.release();
    await pgPool.end();
  }
}

loadItemMaster().catch(err => {
  console.error('\n❌ Load failed:', err.message);
  process.exit(1);
});
