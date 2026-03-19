const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { runMigrations } = require('../../bootstrap/db');

class FakeClient {
  constructor(state) {
    this.state = state;
  }

  async query(sql, params = []) {
    const normalized = String(sql).trim();

    if (/^BEGIN/i.test(normalized) || /^COMMIT/i.test(normalized) || /^ROLLBACK/i.test(normalized)) {
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT INTO schema_migrations/i.test(normalized)) {
      this.state.applied.add(params[0]);
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  release() {}
}

class FakePool {
  constructor() {
    this.applied = new Set();
  }

  async query(sql, params = []) {
    const normalized = String(sql).trim();

    if (/SELECT 1 FROM schema_migrations/i.test(normalized)) {
      const exists = this.applied.has(params[0]);
      return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return new FakeClient(this);
  }
}

test('migration sql contains key module tables (invitations/tickets/moderation)', async () => {
  const sql = await fs.readFile(path.join(process.cwd(), 'migrations', '001_initial_schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS invite_joins/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tickets/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mod_cases/i);
});

test('runMigrations is idempotent for already applied files', async () => {
  const pool = new FakePool();
  const migrationsDir = path.join(process.cwd(), 'migrations');

  await runMigrations(pool, { migrationsDir });
  const appliedAfterFirst = pool.applied.size;
  await runMigrations(pool, { migrationsDir });

  assert.equal(pool.applied.size, appliedAfterFirst);
  assert.ok(pool.applied.has('001_initial_schema.sql'));
});
