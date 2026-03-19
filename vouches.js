const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");

function hoursBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

function createVouchesService({ pool, config, rankup }) {
  /* -------------------------------
     Slash commands (vouches)
  -------------------------------- */
  const commands = [
    new SlashCommandBuilder()
      .setName("vouch")
      .setDescription("Ajoute un vouch à un membre")
      .addUserOption((opt) =>
        opt.setName("membre").setDescription("La personne à vouch").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("note")
          .setDescription("Ton message (ex: 'Super fiable, transaction nickel')")
          .setRequired(true)
          .setMaxLength(300)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("rating")
          .setDescription("Note 1 à 5 (par défaut 5)")
          .setMinValue(1)
          .setMaxValue(5)
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("vouches")
      .setDescription("Affiche les vouches d'un membre (privé)")
      .addUserOption((opt) =>
        opt.setName("membre").setDescription("La personne").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("topvouches")
      .setDescription("Classement des membres les plus vouch (privé)")
      .addIntegerOption((opt) =>
        opt
          .setName("limit")
          .setDescription("Nombre de lignes (max 10)")
          .setMinValue(3)
          .setMaxValue(10)
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("setvouchboard")
      .setDescription("Crée (ou déplace) le message de classement auto dans ce salon")
      .addIntegerOption((opt) =>
        opt
          .setName("limit")
          .setDescription("Top N (max 10)")
          .setMinValue(3)
          .setMaxValue(10)
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("removevouchboard")
      .setDescription("Désactive la mise à jour auto du classement des vouchs"),

    // ✅ nouveau : config par serveur
    new SlashCommandBuilder()
      .setName("vouch-config")
      .setDescription("Configure les vouches sur ce serveur")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName("setchannel")
          .setDescription("Définit le salon où les vouches sont autorisés")
          .addChannelOption((opt) =>
            opt
              .setName("salon")
              .setDescription("Salon autorisé pour /vouch")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("clearchannel")
          .setDescription("Retire la restriction (vouch possible partout)")
      ),
  ];

  /* -------------------------------
     VOUCH SETTINGS (par serveur)
  -------------------------------- */
  async function getVouchSettings(guildId) {
    const res = await pool.query(
      `SELECT vouch_channel_id FROM vouch_settings WHERE guild_id=$1 LIMIT 1`,
      [guildId]
    );
    return res.rows[0] || { vouch_channel_id: null };
  }

  async function setVouchChannel(guildId, channelId) {
    await pool.query(
      `
      INSERT INTO vouch_settings (guild_id, vouch_channel_id)
      VALUES ($1,$2)
      ON CONFLICT (guild_id) DO UPDATE
      SET vouch_channel_id=EXCLUDED.vouch_channel_id,
          updated_at=NOW()
      `,
      [guildId, channelId]
    );
  }

  async function clearVouchChannel(guildId) {
    await pool.query(
      `
      INSERT INTO vouch_settings (guild_id, vouch_channel_id)
      VALUES ($1, NULL)
      ON CONFLICT (guild_id) DO UPDATE
      SET vouch_channel_id=NULL,
          updated_at=NOW()
      `,
      [guildId]
    );
  }

  // Retourne le salon autorisé:
  // 1) DB par serveur
  // 2) fallback ENV global (config.VOUCH_CHANNEL_ID)
  async function getAllowedVouchChannelId(guildId) {
    const s = await getVouchSettings(guildId);
    return s?.vouch_channel_id || config.VOUCH_CHANNEL_ID || null;
  }

  /* -------------------------------
     VOUCHBOARD (embed auto-refresh)
  -------------------------------- */
  async function getVouchboardConfig(guildId) {
    const res = await pool.query(
      `SELECT channel_id, message_id, limit_count FROM vouchboard WHERE guild_id=$1 LIMIT 1`,
      [guildId]
    );
    return res.rows[0] || null;
  }

  async function saveVouchboardConfig(guildId, channelId, messageId, limitCount) {
    await pool.query(
      `
      INSERT INTO vouchboard (guild_id, channel_id, message_id, limit_count)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (guild_id) DO UPDATE
      SET channel_id=EXCLUDED.channel_id,
          message_id=EXCLUDED.message_id,
          limit_count=EXCLUDED.limit_count,
          updated_at=NOW()
      `,
      [guildId, channelId, messageId, limitCount]
    );
  }

  async function removeVouchboardConfig(guildId) {
    await pool.query(`DELETE FROM vouchboard WHERE guild_id=$1`, [guildId]);
  }

  async function fetchTopVouches(guildId, limit = 10) {
    const top = await pool.query(
      `
      SELECT vouched_id, COUNT(*)::int AS count, AVG(rating)::float AS avg
      FROM vouches
      WHERE guild_id=$1
      GROUP BY vouched_id
      ORDER BY count DESC
      LIMIT $2
      `,
      [guildId, limit]
    );
    return top.rows;
  }

  function buildVouchboardEmbed(rows, limit) {
    const desc = rows.length
      ? rows
          .map((r, i) => {
            const avg = r.avg ? r.avg.toFixed(2) : "N/A";
            return `**${i + 1}.** <@${r.vouched_id}> — **${r.count}** vouches — **${avg}/5**`;
          })
          .join("\n")
      : "Aucun vouch pour le moment.";

    return new EmbedBuilder()
      .setTitle("🏆 Classement des vouchs")
      .setDescription(desc)
      .setFooter({
        text: `Top ${limit} • Mise à jour toutes les ${Math.round(
          config.VOUCHBOARD_REFRESH_MS / 1000
        )}s`,
      })
      .setTimestamp();
  }

  async function updateVouchboardMessage(client, guildId) {
    const cfg = await getVouchboardConfig(guildId);
    if (!cfg) return;

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const limit = Math.max(3, Math.min(10, Number(cfg.limit_count) || 10));
    const rows = await fetchTopVouches(guildId, limit);
    const embed = buildVouchboardEmbed(rows, limit);

    let msg = await channel.messages.fetch(cfg.message_id).catch(() => null);

    // Message supprimé => on le recrée
    if (!msg) {
      msg = await channel.send({ embeds: [embed] });
      await saveVouchboardConfig(guildId, channel.id, msg.id, limit);
      return;
    }

    await msg.edit({ embeds: [embed] });
  }

  let vouchboardInterval = null;

  function startGlobalVouchboardUpdater(client) {
    if (vouchboardInterval) return vouchboardInterval;
    vouchboardInterval = setInterval(async () => {
      for (const g of client.guilds.cache.values()) {
        updateVouchboardMessage(client, g.id).catch((e) =>
          console.error("updateVouchboardMessage:", e)
        );
      }
    }, config.VOUCHBOARD_REFRESH_MS);
    return vouchboardInterval;
  }

  function stopGlobalVouchboardUpdater() {
    if (!vouchboardInterval) return;
    clearInterval(vouchboardInterval);
    vouchboardInterval = null;
  }

  /* -------------------------------
     Handlers (commands)
  -------------------------------- */
  async function handleInteraction(interaction, client) {
    const name = interaction.commandName;

    // /vouch-config
    if (name === "vouch-config") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "⚠️ Cette commande marche dans un serveur.",
          ephemeral: true,
        });
        return true;
      }

      const sub = interaction.options.getSubcommand(true);

      if (sub === "setchannel") {
        const channel = interaction.options.getChannel("salon", true);

        if (!channel.isTextBased()) {
          await interaction.reply({
            content: "⚠️ Choisis un salon texte (pas vocal).",
            ephemeral: true,
          });
          return true;
        }

        await setVouchChannel(interaction.guildId, channel.id);

        await interaction.reply({
          content: `✅ Salon vouch défini sur ${channel} pour ce serveur.`,
          ephemeral: true,
        });
        return true;
      }

      if (sub === "clearchannel") {
        await clearVouchChannel(interaction.guildId);

        await interaction.reply({
          content: "✅ Restriction retirée : /vouch est possible partout sur ce serveur.",
          ephemeral: true,
        });
        return true;
      }

      return false;
    }

    // /setvouchboard
    if (name === "setvouchboard") {
      if (
        !interaction.memberPermissions ||
        !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
      ) {
        await interaction.reply({
          content: "⛔ Il faut la permission **Gérer le serveur** pour faire ça.",
          ephemeral: true,
        });
        return true;
      }

      const limit = interaction.options.getInteger("limit") ?? 10;
      const rows = await fetchTopVouches(interaction.guildId, limit);
      const embed = buildVouchboardEmbed(rows, limit);

      const msg = await interaction.channel.send({ embeds: [embed] });
      await saveVouchboardConfig(interaction.guildId, interaction.channelId, msg.id, limit);

      await interaction.reply({
        content: `✅ Vouchboard créé ici.\nIl sera mis à jour toutes les ${Math.round(
          config.VOUCHBOARD_REFRESH_MS / 1000
        )}s.`,
        ephemeral: true,
      });
      return true;
    }

    // /removevouchboard
    if (name === "removevouchboard") {
      if (
        !interaction.memberPermissions ||
        !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
      ) {
        await interaction.reply({
          content: "⛔ Il faut la permission **Gérer le serveur** pour faire ça.",
          ephemeral: true,
        });
        return true;
      }

      await removeVouchboardConfig(interaction.guildId);
      await interaction.reply({
        content: "✅ Vouchboard désactivé (plus de mises à jour auto).",
        ephemeral: true,
      });
      return true;
    }

    // /vouch
    if (name === "vouch") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "⚠️ Cette commande marche dans un serveur.",
          ephemeral: true,
        });
        return true;
      }

      // ✅ restriction par serveur (DB) puis fallback ENV
      const allowedChannelId = await getAllowedVouchChannelId(interaction.guildId);
      if (allowedChannelId && interaction.channelId !== allowedChannelId) {
        await interaction.reply({
          content: `⚠️ Les vouchs se font uniquement dans <#${allowedChannelId}>.`,
          ephemeral: true,
        });
        return true;
      }

      const target = interaction.options.getUser("membre", true);
      const note = interaction.options.getString("note", true).trim();
      const rating = interaction.options.getInteger("rating") ?? 5;

      if (target.bot) {
        await interaction.reply({ content: "⚠️ Tu ne peux pas vouch un bot.", ephemeral: true });
        return true;
      }
      if (target.id === interaction.user.id) {
        await interaction.reply({
          content: "⚠️ Tu ne peux pas te vouch toi-même.",
          ephemeral: true,
        });
        return true;
      }
      if (note.length < 3) {
        await interaction.reply({
          content: "⚠️ Ta note est trop courte (min 3 caractères).",
          ephemeral: true,
        });
        return true;
      }

      // Anti-spam : 1 vouch par personne -> même cible toutes les 24h
      const last = await pool.query(
        `
        SELECT created_at
        FROM vouches
        WHERE guild_id=$1 AND voucher_id=$2 AND vouched_id=$3
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [interaction.guildId, interaction.user.id, target.id]
      );

      if (last.rows.length) {
        const lastDate = new Date(last.rows[0].created_at);
        if (hoursBetween(new Date(), lastDate) < 24) {
          await interaction.reply({
            content: "⏳ Tu as déjà vouch cette personne il y a moins de 24h.\nRéessaie plus tard.",
            ephemeral: true,
          });
          return true;
        }
      }

      await pool.query(
        `INSERT INTO vouches (guild_id, voucher_id, vouched_id, message, rating) VALUES ($1,$2,$3,$4,$5)`,
        [interaction.guildId, interaction.user.id, target.id, note, rating]
      );

      const stats = await pool.query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg FROM vouches WHERE guild_id=$1 AND vouched_id=$2`,
        [interaction.guildId, target.id]
      );

      const count = stats.rows[0].count;
      const avg = stats.rows[0].avg ? stats.rows[0].avg.toFixed(2) : "N/A";

      const embed = new EmbedBuilder()
        .setTitle("✅ Nouveau vouch")
        .setDescription(`**${interaction.user.tag}** a vouch **${target.tag}**`)
        .addFields(
          { name: "Note", value: note },
          { name: "Rating", value: `${rating}/5`, inline: true },
          { name: "Total vouches", value: `${count}`, inline: true },
          { name: "Moyenne", value: `${avg}/5`, inline: true }
        )
        .setTimestamp();

      // Update du vouchboard tout de suite
      updateVouchboardMessage(client, interaction.guildId).catch(() => {});

      // AUTO-RANKUP
      const guild = interaction.guild;
      if (guild) {
        const member = await guild.members.fetch(target.id).catch(() => null);
        if (member) {
          const r = await rankup
            .applyRankForMember(guild, member, "Auto rank (vouches)")
            .catch(() => null);

          if (r && r.changed) {
            const log = rankup.buildAutoRankLogEmbed(member.id, r);
            rankup.sendRankLog(guild, log).catch(() => {});
          }
        }
      }

      await interaction.reply({ embeds: [embed] });
      return true;
    }

    // /vouches (privé)
    if (name === "vouches") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "⚠️ Cette commande marche dans un serveur.",
          ephemeral: true,
        });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const target = interaction.options.getUser("membre", true);

      const stats = await pool.query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg FROM vouches WHERE guild_id=$1 AND vouched_id=$2`,
        [interaction.guildId, target.id]
      );

      const recent = await pool.query(
        `SELECT voucher_id, message, rating, created_at
         FROM vouches
         WHERE guild_id=$1 AND vouched_id=$2
         ORDER BY created_at DESC
         LIMIT 5`,
        [interaction.guildId, target.id]
      );

      const count = stats.rows[0].count;
      const avg = stats.rows[0].avg ? stats.rows[0].avg.toFixed(2) : "N/A";

      const lines = recent.rows.length
        ? recent.rows
            .map((r) => {
              return `• **${r.rating}/5** — <@${r.voucher_id}>\n> ${r.message}`;
            })
            .join("\n\n")
        : "Aucun vouch pour le moment.";

      const embed = new EmbedBuilder()
        .setTitle(`📌 Vouches de ${target.tag}`)
        .setDescription(lines)
        .addFields(
          { name: "Total", value: `${count}`, inline: true },
          { name: "Moyenne", value: `${avg}/5`, inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    // /topvouches (privé)
    if (name === "topvouches") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "⚠️ Cette commande marche dans un serveur.",
          ephemeral: true,
        });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const limit = interaction.options.getInteger("limit") ?? 5;

      const top = await pool.query(
        `
        SELECT vouched_id, COUNT(*)::int AS count, AVG(rating)::float AS avg
        FROM vouches
        WHERE guild_id=$1
        GROUP BY vouched_id
        ORDER BY count DESC
        LIMIT $2
        `,
        [interaction.guildId, limit]
      );

      if (!top.rows.length) {
        await interaction.editReply({
          content: "Aucun vouch dans ce serveur pour le moment.",
        });
        return true;
      }

      const desc = top.rows
        .map((r, i) => {
          const avg = r.avg ? r.avg.toFixed(2) : "N/A";
          return `**${i + 1}.** <@${r.vouched_id}> — **${r.count}** vouches — **${avg}/5**`;
        })
        .join("\n");

      const embed = new EmbedBuilder().setTitle("🏆 Top Vouches").setDescription(desc).setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    return false;
  }

  return {
    commands,
    handleInteraction,
    updateVouchboardMessage,
    startGlobalVouchboardUpdater,
    stopGlobalVouchboardUpdater,
  };
}

module.exports = { createVouchesService };
