const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  MessageFlags,
} = require('discord.js');

function createInvitationsService({ pool }) {
  const inviteCache = new Map(); // guildId -> Map(code -> uses)

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  function logTransactionError(scope, context, error) {
    console.error(`[invitations] transaction failed (${scope})`, {
      ...context,
      error: error?.message || error,
    });
  }

  function buildInviteCommand(commandName) {
    return new SlashCommandBuilder()
      .setName(commandName)
      .setDescription("Système d'invitations avancé (profil, classement, rewards, admin)")
      .addSubcommand((sub) =>
        sub
          .setName('profil')
          .setDescription("Affiche le profil invitation d'un membre")
          .addUserOption((opt) =>
            opt.setName('membre').setDescription('Membre ciblé').setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('leaderboard')
          .setDescription('Classement des meilleurs inviteurs')
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Nombre de lignes (3-20)')
              .setRequired(false)
              .setMinValue(3)
              .setMaxValue(20)
          )
      )
      .addSubcommand((sub) => sub.setName('rewards').setDescription('Voir les paliers de récompenses'))
      .addSubcommand((sub) =>
        sub.setName('panel').setDescription('Panel admin premium (config, métriques, commandes utiles)')
      )
      .addSubcommand((sub) =>
        sub
          .setName('annonce')
          .setDescription("Annonce publiquement qui a invité un membre et son total net")
          .addUserOption((opt) =>
            opt.setName('membre').setDescription('Membre à afficher').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('setannonce')
          .setDescription("Définir le salon d'annonces simples des invitations")
          .addChannelOption((opt) =>
            opt.setName('salon').setDescription("Salon d'annonces").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('clearannonce')
          .setDescription("Retirer le salon d'annonces simples des invitations")
      )
      .addSubcommand((sub) =>
        sub
          .setName('setlog')
          .setDescription('Définir le salon de logs invitations')
          .addChannelOption((opt) =>
            opt.setName('salon').setDescription('Salon de logs').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('clearlog')
          .setDescription('Retirer le salon de logs invitations')
      )
      .addSubcommand((sub) =>
        sub
          .setName('setfakemin')
          .setDescription('Âge minimum du compte (en jours) pour une invite valide')
          .addIntegerOption((opt) =>
            opt
              .setName('jours')
              .setDescription('Jours minimum (0-365)')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(365)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('setreward')
          .setDescription('Configurer un palier de récompense')
          .addRoleOption((opt) => opt.setName('role').setDescription('Rôle récompense').setRequired(true))
          .addIntegerOption((opt) =>
            opt
              .setName('invites')
              .setDescription('Invites nettes requises')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(5000)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('delreward')
          .setDescription('Supprimer un palier de récompense')
          .addRoleOption((opt) => opt.setName('role').setDescription('Rôle à retirer').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('bonus')
          .setDescription("Ajouter/retirer un bonus manuel d'invites à un membre")
          .addUserOption((opt) => opt.setName('membre').setDescription('Membre ciblé').setRequired(true))
          .addIntegerOption((opt) =>
            opt
              .setName('valeur')
              .setDescription('Valeur positive/négative (ex: 2, -1)')
              .setRequired(true)
              .setMinValue(-500)
              .setMaxValue(500)
          )
          .addStringOption((opt) =>
            opt
              .setName('raison')
              .setDescription('Raison administrative (optionnel)')
              .setRequired(false)
              .setMaxLength(200)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('sync')
          .setDescription('Recalcule les récompenses sur tous les membres suivis')
      );
  }

  // NOTE: exposing both /invite and /invites created frequent command-version mismatches
  // on Discord clients ("commande obsolète"). We keep only /invite for stability.
  const commands = [buildInviteCommand('invite')];

  async function getSettings(guildId) {
    const res = await pool.query(
      `SELECT guild_id, log_channel_id, announce_channel_id, fake_min_account_days FROM invite_settings WHERE guild_id=$1`,
      [guildId]
    );
    return res.rows[0] || { guild_id: guildId, log_channel_id: null, announce_channel_id: null, fake_min_account_days: 7 };
  }

  async function setSettings(guildId, patch) {
    await pool.query(
      `INSERT INTO invite_settings (guild_id, log_channel_id, announce_channel_id, fake_min_account_days)
       VALUES ($1, $2, $3, COALESCE($4, 7))
       ON CONFLICT (guild_id) DO UPDATE SET
         log_channel_id = COALESCE($2, invite_settings.log_channel_id),
         announce_channel_id = COALESCE($3, invite_settings.announce_channel_id),
         fake_min_account_days = COALESCE($4, invite_settings.fake_min_account_days),
         updated_at = NOW()`,
      [guildId, patch.log_channel_id ?? null, patch.announce_channel_id ?? null, patch.fake_min_account_days ?? null]
    );
  }

  async function clearLogChannel(guildId) {
    await pool.query(
      `INSERT INTO invite_settings (guild_id, log_channel_id)
       VALUES ($1, NULL)
       ON CONFLICT (guild_id) DO UPDATE SET
         log_channel_id = NULL,
         updated_at = NOW()`,
      [guildId]
    );
  }



  async function clearAnnounceChannel(guildId) {
    await pool.query(
      `INSERT INTO invite_settings (guild_id, announce_channel_id)
       VALUES ($1, NULL)
       ON CONFLICT (guild_id) DO UPDATE SET
         announce_channel_id = NULL,
         updated_at = NOW()`,
      [guildId]
    );
  }

  async function ensureStatRow(guildId, userId, db = pool) {
    await db.query(
      `INSERT INTO invite_stats (guild_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (guild_id, user_id) DO NOTHING`,
      [guildId, userId]
    );
  }

  async function recomputeTotal(guildId, userId, db = pool) {
    const res = await db.query(
      `UPDATE invite_stats
       SET total = GREATEST(0, regular - left_count + bonus),
           updated_at = NOW()
       WHERE guild_id=$1 AND user_id=$2
       RETURNING *`,
      [guildId, userId]
    );
    return res.rows[0] || null;
  }

  async function logInviteEvent(guild, settings, embed) {
    if (!settings?.log_channel_id) return;
    const channel = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    await channel.send({ embeds: [embed] }).catch(() => {});
  }



  async function sendSimpleJoinAnnouncement(guild, settings, targetMember, inviterId, total) {
    const channelId = settings?.announce_channel_id;
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const content = inviterId
      ? `📣 ${targetMember} a été invité(e) par <@${inviterId}> — compteur net actuel: **${total}**.`
      : `📣 ${targetMember} a rejoint, mais l'inviteur est inconnu pour le moment.`;

    await channel.send({ content }).catch(() => {});
  }

  async function fetchRewardRows(guildId) {
    const res = await pool.query(
      `SELECT role_id, required_invites FROM invite_rewards WHERE guild_id=$1 ORDER BY required_invites ASC`,
      [guildId]
    );
    return res.rows;
  }

  async function syncRewardsForMember(guild, userId) {
    const statRes = await pool.query(
      `SELECT total FROM invite_stats WHERE guild_id=$1 AND user_id=$2`,
      [guild.id, userId]
    );
    const total = Number(statRes.rows[0]?.total || 0);
    const rewards = await fetchRewardRows(guild.id);
    if (!rewards.length) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    for (const r of rewards) {
      const roleId = r.role_id;
      const canHave = total >= Number(r.required_invites);
      if (!guild.roles.cache.has(roleId)) continue;
      const hasRole = member.roles.cache.has(roleId);
      if (canHave && !hasRole) {
        await member.roles.add(roleId, 'Récompense invitations').catch(() => {});
      }
      if (!canHave && hasRole) {
        await member.roles.remove(roleId, 'Seuil invitations non atteint').catch(() => {});
      }
    }
  }

  async function cacheGuildInvites(guild) {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return;
    const map = new Map();
    for (const inv of invites.values()) map.set(inv.code, inv.uses || 0);
    inviteCache.set(guild.id, map);
  }

  async function resolveJoinInvite(guild) {
    const previous = inviteCache.get(guild.id) || new Map();
    const current = await guild.invites.fetch().catch(() => null);
    if (!current) return { invite: null, currentMap: previous, isAmbiguous: true };

    const candidates = [];
    for (const inv of current.values()) {
      const before = previous.get(inv.code) || 0;
      const now = inv.uses || 0;
      if (now > before) {
        candidates.push({ inv, delta: now - before });
      }
    }

    let used = null;
    let isAmbiguous = false;
    if (candidates.length === 1 && candidates[0].delta === 1) {
      used = candidates[0].inv;
    } else if (candidates.length > 0) {
      isAmbiguous = true;
      const exact = candidates.find((c) => c.delta === 1);
      used = exact?.inv || null;
    } else {
      isAmbiguous = true;
    }

    const nextMap = new Map();
    for (const inv of current.values()) nextMap.set(inv.code, inv.uses || 0);
    return { invite: used, currentMap: nextMap, isAmbiguous };
  }

  async function getRank(guildId, userId) {
    const res = await pool.query(
      `SELECT COALESCE(pos, 0)::int AS pos
       FROM (
         SELECT user_id, ROW_NUMBER() OVER (ORDER BY total DESC, regular DESC, updated_at ASC) AS pos
         FROM invite_stats
         WHERE guild_id=$1
       ) t
       WHERE user_id=$2`,
      [guildId, userId]
    );
    return Number(res.rows[0]?.pos || 0);
  }

  async function handleGuildMemberAdd(member) {
    if (!member?.guild) return;

    const guild = member.guild;
    const settings = await getSettings(guild.id);
    const { invite, currentMap, isAmbiguous } = await resolveJoinInvite(guild);
    inviteCache.set(guild.id, currentMap);

    let inviterId = invite?.inviter?.id || null;
    if (inviterId === member.id) inviterId = null;

    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const minDays = Number(settings.fake_min_account_days || 7);
    const isFake = accountAgeMs < minDays * 24 * 60 * 60 * 1000;

    let stat = null;
    try {
      stat = await withTransaction(async (db) => {
        await db.query(
          `INSERT INTO invite_joins (guild_id, user_id, inviter_id, invite_code, is_fake, is_ambiguous)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (guild_id, user_id)
           DO UPDATE SET
             inviter_id=EXCLUDED.inviter_id,
             invite_code=EXCLUDED.invite_code,
             is_fake=EXCLUDED.is_fake,
             is_ambiguous=EXCLUDED.is_ambiguous,
             joined_at=NOW(),
             left_at=NULL,
             status='joined'`,
          [guild.id, member.id, inviterId, invite?.code || null, isFake, isAmbiguous]
        );

        if (!inviterId) return null;

        await ensureStatRow(guild.id, inviterId, db);
        await db.query(
          `UPDATE invite_stats
           SET regular = regular + CASE WHEN $3 THEN 0 ELSE 1 END,
               fake = fake + CASE WHEN $3 THEN 1 ELSE 0 END,
               updated_at = NOW()
           WHERE guild_id=$1 AND user_id=$2`,
          [guild.id, inviterId, isFake]
        );
        return recomputeTotal(guild.id, inviterId, db);
      });
    } catch (e) {
      logTransactionError('handleGuildMemberAdd', { guildId: guild.id, memberId: member.id }, e);
      throw e;
    }

    if (inviterId) {
      await syncRewardsForMember(guild, inviterId);

      const embed = new EmbedBuilder()
        .setColor(isFake ? 0xe67e22 : 0x2ecc71)
        .setTitle(isAmbiguous ? '📥 Nouvelle invitation détectée (ambiguë)' : '📥 Nouvelle invitation détectée')
        .setDescription(
          `${member} a rejoint via ${invite ? `\`${invite.code}\`` : '`inconnue`'}\nInviteur: <@${inviterId}>`
        )
        .addFields(
          { name: 'Type', value: isFake ? '⚠️ Suspecte (compte trop récent)' : '✅ Valide', inline: true },
          { name: 'Attribution', value: isAmbiguous ? '⚠️ Ambiguë (concurrence possible)' : '✅ Fiable', inline: true },
          { name: 'Total net', value: `**${stat?.total || 0}**`, inline: true }
        )
        .setTimestamp();
      await logInviteEvent(guild, settings, embed);
      await sendSimpleJoinAnnouncement(guild, settings, member, inviterId, Number(stat?.total || 0));
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('📥 Nouveau membre (invitation inconnue)')
      .setDescription(`${member} a rejoint, mais aucune invitation n'a pu être identifiée.`)
      .setTimestamp();
    await logInviteEvent(guild, settings, embed);
    await sendSimpleJoinAnnouncement(guild, settings, member, null, 0);
  }

  async function handleGuildMemberRemove(member) {
    if (!member?.guild) return;
    const guild = member.guild;
    const settings = await getSettings(guild.id);

    let inviterId = null;
    let stat = null;
    try {
      const txResult = await withTransaction(async (db) => {
        const res = await db.query(
          `SELECT inviter_id
           FROM invite_joins
           WHERE guild_id=$1 AND user_id=$2 AND status='joined'
           LIMIT 1`,
          [guild.id, member.id]
        );
        const txInviterId = res.rows[0]?.inviter_id || null;

        await db.query(
          `UPDATE invite_joins
           SET status='left', left_at=NOW()
           WHERE guild_id=$1 AND user_id=$2 AND status='joined'`,
          [guild.id, member.id]
        );

        if (!txInviterId) {
          return { inviterId: null, stat: null };
        }

        await ensureStatRow(guild.id, txInviterId, db);
        await db.query(
          `UPDATE invite_stats
           SET left_count = left_count + 1,
               updated_at = NOW()
           WHERE guild_id=$1 AND user_id=$2`,
          [guild.id, txInviterId]
        );
        const txStat = await recomputeTotal(guild.id, txInviterId, db);
        return { inviterId: txInviterId, stat: txStat };
      });

      inviterId = txResult.inviterId;
      stat = txResult.stat;
    } catch (e) {
      logTransactionError('handleGuildMemberRemove', { guildId: guild.id, memberId: member.id }, e);
      throw e;
    }

    if (!inviterId) return;
    await syncRewardsForMember(guild, inviterId);

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('📤 Départ d\'un invité')
      .setDescription(`${member.user.tag} a quitté le serveur. Inviteur: <@${inviterId}>`)
      .addFields({ name: 'Total net de l\'inviteur', value: `**${stat?.total || 0}**`, inline: true })
      .setTimestamp();
    await logInviteEvent(guild, settings, embed);
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !['invite', 'invites'].includes(interaction.commandName)) return false;
    if (!interaction.guildId) {
      await interaction.reply({ content: '⚠️ Commande disponible uniquement en serveur.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand(true);
    const adminSubs = new Set(['setlog', 'clearlog', 'setannonce', 'clearannonce', 'setfakemin', 'setreward', 'delreward', 'bonus', 'sync']);
    if (adminSubs.has(sub) && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: '❌ Permission refusée. Tu dois avoir **Gérer le serveur**.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === 'profil') {
      const target = interaction.options.getUser('membre') || interaction.user;
      await ensureStatRow(guildId, target.id);

      const res = await pool.query(
        `SELECT regular, fake, left_count, bonus, total, updated_at
         FROM invite_stats WHERE guild_id=$1 AND user_id=$2`,
        [guildId, target.id]
      );
      const stat = res.rows[0] || { regular: 0, fake: 0, left_count: 0, bonus: 0, total: 0 };
      const rank = await getRank(guildId, target.id);

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`👤 Profil invitations — ${target.tag}`)
        .addFields(
          { name: '✅ Valides', value: String(stat.regular || 0), inline: true },
          { name: '⚠️ Fake/Suspectes', value: String(stat.fake || 0), inline: true },
          { name: '📤 Départs', value: String(stat.left_count || 0), inline: true },
          { name: '🎁 Bonus admin', value: String(stat.bonus || 0), inline: true },
          { name: '🏆 Total net', value: `**${stat.total || 0}**`, inline: true },
          { name: '#️⃣ Rang', value: rank > 0 ? `#${rank}` : 'N/A', inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'leaderboard') {
      const limit = interaction.options.getInteger('limit') || 10;
      const res = await pool.query(
        `SELECT user_id, total, regular, left_count, bonus
         FROM invite_stats
         WHERE guild_id=$1
         ORDER BY total DESC, regular DESC
         LIMIT $2`,
        [guildId, limit]
      );

      const lines = res.rows.length
        ? res.rows
            .map(
              (r, i) =>
                `**${i + 1}.** <@${r.user_id}> — **${r.total}** (valides: ${r.regular}, départs: ${r.left_count}, bonus: ${r.bonus})`
            )
            .join('\n')
        : 'Aucune donnée invitation pour le moment.';

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🏅 Leaderboard invitations')
        .setDescription(lines)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      return true;
    }

    if (sub === 'rewards') {
      const rows = await fetchRewardRows(guildId);
      const text = rows.length
        ? rows.map((r) => `• <@&${r.role_id}> — **${r.required_invites}** invites nettes`).join('\n')
        : 'Aucun palier configuré.';
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🎁 Paliers de rewards invitations')
        .setDescription(text)
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'panel') {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
          content: '❌ Ce panel est réservé aux administrateurs (permission **Gérer le serveur**).',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const [settings, leaderboardRes, statsRes, rewards, joinsHealthRes] = await Promise.all([
        getSettings(guildId),
        pool.query(
          `SELECT user_id, total
           FROM invite_stats
           WHERE guild_id=$1
           ORDER BY total DESC, regular DESC
           LIMIT 5`,
          [guildId]
        ),
        pool.query(
          `SELECT
             COUNT(*)::int AS tracked_members,
             COALESCE(SUM(regular), 0)::int AS valid_invites,
             COALESCE(SUM(fake), 0)::int AS fake_invites,
             COALESCE(SUM(left_count), 0)::int AS leaves
           FROM invite_stats
           WHERE guild_id=$1`,
          [guildId]
        ),
        fetchRewardRows(guildId),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='joined')::int AS active_joins,
             COUNT(*) FILTER (WHERE is_ambiguous=true AND status='joined')::int AS ambiguous_joins,
             COUNT(*) FILTER (WHERE inviter_id IS NULL AND status='joined')::int AS unknown_inviter_joins
           FROM invite_joins
           WHERE guild_id=$1`,
          [guildId]
        ),
      ]);

      const leaderboardText = leaderboardRes.rows.length
        ? leaderboardRes.rows
            .map((row, i) => `**${i + 1}.** <@${row.user_id}> — **${row.total}**`)
            .join('\n')
        : 'Aucune donnée pour le moment.';
      const overview = statsRes.rows[0] || {
        tracked_members: 0,
        valid_invites: 0,
        fake_invites: 0,
        leaves: 0,
      };
      const joinsHealth = joinsHealthRes.rows[0] || {
        active_joins: 0,
        ambiguous_joins: 0,
        unknown_inviter_joins: 0,
      };
      const rewardsPreview = rewards.length
        ? rewards
            .slice(0, 4)
            .map((r) => `• <@&${r.role_id}> → **${r.required_invites}**`)
            .join('\n')
        : 'Aucun palier configuré.';

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('✨ Invite Premium Admin Panel')
        .setDescription(
          "Vue d'ensemble administrateur: configuration active, qualité du tracking et raccourcis de pilotage."
        )
        .addFields(
          {
            name: '📊 Statistiques globales',
            value:
              `Membres suivis: **${overview.tracked_members}**\n` +
              `Invites valides: **${overview.valid_invites}**\n` +
              `Invites suspectes: **${overview.fake_invites}**\n` +
              `Départs: **${overview.leaves}**`,
            inline: true,
          },
          {
            name: '🧪 Santé du tracking',
            value:
              `Joins actifs suivis: **${joinsHealth.active_joins}**\n` +
              `Attributions ambiguës: **${joinsHealth.ambiguous_joins}**\n` +
              `Inviteur inconnu: **${joinsHealth.unknown_inviter_joins}**`,
            inline: true,
          },
          {
            name: '⚙️ Configuration',
            value:
              `Logs: ${settings.log_channel_id ? `<#${settings.log_channel_id}>` : '`Non défini`'}\n` +
              `Annonces: ${
                settings.announce_channel_id ? `<#${settings.announce_channel_id}>` : '`Non défini`'
              }\n` +
              `Seuil fake: **${Number(settings.fake_min_account_days || 7)} jours**`,
            inline: true,
          },
          { name: '🏅 Top inviteurs (Top 5)', value: leaderboardText, inline: false },
          { name: '🎁 Rewards configurées', value: rewardsPreview, inline: false },
          {
            name: '🛠️ Actions admin rapides',
            value:
              '`/invite setfakemin jours:<x>`\n' +
              '`/invite setlog salon:<#salon>`\n' +
              '`/invite setannonce salon:<#salon>`\n' +
              '`/invite setreward role:<@role> invites:<x>`\n' +
              '`/invite sync`',
            inline: false,
          }
        )
        .setFooter({ text: 'Panel admin — utilise les commandes ci-dessus pour ajuster le système.' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'annonce') {
      const target = interaction.options.getUser('membre', true);
      const joinRes = await pool.query(
        `SELECT inviter_id
         FROM invite_joins
         WHERE guild_id=$1 AND user_id=$2
         ORDER BY joined_at DESC
         LIMIT 1`,
        [guildId, target.id]
      );

      const inviterId = joinRes.rows[0]?.inviter_id || null;
      if (!inviterId) {
        await interaction.reply({
          content: `📣 ${target} a rejoint, mais l'inviteur est inconnu pour le moment.`,
        });
        return true;
      }

      await ensureStatRow(guildId, inviterId);
      const statRes = await pool.query(
        `SELECT total FROM invite_stats WHERE guild_id=$1 AND user_id=$2`,
        [guildId, inviterId]
      );
      const total = Number(statRes.rows[0]?.total || 0);

      await interaction.reply({
        content: `📣 ${target} a été invité(e) par <@${inviterId}> — compteur net actuel: **${total}**.`,
      });
      return true;
    }

    if (sub === 'setlog') {
      const channel = interaction.options.getChannel('salon', true);
      await setSettings(guildId, { log_channel_id: channel.id });
      await interaction.reply({ content: `✅ Salon de logs invitations défini sur ${channel}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'clearlog') {
      await clearLogChannel(guildId);
      await interaction.reply({ content: '✅ Salon de logs invitations retiré.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'setannonce') {
      const channel = interaction.options.getChannel('salon', true);
      await setSettings(guildId, { announce_channel_id: channel.id });
      await interaction.reply({ content: `✅ Salon d'annonces invitations défini sur ${channel}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'clearannonce') {
      await clearAnnounceChannel(guildId);
      await interaction.reply({ content: "✅ Salon d'annonces invitations retiré.", flags: MessageFlags.Ephemeral });
      return true;
    }


    if (sub === 'setfakemin') {
      const days = interaction.options.getInteger('jours', true);
      await setSettings(guildId, { fake_min_account_days: days });
      await interaction.reply({
        content: `✅ Seuil fake mis à **${days} jour(s)** (comptes plus récents => invitation suspecte).`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === 'setreward') {
      const role = interaction.options.getRole('role', true);
      const invites = interaction.options.getInteger('invites', true);
      await pool.query(
        `INSERT INTO invite_rewards (guild_id, role_id, required_invites)
         VALUES ($1,$2,$3)
         ON CONFLICT (guild_id, role_id) DO UPDATE
         SET required_invites=EXCLUDED.required_invites, updated_at=NOW()`,
        [guildId, role.id, invites]
      );
      await interaction.reply({
        content: `✅ Reward configurée: ${role} à **${invites}** invites nettes.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === 'delreward') {
      const role = interaction.options.getRole('role', true);
      await pool.query(`DELETE FROM invite_rewards WHERE guild_id=$1 AND role_id=$2`, [guildId, role.id]);
      await interaction.reply({ content: `✅ Reward supprimée pour ${role}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'bonus') {
      const target = interaction.options.getUser('membre', true);
      const value = interaction.options.getInteger('valeur', true);
      const reason = interaction.options.getString('raison') || null;

      await ensureStatRow(guildId, target.id);
      await pool.query(
        `UPDATE invite_stats
         SET bonus = bonus + $3,
             updated_at = NOW()
         WHERE guild_id=$1 AND user_id=$2`,
        [guildId, target.id, value]
      );
      const stat = await recomputeTotal(guildId, target.id);
      await syncRewardsForMember(interaction.guild, target.id);

      const settings = await getSettings(guildId);
      const log = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle('🛠️ Ajustement admin des invites')
        .setDescription(`Cible: <@${target.id}>\nValeur: **${value >= 0 ? '+' : ''}${value}**\nPar: ${interaction.user}`)
        .addFields(
          { name: 'Nouveau total net', value: `**${stat?.total || 0}**`, inline: true },
          { name: 'Raison', value: reason || 'Aucune', inline: false }
        )
        .setTimestamp();
      await logInviteEvent(interaction.guild, settings, log);

      await interaction.reply({
        content: `✅ Bonus mis à jour pour <@${target.id}>: **${value >= 0 ? '+' : ''}${value}** (total: **${stat?.total || 0}**).`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === 'sync') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await pool.query(`SELECT user_id FROM invite_stats WHERE guild_id=$1`, [guildId]);
      for (const row of res.rows) {
        await recomputeTotal(guildId, row.user_id);
        await syncRewardsForMember(interaction.guild, row.user_id);
      }
      await interaction.editReply(`✅ Sync terminé pour **${res.rows.length}** profil(s).`);
      return true;
    }

    return true;
  }

  async function primeCache(client) {
    for (const guild of client.guilds.cache.values()) {
      await cacheGuildInvites(guild);
    }
  }

  async function handleInviteCreate(invite) {
    const map = inviteCache.get(invite.guild.id) || new Map();
    map.set(invite.code, invite.uses || 0);
    inviteCache.set(invite.guild.id, map);
  }

  async function handleInviteDelete(invite) {
    const map = inviteCache.get(invite.guild.id) || new Map();
    map.delete(invite.code);
    inviteCache.set(invite.guild.id, map);
  }

  return {
    commands,
    handleInteraction,
    handleGuildMemberAdd,
    handleGuildMemberRemove,
    handleInviteCreate,
    handleInviteDelete,
    primeCache,
  };
}

module.exports = { createInvitationsService };
