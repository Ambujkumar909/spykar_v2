/**
 * Database Migration Runner
 * Runs schema.sql and all migration files in order.
 * Usage: npm run db:migrate
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'spykar_inventory',
  user: process.env.PG_USER || 'spykar_app',
  password: process.env.PG_PASSWORD,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function runFile(client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  console.log(`  Running: ${path.basename(filePath)}`);
  await client.query(sql);
  console.log(`  ✓ Done: ${path.basename(filePath)}`);
}

async function migrate() {
  const client = await pool.connect();
  console.log('🗄️  Connected to PostgreSQL');

  try {
    await client.query('BEGIN');

    // 1. Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id        SERIAL PRIMARY KEY,
        filename  VARCHAR(255) UNIQUE NOT NULL,
        ran_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 2. Run base schema if not yet applied
    const schemaPath = path.join(__dirname, 'schema.sql');
    const { rows: schemaRan } = await client.query(
      `SELECT 1 FROM _migrations WHERE filename = 'schema.sql'`
    );
    if (!schemaRan.length) {
      await runFile(client, schemaPath);
      await client.query(`INSERT INTO _migrations (filename) VALUES ('schema.sql')`);
    } else {
      console.log('  ⏭  Skipping schema.sql (already applied)');
    }

    // 3. Run migration files in alphabetical order
    const migrationsDir = path.join(__dirname, 'migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const { rows } = await client.query(
          `SELECT 1 FROM _migrations WHERE filename = $1`, [file]
        );
        if (!rows.length) {
          await runFile(client, path.join(migrationsDir, file));
          await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
        } else {
          console.log(`  ⏭  Skipping ${file} (already applied)`);
        }
      }
    }

    await client.query('COMMIT');
    console.log('\n✅ All migrations completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run directly when invoked as a script
if (require.main === module) {
  migrate().catch(() => process.exit(1));
}

module.exports = { migrate };
