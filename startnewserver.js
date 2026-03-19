const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const DEFAULT_WELCOME_TEMPLATE =
  '👋 Bienvenue {user} sur **{server}** !\nTu es notre **{member_count}e** membre.\n📘 Lis le règlement puis présente-toi pour démarrer.';

function createStartNewServerService({ pool }) {
  const commands = [
    new SlashCommandBuilder()
      .setName('startnewserver')
      .setDescription('Assistant de configuration rapide pour un nouveau serveur Discord')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Guide classique ou mode booster auto')
          .setRequired(false)
          .addChoices(
            { name: 'Guide', value: 'guide' },
            { name: 'Booster (auto setup)', value: 'booster' }
          )
      )
      .addStringOption((opt) =>
        opt
          .setName('welcome_message')
          .setDescription('Template bienvenue (optionnel en mode booster)')
          .setRequired(false)
          .setMaxLength(1900)
      ),
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

  function buildBoosterReportEmbed(report) {
    const done = report.ok.length ? report.ok.map((s) => `✅ ${s}`).join('\n') : '—';
    const warnings = report.warnings.length ? report.warnings.map((s) => `⚠️ ${s}`).join('\n') : 'Aucun';
    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🚀 Mode Booster terminé')
      .setDescription(
        [
          'Le bot a appliqué automatiquement une configuration de base.',
          '',
          '**Actions appliquées**',
          done,
          '',
          '**Points à vérifier**',
          warnings,
          '',
          'Tu peux maintenant affiner via `/help` ou relancer `/startnewserver mode:guide`.',
        ].join('\n')
      );
  }

  async function ensureTextChannel(guild, name, parentId = null, topic = null) {
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.name === name
    );
    if (existing) {
      if (parentId && existing.parentId !== parentId) {
        await existing.setParent(parentId).catch(() => {});
      }
      return existing;
    }
    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      topic: topic || undefined,
      parent: parentId || undefined,
    });
  }

  async function ensureVoiceChannel(guild, name, parentId) {
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildVoice && ch.name === name
    );
    if (existing) {
      if (parentId && existing.parentId !== parentId) {
        await existing.setParent(parentId).catch(() => {});
      }
      return existing;
    }
    return guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId || undefined,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
        },
      ],
    });
  }

  async function runBoosterSetup(interaction) {
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    const report = { ok: [], warnings: [] };
    const welcomeTemplate = interaction.options.getString('welcome_message') || DEFAULT_WELCOME_TEMPLATE;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Évite l'auto-sanction pendant la création massive de salons.
    await pool
      .query(
        `INSERT INTO automod_settings (guild_id, settings_json, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (guild_id) DO UPDATE
           SET settings_json = jsonb_set(
             jsonb_set(COALESCE(automod_settings.settings_json, '{}'::jsonb), '{enabled}', 'false'::jsonb, true),
             '{admin_raid,enabled}',
             'false'::jsonb,
             true
           ),
               updated_at = NOW()`,
        [guildId, JSON.stringify({ enabled: false, admin_raid: { enabled: false } })]
      )
      .then(() => report.ok.push('AutoMod mis en pause temporaire pendant le setup.'))
      .catch(() => report.warnings.push('Impossible de mettre AutoMod en pause avant setup.'));

    let setupCategory = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name === '🤖・mino-setup'
    );
    if (!setupCategory) {
      setupCategory = await guild.channels
        .create({ name: '🤖・mino-setup', type: ChannelType.GuildCategory })
        .catch(() => null);
    }
    if (!setupCategory) report.warnings.push('Impossible de créer la catégorie setup (permissions).');

    const logsMod = await ensureTextChannel(
      guild,
      'logs-moderation',
      setupCategory?.id || null,
      'Logs modération du bot'
    ).catch(() => null);
    const logsInvites = await ensureTextChannel(
      guild,
      'logs-invitations',
      setupCategory?.id || null,
      'Logs invitations du bot'
    ).catch(() => null);
    const announceInvites = await ensureTextChannel(
      guild,
      'annonces-invitations',
      setupCategory?.id || null,
      'Annonces nouveaux membres'
    ).catch(() => null);
    const welcomeChannel = await ensureTextChannel(
      guild,
      'bienvenue',
      setupCategory?.id || null,
      'Messages de bienvenue auto'
    ).catch(() => null);

    if (logsMod) report.ok.push(`Salon logs modération: ${logsMod}.`);
    else report.warnings.push('Salon `logs-moderation` non créé.');
    if (logsInvites) report.ok.push(`Salon logs invitations: ${logsInvites}.`);
    else report.warnings.push('Salon `logs-invitations` non créé.');
    if (announceInvites) report.ok.push(`Salon annonces invitations: ${announceInvites}.`);
    else report.warnings.push('Salon `annonces-invitations` non créé.');
    if (welcomeChannel) report.ok.push(`Salon bienvenue: ${welcomeChannel}.`);
    else report.warnings.push('Salon `bienvenue` non créé.');

    if (logsMod) {
      await pool
        .query(
          `INSERT INTO mod_settings (guild_id, modlog_channel_id, staff_role_id, log_events)
           VALUES ($1, $2, NULL, $3::jsonb)
           ON CONFLICT (guild_id) DO UPDATE
             SET modlog_channel_id = EXCLUDED.modlog_channel_id,
                 log_events = EXCLUDED.log_events,
                 updated_at = NOW()`,
          [
            guildId,
            logsMod.id,
            JSON.stringify({
              message_delete: true,
              message_edit: true,
              member_join: true,
              member_leave: true,
              member_ban: true,
              member_unban: true,
              member_timeout: true,
              role_create: true,
              role_delete: true,
            }),
          ]
        )
        .then(() => report.ok.push('Logs modération configurés.'))
        .catch(() => report.warnings.push('Configuration DB des logs modération échouée.'));
    }

    await pool
      .query(
        `INSERT INTO invite_settings (guild_id, log_channel_id, announce_channel_id, fake_min_account_days)
         VALUES ($1, $2, $3, 7)
         ON CONFLICT (guild_id) DO UPDATE
           SET log_channel_id = EXCLUDED.log_channel_id,
               announce_channel_id = EXCLUDED.announce_channel_id,
               fake_min_account_days = EXCLUDED.fake_min_account_days,
               updated_at = NOW()`,
        [guildId, logsInvites?.id || null, announceInvites?.id || null]
      )
      .then(() => report.ok.push('Invitations (logs + annonces) configurées.'))
      .catch(() => report.warnings.push('Configuration DB des invitations échouée.'));

    await pool
      .query(
        `INSERT INTO welcome_settings (guild_id, channel_id, message_template, enabled, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         ON CONFLICT (guild_id) DO UPDATE
           SET channel_id = EXCLUDED.channel_id,
               message_template = EXCLUDED.message_template,
               enabled = TRUE,
               updated_at = NOW()`,
        [guildId, welcomeChannel?.id || null, welcomeTemplate]
      )
      .then(() => report.ok.push('Message de bienvenue activé.'))
      .catch(() => report.warnings.push('Configuration DB du welcome échouée.'));

    await pool
      .query(
        `INSERT INTO automod_settings (guild_id, settings_json, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (guild_id) DO UPDATE
           SET settings_json = EXCLUDED.settings_json,
               updated_at = NOW()`,
        [
          guildId,
          JSON.stringify({
            enabled: true,
            mode: 'soft',
            log_channel_id: logsMod?.id || null,
            anti_join: { enabled: true, action: 'timeout' },
            anti_mention: { enabled: true, action: 'timeout', block_everyone: true },
            anti_link: { enabled: true, action: 'delete', block_invites: true },
            admin_raid: {
              enabled: false,
              action: 'log',
              max_channels_create_10s: 8,
              max_channels_delete_10s: 5,
              max_webhooks_30s: 5,
            },
          }),
        ]
      )
      .then(() => report.ok.push('AutoMod activé en mode soft (admin-raid laissé OFF pour éviter l’auto-kick).'))
      .catch(() => report.warnings.push('Configuration DB AutoMod échouée.'));

    let statsCategory = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name === '📊・stats-serveur'
    );
    if (!statsCategory) {
      statsCategory = await guild.channels
        .create({ name: '📊・stats-serveur', type: ChannelType.GuildCategory })
        .catch(() => null);
    }
    const membersCount = guild.memberCount || guild.members.cache.size || 0;
    const botsCount = guild.members.cache.filter((m) => m.user?.bot).size;
    const onlineCount = guild.members.cache.filter((m) => m.presence?.status && m.presence.status !== 'offline').size;
    const membersVc = await ensureVoiceChannel(guild, `👤 | Members: ${membersCount}`, statsCategory?.id).catch(() => null);
    const botsVc = await ensureVoiceChannel(guild, `🤖 | Bots: ${botsCount}`, statsCategory?.id).catch(() => null);
    const onlineVc = await ensureVoiceChannel(guild, `🟢 | Online: ${onlineCount}`, statsCategory?.id).catch(() => null);
    if (statsCategory && membersVc && botsVc && onlineVc) {
      await pool
        .query(
          `INSERT INTO server_stats_settings (
             guild_id, category_id, members_channel_id, bots_channel_id, metrics, channels, tracked_role_id, enabled, updated_at
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NULL, TRUE, NOW())
           ON CONFLICT (guild_id) DO UPDATE
             SET category_id = EXCLUDED.category_id,
                 members_channel_id = EXCLUDED.members_channel_id,
                 bots_channel_id = EXCLUDED.bots_channel_id,
                 metrics = EXCLUDED.metrics,
                 channels = EXCLUDED.channels,
                 enabled = TRUE,
                 updated_at = NOW()`,
          [
            guildId,
            statsCategory.id,
            membersVc.id,
            botsVc.id,
            JSON.stringify(['members', 'bots', 'online']),
            JSON.stringify({
              members: membersVc.id,
              bots: botsVc.id,
              online: onlineVc.id,
            }),
          ]
        )
        .then(() => report.ok.push('Server stats de base activées.'))
        .catch(() => report.warnings.push('Configuration DB server stats échouée.'));
    } else {
      report.warnings.push('Server stats partiellement créées (permissions ou salons manquants).');
    }

    await interaction.editReply({
      embeds: [buildBoosterReportEmbed(report)],
      components: [buildActionRow()],
    });
  }

  async function handleSlash(interaction) {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: '❌ Tu dois avoir la permission **Gérer le serveur** pour utiliser cette commande.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const mode = interaction.options.getString('mode') || 'guide';
    if (mode === 'booster') {
      await runBoosterSetup(interaction);
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
