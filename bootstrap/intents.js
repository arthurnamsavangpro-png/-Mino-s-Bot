const { GatewayIntentBits } = require('discord.js');

function buildIntents(config) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ];

  if (config.ENABLE_GUILD_PRESENCES) intents.push(GatewayIntentBits.GuildPresences);
  if (config.ENABLE_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);

  return intents;
}

module.exports = { buildIntents };
