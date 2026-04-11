/**
 * load_party_master.js
 * One-time bulk load of party/store master from AIgetParty (SQL Server) → locations (PostgreSQL)
 *
 * Run:        node src/database/load_party_master.js
 * Force reload: node src/database/load_party_master.js --force
 *
 * Data source: PRIMARY (Spykar ERP SQL Server)
 * Designed so a SECONDARY source can be plugged in later by replacing
 * the fetchRows() function only — the PostgreSQL upsert logic stays unchanged.
 */

'use strict';

require('dotenv').config();
const sql      = require('mssql');
const { Pool } = require('pg');

// ─── Config ───────────────────────────────────────────────────────────────────

const FORCE = process.argv.includes('--force');

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
    connectionTimeout:      30000,
  },
};

const pgPool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// ─── State → Zone mapping ─────────────────────────────────────────────────────

const STATE_ZONE_MAP = {
  // WEST
  'MAHARASHTRA': 'WEST', 'GUJARAT': 'WEST', 'RAJASTHAN': 'WEST',
  'GOA': 'WEST', 'DADRA AND NAGAR HAVELI': 'WEST', 'DAMAN AND DIU': 'WEST',
  // NORTH
  'DELHI': 'NORTH', 'PUNJAB': 'NORTH', 'HARYANA': 'NORTH',
  'UTTAR PRADESH': 'NORTH', 'UTTARAKHAND': 'NORTH',
  'HIMACHAL PRADESH': 'NORTH', 'JAMMU AND KASHMIR': 'NORTH',
  'CHANDIGARH': 'NORTH', 'LADAKH': 'NORTH',
  // SOUTH
  'KARNATAKA': 'SOUTH', 'TAMIL NADU': 'SOUTH', 'KERALA': 'SOUTH',
  'ANDHRA PRADESH': 'SOUTH', 'TELANGANA': 'SOUTH',
  'PUDUCHERRY': 'SOUTH', 'ANDAMAN AND NICOBAR': 'SOUTH',
  // EAST
  'WEST BENGAL': 'EAST', 'ODISHA': 'EAST', 'BIHAR': 'EAST',
  'JHARKHAND': 'EAST', 'ASSAM': 'EAST', 'MEGHALAYA': 'EAST',
  'TRIPURA': 'EAST', 'MANIPUR': 'EAST', 'MIZORAM': 'EAST',
  'NAGALAND': 'EAST', 'ARUNACHAL PRADESH': 'EAST', 'SIKKIM': 'EAST',
  // CENTRAL
  'MADHYA PRADESH': 'CENTRAL', 'CHHATTISGARH': 'CENTRAL',
};

// ─── GGroupName → location type ───────────────────────────────────────────────

function resolveLocationType(gGroupName) {
  const g = (gGroupName || '').toUpperCase();
  // Spykar real GRoupName values
  if (g.includes('EBO'))                                   return 'FOFO';       // EBO-SOR, EBO-Outright
  if (g.includes('COCO') || g.includes('COMPANY OWNED'))  return 'COCO';
  if (g.includes('FOFO') || g.includes('FRANCHISE'))       return 'FOFO';
  if (g.includes('ALTERNATE') || g.includes('ALT'))        return 'DISTRIBUTOR'; // Alternate-SOR, Alternate-Outright
  if (g.includes('DIST') || g.includes('DISTRIBUTOR'))     return 'DISTRIBUTOR';
  if (g.includes('WAREHOUSE') || g.includes('WH'))         return 'WAREHOUSE';
  return 'DISTRIBUTOR'; // safe default
}

// ─── Build location code from type + store number ─────────────────────────────

function buildLocCode(locType, storeNumber) {
  const num = String(storeNumber || '').trim();
  if (!num) return null;
  switch (locType) {
    case 'COCO':        return `COCO-${num}`;
    case 'FOFO':        return `FOFO-${num}`;
    case 'WAREHOUSE':   return `WH-${num}`;
    case 'DISTRIBUTOR':
    default:            return `DIST-${num}`;
  }
}

// ─── PRIMARY data source: fetch rows from EXEC AIgetParty ────────────────────
// To plug in a SECONDARY source later, replace this function only.
// The upsertRow() function below stays unchanged regardless of data source.
async function fetchRows(erpPool) {
  const result = await erpPool.request().query(`EXEC AIgetParty`);
  return result.recordset;
}

// ─── Read a field from row — tries multiple common casing variants ─────────────
function col(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
    const upper = name.toUpperCase();
    if (row[upper] !== undefined && row[upper] !== null) return row[upper];
    const lower = name.toLowerCase();
    if (row[lower] !== undefined && row[lower] !== null) return row[lower];
  }
  return '';
}

