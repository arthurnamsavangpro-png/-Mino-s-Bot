// modrank.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

function boolFromStr(v, def = false) {
  if (v === undefined || v === null) return def;
  return String(v).toLowerCase() === "true";
}

function safeInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Tables (créées dans index.js/initDb):
 * - modrank_settings(guild_id PK, announce_channel_id, log_channel_id, dm_enabled, ping_enabled, mode, updated_at)
 * - modrank_roles(guild_id, role_id, position, created_at, PK(guild_id, role_id))
 * - modrank_counters(guild_id PK, last_ref BIGINT)
 */

function createModrankService({ pool, config }) {
  const DEFAULTS = {
    dm_enabled: false,
    ping_enabled: false,
    mode: "highest", // highest | stack
  };

  async function getSettings(guildId) {
    const { rows } = await pool.query(
      `SELECT * FROM modrank_settings WHERE guild_id=$1`,
      [guildId]
    );
    if (!rows[0]) {
      // fallback defaults sans créer automatiquement (on peut créer au premier /modrank config)
      return { guild_id: guildId, ...DEFAULTS, announce_channel_id: null, log_channel_id: null };
    }
    const s = rows[0];
    return {
      guild_id: guildId,
      announce_channel_id: s.announce_channel_id || null,
      log_channel_id: s.log_channel_id || null,
      dm_enabled: !!s.dm_enabled,
      ping_enabled: !!s.ping_enabled,
      mode: (s.mode || DEFAULTS.mode).toLowerCase(),
    };
  }

  async function upsertSettings(guildId, patch) {
    const current = await getSettings(guildId);
    const next = { ...current, ...patch };

    await pool.query(
      `
      INSERT INTO modrank_settings
        (guild_id, announce_channel_id, log_channel_id, dm_enabled, ping_enabled, mode, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (guild_id) DO UPDATE SET
        announce_channel_id = EXCLUDED.announce_channel_id,
        log_channel_id      = EXCLUDED.log_channel_id,
        dm_enabled          = EXCLUDED.dm_enabled,
        ping_enabled        = EXCLUDED.ping_enabled,
        mode                = EXCLUDED.mode,
        updated_at          = NOW()
      `,
      [
        guildId,
        next.announce_channel_id,
        next.log_channel_id,
        next.dm_enabled,
        next.ping_enabled,
        next.mode,
      ]
    );
    return next;
  }

  async function listRoles(guildId) {
    const { rows } = await pool.query(
      `SELECT role_id, position FROM modrank_roles WHERE guild_id=$1 ORDER BY position ASC`,
      [guildId]
    );
    return rows.map((r) => ({ role_id: r.role_id, position: Number(r.position) }));
  }

  async function addRole(guildId, roleId, position) {
    await pool.query(
      `
      INSERT INTO modrank_roles (guild_id, role_id, position, created_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (guild_id, role_id) DO UPDATE SET
        position = EXCLUDED.position
      `,
      [guildId, roleId, position]
    );
  }

  async function removeRole(guildId, roleId) {
    await pool.query(
      `DELETE FROM modrank_roles WHERE guild_id=$1 AND role_id=$2`,
      [guildId, roleId]
    );
  }

  async function moveRole(guildId, roleId, direction) {
    // direction: up|down (swap avec voisin)
    const roles = await listRoles(guildId);
    const idx = roles.findIndex((r) => r.role_id === roleId);
    if (idx === -1) return { ok: false, msg: "Rôle introuvable dans l’échelle." };

    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= roles.length) {
      return { ok: false, msg: "Impossible de déplacer (déjà en bord)." };
    }

    const a = roles[idx];
    const b = roles[swapWith];

    await pool.query(
      `UPDATE modrank_roles SET position=$1 WHERE guild_id=$2 AND role_id=$3`,
      [b.position, guildId, a.role_id]
    );
    await pool.query(
      `UPDATE modrank_roles SET position=$1 WHERE guild_id=$2 AND role_id=$3`,
      [a.position, guildId, b.role_id]
    );

    return { ok: true };
  }

  async function nextRef(guildId) {
    // compteur par serveur (MR-000001, etc.)
    await pool.query(
      `INSERT INTO modrank_counters (guild_id, last_ref) VALUES ($1, 0)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId]
    );
    const { rows } = await pool.query(
      `UPDATE modrank_counters SET last_ref = last_ref + 1 WHERE guild_id=$1 RETURNING last_ref`,
      [guildId]
    );
    const n = rows?.[0]?.last_ref ?? 0;
    return `MR-${String(n).padStart(6, "0")}`;
  }

  function isStaff(interaction) {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles);
  }

  function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  }

  function guildBranding(interaction) {
    const guildName = interaction.guild?.name || "Serveur";
    const guildIcon =
      interaction.guild?.iconURL?.({ extension: "png", size: 256 }) || null;
    return { guildName, guildIcon };
  }

  function makeLuxuryEmbed({
    interaction,
    targetUser,
    targetAvatar,
    title,
    description,
    fields,
  }) {
    const { guildName, guildIcon } = guildBranding(interaction);

    const embed = new EmbedBuilder()
      .setColor(0xe10600) // rouge premium
      .setAuthor({
        name: guildName,
        iconURL: guildIcon ?? undefined, // logo serveur ici (brand)
      })
      .setTitle(title)
      .setDescription(description)
      .setThumbnail(targetAvatar) // avatar membre en thumbnail
      .addFields(fields)
      .setFooter({ text: guildName });

    return embed;
  }

  async function sendToChannelSafe(client, channelId, payload) {
    if (!channelId) return null;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return null;
    return ch.send(payload).catch(() => null);
  }

  async function getCurrentModrankRoleId(member, roleIdsInScale) {
    // Renvoie le rôle ModRank le plus haut actuellement (selon l’ordre position ASC => bas->haut)
    // Donc le plus haut = dernier trouvé dans la liste ordonnée.
    let found = null;
    for (const roleId of roleIdsInScale) {
      if (member.roles.cache.has(roleId)) found = roleId;
    }
    return found; // null si aucun
  }

  async function applyModrank({
    interaction,
    client,
    targetMember,
    newRoleId,
    reason,
    actionLabel, // "Promotion" / "Rétrogradation" / "Ajustement"
  }) {
    const guildId = interaction.guildId;
    const settings = await getSettings(guildId);
    const scale = await listRoles(guildId);
    if (!scale.length) {
      return { ok: false, msg: "Aucun ModRank configuré. Utilise `/modrank add`." };
    }

    // Vérifs rôle existe
    const newRole = await interaction.guild.roles.fetch(newRoleId).catch(() => null);
    if (!newRole) return { ok: false, msg: "Rôle introuvable sur le serveur." };

    // Vérifs hiérarchie
    const me = interaction.guild.members.me;
    if (!me) return { ok: false, msg: "Impossible de vérifier la hiérarchie du bot." };

    if (newRole.position >= me.roles.highest.position) {
      return { ok: false, msg: "Je ne peux pas attribuer ce rôle (hiérarchie du bot insuffisante)." };
    }

    // Optionnel: empêcher qu’un mod donne un rôle au-dessus de lui-même
    if (
      interaction.member &&
      newRole.position >= interaction.member.roles.highest.position &&
      !interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return { ok: false, msg: "Tu ne peux pas attribuer un rôle au-dessus (ou égal) à ton plus haut rôle." };
    }

    const roleIdsInScale = scale.map((r) => r.role_id);
    const oldRoleId = await getCurrentModrankRoleId(targetMember, roleIdsInScale);

    // Mode highest: retirer tous les rôles ModRank avant d’ajouter le nouveau
    if (settings.mode === "highest") {
      const toRemove = roleIdsInScale.filter((rid) => targetMember.roles.cache.has(rid) && rid !== newRoleId);
      if (toRemove.length) {
        await targetMember.roles.remove(toRemove, "ModRank: mode highest").catch(() => null);
      }
    }

    // Appliquer
    if (!targetMember.roles.cache.has(newRoleId)) {
      await targetMember.roles.add(newRoleId, "ModRank").catch(() => null);
    }

    const refId = await nextRef(guildId);
    const ts = nowUnix();

    const targetUser = targetMember.user;
    const targetAvatar = targetUser.displayAvatarURL({ extension: "png", size: 256 });

    const oldRoleName = oldRoleId ? `<@&${oldRoleId}>` : "—";
    const newRoleName = `<@&${newRoleId}>`;

    const embed = makeLuxuryEmbed({
      interaction,
      targetUser,
      targetAvatar,
      title: "Mise à niveau confirmée",
      description: "Le statut du membre a été mis à jour.",
      fields: [
        { name: "Membre", value: `${targetUser}`, inline: true },
        { name: "Évolution", value: `${oldRoleName} → ${newRoleName}`, inline: true },
        { name: "Motif", value: reason?.trim() ? reason : "—", inline: false },
        { name: "Validé par", value: `${interaction.user}`, inline: true },
        { name: "Référence", value: `${refId} • <t:${ts}:F>`, inline: true },
      ],
    });

    // Annonce publique (optionnelle)
    const announcePayload = {
      content: settings.ping_enabled ? `${targetUser}` : null,
      embeds: [embed],
    };
    const announceMsg = await sendToChannelSafe(client, settings.announce_channel_id, announcePayload);

    // Log staff (optionnel) - embed “audit” sobre mais dans le même style
    const { guildName, guildIcon } = guildBranding(interaction);
    const logEmbed = new EmbedBuilder()
      .setColor(0xe10600)
      .setAuthor({ name: guildName, iconURL: guildIcon ?? undefined })
      .setTitle("Historique — Changement de rang")
      .setDescription(`${actionLabel} effectuée.`)
      .addFields(
        { name: "Membre", value: `${targetUser} (\`${targetUser.id}\`)`, inline: false },
        { name: "Avant", value: `${oldRoleName}`, inline: true },
        { name: "Après", value: `${newRoleName}`, inline: true },
        { name: "Modérateur", value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: false },
        { name: "Motif", value: reason?.trim() ? reason : "—", inline: false },
        { name: "Référence", value: `${refId} • <t:${ts}:F>`, inline: true },
        { name: "Annonce", value: announceMsg ? `<#${announceMsg.channelId}>` : "—", inline: true }
      )
      .setFooter({ text: guildName });

    await sendToChannelSafe(client, settings.log_channel_id, { embeds: [logEmbed] });

    // DM (optionnel)
    if (settings.dm_enabled) {
      const dmEmbed = makeLuxuryEmbed({
        interaction,
        targetUser,
        targetAvatar,
        title: "Mise à jour de votre statut",
        description: `Votre rang a été ajusté sur **${interaction.guild.name}**.`,
        fields: [
          { name: "Évolution", value: `${oldRoleName} → ${newRoleName}`, inline: false },
          { name: "Validé par", value: `${interaction.user}`, inline: true },
          { name: "Motif", value: reason?.trim() ? reason : "—", inline: true },
          { name: "Référence", value: `${refId} • <t:${ts}:F>`, inline: false },
        ],
      });

      await targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
    }

    return { ok: true, refId, oldRoleId };
  }

  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName("modrank")
        .setDescription("Système de rangs modération (séparé des vouches)")
        // CONFIG
        .addSubcommand((sc) =>
          sc
            .setName("config")
            .setDescription("Configurer ModRank (announce/log/dm/ping/mode)")
            .addChannelOption((o) =>
              o.setName("announce_channel").setDescription("Salon annonces rank").setRequired(false)
            )
            .addChannelOption((o) =>
              o.setName("log_channel").setDescription("Salon logs staff").setRequired(false)
            )
            .addBooleanOption((o) =>
              o.setName("dm").setDescription("DM le membre après un changement").setRequired(false)
            )
            .addBooleanOption((o) =>
              o.setName("ping").setDescription("Ping le membre dans l’annonce").setRequired(false)
            )
            .addStringOption((o) =>
              o
                .setName("mode")
                .setDescription("highest = 1 seul rank, stack = cumule")
                .addChoices(
                  { name: "highest (recommandé)", value: "highest" },
                  { name: "stack", value: "stack" }
                )
                .setRequired(false)
            )
        )
        // ADD
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription("Ajouter/mettre à jour un rôle dans l’échelle ModRank")
            .addRoleOption((o) => o.setName("role").setDescription("Rôle ModRank").setRequired(true))
            .addIntegerOption((o) =>
              o
                .setName("position")
                .setDescription("Ordre (1=plus bas, plus grand=plus haut)")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(1000)
            )
        )
        // REMOVE
        .addSubcommand((sc) =>
          sc
            .setName("remove")
            .setDescription("Retirer un rôle de l’échelle ModRank")
            .addRoleOption((o) => o.setName("role").setDescription("Rôle").setRequired(true))
        )
        // LIST
        .addSubcommand((sc) => sc.setName("list").setDescription("Lister l’échelle ModRank"))
        // MOVE
        .addSubcommand((sc) =>
          sc
            .setName("move")
            .setDescription("Déplacer un rôle dans l’échelle (swap)")
            .addRoleOption((o) => o.setName("role").setDescription("Rôle").setRequired(true))
            .addStringOption((o) =>
              o
                .setName("direction")
                .setDescription("Sens")
                .addChoices({ name: "up", value: "up" }, { name: "down", value: "down" })
                .setRequired(true)
            )
        )
        // UP
        .addSubcommand((sc) =>
          sc
            .setName("up")
            .setDescription("Promouvoir un membre au rang ModRank supérieur")
            .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
            .addStringOption((o) =>
              o
                .setName("motif")
                .setDescription("Motif (optionnel)")
                .setRequired(false)
                .setMaxLength(300)
            )
        )
        // DOWN
        .addSubcommand((sc) =>
          sc
            .setName("down")
            .setDescription("Rétrograder un membre au rang ModRank inférieur")
            .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
            .addStringOption((o) =>
              o
                .setName("motif")
                .setDescription("Motif (optionnel)")
                .setRequired(false)
                .setMaxLength(300)
            )
        )
        // SET
        .addSubcommand((sc) =>
          sc
            .setName("set")
            .setDescription("Définir un rang ModRank précis à un membre")
            .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
            .addRoleOption((o) => o.setName("role").setDescription("Rôle ModRank").setRequired(true))
            .addStringOption((o) =>
              o
                .setName("motif")
                .setDescription("Motif (optionnel)")
                .setRequired(false)
                .setMaxLength(300)
            )
        )
        // INFO
        .addSubcommand((sc) =>
          sc
            .setName("info")
            .setDescription("Voir le rang ModRank actuel d’un membre")
            .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
        ),
    ];
  }

  async function handleInteraction(interaction, client) {
    if (!interaction.isChatInputCommand()) return false;
    if (interaction.commandName !== "modrank") return false;

    // Permissions: config & gestion échelle = admin, actions up/down/set = manage roles
    const sub = interaction.options.getSubcommand();

    if (sub === "config" || sub === "add" || sub === "remove" || sub === "move") {
      if (!isAdmin(interaction)) {
        await interaction.reply({
          content: "Accès refusé. (Admin requis)",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
    } else {
      if (!isStaff(interaction)) {
        await interaction.reply({
          content: "Accès refusé. (Manage Roles requis)",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
    }

    const guildId = interaction.guildId;

    // ---------- CONFIG ----------
    if (sub === "config") {
      const announce = interaction.options.getChannel("announce_channel");
      const log = interaction.options.getChannel("log_channel");
      const dm = interaction.options.getBoolean("dm");
      const ping = interaction.options.getBoolean("ping");
      const mode = interaction.options.getString("mode");

      const patch = {};
      if (announce !== null) patch.announce_channel_id = announce?.id ?? null;
      if (log !== null) patch.log_channel_id = log?.id ?? null;
      if (dm !== null) patch.dm_enabled = !!dm;
      if (ping !== null) patch.ping_enabled = !!ping;
      if (mode) patch.mode = mode;

      const s = await upsertSettings(guildId, patch);

      await interaction.reply({
        content:
          `✅ ModRank configuré.\n` +
          `• announce: ${s.announce_channel_id ? `<#${s.announce_channel_id}>` : "—"}\n` +
          `• log: ${s.log_channel_id ? `<#${s.log_channel_id}>` : "—"}\n` +
          `• dm: ${s.dm_enabled ? "on" : "off"}\n` +
          `• ping: ${s.ping_enabled ? "on" : "off"}\n` +
          `• mode: ${s.mode}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---------- ADD ----------
    if (sub === "add") {
      const role = interaction.options.getRole("role", true);
      const position = interaction.options.getInteger("position", true);

      await addRole(guildId, role.id, position);

      await interaction.reply({
        content: `✅ Ajout/maj: ${role} (position=${position})`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---------- REMOVE ----------
    if (sub === "remove") {
      const role = interaction.options.getRole("role", true);
      await removeRole(guildId, role.id);

      await interaction.reply({
        content: `✅ Retiré de l’échelle: ${role}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---------- LIST ----------
    if (sub === "list") {
      const roles = await listRoles(guildId);
      if (!roles.length) {
        await interaction.reply({
          content: "Aucun ModRank configuré. Utilise `/modrank add`.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const lines = roles.map((r) => `• \`${r.position}\` — <@&${r.role_id}>`).join("\n");

      await interaction.reply({
        content: `**Échelle ModRank**\n${lines}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---------- MOVE ----------
    if (sub === "move") {
      const role = interaction.options.getRole("role", true);
      const direction = interaction.options.getString("direction", true);

      const res = await moveRole(guildId, role.id, direction);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.msg}`, flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.reply({
        content: `✅ Déplacé: ${role} (${direction})`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // Actions membre
    const targetUser = interaction.options.getUser("membre", true);
    const reason = interaction.options.getString("motif") || null;
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({
        content: "Membre introuvable (probablement pas sur le serveur).",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const scale = await listRoles(guildId);
    if (!scale.length) {
      await interaction.reply({
        content: "Aucun ModRank configuré. Utilise `/modrank add`.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const roleIdsInScale = scale.map((r) => r.role_id);

    // ---------- INFO ----------
    if (sub === "info") {
      const currentRoleId = await getCurrentModrankRoleId(targetMember, roleIdsInScale);
      const idx = currentRoleId ? roleIdsInScale.indexOf(currentRoleId) : -1;

      const current = currentRoleId ? `<@&${currentRoleId}>` : "—";
      const next = idx >= 0 && idx < roleIdsInScale.length - 1 ? `<@&${roleIdsInScale[idx + 1]}>` : "—";
      const prev = idx > 0 ? `<@&${roleIdsInScale[idx - 1]}>` : "—";

      await interaction.reply({
        content:
          `**ModRank — ${targetUser}**\n` +
          `• actuel: ${current}\n` +
          `• précédent: ${prev}\n` +
          `• suivant: ${next}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---------- SET ----------
    if (sub === "set") {
      const role = interaction.options.getRole("role", true);

      // Vérifier que le rôle appartient à l’échelle ModRank
      const inScale = roleIdsInScale.includes(role.id);
      if (!inScale) {
        await interaction.reply({
          content: "⚠️ Ce rôle n’est pas dans l’échelle ModRank. Ajoute-le via `/modrank add`.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const res = await applyModrank({
        interaction,
        client,
        targetMember,
        newRoleId: role.id,
        reason,
        actionLabel: "Ajustement",
      });

      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.msg}`, flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.reply({
        content: `✅ Rang défini. (ref: ${res.refId})`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---------- UP / DOWN ----------
    const currentRoleId = await getCurrentModrankRoleId(targetMember, roleIdsInScale);
    const idx = currentRoleId ? roleIdsInScale.indexOf(currentRoleId) : -1;

    if (sub === "up") {
      const newIdx = idx === -1 ? 0 : idx + 1;
      if (newIdx >= roleIdsInScale.length) {
        await interaction.reply({
          content: "⚠️ Ce membre est déjà au rang le plus haut.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const res = await applyModrank({
        interaction,
        client,
        targetMember,
        newRoleId: roleIdsInScale[newIdx],
        reason,
        actionLabel: "Promotion",
      });

      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.msg}`, flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.reply({
        content: `✅ Promotion effectuée. (ref: ${res.refId})`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (sub === "down") {
      const newIdx = idx === -1 ? -1 : idx - 1;
      if (newIdx < 0) {
        // si aucun rang, ou déjà au plus bas => on retire les ranks (mode highest) ? on reste simple
        await interaction.reply({
          content: "⚠️ Ce membre n’a pas de rang ModRank à rétrograder (ou déjà au plus bas).",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const res = await applyModrank({
        interaction,
        client,
        targetMember,
        newRoleId: roleIdsInScale[newIdx],
        reason,
        actionLabel: "Rétrogradation",
      });

      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.msg}`, flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.reply({
        content: `✅ Rétrogradation effectuée. (ref: ${res.refId})`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.reply({
      content: "Commande inconnue.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const commands = buildCommands();

  return {
    commands,
    handleInteraction,
  };
}

module.exports = { createModrankService };
