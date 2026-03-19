const test = require('node:test');
const assert = require('node:assert/strict');

const { createTicketSettingsRepository } = require('../../tickets/repositories/settings-repository');

function createPoolMock(selectRow) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT category_id')) {
        return { rows: selectRow ? [selectRow] : [] };
      }
      return { rows: [] };
    },
  };
}

test('getSettings merges defaults and clamps numeric values', async () => {
  const pool = createPoolMock({
    category_id: '123',
    staff_role_ids: ['111111111111111111', 'bad-role'],
    max_open_per_user: 99,
    cooldown_seconds: -5,
  });

  const repo = createTicketSettingsRepository({
    pool,
    config: {
      TICKET_CATEGORY_ID: null,
      TICKET_STAFF_ROLE_ID: null,
      ADMIN_FEEDBACK_CHANNEL_ID: null,
      TICKET_TRANSCRIPT_CHANNEL_ID: null,
      TICKET_MAX_OPEN_PER_USER: 1,
      TICKET_COOLDOWN_SECONDS: 600,
      TICKET_CLAIM_EXCLUSIVE: false,
      TICKET_DELETE_ON_CLOSE: false,
    },
  });

  const settings = await repo.getSettings('guild-1');

  assert.equal(settings.category_id, '123');
  assert.equal(settings.max_open_per_user, 5);
  assert.equal(settings.cooldown_seconds, 0);
  assert.deepEqual(settings.staff_role_ids, ['111111111111111111']);
  assert.equal(settings.staff_role_id, '111111111111111111');
});

test('upsertSettings keeps first valid staff role as staff_role_id', async () => {
  const pool = createPoolMock(null);
  const repo = createTicketSettingsRepository({
    pool,
    config: {
      TICKET_CATEGORY_ID: null,
      TICKET_STAFF_ROLE_ID: null,
      ADMIN_FEEDBACK_CHANNEL_ID: null,
      TICKET_TRANSCRIPT_CHANNEL_ID: null,
      TICKET_MAX_OPEN_PER_USER: 1,
      TICKET_COOLDOWN_SECONDS: 600,
      TICKET_CLAIM_EXCLUSIVE: false,
      TICKET_DELETE_ON_CLOSE: false,
    },
  });

  const next = await repo.upsertSettings('guild-1', {
    staff_role_ids: ['222222222222222222', 'not-valid'],
  });

  assert.deepEqual(next.staff_role_ids, ['222222222222222222']);
  assert.equal(next.staff_role_id, '222222222222222222');

  const upsertCall = pool.calls.find((c) => c.sql.includes('INSERT INTO ticket_settings'));
  assert.ok(upsertCall);
  assert.equal(upsertCall.params[2], '222222222222222222');
  assert.deepEqual(upsertCall.params[3], ['222222222222222222']);
});

test('repository uses logger.warn when ensure columns fails', async () => {
  const warnings = [];
  const pool = {
    async query(sql) {
      if (sql.includes('ALTER TABLE ticket_settings')) throw new Error('db-down');
      if (sql.includes('SELECT category_id')) return { rows: [] };
      return { rows: [] };
    },
  };

  const repo = createTicketSettingsRepository({
    pool,
    logger: {
      warn(payload) {
        warnings.push(payload);
      },
    },
    config: {
      TICKET_CATEGORY_ID: null,
      TICKET_STAFF_ROLE_ID: null,
      ADMIN_FEEDBACK_CHANNEL_ID: null,
      TICKET_TRANSCRIPT_CHANNEL_ID: null,
      TICKET_MAX_OPEN_PER_USER: 1,
      TICKET_COOLDOWN_SECONDS: 600,
      TICKET_CLAIM_EXCLUSIVE: false,
      TICKET_DELETE_ON_CLOSE: false,
    },
  });

  const settings = await repo.getSettings('guild-1');
  assert.equal(settings.max_open_per_user, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'ensure_settings_columns_failed');
});
