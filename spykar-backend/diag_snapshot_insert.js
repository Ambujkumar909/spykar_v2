// Diagnose why the snapshot-swap INSERT (5M rows) takes ~19 min.
// Uses catalog estimates (no count(*)) to avoid blocking on the rolling-back txn.
require('dotenv').config();
const { query } = require('./src/config/database');

(async () => {
  // 1) Is a rollback / heavy txn still active on inventory_snapshot?
  const act = await query(`
    SELECT pid, state, wait_event_type, wait_event,
           EXTRACT(EPOCH FROM (NOW()-xact_start))::int xact_age_s,
           LEFT(regexp_replace(query,'\\s+',' ','g'),70) q
    FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND (state<>'idle' OR query ILIKE '%inventory_snapshot%')
    ORDER BY xact_start NULLS LAST`);
  console.log('=== active/relevant backends ===');
  act.rows.forEach(r => console.log(' ', JSON.stringify(r)));

  // 2) Row estimates (no lock) for the tables involved
  const est = await query(`
    SELECT relname, reltuples::bigint est_rows,
           pg_size_pretty(pg_total_relation_size(oid)) total_size,
           relpersistence
    FROM pg_class
    WHERE relname IN ('inventory_snapshot','inventory_snapshot_next','stg_stock','locations','skus')
    ORDER BY relname`);
  console.log('\n=== table estimates (relpersistence: p=permanent,u=unlogged,t=temp) ===');
  est.rows.forEach(r => console.log(' ', JSON.stringify(r)));

  // 3) inventory_snapshot structure: indexes, FKs, generated/default cols
  const idx = await query(`SELECT indexname, LEFT(indexdef,140) def FROM pg_indexes WHERE tablename='inventory_snapshot'`);
  console.log('\n=== inventory_snapshot indexes ===');
  idx.rows.forEach(r => console.log(' ', r.indexname, '::', r.def));

  const fks = await query(`
    SELECT conname, pg_get_constraintdef(oid) def
    FROM pg_constraint WHERE conrelid='inventory_snapshot'::regclass AND contype IN ('f','u','p')`);
  console.log('\n=== inventory_snapshot p/u/f constraints ===');
  fks.rows.forEach(r => console.log(' ', r.conname, '::', r.def));

  const cols = await query(`
    SELECT column_name, data_type, column_default, is_generated, generation_expression
    FROM information_schema.columns
    WHERE table_name='inventory_snapshot' ORDER BY ordinal_position`);
  console.log('\n=== inventory_snapshot columns ===');
  cols.rows.forEach(r => console.log(' ', JSON.stringify(r)));

  // 4) WAL / checkpoint / memory settings that gate bulk-insert speed
  const settings = await query(`
    SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('wal_level','max_wal_size','min_wal_size','checkpoint_timeout',
      'checkpoint_completion_target','wal_compression','full_page_writes',
      'synchronous_commit','fsync','shared_buffers','wal_buffers','work_mem',
      'maintenance_work_mem','max_parallel_workers','max_parallel_maintenance_workers',
      'autovacuum','data_checksums')
    ORDER BY name`);
  console.log('\n=== relevant settings ===');
  settings.rows.forEach(r => console.log('  ', r.name, '=', r.setting, r.unit||''));

  // 5) Recent checkpoint activity (are checkpoints firing during loads?)
  try {
    const cp = await query(`SELECT num_timed, num_requested, write_time, sync_time FROM pg_stat_checkpointer`);
    console.log('\n=== pg_stat_checkpointer ===', JSON.stringify(cp.rows[0]));
  } catch (_) {
    try { const cp = await query(`SELECT checkpoints_timed, checkpoints_req, checkpoint_write_time, checkpoint_sync_time FROM pg_stat_bgwriter`);
      console.log('\n=== pg_stat_bgwriter ===', JSON.stringify(cp.rows[0])); } catch(e){ console.log('checkpoint stats n/a:', e.message); }
  }

  process.exit(0);
})().catch(e => { console.error('DIAG ERROR:', e.message); process.exit(1); });
