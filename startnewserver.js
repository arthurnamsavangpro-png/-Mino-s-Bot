const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
} = require('discord.js');

function createStartNewServerService() {
  const commands = [
    new SlashCommandBuilder()
      .setName('startnewserver')
      .setDescription('Assistant de configuration rapide pour un nouveau serveur Discord'),
  ];

  function buildMainEmbed(guildName) {
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🚀 Assistant /startnewserver')
      .setDescription(
        [
          `Configuration rapide pour **${guildName || 'ton serveur'}**.`,
          '',
          'Utilise ce guide pour avoir une base propre en moins de 10 minutes.',
          '',
          '### 1) Sécurité & logs',
          '• `/log set` puis `/log events` pour activer les événements importants.',
          '• `/automod preset` puis `/automod panel` pour une protection immédiate.',
          '',
          '### 2) Accueil & rétention',
          '• `/welcome set` pour message + salon d’arrivée.',
          '• `/invite setlog` et `/invite setannonce` pour suivre la croissance.',
          '',
          '### 3) Support & organisation',
          '• `/ticket-setup` et `/ticket-panel` pour le support utilisateur.',
          '• `/serverstats setup` pour afficher les compteurs vocaux.',
          '',
          'Clique sur les boutons ci-dessous pour obtenir une checklist prête à suivre.',
        ].join('\n')
      )
      .setFooter({ text: 'Astuce: lance aussi /help pour voir toutes les catégories.' });
  }

  function buildChecklistEmbed() {
    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Checklist configuration rapide')
      .setDescription(
        [
          '1. Crée un salon `#logs-bot` privé au staff.',
          '2. Lance `/log set` puis `/log status`.',
          '3. Lance `/automod preset` (mode strict conseillé pour serveurs publics).',
          '4. Lance `/welcome set` avec un message clair + règles.',
          '5. Lance `/ticket-setup` puis `/ticket-panel`.',
          '6. Configure `/invite setlog` pour tracer les arrivées.',
          '7. Termine avec `/help` pour ajuster les modules optionnels.',
        ].join('\n')
      );
  }

  function buildLogsEmbed() {
    return new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🧭 Où mettre les logs ?')
      .setDescription(
        [
          'Structure simple et intuitive recommandée :',
          '',
          '• `#logs-moderation` → sanctions, warns, timeout (`/log set`).',
          '• `#logs-invitations` → joins/leaves & invites (`/invite setlog`).',
          '• `#annonces-invitations` → mise en avant des nouveaux (`/invite setannonce`).',
          '• `#tickets-logs` → transcripts/fermetures tickets.',
          '',
          'Astuce: garde ces salons invisibles pour les membres non staff.',
        ].join('\n')
      );
  }

  function buildActionRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('startnewserver:checklist')
        .setLabel('Checklist rapide')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('startnewserver:logs')
        .setLabel('Plan des logs')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  async function handleSlash(interaction) {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: '❌ Tu dois avoir la permission **Gérer le serveur** pour utiliser cette commande.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.reply({
      embeds: [buildMainEmbed(interaction.guild?.name)],
      components: [buildActionRow()],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async function handleButton(interaction) {
    if (!interaction.isButton() || !interaction.customId?.startsWith('startnewserver:')) return false;

    if (interaction.customId === 'startnewserver:checklist') {
      await interaction.reply({
        embeds: [buildChecklistEmbed()],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (interaction.customId === 'startnewserver:logs') {
      await interaction.reply({
        embeds: [buildLogsEmbed()],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    return false;
  }

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === 'startnewserver') {
      return handleSlash(interaction);
    }
    return handleButton(interaction);
  }

  return { commands, handleInteraction };
}

module.exports = { createStartNewServerService };
