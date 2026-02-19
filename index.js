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

// Rankup: si "true", garde tous les rôles de rank en dessous (stack).
// Sinon (défaut), garde uniquement le rôle de rank le plus haut.
const RANKUP_STACK = (process.env.RANKUP_STACK || "false").toLowerCase() === "true";

// Optionnel : salon de logs (rankup/rankdown/auto-rank)
const RANKUP_LOG_CHANNEL_ID = process.env.RANKUP_LOG_CHANNEL_ID || null;

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

    -- Rank roles (basés sur le nombre de vouches)
    CREATE TABLE IF NOT EXISTS rank_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      required_vouches INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rank_roles_guild_required ON rank_roles (guild_id, required_vouches);
  `);
  console.log("✅ DB prête (tables vouches + vouchboard + rank_roles OK).");
}

const client = new Client({
  // GuildMembers utile pour gérer les rôles (assure-toi d'activer l'intent "Server Members Intent" dans le Dev Portal)
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
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

    /* -------------------------------
       RANKUP (modération)
    -------------------------------- */

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

async function sendRankLog(guild, embed) {
  if (!RANKUP_LOG_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(RANKUP_LOG_CHANNEL_ID).catch(() => null);
  if (ch && ch.isTextBased()) ch.send({ embeds: [embed] }).catch(() => {});
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
      text: `Top ${limit} • Mise à jour toutes les ${Math.round(VOUCHBOARD_REFRESH_MS / 1000)}s`,
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
  }, VOUCHBOARD_REFRESH_MS);
}

/* -------------------------------
   RANKUP (roles basés sur vouches)
-------------------------------- */

async function fetchRankRoles(guildId) {
  const res = await pool.query(
    `SELECT role_id, required_vouches
     FROM rank_roles
     WHERE guild_id=$1
     ORDER BY required_vouches ASC, role_id ASC`,
    [guildId]
  );
  return res.rows; // [{role_id, required_vouches}]
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
  await pool.query(
    `DELETE FROM rank_roles WHERE guild_id=$1 AND role_id=$2`,
    [guildId, roleId]
  );
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
  // rankRoles triés ASC; on récupère les rôles <= vouchCount
  const eligible = rankRoles.filter((r) => Number(r.required_vouches) <= Number(vouchCount));
  if (!eligible.length) return { highest: null, stack: [] };

  const highest = eligible[eligible.length - 1];
  const stack = eligible.map((r) => r.role_id);
  return { highest, stack };
}

function canManageRole(meMember, role) {
  // Le bot doit avoir un rôle plus haut que le rôle à gérer
  if (!meMember || !role) return false;
  return meMember.roles.highest.comparePositionTo(role) > 0;
}

async function applyRankForMember(guild, member, reason = "Rank sync") {
  const guildId = guild.id;
  const rankRoles = await fetchRankRoles(guildId);

  if (!rankRoles.length) {
    return { changed: false, message: "Aucun rang configuré." };
  }

  const vouchCount = await getVouchCountFor(guildId, member.id);
  const { highest, stack } = computeEligibleRankRoles(rankRoles, vouchCount);

  const configuredRoleIds = new Set(rankRoles.map((r) => r.role_id));
  const me = await guild.members.fetchMe().catch(() => null);

  // roles existants du membre parmi les ranks configurés
  const currentRankRoleIds = member.roles.cache
    .filter((r) => configuredRoleIds.has(r.id))
    .map((r) => r.id);

  const wantedRoleIds = new Set();
  if (highest) {
    if (RANKUP_STACK) stack.forEach((id) => wantedRoleIds.add(id));
    else wantedRoleIds.add(highest.role_id);
  }

  const toRemove = currentRankRoleIds.filter((id) => !wantedRoleIds.has(id));
  const toAdd = [...wantedRoleIds].filter((id) => !currentRankRoleIds.includes(id));

  // Vérif manage roles
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

  const changed = toRemove.length > 0 || toAdd.length > 0;

  return {
    changed,
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

  // On considère l'ordre par required_vouches ASC
  const idsOrdered = rankRoles.map((r) => r.role_id);
  const configuredSet = new Set(idsOrdered);

  // Trouve le rang actuel (le plus haut selon l'ordre config)
  let currentIndex = -1;
  for (let i = 0; i < idsOrdered.length; i++) {
    const rid = idsOrdered[i];
    if (member.roles.cache.has(rid)) currentIndex = i;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0) return { ok: false, message: "Déjà au rang le plus bas (ou aucun rang)." };
  if (nextIndex >= idsOrdered.length) return { ok: false, message: "Déjà au rang le plus haut." };

  const me = await guild.members.fetchMe().catch(() => null);

  const nextRoleId = idsOrdered[nextIndex];
  const nextRole = guild.roles.cache.get(nextRoleId) || (await guild.roles.fetch(nextRoleId).catch(() => null));
  if (!nextRole) return { ok: false, message: "Rôle introuvable (supprimé ?). Retire-le avec /rank-remove." };
  if (!canManageRole(me, nextRole)) {
    return { ok: false, message: "Je ne peux pas attribuer ce rôle (hiérarchie/permissions)." };
  }

  const allRankRoleIds = member.roles.cache
    .filter((r) => configuredSet.has(r.id))
    .map((r) => r.id);

  // Si stack: on veut tous les rangs <= nextIndex
  // Sinon: uniquement nextRoleId
  const wanted = new Set();
  if (RANKUP_STACK) {
    for (let i = 0; i <= nextIndex; i++) wanted.add(idsOrdered[i]);
  } else {
    wanted.add(nextRoleId);
  }

  const toRemove = allRankRoleIds.filter((id) => !wanted.has(id));
  const toAdd = [...wanted].filter((id) => !member.roles.cache.has(id));

  for (const rid of [...toRemove, ...toAdd]) {
    const role = guild.roles.cache.get(rid) || (await guild.roles.fetch(rid).catch(() => null));
    if (!role) continue;
    if (!canManageRole(me, role)) {
      return { ok: false, message: "Je ne peux pas gérer un des rôles (hiérarchie)." };
    }
  }

  if (toRemove.length) await member.roles.remove(toRemove, "Manual rank step").catch(() => {});
  if (toAdd.length) await member.roles.add(toAdd, "Manual rank step").catch(() => {});

  return { ok: true, nextRoleId, toAdd, toRemove };
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

    // Update du vouchboard tout de suite
    updateVouchboardMessage(client, interaction.guildId).catch(() => {});

    // AUTO-RANKUP (si config rank_roles existe)
    const guild = interaction.guild;
    if (guild) {
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (member) {
        const r = await applyRankForMember(guild, member, "Auto rank (vouches)").catch(() => null);
        if (r && r.changed) {
          const log = new EmbedBuilder()
            .setTitle("⬆️ Auto Rank (vouches)")
            .setDescription(`Mise à jour des ranks pour <@${member.id}>`)
            .addFields(
              { name: "Vouches", value: `${r.vouchCount ?? "?"}`, inline: true },
              { name: "Ajoutés", value: r.toAdd?.length ? r.toAdd.map((id) => `<@&${id}>`).join(" ") : "Aucun", inline: false },
              { name: "Retirés", value: r.toRemove?.length ? r.toRemove.map((id) => `<@&${id}>`).join(" ") : "Aucun", inline: false }
            )
            .setTimestamp();
          sendRankLog(guild, log).catch(() => {});
        }
      }
    }

    // Public (comme tu avais)
    return interaction.reply({ embeds: [embed] });
  }

  // /vouches  ✅ PRIVÉ (EPHEMERAL)
  if (interaction.commandName === "vouches") {
    if (!interaction.guildId) {
      return interaction.reply({
        content: "⚠️ Cette commande marche dans un serveur.",
        ephemeral: true,
      });
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

  /* -------------------------------
     RANKUP COMMANDS (MOD)
  -------------------------------- */

  // helper permission
  function mustBeMod() {
    return (
      interaction.memberPermissions &&
      interaction.memberPermissions.has(PermissionsBitField.Flags.ManageRoles)
    );
  }

  // /rank-add
  if (interaction.commandName === "rank-add") {
    if (!mustBeMod()) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.",
        ephemeral: true,
      });
    }

    const role = interaction.options.getRole("role", true);
    const vouches = interaction.options.getInteger("vouches", true);

    await upsertRankRole(interaction.guildId, role.id, vouches);

    return interaction.reply({
      content: `✅ Rang enregistré : ${role} à **${vouches}** vouches.`,
      ephemeral: true,
    });
  }

  // /rank-remove
  if (interaction.commandName === "rank-remove") {
    if (!mustBeMod()) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.",
        ephemeral: true,
      });
    }

    const role = interaction.options.getRole("role", true);
    await removeRankRole(interaction.guildId, role.id);

    return interaction.reply({
      content: `✅ Rang retiré de la config : ${role}`,
      ephemeral: true,
    });
  }

  // /rank-list
  if (interaction.commandName === "rank-list") {
    const ranks = await fetchRankRoles(interaction.guildId);

    if (!ranks.length) {
      return interaction.reply({
        content: "Aucun rang configuré. Utilise **/rank-add**.",
        ephemeral: true,
      });
    }

    const desc = ranks
      .map((r) => `• **${r.required_vouches}** vouches → <@&${r.role_id}>`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("📈 Rangs (vouches → rôle)")
      .setDescription(desc)
      .setFooter({ text: `Mode: ${RANKUP_STACK ? "STACK (tous les rangs)" : "HIGHEST (rang max seulement)"}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // /rank-sync
  if (interaction.commandName === "rank-sync") {
    if (!mustBeMod()) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.",
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser("membre", true);
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.editReply("⚠️ Membre introuvable.");

    const res = await applyRankForMember(guild, member, "Rank sync (mod)");
    if (!res || res.message) {
      return interaction.editReply(`⚠️ ${res?.message || "Erreur lors du sync."}`);
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

    return interaction.editReply({ embeds: [embed] });
  }

  // /rankup (manuel)
  if (interaction.commandName === "rankup") {
    if (!mustBeMod()) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.",
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser("membre", true);
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.editReply("⚠️ Membre introuvable.");

    const res = await manualRankStep(guild, member, +1);
    if (!res.ok) return interaction.editReply(`⚠️ ${res.message}`);

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
    return interaction.editReply({ embeds: [embed] });
  }

  // /rankdown (manuel)
  if (interaction.commandName === "rankdown") {
    if (!mustBeMod()) {
      return interaction.reply({
        content: "⛔ Il faut la permission **Gérer les rôles** pour faire ça.",
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser("membre", true);
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "⚠️ Serveur introuvable.", ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.editReply("⚠️ Membre introuvable.");

    const res = await manualRankStep(guild, member, -1);
    if (!res.ok) return interaction.editReply(`⚠️ ${res.message}`);

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
    return interaction.editReply({ embeds: [embed] });
  }
});

client.login(TOKEN);
