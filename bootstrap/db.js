const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

function createDbPool(config) {
  return new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

async function runMigrations(pool, { migrationsDir = path.join(process.cwd(), 'migrations') } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    const exists = await pool.query(`SELECT 1 FROM schema_migrations WHERE filename=$1 LIMIT 1`, [filename]);
    if (exists.rowCount) continue;

    const fullPath = path.join(migrationsDir, filename);
    const sql = await fs.readFile(fullPath, 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [filename]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { createDbPool, runMigrations };
