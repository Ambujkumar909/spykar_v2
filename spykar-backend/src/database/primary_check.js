/**
 * primary_check.js  —  M3 connectivity / access preflight for the Primary Sales feed
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-service diagnostic so a DBA can verify the M3ReportdataPRD grant landed
 * WITHOUT running the loader. Read-only; never writes anything.
 *
 *   node src/database/primary_check.js     (or:  npm run primary:check)
 *
 * Reads the same M3_* env (falling back to MSSQL_*) the real loader uses, then:
 *   1. connects to the M3 server
 *   2. prints the server name + databases the login can open
 *   3. searches every accessible DB for MITWHL / MITTRA / MITMAS
 *   4. runs the exact fully-qualified probe the loader needs
 *   5. prints a single READY / NOT READY verdict + the precise fix if blocked
 */

'use strict';

require('dotenv').config();
const sql = require('mssql');

const CFG = {
  server:   process.env.M3_HOST     || process.env.MSSQL_HOST,
  port:     parseInt(process.env.M3_PORT || process.env.MSSQL_PORT) || 1433,
  database: process.env.M3_DATABASE || process.env.MSSQL_DATABASE,
  user:     process.env.M3_USER     || process.env.MSSQL_USER,
  password: process.env.M3_PASSWORD || process.env.MSSQL_PASSWORD,
  encrypt:  (process.env.M3_ENCRYPT || process.env.MSSQL_ENCRYPT) === 'true',
};
const TARGET_DB = 'M3ReportdataPRD'; // the catalog the loader's queries reference
const TABLES = ['MITWHL', 'MITTRA', 'MITMAS'];

function baseConn(database) {
  return {
    server: CFG.server, port: CFG.port, database, user: CFG.user, password: CFG.password,
    options: { encrypt: CFG.encrypt, trustServerCertificate: true, connectionTimeout: 15000, requestTimeout: 90000, enableArithAbort: true },
  };
}

function line() { console.log('─'.repeat(64)); }

