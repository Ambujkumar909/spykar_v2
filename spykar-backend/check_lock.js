require('dotenv').config();
const db = require('./src/config/database');

(async () => {
  try {
    // 1. Is the sync advisory lock (4815, 162342) currently held?
    const locks = await db.query(
      `SELECT l.pid, a.state, a.application_name, a.query_start, a.state_change
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.classid = 4815
          AND l.objid = 162342`
    );
    console.log('ADVISORY LOCK (4815,162342) holders:', locks.rowCount);
    locks.rows.forEach(r => console.log('  ', JSON.stringify(r)));

    // 2. Snapshot freshness — most recent business dates present
    const snap = await db.query(
      `SELECT snapshot_date, COUNT(*) AS rows, MAX(updated_at) AS last_updated
         FROM inventory_snapshot
        GROUP BY snapshot_date
        ORDER BY snapshot_date DESC
        LIMIT 5`
    );
    console.log('\ninventory_snapshot — latest dates:');
    snap.rows.forEach(r => console.log('  ', r.business_date, '=>', r.rows, 'rows'));

    // 3. Any in-progress sync recorded?
    try {
      const runs = await db.query(
        `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 3`
      );
      console.log('\nsync_runs (latest 3):');
      runs.rows.forEach(r => console.log('  ', JSON.stringify(r)));
    } catch (e) {
      console.log('\n(sync_runs table not present:', e.message, ')');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit(0);
  }
})();
