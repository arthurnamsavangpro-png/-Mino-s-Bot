const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

function createSendMessageService() {
  const sendCmd = new SlashCommandBuilder()
    .setName("send")
    .setDescription("MOD: Envoie un message texte via le bot")
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Texte à envoyer").setRequired(true).setMaxLength(2000)
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
      opt.setName("reply_to").setDescription("Répondre à un message (ID ou lien)").setRequired(false).setMaxLength(200)
    )
    .addAttachmentOption((opt) =>
      opt.setName("file").setDescription("Pièce jointe (1 fichier)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("mentions").setDescription("Autoriser mentions users/roles (par défaut: non)").setRequired(false)
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
      opt.setName("reply_to").setDescription("Répondre à un message (ID ou lien)").setRequired(false).setMaxLength(200)
    )
    .addBooleanOption((opt) =>
      opt.setName("mentions").setDescription("Autoriser mentions users/roles (par défaut: non)").setRequired(false)
    );

  const commands = [sendCmd, sendEmbedCmd];

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
    if (!msg) return { error: "⚠️ Message `reply_to` introuvable (mauvais ID/lien, ou pas accessible)." };
    return { reply: { messageReference: msg.id, failIfNotExists: false } };
  }

  async function handleInteraction(interaction) {
    try {
      /* ---------------- MODAL SUBMIT ---------------- */
      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith("sendembed|")) return false;

        // ACK immédiat (anti-timeout)
        await interaction.deferReply({ ephemeral: true }).catch(() => {});

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

        // salon cible (thread inclus) via client.channels.fetch
        let targetChannel =
          (await fetchAnyChannel(interaction, channelId)) ||
          (await fetchAnyChannel(interaction, replyChannelId)) ||
          interaction.channel;

        if (!targetChannel || !targetChannel.isTextBased?.() || targetChannel.guildId !== interaction.guildId) {
          await interaction.editReply("⚠️ Salon invalide (il doit être textuel et du même serveur).").catch(() => {});
          return true;
        }

        // Interdire reply cross-salon
        if (channelId !== "0" && replyChannelId !== "0" && channelId !== replyChannelId) {
          await interaction.editReply(
            "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`."
          ).catch(() => {});
          return true;
        }

        const canSend = await ensureBotCanSend(interaction, targetChannel);
        if (!canSend) {
          await interaction.editReply("⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon.").catch(() => {});
          return true;
        }

        // ✅ lecture SAFE (évite crash si vieux modal)
        const messageContent = (safeGetField(interaction, "msg_content") || "").trim();
        const embedTitle = (safeGetField(interaction, "embed_title") || "").trim();
        const embedDesc = (safeGetField(interaction, "embed_desc") || "").trim();

        if (!embedDesc) {
          await interaction.editReply("⚠️ La description de l’embed est obligatoire.").catch(() => {});
          return true;
        }

        const eb = new EmbedBuilder().setDescription(embedDesc).setTimestamp();
        if (embedTitle) eb.setTitle(embedTitle);

        const replyRes = await resolveReply(targetChannel, replyMsgId);
        if (replyRes?.error) {
          await interaction.editReply(replyRes.error).catch(() => {});
          return true;
        }

        try {
          await targetChannel.send({
            content: messageContent || undefined,
            embeds: [eb],
            allowedMentions,
            reply: replyRes.reply,
          });

          await interaction.editReply(`✅ Embed envoyé dans ${targetChannel}.`).catch(() => {});
        } catch (e) {
          console.error("sendembed modal send error:", e);
          await interaction.editReply(`⚠️ Impossible d’envoyer: ${String(e?.message || e)}`).catch(() => {});
        }

        return true;
      }

      /* ---------------- SLASH COMMANDS ---------------- */
      if (!interaction.isChatInputCommand()) return false;

      const isSend = interaction.commandName === "send";
      const isSendEmbed = interaction.commandName === "sendembed";
      if (!isSend && !isSendEmbed) return false;

      if (!interaction.guild) {
        await interaction.reply({ content: "⚠️ Cette commande fonctionne uniquement dans un serveur.", ephemeral: true });
        return true;
      }
      if (!mustBeMod(interaction)) {
        await interaction.reply({ content: "⛔ Il faut la permission **Gérer les messages**.", ephemeral: true });
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

        const inputDesc = new TextInputBuilder()
          .setCustomId("embed_desc")
          .setLabel("Description de l'embed")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4096)
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
        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        const message = interaction.options.getString("message", true);
        const explicitChannel = interaction.options.getChannel("salon") || null;

        const replyRaw = interaction.options.getString("reply_to") || null;
        const replyParsed = parseMessageLinkOrId(replyRaw);

        const allowMentions = interaction.options.getBoolean("mentions") ?? false;
        const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

        let targetChannel =
          explicitChannel ||
          (replyParsed?.channelId ? await fetchAnyChannel(interaction, replyParsed.channelId) : null) ||
          interaction.channel;

        if (!targetChannel || !targetChannel.isTextBased?.() || targetChannel.guildId !== interaction.guildId) {
          await interaction.editReply("⚠️ Salon invalide (il doit être textuel et du même serveur).").catch(() => {});
          return true;
        }

        if (explicitChannel && replyParsed?.channelId && explicitChannel.id !== replyParsed.channelId) {
          await interaction.editReply(
            "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`."
          ).catch(() => {});
          return true;
        }

        const canSend = await ensureBotCanSend(interaction, targetChannel);
        if (!canSend) {
          await interaction.editReply("⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon.").catch(() => {});
          return true;
        }

        const attachment = interaction.options.getAttachment("file");
        const files = attachment ? [{ attachment: attachment.url, name: attachment.name || "file" }] : undefined;

        const replyRes = await resolveReply(targetChannel, replyParsed?.messageId || "0");
        if (replyRes?.error) {
          await interaction.editReply(replyRes.error).catch(() => {});
          return true;
        }

        try {
          await targetChannel.send({
            content: message,
            files,
            allowedMentions,
            reply: replyRes.reply,
          });

          await interaction.editReply(
            `✅ Message envoyé dans ${targetChannel}${replyRes.reply ? " (en réponse)" : ""}${files ? " + fichier" : ""}.`
          ).catch(() => {});
        } catch (e) {
          console.error("send error:", e);
          await interaction.editReply(`⚠️ Impossible d’envoyer: ${String(e?.message || e)}`).catch(() => {});
        }

        return true;
      }

      return false;
    } catch (e) {
      console.error("send-message handler fatal:", e);

      // fallback anti-timeout
      if (interaction && interaction.isRepliable && interaction.isRepliable()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: "⚠️ Erreur interne (voir logs).", ephemeral: true }).catch(() => {});
        } else if (interaction.deferred && !interaction.replied) {
          await interaction.editReply("⚠️ Erreur interne (voir logs).").catch(() => {});
        }
      }
      return true;
    }
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
