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

  async function getTargetChannel(interaction, explicitChannel, replyParsed) {
    let target = explicitChannel || interaction.channel;

    // Si reply lien => déduire le salon si aucun salon explicite
    if (!explicitChannel && replyParsed?.channelId) {
      const ch = await interaction.guild.channels.fetch(replyParsed.channelId).catch(() => null);
      if (ch && ch.isTextBased()) target = ch;
    }

    return target;
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

  async function resolveReply(interaction, targetChannel, replyParsed, explicitChannel) {
    if (!replyParsed?.messageId) return null;

    if (explicitChannel && replyParsed?.channelId && explicitChannel.id !== replyParsed.channelId) {
      return { error: "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`." };
    }

    const msg = await targetChannel.messages.fetch(replyParsed.messageId).catch(() => null);
    if (!msg) return { error: "⚠️ Message `reply_to` introuvable (mauvais ID/lien, ou pas accessible)." };

    return { reply: { messageReference: msg.id, failIfNotExists: false } };
  }

  /* -------------------------------
     Handler (slash + modal submit)
  -------------------------------- */
  async function handleInteraction(interaction) {
    /* ---------- MODAL SUBMIT ---------- */
    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith("sendembed|")) return false;

      if (!interaction.guild) {
        await interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });
        return true;
      }
      if (!mustBeMod(interaction)) {
        await interaction.reply({
          content: "⛔ Il faut la permission **Gérer les messages**.",
          ephemeral: true,
        });
        return true;
      }

      // customId: sendembed|channelId|mentions|replyMsgId
      const [, channelId, mentionsFlag, replyMsgId] = interaction.customId.split("|");
      const allowMentions = mentionsFlag === "1";

      const targetChannel =
        (channelId && channelId !== "0"
          ? await interaction.guild.channels.fetch(channelId).catch(() => null)
          : interaction.channel) || interaction.channel;

      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.reply({ content: "⚠️ Salon invalide.", ephemeral: true });
        return true;
      }

      const canSend = await ensureBotCanSend(interaction, targetChannel);
      if (!canSend) {
        await interaction.reply({
          content: "⚠️ Je n’ai pas la permission d’envoyer des messages dans ce salon.",
          ephemeral: true,
        });
        return true;
      }

      const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

      const messageContent = interaction.fields.getTextInputValue("msg_content")?.trim() || "";
      const embedTitle = interaction.fields.getTextInputValue("embed_title")?.trim() || "";
      const embedDesc = interaction.fields.getTextInputValue("embed_desc")?.trim() || "";

      if (!embedDesc) {
        await interaction.reply({ content: "⚠️ La description de l’embed est obligatoire.", ephemeral: true });
        return true;
      }

      const eb = new EmbedBuilder().setDescription(embedDesc).setTimestamp();
      if (embedTitle) eb.setTitle(embedTitle);

      let reply = undefined;
      if (replyMsgId && replyMsgId !== "0") {
        const msg = await targetChannel.messages.fetch(replyMsgId).catch(() => null);
        if (msg) reply = { messageReference: msg.id, failIfNotExists: false };
      }

      try {
        await targetChannel.send({
          content: messageContent || undefined,
          embeds: [eb],
          allowedMentions,
          reply,
        });

        await interaction.reply({
          content: `✅ Embed envoyé dans ${targetChannel}.`,
          ephemeral: true,
        });
      } catch (e) {
        console.error("sendembed modal error:", e);
        await interaction.reply({ content: "⚠️ Impossible d’envoyer (erreur).", ephemeral: true });
      }

      return true;
    }

    /* ---------- SLASH COMMANDS ---------- */
    if (!interaction.isChatInputCommand()) return false;

    const isSend = interaction.commandName === "send";
    const isSendEmbed = interaction.commandName === "sendembed";
    if (!isSend && !isSendEmbed) return false;

    if (!interaction.guild) {
      await interaction.reply({ content: "⚠️ Cette commande fonctionne uniquement dans un serveur.", ephemeral: true });
      return true;
    }

    if (!mustBeMod(interaction)) {
      await interaction.reply({
        content: "⛔ Il faut la permission **Gérer les messages** pour utiliser cette commande.",
        ephemeral: true,
      });
      return true;
    }

    const explicitChannel = interaction.options.getChannel("salon") || null;
    const replyRaw = interaction.options.getString("reply_to") || null;
    const replyParsed = parseMessageLinkOrId(replyRaw);
    const allowMentions = interaction.options.getBoolean("mentions") ?? false;

    const targetChannel = await getTargetChannel(interaction, explicitChannel, replyParsed);
    if (!targetChannel || !targetChannel.isTextBased()) {
      await interaction.reply({ content: "⚠️ Salon invalide (il doit être textuel).", ephemeral: true });
      return true;
    }

    const canSend = await ensureBotCanSend(interaction, targetChannel);
    if (!canSend) {
      await interaction.reply({
        content:
          "⚠️ Je n’ai pas la permission **Voir le salon** et/ou **Envoyer des messages** (ou **Envoyer dans les threads**) ici.",
        ephemeral: true,
      });
      return true;
    }

    const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

    // Reply (pour /send uniquement ici — /sendembed gère ça via customId aussi)
    const replyRes = await resolveReply(interaction, targetChannel, replyParsed, explicitChannel);
    if (replyRes?.error) {
      await interaction.reply({ content: replyRes.error, ephemeral: true });
      return true;
    }
    const reply = replyRes?.reply;

    /* ---------- /send ---------- */
    if (isSend) {
      const message = interaction.options.getString("message", true);

      const attachment = interaction.options.getAttachment("file");
      const files = attachment
        ? [{ attachment: attachment.url, name: attachment.name || "file" }]
        : undefined;

      try {
        await targetChannel.send({
          content: message,
          files,
          allowedMentions,
          reply,
        });

        await interaction.reply({
          content: `✅ Message envoyé dans ${targetChannel}${reply ? " (en réponse)" : ""}${files ? " + fichier" : ""}.`,
          ephemeral: true,
        });
      } catch (e) {
        console.error("send error:", e);
        await interaction.reply({ content: "⚠️ Impossible d’envoyer (erreur).", ephemeral: true });
      }

      return true;
    }

    /* ---------- /sendembed (ouvre le MODAL) ---------- */
    if (isSendEmbed) {
      // On encode juste ce qu’on peut dans customId (limite 100 chars)
      const channelId = explicitChannel?.id || "0";
      const mentionsFlag = allowMentions ? "1" : "0";

      // reply message id (si lien cross-channel on a déjà résolu plus haut)
      const replyMsgId = replyParsed?.messageId || "0";

      const modal = new ModalBuilder()
        .setCustomId(`sendembed|${channelId}|${mentionsFlag}|${replyMsgId}`)
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

    return true;
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
