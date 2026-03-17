const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const RED = 0xff0000;

function redEmbed() {
  return new EmbedBuilder().setColor(RED).setTimestamp();
}

function fmtUserTag(userOrId, fallbackTag) {
  if (!userOrId) return fallbackTag || 'Inconnu';
  if (typeof userOrId === 'string') return fallbackTag || userOrId;
  return userOrId.tag || fallbackTag || `${userOrId.username}`;
}

function parseDurationToMs(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (['off', 'remove', 'none', '0', '0s', '0m', '0h', '0d', '0w'].includes(s)) return 0;

  // Support: 10m, 2h, 3d, 1w, 30s; also allow spaces: "10 m"
  const m = s.match(/^\s*(\d+)\s*([smhdw])\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n < 0) return null;

  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60 * 1000
        : unit === 'h'
          ? 60 * 60 * 1000
          : unit === 'd'
            ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
  return n * mult;
}

function formatDuration(ms) {
  if (ms == null) return 'N/A';
  if (ms === 0) return '0';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  return `${w}w`;
}

function safeReason(reason, moderatorTag) {
  const base = (reason || 'Aucune raison fournie').trim();
  const suffix = moderatorTag ? ` | Mod: ${moderatorTag}` : '';
  const out = `${base}${suffix}`;
  return out.length > 512 ? out.slice(0, 509) + '…' : out;
}

function defaultLogEvents() {
  return {
    BAN: true,
    UNBAN: true,
    TIMEOUT: true,
    UNTIMEOUT: true,
    WARN: true,
    PURGE: true,
  };
}

function mergeLogEvents(stored) {
  const d = defaultLogEvents();
  if (!stored || typeof stored !== 'object') return d;
  return { ...d, ...stored };
}

