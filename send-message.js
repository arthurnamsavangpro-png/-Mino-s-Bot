const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");

function createSendMessageService() {
  const cmd = new SlashCommandBuilder()
    .setName("send")
    .setDescription("MOD: Envoie un message via le bot")
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Texte du message (ou description embed si embed activé)")
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
    .addBooleanOption((opt) =>
      opt
        .setName("mentions")
        .setDescription("Autoriser mentions users/roles (par défaut: non)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("reply_to")
        .setDescription("Répondre à un message (ID ou lien Discord du message)")
        .setRequired(false)
        .setMaxLength(200)
    )
    .addAttachmentOption((opt) =>
      opt.setName("file").setDescription("Pièce jointe à envoyer (1 fichier)").setRequired(false)
    )
    // ---- EMBED OPTIONS ----
    .addBooleanOption((opt) =>
      opt.setName("embed").setDescription("Envoyer en embed (par défaut: non)").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("embed_title").setDescription("Titre de l'embed").setRequired(false).setMaxLength(256)
    )
    .addStringOption((opt) =>
      opt
        .setName("embed_desc")
        .setDescription("Description de l'embed (sinon: utilise 'message')")
        .setRequired(false)
        .setMaxLength(4096)
    )
    .addStringOption((opt) =>
      opt
        .setName("embed_color")
        .setDescription("Couleur hex (ex: #ff0000 ou ff0000)")
        .setRequired(false)
        .setMaxLength(10)
    )
    .addStringOption((opt) =>
      opt.setName("embed_thumbnail").setDescription("URL thumbnail").setRequired(false).setMaxLength(400)
    )
    .addStringOption((opt) =>
      opt.setName("embed_image").setDescription("URL image").setRequired(false).setMaxLength(400)
    )
    .addStringOption((opt) =>
      opt.setName("embed_footer").setDescription("Footer de l'embed").setRequired(false).setMaxLength(2048)
    );

  // ✅ Fields 1..4 (max possible sans dépasser la limite d’options Discord)
  for (let i = 1; i <= 4; i++) {
    cmd
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

  const commands = [cmd];

  function parseHexColor(input) {
    if (!input) return null;
    const cleaned = input.trim().replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
    return parseInt(cleaned, 16);
  }

  function parseMessageLinkOrId(input) {
    if (!input) return null;
    const s = input.trim();
    if (/^\d{16,20}$/.test(s)) return { messageId: s, channelId: null };
    const m = s.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (m) return { channelId: m[2], messageId: m[3] };
    return null;
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return false;
    if (interaction.commandName !== "send") return false;

    if (
      !interaction.memberPermissions ||
      !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageMessages)
    ) {
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

    const content = interaction.options.getString("message", true);
    const allowMentions = interaction.options.getBoolean("mentions") ?? false;

    const replyRaw = interaction.options.getString("reply_to") || null;
    const replyParsed = parseMessageLinkOrId(replyRaw);

    const explicitChannel = interaction.options.getChannel("salon") || null;
    let targetChannel = explicitChannel || interaction.channel;

    if (!explicitChannel && replyParsed?.channelId) {
      const ch = await interaction.guild.channels.fetch(replyParsed.channelId).catch(() => null);
      if (ch && ch.isTextBased()) targetChannel = ch;
    }

    if (!targetChannel || !targetChannel.isTextBased()) {
      await interaction.reply({ content: "⚠️ Salon invalide (il doit être textuel).", ephemeral: true });
      return true;
    }

    if (explicitChannel && replyParsed?.channelId && explicitChannel.id !== replyParsed.channelId) {
      await interaction.reply({
        content:
          "⚠️ Le message à reply n’est pas dans le salon choisi. Mets le bon salon, ou enlève `salon:`.",
        ephemeral: true,
      });
      return true;
    }

    const me = await interaction.guild.members.fetchMe().catch(() => null);
    const perms = targetChannel.permissionsFor(me);

    const needThreadPerm = targetChannel.isThread?.() === true;
    const canSend =
      perms?.has(PermissionsBitField.Flags.ViewChannel) &&
      perms?.has(PermissionsBitField.Flags.SendMessages) &&
      (!needThreadPerm || perms?.has(PermissionsBitField.Flags.SendMessagesInThreads));

    if (!canSend) {
      await interaction.reply({
        content:
          "⚠️ Je n’ai pas la permission **Voir le salon** et/ou **Envoyer des messages** (ou **Envoyer dans les threads**) ici.",
        ephemeral: true,
      });
      return true;
    }

    const allowedMentions = allowMentions ? { parse: ["users", "roles"] } : { parse: [] };

    const attachment = interaction.options.getAttachment("file");
    const files = attachment ? [{ attachment: attachment.url, name: attachment.name || "file" }] : undefined;

    // Embed
    const useEmbed = interaction.options.getBoolean("embed") ?? false;
    const embedTitle = interaction.options.getString("embed_title") || null;
    const embedDesc = interaction.options.getString("embed_desc") || null;
    const embedColorRaw = interaction.options.getString("embed_color") || null;
    const embedThumb = interaction.options.getString("embed_thumbnail") || null;
    const embedImage = interaction.options.getString("embed_image") || null;
    const embedFooter = interaction.options.getString("embed_footer") || null;

    let embeds = undefined;
    if (useEmbed) {
      const eb = new EmbedBuilder();

      if (embedTitle) eb.setTitle(embedTitle);
      eb.setDescription(embedDesc ?? content);

      const hex = parseHexColor(embedColorRaw);
      if (hex !== null) eb.setColor(hex);

      if (embedThumb) eb.setThumbnail(embedThumb);
      if (embedImage) eb.setImage(embedImage);
      if (embedFooter) eb.setFooter({ text: embedFooter });

      // ✅ Fields via options Field1..Field4
      const fields = [];
      for (let i = 1; i <= 4; i++) {
        const name = interaction.options.getString(`field${i}_name`) || "";
        const value = interaction.options.getString(`field${i}_value`) || "";
        if (!name || !value) continue;
        const inline = interaction.options.getBoolean(`field${i}_inline`) ?? false;
        fields.push({ name: name.slice(0, 256), value: value.slice(0, 1024), inline });
      }
      if (fields.length) eb.addFields(fields);

      eb.setTimestamp();
      embeds = [eb];
    }

    // Reply
    let reply = undefined;
    if (replyParsed?.messageId) {
      const msg = await targetChannel.messages.fetch(replyParsed.messageId).catch(() => null);
      if (!msg) {
        await interaction.reply({
          content: "⚠️ Message `reply_to` introuvable (mauvais ID/lien, ou pas accessible).",
          ephemeral: true,
        });
        return true;
      }
      reply = { messageReference: msg.id, failIfNotExists: false };
    }

    const payload = {
      content: useEmbed ? undefined : content,
      embeds,
      files,
      allowedMentions,
      reply,
    };

    try {
      await targetChannel.send(payload);
      await interaction.reply({
        content: `✅ Envoyé dans ${targetChannel}${reply ? " (en réponse)" : ""}${files ? " + fichier" : ""}${useEmbed ? " + embed" : ""}.`,
        ephemeral: true,
      });
    } catch (e) {
      console.error("send command error:", e);
      await interaction.reply({ content: "⚠️ Impossible d’envoyer le message (erreur).", ephemeral: true });
    }

    return true;
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
