const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const { Pool } = require("pg");

const { createVouchesService } = require("./vouches");
const { createRankupService } = require("./rankup");
const { createSendMessageService } = require("./send-message");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

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

const config = {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VOUCH_CHANNEL_ID,
  VOUCHBOARD_REFRESH_MS,
  RANKUP_STACK,
  RANKUP_LOG_CHANNEL_ID,
};

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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Services
const rankup = createRankupService({ pool, config });
const vouches = createVouchesService({ pool, config, rankup });
const sendMessage = createSendMessageService();

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("ping").setDescription("Répond pong + latence"),

    // Vouches
    ...vouches.commands,

    // Rankup
    ...rankup.commands,

    // Send message
    ...sendMessage.commands,
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });

  console.log("✅ Slash commands enregistrées sur le serveur.");
}

/* -------------------------------
   Bot lifecycle
-------------------------------- */

client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  try {
    await initDb();
    await registerCommands();

    for (const g of client.guilds.cache.values()) {
      await vouches.updateVouchboardMessage(client, g.id).catch(() => {});
    }
    vouches.startGlobalVouchboardUpdater(client);
  } catch (err) {
    console.error("Erreur au démarrage:", err);
    process.exit(1);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    const sent = await interaction.reply({ content: "pong 🏓", fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    return interaction.editReply(`pong 🏓 (latence: ${latency}ms)`);
  }

  // /send
  if (await sendMessage.handleInteraction(interaction)) return;

  // Vouches module
  if (await vouches.handleInteraction(interaction, client)) return;

  // Rankup module
  if (await rankup.handleInteraction(interaction)) return;
});

client.login(TOKEN);
