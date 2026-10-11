/**
 * load_esales_stock.js — CLI for the ESales partner stock workbooks
 * ─────────────────────────────────────────────────────────────────────────────
 *   node src/database/load_esales_stock.js --dir=<folder> [--prune] [--dry-run]
 *   node src/database/load_esales_stock.js --rebuild
 *
 *   --dir      folder holding the "E-Sales <month>.xlsx" workbooks
 *              (default: $ESALES_STOCK_DIR)
 *   --prune    also remove snapshots whose workbook has left the folder
 *   --dry-run  read + validate every changed workbook, write nothing
 *   --rebuild  only refresh the derived data (item attributes, the page's
 *              pre-joined rows) — e.g. after editing esales_partners.channel
 *
 * New workbooks are added, changed ones (sha256) replace their snapshot,
 * unchanged ones are skipped — safe to run after every OneDrive pull.
 * Exits 1 if any workbook was rejected (its previous version stays loaded).
 * Rules: see src/services/esalesStock.js.
 */

'use strict';

require('dotenv').config();
const { loadFolder, rebuildItems } = require('../services/esalesStock');
const { pool } = require('../config/database');

const ARGS = process.argv.slice(2);
const argVal = (k) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };

async function main() {
  if (ARGS.includes('--rebuild')) { console.log(`ESales stock: derived data rebuilt (${await rebuildItems()} barcodes matched to the item master)`); return 0; }
  const dir = argVal('dir') || process.env.ESALES_STOCK_DIR;
  if (!dir) { console.error('Usage: node load_esales_stock.js --dir=<folder> [--prune] [--dry-run] | --rebuild'); process.exit(1); }
  const dryRun = ARGS.includes('--dry-run');
  console.log(`ESales stock ${dryRun ? 'dry run' : 'load'} — ${dir}`);
  const r = await loadFolder(dir, { prune: ARGS.includes('--prune'), dryRun, log: console.log });
  console.log(`${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, `
    + `${r.removed.length} removed, ${r.missing.length} missing from folder, ${r.failed.length} rejected, ${r.warnings.length} warning(s)`);
  return r.failed.length ? 1 : 0;
}

main()
  .then((code) => pool.end().then(() => process.exit(code)))
  .catch((err) => { console.error(err.message); process.exit(1); });
