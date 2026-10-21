// One-time (or repair) build of the War Room rollups from inventory_movements:
// wr_store_day / wr_cat_day (afterwards every sync keeps them current together
// with srd_store — services/salesRollup.js), then the closing-stock rollup
// wr_stock_cat for EVERY daily snapshot, so any as-on date opens instantly.
//   npm run warroom:build            both
//   npm run warroom:build -- --stock stock only
require('dotenv').config();
process.env.PG_STATEMENT_TIMEOUT = '0';
const { transaction, query } = require('../config/database');
const { rebuildWarRoom } = require('../services/salesRollup');
const { ensureStock } = require('../services/warRoom');

(async () => {
  if (!process.argv.includes('--stock')) console.log('War Room rollups built:', await transaction((c) => rebuildWarRoom(c)));
  const { rows } = await query(`SELECT DISTINCT snapshot_date::text AS d FROM inventory_daily_snapshot ORDER BY 1 DESC`);
  const t0 = Date.now();
  for (const [i, { d }] of rows.entries()) {
    await ensureStock(d);
    if ((i + 1) % 25 === 0 || i === rows.length - 1) console.log(`  stock ${i + 1}/${rows.length} days (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  process.exit(0);
})().catch((e) => { console.error('War Room build failed:', e.message); process.exit(1); });