// ─── Upsert a single row into PostgreSQL locations table ─────────────────────
async function upsertRow(pgClient, row, zoneCache) {
  // Adjust these field names to match actual AIgetParty column names if needed.
  // Running with --force will print the first row's column names for reference.
  const storeNumber = String(col(row, 'STORENUMBER', 'StoreNumber', 'store_number', 'STORE_NO') || '').trim();
  const gGroupName  = col(row, 'GGROUPNAME', 'GGroupName', 'GRoupName', 'ggroup_name', 'GROUP_NAME', 'GROUPNAME', 'GroupName');
  const partyName   = col(row, 'Shopname', 'SHOPNAME', 'shopname', 'PARTYNAME', 'PartyName', 'party_name', 'NAME') || gGroupName;
  const state       = String(col(row, 'STATE', 'State') || '').trim().toUpperCase();
  const city        = col(row, 'CITY', 'City');
  const pincode     = col(row, 'PINCODE', 'Pincode', 'PIN');
  const gstin       = col(row, 'GSTIN', 'Gstin', 'gstin', 'GST_NO');
  const phone       = col(row, 'PHONE', 'Phone', 'CONTACTNO', 'ContactNo', 'MOBILE');
  const email       = col(row, 'EMAIL', 'Email');
  const externalId  = storeNumber;

  if (!externalId) return { ok: false }; // skip rows with no identifier

  const locType = resolveLocationType(String(gGroupName));
  const code    = buildLocCode(locType, storeNumber);
  if (!code) return { ok: false };

  // Zone lookup — graceful: null if state not in map (no crash)
  const zoneName = STATE_ZONE_MAP[state] || null;
  let zoneId = null;

  if (zoneName) {
    if (zoneCache.has(zoneName)) {
      zoneId = zoneCache.get(zoneName);
    } else {
      const zr = await pgClient.query(
        `SELECT id FROM zones WHERE name = $1 LIMIT 1`,
        [zoneName]
      );
      zoneId = zr.rows[0]?.id || null;
      zoneCache.set(zoneName, zoneId); // cache per run to avoid redundant queries
    }
  }

  // Normalise GGroupName: trim and preserve original casing for display
  const groupNameRaw = String(gGroupName || '').trim() || null;

  const res = await pgClient.query(`
    INSERT INTO locations
      (code, name, type, group_name, zone_id, city, state, pincode,
       contact_phone, contact_email, gstin, external_id, is_active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, true)
    ON CONFLICT (external_id) DO UPDATE SET
      code          = EXCLUDED.code,
      name          = EXCLUDED.name,
      type          = EXCLUDED.type,
      group_name    = EXCLUDED.group_name,
      zone_id       = COALESCE(EXCLUDED.zone_id, locations.zone_id),
      city          = EXCLUDED.city,
      state         = EXCLUDED.state,
      pincode       = EXCLUDED.pincode,
      contact_phone = EXCLUDED.contact_phone,
      contact_email = EXCLUDED.contact_email,
      gstin         = EXCLUDED.gstin,
      is_active     = true,
      updated_at    = NOW()
    RETURNING (xmax = 0) AS is_new
  `, [
    code,
    partyName || code,
    locType,
    groupNameRaw,
    zoneId,
    city    || null,
    state   || null,
    pincode || null,
    phone   || null,
    email   || null,
    gstin   || null,
    externalId,
  ]);

  return { ok: true, isNew: res.rows[0]?.is_new === true };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('load_party_master.js — AIgetParty → locations');
  console.log('='.repeat(60));

  // Safety check: skip if table already populated (unless --force)
  const pg0 = await pgPool.connect();
  let existingCount = 0;
  try {
    const r = await pg0.query('SELECT COUNT(*) AS cnt FROM locations');
    existingCount = parseInt(r.rows[0].cnt, 10);
  } finally {
    pg0.release();
  }

  if (existingCount > 10 && !FORCE) {
    console.log(`\nLocations table already has ${existingCount} rows.`);
    console.log('Use --force to reload:  node src/database/load_party_master.js --force');
    return;
  }
  if (existingCount > 10 && FORCE) {
    console.log(`\n--force flag: will upsert over ${existingCount} existing rows`);
  }

  const startTime = Date.now();
  let erpPool;

  try {
    // Connect to PRIMARY source (SQL Server)
    console.log(`\nConnecting to SQL Server ${process.env.MSSQL_HOST}:${process.env.MSSQL_PORT || 1433}...`);
    erpPool = await sql.connect(sqlConfig);
    console.log('SQL Server connected.');

    console.log('Running EXEC AIgetParty ...');
    const rows = await fetchRows(erpPool);
    console.log(`Fetched ${rows.length} rows`);

    if (rows.length === 0) {
      console.log('No rows returned. Exiting.');
      return;
    }

    // Print column names from first row — helps user verify / map fields
    console.log('\nColumn names returned by AIgetParty:');
    console.log(' ', Object.keys(rows[0]).join(', '));
    console.log('');

    // Upsert into PostgreSQL
    const pg       = await pgPool.connect();
    const zoneCache = new Map();
    let newCount = 0, updCount = 0, skipCount = 0;

    try {
      for (let i = 0; i < rows.length; i++) {
        try {
          const { ok, isNew } = await upsertRow(pg, rows[i], zoneCache);
          if (!ok)      { skipCount++; continue; }
          if (isNew)    newCount++;
          else          updCount++;
        } catch (err) {
          console.error(`\nRow ${i} error:`, err.message);
          skipCount++;
        }

        if ((i + 1) % 250 === 0 || i === rows.length - 1) {
          const pct = Math.round(((i + 1) / rows.length) * 100);
          process.stdout.write(`\rLoaded ${i + 1} / ${rows.length} rows (${pct}%)   `);
        }
      }
      process.stdout.write('\n');
    } finally {
      pg.release();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '─'.repeat(60));
    console.log(`Done in ${elapsed}s`);
    console.log(`  New      : ${newCount}`);
    console.log(`  Updated  : ${updCount}`);
    console.log(`  Skipped  : ${skipCount}`);
    console.log('─'.repeat(60));

  } finally {
    if (erpPool) await erpPool.close().catch(() => {});
    await pgPool.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  if (err.code)   console.error('Code   :', err.code);
  if (err.stack)  console.error('Stack  :', err.stack);
  process.exit(1);
});
