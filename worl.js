// worl.js — WorL Trade Assist (Variante 2) : /worl -> bouton Trade -> 2 étapes (message) -> sondage W/L

const crypto = require("crypto");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

// Sessions temporaires (en mémoire) : 1 créateur -> 1 setup à la fois par guild/channel
// Note: les sondages eux sont persistés en DB.
const setupSessions = new Map(); // key = `${guildId}:${channelId}:${userId}` -> { step, tradeText, startedAt }

function makeKey(guildId, channelId, userId) {
  return `${guildId}:${channelId}:${userId}`;
}

function nowMs() {
  return Date.now();
}

function safeTrim(s, max = 900) {
  if (!s) return "";
  s = String(s).trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function percent(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

async function ensureDb(pool) {
  // Tables WorL (idempotent). Appelées aussi depuis index.js, mais safe si double.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worl_polls (
      poll_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'trade',
      trade_text TEXT NOT NULL,
      contre_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_worl_polls_guild_status ON worl_polls (guild_id, status);

    CREATE TABLE IF NOT EXISTS worl_votes (
      poll_id TEXT NOT NULL REFERENCES worl_polls(poll_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('W','L')),
      voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (poll_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worl_votes_poll ON worl_votes (poll_id);
  `);
}

function buildCreatorEmbed(guild) {
  const e = new EmbedBuilder()
    .setTitle("🧊 WorL — Créateur de sondage")
    .setDescription(
      [
        "**Choisis un mode :**",
        "💱 **Trade** → format Marketplace `Je trade` / `Contre`",
        "",
        "_Ensuite je te guide en 2 étapes (sans modal lourd)._",
      ].join("\n")
    )
    .setThumbnail(guild?.iconURL?.({ size: 256 }) || null)
    .setFooter({ text: "Mino Bot • WorL" });
  return e;
}

function buildTradePromptEmbed(step, guild) {
  const e = new EmbedBuilder()
    .setTitle(`💱 Trade Setup (${step}/2)`)
    .setThumbnail(guild?.iconURL?.({ size: 256 }) || null)
    .setFooter({ text: "Mino Bot • WorL • réponds dans le chat" });

  if (step === 1) {
    e.setDescription(
      [
        "Écris **ce que tu trades**.",
        "",
        "Exemple : `2x Brainrot Rare + 50k`",
        "",
        "👉 Tu peux annuler en tapant : `cancel`",
      ].join("\n")
    );
  } else {
    e.setDescription(
      [
        "Écris **ce que tu veux en échange**.",
        "",
        "Exemple : `1x Brainrot Mythic`",
        "",
        "👉 Tu peux annuler en tapant : `cancel`",
      ].join("\n")
    );
  }
  return e;
}

function buildPollEmbed({ guild, creatorId, tradeText, contreText, wCount, lCount }) {
  const total = wCount + lCount;

  const e = new EmbedBuilder()
    .setTitle("💱 Trade Check — W or L ?")
    .setDescription(`Posté par <@${creatorId}>`)
    .addFields(
      { name: "🧊 Je trade :", value: tradeText || "—", inline: false },
      { name: "⚔️ Contre :", value: contreText || "—", inline: false },
      {
        name: "📊 Résultats",
        value: `✅ W: **${wCount}** (${percent(wCount, total)})  |  ❌ L: **${lCount}** (${percent(lCount, total)})  |  Total: **${total}**`,
        inline: false,
      }
    )
    .setThumbnail(guild?.iconURL?.({ size: 256 }) || null)
    .setFooter({ text: "Mino Bot • Trade Poll" });

  return e;
}

function pollButtons({ disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("worl:vote:W")
      .setLabel("✅ W")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("worl:vote:L")
      .setLabel("❌ L")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("worl:details")
      .setLabel("📊 Détails")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("worl:close")
      .setLabel("🔒 Fermer")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function creatorButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("worl:mode:trade")
      .setLabel("💱 Trade (Je trade / Contre)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("worl:cancel")
      .setLabel("✖ Annuler")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function getCounts(pool, pollId) {
  const r = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE choice='W')::int AS w,
      COUNT(*) FILTER (WHERE choice='L')::int AS l
     FROM worl_votes
     WHERE poll_id=$1`,
    [pollId]
  );
  return { w: r.rows[0]?.w || 0, l: r.rows[0]?.l || 0 };
}

async function fetchPollByMessage(pool, channelId, messageId) {
  const r = await pool.query(
    `SELECT * FROM worl_polls WHERE channel_id=$1 AND message_id=$2 LIMIT 1`,
    [channelId, messageId]
  );
  return r.rows[0] || null;
}

function canClose(interaction, poll) {
  if (!interaction.inGuild()) return false;
  if (interaction.user.id === poll.creator_id) return true;

  const perms = interaction.memberPermissions;
  if (!perms) return false;

  // staff standard : ManageMessages ou Administrator
  return (
    perms.has(PermissionsBitField.Flags.ManageMessages) ||
    perms.has(PermissionsBitField.Flags.Administrator)
  );
}

async function startTradeSession(interaction) {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const userId = interaction.user.id;

  const key = makeKey(guildId, channelId, userId);
  setupSessions.set(key, {
    step: 1,
    tradeText: "",
    startedAt: nowMs(),
  });

  await interaction.reply({
    embeds: [buildTradePromptEmbed(1, interaction.guild)],
    flags: MessageFlags.Ephemeral,
  });

  // collector sur le salon (l’utilisateur répond dans le chat)
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) return;

  const filter = (m) => m.author?.id === userId;
  const collector = channel.createMessageCollector({ filter, time: 120000, max: 1 });

  collector.on("collect", async (m) => {
    try {
      const content = safeTrim(m.content, 900);

      // nettoyage si possible
      if (m.deletable) await m.delete().catch(() => {});

      if (content.toLowerCase() === "cancel") {
        setupSessions.delete(key);
        await interaction.followUp({
          content: "✖ Setup annulé.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sess = setupSessions.get(key);
      if (!sess) return;

      sess.tradeText = content;
      sess.step = 2;
      setupSessions.set(key, sess);

      await interaction.followUp({
        embeds: [buildTradePromptEmbed(2, interaction.guild)],
        flags: MessageFlags.Ephemeral,
      });

      // 2ème collector
      const collector2 = channel.createMessageCollector({ filter, time: 120000, max: 1 });
      collector2.on("collect", async (m2) => {
        try {
          const content2 = safeTrim(m2.content, 900);
          if (m2.deletable) await m2.delete().catch(() => {});

          if (content2.toLowerCase() === "cancel") {
            setupSessions.delete(key);
            await interaction.followUp({
              content: "✖ Setup annulé.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const sess2 = setupSessions.get(key);
          if (!sess2) return;

          const tradeText = sess2.tradeText;
          const contreText = content2;

          setupSessions.delete(key);

          // publier le sondage
          const pollId = crypto.randomBytes(8).toString("hex");
          const embed = buildPollEmbed({
            guild: interaction.guild,
            creatorId: userId,
            tradeText,
            contreText,
            wCount: 0,
            lCount: 0,
          });

          const msg = await channel.send({
            embeds: [embed],
            components: [pollButtons({ disabled: false })],
          });

          // persist DB
          await interaction.client.__worl_pool.query(
            `INSERT INTO worl_polls (poll_id, guild_id, channel_id, message_id, creator_id, mode, trade_text, contre_text, status)
             VALUES ($1,$2,$3,$4,$5,'trade',$6,$7,'open')`,
            [pollId, guildId, channelId, msg.id, userId, tradeText, contreText]
          );

          await interaction.followUp({
            content: "✅ Ton Trade Poll a été publié !",
            flags: MessageFlags.Ephemeral,
          });
        } catch (e) {
          console.error("worl collector2 error:", e);
          setupSessions.delete(key);
          await interaction.followUp({
            content: "⚠️ Erreur pendant le setup (voir logs).",
            flags: MessageFlags.Ephemeral,
          });
        }
      });

      collector2.on("end", async (collected) => {
        if (collected.size === 0) {
          setupSessions.delete(key);
          await interaction.followUp({
            content: "⏳ Setup expiré (2/2). Relance `/worl`.",
            flags: MessageFlags.Ephemeral,
          });
        }
      });
    } catch (e) {
      console.error("worl collector error:", e);
      setupSessions.delete(key);
      await interaction.followUp({
        content: "⚠️ Erreur pendant le setup (voir logs).",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      setupSessions.delete(key);
      await interaction.followUp({
        content: "⏳ Setup expiré (1/2). Relance `/worl`.",
        flags: MessageFlags.Ephemeral,
      });
    }
  });
}

function createWorlService({ pool, config }) {
  // hack simple: stocker pool sur le client (comme ça worl.js peut l’utiliser dans les collectors)
  // => index.js va set client.__worl_pool = pool
  // (aucun impact sur tes autres modules)
  const commands = [
    new SlashCommandBuilder().setName("worl").setDescription("Créer un sondage W ou L (mode Trade assisté)"),
  ];

  async function handleInteraction(interaction, client) {
    // rendre pool accessible dans collectors
    if (client && !client.__worl_pool) client.__worl_pool = pool;

    // Slash
    if (interaction.isChatInputCommand() && interaction.commandName === "worl") {
      if (!interaction.inGuild()) {
        await interaction.reply({
          content: "⚠️ Utilisable uniquement sur un serveur.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await interaction.reply({
        embeds: [buildCreatorEmbed(interaction.guild)],
        components: [creatorButtons()],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // Boutons WorL
    if (interaction.isButton()) {
      const id = interaction.customId || "";
      if (!id.startsWith("worl:")) return false;

      // creator UI
      if (id === "worl:cancel") {
        await interaction.reply({ content: "✖ Annulé.", flags: MessageFlags.Ephemeral });
        return true;
      }
      if (id === "worl:mode:trade") {
        // évite double start
        const key = makeKey(interaction.guildId, interaction.channelId, interaction.user.id);
        if (setupSessions.has(key)) {
          await interaction.reply({
            content: "⚠️ Tu as déjà un setup en cours ici. Tape `cancel` ou attends l’expiration.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        await startTradeSession(interaction);
        return true;
      }

      // boutons de sondage (W/L/details/close) => retrouver le poll via message
      const poll = await fetchPollByMessage(pool, interaction.channelId, interaction.message.id);
      if (!poll) {
        await interaction.reply({
          content: "⚠️ Sondage introuvable (peut-être ancien / DB reset).",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (poll.status !== "open") {
        await interaction.reply({ content: "🔒 Ce sondage est fermé.", flags: MessageFlags.Ephemeral });
        return true;
      }

      if (id === "worl:details") {
        const { w, l } = await getCounts(pool, poll.poll_id);
        const total = w + l;

        await interaction.reply({
          content: `📊 Résultats : ✅ W **${w}** (${percent(w, total)}) | ❌ L **${l}** (${percent(l, total)}) | Total **${total}**`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (id === "worl:close") {
        if (!canClose(interaction, poll)) {
          await interaction.reply({
            content: "⛔ Tu n’as pas la permission de fermer ce sondage.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }

        await pool.query(`UPDATE worl_polls SET status='closed', closed_at=NOW() WHERE poll_id=$1`, [poll.poll_id]);

        // refresh embed + disable buttons
        const { w, l } = await getCounts(pool, poll.poll_id);

        const embed = buildPollEmbed({
          guild: interaction.guild,
          creatorId: poll.creator_id,
          tradeText: poll.trade_text,
          contreText: poll.contre_text,
          wCount: w,
          lCount: l,
        }).setTitle("🔒 Trade Check — Fermé");

        await interaction.message.edit({
          embeds: [embed],
          components: [pollButtons({ disabled: true })],
        });

        await interaction.reply({ content: "✅ Sondage fermé.", flags: MessageFlags.Ephemeral });
        return true;
      }

      if (id === "worl:vote:W" || id === "worl:vote:L") {
        const choice = id.endsWith(":W") ? "W" : "L";

        await pool.query(
          `INSERT INTO worl_votes (poll_id, guild_id, user_id, choice)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (poll_id, user_id)
           DO UPDATE SET choice=EXCLUDED.choice, voted_at=NOW()`,
          [poll.poll_id, poll.guild_id, interaction.user.id, choice]
        );

        const { w, l } = await getCounts(pool, poll.poll_id);

        const embed = buildPollEmbed({
          guild: interaction.guild,
          creatorId: poll.creator_id,
          tradeText: poll.trade_text,
          contreText: poll.contre_text,
          wCount: w,
          lCount: l,
        });

        await interaction.message.edit({
          embeds: [embed],
          components: [pollButtons({ disabled: false })],
        });

        await interaction.reply({
          content: `✅ Vote enregistré : **${choice}**`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      return true;
    }

    return false;
  }

  return { commands, handleInteraction, ensureDb };
}

module.exports = { createWorlService };
