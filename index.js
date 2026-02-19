const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");

const { Pool } = require("pg");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID
const GUILD_ID = process.env.GUILD_ID; // ID du serveur (pour enregistrer vite les slash commands)

// Optionnel : forcer les vouchs dans un salon précis
const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || null;

// Rafraîchissement du leaderboard auto (par défaut 60s)
const VOUCHBOARD_REFRESH_MS = Number(process.env.VOUCHBOARD_REFRESH_MS || 60000);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Variables manquantes. Ajoute DISCORD_TOKEN, CLIENT_ID, GUILD_ID.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL manquant. Ajoute une DB PostgreSQL sur Railway (ou définis DATABASE_URL)."
  );
  process.exit(1);
}

// Railway/Postgres : SSL souvent nécessaire en prod
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vouches (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      voucher_id TEXT NOT NULL,
      vouched_id TEXT NOT NULL,
      message TEXT NOT NULL,
      rating SMALLINT NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_vouches_guild_vouched ON vouches (guild_id, vouched_id);
    CREATE INDEX IF NOT EXISTS idx_vouches_guild_voucher_vouched ON vouches (guild_id, voucher_id, vouched_id);

    -- Message “classement” qui s’actualise
    CREATE TABLE IF NOT EXISTS vouchboard (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      limit_count INTEGER NOT NULL DEFAULT 10,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ DB prête (tables vouches + vouchboard OK).");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("ping").setDescription("Répond pong + latence"),

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
      .setDescription("Affiche les vouches d'un membre")
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

    // ✅ Commandes pour le message auto-refresh
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
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // Enregistrement GUILD (instantané). Global peut prendre du temps.
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });

  console.log("✅ Slash commands enregistrées sur le serveur.");
}

function hoursBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

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
        VOUCHBOARD_REFRESH_MS / 1000
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
  // Une boucle globale suffit (si un serveur n'a pas de board, updateVouchboardMessage return)
  setInterval(async () => {
    for (const g of client.guilds.cache.values()) {
      updateVouchboardMessage(client, g.id).catch((e) =>
        console.error("updateVouchboardMessage:", e)
      );
    }
  }, VOUCHBOARD_REFRESH_MS);
}

/* -------------------------------
   Bot lifecycle
-------------------------------- */

client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  try {
    await initDb();
    await registerCommands();

    // Update une première fois + lance la boucle 60s
    for (const g of client.guilds.cache.values()) {
      await updateVouchboardMessage(client, g.id).catch(() => {});
    }
    startGlobalVouchboardUpdater(client);
  } catch (err) {
    console.error("Erreur au démarrage:", err);
    process.exit(1);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /ping
  if (interaction.commandName === "ping") {
    const sent = await interaction.reply({ content: "pong 🏓", fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    return interaction.editReply(`pong 🏓 (latence: ${latency}ms)`);
  }

  // /setvouchboard
  if (interaction.commandName === "setvouchboard") {
    if (
      !interaction.memberPermissions ||
      !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer le serveur** pour faire ça.",
        ephemeral: true,
      });
    }

    const limit = interaction.options.getInteger("limit") ?? 10;
    const rows = await fetchTopVouches(interaction.guildId, limit);
    const embed = buildVouchboardEmbed(rows, limit);

    const msg = await interaction.channel.send({ embeds: [embed] });

    await saveVouchboardConfig(interaction.guildId, interaction.channelId, msg.id, limit);

    return interaction.reply({
      content: `✅ Vouchboard créé ici. Il sera mis à jour toutes les ${Math.round(
        VOUCHBOARD_REFRESH_MS / 1000
      )}s.`,
      ephemeral: true,
    });
  }

  // /removevouchboard
  if (interaction.commandName === "removevouchboard") {
    if (
      !interaction.memberPermissions ||
      !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer le serveur** pour faire ça.",
        ephemeral: true,
      });
    }

    await removeVouchboardConfig(interaction.guildId);
    return interaction.reply({
      content: "✅ Vouchboard désactivé (plus de mises à jour auto).",
      ephemeral: true,
    });
  }

  // /vouch
  if (interaction.commandName === "vouch") {
    // Optionnel : forcer un salon
    if (VOUCH_CHANNEL_ID && interaction.channelId !== VOUCH_CHANNEL_ID) {
      return interaction.reply({
        content: `⚠️ Les vouchs se font uniquement dans <#${VOUCH_CHANNEL_ID}>.`,
        ephemeral: true,
      });
    }

    const target = interaction.options.getUser("membre", true);
    const note = interaction.options.getString("note", true).trim();
    const rating = interaction.options.getInteger("rating") ?? 5;

    if (!interaction.guildId) {
      return interaction.reply({
        content: "⚠️ Cette commande marche dans un serveur.",
        ephemeral: true,
      });
    }
    if (target.bot) {
      return interaction.reply({ content: "⚠️ Tu ne peux pas vouch un bot.", ephemeral: true });
    }
    if (target.id === interaction.user.id) {
      return interaction.reply({
        content: "⚠️ Tu ne peux pas te vouch toi-même.",
        ephemeral: true,
      });
    }
    if (note.length < 3) {
      return interaction.reply({
        content: "⚠️ Ta note est trop courte (min 3 caractères).",
        ephemeral: true,
      });
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
        return interaction.reply({
          content: "⏳ Tu as déjà vouch cette personne il y a moins de 24h. Réessaie plus tard.",
          ephemeral: true,
        });
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

    // ✅ Optionnel mais utile : update du vouchboard tout de suite (sans attendre 60s)
    updateVouchboardMessage(client, interaction.guildId).catch(() => {});

    // 🔁 Si tu veux que /vouch soit PUBLIC, laisse comme ça (pas d'ephemeral).
    // Si tu veux qu'il soit privé, ajoute: ephemeral: true
    return interaction.reply({ embeds: [embed] });
  }

  // /vouches  ✅✅✅ PRIVÉ (EPHEMERAL) : visible uniquement par l'utilisateur qui exécute la commande
  if (interaction.commandName === "vouches") {
    if (!interaction.guildId) {
      return interaction.reply({
        content: "⚠️ Cette commande marche dans un serveur.",
        ephemeral: true,
      });
    }

    // Important : on répond tout de suite en EPHEMERAL (évite timeout + reste 100% privé)
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

    // On édite la réponse deferred (elle reste EPHEMERAL)
    return interaction.editReply({ embeds: [embed] });
  }

  // /topvouches
  if (interaction.commandName === "topvouches") {
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
      return interaction.reply({ content: "Aucun vouch dans ce serveur pour le moment." });
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

    return interaction.reply({ embeds: [embed] });
  }
});

client.login(TOKEN);