async function main() {
  console.log('='.repeat(64));
  console.log('Primary Sales — M3 connectivity & access check');
  console.log('='.repeat(64));
  console.log(`server   : ${CFG.server}:${CFG.port}`);
  console.log(`login    : ${CFG.user}`);
  console.log(`catalog  : ${CFG.database || '(default)'}  (target data DB: ${TARGET_DB})`);
  console.log(`password : ${CFG.password ? '(set, len ' + CFG.password.length + ')' : '*** NOT SET ***'}`);
  line();

  if (!CFG.server || !CFG.user || !CFG.password) {
    console.log('❌ NOT READY — missing M3_HOST / M3_USER / M3_PASSWORD (or MSSQL_* fallback) in .env');
    process.exit(1);
  }

  // ── 1. Connect. Try the configured catalog; if the login can't open it,
  //       fall back to master so we can still gather diagnostics. ────────────
  let pool, openedDb = CFG.database || 'master';
  try {
    pool = await sql.connect(baseConn(CFG.database || 'master'));
  } catch (e) {
    if (/Login failed/i.test(e.message) && (CFG.database && CFG.database.toLowerCase() !== 'master')) {
      console.log(`⚠  Could not open catalog "${CFG.database}" (${e.message.trim()}). Retrying via master for diagnostics…`);
      try { pool = await sql.connect(baseConn('master')); openedDb = 'master'; }
      catch (e2) { console.log(`❌ NOT READY — cannot connect at all: ${e2.message}`); process.exit(1); }
    } else {
      console.log(`❌ NOT READY — cannot connect: ${e.message}`);
      if (/getaddrinfo|ETIMEOUT|ECONNREFUSED|failed to connect/i.test(e.message)) {
        console.log('   → Wrong M3_HOST/M3_PORT or network/firewall is blocking the M3 server.');
      } else if (/Login failed/i.test(e.message)) {
        console.log('   → Bad M3_USER/M3_PASSWORD.');
      }
      process.exit(1);
    }
  }

  try {
    const sv = (await pool.request().query('SELECT @@SERVERNAME AS n')).recordset[0].n;
    console.log(`✔ Connected (opened "${openedDb}") — serverName: ${sv}`);

    // ── 2. Accessible databases ───────────────────────────────────────────
    const dbs = (await pool.request().query('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name)=1 ORDER BY name')).recordset.map(r => r.name);
    console.log(`✔ Databases this login can open: ${dbs.join(', ')}`);
    const targetVisible = dbs.some(d => d.toLowerCase() === TARGET_DB.toLowerCase());
    console.log(`  ${TARGET_DB} accessible: ${targetVisible ? 'YES' : 'NO'}`);

    // ── 3. Search accessible DBs for the MIT* tables ──────────────────────
    const found = [];
    for (const db of dbs) {
      try {
        const q = await pool.request().query(
          `SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME
             FROM [${db}].INFORMATION_SCHEMA.TABLES
            WHERE TABLE_NAME IN ('${TABLES.join("','")}')`
        );
        for (const r of q.recordset) found.push(`${r.TABLE_CATALOG}.${r.TABLE_SCHEMA}.${r.TABLE_NAME}`);
      } catch (_) { /* skip unreadable db */ }
    }
    if (found.length) { console.log('✔ MIT* tables found in accessible DBs:'); found.forEach(f => console.log('   ★ ' + f)); }
    else console.log('  MIT* tables found in accessible DBs: NONE');

    // ── 4. The exact probe the loader runs ────────────────────────────────
    line();
    let probeOk = true, probeErr = null, sample = null;
    for (const t of TABLES) {
      try {
        const r = await pool.request().query(`SELECT TOP 1 1 AS ok FROM ${TARGET_DB}.dbo.${t}`);
        if (t === 'MITWHL') {
          const w = await pool.request().query(`SELECT COUNT(*) AS c FROM ${TARGET_DB}.dbo.MITWHL WHERE CONO=92 AND DIVI='AAA'`);
          sample = w.recordset[0].c;
        }
        console.log(`✔ SELECT on ${TARGET_DB}.dbo.${t} — OK`);
      } catch (e) { probeOk = false; probeErr = e.message; console.log(`✗ SELECT on ${TARGET_DB}.dbo.${t} — FAIL: ${e.message}`); break; }
    }

    // ── 5. Verdict ────────────────────────────────────────────────────────
    line();
    if (probeOk) {
      console.log('✅ READY — the loader can read all three M3 tables.');
      console.log(`   AAA warehouses (CONO=92, DIVI='AAA') visible: ${sample}`);
      console.log('   Next: npm run primary:warehouses  →  npm run primary:backfill');
      process.exit(0);
    } else {
      console.log('❌ NOT READY — the login cannot read the M3 source tables.');
      if (/Invalid object name/i.test(probeErr || '')) {
        console.log(`   → ${TARGET_DB} is not on this server (${CFG.server}), or this login can't see it.`);
        console.log('     Point M3_HOST at the server that actually hosts M3ReportdataPRD, OR have a DBA');
        console.log(`     grant this login read access there:`);
        console.log(`        USE [${TARGET_DB}]; CREATE USER [${CFG.user}] FOR LOGIN [${CFG.user}];`);
        console.log(`        ALTER ROLE db_datareader ADD MEMBER [${CFG.user}];`);
      } else if (/permission|denied/i.test(probeErr || '')) {
        console.log(`   → Connected but lacks SELECT. Have a DBA add this login to db_datareader on ${TARGET_DB}.`);
      } else {
        console.log(`   → ${probeErr}`);
      }
      process.exit(2);
    }
  } finally {
    try { await pool.close(); } catch (_) {}
  }
}

main().catch(err => { console.error('\n❌ check crashed:', err.message || err); process.exit(1); });
