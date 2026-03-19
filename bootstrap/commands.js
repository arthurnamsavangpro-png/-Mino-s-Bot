const { REST, Routes } = require('discord.js');

const SERVICE_COMMAND_ORDER = [
  'ping',
  'help',
  'vouches',
  'rankup',
  'modrank',
  'sendMessage',
  'tickets',
  'giveaways',
  'moderation',
  'automod',
  'updates',
  'absence',
  'invitations',
  'welcome',
  'serverstats',
  'worl',
];

function toCommandJson(command, serviceName, index) {
  const json = typeof command?.toJSON === 'function' ? command.toJSON() : command;
  if (!json || typeof json.name !== 'string' || !json.name.trim()) {
    throw new Error(
      `Commande invalide dans le service "${serviceName}" (index ${index}): nom manquant.`
    );
  }
  return json;
}

function buildCommandsPayload(services) {
  const safeServices = services || {};
  const commands = [];

  for (const serviceName of SERVICE_COMMAND_ORDER) {
    const service = safeServices[serviceName];
    const serviceCommands = Array.isArray(service?.commands) ? service.commands : [];
    for (const [index, command] of serviceCommands.entries()) {
      commands.push(toCommandJson(command, serviceName, index));
    }
  }

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
