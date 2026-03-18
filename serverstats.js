const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

function createServerStatsService({ pool }) {
  const TABLE = "server_stats_settings";

  const commands = [
    new SlashCommandBuilder()
      .setName("serverstats")
      .setDescription("Configurer des salons vocaux de statistiques")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName("setup")
          .setDescription("Créer la catégorie + salons vocaux de stats")
      )
      .addSubcommand((sub) =>
        sub
          .setName("refresh")
          .setDescription("Forcer la mise à jour des compteurs")
      )
      .addSubcommand((sub) =>
        sub
          .setName("disable")
          .setDescription("Désactiver les stats vocales (sans supprimer les salons)")
      ),
  ];

  async function ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        guild_id TEXT PRIMARY KEY,
        category_id TEXT,
        members_channel_id TEXT,
        bots_channel_id TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async function getSettings(guildId) {
    const { rows } = await pool.query(
      `SELECT guild_id, category_id, members_channel_id, bots_channel_id, enabled
       FROM ${TABLE}
       WHERE guild_id = $1`,
      [guildId]
    );
    return rows[0] || null;
  }

  async function saveSettings(guildId, data) {
    await pool.query(
      `INSERT INTO ${TABLE} (guild_id, category_id, members_channel_id, bots_channel_id, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (guild_id)
       DO UPDATE SET
         category_id = EXCLUDED.category_id,
         members_channel_id = EXCLUDED.members_channel_id,
         bots_channel_id = EXCLUDED.bots_channel_id,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()`,
      [guildId, data.category_id, data.members_channel_id, data.bots_channel_id, data.enabled]
    );
  }

  async function countMembers(guild) {
    await guild.members.fetch();
    const members = guild.members.cache;
    const bots = members.filter((m) => m.user?.bot).size;
    return {
      members: guild.memberCount,
      bots,
    };
  }

  async function ensureStatChannels(guild, categoryId, current = null) {
    const category = guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("Catégorie introuvable. Relance /serverstats setup.");
    }

    const basePerms = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      },
    ];

    let membersChannel = current?.members_channel_id
      ? guild.channels.cache.get(current.members_channel_id)
      : null;
    if (!membersChannel || membersChannel.type !== ChannelType.GuildVoice) {
      membersChannel = await guild.channels.create({
        name: "👤 | Members: 0",
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: basePerms,
      });
    } else if (membersChannel.parentId !== category.id) {
      await membersChannel.setParent(category.id).catch(() => {});
    }

    let botsChannel = current?.bots_channel_id
      ? guild.channels.cache.get(current.bots_channel_id)
      : null;
    if (!botsChannel || botsChannel.type !== ChannelType.GuildVoice) {
      botsChannel = await guild.channels.create({
        name: "🤖 | Bots: 0",
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: basePerms,
      });
    } else if (botsChannel.parentId !== category.id) {
      await botsChannel.setParent(category.id).catch(() => {});
    }

    return { membersChannel, botsChannel };
  }

  async function refreshGuildStats(guild) {
    const settings = await getSettings(guild.id);
    if (!settings || !settings.enabled) return false;

    const membersChannel = guild.channels.cache.get(settings.members_channel_id);
    const botsChannel = guild.channels.cache.get(settings.bots_channel_id);
    if (!membersChannel || !botsChannel) return false;

    const counts = await countMembers(guild);
    const memberName = `👤 | Members: ${counts.members}`;
    const botName = `🤖 | Bots: ${counts.bots}`;

    if (membersChannel.name !== memberName) {
      await membersChannel.setName(memberName).catch(() => {});
    }
    if (botsChannel.name !== botName) {
      await botsChannel.setName(botName).catch(() => {});
    }
    return true;
  }

  async function refreshAll(client) {
    const { rows } = await pool.query(`SELECT guild_id FROM ${TABLE} WHERE enabled = TRUE`);
    for (const row of rows) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) continue;
      await refreshGuildStats(guild).catch(() => {});
    }
  }

  function startScheduler(client) {
    setInterval(() => {
      refreshAll(client).catch(() => {});
    }, 120_000);
  }

  async function handleInteraction(interaction, client) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "serverstats") {
      return false;
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "❌ Cette commande doit être utilisée sur un serveur.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === "setup") {
      await ensureTable();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const category = await guild.channels.create({
        name: "📊 SERVER STATS",
        type: ChannelType.GuildCategory,
      });

      const current = await getSettings(guild.id);
      const channels = await ensureStatChannels(guild, category.id, current);

      await saveSettings(guild.id, {
        category_id: category.id,
        members_channel_id: channels.membersChannel.id,
        bots_channel_id: channels.botsChannel.id,
        enabled: true,
      });

      await refreshGuildStats(guild);

      await interaction.editReply(
        `✅ Stats vocales activées dans **${category.name}**.\n` +
          `• ${channels.membersChannel}\n` +
          `• ${channels.botsChannel}`
      );
      return true;
    }

    if (sub === "refresh") {
      await ensureTable();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const ok = await refreshGuildStats(guild);
      await interaction.editReply(
        ok
          ? "✅ Compteurs vocaux mis à jour."
          : "⚠️ Aucune configuration active. Utilise `/serverstats setup` d'abord."
      );
      return true;
    }

    if (sub === "disable") {
      await ensureTable();
      const current = await getSettings(guild.id);
      if (!current) {
        await interaction.reply({
          content: "⚠️ Aucune configuration trouvée.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await saveSettings(guild.id, {
        ...current,
        enabled: false,
      });
      await interaction.reply({
        content: "✅ Stats vocales désactivées. Les salons existants sont conservés.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    return false;
  }

  return {
    commands,
    handleInteraction,
    refreshGuildStats,
    startScheduler,
    ensureTable,
  };
}

module.exports = { createServerStatsService };
