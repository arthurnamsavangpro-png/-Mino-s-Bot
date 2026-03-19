function createInteractionRouter(services) {
  const orderedEntries = [
    ['help', services.help],
    ['tickets', services.tickets],
    ['sendMessage', services.sendMessage],
    ['giveaways', services.giveaways],
    ['automod', services.automod],
    ['updates', services.updates],
    ['absence', services.absence],
    ['invitations', services.invitations],
    ['welcome', services.welcome],
    ['serverstats', services.serverstats],
    ['worl', services.worl],
    ['moderation', services.moderation],
    ['vouches', services.vouches],
    ['rankup', services.rankup],
    ['modrank', services.modrank],
  ].filter(([, service]) => Boolean(service));

  const commandMap = new Map();
  for (const [serviceName, service] of orderedEntries) {
    if (typeof service.handleInteraction !== 'function') continue;
    for (const command of service.commands || []) {
      const json = typeof command.toJSON === 'function' ? command.toJSON() : command;
      if (!json?.name) continue;
      if (!commandMap.has(json.name)) commandMap.set(json.name, []);
      commandMap.get(json.name).push({ serviceName, service });
    }
  }
  const duplicateCommands = [...commandMap.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([commandName, entries]) => ({ commandName, services: entries.map((entry) => entry.serviceName) }));

  async function dispatchInteraction(interaction, client) {
    if (interaction.isChatInputCommand()) {
      const scopedServices = commandMap.get(interaction.commandName) || [];

      // Routage explicite: si la commande est connue, on n'interroge que ses handlers.
      if (scopedServices.length) {
        for (const { service } of scopedServices) {
          if (typeof service.handleInteraction !== 'function') continue;
          if (await service.handleInteraction(interaction, client)) return true;
        }
        return false;
      }

      // Fallback uniquement pour commandes inconnues (compat/legacy).
      for (const [, service] of orderedEntries) {
        if (typeof service.handleInteraction !== 'function') continue;
        if (await service.handleInteraction(interaction, client)) return true;
      }
      return false;
    }

    // Components/modals: certains services multiplexent via customId.
    for (const [, service] of orderedEntries) {
      if (typeof service.handleInteraction !== 'function') continue;
      if (await service.handleInteraction(interaction, client)) return true;
    }
    return false;
  }

  return { dispatchInteraction, commandMap, duplicateCommands };
}

module.exports = { createInteractionRouter };
