// Diagnostic probe: why does AIGetStock 100%-miss the master lookups?
// Streams a sample of AIGetStock rows and tests each against the SAME
// lookup maps the sync engine builds, reporting match rate + miss reasons.
require('dotenv').config();
const sql = require('mssql');
const { query } = require('./src/config/database');

const SAMPLE = parseInt(process.argv[3] || '800', 10);
const dateStr = process.argv[2] || (() => {
  const d = new Date();
  const m = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][d.getMonth()];
  return `${String(d.getDate()).padStart(2,'0')}-${m}-${String(d.getFullYear()).slice(-2)}`;
})();

function col(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
    if (row[name.toUpperCase()] !== undefined && row[name.toUpperCase()] !== null) return row[name.toUpperCase()];
    if (row[name.toLowerCase()] !== undefined && row[name.toLowerCase()] !== null) return row[name.toLowerCase()];
  }
  return null;
}

(async () => {
  // Build the exact same maps as buildLookupMaps()
  const [locRows, skuRows] = await Promise.all([
    query('SELECT id, code, external_id FROM locations WHERE is_active = true'),
    query('SELECT id, external_id, style_variant FROM skus WHERE is_active = true'),
  ]);
  const locationByCode = new Map(), locationByExtId = new Map();
  const skuByStyleVariant = new Map(), skuByExtId = new Map();
  for (const r of locRows.rows) {
    if (r.code) locationByCode.set(r.code.toUpperCase().trim(), r.id);
    if (r.external_id) locationByExtId.set(String(r.external_id).toUpperCase().trim(), r.id);
  }
  for (const r of skuRows.rows) {
    if (r.style_variant) skuByStyleVariant.set(r.style_variant.toUpperCase().trim(), r.id);
    if (r.external_id) skuByExtId.set(String(r.external_id).toUpperCase().trim(), r.id);
  }
  console.log(`Maps: ${locationByExtId.size} loc extId, ${locationByCode.size} loc code, ${skuByExtId.size} sku extId, ${skuByStyleVariant.size} sku styleVariant`);

  await sql.connect({
    server: process.env.MSSQL_HOST, port: parseInt(process.env.MSSQL_PORT)||1433,
    database: process.env.MSSQL_DATABASE, user: process.env.MSSQL_USER, password: process.env.MSSQL_PASSWORD,
    options: { encrypt: process.env.MSSQL_ENCRYPT==='true', trustServerCertificate: true, requestTimeout: 120000 },
  });
  console.log(`MSSQL connected. EXEC AIGetStock '${dateStr}' (sampling ${SAMPLE} rows)`);

  const req = new sql.Request();
  req.stream = true;
  let seen=0, locHit=0, skuHit=0, both=0, locMiss=0, skuMiss=0;
  const missSamples = [];
  await new Promise((resolve, reject) => {
    req.on('row', (row) => {
      if (seen >= SAMPLE) return;
      seen++;
      const storeCode = String(col(row,'Storecode','STORECODE','storecode')||'').trim().toUpperCase();
      const barcode   = String(col(row,'barcode','BARCODE','Barcode')||'').trim().toUpperCase();
      const styleVar  = String(col(row,'InforItemCode','INFORITEMCODE','style_variant')||'').trim().toUpperCase();
      const lId = locationByExtId.get(storeCode) || locationByCode.get(storeCode);
      const sId = skuByExtId.get(barcode) || skuByStyleVariant.get(styleVar);
      if (lId) locHit++; else locMiss++;
      if (sId) skuHit++; else skuMiss++;
      if (lId && sId) both++;
      if ((!lId || !sId) && missSamples.length < 15) {
        missSamples.push({ storeCode, barcode, styleVar, loc: !!lId, sku: !!sId,
          rawKeys: Object.keys(row).join(',') });
      }
      if (seen >= SAMPLE) { try { req.cancel(); } catch(_){} }
    });
    req.on('error', (e)=> { if (!/canceled/i.test(e.message)) reject(e); });
    req.on('done', resolve);
    req.query(`EXEC AIGetStock '${dateStr}'`);
  });

  console.log(`\n=== RESULTS (${seen} rows sampled) ===`);
  console.log(`location match: ${locHit}/${seen} (${(100*locHit/seen).toFixed(1)}%)  miss: ${locMiss}`);
  console.log(`sku match:      ${skuHit}/${seen} (${(100*skuHit/seen).toFixed(1)}%)  miss: ${skuMiss}`);
  console.log(`BOTH match:     ${both}/${seen} (${(100*both/seen).toFixed(1)}%)  <-- rows that would actually load`);
  console.log(`\n=== sample misses (loc/sku=true means that side matched) ===`);
  missSamples.forEach(m => console.log(JSON.stringify(m)));
  process.exit(0);
})().catch(e => { console.error('PROBE ERROR:', e.message); process.exit(1); });
