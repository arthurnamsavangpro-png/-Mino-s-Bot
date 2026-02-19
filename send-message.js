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

/**
 * 2 commandes:
 * - /send      -> message texte direct
 * - /sendembed -> ouvre un MODAL (comme ta capture) puis envoie l'embed
 */
function createSendMessageService() {
  /* -------------------------------
     /send (texte)
  -------------------------------- */
  const sendCmd = new SlashCommandBuilder()
    .setName("send")
    .setDescription("MOD: Envoie un message texte via le bot")
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Texte à envoyer")
        .setRequired(true)
        .setMaxLength(2000)
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
        .setDescription("Répondre à un message (ID ou lien Discord du message)")
        .setRequired(false)
        .setMaxLength(200)
    )
    .addAttachmentOption((opt) =>
      opt
        .setName("file")
        .setDescription("Pièce jointe à envoyer (1 fichier)")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("mentions")
        .setDescription("Autoriser mentions users/roles (par défaut: non)")
        .setRequired(false)
    );

  /* -------------------------------
     /sendembed (modal)
     IMPORTANT: on ouvre le modal immédiatement (pas de fetch avant)
  -------------------------------- */
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
        .setDescription("Répondre à un message (ID ou lien Discord du message)")
        .setRequired(false)
        .setMaxLength(200)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("mentions")
        .setDescription("Autoriser mentions users/roles (par défaut: non)")
        .setRequired(false)
    );

  const commands = [sendCmd, sendEmbedCmd];

  /* -------------------------------
     Helpers
  -------------------------------- */
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

  async function ensureBotCanSend(interaction, targetChannel) {
    const me = await interaction.guild.members.fetchMe().catch(() => null);
    const perms = targetChannel.permissionsFor(me);

    const needThreadPerm = targetChannel.isThread?.() === true;
    const canSend =
      perms?.has(PermissionsBitField.Flags.ViewChannel) &&
      perms?.has(PermissionsBitField.Flags.SendMessages) &&
      (!needThreadPerm || perms?.has(PermissionsBitField.Flags.SendMessagesInThreads));

    return Boolean(canSend);
  }

  async function resolveReply(targetChannel, replyMsgId) {
    if (!replyMsgId || replyMsgId === "0") return { reply: undefined };

    const msg = await targetChannel.messages.fetch(replyMsgId).catch(() => null);
    if (!msg) {
      return { error: "⚠️ Message `reply_to` introuvable (mauvais ID/lien, ou pas accessible)." };
    }
    return { reply: { messageReference: msg.id, failIfNotExists: false } };
  }

  /* -------------------------------
     Handler (slash + modal submit)
  -------------------------------- */
  async function handleInteraction(interaction) {
    /* ---------- MODAL SUBMIT ---------- */
    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith("sendembed|")) return false;

      // ACK immédiat pour éviter "l'application ne répond plus"
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

      // Choix du salon:
      // - si salon fourni via /sendembed -> channelId
      // - sinon si reply link avait un salon -> replyChannelId
      // - sinon -> salon courant
      let targetChannel =
        (channelId !== "0"
          ? await interaction.guild.channels.fetch(channelId).catch(() => null)
          : null) ||
        (replyChannelId !== "0"
          ? await interaction.guild.channels.fetch(replyChannelId).catch(() => null)
          : null) ||
        interaction.channel;

      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.editReply("⚠️ Salon invalide (il doit être textuel).").catch(() => {});
        return true;
      }

      // Si l'utilisateur a choisi un salon MAIS reply link est d'un autre salon => on refuse (reply cross-channel impossible)
      if (channelId !== "0" && replyChannelId !== "0" && channelId !== replyChannelId) {
        await interaction.editReply(
          "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`."
        ).catch(() => {});
        return true;
      }

      const canSend = await ensureBotCanSend(interaction, targetChannel);
      if (!canSend) {
        await interaction.editReply(
          "⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon."
        ).catch(() => {});
        return true;
      }

      const messageContent = interaction.fields.getTextInputValue("msg_content")?.trim() || "";
      const embedTitle = interaction.fields.getTextInputValue("embed_title")?.trim() || "";
      const embedDesc = interaction.fields.getTextInputValue("embed_desc")?.trim() || "";

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
        console.error("sendembed modal error:", e);
        await interaction.editReply("⚠️ Impossible d’envoyer (erreur).").catch(() => {});
      }

      return true;
    }

    /* ---------- SLASH COMMANDS ---------- */
    if (!interaction.isChatInputCommand()) return false;

    const isSend = interaction.commandName === "send";
    const isSendEmbed = interaction.commandName === "sendembed";
    if (!isSend && !isSendEmbed) return false;

    if (!interaction.guild) {
      await interaction.reply({
        content: "⚠️ Cette commande fonctionne uniquement dans un serveur.",
        ephemeral: true,
      });
      return true;
    }

    if (!mustBeMod(interaction)) {
      await interaction.reply({
        content: "⛔ Il faut la permission **Gérer les messages** pour utiliser cette commande.",
        ephemeral: true,
      });
      return true;
    }

    /* ---------- /sendembed : ouvre le MODAL immédiatement ---------- */
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

    /* ---------- /send (texte) ---------- */
    if (isSend) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      const message = interaction.options.getString("message", true);
      const explicitChannel = interaction.options.getChannel("salon") || null;

      const replyRaw = interaction.options.getString("reply_to") || null;
      const replyParsed = parseMessageLinkOrId(replyRaw);

      const allowMentions = interaction.options.getBoolean("mentions") ?? false;
      const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

      // Choix salon (si reply link et pas de salon explicite -> on en déduit le salon)
      let targetChannel =
        explicitChannel ||
        (replyParsed?.channelId
          ? await interaction.guild.channels.fetch(replyParsed.channelId).catch(() => null)
          : null) ||
        interaction.channel;

      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.editReply("⚠️ Salon invalide (il doit être textuel).").catch(() => {});
        return true;
      }

      // Si salon explicite et reply link d'un autre salon => refuse (reply cross-channel impossible)
      if (explicitChannel && replyParsed?.channelId && explicitChannel.id !== replyParsed.channelId) {
        await interaction.editReply(
          "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`."
        ).catch(() => {});
        return true;
      }

      const canSend = await ensureBotCanSend(interaction, targetChannel);
      if (!canSend) {
        await interaction.editReply(
          "⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon."
        ).catch(() => {});
        return true;
      }

      const attachment = interaction.options.getAttachment("file");
      const files = attachment
        ? [{ attachment: attachment.url, name: attachment.name || "file" }]
        : undefined;

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
        await interaction.editReply("⚠️ Impossible d’envoyer (erreur).").catch(() => {});
      }

      return true;
    }

    return true;
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
