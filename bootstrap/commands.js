const { REST, Routes, SlashCommandBuilder } = require('discord.js');

function buildCommandsPayload(services) {
  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Répond pong + latence'),
    ...services.help.commands,
    ...services.vouches.commands,
    ...services.rankup.commands,
    ...services.modrank.commands,
    ...services.sendMessage.commands,
    ...services.tickets.commands,
    ...services.giveaways.commands,
    ...services.moderation.commands,
    ...services.automod.commands,
    ...services.updates.commands,
    ...services.absence.commands,
    ...services.invitations.commands,
    ...services.welcome.commands,
    ...services.serverstats.commands,
    ...services.worl.commands,
  ].map((c) => c.toJSON());

  const seen = new Set();
  const duplicates = new Set();
  for (const command of commands) {
    if (seen.has(command.name)) duplicates.add(command.name);
    seen.add(command.name);
  }

  return { commands, duplicates: [...duplicates].sort() };
}

async function registerCommands({ token, clientId, guildId, commandsScope, services, logger }) {
  const { commands, duplicates } = buildCommandsPayload(services);
  if (duplicates.length) {
    throw new Error(`Commandes slash dupliquées: ${duplicates.join(', ')}`);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  async function putGlobal() {
    const created = await rest.put(Routes.applicationCommands(clientId), { body: commands });
    const names = Array.isArray(created) ? created.map((c) => c.name) : [];
    logger.info({ module: 'commands', event: 'register_global', count: names.length, hasInvite: names.includes('invite') });
  }

  async function putGuild(targetGuildId) {
    const created = await rest.put(Routes.applicationGuildCommands(clientId, targetGuildId), { body: commands });
    const names = Array.isArray(created) ? created.map((c) => c.name) : [];
    logger.info({ module: 'commands', event: 'register_guild', guildId: targetGuildId, count: names.length, hasInvite: names.includes('invite') });
  }

  if (commandsScope === 'global') return putGlobal();
  if (commandsScope === 'guild') return putGuild(guildId);
  if (commandsScope === 'both') {
    await putGlobal();
    await putGuild(guildId);
    return;
  }

  logger.warn({ module: 'commands', event: 'invalid_scope', commandsScope, fallback: 'global' });
  return putGlobal();
}

module.exports = { registerCommands, buildCommandsPayload };
