const { MessageFlags } = require('discord.js');

function registerProcessSignals({ gracefulShutdown, logger }) {
  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT').catch((err) => {
      logger.error({ module: 'core', event: 'shutdown_fatal', signal: 'SIGINT', error: err?.message || err });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch((err) => {
      logger.error({ module: 'core', event: 'shutdown_fatal', signal: 'SIGTERM', error: err?.message || err });
      process.exit(1);
    });
  });
}

function registerClientEvents({ client, services, logger }) {
  const {
    help,
    tickets,
    sendMessage,
    giveaways,
    automod,
    updates,
    absence,
    invitations,
    welcome,
    serverstats,
    worl,
    moderation,
    vouches,
    rankup,
    modrank,
  } = services;

  client.on('interactionCreate', async (interaction) => {
    const isSlash = interaction.isChatInputCommand();
    const requestId = logger.nextRequestId();
    const startedAt = Date.now();
    const commandName = isSlash ? interaction.commandName : interaction.customId || interaction.type;
    const baseContext = {
      module: 'interactions',
      event: 'interaction',
      requestId,
      guildId: interaction.guildId || null,
      userId: interaction.user?.id || null,
      commandName,
    };

    logger.info({ ...baseContext, phase: 'start' });

    try {
      if (await help.handleInteraction(interaction, client)) return;
      if (await tickets.handleInteraction(interaction, client)) return;
      if (await sendMessage.handleInteraction(interaction)) return;
      if (await giveaways.handleInteraction(interaction, client)) return;
      if (await automod.handleInteraction(interaction, client)) return;
      if (await updates.handleInteraction(interaction, client)) return;
      if (await absence.handleInteraction(interaction, client)) return;
      if (await invitations.handleInteraction(interaction, client)) return;
      if (await welcome.handleInteraction(interaction, client)) return;
      if (await serverstats.handleInteraction(interaction, client)) return;
      if (await worl.handleInteraction(interaction, client)) return;
      if (await moderation.handleInteraction(interaction, client)) return;

      if (!isSlash) return;

      if (interaction.commandName === 'ping') {
        const sent = await interaction.reply({ content: 'pong ', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(`pong (latence: ${latency}ms)`);
        return;
      }

      if (await vouches.handleInteraction(interaction, client)) return;
      if (await rankup.handleInteraction(interaction)) return;
      if (await modrank.handleInteraction(interaction, client)) return;
    } catch (e) {
      logger.error({ ...baseContext, event: 'interaction_error', error: e?.message || e });
      if (interaction?.isRepliable?.()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction
            .reply({
              content: '⚠️ Erreur interne (voir logs).',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        } else if (interaction.deferred && !interaction.replied) {
          await interaction.editReply('⚠️ Erreur interne (voir logs).').catch(() => {});
        }
      }
    } finally {
      logger.info({ ...baseContext, phase: 'end', latencyMs: Date.now() - startedAt });
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      if (await automod.handleMessage(message, client)) return;
      if (await tickets.handleMessage?.(message, client)) return;
      if (await moderation.handleMessage?.(message, client)) return;
    } catch (e) {
      logger.error({ module: 'events', event: 'messageCreate_fatal', error: e?.message || e });
    }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      await automod.handleGuildMemberAdd(member, client);
      await moderation.handleGuildMemberAdd?.(member, client);
      await invitations.handleGuildMemberAdd(member, client);
      await welcome.handleGuildMemberAdd(member, client);
      await serverstats.refreshGuildStats(member.guild);
    } catch (e) {
      logger.error({ module: 'events', event: 'guildMemberAdd_fatal', guildId: member?.guild?.id, userId: member?.id, error: e?.message || e });
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      await moderation.handleGuildMemberUpdate?.(oldMember, newMember, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'guildMemberUpdate_fatal', guildId: newMember?.guild?.id, userId: newMember?.id, error: e?.message || e });
    }
  });

  client.on('presenceUpdate', async (oldPresence, newPresence) => {
    try {
      await moderation.handlePresenceUpdate?.(oldPresence, newPresence, client);
      await serverstats.handlePresenceUpdate?.(newPresence);
    } catch (e) {
      logger.error({ module: 'events', event: 'presenceUpdate_fatal', guildId: newPresence?.guild?.id, userId: newPresence?.userId, error: e?.message || e });
    }
  });

  client.on('userUpdate', async (oldUser, newUser) => {
    try {
      await moderation.handleUserUpdate?.(oldUser, newUser, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'userUpdate_fatal', userId: newUser?.id, error: e?.message || e });
    }
  });

  client.on('channelCreate', async (channel) => {
    try {
      await automod.handleChannelCreate(channel, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'channelCreate_fatal', guildId: channel?.guild?.id, error: e?.message || e });
    }
  });

  client.on('channelDelete', async (channel) => {
    try {
      await automod.handleChannelDelete(channel, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'channelDelete_fatal', guildId: channel?.guild?.id, error: e?.message || e });
    }
  });

  client.on('webhooksUpdate', async (channel) => {
    try {
      await automod.handleWebhooksUpdate(channel, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'webhooksUpdate_fatal', guildId: channel?.guild?.id, error: e?.message || e });
    }
  });

  client.on('guildMemberRemove', async (member) => {
    try {
      await invitations.handleGuildMemberRemove(member, client);
      await serverstats.refreshGuildStats(member.guild);
    } catch (e) {
      logger.error({ module: 'events', event: 'guildMemberRemove_fatal', guildId: member?.guild?.id, userId: member?.id, error: e?.message || e });
    }
  });

  client.on('inviteCreate', async (invite) => {
    try {
      await invitations.handleInviteCreate(invite, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'inviteCreate_fatal', guildId: invite?.guild?.id, error: e?.message || e });
    }
  });

  client.on('inviteDelete', async (invite) => {
    try {
      await invitations.handleInviteDelete(invite, client);
    } catch (e) {
      logger.error({ module: 'events', event: 'inviteDelete_fatal', guildId: invite?.guild?.id, error: e?.message || e });
    }
  });
}

module.exports = { registerProcessSignals, registerClientEvents };
