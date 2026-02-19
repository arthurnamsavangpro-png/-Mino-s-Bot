// giveaway.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

function parseDurationMs(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return null;

  // Supporte "1h30m", "2d", "45m", "90s"
  const re = /(\d+)\s*(s|m|h|d|w)/g;
  let match;
  let total = 0;
  let found = false;

  while ((match = re.exec(s))) {
    found = true;
    const n = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(n) || n <= 0) continue;

    if (unit === "s") total += n * 1000;
    else if (unit === "m") total += n * 60 * 1000;
    else if (unit === "h") total += n * 60 * 60 * 1000;
    else if (unit === "d") total += n * 24 * 60 * 60 * 1000;
    else if (unit === "w") total += n * 7 * 24 * 60 * 60 * 1000;
  }

  if (!found || total <= 0) return null;
  return total;
}

function parseRoleIds(input) {
  if (!input) return [];
  const s = String(input).trim();
  if (!s) return [];

  const out = new Set();

  // <@&123>
  const mentionRe = /<@&(\d{16,20})>/g;
  let m;
  while ((m = mentionRe.exec(s))) out.add(m[1]);

  // IDs seuls
  const idRe = /\b(\d{16,20})\b/g;
  while ((m = idRe.exec(s))) out.add(m[1]);

  return [...out];
}

function buildRequirementsText(req) {
  const parts = [];

  const required = Array.isArray(req.required_role_ids) ? req.required_role_ids : [];
  const forbidden = Array.isArray(req.forbidden_role_ids) ? req.forbidden_role_ids : [];
  const minAge = Number(req.min_account_age_days || 0);
  const minVouches = Number(req.min_vouches || 0);

  if (required.length) {
    parts.push(`• **Rôle requis** : ${required.map((id) => `<@&${id}>`).join(" ")}`);
  }
  if (forbidden.length) {
    parts.push(`• **Rôles interdits** : ${forbidden.map((id) => `<@&${id}>`).join(" ")}`);
  }
  if (minAge > 0) parts.push(`• **Âge du compte** : minimum **${minAge}** jour(s)`);
  if (minVouches > 0) parts.push(`• **Vouches minimum** : **${minVouches}**`);

  return parts.length ? parts.join("\n") : "Aucune";
}

function buildGiveawayEmbed({ prize, hostId, winnerCount, endAt, status, participantsCount, requirements, winners }) {
  const ended = status === "ended";
  const cancelled = status === "cancelled";

  const title = cancelled
    ? "🚫 Giveaway annulé"
    : ended
      ? "🎉 Giveaway terminé"
      : "🎉 Giveaway";

  const eb = new EmbedBuilder()
    .setTitle(title)
    .addFields(
      { name: "🎁 Lot", value: prize || "?", inline: false },
      { name: "👑 Host", value: hostId ? `<@${hostId}>` : "?", inline: true },
      { name: "🏆 Gagnants", value: String(winnerCount ?? 1), inline: true },
      { name: "⏳ Fin", value: endAt ? `<t:${Math.floor(new Date(endAt).getTime() / 1000)}:R>` : "?", inline: true },
      { name: "📌 Conditions", value: buildRequirementsText(requirements || {}), inline: false },
      { name: "👥 Participants", value: String(participantsCount ?? 0), inline: true }
    )
    .setTimestamp();

  if (ended) {
    const win = Array.isArray(winners) ? winners : [];
    eb.addFields({
      name: "✅ Résultat",
      value: win.length ? win.map((id) => `<@${id}>`).join(", ") : "Aucun gagnant (pas assez de participants éligibles).",
      inline: false,
    });
  }

  if (cancelled) {
    eb.addFields({ name: "ℹ️ Info", value: "Ce giveaway a été annulé par le staff.", inline: false });
  }

  return eb;
}

