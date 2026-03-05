const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const { randomUUID } = require('crypto');

function parseDateInput(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  const normalized = s.replace(' ', 'T');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatDate(dt) {
  try {
    return `<t:${Math.floor(new Date(dt).getTime() / 1000)}:f>`;
  } catch {
    return 'Date invalide';
  }
}

async function getSettings(pool, guildId) {
  const res = await pool.query('SELECT * FROM absence_settings WHERE guild_id=$1', [guildId]);
  return res.rows[0] || null;
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function hasRequiredRole(member, roleId) {
  if (!roleId) return true;
  return member?.roles?.cache?.has(roleId) || false;
}

function buildRequestEmbed(absence, title, color, extra = {}) {
  const embed = new EmbedBuilder()
    .setTitle('🗓️ Demande d\'absence staff')
    .setColor(color)
    .setDescription(title)
    .addFields(
      { name: 'ID', value: `\`${absence.absence_id}\``, inline: true },
      { name: 'Membre', value: `<@${absence.user_id}>`, inline: true },
      { name: 'Début', value: formatDate(absence.start_at), inline: true },
      { name: 'Fin', value: formatDate(absence.end_at), inline: true },
      { name: 'Raison', value: absence.reason || 'Non précisée', inline: false }
    )
    .setTimestamp(new Date());

  if (extra.byUser) {
    embed.addFields({ name: 'Action par', value: `<@${extra.byUser.id}>`, inline: true });
  }
  if (extra.reason) {
    embed.addFields({ name: 'Motif', value: extra.reason, inline: false });
  }

  return embed;
}

function createAbsenceService({ pool }) {
  const commands = [
    new SlashCommandBuilder()
      .setName('absence')
      .setDescription('Gestion des absences staff')
      .addSubcommand((sc) =>
        sc
          .setName('set')
          .setDescription('Configurer le système d\'absence (admin)')
          .addRoleOption((opt) =>
            opt.setName('staff_role').setDescription('Rôle staff autorisé à déclarer').setRequired(true)
          )
          .addRoleOption((opt) =>
            opt.setName('admin_role').setDescription('Rôle admin valideur').setRequired(true)
          )
          .addRoleOption((opt) =>
            opt.setName('absence_role').setDescription('Rôle ajouté pendant l\'absence validée').setRequired(true)
          )
          .addChannelOption((opt) =>
            opt.setName('log_channel').setDescription('Salon des demandes et validations').setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('declare')
          .setDescription('Déclare une absence (soumise à validation admin)')
          .addStringOption((opt) =>
            opt
              .setName('fin')
              .setDescription('Date de fin (YYYY-MM-DD HH:mm)')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('debut')
              .setDescription('Date de début (YYYY-MM-DD HH:mm), défaut=maintenant')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('raison')
              .setDescription('Raison de l\'absence')
              .setRequired(false)
              .setMaxLength(300)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('approve')
          .setDescription('Approuver une demande d\'absence (admin)')
          .addStringOption((opt) =>
            opt.setName('absence_id').setDescription('ID de la demande').setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('reject')
          .setDescription('Refuser une demande d\'absence (admin)')
          .addStringOption((opt) =>
            opt.setName('absence_id').setDescription('ID de la demande').setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName('raison').setDescription('Raison du refus').setRequired(false).setMaxLength(300)
          )
      )
      .addSubcommand((sc) =>
        sc.setName('retour').setDescription('Signaler son retour (retire le rôle absence)')
      )
      .addSubcommand((sc) =>
        sc
          .setName('statut')
          .setDescription('Voir le statut d\'absence d\'un membre')
          .addUserOption((opt) => opt.setName('membre').setDescription('Membre ciblé').setRequired(false))
      ),
  ];

  async function ensureConfigured(interaction) {
    const settings = await getSettings(pool, interaction.guildId);
    if (!settings) {
      await interaction.reply({
        content: '⚠️ Système non configuré. Un admin doit faire **/absence set**.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
    return settings;
  }

  async function approveAbsence({ guild, settings, absenceId, byUser }) {
    const res = await pool.query(`SELECT * FROM staff_absences WHERE guild_id=$1 AND absence_id=$2`, [guild.id, absenceId]);
    const absence = res.rows[0];
    if (!absence) return { ok: false, message: 'Absence introuvable.' };
    if (absence.status !== 'pending') return { ok: false, message: `Statut actuel: ${absence.status}.` };

    await pool.query(
      `UPDATE staff_absences
       SET status='approved', approved_by=$3, approved_at=NOW(), updated_at=NOW()
       WHERE guild_id=$1 AND absence_id=$2`,
      [guild.id, absenceId, byUser.id]
    );

    const member = await guild.members.fetch(absence.user_id).catch(() => null);
    if (member && settings.absence_role_id && guild.roles.cache.has(settings.absence_role_id)) {
      await member.roles.add(settings.absence_role_id, `Absence approuvée (${absenceId})`).catch(() => {});
    }

    const fresh = { ...absence, status: 'approved', approved_by: byUser.id };
    await updateDecisionMessage({ guild, absence: fresh, status: 'approved', byUser });
    await notifyMemberDecision({ guild, absence: fresh, byUser, approved: true });

    return { ok: true, absence: fresh };
  }

  async function updateDecisionMessage({ guild, absence, status, byUser, reason }) {
    const row = await pool.query(
      `SELECT log_channel_id, log_message_id FROM staff_absences WHERE guild_id=$1 AND absence_id=$2`,
      [guild.id, absence.absence_id]
    );
    const logChannelId = absence.log_channel_id || row.rows[0]?.log_channel_id;
    const logMessageId = absence.log_message_id || row.rows[0]?.log_message_id;
    if (!logChannelId || !logMessageId) return;

    const channel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(logMessageId).catch(() => null);
    if (!message) return;

    let title = '⏳ En attente de validation admin';
    let color = 0xf1c40f;
    if (status === 'approved') {
      title = '✅ Absence approuvée';
      color = 0x2ecc71;
    } else if (status === 'rejected') {
      title = '❌ Absence refusée';
      color = 0xe74c3c;
    } else if (status === 'cancelled' || status === 'ended') {
      title = '🛑 Absence clôturée';
      color = 0x95a5a6;
    }

    await message.edit({
      embeds: [buildRequestEmbed(absence, title, color, { byUser, reason })],
      components: [],
    }).catch(() => {});
  }

  async function notifyMemberDecision({ guild, absence, byUser, approved, reason }) {
    const user = await guild.client.users.fetch(absence.user_id).catch(() => null);
    if (!user) return;

    const verdict = approved ? '✅ **approuvée**' : '❌ **refusée**';
    const msg = [
      `Ta demande d'absence \`${absence.absence_id}\` a été ${verdict}.`,
      `• Début: ${new Date(absence.start_at).toLocaleString('fr-FR')}`,
      `• Fin: ${new Date(absence.end_at).toLocaleString('fr-FR')}`,
      `• Décision par: <@${byUser.id}>`,
    ];
    if (reason) msg.push(`• Motif: ${reason}`);

    await user.send({ content: msg.join('\n') }).catch(() => {});
  }

  async function rejectAbsence({ guild, absenceId, byUser, reason }) {
    const res = await pool.query(`SELECT * FROM staff_absences WHERE guild_id=$1 AND absence_id=$2`, [guild.id, absenceId]);
    const absence = res.rows[0];
    if (!absence) return { ok: false, message: 'Absence introuvable.' };
    if (absence.status !== 'pending') return { ok: false, message: `Statut actuel: ${absence.status}.` };

    await pool.query(
      `UPDATE staff_absences
       SET status='rejected', approved_by=$3, approved_at=NOW(), decision_reason=$4, updated_at=NOW()
       WHERE guild_id=$1 AND absence_id=$2`,
      [guild.id, absenceId, byUser.id, reason || null]
    );

    const fresh = { ...absence, status: 'rejected', approved_by: byUser.id, decision_reason: reason || null };
    await updateDecisionMessage({ guild, absence: fresh, status: 'rejected', byUser, reason });
    await notifyMemberDecision({ guild, absence: fresh, byUser, approved: false, reason });

    return { ok: true, absence: fresh };
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith('absence:')) return false;
      const [_, action, absenceId] = interaction.customId.split(':');
      const settings = await ensureConfigured(interaction);
      if (!settings) return true;

      const canModerate = isAdmin(interaction) || hasRequiredRole(interaction.member, settings.admin_role_id);
      if (!canModerate) {
        await interaction.reply({ content: '❌ Tu ne peux pas valider/refuser.', flags: MessageFlags.Ephemeral });
        return true;
      }

      if (action === 'approve') {
        const out = await approveAbsence({ guild: interaction.guild, settings, absenceId, byUser: interaction.user });
        if (!out.ok) {
          await interaction.reply({ content: `❌ ${out.message}`, flags: MessageFlags.Ephemeral });
          return true;
        }
        await interaction.reply({ content: `✅ Absence \`${absenceId}\` approuvée.`, flags: MessageFlags.Ephemeral });
        return true;
      }

      if (action === 'reject') {
        const out = await rejectAbsence({ guild: interaction.guild, absenceId, byUser: interaction.user, reason: 'Refus via bouton' });
        if (!out.ok) {
          await interaction.reply({ content: `❌ ${out.message}`, flags: MessageFlags.Ephemeral });
          return true;
        }
        await interaction.reply({ content: `✅ Absence \`${absenceId}\` refusée.`, flags: MessageFlags.Ephemeral });
        return true;
      }

      return false;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== 'absence') return false;
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const staffRole = interaction.options.getRole('staff_role', true);
      const adminRole = interaction.options.getRole('admin_role', true);
      const absenceRole = interaction.options.getRole('absence_role', true);
      const logChannel = interaction.options.getChannel('log_channel', true);

      await pool.query(
        `INSERT INTO absence_settings (guild_id, staff_role_id, admin_role_id, absence_role_id, log_channel_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (guild_id)
         DO UPDATE SET staff_role_id=EXCLUDED.staff_role_id,
                       admin_role_id=EXCLUDED.admin_role_id,
                       absence_role_id=EXCLUDED.absence_role_id,
                       log_channel_id=EXCLUDED.log_channel_id,
                       updated_at=NOW()`,
        [interaction.guildId, staffRole.id, adminRole.id, absenceRole.id, logChannel.id]
      );

      await interaction.reply({
        content: `✅ Configuration enregistrée.\n• Staff: <@&${staffRole.id}>\n• Admin: <@&${adminRole.id}>\n• Rôle absence: <@&${absenceRole.id}>\n• Salon: <#${logChannel.id}>`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const settings = await ensureConfigured(interaction);
    if (!settings) return true;

    const canDeclare = isAdmin(interaction) || hasRequiredRole(interaction.member, settings.staff_role_id);
    if (sub === 'declare') {
      if (!canDeclare) {
        await interaction.reply({ content: '❌ Tu dois avoir le rôle staff configuré.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const endInput = interaction.options.getString('fin', true);
      const startInput = interaction.options.getString('debut', false);
      const reason = interaction.options.getString('raison', false);

      const startAt = parseDateInput(startInput) || new Date();
      const endAt = parseDateInput(endInput);
      if (!endAt) {
        await interaction.reply({ content: '❌ Date de fin invalide. Format attendu: `YYYY-MM-DD HH:mm`.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (endAt <= startAt) {
        await interaction.reply({ content: '❌ La date de fin doit être après la date de début.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const existing = await pool.query(
        `SELECT absence_id FROM staff_absences WHERE guild_id=$1 AND user_id=$2 AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, interaction.user.id]
      );
      if (existing.rows[0]) {
        await interaction.reply({
          content: `⚠️ Tu as déjà une absence en cours (${existing.rows[0].absence_id}). Termine-la avant d'en créer une autre.`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const absenceId = `abs_${randomUUID().slice(0, 8)}`;
      await pool.query(
        `INSERT INTO staff_absences (
          absence_id, guild_id, user_id, start_at, end_at, reason, status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),NOW())`,
        [absenceId, interaction.guildId, interaction.user.id, startAt.toISOString(), endAt.toISOString(), reason || null]
      );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`absence:approve:${absenceId}`).setLabel('Approuver').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`absence:reject:${absenceId}`).setLabel('Refuser').setStyle(ButtonStyle.Danger)
      );

      const logChannel = await interaction.guild.channels.fetch(settings.log_channel_id).catch(() => null);
      if (logChannel?.isTextBased()) {
        const pending = {
          absence_id: absenceId,
          user_id: interaction.user.id,
          start_at: startAt,
          end_at: endAt,
          reason: reason || null,
        };
        const sent = await logChannel
          .send({
            embeds: [buildRequestEmbed(pending, '⏳ En attente de validation admin', 0xf1c40f)],
            components: [row],
          })
          .catch(() => null);

        if (sent?.id) {
          await pool.query(
            `UPDATE staff_absences SET log_channel_id=$3, log_message_id=$4, updated_at=NOW() WHERE guild_id=$1 AND absence_id=$2`,
            [interaction.guildId, absenceId, sent.channelId, sent.id]
          );
        }
      }

      await interaction.reply({
        content: `✅ Demande envoyée pour validation admin. ID: \`${absenceId}\``,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const canModerate = isAdmin(interaction) || hasRequiredRole(interaction.member, settings.admin_role_id);

    if (sub === 'approve') {
      if (!canModerate) {
        await interaction.reply({ content: '❌ Tu ne peux pas approuver les absences.', flags: MessageFlags.Ephemeral });
        return true;
      }
      const absenceId = interaction.options.getString('absence_id', true);
      const out = await approveAbsence({ guild: interaction.guild, settings, absenceId, byUser: interaction.user });
      if (!out.ok) {
        await interaction.reply({ content: `❌ ${out.message}`, flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({ content: `✅ Absence \`${absenceId}\` approuvée.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'reject') {
      if (!canModerate) {
        await interaction.reply({ content: '❌ Tu ne peux pas refuser les absences.', flags: MessageFlags.Ephemeral });
        return true;
      }
      const absenceId = interaction.options.getString('absence_id', true);
      const reason = interaction.options.getString('raison', false);
      const out = await rejectAbsence({ guild: interaction.guild, absenceId, byUser: interaction.user, reason });
      if (!out.ok) {
        await interaction.reply({ content: `❌ ${out.message}`, flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({ content: `✅ Absence \`${absenceId}\` refusée.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'retour') {
      const row = await pool.query(
        `SELECT * FROM staff_absences WHERE guild_id=$1 AND user_id=$2 AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, interaction.user.id]
      );
      const absence = row.rows[0];
      if (!absence) {
        await interaction.reply({ content: 'ℹ️ Tu n\'as pas d\'absence active.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const nextStatus = absence.status === 'approved' ? 'ended' : 'cancelled';

      await pool.query(
        `UPDATE staff_absences SET status=$3, ended_at=NOW(), updated_at=NOW() WHERE guild_id=$1 AND absence_id=$2`,
        [interaction.guildId, absence.absence_id, nextStatus]
      );

      if (absence.status === 'approved') {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member && settings.absence_role_id && member.roles.cache.has(settings.absence_role_id)) {
          await member.roles.remove(settings.absence_role_id, `Retour absence (${absence.absence_id})`).catch(() => {});
        }
      }

      await updateDecisionMessage({
        guild: interaction.guild,
        absence: { ...absence, status: nextStatus },
        status: nextStatus,
        byUser: interaction.user,
        reason: nextStatus === 'cancelled' ? 'Annulée par le membre via /absence retour' : undefined,
      });

      const retourMsg =
        nextStatus === 'cancelled'
          ? `✅ Demande \`${absence.absence_id}\` annulée.`
          : `✅ Retour enregistré pour \`${absence.absence_id}\`.`;
      await interaction.reply({ content: retourMsg, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'statut') {
      const user = interaction.options.getUser('membre', false) || interaction.user;
      const row = await pool.query(
        `SELECT * FROM staff_absences WHERE guild_id=$1 AND user_id=$2 AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, user.id]
      );
      const absence = row.rows[0];
      if (!absence) {
        await interaction.reply({ content: `ℹ️ ${user} n\'a pas d\'absence active.`, flags: MessageFlags.Ephemeral });
        return true;
      }

      const statusTxt = absence.status === 'pending' ? '⏳ En attente de validation' : '✅ Absence approuvée';
      await interaction.reply({
        content: `**Statut de ${user}:**\n• ID: \`${absence.absence_id}\`\n• Début: ${formatDate(absence.start_at)}\n• Fin: ${formatDate(absence.end_at)}\n• Statut: ${statusTxt}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    return false;
  }

  return { commands, handleInteraction };
}

module.exports = { createAbsenceService };
