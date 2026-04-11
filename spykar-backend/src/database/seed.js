/**
 * Database Seeder — Users Only
 * Seeds the 3 application user accounts (admin, manager, viewer).
 * Real inventory data is sourced from SQL Server via the sync service.
 *
 * Usage: npm run db:seed
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'spykar_inventory',
  user:     process.env.PG_USER     || 'spykar_app',
  password: process.env.PG_PASSWORD,
});

const USERS = [
  { email: 'admin@spykar.com',   password: 'Admin@123',   name: 'Super Admin',     role: 'SUPER_ADMIN' },
  { email: 'manager@spykar.com', password: 'Manager@123', name: 'Inventory Head',  role: 'MANAGER'     },
  { email: 'viewer@spykar.com',  password: 'Viewer@123',  name: 'Sales Viewer',    role: 'VIEWER'      },
];

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('👤 Seeding users...');

    for (const u of USERS) {
      const passwordHash = await bcrypt.hash(u.password, SALT_ROUNDS);
      await client.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           name          = EXCLUDED.name,
           role          = EXCLUDED.role`,
        [u.email, passwordHash, u.name, u.role],
      );
      console.log(`  ✓ ${u.email} (${u.role})`);
    }

    await client.query('COMMIT');
    console.log('✅ Done. Login: admin@spykar.com / Admin@123');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
