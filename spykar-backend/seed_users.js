require('dotenv').config();
const { connectDatabase, pool } = require('./src/config/database');
const bcrypt = require('bcrypt');

async function seedUsersOnly() {
  await connectDatabase();

  console.log('👤 Seeding users only...');

  const hash = await bcrypt.hash('Admin@123', 12);

  // Insert-if-missing only. This used to DELETE FROM users first, so re-running
  // it on a live system wiped every account (and, by cascade, their sessions
  // and AI history) and reset the admins to the default password.
  const ins = await pool.query(`
    INSERT INTO users (name, email, password_hash, role, is_active)
    VALUES
      ('Super Admin',    'admin@spykar.com',   $1, 'SUPER_ADMIN', true),
      ('Spykar Manager', 'manager@spykar.com', $1, 'MANAGER',     true),
      ('Viewer',         'viewer@spykar.com',  $1, 'VIEWER',      true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      WHERE users.password_hash LIKE '%placeholder%'   -- schema.sql's unusable stub
  `, [hash]);
  console.log(`   ${ins.rowCount} user(s) created or activated; real accounts left untouched`);

  await pool.query(`
    INSERT INTO zones (code, name) VALUES
      ('NORTH',   'North India'),
      ('SOUTH',   'South India'),
      ('EAST',    'East India'),
      ('WEST',    'West India'),
      ('CENTRAL', 'Central India')
    ON CONFLICT (code) DO NOTHING
  `);

  console.log('✅ Users seeded:');
  console.log('   admin@spykar.com   / Admin@123  (SUPER_ADMIN)');
  console.log('   manager@spykar.com / Admin@123  (MANAGER)');
  console.log('   viewer@spykar.com  / Admin@123  (VIEWER)');
  console.log('✅ Zones seeded: NORTH, SOUTH, EAST, WEST, CENTRAL');
  console.log('');
  console.log('Next: load the masters (load_party_master.js, load_item_master.js), then run the FULL sync.');
  process.exit(0);
}

seedUsersOnly().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});