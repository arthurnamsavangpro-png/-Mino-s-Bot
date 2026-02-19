const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");

/**
 * Service: /send
 * - Envoie un message en tant que bot
 * - Optionnel: choisir un salon
 * - Optionnel: autoriser mentions (users/roles) (désactivé par défaut)
 */
function createSendMessageService() {
  const commands = [
    new SlashCommandBuilder()
      .setName("send")
      .setDescription("MOD: Envoie un message via le bot")
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription("Le message à envoyer")
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
            ChannelType.PrivateThread
          )
      )
      .addBooleanOption((opt) =>
        opt
          .setName("mentions")
          .setDescription("Autoriser mentions users/roles (par défaut: non)")
          .setRequired(false)
      ),
  ];

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return false;
    if (interaction.commandName !== "send") return false;

    // Permission mod (tu peux changer en ManageGuild / Administrator si tu veux)
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

    const msg = interaction.options.getString("message", true);
    const targetChannel = interaction.options.getChannel("salon") || interaction.channel;
    const allowMentions = interaction.options.getBoolean("mentions") ?? false;

    // Sécurité: salon text only
    if (!targetChannel || !targetChannel.isTextBased()) {
      await interaction.reply({
        content: "⚠️ Salon invalide (il doit être textuel).",
        ephemeral: true,
      });
      return true;
    }

    // Vérifie permissions du bot dans le salon
    const me = interaction.guild?.members?.me || (await interaction.guild?.members.fetchMe().catch(() => null));
    const perms = targetChannel.permissionsFor(me);
    if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel) || !perms.has(PermissionsBitField.Flags.SendMessages)) {
      await interaction.reply({
        content: "⚠️ Je n’ai pas la permission **Voir le salon** et/ou **Envoyer des messages** dans ce salon.",
        ephemeral: true,
      });
      return true;
    }

    // Anti ping: par défaut aucune mention n'est parsée
    const allowedMentions = allowMentions
      ? { parse: ["users", "roles"] } // pas @everyone / @here
      : { parse: [] };

    try {
      const sent = await targetChannel.send({
        content: msg,
        allowedMentions,
      });

      await interaction.reply({
        content: `✅ Message envoyé dans ${targetChannel} (ID: ${sent.id}).`,
        ephemeral: true,
      });
    } catch (e) {
      console.error("send command error:", e);
      await interaction.reply({
        content: "⚠️ Impossible d’envoyer le message (erreur).",
        ephemeral: true,
      });
    }

    return true;
  }

  return { commands, handleInteraction };
}

module.exports = { createSendMessageService };
