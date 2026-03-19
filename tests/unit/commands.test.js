const test = require('node:test');
const assert = require('node:assert/strict');
const { SlashCommandBuilder } = require('discord.js');

const { buildCommandsPayload } = require('../../bootstrap/commands');

function serviceWith(...names) {
  return {
    commands: names.map((name) => new SlashCommandBuilder().setName(name).setDescription(`cmd ${name}`)),
  };
}

function makeServices(overrides = {}) {
  return {
    ping: serviceWith('ping'),
    startnewserver: serviceWith('startnewserver'),
    help: serviceWith('help'),
    vouches: serviceWith('vouch'),
    rankup: serviceWith('rankup'),
    modrank: serviceWith('modrank'),
    sendMessage: serviceWith('send-message'),
    tickets: serviceWith('ticket-panel'),
    giveaways: serviceWith('giveaway'),
    moderation: serviceWith('moderation'),
    automod: serviceWith('automod'),
    updates: serviceWith('updates'),
    absence: serviceWith('absence'),
    invitations: serviceWith('invite'),
    welcome: serviceWith('welcome'),
    serverstats: serviceWith('serverstats'),
    worl: serviceWith('worl'),
    ...overrides,
  };
}

test('buildCommandsPayload returns no duplicates for unique names', () => {
  const { commands, duplicates } = buildCommandsPayload(makeServices());
  assert.ok(commands.some((c) => c.name === 'ping'));
  assert.deepEqual(duplicates, []);
});

test('buildCommandsPayload detects duplicate command names', () => {
  const services = makeServices({
    help: serviceWith('shared'),
    vouches: serviceWith('shared'),
  });

  const { duplicates } = buildCommandsPayload(services);
  assert.deepEqual(duplicates, ['shared']);
});

test('buildCommandsPayload ignores missing services and missing commands arrays', () => {
  const { commands, duplicates } = buildCommandsPayload({
    ping: serviceWith('ping'),
    help: { commands: null },
    // autres services absents volontairement
  });

  assert.deepEqual(duplicates, []);
  assert.deepEqual(commands.map((c) => c.name), ['ping']);
});

test('buildCommandsPayload throws for invalid command payload', () => {
  assert.throws(
    () =>
      buildCommandsPayload({
        ping: {
          commands: [{ toJSON: () => ({}) }],
        },
      }),
    /Commande invalide/
  );
});