function mustBeStaff(interaction) {
  return (
    interaction.memberPermissions &&
    interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

async function ensureBotCanSend(interaction, targetChannel) {
  const me = await interaction.guild.members.fetchMe().catch(() => null);
  if (!me) return false;
  const perms = targetChannel.permissionsFor(me);
  const needThreadPerm = targetChannel.isThread?.() === true;
  return Boolean(
    perms?.has(PermissionsBitField.Flags.ViewChannel) &&
      perms?.has(PermissionsBitField.Flags.SendMessages) &&
      (!needThreadPerm || perms?.has(PermissionsBitField.Flags.SendMessagesInThreads))
  );
}

function buildGiveawayComponents({ disabled = false } = {}) {
  const joinBtn = new ButtonBuilder()
    .setCustomId("gw:join")
    .setLabel("Participer")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  const leaveBtn = new ButtonBuilder()
    .setCustomId("gw:leave")
    .setLabel("Quitter")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  return [new ActionRowBuilder().addComponents(joinBtn, leaveBtn)];
}

function createGiveawayService({ pool, config }) {
  const commands = [
    new SlashCommandBuilder()
      .setName("giveaway")
      .setDescription("Giveaways (modération + participation)")
      .addSubcommand((sc) =>
        sc
          .setName("create")
          .setDescription("MOD: Créer un giveaway (avec règles optionnelles)")
          .addStringOption((opt) =>
            opt
              .setName("prize")
              .setDescription("Lot à gagner")
              .setRequired(true)
              .setMaxLength(200)
          )
          .addStringOption((opt) =>
            opt
              .setName("duration")
              .setDescription("Durée: ex 30m, 2h, 1d, 1h30m")
              .setRequired(true)
              .setMaxLength(32)
          )
          .addIntegerOption((opt) =>
            opt
              .setName("winners")
              .setDescription("Nombre de gagnants (défaut: 1)")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(20)
          )
          .addChannelOption((opt) =>
            opt
              .setName("channel")
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
          // RÈGLES (optionnelles = désactivées si vides / 0)
          .addStringOption((opt) =>
            opt
              .setName("required_roles")
              .setDescription("Rôle(s) requis: mentions ou IDs, séparés par espaces")
              .setRequired(false)
              .setMaxLength(600)
          )
          .addStringOption((opt) =>
            opt
              .setName("forbidden_roles")
              .setDescription("Rôle(s) interdits: mentions ou IDs, séparés par espaces")
              .setRequired(false)
              .setMaxLength(600)
          )
          .addIntegerOption((opt) =>
            opt
              .setName("min_account_age_days")
              .setDescription("Âge minimum du compte en jours (0 = désactivé)")
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(3650)
          )
          .addIntegerOption((opt) =>
            opt
              .setName("min_vouches")
              .setDescription("Vouches minimum (0 = désactivé)")
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(100000)
          )
          .addBooleanOption((opt) =>
            opt
              .setName("mention_everyone")
              .setDescription("@everyone au lancement (défaut: non)")
              .setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("end")
          .setDescription("MOD: Terminer un giveaway maintenant")
          .addStringOption((opt) =>
            opt
              .setName("message_id")
              .setDescription("ID du message giveaway (dans le salon)")
              .setRequired(true)
              .setMaxLength(32)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("cancel")
          .setDescription("MOD: Annuler un giveaway")
          .addStringOption((opt) =>
            opt
              .setName("message_id")
              .setDescription("ID du message giveaway (dans le salon)")
              .setRequired(true)
              .setMaxLength(32)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("reroll")
          .setDescription("MOD: Re-tirer des gagnants (giveaway terminé)")
          .addStringOption((opt) =>
            opt
              .setName("message_id")
              .setDescription("ID du message giveaway")
              .setRequired(true)
              .setMaxLength(32)
          )
          .addIntegerOption((opt) =>
            opt
              .setName("winners")
              .setDescription("Nombre de nouveaux gagnants (défaut: même nombre)")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(20)
          )
      )
      .addSubcommandGroup((grp) =>
        grp
          .setName("rules")
          .setDescription("MOD: Voir / modifier les règles d'un giveaway (activer/désactiver)")
          .addSubcommand((sc) =>
            sc
              .setName("show")
              .setDescription("Afficher les règles")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("ID du message giveaway")
                  .setRequired(true)
                  .setMaxLength(32)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("set")
              .setDescription("Définir (active) une règle")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("ID du message giveaway")
                  .setRequired(true)
                  .setMaxLength(32)
              )
              .addStringOption((opt) =>
                opt
                  .setName("type")
                  .setDescription("Quel type de règle ?")
                  .setRequired(true)
                  .addChoices(
                    { name: "required_roles", value: "required_roles" },
                    { name: "forbidden_roles", value: "forbidden_roles" },
                    { name: "min_account_age_days", value: "min_account_age_days" },
                    { name: "min_vouches", value: "min_vouches" }
                  )
              )
              .addStringOption((opt) =>
                opt
                  .setName("roles")
                  .setDescription("Pour required/forbidden: mentions ou IDs")
                  .setRequired(false)
                  .setMaxLength(600)
              )
              .addIntegerOption((opt) =>
                opt
                  .setName("number")
                  .setDescription("Pour min_account_age_days / min_vouches")
                  .setRequired(false)
                  .setMinValue(0)
                  .setMaxValue(100000)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("clear")
              .setDescription("Désactiver une règle (remet à vide/0)")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("ID du message giveaway")
                  .setRequired(true)
                  .setMaxLength(32)
              )
              .addStringOption((opt) =>
                opt
                  .setName("type")
                  .setDescription("Quelle règle désactiver ?")
                  .setRequired(true)
                  .addChoices(
                    { name: "required_roles", value: "required_roles" },
                    { name: "forbidden_roles", value: "forbidden_roles" },
                    { name: "min_account_age_days", value: "min_account_age_days" },
                    { name: "min_vouches", value: "min_vouches" }
                  )
              )
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("list")
          .setDescription("Lister les giveaways actifs du serveur")
      ),
  ];

  async function getGiveaway(giveawayId) {
    const res = await pool.query(
      `SELECT * FROM giveaways WHERE giveaway_id=$1 LIMIT 1`,
      [giveawayId]
    );
    return res.rows[0] || null;
  }

  async function getParticipantsCount(giveawayId) {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS c FROM giveaway_entries WHERE giveaway_id=$1`,
      [giveawayId]
    );
    return res.rows[0]?.c ?? 0;
  }

  async function getVouchCountsMap(guildId, userIds) {
    if (!userIds.length) return new Map();
    const res = await pool.query(
      `
        SELECT vouched_id, COUNT(*)::int AS c
        FROM vouches
        WHERE guild_id=$1 AND vouched_id = ANY($2::text[])
        GROUP BY vouched_id
      `,
      [guildId, userIds]
    );
    const map = new Map();
    for (const r of res.rows) map.set(String(r.vouched_id), Number(r.c));
    return map;
  }

  async function isEligible({ guild, member, user, requirements, vouchCountMap }) {
    const req = requirements || {};
    const required = Array.isArray(req.required_role_ids) ? req.required_role_ids : [];
    const forbidden = Array.isArray(req.forbidden_role_ids) ? req.forbidden_role_ids : [];
    const minAge = Number(req.min_account_age_days || 0);
    const minVouches = Number(req.min_vouches || 0);

    // required roles: au moins un
    if (required.length) {
      const ok = required.some((rid) => member.roles.cache.has(rid));
      if (!ok) return { ok: false, reason: "Tu n'as pas le rôle requis." };
    }

    // forbidden roles: aucun
    if (forbidden.length) {
      const bad = forbidden.some((rid) => member.roles.cache.has(rid));
      if (bad) return { ok: false, reason: "Tu as un rôle interdit pour ce giveaway." };
    }

    // account age
    if (minAge > 0) {
      const ageMs = Date.now() - user.createdTimestamp;
      const needMs = minAge * 24 * 60 * 60 * 1000;
      if (ageMs < needMs) {
        return { ok: false, reason: `Ton compte est trop récent (min ${minAge} jour(s)).` };
      }
    }

    // vouches
    if (minVouches > 0) {
      const c = vouchCountMap ? (vouchCountMap.get(member.id) ?? 0) : 0;
      if (c < minVouches) {
        return { ok: false, reason: `Il faut au moins ${minVouches} vouches pour participer.` };
      }
    }

    return { ok: true };
  }

  async function upsertRequirements(giveawayId, patch) {
    const current = await getGiveaway(giveawayId);
    if (!current) return null;

    const req = current.requirements || {};
    const merged = { ...req, ...patch };

    await pool.query(
      `UPDATE giveaways SET requirements=$2::jsonb WHERE giveaway_id=$1`,
      [giveawayId, JSON.stringify(merged)]
    );

    return merged;
  }

  function pickRandomUnique(arr, n) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, Math.max(0, Math.min(n, a.length)));
  }

  async function refreshGiveawayMessage(client, gRow, { disableButtons = false } = {}) {
    const guild = await client.guilds.fetch(gRow.guild_id).catch(() => null);
    if (!guild) return;

    const channel = await client.channels.fetch(gRow.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased?.()) return;

    const msg = await channel.messages.fetch(gRow.message_id).catch(() => null);
    if (!msg) return;

    const participantsCount = await getParticipantsCount(gRow.giveaway_id);
    const embed = buildGiveawayEmbed({
      prize: gRow.prize,
      hostId: gRow.host_id,
      winnerCount: gRow.winner_count,
      endAt: gRow.end_at,
      status: gRow.status,
      participantsCount,
      requirements: gRow.requirements,
      winners: gRow.winners,
    });

    const components = buildGiveawayComponents({ disabled: disableButtons });
    await msg.edit({ embeds: [embed], components }).catch(() => {});
  }

  async function finalizeGiveaway(client, giveawayId, { forced = false } = {}) {
    const gRow = await getGiveaway(giveawayId);
    if (!gRow) return { ok: false, message: "Giveaway introuvable." };
    if (gRow.status !== "running" && !forced) {
      return { ok: false, message: "Ce giveaway n'est pas en cours." };
    }

    const guild = await client.guilds.fetch(gRow.guild_id).catch(() => null);
    if (!guild) {
      await pool.query(
        `UPDATE giveaways SET status='cancelled', ended_at=NOW() WHERE giveaway_id=$1`,
        [giveawayId]
      );
      return { ok: false, message: "Serveur introuvable, giveaway annulé." };
    }

    const channel = await client.channels.fetch(gRow.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      await pool.query(
        `UPDATE giveaways SET status='cancelled', ended_at=NOW() WHERE giveaway_id=$1`,
        [giveawayId]
      );
      return { ok: false, message: "Salon introuvable, giveaway annulé." };
    }

    const msg = await channel.messages.fetch(gRow.message_id).catch(() => null);
    if (!msg) {
      await pool.query(
        `UPDATE giveaways SET status='cancelled', ended_at=NOW() WHERE giveaway_id=$1`,
        [giveawayId]
      );
      return { ok: false, message: "Message giveaway supprimé, giveaway annulé." };
    }

    // Liste participants
    const entriesRes = await pool.query(
      `SELECT user_id FROM giveaway_entries WHERE giveaway_id=$1`,
      [giveawayId]
    );
    const userIds = entriesRes.rows.map((r) => String(r.user_id));

    // Pré-calc vouches si règle active
    const req = gRow.requirements || {};
    const minVouches = Number(req.min_vouches || 0);
    const vouchMap = minVouches > 0 ? await getVouchCountsMap(gRow.guild_id, userIds) : new Map();

    // Filtre éligibles
    const eligible = [];
    for (const uid of userIds) {
      const member = await guild.members.fetch(uid).catch(() => null);
      if (!member) continue;

      const user = await client.users.fetch(uid).catch(() => null);
      if (!user) continue;

      const check = await isEligible({
        guild,
        member,
        user,
        requirements: req,
        vouchCountMap: vouchMap,
      });

      if (check.ok) eligible.push(uid);
    }

    const winners = pickRandomUnique(eligible, Number(gRow.winner_count || 1));

    await pool.query(
      `UPDATE giveaways
       SET status='ended', winners=$2::jsonb, ended_at=NOW()
       WHERE giveaway_id=$1`,
      [giveawayId, JSON.stringify(winners)]
    );

    // refresh row after update
    const updated = await getGiveaway(giveawayId);
    await refreshGiveawayMessage(client, updated, { disableButtons: true });

    if (winners.length) {
      await channel
        .send(`🎉 Félicitations ${winners.map((id) => `<@${id}>`).join(", ")} ! Vous gagnez **${updated.prize}**.`)
        .catch(() => {});
    } else {
      await channel
        .send(`⏱️ Giveaway terminé (**${updated.prize}**) : aucun gagnant (pas assez de participants éligibles).`)
        .catch(() => {});
    }

    return { ok: true, winners };
  }

  async function cancelGiveaway(client, giveawayId) {
    const gRow = await getGiveaway(giveawayId);
    if (!gRow) return { ok: false, message: "Giveaway introuvable." };
    if (gRow.status !== "running") return { ok: false, message: "Ce giveaway n'est pas en cours." };

    await pool.query(
      `UPDATE giveaways SET status='cancelled', ended_at=NOW() WHERE giveaway_id=$1`,
      [giveawayId]
    );

    const updated = await getGiveaway(giveawayId);
    await refreshGiveawayMessage(client, updated, { disableButtons: true });

    return { ok: true };
  }

  async function rerollGiveaway(client, giveawayId, overrideWinnerCount) {
    const gRow = await getGiveaway(giveawayId);
    if (!gRow) return { ok: false, message: "Giveaway introuvable." };
    if (gRow.status !== "ended") return { ok: false, message: "Ce giveaway n'est pas terminé." };

    const guild = await client.guilds.fetch(gRow.guild_id).catch(() => null);
    if (!guild) return { ok: false, message: "Serveur introuvable." };

    const channel = await client.channels.fetch(gRow.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased?.()) return { ok: false, message: "Salon introuvable." };

    const msg = await channel.messages.fetch(gRow.message_id).catch(() => null);
    if (!msg) return { ok: false, message: "Message giveaway introuvable." };

    // participants
    const entriesRes = await pool.query(
      `SELECT user_id FROM giveaway_entries WHERE giveaway_id=$1`,
      [giveawayId]
    );
    const userIds = entriesRes.rows.map((r) => String(r.user_id));

    const req = gRow.requirements || {};
    const minVouches = Number(req.min_vouches || 0);
    const vouchMap = minVouches > 0 ? await getVouchCountsMap(gRow.guild_id, userIds) : new Map();

    const previous = Array.isArray(gRow.winners) ? gRow.winners.map(String) : [];

    const eligible = [];
    for (const uid of userIds) {
      if (previous.includes(uid)) continue; // évite de reprendre les anciens
      const member = await guild.members.fetch(uid).catch(() => null);
      if (!member) continue;

      const user = await client.users.fetch(uid).catch(() => null);
      if (!user) continue;

      const check = await isEligible({
        guild,
        member,
        user,
        requirements: req,
        vouchCountMap: vouchMap,
      });
      if (check.ok) eligible.push(uid);
    }

    const wanted = Number(overrideWinnerCount || gRow.winner_count || 1);
    const newWinners = pickRandomUnique(eligible, wanted);

    const merged = [...previous, ...newWinners];

    await pool.query(
      `UPDATE giveaways SET winners=$2::jsonb WHERE giveaway_id=$1`,
      [giveawayId, JSON.stringify(merged)]
    );

    const updated = await getGiveaway(giveawayId);
    await refreshGiveawayMessage(client, updated, { disableButtons: true });

    if (newWinners.length) {
      await channel
        .send(`🎲 Reroll : nouveaux gagnants ${newWinners.map((id) => `<@${id}>`).join(", ")} (lot: **${updated.prize}**).`)
        .catch(() => {});
    } else {
      await channel
        .send(`🎲 Reroll : aucun nouveau gagnant éligible (lot: **${updated.prize}**).`)
        .catch(() => {});
    }

    return { ok: true, newWinners };
  }

  async function handleJoinLeave(interaction, client, action) {
    // bouton cliqué sur un message giveaway
    const messageId = interaction.message?.id;
    if (!messageId) return false;

    const gRow = await getGiveaway(messageId);
    if (!gRow) {
      await interaction.reply({ content: "⚠️ Giveaway introuvable (ou supprimé).", ephemeral: true }).catch(() => {});
      return true;
    }

    if (gRow.status !== "running") {
      await interaction.reply({ content: "⛔ Ce giveaway n'est plus actif.", ephemeral: true }).catch(() => {});
      return true;
    }

    if (!interaction.guild) {
      await interaction.reply({ content: "⚠️ Cette action doit être faite dans un serveur.", ephemeral: true }).catch(() => {});
      return true;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: "⚠️ Membre introuvable.", ephemeral: true }).catch(() => {});
      return true;
    }

    // Vérif règles (join uniquement)
    if (action === "join") {
      const req = gRow.requirements || {};
      const minVouches = Number(req.min_vouches || 0);
      const vouchMap =
        minVouches > 0 ? await getVouchCountsMap(gRow.guild_id, [interaction.user.id]) : new Map();

      const check = await isEligible({
        guild: interaction.guild,
        member,
        user: interaction.user,
        requirements: req,
        vouchCountMap: vouchMap,
      });

      if (!check.ok) {
        await interaction.reply({ content: `⛔ ${check.reason}`, ephemeral: true }).catch(() => {});
        return true;
      }
    }

    if (action === "join") {
      // insert unique
      try {
        await pool.query(
          `INSERT INTO giveaway_entries (giveaway_id, guild_id, user_id, entries)
           VALUES ($1,$2,$3,1)`,
          [gRow.giveaway_id, gRow.guild_id, interaction.user.id]
        );
        await interaction.reply({ content: "✅ Tu participes au giveaway !", ephemeral: true }).catch(() => {});
      } catch (e) {
        // déjà inscrit
        await interaction.reply({ content: "ℹ️ Tu participes déjà à ce giveaway.", ephemeral: true }).catch(() => {});
      }
    } else {
      await pool.query(
        `DELETE FROM giveaway_entries WHERE giveaway_id=$1 AND user_id=$2`,
        [gRow.giveaway_id, interaction.user.id]
      );
      await interaction.reply({ content: "✅ Tu as quitté le giveaway.", ephemeral: true }).catch(() => {});
    }

    // Refresh embed participants
    const refreshed = await getGiveaway(gRow.giveaway_id);
    await refreshGiveawayMessage(client, refreshed, { disableButtons: false });
    return true;
  }

  async function handleInteraction(interaction, client) {
    try {
      // --- Boutons join/leave
      if (interaction.isButton()) {
        if (interaction.customId === "gw:join") return await handleJoinLeave(interaction, client, "join");
        if (interaction.customId === "gw:leave") return await handleJoinLeave(interaction, client, "leave");
        return false;
      }

      // --- Slash
      if (!interaction.isChatInputCommand()) return false;
      if (interaction.commandName !== "giveaway") return false;

      const sub = interaction.options.getSubcommand();
      const group = interaction.options.getSubcommandGroup(false);

      // /giveaway list
      if (sub === "list" && !group) {
        const res = await pool.query(
          `SELECT giveaway_id, channel_id, prize, end_at
           FROM giveaways
           WHERE guild_id=$1 AND status='running'
           ORDER BY end_at ASC
           LIMIT 20`,
          [interaction.guildId]
        );

        if (!res.rows.length) {
          await interaction.reply({ content: "Aucun giveaway actif.", ephemeral: true });
          return true;
        }

        const lines = res.rows.map(
          (r) =>
            `• ID **${r.giveaway_id}** — <#${r.channel_id}> — **${r.prize}** — fin <t:${Math.floor(
              new Date(r.end_at).getTime() / 1000
            )}:R>`
        );

        await interaction.reply({ content: lines.join("\n"), ephemeral: true });
        return true;
      }

      // Commands staff
      if (["create", "end", "cancel", "reroll"].includes(sub) || group === "rules") {
        if (!mustBeStaff(interaction)) {
          await interaction.reply({
            content: "⛔ Il faut la permission **Gérer le serveur** pour faire ça.",
            ephemeral: true,
          });
          return true;
        }
      }

      // /giveaway create
      if (sub === "create") {
        if (!interaction.guild) {
          await interaction.reply({ content: "⚠️ Cette commande marche dans un serveur.", ephemeral: true });
          return true;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        const prize = interaction.options.getString("prize", true).trim();
        const durationRaw = interaction.options.getString("duration", true);
        const winners = interaction.options.getInteger("winners") ?? 1;

        const targetChannel =
          interaction.options.getChannel("channel") ||
          interaction.channel;

        if (!targetChannel || !targetChannel.isTextBased?.() || targetChannel.guildId !== interaction.guildId) {
          await interaction.editReply("⚠️ Salon invalide.");
          return true;
        }

        const canSend = await ensureBotCanSend(interaction, targetChannel);
        if (!canSend) {
          await interaction.editReply("⚠️ Je n’ai pas la permission d’envoyer dans ce salon.");
          return true;
        }

        const durationMs = parseDurationMs(durationRaw);
        if (!durationMs) {
          await interaction.editReply("⚠️ Durée invalide. Exemple: `30m`, `2h`, `1d`, `1h30m`.");
          return true;
        }

        // limites sécurité (10s -> 30 jours)
        const minMs = 10 * 1000;
        const maxMs = 30 * 24 * 60 * 60 * 1000;
        const clamped = Math.max(minMs, Math.min(maxMs, durationMs));
        const endAt = new Date(Date.now() + clamped);

        // RÈGLES (optionnelles)
        const requiredRoles = parseRoleIds(interaction.options.getString("required_roles") || "");
        const forbiddenRoles = parseRoleIds(interaction.options.getString("forbidden_roles") || "");
        const minAccountAgeDays = interaction.options.getInteger("min_account_age_days") ?? 0;
        const minVouches = interaction.options.getInteger("min_vouches") ?? 0;

        const requirements = {
          required_role_ids: requiredRoles,
          forbidden_role_ids: forbiddenRoles,
          min_account_age_days: Number(minAccountAgeDays || 0),
          min_vouches: Number(minVouches || 0),
        };

        // Message giveaway
        const embed = buildGiveawayEmbed({
          prize,
          hostId: interaction.user.id,
          winnerCount: winners,
          endAt,
          status: "running",
          participantsCount: 0,
          requirements,
          winners: [],
        });

        const mentionEveryone = interaction.options.getBoolean("mention_everyone") ?? false;
        const allowedMentions = mentionEveryone ? { parse: ["everyone"] } : { parse: [] };

        const msg = await targetChannel.send({
          content: mentionEveryone ? "@everyone" : undefined,
          embeds: [embed],
          components: buildGiveawayComponents({ disabled: false }),
          allowedMentions,
        });

        // Store DB (giveaway_id = message.id)
        await pool.query(
          `INSERT INTO giveaways
           (giveaway_id, guild_id, channel_id, message_id, prize, host_id, winner_count, end_at, status, requirements, winners)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9::jsonb,'[]'::jsonb)`,
          [
            msg.id,
            interaction.guildId,
            targetChannel.id,
            msg.id,
            prize,
            interaction.user.id,
            winners,
            endAt.toISOString(),
            JSON.stringify(requirements),
          ]
        );

        await interaction.editReply(`✅ Giveaway créé dans ${targetChannel} (ID: **${msg.id}**).`);
        return true;
      }

      // /giveaway end
      if (sub === "end") {
        const id = interaction.options.getString("message_id", true).trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        const res = await finalizeGiveaway(client, id, { forced: true });
        await interaction.editReply(res.ok ? "✅ Giveaway terminé." : `⚠️ ${res.message || "Erreur."}`);
        return true;
      }

      // /giveaway cancel
      if (sub === "cancel") {
        const id = interaction.options.getString("message_id", true).trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        const res = await cancelGiveaway(client, id);
        await interaction.editReply(res.ok ? "✅ Giveaway annulé." : `⚠️ ${res.message || "Erreur."}`);
        return true;
      }

      // /giveaway reroll
      if (sub === "reroll") {
        const id = interaction.options.getString("message_id", true).trim();
        const w = interaction.options.getInteger("winners") ?? null;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        const res = await rerollGiveaway(client, id, w);
        await interaction.editReply(res.ok ? "✅ Reroll effectué." : `⚠️ ${res.message || "Erreur."}`);
        return true;
      }

      // /giveaway rules ...
      if (group === "rules") {
        const id = interaction.options.getString("message_id", true).trim();

        if (sub === "show") {
          const gRow = await getGiveaway(id);
          if (!gRow) {
            await interaction.reply({ content: "⚠️ Giveaway introuvable.", ephemeral: true });
            return true;
          }
          const reqText = buildRequirementsText(gRow.requirements || {});
          await interaction.reply({ content: `📌 Règles actuelles (ID **${id}**) :\n${reqText}`, ephemeral: true });
          return true;
        }

        if (sub === "set") {
          const type = interaction.options.getString("type", true);
          const rolesRaw = interaction.options.getString("roles") || "";
          const number = interaction.options.getInteger("number");

          let patch = null;

          if (type === "required_roles") {
            const ids = parseRoleIds(rolesRaw);
            patch = { required_role_ids: ids };
          } else if (type === "forbidden_roles") {
            const ids = parseRoleIds(rolesRaw);
            patch = { forbidden_role_ids: ids };
          } else if (type === "min_account_age_days") {
            patch = { min_account_age_days: Number(number ?? 0) };
          } else if (type === "min_vouches") {
            patch = { min_vouches: Number(number ?? 0) };
          }

          if (!patch) {
            await interaction.reply({ content: "⚠️ Paramètres invalides.", ephemeral: true });
            return true;
          }

          const merged = await upsertRequirements(id, patch);
          if (!merged) {
            await interaction.reply({ content: "⚠️ Giveaway introuvable.", ephemeral: true });
            return true;
          }

          const gRow = await getGiveaway(id);
          await refreshGiveawayMessage(client, gRow, { disableButtons: false });

          await interaction.reply({ content: "✅ Règle mise à jour.", ephemeral: true });
          return true;
        }

        if (sub === "clear") {
          const type = interaction.options.getString("type", true);

          let patch = null;
          if (type === "required_roles") patch = { required_role_ids: [] };
          else if (type === "forbidden_roles") patch = { forbidden_role_ids: [] };
          else if (type === "min_account_age_days") patch = { min_account_age_days: 0 };
          else if (type === "min_vouches") patch = { min_vouches: 0 };

          const merged = await upsertRequirements(id, patch);
          if (!merged) {
            await interaction.reply({ content: "⚠️ Giveaway introuvable.", ephemeral: true });
            return true;
          }

          const gRow = await getGiveaway(id);
          await refreshGiveawayMessage(client, gRow, { disableButtons: false });

          await interaction.reply({ content: "✅ Règle désactivée.", ephemeral: true });
          return true;
        }
      }

      return true;
    } catch (e) {
      console.error("giveaway handler fatal:", e);
      if (interaction?.isRepliable?.()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction
            .reply({ content: "⚠️ Erreur interne (voir logs).", flags: MessageFlags.Ephemeral })
            .catch(() => {});
        } else if (interaction.deferred) {
          await interaction.editReply("⚠️ Erreur interne (voir logs).").catch(() => {});
        }
      }
      return true;
    }
  }

  function startGlobalGiveawaySweeper(client) {
    setInterval(async () => {
      try {
        // récupère tous les giveaways arrivés à échéance
        const res = await pool.query(
          `SELECT giveaway_id
           FROM giveaways
           WHERE status='running' AND end_at <= NOW()
           ORDER BY end_at ASC
           LIMIT 50`
        );

        for (const row of res.rows) {
          await finalizeGiveaway(client, String(row.giveaway_id)).catch((e) =>
            console.error("finalizeGiveaway:", e)
          );
        }
      } catch (e) {
        console.error("giveaway sweeper error:", e);
      }
    }, Math.max(5000, Number(config.GIVEAWAY_SWEEP_MS || 15000)));
  }

  return { commands, handleInteraction, startGlobalGiveawaySweeper };
}

module.exports = { createGiveawayService };
