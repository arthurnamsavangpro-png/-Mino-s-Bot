// updates.js
const {
  SlashCommandBuilder,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redEmbed() {
  return new EmbedBuilder().setColor(0xff0000);
}

function isOwner(interaction, ownerId) {
  if (!ownerId) return false;
  return interaction.user?.id === ownerId;
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS updates_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function setGuildUpdatesChannel(pool, guildId, channelId) {
  await pool.query(
    `
    INSERT INTO updates_settings (guild_id, channel_id, enabled, updated_at)
    VALUES ($1, $2, TRUE, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET channel_id = EXCLUDED.channel_id, enabled = TRUE, updated_at = NOW();
  `,
    [guildId, channelId]
  );
}

async function disableGuildUpdates(pool, guildId) {
  await pool.query(
    `
    INSERT INTO updates_settings (guild_id, channel_id, enabled, updated_at)
    VALUES ($1, NULL, FALSE, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET enabled = FALSE, updated_at = NOW();
  `,
    [guildId]
  );
}

async function getGuildUpdates(pool, guildId) {
  const { rows } = await pool.query(
    `SELECT guild_id, channel_id, enabled, updated_at FROM updates_settings WHERE guild_id = $1`,
    [guildId]
  );
  return rows[0] || null;
}

async function getAllEnabledGuilds(pool) {
  const { rows } = await pool.query(
    `SELECT guild_id, channel_id FROM updates_settings WHERE enabled = TRUE AND channel_id IS NOT NULL`
  );
  return rows;
}

function canBotSend(channel) {
  const perms = channel.permissionsFor(channel.client.user?.id);
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ViewChannel) &&
    perms.has(PermissionsBitField.Flags.SendMessages)
  );
}

/* ------------------ Modal helpers ------------------ */
const MODAL_ID = "updates:broadcastembed";
const FIELD_TITLE = "title";
const FIELD_DESC = "description";
const FIELD_FOOTER = "footer";
const FIELD_IMAGE = "image";
const FIELD_PING = "ping_everyone";

function buildBroadcastEmbedModal() {
  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle("Broadcast Embed - Mises à jour");

  const title = new TextInputBuilder()
    .setCustomId(FIELD_TITLE)
    .setLabel("Titre")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(256)
    .setRequired(true);

  const desc = new TextInputBuilder()
    .setCustomId(FIELD_DESC)
    .setLabel("Description")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(3800)
    .setRequired(true);

  const footer = new TextInputBuilder()
    .setCustomId(FIELD_FOOTER)
    .setLabel("Footer (optionnel)")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(2048)
    .setRequired(false);

  const image = new TextInputBuilder()
    .setCustomId(FIELD_IMAGE)
    .setLabel("Image URL (optionnel)")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(500)
    .setRequired(false);

  const ping = new TextInputBuilder()
    .setCustomId(FIELD_PING)
    .setLabel("Ping @everyone ? (oui/non)")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(10)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(desc),
    new ActionRowBuilder().addComponents(footer),
    new ActionRowBuilder().addComponents(image),
    new ActionRowBuilder().addComponents(ping)
  );

  return modal;
}

function parseYesNoToBool(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return v === "oui" || v === "yes" || v === "y" || v === "true" || v === "1";
}

function looksLikeUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function createUpdatesService({ pool, config }) {
  const OWNER_ID = config.OWNER_ID || null;

  const commands = [
    new SlashCommandBuilder()
      .setName("updateschannel")
      .setDescription("Configurer le salon des annonces (updates) du bot")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Définir le salon où le bot enverra les annonces de mise à jour")
          .addChannelOption((opt) =>
            opt
              .setName("salon")
              .setDescription("Le salon d'annonces (texte)")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("disable").setDescription("Désactiver les annonces de mise à jour sur ce serveur")
      )
      .addSubcommand((sub) =>
        sub.setName("info").setDescription("Voir la configuration des annonces de mise à jour")
      ),

    new SlashCommandBuilder()
      .setName("broadcast")
      .setDescription("OWNER: Envoyer un message d'update sur tous les serveurs configurés")
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription("Contenu du message (texte)")
          .setRequired(true)
          .setMaxLength(1800)
      )
      .addBooleanOption((opt) =>
        opt
          .setName("ping_everyone")
          .setDescription("Ping @everyone (si autorisé sur le serveur)")
          .setRequired(false)
      ),

    // ✅ Modal version: plus d'options ici → ça ouvre la fenêtre
    new SlashCommandBuilder()
      .setName("broadcastembed")
      .setDescription("OWNER: Ouvre une fenêtre pour créer un embed et l'envoyer partout"),
  ];

  async function doBroadcastEmbed({ client, title, description, footer, image, pingEveryone }) {
    const rows = await getAllEnabledGuilds(pool);

    let ok = 0;
    let skipped = 0;
    let failed = 0;

    const emb = redEmbed().setTitle(title).setDescription(description).setTimestamp();
    if (footer) emb.setFooter({ text: footer });
    if (image) emb.setImage(image);

    for (const r of rows) {
      const guild = client.guilds.cache.get(r.guild_id);
      if (!guild) {
        failed++;
        continue;
      }

      let channel = null;
      try {
        channel = await guild.channels.fetch(r.channel_id).catch(() => null);
      } catch {
        channel = null;
      }

      if (!channel || !channel.isTextBased()) {
        failed++;
        continue;
      }

      if (!canBotSend(channel)) {
        skipped++;
        continue;
      }

      try {
        await channel.send({
          content: pingEveryone ? "@everyone" : null,
          embeds: [emb],
          allowedMentions: pingEveryone ? { parse: ["everyone"] } : { parse: [] },
        });
        ok++;
      } catch {
        failed++;
      }

      // Anti rate-limit
      await sleep(900);
    }

    return { ok, skipped, failed, total: rows.length };
  }

  async function handleInteraction(interaction, client) {
    try {
      // Assure la table
      await ensureTable(pool);

      /* ---------- Modal submit ---------- */
      if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
        if (!isOwner(interaction, OWNER_ID)) {
          await interaction.reply({
            content: "❌ Commande réservée à l’owner du bot.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        const title = interaction.fields.getTextInputValue(FIELD_TITLE);
        const description = interaction.fields.getTextInputValue(FIELD_DESC);
        const footerRaw = interaction.fields.getTextInputValue(FIELD_FOOTER) || "";
        const imageRaw = interaction.fields.getTextInputValue(FIELD_IMAGE) || "";
        const pingRaw = interaction.fields.getTextInputValue(FIELD_PING) || "";

        const footer = footerRaw.trim() ? footerRaw.trim() : null;
        const pingEveryone = parseYesNoToBool(pingRaw);

        let image = null;
        if (imageRaw.trim()) {
          if (!looksLikeUrl(imageRaw.trim())) {
            await interaction.reply({
              embeds: [
                redEmbed()
                  .setTitle("❌ Image URL invalide")
                  .setDescription("Mets une URL qui commence par `http://` ou `https://` (ou laisse vide)."),
              ],
              flags: MessageFlags.Ephemeral,
            });
            return true;
          }
          image = imageRaw.trim();
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const res = await doBroadcastEmbed({
          client,
          title,
          description,
          footer,
          image,
          pingEveryone,
        });

        await interaction.editReply({
          embeds: [
            redEmbed()
              .setTitle("📣 Broadcast embed terminé")
              .setDescription(
                [
                  `✅ Envoyés : **${res.ok}**`,
                  `⚠️ Skippés (pas de perms / pas d'accès) : **${res.skipped}**`,
                  `❌ Échecs : **${res.failed}**`,
                  "",
                  `Serveurs configurés (enabled + salon) : **${res.total}**`,
                ].join("\n")
              ),
          ],
        });

        return true;
      }

      /* ---------- Slash commands ---------- */
      if (!interaction.isChatInputCommand()) return false;

      if (interaction.commandName === "updateschannel") {
        if (
          !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) &&
          !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
        ) {
          await interaction.reply({
            content: "❌ Tu n'as pas la permission **Gérer le serveur** pour configurer ça.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (sub === "set") {
          const channel = interaction.options.getChannel("salon", true);

          if (!channel || !channel.isTextBased()) {
            await interaction.reply({
              content: "❌ Salon invalide (choisis un salon texte).",
              flags: MessageFlags.Ephemeral,
            });
            return true;
          }

          if (!canBotSend(channel)) {
            await interaction.reply({
              content:
                "❌ Je n’ai pas les permissions pour écrire dans ce salon (ViewChannel + SendMessages).",
              flags: MessageFlags.Ephemeral,
            });
            return true;
          }

          await setGuildUpdatesChannel(pool, guildId, channel.id);

          await interaction.reply({
            embeds: [
              redEmbed()
                .setTitle("✅ Salon updates configuré")
                .setDescription(`Les annonces seront envoyées dans ${channel}.`)
                .setFooter({ text: "Tu peux désactiver via /updateschannel disable" }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        if (sub === "disable") {
          await disableGuildUpdates(pool, guildId);
          await interaction.reply({
            embeds: [
              redEmbed()
                .setTitle("✅ Updates désactivées")
                .setDescription("Ce serveur ne recevra plus les annonces de mises à jour."),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        if (sub === "info") {
          const row = await getGuildUpdates(pool, guildId);
          const desc = row
            ? [
                `**Activé :** ${row.enabled ? "✅ Oui" : "❌ Non"}`,
                `**Salon :** ${row.channel_id ? `<#${row.channel_id}>` : "Non défini"}`,
              ].join("\n")
            : "Aucune config trouvée. Utilise `/updateschannel set`.";

          await interaction.reply({
            embeds: [redEmbed().setTitle("ℹ️ Config updates").setDescription(desc)],
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        return true;
      }

      if (interaction.commandName === "broadcast") {
        if (!isOwner(interaction, OWNER_ID)) {
          await interaction.reply({
            content: "❌ Commande réservée à l’owner du bot.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const pingEveryone = interaction.options.getBoolean("ping_everyone") || false;
        const message = interaction.options.getString("message", true);

        const rows = await getAllEnabledGuilds(pool);

        let ok = 0;
        let skipped = 0;
        let failed = 0;

        for (const r of rows) {
          const guild = client.guilds.cache.get(r.guild_id);
          if (!guild) {
            failed++;
            continue;
          }

          let channel = null;
          try {
            channel = await guild.channels.fetch(r.channel_id).catch(() => null);
          } catch {
            channel = null;
          }

          if (!channel || !channel.isTextBased()) {
            failed++;
            continue;
          }

          if (!canBotSend(channel)) {
            skipped++;
            continue;
          }

          try {
            await channel.send({
              content: pingEveryone ? `@everyone\n${message}` : message,
              allowedMentions: pingEveryone ? { parse: ["everyone"] } : { parse: [] },
            });
            ok++;
          } catch {
            failed++;
          }

          await sleep(900);
        }

        await interaction.editReply({
          embeds: [
            redEmbed()
              .setTitle("📣 Broadcast terminé")
              .setDescription(
                [
                  `✅ Envoyés : **${ok}**`,
                  `⚠️ Skippés (pas de perms / pas d'accès) : **${skipped}**`,
                  `❌ Échecs : **${failed}**`,
                  "",
                  `Serveurs configurés (enabled + salon) : **${rows.length}**`,
                ].join("\n")
              ),
          ],
        });

        return true;
      }

      // ✅ Ouvre le modal
      if (interaction.commandName === "broadcastembed") {
        if (!isOwner(interaction, OWNER_ID)) {
          await interaction.reply({
            content: "❌ Commande réservée à l’owner du bot.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        const modal = buildBroadcastEmbedModal();
        await interaction.showModal(modal);
        return true;
      }

      return false;
    } catch (e) {
      console.error("updates.handleInteraction error:", e);

      if (interaction?.isRepliable?.()) {
        const msg = "⚠️ Erreur interne (voir logs).";
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
        } else if (interaction.deferred && !interaction.replied) {
          await interaction.editReply(msg).catch(() => {});
        }
      }
      return true;
    }
  }

  return { commands, handleInteraction };
}

module.exports = { createUpdatesService };
