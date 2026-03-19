const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../../bootstrap/config');

function baseEnv() {
  return {
    DISCORD_TOKEN: 'token',
    CLIENT_ID: 'client',
    DATABASE_URL: 'postgres://local',
  };
}

test('loadConfig rejects invalid numeric env values', () => {
  const env = {
    ...baseEnv(),
    VOUCHBOARD_REFRESH_MS: 'not-a-number',
  };

  assert.throws(() => loadConfig(env), /VOUCHBOARD_REFRESH_MS invalide/);
});

test('loadConfig accepts valid numeric env values', () => {
  const env = {
    ...baseEnv(),
    TICKET_MAX_OPEN_PER_USER: '3',
    TICKET_COOLDOWN_SECONDS: '120',
    GIVEAWAY_SWEEP_MS: '15000',
  };

  const config = loadConfig(env);
  assert.equal(config.TICKET_MAX_OPEN_PER_USER, 3);
  assert.equal(config.TICKET_COOLDOWN_SECONDS, 120);
  assert.equal(config.GIVEAWAY_SWEEP_MS, 15000);
});
