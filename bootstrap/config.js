function loadConfig(env = process.env) {
  const TOKEN = env.DISCORD_TOKEN;
  const CLIENT_ID = env.CLIENT_ID;
  const GUILD_ID = env.GUILD_ID || null;
  const COMMANDS_SCOPE = (env.COMMANDS_SCOPE || (GUILD_ID ? 'guild' : 'global')).toLowerCase();
  const OWNER_ID = env.OWNER_ID || null;

  if (!TOKEN || !CLIENT_ID) {
    throw new Error('Variables manquantes: DISCORD_TOKEN et CLIENT_ID');
  }
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL manquant');
  }
  if ((COMMANDS_SCOPE === 'guild' || COMMANDS_SCOPE === 'both') && !GUILD_ID) {
    throw new Error("COMMANDS_SCOPE est 'guild'/'both' mais GUILD_ID est manquant");
  }

  return {
    TOKEN,
    CLIENT_ID,
    GUILD_ID,
    COMMANDS_SCOPE,
    OWNER_ID,

    DATABASE_URL: env.DATABASE_URL,
    NODE_ENV: env.NODE_ENV,

    VOUCH_CHANNEL_ID: env.VOUCH_CHANNEL_ID || null,
    VOUCHBOARD_REFRESH_MS: Number(env.VOUCHBOARD_REFRESH_MS || 60000),

    RANKUP_STACK: (env.RANKUP_STACK || 'false').toLowerCase() === 'true',
    RANKUP_LOG_CHANNEL_ID: env.RANKUP_LOG_CHANNEL_ID || null,

    TICKET_CATEGORY_ID: env.TICKET_CATEGORY_ID || null,
    TICKET_STAFF_ROLE_ID: env.TICKET_STAFF_ROLE_ID || null,
    ADMIN_FEEDBACK_CHANNEL_ID: env.ADMIN_FEEDBACK_CHANNEL_ID || null,
    TICKET_TRANSCRIPT_CHANNEL_ID: env.TICKET_TRANSCRIPT_CHANNEL_ID || null,
    TICKET_MAX_OPEN_PER_USER: Number(env.TICKET_MAX_OPEN_PER_USER || 1),
    TICKET_COOLDOWN_SECONDS: Number(env.TICKET_COOLDOWN_SECONDS || 600),
    TICKET_CLAIM_EXCLUSIVE: (env.TICKET_CLAIM_EXCLUSIVE || 'false').toLowerCase() === 'true',
    TICKET_DELETE_ON_CLOSE: (env.TICKET_DELETE_ON_CLOSE || 'false').toLowerCase() === 'true',

    GIVEAWAY_SWEEP_MS: Number(env.GIVEAWAY_SWEEP_MS || 15000),

    MODLOG_CHANNEL_ID: env.MODLOG_CHANNEL_ID || null,
    MOD_STAFF_ROLE_ID: env.MOD_STAFF_ROLE_ID || null,
  };
}

module.exports = { loadConfig };
