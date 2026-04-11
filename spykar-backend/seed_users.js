require('dotenv').config();
const { connectDatabase, pool } = require('./src/config/database');
const { connectRedis } = require('./src/config/redis');
const bcrypt = require('bcrypt');

async function seedUsersOnly() {
  await connectDatabase();
  await connectRedis();

  console.log('👤 Seeding users only...');

  const hash = await bcrypt.hash('Admin@123', 12);

  await pool.query('DELETE FROM users');
  await pool.query(`
    INSERT INTO users (name, email, password_hash, role, is_active)
    VALUES
      ('Super Admin',    'admin@spykar.com',   $1, 'SUPER_ADMIN', true),
      ('Spykar Manager', 'manager@spykar.com', $1, 'MANAGER',     true),
      ('Viewer',         'viewer@spykar.com',  $1, 'VIEWER',      true)
  `, [hash]);

  await pool.query('DELETE FROM zones');
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
  console.log('Now add constraints then run FULL sync from dashboard.');
  process.exit(0);
}

seedUsersOnly().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});