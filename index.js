// index.js
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} = require("discord.js");

const { Pool } = require("pg");

const { createVouchesService } = require("./vouches");
const { createRankupService } = require("./rankup");
const { createSendMessageService } = require("./send-message");
const { createTicketsService } = require("./tickets");
const { createGiveawayService } = require("./giveaway");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID
const GUILD_ID = process.env.GUILD_ID; // ID du serveur (enregistrement rapide des slash commands)

// Vouches
const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || null;
const VOUCHBOARD_REFRESH_MS = Number(process.env.VOUCHBOARD_REFRESH_MS || 60000);

// Rankup
const RANKUP_STACK = (process.env.RANKUP_STACK || "false").toLowerCase() === "true";
const RANKUP_LOG_CHANNEL_ID = process.env.RANKUP_LOG_CHANNEL_ID || null;

// Tickets (fallback ENV, mais tu peux config via /ticket-config)
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const TICKET_STAFF_ROLE_ID = process.env.TICKET_STAFF_ROLE_ID || null;
const ADMIN_FEEDBACK_CHANNEL_ID = process.env.ADMIN_FEEDBACK_CHANNEL_ID || null;
const TICKET_TRANSCRIPT_CHANNEL_ID = process.env.TICKET_TRANSCRIPT_CHANNEL_ID || null;
const TICKET_MAX_OPEN_PER_USER = Number(process.env.TICKET_MAX_OPEN_PER_USER || 1);
const TICKET_COOLDOWN_SECONDS = Number(process.env.TICKET_COOLDOWN_SECONDS || 600);
const TICKET_CLAIM_EXCLUSIVE = (process.env.TICKET_CLAIM_EXCLUSIVE || "false").toLowerCase() === "true";
const TICKET_DELETE_ON_CLOSE = (process.env.TICKET_DELETE_ON_CLOSE || "false").toLowerCase() === "true";

// Giveaways
const GIVEAWAY_SWEEP_MS = Number(process.env.GIVEAWAY_SWEEP_MS || 15000);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Variables manquantes.\nAjoute DISCORD_TOKEN, CLIENT_ID, GUILD_ID.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL manquant.\nAjoute une DB PostgreSQL (Railway) ou définis DATABASE_URL."
  );
  process.exit(1);
}

const config = {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,

  // vouches
  VOUCH_CHANNEL_ID,
  VOUCHBOARD_REFRESH_MS,

  // rankup
  RANKUP_STACK,
  RANKUP_LOG_CHANNEL_ID,

  // tickets
  TICKET_CATEGORY_ID,
  TICKET_STAFF_ROLE_ID,
  ADMIN_FEEDBACK_CHANNEL_ID,
  TICKET_TRANSCRIPT_CHANNEL_ID,
  TICKET_MAX_OPEN_PER_USER,
  TICKET_COOLDOWN_SECONDS,
  TICKET_CLAIM_EXCLUSIVE,
  TICKET_DELETE_ON_CLOSE,

  // giveaways
  GIVEAWAY_SWEEP_MS,
};

// Railway/Postgres : SSL souvent nécessaire en prod
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    /* --- vouches --- */
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

    CREATE TABLE IF NOT EXISTS vouchboard (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      limit_count INTEGER NOT NULL DEFAULT 10,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* --- rankup --- */
    CREATE TABLE IF NOT EXISTS rank_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      required_vouches INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rank_roles_guild_required ON rank_roles (guild_id, required_vouches);

    /* --- tickets --- */
    CREATE TABLE IF NOT EXISTS ticket_settings (
      guild_id TEXT PRIMARY KEY,
      category_id TEXT,
      staff_role_id TEXT,
      admin_feedback_channel_id TEXT,
      transcript_channel_id TEXT,
      max_open_per_user INTEGER NOT NULL DEFAULT 1,
      cooldown_seconds INTEGER NOT NULL DEFAULT 600,
      claim_exclusive BOOLEAN NOT NULL DEFAULT FALSE,
      delete_on_close BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticket_panels (
      panel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      categories JSONB,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_panels_guild ON ticket_panels (guild_id);

    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      opener_id TEXT NOT NULL,
      category_label TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_channel_unique ON tickets (channel_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_guild_opener_status ON tickets (guild_id, opener_id, status);
    CREATE INDEX IF NOT EXISTS idx_tickets_guild_created ON tickets (guild_id, created_at);

    CREATE TABLE IF NOT EXISTS ticket_feedback (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      opener_id TEXT NOT NULL,
      claimed_by TEXT,
      rating SMALLINT NOT NULL,
      comment TEXT,
      log_channel_id TEXT,
      log_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_feedback_guild_created ON ticket_feedback (guild_id, created_at);

    CREATE TABLE IF NOT EXISTS ticket_transcripts (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* --- giveaways --- */
    CREATE TABLE IF NOT EXISTS giveaways (
      giveaway_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      prize TEXT NOT NULL,
      host_id TEXT NOT NULL,
      winner_count INTEGER NOT NULL DEFAULT 1,
      end_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', /* running|ended|cancelled */
      requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
      winners JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_giveaways_guild_status_endat ON giveaways (guild_id, status, end_at);

    CREATE TABLE IF NOT EXISTS giveaway_entries (
      giveaway_id TEXT NOT NULL REFERENCES giveaways(giveaway_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entries INTEGER NOT NULL DEFAULT 1,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (giveaway_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_giveaway_entries_guild_user ON giveaway_entries (guild_id, user_id);
  `);

  console.log("✅ DB prête (vouches + rank_roles + tickets + giveaways OK).");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Services
const rankup = createRankupService({ pool, config });
const vouches = createVouchesService({ pool, config, rankup });
const sendMessage = createSendMessageService();
const tickets = createTicketsService({ pool, config });
const giveaways = createGiveawayService({ pool, config });

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("ping").setDescription("Répond pong + latence"),
    ...vouches.commands,
    ...rankup.commands,
    ...sendMessage.commands,
    ...tickets.commands,
    ...giveaways.commands,
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands enregistrées sur le serveur.");
}

client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  try {
    await initDb();
    await registerCommands();

    // vouchboard refresh + init
    for (const g of client.guilds.cache.values()) {
      await vouches.updateVouchboardMessage(client, g.id).catch(() => {});
    }
    vouches.startGlobalVouchboardUpdater(client);

    // giveaways sweeper
    giveaways.startGlobalGiveawaySweeper(client);
  } catch (err) {
    console.error("Erreur au démarrage:", err);
    process.exit(1);
  }
});

// Logs globaux utiles
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

client.on("interactionCreate", async (interaction) => {
  try {
    // Tickets en premier (boutons/select/modals + slash)
    if (await tickets.handleInteraction(interaction, client)) return;

    // Send-message ensuite (gère aussi ses modals)
    if (await sendMessage.handleInteraction(interaction)) return;

    // Giveaways (boutons + slash)
    if (await giveaways.handleInteraction(interaction, client)) return;

    // Le reste: slash uniquement
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
      const sent = await interaction.reply({ content: "pong ", fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      return interaction.editReply(`pong (latence: ${latency}ms)`);
    }

    if (await vouches.handleInteraction(interaction, client)) return;
    if (await rankup.handleInteraction(interaction)) return;
  } catch (e) {
    console.error("interactionCreate fatal:", e);
    if (interaction?.isRepliable?.()) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction
          .reply({
            content: "⚠️ Erreur interne (voir logs).",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply("⚠️ Erreur interne (voir logs).").catch(() => {});
      }
    }
  }
});

client.login(TOKEN);
