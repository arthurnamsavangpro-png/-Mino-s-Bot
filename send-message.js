const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

function createSendMessageService({ config } = {}) {
  const sendCmd = new SlashCommandBuilder()
    .setName("send")
    .setDescription("MOD: Envoie un message texte via le bot")
    .addStringOption((opt) =>
      opt.setName("texte").setDescription("Texte à envoyer").setRequired(false).setMaxLength(2000)
    )
    .addChannelOption((opt) =>
      opt
        .setName("salon")
        .setDescription("Salon cible (sinon: salon actuel)")
        .setRequired(false)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("reply_to")
        .setDescription("Répondre à un message (ID ou lien)")
        .setRequired(false)
        .setMaxLength(200)
    )
    .addAttachmentOption((opt) =>
      opt.setName("file").setDescription("Pièce jointe (1 fichier)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("mentions")
        .setDescription("Autoriser mentions users/roles (par défaut: non)")
        .setRequired(false)
    );

  const sendEmbedCmd = new SlashCommandBuilder()
    .setName("sendembed")
    .setDescription("MOD: Ouvre un formulaire pour envoyer un embed (modal)")
    .addChannelOption((opt) =>
      opt
        .setName("salon")
        .setDescription("Salon cible (sinon: salon actuel)")
        .setRequired(false)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("reply_to")
        .setDescription("Répondre à un message (ID ou lien)")
        .setRequired(false)
        .setMaxLength(200)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("mentions")
        .setDescription("Autoriser mentions users/roles (par défaut: non)")
        .setRequired(false)
    );

  const dmAllCmd = new SlashCommandBuilder()
    .setName("dm-all")
    .setDescription("OWNER: Envoie un message privé à tous les membres des serveurs du bot")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Message à envoyer en DM à tous les membres")
        .setRequired(true)
        .setMaxLength(2000)
    );

  const commands = [sendCmd, sendEmbedCmd, dmAllCmd];

  // Pending dm-all confirmations: userId -> { message }
  const pendingDmAll = new Map();

  function isOwner(userId) {
    return Boolean(config?.OWNER_ID && userId === config.OWNER_ID);
  }

  function mustBeMod(interaction) {
    return (
      interaction.memberPermissions &&
      interaction.memberPermissions.has(PermissionsBitField.Flags.ManageMessages)
    );
  }

  function parseMessageLinkOrId(input) {
    if (!input) return null;
    const s = input.trim();
    if (/^\d{16,20}$/.test(s)) return { messageId: s, channelId: null };
    const m = s.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (m) return { channelId: m[2], messageId: m[3] };
    return null;
  }

  async function fetchAnyChannel(interaction, id) {
    if (!id || id === "0") return null;
    return await interaction.client.channels.fetch(id).catch(() => null);
  }

  function safeGetField(interaction, id) {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      return "";
    }
  }

  async function ensureBotCanSend(interaction, targetChannel) {
    const me = await interaction.guild.members.fetchMe().catch(() => null);
    if (!me) return false;

    const perms = targetChannel.permissionsFor(me);
    const needThreadPerm = targetChannel.isThread?.() === true;

    return Boolean(
      perms?.has(PermissionsBitField.Flags.ViewChannel) &&
        perms?.has(PermissionsBitField.Flags.SendMessages) &&
        (!needThreadPerm || perms?.has(PermissionsBitField.Flags.SendMessagesInThreads))
    );
  }

  async function resolveReply(targetChannel, replyMsgId) {
    if (!replyMsgId || replyMsgId === "0") return { reply: undefined };
    const msg = await targetChannel.messages.fetch(replyMsgId).catch(() => null);
    if (!msg)
      return { error: "⚠️ Message `reply_to` introuvable (mauvais ID/lien, ou pas accessible)." };
    return { reply: { messageReference: msg.id, failIfNotExists: false } };
  }

  async function handleInteraction(interaction) {
    try {
      /* ---------------- DM-ALL BUTTONS ---------------- */
      if (interaction.isButton()) {
        const { customId, user } = interaction;

        if (customId.startsWith("dmall_confirm|")) {
          const ownerId = customId.split("|")[1];
          if (user.id !== ownerId) {
            await interaction
              .reply({ content: "⛔ Ce bouton ne t'est pas destiné.", flags: MessageFlags.Ephemeral })
              .catch(() => {});
            return true;
          }

          const pending = pendingDmAll.get(user.id);
          if (!pending) {
            await interaction
              .update({ content: "⚠️ Session expirée. Relance la commande `/dm-all`.", embeds: [], components: [] })
              .catch(() => {});
            return true;
          }

          pendingDmAll.delete(user.id);

          await interaction
            .update({ content: "⏳ Récupération des membres en cours...", embeds: [], components: [] })
            .catch(() => {});

          const { message } = pending;
          const client = interaction.client;
          const sentUsers = new Set();
          let success = 0;
          let failed = 0;
          let skipped = 0;
          let lastProgressUpdate = Date.now();

          for (const guild of client.guilds.cache.values()) {
            let members;
            try {
              members = await guild.members.fetch();
            } catch {
              continue;
            }

            for (const member of members.values()) {
              if (member.user.bot) continue;
              if (sentUsers.has(member.user.id)) {
                skipped++;
                continue;
              }
              sentUsers.add(member.user.id);

              try {
                await member.user.send(message);
                success++;
              } catch {
                failed++;
              }

              if (Date.now() - lastProgressUpdate > 5_000) {
                lastProgressUpdate = Date.now();
                await interaction
                  .editReply({
                    content: `⏳ En cours... **${success + failed + skipped}** traités — ✅ ${success} envoyés · ❌ ${failed} échecs`,
                  })
                  .catch(() => {});
              }
            }
          }

          await interaction
            .editReply({
              content:
                `✅ **Envoi terminé !**\n` +
                `📨 Envoyés avec succès : **${success}**\n` +
                `❌ Échecs (DM fermés / bloqués) : **${failed}**\n` +
                `⏭️ Ignorés (déjà reçu) : **${skipped}**`,
            })
            .catch(() => {});
          return true;
        }

        if (customId.startsWith("dmall_cancel|")) {
          const ownerId = customId.split("|")[1];
          if (user.id !== ownerId) {
            await interaction
              .reply({ content: "⛔ Ce bouton ne t'est pas destiné.", flags: MessageFlags.Ephemeral })
              .catch(() => {});
            return true;
          }

          pendingDmAll.delete(user.id);
          await interaction
            .update({ content: "❌ Envoi annulé.", embeds: [], components: [] })
            .catch(() => {});
          return true;
        }

        return false;
      }

      /* ---------------- MODAL SUBMIT ---------------- */
      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith("sendembed|")) return false;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        if (!interaction.guild) {
          await interaction.editReply("⚠️ Serveur introuvable.").catch(() => {});
          return true;
        }
        if (!mustBeMod(interaction)) {
          await interaction.editReply("⛔ Il faut la permission **Gérer les messages**.").catch(() => {});
          return true;
        }

        // customId: sendembed|channelId|mentionsFlag|replyChannelId|replyMsgId
        const parts = interaction.customId.split("|");
        const channelId = parts[1] || "0";
        const mentionsFlag = parts[2] || "0";
        const replyChannelId = parts[3] || "0";
        const replyMsgId = parts[4] || "0";

        const allowMentions = mentionsFlag === "1";
        const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

        let targetChannel =
          (await fetchAnyChannel(interaction, channelId)) ||
          (await fetchAnyChannel(interaction, replyChannelId)) ||
          interaction.channel;

        if (
          !targetChannel ||
          !targetChannel.isTextBased?.() ||
          targetChannel.guildId !== interaction.guildId
        ) {
          await interaction
            .editReply("⚠️ Salon invalide (il doit être textuel et du même serveur).")
            .catch(() => {});
          return true;
        }

        if (channelId !== "0" && replyChannelId !== "0" && channelId !== replyChannelId) {
          await interaction
            .editReply(
              "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`."
            )
            .catch(() => {});
          return true;
        }

        const canSend = await ensureBotCanSend(interaction, targetChannel);
        if (!canSend) {
          await interaction
            .editReply("⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon.")
            .catch(() => {});
          return true;
        }

        // lecture SAFE
        const messageContent = (safeGetField(interaction, "msg_content") || "").trim().slice(0, 2000);
        const embedTitle = (safeGetField(interaction, "embed_title") || "").trim().slice(0, 256);

        // MODAL max = 4000, Embed desc max = 4096 (on reste safe)
        let embedDesc = (safeGetField(interaction, "embed_desc") || "").trim();
        embedDesc = embedDesc.slice(0, 4096);

        if (!embedDesc) {
          await interaction.editReply("⚠️ La description de l’embed est obligatoire.").catch(() => {});
          return true;
        }

        const eb = new EmbedBuilder().setColor(0xff0000).setDescription(embedDesc).setTimestamp();
        if (embedTitle) eb.setTitle(embedTitle);

        const replyRes = await resolveReply(targetChannel, replyMsgId);
        if (replyRes?.error) {
          await interaction.editReply(replyRes.error).catch(() => {});
          return true;
        }

        await targetChannel.send({
          content: messageContent || undefined,
          embeds: [eb],
          allowedMentions,
          reply: replyRes.reply,
        });

        await interaction.editReply(`✅ Embed envoyé dans ${targetChannel}.`).catch(() => {});
        return true;
      }

      /* ---------------- SLASH COMMANDS ---------------- */
      if (!interaction.isChatInputCommand()) return false;

      const isSend = interaction.commandName === "send";
      const isSendEmbed = interaction.commandName === "sendembed";
      const isDmAll = interaction.commandName === "dm-all";
      if (!isSend && !isSendEmbed && !isDmAll) return false;

      if (!interaction.guild) {
        await interaction.reply({
          content: "⚠️ Cette commande fonctionne uniquement dans un serveur.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      if (!mustBeMod(interaction)) {
        await interaction.reply({
          content: "⛔ Il faut la permission **Gérer les messages**.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      // /dm-all : confirmation avant envoi massif
      if (isDmAll) {
        if (!isOwner(interaction.user.id)) {
          await interaction.reply({
            content: "⛔ Cette commande est réservée au propriétaire du bot.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        const message = interaction.options.getString("message");
        const guildCount = interaction.client.guilds.cache.size;

        pendingDmAll.set(interaction.user.id, { message });
        setTimeout(() => pendingDmAll.delete(interaction.user.id), 60_000);

        const embed = new EmbedBuilder()
          .setColor(0xff6600)
          .setTitle("⚠️ Confirmation requise")
          .setDescription(
            `Tu es sur le point d'envoyer un DM à **tous les membres** de **${guildCount} serveur(s)**.\n\n**Message :**\n${message}`
          )
          .setFooter({ text: "Cette confirmation expire dans 60 secondes." });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`dmall_confirm|${interaction.user.id}`)
            .setLabel("Confirmer l'envoi")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`dmall_cancel|${interaction.user.id}`)
            .setLabel("Annuler")
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
          embeds: [embed],
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      // /sendembed : ouvre le modal immédiatement (aucun fetch)
      if (isSendEmbed) {
        const explicitChannel = interaction.options.getChannel("salon") || null;
        const allowMentions = interaction.options.getBoolean("mentions") ?? false;

        const replyRaw = interaction.options.getString("reply_to") || null;
        const parsed = parseMessageLinkOrId(replyRaw);

        const channelId = explicitChannel?.id || "0";
        const mentionsFlag = allowMentions ? "1" : "0";
        const replyChId = parsed?.channelId || "0";
        const replyMsgId = parsed?.messageId || "0";

        const modal = new ModalBuilder()
          .setCustomId(`sendembed|${channelId}|${mentionsFlag}|${replyChId}|${replyMsgId}`)
          .setTitle("Envoyer un message");

        const inputContent = new TextInputBuilder()
          .setCustomId("msg_content")
          .setLabel("Contenu du message")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(2000)
          .setPlaceholder("Quel contenu souhaitez-vous donner à votre message ?");

        const inputTitle = new TextInputBuilder()
          .setCustomId("embed_title")
          .setLabel("Titre de l'embed")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(256)
          .setPlaceholder("Quel titre souhaitez-vous donner à votre embed ?");

        // ✅ FIX: MODAL paragraph max = 4000 (pas 4096)
        const inputDesc = new TextInputBuilder()
          .setCustomId("embed_desc")
          .setLabel("Description de l'embed")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setPlaceholder("Quelle description souhaitez-vous donner à votre embed ?");

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputContent),
          new ActionRowBuilder().addComponents(inputTitle),
          new ActionRowBuilder().addComponents(inputDesc)
        );

        await interaction.showModal(modal);
        return true;
      }

      // /send : texte + fichier
      if (isSend) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        const message = ((interaction.options.getString("texte") || interaction.options.getString("message") || "")).trim();
        const explicitChannel = interaction.options.getChannel("salon") || null;

        const replyRaw = interaction.options.getString("reply_to") || null;
        const replyParsed = parseMessageLinkOrId(replyRaw);

        const allowMentions = interaction.options.getBoolean("mentions") ?? false;
        const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

        let targetChannel =
          explicitChannel ||
          (replyParsed?.channelId ? await fetchAnyChannel(interaction, replyParsed.channelId) : null) ||
          interaction.channel;

        if (
          !targetChannel ||
          !targetChannel.isTextBased?.() ||
          targetChannel.guildId !== interaction.guildId
        ) {
          await interaction
            .editReply("⚠️ Salon invalide (il doit être textuel et du même serveur).")
            .catch(() => {});
          return true;
        }

        if (explicitChannel && replyParsed?.channelId && explicitChannel.id !== replyParsed.channelId) {
          await interaction
            .editReply(
              "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`."
            )
            .catch(() => {});
          return true;
        }

        const canSend = await ensureBotCanSend(interaction, targetChannel);
        if (!canSend) {
          await interaction
            .editReply("⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon.")
            .catch(() => {});
          return true;
        }

        const attachment = interaction.options.getAttachment("file");
        if (!message && !attachment) {
          await interaction
            .editReply("⚠️ Tu dois fournir au moins un message ou un fichier.")
            .catch(() => {});
          return true;
        }

        const files = attachment ? [{ attachment: attachment.url, name: attachment.name || "file" }] : undefined;

        const replyRes = await resolveReply(targetChannel, replyParsed?.messageId || "0");
        if (replyRes?.error) {
          await interaction.editReply(replyRes.error).catch(() => {});
          return true;
        }

        await targetChannel.send({
          content: message ? message.slice(0, 2000) : undefined,
          files,
          allowedMentions,
          reply: replyRes.reply,
        });

        await interaction
          .editReply(
            `✅ Message envoyé dans ${targetChannel}${replyRes.reply ? " (en réponse)" : ""}${files ? " + fichier" : ""}.`
          )
          .catch(() => {});
        return true;
      }

      return false;
    } catch (e) {
      console.error("send-message handler fatal:", e);

      if (interaction?.isRepliable?.()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction
            .reply({ content: "⚠️ Erreur interne (voir logs).", flags: MessageFlags.Ephemeral })
            .catch(() => {});
        } else if (interaction.deferred) {
          await interaction.editReply("⚠️ Erreur interne (voir logs).").catch(() => {});
        }
      }
      return true;
    }
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
