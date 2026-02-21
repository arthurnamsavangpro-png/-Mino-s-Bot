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
const { createModrankService } = require("./modrank");
const { createSendMessageService } = require("./send-message");
const { createTicketsService } = require("./tickets");
const { createGiveawayService } = require("./giveaway");
const { createModerationService } = require("./moderation");
const { createAutomodService } = require("./automod");

// ✅ NOUVEAU : updates/broadcast
const { createUpdatesService } = require("./updates");

/* ----------------------------- ENV ------------------------------ */
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const COMMANDS_SCOPE = (
  process.env.COMMANDS_SCOPE || (GUILD_ID ? "guild" : "global")
).toLowerCase();

// ✅ owner id pour /broadcast & /broadcastembed
const OWNER_ID = process.env.OWNER_ID || null;

/* ----------------------------- Vouches ------------------------------ */
const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || null;
const VOUCHBOARD_REFRESH_MS = Number(process.env.VOUCHBOARD_REFRESH_MS || 60000);

/* ----------------------------- Rankup (vouch) ------------------------------ */
const RANKUP_STACK = (process.env.RANKUP_STACK || "false").toLowerCase() === "true";
const RANKUP_LOG_CHANNEL_ID = process.env.RANKUP_LOG_CHANNEL_ID || null;

/* ----------------------------- Tickets ------------------------------ */
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const TICKET_STAFF_ROLE_ID = process.env.TICKET_STAFF_ROLE_ID || null;
const ADMIN_FEEDBACK_CHANNEL_ID = process.env.ADMIN_FEEDBACK_CHANNEL_ID || null;
const TICKET_TRANSCRIPT_CHANNEL_ID = process.env.TICKET_TRANSCRIPT_CHANNEL_ID || null;
const TICKET_MAX_OPEN_PER_USER = Number(process.env.TICKET_MAX_OPEN_PER_USER || 1);
const TICKET_COOLDOWN_SECONDS = Number(process.env.TICKET_COOLDOWN_SECONDS || 600);
const TICKET_CLAIM_EXCLUSIVE =
  (process.env.TICKET_CLAIM_EXCLUSIVE || "false").toLowerCase() === "true";
const TICKET_DELETE_ON_CLOSE =
  (process.env.TICKET_DELETE_ON_CLOSE || "false").toLowerCase() === "true";

/* ----------------------------- Giveaways ------------------------------ */
const GIVEAWAY_SWEEP_MS = Number(process.env.GIVEAWAY_SWEEP_MS || 15000);

/* ----------------------------- Moderation ------------------------------ */
const MODLOG_CHANNEL_ID = process.env.MODLOG_CHANNEL_ID || null;
const MOD_STAFF_ROLE_ID = process.env.MOD_STAFF_ROLE_ID || null;

/* ----------------------------- Checks ------------------------------ */
if (!TOKEN || !CLIENT_ID) {
  console.error("Variables manquantes.\nAjoute DISCORD_TOKEN et CLIENT_ID.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.\nAjoute une DB PostgreSQL (Railway) ou définis DATABASE_URL.");
  process.exit(1);
}
if ((COMMANDS_SCOPE === "guild" || COMMANDS_SCOPE === "both") && !GUILD_ID) {
  console.error(
    "COMMANDS_SCOPE est 'guild' ou 'both' mais GUILD_ID est manquant.\nAjoute GUILD_ID ou mets COMMANDS_SCOPE=global."
  );
  process.exit(1);
}

/* ----------------------------- Config object ------------------------------ */
const config = {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,
  COMMANDS_SCOPE,

  OWNER_ID, // ✅

  VOUCH_CHANNEL_ID,
  VOUCHBOARD_REFRESH_MS,

  RANKUP_STACK,
  RANKUP_LOG_CHANNEL_ID,

  TICKET_CATEGORY_ID,
  TICKET_STAFF_ROLE_ID,
  ADMIN_FEEDBACK_CHANNEL_ID,
  TICKET_TRANSCRIPT_CHANNEL_ID,
  TICKET_MAX_OPEN_PER_USER,
  TICKET_COOLDOWN_SECONDS,
  TICKET_CLAIM_EXCLUSIVE,
  TICKET_DELETE_ON_CLOSE,

  GIVEAWAY_SWEEP_MS,

  MODLOG_CHANNEL_ID,
  MOD_STAFF_ROLE_ID,
};

