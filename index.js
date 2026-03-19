const { Client, ActivityType } = require('discord.js');

const { loadConfig } = require('./bootstrap/config');
const { createDbPool, runMigrations } = require('./bootstrap/db');
const { registerCommands } = require('./bootstrap/commands');
const { registerClientEvents, registerProcessSignals } = require('./bootstrap/events');
const { buildIntents } = require('./bootstrap/intents');
const { createLogger } = require('./logger');

const { createVouchesService } = require('./vouches');
const { createRankupService } = require('./rankup');
const { createModrankService } = require('./modrank');
const { createSendMessageService } = require('./send-message');
const { createTicketsService } = require('./tickets');
const { createGiveawayService } = require('./giveaway');
const { createModerationService } = require('./moderation');
const { createAutomodService } = require('./automod');
const { createUpdatesService } = require('./updates');
const { createAbsenceService } = require('./absence');
const { createInvitationsService } = require('./invitations');
const { createWelcomeService } = require('./welcome');
const { createServerStatsService } = require('./serverstats');
const { createWorlService } = require('./worl');
const { createHelpService } = require('./help');
const { createPingService } = require('./ping');
const { createStartNewServerService } = require('./startnewserver');

const logger = createLogger();

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

const pool = createDbPool(config);

const client = new Client({
  intents: buildIntents(config),
});

const ping = createPingService();
const startnewserver = createStartNewServerService();
const rankup = createRankupService({ pool, config });
const vouches = createVouchesService({ pool, config, rankup });
const modrank = createModrankService({ pool, config });
const sendMessage = createSendMessageService();
const tickets = createTicketsService({ pool, config, logger });
const giveaways = createGiveawayService({ pool, config });
const moderation = createModerationService({ pool, config });
const automod = createAutomodService({ pool, config });
const updates = createUpdatesService({ pool, config });
const absence = createAbsenceService({ pool, config });
const invitations = createInvitationsService({ pool, config });
const welcome = createWelcomeService({ pool, config });
const serverstats = createServerStatsService({ pool, config });
const worl = createWorlService({ pool, config });

const help = createHelpService({
  services: {
    ping,
    startnewserver,
    vouches,
    rankup,
    modrank,
    tickets,
    giveaways,
    moderation,
    automod,
    updates,
    absence,
    invitations,
    welcome,
    serverstats,
    worl,
    sendMessage,
  },
});

const services = {
  ping,
  startnewserver,
  help,
  vouches,
  rankup,
  modrank,
  sendMessage,
  tickets,
  giveaways,
  moderation,
  automod,
  updates,
  absence,
  invitations,
  welcome,
  serverstats,
  worl,
};

let presenceInterval = null;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.warn({ module: 'core', event: 'shutdown_start', signal });

  const hardTimeout = setTimeout(() => {
    logger.error({ module: 'core', event: 'shutdown_timeout', timeoutMs: 10_000 });
    process.exit(1);
  }, 10_000);
  hardTimeout.unref?.();

  try {
    if (presenceInterval) {
      clearInterval(presenceInterval);
      presenceInterval = null;
    }

    vouches.stopGlobalVouchboardUpdater?.();
    giveaways.stopGlobalGiveawaySweeper?.();
    serverstats.stopScheduler?.();

    client.destroy();
    await pool.end();

    logger.info({
      module: 'core',
      event: 'shutdown_done',
      topErrorModules: logger.getTopErrorModules(5),
    });

    clearTimeout(hardTimeout);
    process.exit(0);
  } catch (error) {
    clearTimeout(hardTimeout);
    logger.error({ module: 'core', event: 'shutdown_error', error: error?.message || error });
    process.exit(1);
  }
}

registerProcessSignals({ gracefulShutdown, logger });

process.on('unhandledRejection', (err) =>
  logger.error({ module: 'process', event: 'unhandledRejection', error: err?.message || err })
);
process.on('uncaughtException', (err) =>
  logger.error({ module: 'process', event: 'uncaughtException', error: err?.message || err })
);

registerClientEvents({ client, services, logger });

client.once('clientReady', async () => {
  logger.info({ module: 'core', event: 'client_ready', userTag: client.user.tag });

  const activities = [
    { name: '🏆 WorL • Vote Win / Lose', type: ActivityType.Playing },
    { name: '🎫 Tickets • Premium Support', type: ActivityType.Playing },
    { name: '🛡️ Modération • Sécurité active', type: ActivityType.Playing },
    { name: '⭐ Vouches • Système d\'avis/Feedback', type: ActivityType.Playing },
    { name: '⚙️ /help • Toutes les commandes', type: ActivityType.Playing },
    { name: `🌍 ${client.guilds.cache.size} serveurs`, type: ActivityType.Watching },
  ];

  let i = 0;
  const updatePresence = () => {
    const a = activities[i];
    client.user.setPresence({ activities: [{ name: a.name, type: a.type }], status: 'online' });
    i = (i + 1) % activities.length;
  };

  updatePresence();
  presenceInterval = setInterval(updatePresence, 15_000);

  try {
    await runMigrations(pool);
    logger.info({ module: 'db', event: 'migrations_done' });

    await registerCommands({
      token: config.TOKEN,
      clientId: config.CLIENT_ID,
      guildId: config.GUILD_ID,
      commandsScope: config.COMMANDS_SCOPE,
      services,
      logger,
    });

    await invitations.primeCache(client);

    for (const g of client.guilds.cache.values()) {
      await serverstats.refreshGuildStats(g).catch((error) => {
        logger.warn({
          module: 'serverstats',
          event: 'initial_refresh_failed',
          guildId: g.id,
          error: error?.message || error,
        });
      });
    }
    serverstats.startScheduler(client);

    for (const g of client.guilds.cache.values()) {
      await vouches.updateVouchboardMessage(client, g.id).catch((error) => {
        logger.warn({
          module: 'vouches',
          event: 'initial_vouchboard_update_failed',
          guildId: g.id,
          error: error?.message || error,
        });
      });
    }
    vouches.startGlobalVouchboardUpdater(client);

    giveaways.startGlobalGiveawaySweeper(client);
  } catch (error) {
    logger.error({ module: 'core', event: 'startup_error', error: error?.message || error });
    process.exit(1);
  }
});

client.login(config.TOKEN);
