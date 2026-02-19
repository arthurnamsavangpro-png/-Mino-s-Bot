const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");

function canManageRole(meMember, role) {
  if (!meMember || !role) return false;
  return meMember.roles.highest.comparePositionTo(role) > 0;
}

function createRankupService({ pool, config }) {
  /* -------------------------------
     Slash commands (rankup)
  -------------------------------- */
  const commands = [
    new SlashCommandBuilder()
      .setName("rank-add")
      .setDescription("MOD: Ajoute (ou modifie) un rang basé sur le nombre de vouches")
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("Rôle à attribuer").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("vouches")
          .setDescription("Vouches requis pour ce rôle")
          .setMinValue(0)
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("rank-remove")
      .setDescription("MOD: Supprime un rang (rôle) de la config")
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("Rôle à retirer de la config").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("rank-list")
      .setDescription("Liste les rangs configurés (vouches requis -> rôle)"),

    new SlashCommandBuilder()
      .setName("rank-sync")
      .setDescription("MOD: Recalcule le rang d'un membre selon ses vouches")
      .addUserOption((opt) =>
        opt.setName("membre").setDescription("Membre à synchroniser").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("rankup")
      .setDescription("MOD: Rankup manuel vers le rang suivant (selon la config)")
      .addUserOption((opt) =>
        opt.setName("membre").setDescription("Membre à promouvoir").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("rankdown")
      .setDescription("MOD: Rankdown manuel vers le rang précédent (selon la config)")
      .addUserOption((opt) =>
        opt.setName("membre").setDescription("Membre à rétrograder").setRequired(true)
      ),
  ];

  async function sendRankLog(guild, embed) {
    if (!config.RANKUP_LOG_CHANNEL_ID) return;
    const ch = await guild.channels.fetch(config.RANKUP_LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) ch.send({ embeds: [embed] }).catch(() => {});
  }

  async function fetchRankRoles(guildId) {
    const res = await pool.query(
      `SELECT role_id, required_vouches
       FROM rank_roles
       WHERE guild_id=$1
       ORDER BY required_vouches ASC, role_id ASC`,
      [guildId]
    );
    return res.rows;
  }

  async function upsertRankRole(guildId, roleId, requiredVouches) {
    await pool.query(
      `INSERT INTO rank_roles (guild_id, role_id, required_vouches)
       VALUES ($1,$2,$3)
       ON CONFLICT (guild_id, role_id) DO UPDATE
         SET required_vouches=EXCLUDED.required_vouches`,
      [guildId, roleId, requiredVouches]
    );
  }

  async function removeRankRole(guildId, roleId) {
    await pool.query(`DELETE FROM rank_roles WHERE guild_id=$1 AND role_id=$2`, [guildId, roleId]);
  }

  async function getVouchCountFor(guildId, userId) {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM vouches
       WHERE guild_id=$1 AND vouched_id=$2`,
      [guildId, userId]
    );
    return res.rows[0]?.count ?? 0;
  }

  function computeEligibleRankRoles(rankRoles, vouchCount) {
    const eligible = rankRoles.filter((r) => Number(r.required_vouches) <= Number(vouchCount));
    if (!eligible.length) return { highest: null, stack: [] };

    const highest = eligible[eligible.length - 1];
    const stack = eligible.map((r) => r.role_id);
    return { highest, stack };
  }

  async function applyRankForMember(guild, member, reason = "Rank sync") {
    const guildId = guild.id;
    const rankRoles = await fetchRankRoles(guildId);

    if (!rankRoles.length) return { changed: false, message: "Aucun rang configuré." };

    const vouchCount = await getVouchCountFor(guildId, member.id);
    const { highest, stack } = computeEligibleRankRoles(rankRoles, vouchCount);

    const configuredRoleIds = new Set(rankRoles.map((r) => r.role_id));
    const me = await guild.members.fetchMe().catch(() => null);

    const currentRankRoleIds = member.roles.cache
      .filter((r) => configuredRoleIds.has(r.id))
      .map((r) => r.id);

    const wantedRoleIds = new Set();
    if (highest) {
      if (config.RANKUP_STACK) stack.forEach((id) => wantedRoleIds.add(id));
      else wantedRoleIds.add(highest.role_id);
    }

    const toRemove = currentRankRoleIds.filter((id) => !wantedRoleIds.has(id));
    const toAdd = [...wantedRoleIds].filter((id) => !currentRankRoleIds.includes(id));

    for (const rid of [...toRemove, ...toAdd]) {
      const role = guild.roles.cache.get(rid) || (await guild.roles.fetch(rid).catch(() => null));
      if (!role) continue;
      if (!canManageRole(me, role)) {
        return {
          changed: false,
          message:
            "Je ne peux pas gérer un des rôles de rank (hiérarchie). Mets le rôle du bot au-dessus des rôles de rank.",
        };
      }
    }

    if (toRemove.length) await member.roles.remove(toRemove, reason).catch(() => {});
    if (toAdd.length) await member.roles.add(toAdd, reason).catch(() => {});

    return {
      changed: toRemove.length > 0 || toAdd.length > 0,
      vouchCount,
      highestRoleId: highest?.role_id ?? null,
      toAdd,
      toRemove,
    };
  }

  async function manualRankStep(guild, member, direction /* +1 or -1 */) {
    const guildId = guild.id;
    const rankRoles = await fetchRankRoles(guildId);
    if (!rankRoles.length) return { ok: false, message: "Aucun rang configuré. Utilise /rank-add." };

    const idsOrdered = rankRoles.map((r) => r.role_id);
    const configuredSet = new Set(idsOrdered);

    let currentIndex = -1;
    for (let i = 0; i < idsOrdered.length; i++) {
      if (member.roles.cache.has(idsOrdered[i])) currentIndex = i;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0) return { ok: false, message: "Déjà au rang le plus bas (ou aucun rang)." };
    if (nextIndex >= idsOrdered.length) return { ok: false, message: "Déjà au rang le plus haut." };

    const me = await guild.members.fetchMe().catch(() => null);

    const nextRoleId = idsOrdered[nextIndex];
    const nextRole =
      guild.roles.cache.get(nextRoleId) || (await guild.roles.fetch(nextRoleId).catch(() => null));

    if (!nextRole) return { ok: false, message: "Rôle introuvable (supprimé ?). Retire-le avec /rank-remove." };
    if (!canManageRole(me, nextRole)) return { ok: false, message: "Je ne peux pas attribuer ce rôle (hiérarchie/permissions)." };

    const allRankRoleIds = member.roles.cache
      .filter((r) => configuredSet.has(r.id))
      .map((r) => r.id);

    const wanted = new Set();
    if (config.RANKUP_STACK) {
      for (let i = 0; i <= nextIndex; i++) wanted.add(idsOrdered[i]);
    } else {
      wanted.add(nextRoleId);
    }

    const toRemove = allRankRoleIds.filter((id) => !wanted.has(id));
    const toAdd = [...wanted].filter((id) => !member.roles.cache.has(id));

    for (const rid of [...toRemove, ...toAdd]) {
      const role = guild.roles.cache.get(rid) || (await guild.roles.fetch(rid).catch(() => null));
      if (!role) continue;
      if (!canManageRole(me, role)) return { ok: false, message: "Je ne peux pas gérer un des rôles (hiérarchie)." };
    }

    if (toRemove.length) await member.roles.remove(toRemove, "Manual rank step").catch(() => {});
    if (toAdd.length) await member.roles.add(toAdd, "Manual rank step").catch(() => {});

    return { ok: true, nextRoleId, toAdd, toRemove };
  }

  function buildAutoRankLogEmbed(memberId, res) {
    return new EmbedBuilder()
      .setTitle("⬆️ Auto Rank (vouches)")
      .setDescription(`Mise à jour des ranks pour <@${memberId}>`)
      .addFields(
        { name: "Vouches", value: `${res.vouchCount ?? "?"}`, inline: true },
        {
          name: "Ajoutés",
          value: res.toAdd?.length ? res.toAdd.map((id) => `<@&${id}>`).join(" ") : "Aucun",
          inline: false,
        },
        {
          name: "Retirés",
          value: res.toRemove?.length ? res.toRemove.map((id) => `<@&${id}>`).join(" ") : "Aucun",
          inline: false,
        }
      )
      .setTimestamp();
  }

  function mustBeMod(interaction) {
    return (
      interaction.memberPermissions &&
      interaction.memberPermissions.has(PermissionsBitField.Flags.ManageRoles)
    );
  }

  async function handleInteraction(interaction) {
    const name = interaction.commandName;

    // /rank-add
    if (name === "rank-add") {
      if (!mustBeMod(interaction)) {
        await interaction.reply({ content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.", ephemeral: true });
        return true;
      }

      const role = interaction.options.getRole("role", true);
      const vouches = interaction.options.getInteger("vouches", true);

      await upsertRankRole(interaction.guildId, role.id, vouches);

      await interaction.reply({ content: `✅ Rang enregistré : ${role} à **${vouches}** vouches.`, ephemeral: true });
      return true;
    }

    // /rank-remove
    if (name === "rank-remove") {
      if (!mustBeMod(interaction)) {
        await interaction.reply({ content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.", ephemeral: true });
        return true;
      }

      const role = interaction.options.getRole("role", true);
      await removeRankRole(interaction.guildId, role.id);

      await interaction.reply({ content: `✅ Rang retiré de la config : ${role}`, ephemeral: true });
      return true;
    }

    // /rank-list
    if (name === "rank-list") {
      const ranks = await fetchRankRoles(interaction.guildId);

      if (!ranks.length) {
        await interaction.reply({ content: "Aucun rang configuré. Utilise **/rank-add**.", ephemeral: true });
        return true;
      }

      const desc = ranks
        .map((r) => `• **${r.required_vouches}** vouches → <@&${r.role_id}>`)
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle("📈 Rangs (vouches → rôle)")
        .setDescription(desc)
        .setFooter({ text: `Mode: ${config.RANKUP_STACK ? "STACK (tous les rangs)" : "HIGHEST (rang max seulement)"}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return true;
    }

    // /rank-sync
    if (name === "rank-sync") {
      if (!mustBeMod(interaction)) {
        await interaction.reply({ content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.", ephemeral: true });
        return true;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser("membre", true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply("⚠️ Membre introuvable.");
        return true;
      }

      const res = await applyRankForMember(guild, member, "Rank sync (mod)");
      if (!res || res.message) {
        await interaction.editReply(`⚠️ ${res?.message || "Erreur lors du sync."}`);
        return true;
      }

      const added = res.toAdd?.length ? res.toAdd.map((id) => `<@&${id}>`).join(" ") : "Aucun";
      const removed = res.toRemove?.length ? res.toRemove.map((id) => `<@&${id}>`).join(" ") : "Aucun";

      const embed = new EmbedBuilder()
        .setTitle("🔁 Rank Sync")
        .setDescription(`Synchronisation de <@${member.id}>`)
        .addFields(
          { name: "Vouches", value: `${res.vouchCount ?? "?"}`, inline: true },
          { name: "Ajoutés", value: added, inline: false },
          { name: "Retirés", value: removed, inline: false }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    // /rankup
    if (name === "rankup") {
      if (!mustBeMod(interaction)) {
        await interaction.reply({ content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.", ephemeral: true });
        return true;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser("membre", true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply("⚠️ Membre introuvable.");
        return true;
      }

      const res = await manualRankStep(guild, member, +1);
      if (!res.ok) {
        await interaction.editReply(`⚠️ ${res.message}`);
        return true;
      }

      const embed = new EmbedBuilder()
        .setTitle("⬆️ Rankup (manuel)")
        .setDescription(`Promotion de <@${member.id}>`)
        .addFields(
          { name: "Nouveau rang", value: `<@&${res.nextRoleId}>`, inline: false },
          { name: "Ajoutés", value: res.toAdd?.length ? res.toAdd.map((id) => `<@&${id}>`).join(" ") : "Aucun", inline: false },
          { name: "Retirés", value: res.toRemove?.length ? res.toRemove.map((id) => `<@&${id}>`).join(" ") : "Aucun", inline: false }
        )
        .setTimestamp();

      sendRankLog(guild, embed).catch(() => {});
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    // /rankdown
    if (name === "rankdown") {
      if (!mustBeMod(interaction)) {
        await interaction.reply({ content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.", ephemeral: true });
        return true;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser("membre", true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply("⚠️ Membre introuvable.");
        return true;
      }

      const res = await manualRankStep(guild, member, -1);
      if (!res.ok) {
        await interaction.editReply(`⚠️ ${res.message}`);
        return true;
      }

      const embed = new EmbedBuilder()
        .setTitle("⬇️ Rankdown (manuel)")
        .setDescription(`Rétrogradation de <@${member.id}>`)
        .addFields(
          { name: "Nouveau rang", value: `<@&${res.nextRoleId}>`, inline: false },
          { name: "Ajoutés", value: res.toAdd?.length ? res.toAdd.map((id) => `<@&${id}>`).join(" ") : "Aucun", inline: false },
          { name: "Retirés", value: res.toRemove?.length ? res.toRemove.map((id) => `<@&${id}>`).join(" ") : "Aucun", inline: false }
        )
        .setTimestamp();

      sendRankLog(guild, embed).catch(() => {});
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    return false;
  }

  return {
    commands,
    handleInteraction,

    // Export utiles pour /vouch (auto rank)
    applyRankForMember,
    sendRankLog,
    buildAutoRankLogEmbed,
  };
}

module.exports = { createRankupService };

