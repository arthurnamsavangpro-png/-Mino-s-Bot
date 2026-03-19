const test = require('node:test');
const assert = require('node:assert/strict');

const { createInteractionRouter } = require('../../bootstrap/interaction-router');

function mkService(commandNames = [], result = false, marker = []) {
  return {
    commands: commandNames.map((name) => ({ toJSON: () => ({ name }) })),
    async handleInteraction(interaction) {
      marker.push(interaction.commandName || interaction.customId || 'unknown');
      return result;
    },
  };
}

function makeServices(marker, overrides = {}) {
  return {
    help: mkService(['help'], false, marker),
    tickets: mkService(['ticket-panel'], false, marker),
    sendMessage: mkService(['send-message'], false, marker),
    giveaways: mkService(['giveaway'], false, marker),
    automod: mkService(['automod'], false, marker),
    updates: mkService(['updates'], false, marker),
    absence: mkService(['absence'], false, marker),
    invitations: mkService(['invite'], false, marker),
    welcome: mkService(['welcome'], false, marker),
    serverstats: mkService(['serverstats'], false, marker),
    worl: mkService(['worl'], false, marker),
    moderation: mkService(['moderation'], false, marker),
    vouches: mkService(['vouch'], false, marker),
    rankup: mkService(['rankup'], false, marker),
    modrank: mkService(['modrank'], false, marker),
    ...overrides,
  };
}

test('dispatchInteraction routes slash command to scoped service first', async () => {
  const marker = [];
  const ticketService = mkService(['ticket-panel'], true, marker);
  const services = makeServices(marker, { tickets: ticketService });
  const router = createInteractionRouter(services);

  const interaction = { isChatInputCommand: () => true, commandName: 'ticket-panel' };
  const handled = await router.dispatchInteraction(interaction, {});

  assert.equal(handled, true);
  assert.deepEqual(marker, ['ticket-panel']);
});

test('dispatchInteraction runs fallback chain when scoped handler does not handle', async () => {
  const marker = [];
  const services = makeServices(marker);
  const router = createInteractionRouter(services);

  const interaction = { isChatInputCommand: () => true, commandName: 'unknown-cmd' };
  const handled = await router.dispatchInteraction(interaction, {});

  assert.equal(handled, false);
  assert.equal(marker.length, 15);
});

test('dispatchInteraction supports non-slash interactions', async () => {
  const marker = [];
  const services = makeServices(marker, {
    automod: {
      commands: [{ toJSON: () => ({ name: 'automod' }) }],
      async handleInteraction(interaction) {
        marker.push(interaction.customId);
        return interaction.customId === 'automod:btn';
      },
    },
  });
  const router = createInteractionRouter(services);

  const interaction = { isChatInputCommand: () => false, customId: 'automod:btn' };
  const handled = await router.dispatchInteraction(interaction, {});

  assert.equal(handled, true);
  assert.ok(marker.includes('automod:btn'));
});
