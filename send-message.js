const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");

/**
 * 2 commandes:
 * - /send      -> message texte
 * - /sendembed -> embed structuré + fields
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
     /sendembed (embed + fields)
  -------------------------------- */
  const embedCmd = new SlashCommandBuilder()
    .setName("sendembed")
    .setDescription("MOD: Envoie un embed via le bot")
    .addStringOption((opt) =>
      opt
        .setName("description")
        .setDescription("Description de l'embed")
        .setRequired(true)
        .setMaxLength(4096)
    )
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("Titre de l'embed")
        .setRequired(false)
        .setMaxLength(256)
    )
    .addStringOption((opt) =>
      opt
        .setName("color")
        .setDescription("Couleur hex (ex: #ff0000 ou ff0000)")
        .setRequired(false)
        .setMaxLength(10)
    )
    .addStringOption((opt) =>
      opt
        .setName("thumbnail")
        .setDescription("URL thumbnail")
        .setRequired(false)
        .setMaxLength(400)
    )
    .addStringOption((opt) =>
      opt
        .setName("image")
        .setDescription("URL image")
        .setRequired(false)
        .setMaxLength(400)
    )
    .addStringOption((opt) =>
      opt
        .setName("footer")
        .setDescription("Footer de l'embed")
        .setRequired(false)
        .setMaxLength(2048)
    )
    .addStringOption((opt) =>
      opt
        .setName("content")
        .setDescription("Texte normal en plus de l'embed (optionnel)")
        .setRequired(false)
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

  // ✅ Fields 1..4 (Discord limite les options, 4 fields = bon compromis)
  for (let i = 1; i <= 4; i++) {
    embedCmd
      .addStringOption((opt) =>
        opt
          .setName(`field${i}_name`)
          .setDescription(`Field ${i} - Nom`)
          .setRequired(false)
          .setMaxLength(256)
      )
      .addStringOption((opt) =>
        opt
          .setName(`field${i}_value`)
          .setDescription(`Field ${i} - Valeur`)
          .setRequired(false)
          .setMaxLength(1024)
      )
      .addBooleanOption((opt) =>
        opt
          .setName(`field${i}_inline`)
          .setDescription(`Field ${i} - Inline ? (true/false)`)
          .setRequired(false)
      );
  }

  const commands = [sendCmd, embedCmd];

  /* -------------------------------
     Helpers
  -------------------------------- */
  function parseHexColor(input) {
    if (!input) return null;
    const cleaned = input.trim().replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
    return parseInt(cleaned, 16);
  }

  function parseMessageLinkOrId(input) {
    if (!input) return null;
    const s = input.trim();

    // ID simple
    if (/^\d{16,20}$/.test(s)) return { messageId: s, channelId: null };

    // Lien discord: https://discord.com/channels/GUILD/CHANNEL/MESSAGE
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

    // Si user a donné un salon différent de celui du lien: on bloque
    if (explicitChannel && replyParsed?.channelId && explicitChannel.id !== replyParsed.channelId) {
      return { error: "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`." };
    }

    const msg = await targetChannel.messages.fetch(replyParsed.messageId).catch(() => null);
    if (!msg) {
      return { error: "⚠️ Message `reply_to` introuvable (mauvais ID/lien, ou pas accessible)." };
    }

    return { reply: { messageReference: msg.id, failIfNotExists: false } };
  }

  function mustBeMod(interaction) {
    return (
      interaction.memberPermissions &&
      interaction.memberPermissions.has(PermissionsBitField.Flags.ManageMessages)
    );
  }

  /* -------------------------------
     Handler
  -------------------------------- */
  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return false;

    const isSend = interaction.commandName === "send";
    const isSendEmbed = interaction.commandName === "sendembed";
    if (!isSend && !isSendEmbed) return false;

    if (!mustBeMod(interaction)) {
      await interaction.reply({
        content: "⛔ Il faut la permission **Gérer les messages** pour utiliser cette commande.",
        ephemeral: true,
      });
      return true;
    }

    if (!interaction.guild) {
      await interaction.reply({
        content: "⚠️ Cette commande fonctionne uniquement dans un serveur.",
        ephemeral: true,
      });
      return true;
    }

    const explicitChannel = interaction.options.getChannel("salon") || null;
    const replyRaw = interaction.options.getString("reply_to") || null;
    const replyParsed = parseMessageLinkOrId(replyRaw);

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

    const allowMentions = interaction.options.getBoolean("mentions") ?? false;
    const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

    const attachment = interaction.options.getAttachment("file");
    const files = attachment
      ? [{ attachment: attachment.url, name: attachment.name || "file" }]
      : undefined;

    const replyRes = await resolveReply(interaction, targetChannel, replyParsed, explicitChannel);
    if (replyRes?.error) {
      await interaction.reply({ content: replyRes.error, ephemeral: true });
      return true;
    }
    const reply = replyRes?.reply;

    try {
      if (isSend) {
        const message = interaction.options.getString("message", true);

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
        return true;
      }

      if (isSendEmbed) {
        const description = interaction.options.getString("description", true);
        const title = interaction.options.getString("title") || null;
        const colorRaw = interaction.options.getString("color") || null;
        const thumbnail = interaction.options.getString("thumbnail") || null;
        const image = interaction.options.getString("image") || null;
        const footer = interaction.options.getString("footer") || null;
        const content = interaction.options.getString("content") || null;

        const eb = new EmbedBuilder().setDescription(description).setTimestamp();
        if (title) eb.setTitle(title);

        const hex = parseHexColor(colorRaw);
        if (hex !== null) eb.setColor(hex);

        if (thumbnail) eb.setThumbnail(thumbnail);
        if (image) eb.setImage(image);
        if (footer) eb.setFooter({ text: footer });

        // Fields 1..4
        const fields = [];
        for (let i = 1; i <= 4; i++) {
          const name = interaction.options.getString(`field${i}_name`) || "";
          const value = interaction.options.getString(`field${i}_value`) || "";
          if (!name || !value) continue;
          const inline = interaction.options.getBoolean(`field${i}_inline`) ?? false;
          fields.push({ name: name.slice(0, 256), value: value.slice(0, 1024), inline });
        }
        if (fields.length) eb.addFields(fields);

        await targetChannel.send({
          content: content || undefined,
          embeds: [eb],
          files,
          allowedMentions,
          reply,
        });

        await interaction.reply({
          content: `✅ Embed envoyé dans ${targetChannel}${reply ? " (en réponse)" : ""}${files ? " + fichier" : ""}.`,
          ephemeral: true,
        });
        return true;
      }
    } catch (e) {
      console.error("send/sendembed error:", e);
      await interaction.reply({
        content: "⚠️ Impossible d’envoyer (erreur).",
        ephemeral: true,
      });
      return true;
    }

    return true;
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
