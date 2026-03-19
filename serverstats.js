const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

function createServerStatsService({ pool }) {
  const TABLE = "server_stats_settings";

  const PANEL_SELECT_ID = "serverstats:panel:metrics";
  const PANEL_ROLE_ID = "serverstats:panel:role";
  const PANEL_APPLY_ID = "serverstats:panel:apply";
  const PANEL_CANCEL_ID = "serverstats:panel:cancel";

  const panelStates = new Map();
  const presenceRefreshCooldown = new Map();

  const AVAILABLE_METRICS = {
    members: {
      key: "members",
      label: "Members",
      emoji: "👤",
      getLabel: (counts) => `👤 | Members: ${counts.members}`,
    },
    bots: {
      key: "bots",
      label: "Bots",
      emoji: "🤖",
      getLabel: (counts) => `🤖 | Bots: ${counts.bots}`,
    },
    online: {
      key: "online",
      label: "Members online",
      emoji: "🟢",
      getLabel: (counts) => `🟢 | Online: ${counts.online}`,
    },
    role: {
      key: "role",
      label: "Members with a role",
      emoji: "🎭",
      getLabel: (counts, roleId, guild) => {
        const role = roleId ? guild.roles.cache.get(roleId) : null;
        const roleName = role?.name || "Role";
        return `🎭 | ${roleName}: ${counts.roleMembers}`;
      },
    },
  };

  const commands = [
    new SlashCommandBuilder()
      .setName("serverstats")
      .setDescription("Configurer des salons vocaux de statistiques")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName("setup")
          .setDescription("Ouvrir le panel de configuration des stats vocales")
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
        metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
        channels JSONB NOT NULL DEFAULT '{}'::jsonb,
        tracked_role_id TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS channels JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS tracked_role_id TEXT`);
  }

  function normalizeSettings(row) {
    if (!row) return null;
    const metrics = Array.isArray(row.metrics) ? row.metrics : [];
    const channels = row.channels && typeof row.channels === "object" ? row.channels : {};

    // Compat anciennes versions.
    if (!channels.members && row.members_channel_id) {
      channels.members = row.members_channel_id;
    }
    if (!channels.bots && row.bots_channel_id) {
      channels.bots = row.bots_channel_id;
    }

    const normalizedMetrics = metrics.length
      ? metrics
      : [
          ...(channels.members ? ["members"] : []),
          ...(channels.bots ? ["bots"] : []),
        ];

    return {
      ...row,
      metrics: normalizedMetrics,
      channels,
    };
  }

  async function getSettings(guildId) {
    const { rows } = await pool.query(
      `SELECT guild_id, category_id, members_channel_id, bots_channel_id, metrics, channels, tracked_role_id, enabled
       FROM ${TABLE}
       WHERE guild_id = $1`,
      [guildId]
    );
    return normalizeSettings(rows[0] || null);
  }

  async function saveSettings(guildId, data) {
    const channels = data.channels || {};
    const metrics = Array.isArray(data.metrics) ? data.metrics : [];

    await pool.query(
      `INSERT INTO ${TABLE} (
         guild_id,
         category_id,
         members_channel_id,
         bots_channel_id,
         metrics,
         channels,
         tracked_role_id,
         enabled,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, NOW())
       ON CONFLICT (guild_id)
       DO UPDATE SET
         category_id = EXCLUDED.category_id,
         members_channel_id = EXCLUDED.members_channel_id,
         bots_channel_id = EXCLUDED.bots_channel_id,
         metrics = EXCLUDED.metrics,
         channels = EXCLUDED.channels,
         tracked_role_id = EXCLUDED.tracked_role_id,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()`,
      [
        guildId,
        data.category_id,
        channels.members || null,
        channels.bots || null,
        JSON.stringify(metrics),
        JSON.stringify(channels),
        data.tracked_role_id || null,
        data.enabled,
      ]
    );
  }

  async function countMembers(guild, trackedRoleId = null) {
    await guild.members.fetch();
    const members = guild.members.cache;
    const bots = members.filter((m) => m.user?.bot).size;
    const online = members.filter(
      (m) => !m.user?.bot && m.presence && m.presence.status !== "offline"
    ).size;
    const roleMembers = trackedRoleId
      ? members.filter((m) => !m.user?.bot && m.roles.cache.has(trackedRoleId)).size
      : 0;

    return {
      members: guild.memberCount,
      bots,
      online,
      roleMembers,
    };
  }

  async function ensureMetricChannel(guild, categoryId, metricKey, currentChannelId) {
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

    let channel = currentChannelId ? guild.channels.cache.get(currentChannelId) : null;
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      channel = await guild.channels.create({
        name: `${AVAILABLE_METRICS[metricKey].emoji} | ${AVAILABLE_METRICS[metricKey].label}: 0`,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: basePerms,
      });
    } else if (channel.parentId !== category.id) {
      await channel.setParent(category.id).catch(() => {});
    }

    return channel;
  }

  async function ensureStatChannels(guild, settings, selectedMetrics) {
    const channels = settings?.channels || {};
    const out = { ...channels };

    for (const metric of selectedMetrics) {
      const channel = await ensureMetricChannel(guild, settings.category_id, metric, channels[metric]);
      out[metric] = channel.id;
    }

    return out;
  }

  async function refreshGuildStats(guild) {
    const settings = await getSettings(guild.id);
    if (!settings || !settings.enabled) return false;

    const metrics = settings.metrics || [];
    if (!metrics.length) return false;

    const counts = await countMembers(guild, settings.tracked_role_id);

    for (const metric of metrics) {
      if (!AVAILABLE_METRICS[metric]) continue;
      const channelId = settings.channels?.[metric];
      if (!channelId) continue;

      const channel = guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;

      const wantedName = AVAILABLE_METRICS[metric].getLabel(counts, settings.tracked_role_id, guild);
      if (channel.name !== wantedName) {
        await channel.setName(wantedName).catch(() => {});
      }
    }
    return true;
  }

  async function handlePresenceUpdate(presence) {
    const guild = presence?.guild;
    if (!guild) return;

    const now = Date.now();
    const last = presenceRefreshCooldown.get(guild.id) || 0;
    if (now - last < 15_000) return;

    presenceRefreshCooldown.set(guild.id, now);
    await refreshGuildStats(guild).catch(() => {});
  }

  async function refreshAll(client) {
    const { rows } = await pool.query(`SELECT guild_id FROM ${TABLE} WHERE enabled = TRUE`);
    for (const row of rows) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) continue;
      await refreshGuildStats(guild).catch(() => {});
    }
  }

  let schedulerInterval = null;

  function startScheduler(client) {
    if (schedulerInterval) return schedulerInterval;
    schedulerInterval = setInterval(() => {
      refreshAll(client).catch(() => {});
    }, 120_000);
    return schedulerInterval;
  }

  function stopScheduler() {
    if (!schedulerInterval) return;
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  function buildSetupPanel() {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(PANEL_SELECT_ID)
      .setPlaceholder("Choisis les compteurs à afficher")
      .setMinValues(1)
      .setMaxValues(4)
      .addOptions([
        {
          label: "Members",
          value: "members",
          emoji: "👤",
          description: "Nombre total de membres",
          default: true,
        },
        {
          label: "Bots",
          value: "bots",
          emoji: "🤖",
          description: "Nombre de bots",
          default: true,
        },
        {
          label: "Members online",
          value: "online",
          emoji: "🟢",
          description: "Membres humains actuellement en ligne",
        },
        {
          label: "Members with a certain role",
          value: "role",
          emoji: "🎭",
          description: "Compteur des membres ayant un rôle choisi",
        },
      ]);

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(PANEL_ROLE_ID)
      .setPlaceholder("(Optionnel) Rôle à suivre pour l'option role")
      .setMinValues(0)
      .setMaxValues(1);

    const actions = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(PANEL_APPLY_ID).setLabel("Appliquer").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(PANEL_CANCEL_ID).setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );

    return {
      rows: [
        new ActionRowBuilder().addComponents(menu),
        new ActionRowBuilder().addComponents(roleSelect),
        actions,
      ],
      text:
        "### 📊 Server Stats Panel\n" +
        "Choisis les compteurs à créer, puis clique sur **Appliquer**.\n" +
        "- Si tu coches **Members with a certain role**, sélectionne aussi un rôle.",
    };
  }

  function parsePanelState(interaction) {
    const state = panelStates.get(interaction.message.id);
    if (!state) {
      return { selectedMetrics: ["members", "bots"], selectedRoleId: null };
    }
    return {
      selectedMetrics: Array.isArray(state.selectedMetrics) ? state.selectedMetrics : ["members", "bots"],
      selectedRoleId: state.selectedRoleId || null,
    };
  }

  function applyComponentState(message, metrics, roleId = null) {
    const panel = buildSetupPanel();
    const metricSet = new Set(metrics);

    panel.rows[0].components[0].setOptions(
      panel.rows[0].components[0].options.map((option) => ({
        label: option.data.label,
        value: option.data.value,
        emoji: option.data.emoji,
        description: option.data.description,
        default: metricSet.has(option.data.value),
      }))
    );

    panel.rows[1].components[0].setDefaultRoles(roleId ? [roleId] : []);

    return {
      content: message,
      components: panel.rows,
    };
  }

  async function handlePanelInteraction(interaction) {
    const isPanel =
      interaction.customId === PANEL_SELECT_ID ||
      interaction.customId === PANEL_ROLE_ID ||
      interaction.customId === PANEL_APPLY_ID ||
      interaction.customId === PANEL_CANCEL_ID;

    if (!isPanel) return false;

    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "❌ Tu dois avoir la permission **Gérer le serveur**.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const current = parsePanelState(interaction);

    if (interaction.customId === PANEL_SELECT_ID) {
      const metrics = interaction.values;
      const roleId = current.selectedRoleId;
      panelStates.set(interaction.message.id, { selectedMetrics: metrics, selectedRoleId: roleId });
      await interaction.update(
        applyComponentState(
          "✅ Sélection mise à jour. Clique sur **Appliquer** quand c'est prêt.",
          metrics,
          roleId
        )
      );
      return true;
    }

    if (interaction.customId === PANEL_ROLE_ID) {
      const roleId = interaction.values[0] || null;
      panelStates.set(interaction.message.id, { selectedMetrics: current.selectedMetrics, selectedRoleId: roleId });
      await interaction.update(
        applyComponentState(
          "✅ Rôle mis à jour. Clique sur **Appliquer** pour générer/mettre à jour les salons.",
          current.selectedMetrics,
          roleId
        )
      );
      return true;
    }

    if (interaction.customId === PANEL_CANCEL_ID) {
      panelStates.delete(interaction.message.id);
      await interaction.update({
        content: "❎ Configuration annulée.",
        components: [],
      });
      return true;
    }

    if (interaction.customId === PANEL_APPLY_ID) {
      const guild = interaction.guild;
      const selectedMetrics = current.selectedMetrics;
      const selectedRoleId = current.selectedRoleId;

      if (!selectedMetrics.length) {
        await interaction.reply({
          content: "⚠️ Sélectionne au moins un compteur.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (selectedMetrics.includes("role") && !selectedRoleId) {
        await interaction.reply({
          content: "⚠️ Tu dois sélectionner un rôle si tu actives **Members with a certain role**.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await ensureTable();

      let settings = await getSettings(guild.id);
      let categoryId = settings?.category_id;

      const existingCategory = categoryId ? guild.channels.cache.get(categoryId) : null;
      if (!existingCategory || existingCategory.type !== ChannelType.GuildCategory) {
        const category = await guild.channels.create({
          name: "📊 SERVER STATS",
          type: ChannelType.GuildCategory,
        });
        categoryId = category.id;
      }

      settings = {
        ...(settings || {}),
        category_id: categoryId,
        channels: settings?.channels || {},
      };

      const channels = await ensureStatChannels(guild, settings, selectedMetrics);

      await saveSettings(guild.id, {
        category_id: categoryId,
        metrics: selectedMetrics,
        channels,
        tracked_role_id: selectedMetrics.includes("role") ? selectedRoleId : null,
        enabled: true,
      });

      await refreshGuildStats(guild);

      const mentions = selectedMetrics
        .map((metric) => channels[metric])
        .filter(Boolean)
        .map((id) => `<#${id}>`)
        .join("\n");

      panelStates.delete(interaction.message.id);
      await interaction.update({
        content: `✅ Configuration appliquée.\n${mentions || "(Aucun salon créé)"}`,
        components: [],
      });
      return true;
    }

    return false;
  }

  async function handleInteraction(interaction, client) {
    if (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isButton()) {
      return handlePanelInteraction(interaction);
    }

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
      const panel = buildSetupPanel();
      await interaction.reply({
        content: panel.text,
        components: panel.rows,
        flags: MessageFlags.Ephemeral,
      });

      const msg = await interaction.fetchReply();
      panelStates.set(msg.id, { selectedMetrics: ["members", "bots"], selectedRoleId: null });
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
    handlePresenceUpdate,
    startScheduler,
    stopScheduler,
    ensureTable,
  };
}

module.exports = { createServerStatsService };
