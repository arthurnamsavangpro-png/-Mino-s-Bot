function createInteractionRouter(services) {
  const orderedServices = [
    services.help,
    services.tickets,
    services.sendMessage,
    services.giveaways,
    services.automod,
    services.updates,
    services.absence,
    services.invitations,
    services.welcome,
    services.serverstats,
    services.worl,
    services.moderation,
    services.vouches,
    services.rankup,
    services.modrank,
  ].filter(Boolean);

  const commandMap = new Map();
  for (const service of orderedServices) {
    for (const command of service.commands || []) {
      const json = typeof command.toJSON === 'function' ? command.toJSON() : command;
      if (!json?.name) continue;
      if (!commandMap.has(json.name)) commandMap.set(json.name, []);
      commandMap.get(json.name).push(service);
    }
  }

  async function dispatchInteraction(interaction, client) {
    if (interaction.isChatInputCommand()) {
      const scopedServices = commandMap.get(interaction.commandName) || [];

      for (const service of scopedServices) {
        if (await service.handleInteraction(interaction, client)) return true;
      }

      // Fallback sécurité (legacy path) pour éviter toute régression de routing.
      for (const service of orderedServices) {
        if (scopedServices.includes(service)) continue;
        if (await service.handleInteraction(interaction, client)) return true;
      }

      return false;
    }

    // Components/modals: certains services multiplexent via customId.
    for (const service of orderedServices) {
      if (await service.handleInteraction(interaction, client)) return true;
    }
    return false;
  }

  return { dispatchInteraction, commandMap };
}

module.exports = { createInteractionRouter };
