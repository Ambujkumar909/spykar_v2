const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('../config/logger');

// ─── ESales stock folder watcher ─────────────────────────────────────────────
// Keeps Postgres in step with the folder of "E-Sales <month>.xlsx" workbooks
// (ESALES_STOCK_DIR — the local mirror of the OneDrive folder). Every few
// seconds it compares the folder's listing (name, size, modified time) with
// the last one it acted on; on any difference — a workbook added, edited,
// renamed or removed — it runs the loader (database/load_esales_stock.js),
// which works out exactly what changed by sha256 and replaces only those
// snapshots. The API notices the new data on its next state check (≤ 5 s).
//
// Why a child process: parsing a workbook is CPU-bound (~0.7 s each) and would
// stall every request if it ran on the API's event loop.
// Why polling, not fs.watch: a copy in progress fires dozens of events on a
// half-written file. A half-written workbook simply fails its zip check, is
// rejected (the previously loaded version stays), and loads on a later tick
// once the copy has finished and the listing changes again.
//
// --prune is on: the folder is a mirror, so a workbook removed from it takes
// its snapshot out of the database. An empty or missing folder never prunes
// (the loader refuses). Set ESALES_STOCK_PRUNE=false to keep removed files' data.

const LOADER = path.join(__dirname, '..', 'database', 'load_esales_stock.js');
const LOG = path.join(process.cwd(), 'logs', 'esales-load.log');

function listing(dir) {
  return fs.readdirSync(dir)
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .sort()
    .map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; })
    .join('|');
}

function startEsalesWatcher() {
  const dir = process.env.ESALES_STOCK_DIR;
  if (!dir) { logger.info('ESales stock watcher off (ESALES_STOCK_DIR not set)'); return; }
  const everyMs = Math.max(5, parseInt(process.env.ESALES_WATCH_SECONDS, 10) || 15) * 1000;
  const prune = process.env.ESALES_STOCK_PRUNE !== 'false';
  let acted = null;       // the listing the loader last ran against
  let running = false;

  const tick = () => {
    if (running) return;
    let now;
    try { now = listing(dir); } catch (err) { now = `unreadable: ${err.code || err.message}`; }
    if (now === acted) return;
    if (now.startsWith('unreadable')) { acted = now; logger.warn(`ESales stock folder ${dir} ${now}`); return; }

    running = true;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const out = fs.openSync(LOG, 'a');
    fs.writeSync(out, `\n── ${new Date().toISOString()} folder changed\n`);
    const child = spawn(process.execPath, [LOADER, `--dir=${dir}`, ...(prune ? ['--prune'] : [])], {
      stdio: ['ignore', out, out],
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, PG_STATEMENT_TIMEOUT: '0' },   // the API's 40 s per-query cap is not for loads
      windowsHide: true,
    });
    fs.closeSync(out);
    // A change made while the loader ran shows up as a different listing on the next tick.
    const done = (how) => { running = false; acted = now; logger.info(`📦 ESales stock folder changed — loader ${how} (details: logs/esales-load.log)`); };
    child.on('exit', (code) => done(code === 0 ? 'finished' : `finished with rejected workbooks (exit ${code})`));
    child.on('error', (err) => done(`could not start: ${err.message}`));
  };

  tick();
  const timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  logger.info(`📦 ESales stock watcher on — ${dir}, checked every ${everyMs / 1000}s${prune ? ', removed workbooks are pruned' : ''}`);
}

module.exports = { startEsalesWatcher };