async function ensureCounterRow(pool, guildId) {
  await pool.query(
    `INSERT INTO mod_case_counters (guild_id, last_case) VALUES ($1, 0)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}

async function nextCaseId(pool, guildId) {
  await ensureCounterRow(pool, guildId);
  const res = await pool.query(
    `UPDATE mod_case_counters
     SET last_case = last_case + 1
     WHERE guild_id=$1
     RETURNING last_case`,
    [guildId]
  );
  return Number(res.rows[0]?.last_case || 0);
}

function isTextChannelLike(channel) {
  return channel && channel.isTextBased && channel.isTextBased();
}

function hasRole(member, roleId) {
  if (!member || !roleId) return false;
  return member.roles?.cache?.has(roleId) || false;
}

function hasAnyPermission(interaction, perms) {
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(perms);
}

async function tryDmUser(user, embedOrContent) {
  try {
    if (!user) return false;
    if (typeof embedOrContent === 'string') {
      await user.send({ content: embedOrContent });
    } else {
      await user.send({ embeds: [embedOrContent] });
    }
    return true;
  } catch {
    return false;
  }
}

function createModerationService({ pool, config }) {
  const commands = [
    // /ban
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bannir un membre')
      .addUserOption((opt) =>
        opt.setName('membre').setDescription('Membre à bannir').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('raison')
          .setDescription('Raison du ban')
          .setRequired(true)
          .setMaxLength(300)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('supprimer_messages')
          .setDescription('Supprimer les messages des X derniers jours (0-7)')
          .setMinValue(0)
          .setMaxValue(7)
          .setRequired(false)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('dm')
          .setDescription("Envoyer un MP à la cible avant le ban")
          .setRequired(false)
      ),


    // /unban
    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Débannir un utilisateur (par ID)')
      .addStringOption((opt) =>
        opt
          .setName('user_id')
          .setDescription('ID Discord de la personne bannie')
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('raison')
          .setDescription('Raison du déban')
          .setRequired(false)
          .setMaxLength(300)
      ),

    // /banlist
    new SlashCommandBuilder()
      .setName('banlist')
      .setDescription('Liste des utilisateurs bannis')
      .addIntegerOption((opt) =>
        opt
          .setName('page')
          .setDescription('Page (par défaut: 1)')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('limit')
          .setDescription('Bannis par page (1-25, défaut: 10)')
          .setMinValue(1)
          .setMaxValue(25)
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('recherche')
          .setDescription('Filtrer par tag/nom/ID')
          .setRequired(false)
          .setMaxLength(100)
      ),

    // /timeout
    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout (ou retirer un timeout)')
      .addUserOption((opt) =>
        opt.setName('membre').setDescription('Membre à timeout').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('raison')
          .setDescription('Raison')
          .setRequired(true)
          .setMaxLength(300)
      )
      .addStringOption((opt) =>
        opt
          .setName('duree')
          .setDescription('Durée: 10m, 2h, 3d, 1w (ou 0/off pour retirer)')
          .setRequired(false)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('retirer')
          .setDescription('Retirer le timeout (ignore la durée)')
          .setRequired(false)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('dm')
          .setDescription('Envoyer un MP à la cible')
          .setRequired(false)
      ),

    // /warn
    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Avertissements: add/list/remove/clear')
      .addSubcommand((sc) =>
        sc
          .setName('add')
          .setDescription('Ajoute un warn')
          .addUserOption((opt) =>
            opt.setName('membre').setDescription('Membre à warn').setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('raison')
              .setDescription('Raison')
              .setRequired(true)
              .setMaxLength(300)
          )
          .addBooleanOption((opt) =>
            opt
              .setName('dm')
              .setDescription('Envoyer un MP à la cible')
              .setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('list')
          .setDescription("Liste les warns d'un membre")
          .addUserOption((opt) =>
            opt.setName('membre').setDescription('Membre').setRequired(true)
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Nombre de résultats (max 15)')
              .setMinValue(1)
              .setMaxValue(15)
              .setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('remove')
          .setDescription('Supprime un warn via son Case ID')
          .addIntegerOption((opt) =>
            opt.setName('case_id').setDescription('ID du warn').setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('clear')
          .setDescription("Supprime tous les warns d'un membre")
          .addUserOption((opt) =>
            opt.setName('membre').setDescription('Membre').setRequired(true)
          )
          .addBooleanOption((opt) =>
            opt
              .setName('confirmer')
              .setDescription('Confirmer la suppression')
              .setRequired(true)
          )
      ),

    // /purge
    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Supprime des messages dans le salon courant')
      .addIntegerOption((opt) =>
        opt
          .setName('nombre')
          .setDescription('Nombre de messages à supprimer (1-100)')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true)
      )
      .addUserOption((opt) =>
        opt
          .setName('cible')
          .setDescription("Ne supprimer que les messages de cet utilisateur")
          .setRequired(false)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('inclure_bots')
          .setDescription('Inclure les messages des bots (par défaut: oui)')
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('raison')
          .setDescription('Raison (recommandée)')
          .setRequired(false)
          .setMaxLength(200)
      ),


    // /clear (alias de /purge)
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Alias de /purge : supprime des messages dans le salon courant')
      .addIntegerOption((opt) =>
        opt
          .setName('nombre')
          .setDescription('Nombre de messages à supprimer (1-100)')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true)
      )
      .addUserOption((opt) =>
        opt
          .setName('cible')
          .setDescription("Ne supprimer que les messages de cet utilisateur")
          .setRequired(false)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('inclure_bots')
          .setDescription('Inclure les messages des bots (par défaut: oui)')
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('raison')
          .setDescription('Raison (recommandée)')
          .setRequired(false)
          .setMaxLength(200)
      ),

    // /autorole
    new SlashCommandBuilder()
      .setName('autorole')
      .setDescription('Ouvrir le panneau de configuration des rôles automatiques'),

    // /forcerole
    new SlashCommandBuilder()
      .setName('forcerole')
      .setDescription('Attribuer un rôle à tout le serveur (force all)')
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Rôle à donner à tout le monde').setRequired(true)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('ignorer_bots')
          .setDescription('Ignorer les bots (par défaut: oui)')
          .setRequired(false)
      ),

    // /log
    new SlashCommandBuilder()
      .setName('log')
      .setDescription('Config + historique modération')
      .addSubcommand((sc) =>
        sc
          .setName('set')
          .setDescription('Définir le salon de logs modération')
          .addChannelOption((opt) =>
            opt
              .setName('salon')
              .setDescription('Salon où poster les logs')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc.setName('off').setDescription('Désactiver les logs modération')
      )
      .addSubcommand((sc) =>
        sc.setName('status').setDescription('Voir la configuration actuelle')
      )
      .addSubcommand((sc) =>
        sc
          .setName('staffrole')
          .setDescription('Définir (ou retirer) le rôle staff')
          .addRoleOption((opt) =>
            opt
              .setName('role')
              .setDescription('Rôle staff (vide = désactiver)')
              .setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('events')
          .setDescription('Activer/désactiver des logs par action')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('Action à configurer')
              .setRequired(true)
              .addChoices(
                { name: 'BAN', value: 'BAN' },
                { name: 'UNBAN', value: 'UNBAN' },
                { name: 'TIMEOUT', value: 'TIMEOUT' },
                { name: 'UNTIMEOUT', value: 'UNTIMEOUT' },
                { name: 'WARN', value: 'WARN' },
                { name: 'PURGE', value: 'PURGE' }
              )
          )
          .addBooleanOption((opt) =>
            opt
              .setName('actif')
              .setDescription('Activer (true) ou désactiver (false)')
              .setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('case')
          .setDescription('Voir le détail d’un Case ID')
          .addIntegerOption((opt) =>
            opt.setName('id').setDescription('Case ID').setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('history')
          .setDescription('Historique d’un utilisateur (bans/timeouts/warns/purge)')
          .addUserOption((opt) =>
            opt
              .setName('membre')
              .setDescription('Utilisateur (si présent sur le serveur)')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('user_id')
              .setDescription('ID Discord (si plus sur le serveur)')
              .setRequired(false)
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Nombre de résultats (max 15)')
              .setMinValue(1)
              .setMaxValue(15)
              .setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('recent')
          .setDescription('Dernières actions du serveur')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('Filtrer par action')
              .setRequired(false)
              .addChoices(
                { name: 'TOUT', value: 'ALL' },
                { name: 'BAN', value: 'BAN' },
                { name: 'UNBAN', value: 'UNBAN' },
                { name: 'TIMEOUT', value: 'TIMEOUT' },
                { name: 'UNTIMEOUT', value: 'UNTIMEOUT' },
                { name: 'WARN', value: 'WARN' },
                { name: 'PURGE', value: 'PURGE' }
              )
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Nombre de résultats (max 15)')
              .setMinValue(1)
              .setMaxValue(15)
              .setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc.setName('test').setDescription('Envoie un embed test dans le salon de logs')
      ),
  ];

  async function getSettings(guildId) {
    const res = await pool.query(
      `SELECT guild_id, modlog_channel_id, staff_role_id, log_events
       FROM mod_settings
       WHERE guild_id=$1
       LIMIT 1`,
      [guildId]
    );

    const row = res.rows[0] || null;
    const envFallback = {
      modlog_channel_id: config.MODLOG_CHANNEL_ID || null,
      staff_role_id: config.MOD_STAFF_ROLE_ID || null,
      log_events: defaultLogEvents(),
    };

    if (!row) return envFallback;

    return {
      modlog_channel_id: row.modlog_channel_id || envFallback.modlog_channel_id,
      staff_role_id: row.staff_role_id || envFallback.staff_role_id,
      log_events: mergeLogEvents(row.log_events || envFallback.log_events),
    };
  }

  async function saveSettings(guildId, patch) {
    const current = await getSettings(guildId);
    const next = {
      modlog_channel_id:
        patch.modlog_channel_id !== undefined
          ? patch.modlog_channel_id
          : current.modlog_channel_id,
      staff_role_id:
        patch.staff_role_id !== undefined ? patch.staff_role_id : current.staff_role_id,
      log_events:
        patch.log_events !== undefined ? patch.log_events : current.log_events,
    };

    await pool.query(
      `INSERT INTO mod_settings (guild_id, modlog_channel_id, staff_role_id, log_events)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (guild_id) DO UPDATE
         SET modlog_channel_id=EXCLUDED.modlog_channel_id,
             staff_role_id=EXCLUDED.staff_role_id,
             log_events=EXCLUDED.log_events,
             updated_at=NOW()`,
      [guildId, next.modlog_channel_id, next.staff_role_id, JSON.stringify(next.log_events)]
    );



    return next;
  }

  async function getAutoroleSettings(guildId) {
    const res = await pool.query(
      `SELECT role_id, role_ids FROM autorole_settings WHERE guild_id=$1 LIMIT 1`,
      [guildId]
    );

    const row = res.rows[0] || null;
    if (!row) {
      return { role_ids: [] };
    }

    const fromJson = Array.isArray(row.role_ids)
      ? row.role_ids.filter((r) => typeof r === 'string' && r)
      : [];

    if (fromJson.length) {
      return { role_ids: [...new Set(fromJson)] };
    }

    if (row.role_id) {
      return { role_ids: [row.role_id] };
    }

    return { role_ids: [] };
  }

  async function saveAutoroleSettings(guildId, roleIds) {
    const cleaned = [...new Set((roleIds || []).filter((r) => typeof r === 'string' && r))].slice(0, 25);
    await pool.query(
      `INSERT INTO autorole_settings (guild_id, role_id, role_ids)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (guild_id) DO UPDATE
         SET role_id=EXCLUDED.role_id,
             role_ids=EXCLUDED.role_ids,
             updated_at=NOW()`,
      [guildId, cleaned[0] || null, JSON.stringify(cleaned)]
    );

    return { role_ids: cleaned };
  }

  function sanitizeAutoroleRoleIds(guild, roleIds) {
    const uniq = [...new Set((roleIds || []).filter((r) => typeof r === 'string' && r))];
    return uniq.filter((roleId) => {
      const role = guild.roles.cache.get(roleId);
      return !!role && !role.managed;
    });
  }

  function buildAutorolePanel(guild, roleIds) {
    const rolesText = roleIds.length
      ? roleIds.map((id) => `<@&${id}>`).join('\n')
      : 'Aucun rôle configuré.';

    const embed = redEmbed()
      .setTitle('⚙️ Configuration Auto-rôles')
      .setDescription('Choisis un ou plusieurs rôles à attribuer automatiquement aux nouveaux membres.')
      .addFields({ name: 'Rôles par défaut', value: rolesText, inline: false });

    const addRow = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('autorole:add')
        .setPlaceholder('Ajouter un ou plusieurs rôles')
        .setMinValues(1)
        .setMaxValues(25)
    );

    const removeMenu = new StringSelectMenuBuilder()
      .setCustomId('autorole:remove')
      .setPlaceholder(roleIds.length ? 'Retirer un ou plusieurs rôles' : 'Aucun rôle à retirer')
      .setMinValues(1)
      .setMaxValues(Math.max(1, Math.min(roleIds.length, 25)))
      .setDisabled(roleIds.length === 0);

    if (roleIds.length) {
      removeMenu.addOptions(
        roleIds.slice(0, 25).map((roleId) => ({
          label: guild.roles.cache.get(roleId)?.name?.slice(0, 100) || roleId,
          value: roleId,
        }))
      );
    } else {
      removeMenu.addOptions({ label: 'Aucun rôle', value: 'none' });
    }

    const removeRow = new ActionRowBuilder().addComponents(removeMenu);
    const resetRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('autorole:clear')
        .setLabel('Réinitialiser')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(roleIds.length === 0)
    );

    return {
      embeds: [embed],
      components: [addRow, removeRow, resetRow],
    };
  }

  async function sendModLog(guild, settings, embed) {
    if (!settings?.modlog_channel_id) return null;
    if (!embed) return null;
    if (!settings.log_events) settings.log_events = defaultLogEvents();

    const ch = await guild.channels.fetch(settings.modlog_channel_id).catch(() => null);
    if (!ch || !isTextChannelLike(ch)) return null;

    const msg = await ch.send({ embeds: [embed] }).catch(() => null);
    return msg;
  }

  async function insertCase({
    guildId,
    action,
    targetId,
    targetTag,
    moderatorId,
    moderatorTag,
    reason,
    durationMs,
    metadata,
    logChannelId,
    logMessageId,
  }) {
    const caseId = await nextCaseId(pool, guildId);

    await pool.query(
      `INSERT INTO mod_cases (
         guild_id, case_id, action,
         target_id, target_tag,
         moderator_id, moderator_tag,
         reason, duration_ms,
         metadata,
         log_channel_id, log_message_id,
         created_at
       ) VALUES (
         $1,$2,$3,
         $4,$5,
         $6,$7,
         $8,$9,
         $10::jsonb,
         $11,$12,
         NOW()
       )`,
      [
        guildId,
        caseId,
        action,
        targetId || null,
        targetTag || null,
        moderatorId || null,
        moderatorTag || null,
        reason || null,
        durationMs ?? null,
        JSON.stringify(metadata || {}),
        logChannelId || null,
        logMessageId || null,
      ]
    );

    return caseId;
  }

  async function fetchCase(guildId, caseId) {
    const res = await pool.query(
      `SELECT * FROM mod_cases WHERE guild_id=$1 AND case_id=$2 LIMIT 1`,
      [guildId, caseId]
    );
    return res.rows[0] || null;
  }

  async function listCasesForUser(guildId, userId, limit) {
    const res = await pool.query(
      `SELECT case_id, action, reason, duration_ms, created_at
       FROM mod_cases
       WHERE guild_id=$1 AND target_id=$2
       ORDER BY created_at DESC
       LIMIT $3`,
      [guildId, userId, limit]
    );
    return res.rows;
  }

  async function listRecentCases(guildId, actionOrAll, limit) {
    if (actionOrAll && actionOrAll !== 'ALL') {
      const res = await pool.query(
        `SELECT case_id, action, target_id, reason, duration_ms, created_at
         FROM mod_cases
         WHERE guild_id=$1 AND action=$2
         ORDER BY created_at DESC
         LIMIT $3`,
        [guildId, actionOrAll, limit]
      );
      return res.rows;
    }

    const res = await pool.query(
      `SELECT case_id, action, target_id, reason, duration_ms, created_at
       FROM mod_cases
       WHERE guild_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [guildId, limit]
    );
    return res.rows;
  }

  function canUseStaffBypass(interaction, staffRoleId) {
    const member = interaction.member;
    if (!member || !staffRoleId) return false;
    return hasRole(member, staffRoleId);
  }

  function mustHave(interaction, permFlag, staffRoleId) {
    // Staff role can bypass for non-critical actions (timeout/warn/purge/log history)
    if (hasAnyPermission(interaction, permFlag)) return true;
    if (permFlag === PermissionsBitField.Flags.BanMembers) return false;
    return canUseStaffBypass(interaction, staffRoleId);
  }

  function isAdmin(interaction) {
    return hasAnyPermission(interaction, PermissionsBitField.Flags.Administrator);
  }

  async function handleBan(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (!hasAnyPermission(interaction, PermissionsBitField.Flags.BanMembers) && !isAdmin(interaction)) {
      await interaction.reply({
        content: "⛔ Il faut la permission **Bannir des membres** pour faire ça.",
        ephemeral: true,
      });
      return true;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const targetUser = interaction.options.getUser('membre', true);
    const reason = interaction.options.getString('raison', true);
    const deleteDays = interaction.options.getInteger('supprimer_messages') ?? 0;
    const doDm = interaction.options.getBoolean('dm') ?? false;

    if (targetUser.id === interaction.user.id) {
      await interaction.reply({ content: "⚠️ Tu ne peux pas te bannir toi-même.", ephemeral: true });
      return true;
    }

    const me = await guild.members.fetchMe().catch(() => null);
    const modMember = await guild.members.fetch(interaction.user.id).catch(() => null);
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) {
      await interaction.reply({ content: "⚠️ Membre introuvable.", ephemeral: true });
      return true;
    }

    if (me && !targetMember.bannable) {
      await interaction.reply({
        content:
          "⚠️ Je ne peux pas bannir ce membre (hiérarchie/permissions). Mets le rôle du bot au-dessus.",
        ephemeral: true,
      });
      return true;
    }

    if (!isAdmin(interaction) && modMember) {
      if (modMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
        await interaction.reply({
          content: "⚠️ Tu ne peux pas bannir quelqu’un au-dessus (ou égal) à ton rôle.",
          ephemeral: true,
        });
        return true;
      }
    }

    const moderatorTag = fmtUserTag(interaction.user, interaction.user.tag);
    const banReason = safeReason(reason, moderatorTag);

    if (doDm) {
      const dmEmbed = redEmbed()
        .setTitle('🛡️ Vous avez été banni')
        .setDescription(`Serveur: **${guild.name}**`)
        .addFields(
          { name: 'Raison', value: reason },
          { name: 'Modérateur', value: moderatorTag, inline: true }
        );
      await tryDmUser(targetUser, dmEmbed);
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const deleteMessageSeconds = Math.max(0, Math.min(7, deleteDays)) * 24 * 60 * 60;
      await guild.members.ban(targetUser.id, {
        deleteMessageSeconds,
        reason: banReason,
      });

      const logEmbed = redEmbed()
        .setTitle('🛡️ MOD — BAN')
        .addFields(
          { name: 'Cible', value: `<@${targetUser.id}> (${targetUser.id})`, inline: false },
          { name: 'Modérateur', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Suppression messages', value: `${deleteDays}j`, inline: true },
          { name: 'Raison', value: reason, inline: false }
        );

      let logMsg = null;
      if (settings.log_events?.BAN) {
        logMsg = await sendModLog(guild, settings, logEmbed);
      }

      const caseId = await insertCase({
        guildId: interaction.guildId,
        action: 'BAN',
        targetId: targetUser.id,
        targetTag: targetUser.tag || null,
        moderatorId: interaction.user.id,
        moderatorTag,
        reason,
        durationMs: null,
        metadata: { delete_days: deleteDays, dm: doDm },
        logChannelId: logMsg ? logMsg.channelId : (settings.modlog_channel_id || null),
        logMessageId: logMsg ? logMsg.id : null,
      });

      if (logMsg) {
        const updated = EmbedBuilder.from(logEmbed).addFields({
          name: 'Case ID',
          value: `#${caseId}`,
          inline: true,
        });
        await logMsg.edit({ embeds: [updated] }).catch(() => {});
      }

      await interaction.editReply(`✅ Ban effectué. Case **#${caseId}** enregistré.`);
      return true;
    } catch (e) {
      console.error('ban error:', e);
      await interaction.editReply('⚠️ Impossible de bannir (permissions/hiérarchie/erreur API).');
      return true;
    }
  }


  async function handleUnban(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (
      !hasAnyPermission(interaction, PermissionsBitField.Flags.BanMembers) &&
      !isAdmin(interaction)
    ) {
      await interaction.reply({
        content: '⛔ Il faut la permission **Bannir des membres** pour faire ça.',
        ephemeral: true,
      });
      return true;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const rawId = (interaction.options.getString('user_id', true) || '').trim();
    const userId = rawId.replace(/[<@!>]/g, '').trim();

    if (!/^\d{15,21}$/.test(userId)) {
      await interaction.reply({
        content: '⚠️ ID invalide. (Active le mode dev → copier l’ID)',
        ephemeral: true,
      });
      return true;
    }

    const reason = interaction.options.getString('raison') || 'Déban';
    const moderatorTag = fmtUserTag(interaction.user, interaction.user.tag);
    const apiReason = safeReason(reason, moderatorTag);

    await interaction.deferReply({ ephemeral: true });

    const ban = await guild.bans.fetch(userId).catch(() => null);
    if (!ban) {
      await interaction.editReply("⚠️ Cet utilisateur n’est pas banni (ou ID introuvable).");
      return true;
    }

    const unbannedUser = await guild.members.unban(userId, apiReason).catch(() => null);
    if (!unbannedUser) {
      await interaction.editReply('⚠️ Impossible de débannir (permissions/erreur API).');
      return true;
    }

    const logEmbed = redEmbed()
      .setTitle('✅ MOD — UNBAN')
      .addFields(
        {
          name: 'Cible',
          value: `${fmtUserTag(ban.user, ban.user?.tag)} (${userId})`,
          inline: false,
        },
        { name: 'Modérateur', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Raison', value: reason, inline: false }
      );

    let logMsg = null;
    if (settings.log_events?.UNBAN) {
      logMsg = await sendModLog(guild, settings, logEmbed);
    }

    const caseId = await insertCase({
      guildId: interaction.guildId,
      action: 'UNBAN',
      targetId: userId,
      targetTag: ban.user?.tag || null,
      moderatorId: interaction.user.id,
      moderatorTag,
      reason,
      durationMs: null,
      metadata: {},
      logChannelId: logMsg ? logMsg.channelId : settings.modlog_channel_id || null,
      logMessageId: logMsg ? logMsg.id : null,
    });

    if (logMsg) {
      const updated = EmbedBuilder.from(logEmbed).addFields({
        name: 'Case ID',
        value: `#${caseId}`,
        inline: true,
      });
      await logMsg.edit({ embeds: [updated] }).catch(() => {});
    }

    await interaction.editReply(`✅ Déban effectué. Case **#${caseId}**.`);
    return true;
  }

  async function handleBanlist(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (
      !hasAnyPermission(interaction, PermissionsBitField.Flags.BanMembers) &&
      !isAdmin(interaction)
    ) {
      await interaction.reply({
        content: '⛔ Il faut la permission **Bannir des membres** pour faire ça.',
        ephemeral: true,
      });
      return true;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const pageRaw = interaction.options.getInteger('page') ?? 1;
    const limitRaw = interaction.options.getInteger('limit') ?? 10;
    const search = (interaction.options.getString('recherche') || '').trim().toLowerCase();

    const limit = Math.max(1, Math.min(25, limitRaw));
    let page = Math.max(1, pageRaw);

    await interaction.deferReply({ ephemeral: true });

    const bans = await guild.bans.fetch().catch(() => null);
    if (!bans) {
      await interaction.editReply('⚠️ Impossible de récupérer la liste des bannis.');
      return true;
    }

    let items = Array.from(bans.values());
    if (search) {
      items = items.filter((b) => {
        const tag = (b.user?.tag || '').toLowerCase();
        const username = (b.user?.username || '').toLowerCase();
        const id = (b.user?.id || '').toLowerCase();
        return tag.includes(search) || username.includes(search) || id.includes(search);
      });
    }

    const total = items.length;
    if (!total) {
      await interaction.editReply(search ? 'Aucun banni ne correspond à ta recherche.' : 'Aucun utilisateur banni.');
      return true;
    }

    const pages = Math.max(1, Math.ceil(total / limit));
    if (page > pages) page = pages;

    const start = (page - 1) * limit;
    const slice = items.slice(start, start + limit);

    const lines = slice.map((b, i) => {
      const u = b.user;
      const tag = fmtUserTag(u, u?.tag);
      const id = u?.id || '—';
      const r = (b.reason || '—').toString().replace(/\s+/g, ' ').trim();
      const shortReason = r.length > 80 ? r.slice(0, 77) + '…' : r;
      return `**${start + i + 1}.** ${tag} (\`${id}\`) — ${shortReason}`;
    });

    let desc = lines.join('\n');
    if (desc.length > 4090) desc = desc.slice(0, 4087) + '…';

    const embed = redEmbed()
      .setTitle(`⛔ Ban list — ${total} banni(s)${search ? ` (filtre: ${search})` : ''}`)
      .setDescription(desc)
      .setFooter({ text: `Page ${page}/${pages} • ${limit}/page` });

    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  async function handleMessage(message, client) {
    try {
      if (!message || message.author?.bot) return false;
      if (!message.guild || !message.member) return false;

      const content = String(message.content || '');
      if (!content.startsWith('.') && !content.startsWith('+')) return false;

      if (content.startsWith('+')) {
        const plusParts = content.slice(1).trim().split(/\s+/);
        const plusCmd = (plusParts.shift() || '').toLowerCase();

        if (plusCmd === 'warn') {
          const settings = await getSettings(message.guild.id);
          const canWarn =
            message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) ||
            message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
            hasRole(message.member, settings.staff_role_id);

          if (!canWarn) {
            await message.reply('⛔ Il faut la permission **Modérer des membres** (ou être staff) pour faire ça.');
            return true;
          }

          const targetUser = message.mentions.users.first();
          if (!targetUser) {
            await message.reply('⚠️ Utilisation: `+warn @membre [raison]`');
            return true;
          }

          if (targetUser.id === message.author.id) {
            await message.reply('⚠️ Tu ne peux pas te warn toi-même.');
            return true;
          }

          const reason = plusParts
            .filter((p) => !/^<@!?\d+>$/.test(p))
            .join(' ')
            .trim() || 'Aucune raison fournie';
          const moderatorTag = fmtUserTag(message.author, message.author.tag);

          try {
            const caseId = await insertCase({
              guildId: message.guild.id,
              action: 'WARN',
              targetId: targetUser.id,
              targetTag: targetUser.tag || null,
              moderatorId: message.author.id,
              moderatorTag,
              reason,
              durationMs: null,
              metadata: { source: 'prefix:+warn' },
              logChannelId: settings.modlog_channel_id || null,
              logMessageId: null,
            });

            const warnEmbed = redEmbed()
              .setTitle('⚠️ Warn ajouté')
              .setDescription(`Un avertissement a été ajouté à <@${targetUser.id}>.`)
              .addFields(
                { name: 'Membre', value: `<@${targetUser.id}> (${targetUser.id})`, inline: false },
                { name: 'Modérateur', value: `<@${message.author.id}>`, inline: true },
                { name: 'Case ID', value: `#${caseId}`, inline: true },
                { name: 'Raison', value: reason, inline: false }
              );

            await message.reply({ embeds: [warnEmbed] });
            return true;
          } catch (e) {
            console.error('prefix +warn error:', e);
            await message.reply('⚠️ Warn non enregistré (erreur DB).');
            return true;
          }
        }

        if (plusCmd === 'ban') {
          const canBan =
            message.member.permissions.has(PermissionsBitField.Flags.BanMembers) ||
            message.member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!canBan) {
            await message.reply('⛔ Il faut la permission **Bannir des membres** pour faire ça.');
            return true;
          }

          const targetUser = message.mentions.users.first();
          if (!targetUser) {
            await message.reply('⚠️ Utilisation: `+ban @membre [raison]`');
            return true;
          }

          if (targetUser.id === message.author.id) {
            await message.reply('⚠️ Tu ne peux pas te bannir toi-même.');
            return true;
          }

          const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
          if (!targetMember) {
            await message.reply('⚠️ Membre introuvable.');
            return true;
          }

          const me = await message.guild.members.fetchMe().catch(() => null);
          if (me && !targetMember.bannable) {
            await message.reply('⚠️ Je ne peux pas bannir ce membre (hiérarchie/permissions).');
            return true;
          }

          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if (message.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
              await message.reply('⚠️ Tu ne peux pas bannir quelqu’un au-dessus (ou égal) à ton rôle.');
              return true;
            }
          }

          const reason = plusParts
            .filter((p) => !/^<@!?\d+>$/.test(p))
            .join(' ')
            .trim() || 'Aucune raison fournie';
          const moderatorTag = fmtUserTag(message.author, message.author.tag);
          const banReason = safeReason(reason, moderatorTag);

          try {
            await message.guild.members.ban(targetUser.id, {
              deleteMessageSeconds: 0,
              reason: banReason,
            });

            const caseId = await insertCase({
              guildId: message.guild.id,
              action: 'BAN',
              targetId: targetUser.id,
              targetTag: targetUser.tag || null,
              moderatorId: message.author.id,
              moderatorTag,
              reason,
              durationMs: null,
              metadata: { delete_days: 0, source: 'prefix:+ban' },
              logChannelId: null,
              logMessageId: null,
            });

            await message.reply(`✅ Ban effectué sur <@${targetUser.id}>. Case **#${caseId}**.`);
            return true;
          } catch (e) {
            console.error('prefix +ban error:', e);
            await message.reply('⚠️ Impossible de bannir (permissions/hiérarchie/erreur API).');
            return true;
          }
        }

        return false;
      }

      const parts = content.slice(1).trim().split(/\s+/);
      const cmd = (parts.shift() || '').toLowerCase();

      if (cmd !== 'banlist' && cmd !== 'bl') return false;

      // Permission: ban
      const can =
        message.member.permissions.has(PermissionsBitField.Flags.BanMembers) ||
        message.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!can) {
        await message.reply('⛔ Il faut la permission **Bannir des membres** pour faire ça.');
        return true;
      }

      let page = 1;
      if (parts[0] && /^\d+$/.test(parts[0])) page = Math.max(1, Number(parts.shift()));

      const search = parts.join(' ').trim().toLowerCase();

      const bans = await message.guild.bans.fetch().catch(() => null);
      if (!bans) {
        await message.reply('⚠️ Impossible de récupérer la liste des bannis.');
        return true;
      }

      let items = Array.from(bans.values());
      if (search) {
        items = items.filter((b) => {
          const tag = (b.user?.tag || '').toLowerCase();
          const username = (b.user?.username || '').toLowerCase();
          const id = (b.user?.id || '').toLowerCase();
          return tag.includes(search) || username.includes(search) || id.includes(search);
        });
      }

      const total = items.length;
      if (!total) {
        await message.reply(search ? 'Aucun banni ne correspond à ta recherche.' : 'Aucun utilisateur banni.');
        return true;
      }

      const limit = 10;
      const pages = Math.max(1, Math.ceil(total / limit));
      if (page > pages) page = pages;

      const start = (page - 1) * limit;
      const slice = items.slice(start, start + limit);

      const lines = slice.map((b, i) => {
        const u = b.user;
        const tag = fmtUserTag(u, u?.tag);
        const id = u?.id || '—';
        const r = (b.reason || '—').toString().replace(/\s+/g, ' ').trim();
        const shortReason = r.length > 80 ? r.slice(0, 77) + '…' : r;
        return `**${start + i + 1}.** ${tag} (\`${id}\`) — ${shortReason}`;
      });

      let desc = lines.join('\n');
      if (desc.length > 4090) desc = desc.slice(0, 4087) + '…';

      const embed = redEmbed()
        .setTitle(`⛔ Ban list — ${total} banni(s)${search ? ` (filtre: ${search})` : ''}`)
        .setDescription(desc)
        .setFooter({ text: `Page ${page}/${pages} • .banlist [page] [recherche]` });

      await message.reply({ embeds: [embed] });
      return true;
    } catch (e) {
      console.error('banlist prefix handler fatal:', e);
      return true;
    }
  }


  async function handleTimeout(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (
      !mustHave(interaction, PermissionsBitField.Flags.ModerateMembers, settings.staff_role_id) &&
      !isAdmin(interaction)
    ) {
      await interaction.reply({
        content:
          "⛔ Il faut la permission **Modérer des membres** (ou être staff) pour faire ça.",
        ephemeral: true,
      });
      return true;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const targetUser = interaction.options.getUser('membre', true);
    const remove = interaction.options.getBoolean('retirer') ?? false;
    const durationStr = interaction.options.getString('duree');
    const reason = interaction.options.getString('raison', true);
    const doDm = interaction.options.getBoolean('dm') ?? false;

    if (targetUser.id === interaction.user.id) {
      await interaction.reply({ content: "⚠️ Tu ne peux pas te timeout toi-même.", ephemeral: true });
      return true;
    }

    const guildMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!guildMember) {
      await interaction.reply({ content: '⚠️ Membre introuvable.', ephemeral: true });
      return true;
    }

    const me = await guild.members.fetchMe().catch(() => null);
    const modMember = await guild.members.fetch(interaction.user.id).catch(() => null);

    if (me && !guildMember.moderatable) {
      await interaction.reply({
        content:
          "⚠️ Je ne peux pas timeout ce membre (hiérarchie/permissions). Mets le rôle du bot au-dessus.",
        ephemeral: true,
      });
      return true;
    }

    if (!isAdmin(interaction) && modMember) {
      if (modMember.roles.highest.comparePositionTo(guildMember.roles.highest) <= 0) {
        await interaction.reply({
          content: "⚠️ Tu ne peux pas timeout quelqu’un au-dessus (ou égal) à ton rôle.",
          ephemeral: true,
        });
        return true;
      }
    }

    let durationMs = 0;
    if (remove) {
      durationMs = 0;
    } else {
      durationMs = parseDurationToMs(durationStr);
      if (durationMs == null) {
        await interaction.reply({
          content:
            '⚠️ Durée invalide. Exemple: **10m**, **2h**, **3d**, **1w** (ou **0/off** pour retirer).',
          ephemeral: true,
        });
        return true;
      }
    }

    const moderatorTag = fmtUserTag(interaction.user, interaction.user.tag);
    const apiReason = safeReason(reason, moderatorTag);

    if (doDm) {
      const dmEmbed = redEmbed()
        .setTitle(durationMs > 0 ? '⏳ Vous avez été timeout' : '✅ Timeout retiré')
        .setDescription(`Serveur: **${guild.name}**`)
        .addFields(
          durationMs > 0
            ? { name: 'Durée', value: formatDuration(durationMs), inline: true }
            : { name: 'Durée', value: 'Retiré', inline: true },
          { name: 'Raison', value: reason },
          { name: 'Modérateur', value: moderatorTag, inline: true }
        );
      await tryDmUser(targetUser, dmEmbed);
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await guildMember.timeout(durationMs > 0 ? durationMs : null, apiReason);

      const action = durationMs > 0 ? 'TIMEOUT' : 'UNTIMEOUT';

      const logEmbed = redEmbed()
        .setTitle(`⏳ MOD — ${action}`)
        .addFields(
          { name: 'Cible', value: `<@${targetUser.id}> (${targetUser.id})`, inline: false },
          { name: 'Modérateur', value: `<@${interaction.user.id}>`, inline: true },
          {
            name: 'Durée',
            value: durationMs > 0 ? formatDuration(durationMs) : 'Retiré',
            inline: true,
          },
          { name: 'Raison', value: reason, inline: false }
        );

      let logMsg = null;
      if (settings.log_events?.[action]) {
        logMsg = await sendModLog(guild, settings, logEmbed);
      }

      const caseId = await insertCase({
        guildId: interaction.guildId,
        action,
        targetId: targetUser.id,
        targetTag: targetUser.tag || null,
        moderatorId: interaction.user.id,
        moderatorTag,
        reason,
        durationMs: durationMs > 0 ? durationMs : null,
        metadata: { dm: doDm },
        logChannelId: logMsg ? logMsg.channelId : (settings.modlog_channel_id || null),
        logMessageId: logMsg ? logMsg.id : null,
      });

      if (logMsg) {
        const updated = EmbedBuilder.from(logEmbed).addFields({
          name: 'Case ID',
          value: `#${caseId}`,
          inline: true,
        });
        await logMsg.edit({ embeds: [updated] }).catch(() => {});
      }

      await interaction.editReply(
        `✅ ${action === 'TIMEOUT' ? 'Timeout appliqué' : 'Timeout retiré'} — Case **#${caseId}**.`
      );
      return true;
    } catch (e) {
      console.error('timeout error:', e);
      await interaction.editReply('⚠️ Impossible de timeout (permissions/hiérarchie/erreur API).');
      return true;
    }
  }

  async function handleWarn(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (
      !mustHave(interaction, PermissionsBitField.Flags.ModerateMembers, settings.staff_role_id) &&
      !isAdmin(interaction)
    ) {
      await interaction.reply({
        content:
          "⛔ Il faut la permission **Modérer des membres** (ou être staff) pour faire ça.",
        ephemeral: true,
      });
      return true;
    }

    const sub = interaction.options.getSubcommand(true);
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    // /warn add
    if (sub === 'add') {
      const targetUser = interaction.options.getUser('membre', true);
      const reason = interaction.options.getString('raison', true);
      const doDm = interaction.options.getBoolean('dm') ?? false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({ content: "⚠️ Tu ne peux pas te warn toi-même.", ephemeral: true });
        return true;
      }

      const moderatorTag = fmtUserTag(interaction.user, interaction.user.tag);

      if (doDm) {
        const dmEmbed = redEmbed()
          .setTitle('⚠️ Vous avez reçu un avertissement')
          .setDescription(`Serveur: **${guild.name}**`)
          .addFields(
            { name: 'Raison', value: reason },
            { name: 'Modérateur', value: moderatorTag, inline: true }
          );
        await tryDmUser(targetUser, dmEmbed);
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const logEmbed = redEmbed()
          .setTitle('⚠️ MOD — WARN')
          .addFields(
            { name: 'Cible', value: `<@${targetUser.id}> (${targetUser.id})`, inline: false },
            { name: 'Modérateur', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Raison', value: reason, inline: false }
          );

        let logMsg = null;
        if (settings.log_events?.WARN) {
          logMsg = await sendModLog(guild, settings, logEmbed);
        }

        const caseId = await insertCase({
          guildId: interaction.guildId,
          action: 'WARN',
          targetId: targetUser.id,
          targetTag: targetUser.tag || null,
          moderatorId: interaction.user.id,
          moderatorTag,
          reason,
          durationMs: null,
          metadata: { dm: doDm },
          logChannelId: logMsg ? logMsg.channelId : (settings.modlog_channel_id || null),
          logMessageId: logMsg ? logMsg.id : null,
        });

        if (logMsg) {
          const updated = EmbedBuilder.from(logEmbed).addFields({
            name: 'Case ID',
            value: `#${caseId}`,
            inline: true,
          });
          await logMsg.edit({ embeds: [updated] }).catch(() => {});
        }

        await interaction.editReply(`✅ Warn ajouté. Case **#${caseId}**.`);
        return true;
      } catch (e) {
        console.error('warn add error:', e);
        await interaction.editReply('⚠️ Warn non enregistré (erreur DB).');
        return true;
      }
    }

    // /warn list
    if (sub === 'list') {
      const targetUser = interaction.options.getUser('membre', true);
      const limit = interaction.options.getInteger('limit') ?? 10;

      await interaction.deferReply({ ephemeral: true });

      const res = await pool.query(
        `SELECT case_id, reason, created_at
         FROM mod_cases
         WHERE guild_id=$1 AND action='WARN' AND target_id=$2
         ORDER BY created_at DESC
         LIMIT $3`,
        [interaction.guildId, targetUser.id, limit]
      );

      if (!res.rows.length) {
        await interaction.editReply(`Aucun warn trouvé pour <@${targetUser.id}>.`);
        return true;
      }

      const desc = res.rows
        .map((r) => `• **#${r.case_id}** — ${r.reason} _( ${new Date(r.created_at).toLocaleString('fr-FR')} )_`)
        .join('\n');

      const embed = redEmbed()
        .setTitle(`⚠️ Warns — ${targetUser.tag || targetUser.username}`)
        .setDescription(desc);

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    // /warn remove
    if (sub === 'remove') {
      const caseId = interaction.options.getInteger('case_id', true);

      await interaction.deferReply({ ephemeral: true });

      const found = await pool.query(
        `SELECT target_id, reason FROM mod_cases WHERE guild_id=$1 AND case_id=$2 AND action='WARN' LIMIT 1`,
        [interaction.guildId, caseId]
      );

      if (!found.rows.length) {
        await interaction.editReply("⚠️ Warn introuvable (Case ID invalide ?)." );
        return true;
      }

      await pool.query(
        `DELETE FROM mod_cases WHERE guild_id=$1 AND case_id=$2 AND action='WARN'`,
        [interaction.guildId, caseId]
      );

      await interaction.editReply(`✅ Warn **#${caseId}** supprimé.`);
      return true;
    }

    // /warn clear
    if (sub === 'clear') {
      const targetUser = interaction.options.getUser('membre', true);
      const confirm = interaction.options.getBoolean('confirmer', true);
      if (!confirm) {
        await interaction.reply({ content: '⚠️ Mets **confirmer: true** pour valider.', ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const del = await pool.query(
        `DELETE FROM mod_cases WHERE guild_id=$1 AND action='WARN' AND target_id=$2`,
        [interaction.guildId, targetUser.id]
      );

      await interaction.editReply(`✅ Warns supprimés pour <@${targetUser.id}>.`);
      return true;
    }

    return true;
  }

  async function handlePurge(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (
      !mustHave(interaction, PermissionsBitField.Flags.ManageMessages, settings.staff_role_id) &&
      !isAdmin(interaction)
    ) {
      await interaction.reply({
        content:
          "⛔ Il faut la permission **Gérer les messages** (ou être staff) pour faire ça.",
        ephemeral: true,
      });
      return true;
    }

    const channel = interaction.channel;
    if (!isTextChannelLike(channel)) {
      await interaction.reply({ content: '⚠️ Salon invalide.', ephemeral: true });
      return true;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const amount = interaction.options.getInteger('nombre', true);
    const target = interaction.options.getUser('cible');
    const includeBots = interaction.options.getBoolean('inclure_bots');
    const reason = interaction.options.getString('raison') || 'Purge';

    await interaction.deferReply({ ephemeral: true });

    try {
      const fetched = await channel.messages.fetch({ limit: 100 });

      let toDelete = fetched;

      if (target) {
        toDelete = toDelete.filter((m) => m.author?.id === target.id);
      }

      // By default include bots = true (as per option description). If user sets false, exclude bots.
      if (includeBots === false) {
        toDelete = toDelete.filter((m) => !m.author?.bot);
      }

      // Limit to requested amount (newest first)
      const arr = [...toDelete.values()].slice(0, amount);
      if (!arr.length) {
        await interaction.editReply('⚠️ Aucun message correspondant à supprimer.');
        return true;
      }

      const deleted = await channel.bulkDelete(arr, true);
      const deletedCount = deleted?.size ?? 0;

      const logEmbed = redEmbed()
        .setTitle('🧹 MOD — PURGE')
        .addFields(
          { name: 'Salon', value: `<#${channel.id}>`, inline: true },
          { name: 'Modérateur', value: `<@${interaction.user.id}>`, inline: true },
          {
            name: 'Filtre',
            value: `${target ? `cible=<@${target.id}> ` : ''}${includeBots === false ? 'sans bots' : 'avec bots'}`.trim() || 'Aucun',
            inline: false,
          },
          { name: 'Demandé', value: `${amount}`, inline: true },
          { name: 'Supprimés', value: `${deletedCount}`, inline: true },
          { name: 'Raison', value: reason, inline: false }
        );

      let logMsg = null;
      if (settings.log_events?.PURGE) {
        logMsg = await sendModLog(guild, settings, logEmbed);
      }

      const moderatorTag = fmtUserTag(interaction.user, interaction.user.tag);

      const caseId = await insertCase({
        guildId: interaction.guildId,
        action: 'PURGE',
        targetId: target?.id || null,
        targetTag: target?.tag || null,
        moderatorId: interaction.user.id,
        moderatorTag,
        reason,
        durationMs: null,
        metadata: {
          channel_id: channel.id,
          requested: amount,
          deleted: deletedCount,
          include_bots: includeBots !== false,
        },
        logChannelId: logMsg ? logMsg.channelId : (settings.modlog_channel_id || null),
        logMessageId: logMsg ? logMsg.id : null,
      });

      if (logMsg) {
        const updated = EmbedBuilder.from(logEmbed).addFields({
          name: 'Case ID',
          value: `#${caseId}`,
          inline: true,
        });
        await logMsg.edit({ embeds: [updated] }).catch(() => {});
      }

      await interaction.editReply(`✅ Purge terminée. ${deletedCount} message(s) supprimé(s). Case **#${caseId}**.`);
      return true;
    } catch (e) {
      console.error('purge error:', e);
      await interaction.editReply('⚠️ Impossible de purge (permissions/erreur API).');
      return true;
    }
  }

  async function handleLog(interaction, client) {
    const sub = interaction.options.getSubcommand(true);
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const settings = await getSettings(interaction.guildId);

    const canManageConfig =
      hasAnyPermission(interaction, PermissionsBitField.Flags.ManageGuild) || isAdmin(interaction);

    const canViewHistory =
      mustHave(interaction, PermissionsBitField.Flags.ModerateMembers, settings.staff_role_id) ||
      isAdmin(interaction);

    if (['set', 'off', 'events', 'staffrole'].includes(sub) && !canManageConfig) {
      await interaction.reply({
        content: "⛔ Il faut la permission **Gérer le serveur** pour configurer les logs.",
        ephemeral: true,
      });
      return true;
    }

    if (['case', 'history', 'recent'].includes(sub) && !canViewHistory) {
      await interaction.reply({
        content: "⛔ Il faut la permission **Modérer des membres** (ou être staff) pour voir l’historique.",
        ephemeral: true,
      });
      return true;
    }

    // /log set
    if (sub === 'set') {
      const ch = interaction.options.getChannel('salon', true);
      const next = await saveSettings(interaction.guildId, {
        modlog_channel_id: ch.id,
      });
      await interaction.reply({ content: `✅ Salon modlog défini sur ${ch}.`, ephemeral: true });
      return true;
    }

    // /log off
    if (sub === 'off') {
      await saveSettings(interaction.guildId, { modlog_channel_id: null });
      await interaction.reply({ content: '✅ Logs modération désactivés.', ephemeral: true });
      return true;
    }

    // /log staffrole
    if (sub === 'staffrole') {
      const role = interaction.options.getRole('role');
      await saveSettings(interaction.guildId, { staff_role_id: role ? role.id : null });
      await interaction.reply({
        content: role ? `✅ Rôle staff défini: ${role}` : '✅ Rôle staff désactivé.',
        ephemeral: true,
      });
      return true;
    }

    // /log events
    if (sub === 'events') {
      const action = interaction.options.getString('action', true);
      const active = interaction.options.getBoolean('actif', true);
      const nextEvents = { ...mergeLogEvents(settings.log_events) };
      nextEvents[action] = active;
      await saveSettings(interaction.guildId, { log_events: nextEvents });
      await interaction.reply({
        content: `✅ Logs pour **${action}**: **${active ? 'ON' : 'OFF'}**`,
        ephemeral: true,
      });
      return true;
    }

    // /log status
    if (sub === 'status') {
      const events = mergeLogEvents(settings.log_events);
      const chText = settings.modlog_channel_id ? `<#${settings.modlog_channel_id}>` : 'Désactivé';
      const staffText = settings.staff_role_id ? `<@&${settings.staff_role_id}>` : 'Aucun';

      const embed = redEmbed()
        .setTitle('🧾 Config Modération')
        .addFields(
          { name: 'Salon modlog', value: chText, inline: false },
          { name: 'Rôle staff', value: staffText, inline: false },
          {
            name: 'Events',
            value: Object.entries(events)
              .map(([k, v]) => `• **${k}**: ${v ? 'ON' : 'OFF'}`)
              .join('\n'),
            inline: false,
          }
        );

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return true;
    }

    // /log test
    if (sub === 'test') {
      if (!settings.modlog_channel_id) {
        await interaction.reply({ content: '⚠️ Aucun salon modlog configuré. Utilise /log set.', ephemeral: true });
        return true;
      }

      const embed = redEmbed()
        .setTitle('🧪 Test Modlog')
        .setDescription('Si tu vois cet embed, la config modlog fonctionne ✅');

      const msg = await sendModLog(guild, settings, embed);
      await interaction.reply({
        content: msg ? `✅ Test envoyé dans <#${settings.modlog_channel_id}>.` : '⚠️ Impossible d’envoyer dans le salon modlog.',
        ephemeral: true,
      });
      return true;
    }

    // /log case
    if (sub === 'case') {
      const id = interaction.options.getInteger('id', true);
      await interaction.deferReply({ ephemeral: true });

      const c = await fetchCase(interaction.guildId, id);
      if (!c) {
        await interaction.editReply('⚠️ Case introuvable.');
        return true;
      }

      const embed = redEmbed()
        .setTitle(`📁 Case #${c.case_id} — ${c.action}`)
        .addFields(
          { name: 'Cible', value: c.target_id ? `<@${c.target_id}> (${c.target_id})` : '—', inline: false },
          { name: 'Modérateur', value: c.moderator_id ? `<@${c.moderator_id}>` : '—', inline: true },
          {
            name: 'Durée',
            value: c.duration_ms ? formatDuration(Number(c.duration_ms)) : '—',
            inline: true,
          },
          { name: 'Raison', value: c.reason || '—', inline: false }
        )
        .setFooter({ text: `Créé le ${new Date(c.created_at).toLocaleString('fr-FR')}` });

      if (c.log_channel_id && c.log_message_id) {
        embed.addFields({
          name: 'Log',
          value: `Message: ${c.log_message_id} • Salon: <#${c.log_channel_id}>`,
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    // /log history
    if (sub === 'history') {
      const user = interaction.options.getUser('membre');
      const userId = interaction.options.getString('user_id');
      const limit = interaction.options.getInteger('limit') ?? 10;

      const targetId = user?.id || (userId ? userId.trim() : null);
      if (!targetId) {
        await interaction.reply({ content: '⚠️ Donne membre OU user_id.', ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const rows = await listCasesForUser(interaction.guildId, targetId, limit);
      if (!rows.length) {
        await interaction.editReply(`Aucun historique pour **${targetId}**.`);
        return true;
      }

      const desc = rows
        .map((r) => {
          const dur = r.duration_ms ? ` • ${formatDuration(Number(r.duration_ms))}` : '';
          return `• **#${r.case_id}** — **${r.action}**${dur} — ${r.reason || '—'} _( ${new Date(r.created_at).toLocaleString('fr-FR')} )_`;
        })
        .join('\n');

      const embed = redEmbed()
        .setTitle(`🕘 Historique — ${user ? fmtUserTag(user, user.tag) : targetId}`)
        .setDescription(desc);

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    // /log recent
    if (sub === 'recent') {
      const action = interaction.options.getString('action') || 'ALL';
      const limit = interaction.options.getInteger('limit') ?? 10;

      await interaction.deferReply({ ephemeral: true });

      const rows = await listRecentCases(interaction.guildId, action, limit);
      if (!rows.length) {
        await interaction.editReply('Aucune action récente.');
        return true;
      }

      const desc = rows
        .map((r) => {
          const target = r.target_id ? `<@${r.target_id}>` : '—';
          const dur = r.duration_ms ? ` • ${formatDuration(Number(r.duration_ms))}` : '';
          return `• **#${r.case_id}** — **${r.action}** — ${target}${dur} — ${r.reason || '—'} _( ${new Date(r.created_at).toLocaleString('fr-FR')} )_`;
        })
        .join('\n');

      const embed = redEmbed()
        .setTitle(`🧭 Actions récentes — ${action === 'ALL' ? 'TOUT' : action}`)
        .setDescription(desc);

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    return true;
  }



  async function handleAutorole(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (!mustHave(interaction, PermissionsBitField.Flags.ManageRoles, settings.staff_role_id)) {
      await interaction.reply({
        content: '⛔ Il faut la permission **Gérer les rôles** (ou être staff) pour faire ça.',
        ephemeral: true,
      });
      return true;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    const auto = await getAutoroleSettings(interaction.guildId);
    const roleIds = sanitizeAutoroleRoleIds(guild, auto.role_ids);
    if (roleIds.length !== auto.role_ids.length) {
      await saveAutoroleSettings(interaction.guildId, roleIds);
    }

    await interaction.reply({
      ...buildAutorolePanel(guild, roleIds),
      ephemeral: true,
    });
    return true;
  }

  async function handleAutoroleComponent(interaction, client) {
    try {
      const settings = await getSettings(interaction.guildId);

      if (!mustHave(interaction, PermissionsBitField.Flags.ManageRoles, settings.staff_role_id)) {
        await interaction.reply({
          content: '⛔ Il faut la permission **Gérer les rôles** (ou être staff) pour faire ça.',
          ephemeral: true,
        });
        return true;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
        return true;
      }

      if (
        interaction.customId === 'autorole:add' ||
        interaction.customId === 'autorole:remove' ||
        interaction.customId === 'autorole:clear'
      ) {
        await interaction.deferUpdate();
      }

      const auto = await getAutoroleSettings(interaction.guildId);
      let roleIds = sanitizeAutoroleRoleIds(guild, auto.role_ids);

      if (interaction.customId === 'autorole:add' && interaction.isRoleSelectMenu()) {
        const me = await guild.members.fetchMe().catch(() => null);
        if (!me) {
          await interaction.editReply({ content: '⚠️ Bot introuvable.', components: [], embeds: [] });
          return true;
        }

        const selected = interaction.values
          .map((id) => guild.roles.cache.get(id))
          .filter((r) => !!r && !r.managed && me.roles.highest.comparePositionTo(r) > 0)
          .map((r) => r.id);

        roleIds = [...new Set([...roleIds, ...selected])].slice(0, 25);
        await saveAutoroleSettings(interaction.guildId, roleIds);
        await interaction.editReply(buildAutorolePanel(guild, roleIds));
        return true;
      }

      if (interaction.customId === 'autorole:remove' && interaction.isStringSelectMenu()) {
        const toRemove = new Set(interaction.values);
        roleIds = roleIds.filter((id) => !toRemove.has(id));
        await saveAutoroleSettings(interaction.guildId, roleIds);
        await interaction.editReply(buildAutorolePanel(guild, roleIds));
        return true;
      }

      if (interaction.customId === 'autorole:clear' && interaction.isButton()) {
        roleIds = [];
        await saveAutoroleSettings(interaction.guildId, roleIds);
        await interaction.editReply(buildAutorolePanel(guild, roleIds));
        return true;
      }

      return false;
    } catch (error) {
      console.error('handleAutoroleComponent error:', error);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: '⚠️ Erreur pendant la mise à jour du panneau auto-rôles.',
          ephemeral: true,
        }).catch(() => {});
      } else {
        await interaction.editReply({
          content: '⚠️ Erreur pendant la mise à jour du panneau auto-rôles.',
          components: [],
          embeds: [],
        }).catch(() => {});
      }
      return true;
    }
  }

  async function handleForceRole(interaction, client) {
    const settings = await getSettings(interaction.guildId);

    if (!mustHave(interaction, PermissionsBitField.Flags.ManageRoles, settings.staff_role_id)) {
      await interaction.reply({
        content: '⛔ Il faut la permission **Gérer les rôles** (ou être staff) pour faire ça.',
        ephemeral: true,
      });
      return true;
    }

    const role = interaction.options.getRole('role', true);
    const ignoreBots = interaction.options.getBoolean('ignorer_bots') ?? true;
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '⚠️ Serveur introuvable.', ephemeral: true });
      return true;
    }

    if (role.managed) {
      await interaction.reply({
        content: '⚠️ Ce rôle est géré par une intégration, je ne peux pas le donner.',
        ephemeral: true,
      });
      return true;
    }

    const me = await guild.members.fetchMe().catch(() => null);
    if (!me) {
      await interaction.reply({ content: '⚠️ Bot introuvable.', ephemeral: true });
      return true;
    }

    if (me.roles.highest.comparePositionTo(role) <= 0) {
      await interaction.reply({
        content: '⚠️ Le rôle du bot doit être au-dessus du rôle cible.',
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const members = await guild.members.fetch();
    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const member of members.values()) {
      if (ignoreBots && member.user.bot) {
        skipped += 1;
        continue;
      }
      if (member.roles.cache.has(role.id)) {
        skipped += 1;
        continue;
      }
      if (member.id === guild.ownerId) {
        skipped += 1;
        continue;
      }
      if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
        skipped += 1;
        continue;
      }

      try {
        await member.roles.add(role, `Force role par ${interaction.user.tag}`);
        success += 1;
      } catch {
        failed += 1;
      }
    }

    await interaction.editReply(
      `✅ Forcerole terminé pour ${role}.
` +
        `• Ajoutés: **${success}**
` +
        `• Ignorés: **${skipped}**
` +
        `• Erreurs: **${failed}**`
    );
    return true;
  }

  async function handleGuildMemberAdd(member, client) {
    if (!member?.guild) return false;

    const auto = await getAutoroleSettings(member.guild.id);
    let roleIds = sanitizeAutoroleRoleIds(member.guild, auto.role_ids);

    if (!roleIds.length) return false;

    const me = await member.guild.members.fetchMe().catch(() => null);
    if (!me) return false;

    roleIds = roleIds.filter((roleId) => {
      const role = member.guild.roles.cache.get(roleId);
      return role && me.roles.highest.comparePositionTo(role) > 0;
    });

    if (!roleIds.length) return false;

    for (const roleId of roleIds) {
      await member.roles.add(roleId, "Auto-rôle à l'arrivée").catch(() => null);
    }

    return false;
  }

  async function handleInteraction(interaction, client) {
    if (
      (interaction.isRoleSelectMenu() || interaction.isStringSelectMenu() || interaction.isButton()) &&
      String(interaction.customId || '').startsWith('autorole:')
    ) {
      return handleAutoroleComponent(interaction, client);
    }

    if (!interaction.isChatInputCommand()) return false;

    const name = interaction.commandName;

    if (name === 'ban') return handleBan(interaction, client);
    if (name === 'unban') return handleUnban(interaction, client);
    if (name === 'banlist') return handleBanlist(interaction, client);
    if (name === 'timeout') return handleTimeout(interaction, client);
    if (name === 'warn') return handleWarn(interaction, client);
    if (name === 'purge' || name === 'clear') return handlePurge(interaction, client);
    if (name === 'log') return handleLog(interaction, client);
    if (name === 'autorole') return handleAutorole(interaction, client);
    if (name === 'forcerole') return handleForceRole(interaction, client);

    return false;
  }

  return {
    commands,
    handleInteraction,
    handleMessage,
    handleGuildMemberAdd,
  };
}

module.exports = { createModerationService };
