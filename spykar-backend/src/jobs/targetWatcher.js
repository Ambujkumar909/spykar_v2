const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const logger = require('../config/logger');

// ─── War Room target folder watcher ──────────────────────────────────────────
// Keeps wr_targets in step with the DaywiseTarget folder (WR_TARGET_DIR — the
// OneDrive mirror, refreshed every 3 days at 01:00 by onedrive_pull.sh). Every
// minute it compares the folder listing (name, size, modified time) with the
// last one it acted on; on a change it runs the loader in a child process
// (parsing a 100 MB sheet must not stall the API), then drops the War Room's
// cached boards so the new targets show on the next request. The loader skips
// files it has already loaded (sha256) and refuses a file that lost over half
// of the store-days, so a bad upload never replaces good targets.
const LOADER = path.join(__dirname, '..', 'database', 'load_war_room_targets.js');
const LOG = path.join(process.cwd(), 'logs', 'war-room-targets.log');

function listing(dir) {
  return fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort()
    .map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
}

function startTargetWatcher() {
  const dir = process.env.WR_TARGET_DIR || path.join(os.homedir(), 'spykar/onedrive/Target_Data/DaywiseTarget');
  let acted = null; let running = false;
  const tick = () => {
    if (running) return;
    let now;
    try { now = listing(dir); } catch (err) { now = `unreadable: ${err.code || err.message}`; }
    if (now === acted) return;
    if (now.startsWith('unreadable')) { acted = now; logger.warn(`War Room target folder ${dir} ${now}`); return; }
    running = true;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const out = fs.openSync(LOG, 'a');
    fs.writeSync(out, `\n── ${new Date().toISOString()} target folder changed\n`);
    const child = spawn(process.execPath, ['--max-old-space-size=4096', LOADER], {
      stdio: ['ignore', out, out], cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, WR_TARGET_DIR: dir, PG_STATEMENT_TIMEOUT: '0' }, windowsHide: true,
    });
    fs.closeSync(out);
    const done = async (how) => {
      running = false; acted = now;
      try {
        const { invalidatePattern } = require('../config/cache');
        await invalidatePattern('wr:board:*');
      } catch (e) { logger.warn(`War Room cache flush after target load failed: ${e.message}`); }
      logger.info(`🎯 War Room targets — loader ${how} (details: logs/war-room-targets.log)`);
    };
    child.on('exit', (code) => done(code === 0 ? 'finished' : `failed (exit ${code}) — previous targets kept`));
    child.on('error', (err) => done(`could not start: ${err.message}`));
  };
  tick();
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  logger.info(`🎯 War Room target watcher on — ${dir}, checked every 60s`);
}

module.exports = { startTargetWatcher };
