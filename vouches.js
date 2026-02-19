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
      .setDescription("Classement des membres les plus vouch")
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
  ];

  /* -------------------------------
     VOUCHBOARD (embed auto-refresh)
  -------------------------------- */

  async function getVouchboardConfig(guildId) {
    const res = await pool.query(
      `SELECT channel_id, message_id, limit_count
       FROM vouchboard
       WHERE guild_id=$1
       LIMIT 1`,
      [guildId]
    );
    return res.rows[0] || null;
  }

  async function saveVouchboardConfig(guildId, channelId, messageId, limitCount) {
    await pool.query(
      `INSERT INTO vouchboard (guild_id, channel_id, message_id, limit_count)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id) DO UPDATE
         SET channel_id=EXCLUDED.channel_id,
             message_id=EXCLUDED.message_id,
             limit_count=EXCLUDED.limit_count,
             updated_at=NOW()`,
      [guildId, channelId, messageId, limitCount]
    );
  }

  async function removeVouchboardConfig(guildId) {
    await pool.query(`DELETE FROM vouchboard WHERE guild_id=$1`, [guildId]);
  }

  async function fetchTopVouches(guildId, limit = 10) {
    const top = await pool.query(
      `SELECT vouched_id, COUNT(*)::int AS count, AVG(rating)::float AS avg
       FROM vouches
       WHERE guild_id=$1
       GROUP BY vouched_id
       ORDER BY count DESC
       LIMIT $2`,
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
    if (!cfg) return; // pas configuré

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const limit = Math.max(3, Math.min(10, Number(cfg.limit_count) || 10));
    const rows = await fetchTopVouches(guildId, limit);
    const embed = buildVouchboardEmbed(rows, limit);

    let msg = await channel.messages.fetch(cfg.message_id).catch(() => null);

    // Si le message a été supprimé, on le recrée et on met à jour la config
    if (!msg) {
      msg = await channel.send({ embeds: [embed] });
      await saveVouchboardConfig(guildId, channel.id, msg.id, limit);
      return;
    }

    await msg.edit({ embeds: [embed] });
  }

  function startGlobalVouchboardUpdater(client) {
    setInterval(async () => {
      for (const g of client.guilds.cache.values()) {
        updateVouchboardMessage(client, g.id).catch((e) =>
          console.error("updateVouchboardMessage:", e)
        );
      }
    }, config.VOUCHBOARD_REFRESH_MS);
  }

  /* -------------------------------
     Handlers (commands)
  -------------------------------- */

  async function handleInteraction(interaction, client) {
    const name = interaction.commandName;

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
        content: `✅ Vouchboard créé ici. Il sera mis à jour toutes les ${Math.round(
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
      if (config.VOUCH_CHANNEL_ID && interaction.channelId !== config.VOUCH_CHANNEL_ID) {
        await interaction.reply({
          content: `⚠️ Les vouchs se font uniquement dans <#${config.VOUCH_CHANNEL_ID}>.`,
          ephemeral: true,
        });
        return true;
      }

      const target = interaction.options.getUser("membre", true);
      const note = interaction.options.getString("note", true).trim();
      const rating = interaction.options.getInteger("rating") ?? 5;

      if (!interaction.guildId) {
        await interaction.reply({ content: "⚠️ Cette commande marche dans un serveur.", ephemeral: true });
        return true;
      }
      if (target.bot) {
        await interaction.reply({ content: "⚠️ Tu ne peux pas vouch un bot.", ephemeral: true });
        return true;
      }
      if (target.id === interaction.user.id) {
        await interaction.reply({ content: "⚠️ Tu ne peux pas te vouch toi-même.", ephemeral: true });
        return true;
      }
      if (note.length < 3) {
        await interaction.reply({ content: "⚠️ Ta note est trop courte (min 3 caractères).", ephemeral: true });
        return true;
      }

      // Anti-spam : 1 vouch par personne -> même cible toutes les 24h
      const last = await pool.query(
        `SELECT created_at FROM vouches
         WHERE guild_id=$1 AND voucher_id=$2 AND vouched_id=$3
         ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, interaction.user.id, target.id]
      );

      if (last.rows.length) {
        const lastDate = new Date(last.rows[0].created_at);
        if (hoursBetween(new Date(), lastDate) < 24) {
          await interaction.reply({
            content: "⏳ Tu as déjà vouch cette personne il y a moins de 24h. Réessaie plus tard.",
            ephemeral: true,
          });
          return true;
        }
      }

      await pool.query(
        `INSERT INTO vouches (guild_id, voucher_id, vouched_id, message, rating)
         VALUES ($1,$2,$3,$4,$5)`,
        [interaction.guildId, interaction.user.id, target.id, note, rating]
      );

      const stats = await pool.query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg
         FROM vouches WHERE guild_id=$1 AND vouched_id=$2`,
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

      // AUTO-RANKUP (si config rank_roles existe)
      const guild = interaction.guild;
      if (guild) {
        const member = await guild.members.fetch(target.id).catch(() => null);
        if (member) {
          const r = await rankup.applyRankForMember(guild, member, "Auto rank (vouches)").catch(() => null);
          if (r && r.changed) {
            const log = rankup.buildAutoRankLogEmbed(member.id, r);
            rankup.sendRankLog(guild, log).catch(() => {});
          }
        }
      }

      await interaction.reply({ embeds: [embed] });
      return true;
    }

    // /vouches  ✅ PRIVÉ (EPHEMERAL)
    if (name === "vouches") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "⚠️ Cette commande marche dans un serveur.", ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      const target = interaction.options.getUser("membre", true);

      const stats = await pool.query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg
         FROM vouches WHERE guild_id=$1 AND vouched_id=$2`,
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
              const when = `<t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`;
              return `• **${r.rating}/5** — <@${r.voucher_id}> — ${when}\n> ${r.message}`;
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

// /topvouches ✅ PRIVÉ (EPHEMERAL)
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
    `SELECT vouched_id, COUNT(*)::int AS count, AVG(rating)::float AS avg
     FROM vouches
     WHERE guild_id=$1
     GROUP BY vouched_id
     ORDER BY count DESC
     LIMIT $2`,
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

  const embed = new EmbedBuilder()
    .setTitle("🏆 Top Vouches")
    .setDescription(desc)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  return true;
}

    return false; // pas géré ici
  }

  return {
    commands,
    handleInteraction,
    updateVouchboardMessage,
    startGlobalVouchboardUpdater,
  };
}

module.exports = { createVouchesService };
