const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  MessageFlags,
  EmbedBuilder,
} = require("discord.js");

const DEFAULT_WELCOME_TEMPLATE =
  "👋 Bienvenue {user} sur **{server}** !\nTu es notre **{member_count}e** membre.\n📘 Lis le règlement, puis présente-toi pour démarrer.";

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      message_template TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getWelcomeSettings(pool, guildId) {
  const { rows } = await pool.query(
    `SELECT guild_id, channel_id, message_template, enabled, updated_at FROM welcome_settings WHERE guild_id = $1`,
    [guildId]
  );
  return rows[0] || null;
}

async function setWelcomeConfig(pool, guildId, channelId, messageTemplate) {
  await pool.query(
    `
    INSERT INTO welcome_settings (guild_id, channel_id, message_template, enabled, updated_at)
    VALUES ($1, $2, $3, TRUE, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET channel_id = EXCLUDED.channel_id,
                  message_template = EXCLUDED.message_template,
                  enabled = TRUE,
                  updated_at = NOW();
  `,
    [guildId, channelId, messageTemplate]
  );
}

async function disableWelcome(pool, guildId) {
  await pool.query(
    `
    INSERT INTO welcome_settings (guild_id, channel_id, message_template, enabled, updated_at)
    VALUES ($1, NULL, '', FALSE, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET enabled = FALSE,
                  channel_id = NULL,
                  updated_at = NOW();
  `,
    [guildId]
  );
}

function canManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
}

function canBotSend(channel) {
  const perms = channel.permissionsFor(channel.client.user?.id);
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ViewChannel) &&
    perms.has(PermissionsBitField.Flags.SendMessages)
  );
}

function formatWelcomeMessage(template, member) {
  const text = (template || DEFAULT_WELCOME_TEMPLATE).slice(0, 1900);
  return text
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.user.username)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{member_count}", String(member.guild.memberCount || member.guild.members.cache.size || 0));
}

function buildInfoEmbed(row) {
  const isEnabled = Boolean(row?.enabled && row?.channel_id);
  const template = row?.message_template || DEFAULT_WELCOME_TEMPLATE;

  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle("👋 Système de bienvenue")
    .setDescription(
      isEnabled
        ? "Le système de bienvenue est **actif**."
        : "Le système de bienvenue est **désactivé**."
    )
    .addFields(
      {
        name: "Salon",
        value: row?.channel_id ? `<#${row.channel_id}>` : "Non configuré",
        inline: true,
      },
      {
        name: "Template",
        value: `\`\`\`${template.slice(0, 900)}\`\`\``,
      },
      {
        name: "Variables disponibles",
        value: "`{user}` `@mention` • `{username}` • `{server}` • `{member_count}`",
      }
    );
}

function createWelcomeService({ pool }) {
  const commands = [
    new SlashCommandBuilder()
      .setName("welcome")
      .setDescription("Configurer le message de bienvenue automatique")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Activer la bienvenue et définir le salon + message")
          .addChannelOption((opt) =>
            opt
              .setName("salon")
              .setDescription("Salon texte où envoyer la bienvenue")
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName("message")
              .setDescription("Message de bienvenue (variables: {user}, {username}, {server}, {member_count})")
              .setRequired(false)
              .setMaxLength(1900)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("disable").setDescription("Désactiver le système de bienvenue")
      )
      .addSubcommand((sub) =>
        sub.setName("info").setDescription("Afficher la configuration actuelle")
      )
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Envoyer un message de test de bienvenue")
          .addUserOption((opt) =>
            opt
              .setName("membre")
              .setDescription("Membre à utiliser pour l'aperçu (optionnel)")
              .setRequired(false)
          )
      ),
  ];

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return false;
    if (interaction.commandName !== "welcome") return false;

    if (!interaction.guildId) {
      await interaction.reply({
        content: "Cette commande est disponible uniquement sur un serveur.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const sub = interaction.options.getSubcommand();

    if (sub !== "info" && !canManageGuild(interaction)) {
      await interaction.reply({
        content: "Tu dois avoir la permission **Gérer le serveur** pour cette action.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await ensureTable(pool);

    if (sub === "set") {
      const channel = interaction.options.getChannel("salon", true);
      const template = interaction.options.getString("message") || DEFAULT_WELCOME_TEMPLATE;

      if (!canBotSend(channel)) {
        await interaction.reply({
          content: "Je n'ai pas les permissions pour envoyer des messages dans ce salon.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await setWelcomeConfig(pool, interaction.guildId, channel.id, template);
      await interaction.reply({
        embeds: [buildInfoEmbed({ channel_id: channel.id, message_template: template, enabled: true })],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === "disable") {
      await disableWelcome(pool, interaction.guildId);
      await interaction.reply({
        content: "✅ Bienvenue désactivée.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === "info") {
      const row = await getWelcomeSettings(pool, interaction.guildId);
      await interaction.reply({
        embeds: [buildInfoEmbed(row)],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === "test") {
      const row = await getWelcomeSettings(pool, interaction.guildId);
      if (!row?.enabled || !row?.channel_id) {
        await interaction.reply({
          content: "Le système de bienvenue n'est pas actif. Utilise `/welcome set`.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const previewMember = interaction.options.getMember("membre") || interaction.member;
      const target = await interaction.guild.channels.fetch(row.channel_id).catch(() => null);

      if (!target || !canBotSend(target)) {
        await interaction.reply({
          content: "Le salon configuré est introuvable ou je n'ai plus les permissions.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await target.send({
        content: formatWelcomeMessage(row.message_template || DEFAULT_WELCOME_TEMPLATE, previewMember),
      });

      await interaction.reply({
        content: "✅ Message de test envoyé.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    return false;
  }

  async function handleGuildMemberAdd(member) {
    if (!member?.guild?.id || member.user?.bot) return;

    await ensureTable(pool);
    const row = await getWelcomeSettings(pool, member.guild.id);
    if (!row?.enabled || !row?.channel_id) return;

    const channel = await member.guild.channels.fetch(row.channel_id).catch(() => null);
    if (!channel || !canBotSend(channel)) return;

    await channel.send({
      content: formatWelcomeMessage(row.message_template || DEFAULT_WELCOME_TEMPLATE, member),
    });
  }

  return {
    commands,
    handleInteraction,
    handleGuildMemberAdd,
  };
}

module.exports = {
  createWelcomeService,
};
