const test = require('node:test');
const assert = require('node:assert/strict');

const { registerClientEvents } = require('../../bootstrap/events');

function makeClient() {
  const handlers = new Map();
  return {
    on(event, fn) {
      handlers.set(event, fn);
    },
    handlers,
  };
}

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(payload) {
      entries.push({ level: 'info', payload });
    },
    warn(payload) {
      entries.push({ level: 'warn', payload });
    },
    error(payload) {
      entries.push({ level: 'error', payload });
    },
    nextRequestId() {
      return 'req-test';
    },
  };
}

test('registerClientEvents does not crash when optional services are missing', async () => {
  const client = makeClient();
  const logger = makeLogger();

  registerClientEvents({
    client,
    services: {
      ping: { commands: [] },
      help: { commands: [] },
    },
    logger,
  });

  const messageHandler = client.handlers.get('messageCreate');
  assert.equal(typeof messageHandler, 'function');

  await messageHandler({ content: 'hello' });

  const fatal = logger.entries.find(
    (entry) => entry.level === 'error' && entry.payload.event === 'messageCreate_fatal'
  );
  assert.equal(fatal, undefined);
});

test('registerClientEvents executes message handlers in order and stops on first handled', async () => {
  const client = makeClient();
  const logger = makeLogger();
  const calls = [];

  const services = {
    ping: { commands: [] },
    help: { commands: [] },
    tickets: {
      commands: [],
      async handleMessage() {
        calls.push('tickets');
        return true;
      },
    },
    moderation: {
      commands: [],
      async handleMessage() {
        calls.push('moderation');
        return false;
      },
    },
    automod: {
      commands: [],
      async handleMessage() {
        calls.push('automod');
        return false;
      },
    },
  };

  registerClientEvents({ client, services, logger });
  const messageHandler = client.handlers.get('messageCreate');

  await messageHandler({ content: 'x' });

  assert.deepEqual(calls, ['automod', 'tickets']);
});