/* ----------------------------- DB ------------------------------ */
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

    CREATE TABLE IF NOT EXISTS vouch_settings (
      guild_id TEXT PRIMARY KEY,
      vouch_channel_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* --- rankup (vouch) --- */
    CREATE TABLE IF NOT EXISTS rank_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      required_vouches INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rank_roles_guild_required ON rank_roles (guild_id, required_vouches);

    /* --- modrank --- */
    CREATE TABLE IF NOT EXISTS modrank_settings (
      guild_id TEXT PRIMARY KEY,
      announce_channel_id TEXT,
      log_channel_id TEXT,
      dm_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ping_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode TEXT NOT NULL DEFAULT 'highest',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS modrank_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_modrank_roles_guild_position ON modrank_roles (guild_id, position);
    CREATE TABLE IF NOT EXISTS modrank_counters (
      guild_id TEXT PRIMARY KEY,
      last_ref BIGINT NOT NULL DEFAULT 0
    );

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
      status TEXT NOT NULL DEFAULT 'running',
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

    /* --- moderation --- */
    CREATE TABLE IF NOT EXISTS mod_settings (
      guild_id TEXT PRIMARY KEY,
      modlog_channel_id TEXT,
      staff_role_id TEXT,
      log_events JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mod_case_counters (
      guild_id TEXT PRIMARY KEY,
      last_case BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mod_cases (
      guild_id TEXT NOT NULL,
      case_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT,
      target_tag TEXT,
      moderator_id TEXT,
      moderator_tag TEXT,
      reason TEXT,
      duration_ms BIGINT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      log_channel_id TEXT,
      log_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, case_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_target_created ON mod_cases (guild_id, target_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_created ON mod_cases (guild_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_action_created ON mod_cases (guild_id, action, created_at DESC);

    /* ✅ --- automod --- */
    CREATE TABLE IF NOT EXISTS automod_settings (
      guild_id TEXT PRIMARY KEY,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* ✅ --- updates / broadcast --- */
    CREATE TABLE IF NOT EXISTS updates_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("✅ DB prête (modules + automod + updates OK).");
}

/* ----------------------------- Client ------------------------------ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ----------------------------- Services ------------------------------ */
const rankup = createRankupService({ pool, config });
const vouches = createVouchesService({ pool, config, rankup });
const modrank = createModrankService({ pool, config });
const sendMessage = createSendMessageService();
const tickets = createTicketsService({ pool, config });
const giveaways = createGiveawayService({ pool, config });
const moderation = createModerationService({ pool, config });
const automod = createAutomodService({ pool, config });

// ✅ NOUVEAU
const updates = createUpdatesService({ pool, config });

/* ----------------------------- Slash commands deployment ------------------------------ */
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("ping").setDescription("Répond pong + latence"),

    ...vouches.commands,
    ...rankup.commands,
    ...modrank.commands,
    ...sendMessage.commands,
    ...tickets.commands,
    ...giveaways.commands,
    ...moderation.commands,
    ...automod.commands,

    // ✅ updates
    ...updates.commands,
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  if (COMMANDS_SCOPE === "global") {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands enregistrées en GLOBAL (multi-serveur).");
    return;
  }

  if (COMMANDS_SCOPE === "guild") {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`✅ Slash commands enregistrées sur le serveur (GUILD_ID=${GUILD_ID}).`);
    return;
  }

  if (COMMANDS_SCOPE === "both") {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash commands enregistrées en GLOBAL + GUILD (mode hybride).");
    return;
  }

  console.warn(`⚠️ COMMANDS_SCOPE invalide: '${COMMANDS_SCOPE}'.
Mets global|guild|both.
(fallback => global)`);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

/* ----------------------------- Ready ------------------------------ */
client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  try {
    await initDb();
    await registerCommands();

    // vouchboard init + refresh
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

/* ----------------------------- Logs globaux utiles ------------------------------ */
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

/* ----------------------------- Interactions ------------------------------ */
client.on("interactionCreate", async (interaction) => {
  try {
    // Tickets
    if (await tickets.handleInteraction(interaction, client)) return;

    // Send-message
    if (await sendMessage.handleInteraction(interaction)) return;

    // Giveaways
    if (await giveaways.handleInteraction(interaction, client)) return;

    // ✅ Automod (panel + config)
    if (await automod.handleInteraction(interaction, client)) return;

    // ✅ Updates/broadcast
    if (await updates.handleInteraction(interaction, client)) return;

    // Le reste: slash uniquement
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
      const sent = await interaction.reply({ content: "pong ", fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      return interaction.editReply(`pong (latence: ${latency}ms)`);
    }

    if (await vouches.handleInteraction(interaction, client)) return;
    if (await rankup.handleInteraction(interaction)) return;
    if (await modrank.handleInteraction(interaction, client)) return;
    if (await moderation.handleInteraction(interaction, client)) return;
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

/* ----------------------------- Prefix commands + Automod message ------------------------------ */
client.on("messageCreate", async (message) => {
  try {
    // ✅ Automod d’abord (anti mention/link)
    if (await automod.handleMessage(message, client)) return;

    // mod prefix (ex: .banlist)
    if (await moderation.handleMessage?.(message, client)) return;
  } catch (e) {
    console.error("messageCreate fatal:", e);
  }
});

/* ----------------------------- Automod join + admin raid listeners ------------------------------ */
client.on("guildMemberAdd", async (member) => {
  try {
    await automod.handleGuildMemberAdd(member, client);
  } catch (e) {
    console.error("guildMemberAdd fatal:", e);
  }
});

client.on("channelCreate", async (channel) => {
  try {
    await automod.handleChannelCreate(channel, client);
  } catch (e) {
    console.error("channelCreate fatal:", e);
  }
});

client.on("channelDelete", async (channel) => {
  try {
    await automod.handleChannelDelete(channel, client);
  } catch (e) {
    console.error("channelDelete fatal:", e);
  }
});

// webhook updates (best effort)
client.on("webhooksUpdate", async (channel) => {
  try {
    await automod.handleWebhooksUpdate(channel, client);
  } catch (e) {
    console.error("webhooksUpdate fatal:", e);
  }
});

client.login(TOKEN);
