// automod.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  MessageFlags,
  AuditLogEvent,
} = require("discord.js");

const RED = 0xff0000;

function redEmbed() {
  return new EmbedBuilder().setColor(RED).setTimestamp();
}

function isAdminLike(interactionOrMember) {
  const perms = interactionOrMember?.memberPermissions || interactionOrMember?.permissions;
  return perms?.has?.(PermissionsBitField.Flags.Administrator) || false;
}

function hasPerm(interactionOrMember, perm) {
  const perms = interactionOrMember?.memberPermissions || interactionOrMember?.permissions;
  return perms?.has?.(perm) || false;
}

function safeStr(s, max = 1024) {
  const v = String(s ?? "").trim();
  if (!v) return "—";
  return v.length > max ? v.slice(0, max - 1) + "…" : v;
}

function parseDurationToMs(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (["off", "remove", "none", "0", "0s", "0m", "0h", "0d", "0w"].includes(s)) return 0;
  const m = s.match(/^\s*(\d+)\s*([smhdw])\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n < 0) return null;
  const mult =
    unit === "s"
      ? 1000
      : unit === "m"
      ? 60 * 1000
      : unit === "h"
      ? 60 * 60 * 1000
      : unit === "d"
      ? 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
  return n * mult;
}

function formatDuration(ms) {
  if (ms == null) return "N/A";
  if (ms === 0) return "0";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  return `${w}w`;
}

function nowMs() {
  return Date.now();
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function normalizeDomain(d) {
  let s = String(d || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  return s;
}

function extractDomainsFromText(text) {
  const t = String(text || "");
  const out = new Set();

  const urlRe = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const bareRe = /\b([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s<>()"]*)?/gi;

  const urls = t.match(urlRe) || [];
  for (const u of urls) {
    try {
      const host = new URL(u).hostname;
      const d = normalizeDomain(host);
      if (d) out.add(d);
    } catch {}
  }

  const bare = t.match(bareRe) || [];
  for (const b of bare) {
    // évite de récupérer "discord" tout seul etc.
    const d = normalizeDomain(b);
    if (d && d.includes(".")) out.add(d);
  }

  // invites discord
  if (/\bdiscord\.gg\/[a-z0-9]+/i.test(t) || /\bdiscord\.com\/invite\/[a-z0-9]+/i.test(t)) {
    out.add("discord.gg");
  }

  return Array.from(out);
}

function isTextChannelLike(ch) {
  return ch && ch.isTextBased && ch.isTextBased();
}

/** ---------- DB helpers (réutilise tes tables existantes mod_settings/mod_cases/mod_case_counters) ---------- */

async function ensureCaseCounter(pool, guildId) {
  await pool.query(
    `INSERT INTO mod_case_counters (guild_id, last_case) VALUES ($1, 0)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}

async function nextCaseId(pool, guildId) {
  await ensureCaseCounter(pool, guildId);
  const res = await pool.query(
    `UPDATE mod_case_counters SET last_case = last_case + 1 WHERE guild_id=$1 RETURNING last_case`,
    [guildId]
  );
  return Number(res.rows[0]?.last_case || 0);
}

async function getModSettings(pool, config, guildId) {
  const res = await pool.query(
    `SELECT modlog_channel_id, staff_role_id, log_events
     FROM mod_settings WHERE guild_id=$1 LIMIT 1`,
    [guildId]
  );
  const row = res.rows[0] || null;

  const fallback = {
    modlog_channel_id: config.MODLOG_CHANNEL_ID || null,
    staff_role_id: config.MOD_STAFF_ROLE_ID || null,
    log_events: {},
  };

  return {
    modlog_channel_id: row?.modlog_channel_id || fallback.modlog_channel_id,
    staff_role_id: row?.staff_role_id || fallback.staff_role_id,
    log_events: row?.log_events || fallback.log_events || {},
  };
}

async function sendLogToChannel(guild, channelId, embed) {
  if (!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !isTextChannelLike(ch)) return null;
  return await ch.send({ embeds: [embed] }).catch(() => null);
}

async function insertCase(pool, payload) {
  const {
    guildId,
    action,
    targetId,
    targetTag,
    moderatorId,
    moderatorTag,
    reason,
    durationMs,
    metadata,
    logChannelId,
    logMessageId,
  } = payload;

  const caseId = await nextCaseId(pool, guildId);

  await pool.query(
    `INSERT INTO mod_cases (
      guild_id, case_id, action,
      target_id, target_tag,
      moderator_id, moderator_tag,
      reason, duration_ms,
      metadata, log_channel_id, log_message_id,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,NOW())`,
    [
      guildId,
      caseId,
      action,
      targetId || null,
      targetTag || null,
      moderatorId || null,
      moderatorTag || null,
      reason || null,
      durationMs ?? null,
      JSON.stringify(metadata || {}),
      logChannelId || null,
      logMessageId || null,
    ]
  );

  return caseId;
}

/** ----------------- Automod settings ----------------- */

function defaultAutomodSettings() {
  return {
    enabled: false,
    mode: "soft", // soft | hard
    log_channel_id: null, // si null => utilise mod_settings.modlog_channel_id
    trusted_role_id: null,
    verified_role_id: null,

    ignored_channel_ids: [],
    whitelist_role_ids: [],

    anti_join: {
      enabled: true,
      max_joins: 8,
      window_seconds: 60,
      min_account_age_days: 3,
      action: "timeout", // log | timeout | kick | lockdown
      timeout_ms: 10 * 60 * 1000,
      cooldown_seconds: 180,
      lockdown_seconds: 600,
    },

    anti_mention: {
      enabled: true,
      max_mentions: 6,
      block_everyone: true,
      action: "timeout", // delete | warn | timeout | ban
      timeout_ms: 10 * 60 * 1000,
    },

    anti_link: {
      enabled: true,
      block_invites: true,
      action: "warn", // delete | warn | timeout | ban
      timeout_ms: 10 * 60 * 1000,
      no_links_under_account_age_days: 3,
      require_verified_role_for_invites: true,
      whitelist_domains: ["youtube.com", "youtu.be", "twitter.com", "x.com", "tiktok.com", "instagram.com"],
      blacklist_domains: [],
    },

    admin_raid: {
      enabled: true,
      max_channels_create_10s: 3,
      max_channels_delete_10s: 2,
      max_webhooks_30s: 3,
      action: "log", // log | lockdown
      cooldown_seconds: 180,
      lockdown_seconds: 600,
    },

    lockdown: {
      active: false,
      until_ts: null,
      locked_channel_ids: [],
    },

    panel: {
      channel_id: null,
      message_id: null,
    },
  };
}

async function getAutomodSettings(pool, guildId) {
  const res = await pool.query(
    `SELECT settings_json FROM automod_settings WHERE guild_id=$1 LIMIT 1`,
    [guildId]
  );
  const row = res.rows[0] || null;
  const base = defaultAutomodSettings();
  if (!row?.settings_json) return base;

  // merge soft
  const s = row.settings_json;
  return {
    ...base,
    ...s,
    anti_join: { ...base.anti_join, ...(s.anti_join || {}) },
    anti_mention: { ...base.anti_mention, ...(s.anti_mention || {}) },
    anti_link: { ...base.anti_link, ...(s.anti_link || {}) },
    admin_raid: { ...base.admin_raid, ...(s.admin_raid || {}) },
    lockdown: { ...base.lockdown, ...(s.lockdown || {}) },
    panel: { ...base.panel, ...(s.panel || {}) },
  };
}

async function saveAutomodSettings(pool, guildId, nextSettings) {
  await pool.query(
    `INSERT INTO automod_settings (guild_id, settings_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET settings_json=EXCLUDED.settings_json, updated_at=NOW()`,
    [guildId, JSON.stringify(nextSettings)]
  );
  return nextSettings;
}

async function patchAutomodSettings(pool, guildId, patchFn) {
  const cur = await getAutomodSettings(pool, guildId);
  const next = patchFn(cur);
  return await saveAutomodSettings(pool, guildId, next);
}

/** ----------------- UI: Panel joli ----------------- */

function modeBadge(mode) {
  return mode === "hard" ? "🟥 HARD" : "🟧 SOFT";
}

function enabledBadge(on) {
  return on ? "✅ Activé" : "❌ Désactivé";
}

function actionLabel(a) {
  const map = {
    log: "Log",
    delete: "Delete",
    warn: "Warn",
    timeout: "Timeout",
    kick: "Kick",
    ban: "Ban",
    lockdown: "Lockdown",
  };
  return map[a] || a;
}

function buildPanelEmbed(guild, s, modlogChannelIdEffective) {
  const aj = s.anti_join;
  const am = s.anti_mention;
  const al = s.anti_link;
  const ar = s.admin_raid;

  const e = redEmbed()
    .setAuthor({ name: `🛡️ Automod • ${guild.name}`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`${enabledBadge(s.enabled)} • ${modeBadge(s.mode)}`)
    .setDescription(
      [
        "Panel de configuration **Automod / Anti-Raid**.",
        "Les changements sont **instantanés** et sauvegardés en **DB**.",
        "",
        "📌 Logs : " +
          (s.log_channel_id
            ? `<#${s.log_channel_id}>`
            : modlogChannelIdEffective
            ? `<#${modlogChannelIdEffective}> *(hérité de /log set)*`
            : "`Non défini`"),
      ].join("\n")
    );

  e.addFields(
    {
      name: "🚪 Anti-Join",
      value: [
        `• Statut : **${aj.enabled ? "ON" : "OFF"}**`,
        `• Seuil : **${aj.max_joins}** joins / **${aj.window_seconds}s**`,
        `• Âge min compte : **${aj.min_account_age_days}j**`,
        `• Action : **${actionLabel(aj.action)}**`,
        `• Timeout : **${formatDuration(aj.timeout_ms)}** • Cooldown : **${aj.cooldown_seconds}s**`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "📣 Anti-Mention",
      value: [
        `• Statut : **${am.enabled ? "ON" : "OFF"}**`,
        `• Max mentions : **${am.max_mentions}**`,
        `• @everyone/@here : **${am.block_everyone ? "Bloqué (hors whitelist)" : "Autorisé"}**`,
        `• Action : **${actionLabel(am.action)}**`,
        `• Timeout : **${formatDuration(am.timeout_ms)}**`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "🔗 Anti-Link",
      value: [
        `• Statut : **${al.enabled ? "ON" : "OFF"}**`,
        `• Invites : **${al.block_invites ? "Bloquées" : "OK"}**`,
        `• No-links < **${al.no_links_under_account_age_days}j**`,
        `• Invites requièrent rôle vérifié : **${al.require_verified_role_for_invites ? "Oui" : "Non"}**`,
        `• Action : **${actionLabel(al.action)}**`,
      ].join("\n"),
      inline: false,
    },
    {
      name: "🧨 Anti-Raid Admin",
      value: [
        `• Statut : **${ar.enabled ? "ON" : "OFF"}**`,
        `• Create : **${ar.max_channels_create_10s}** / 10s • Delete : **${ar.max_channels_delete_10s}** / 10s`,
        `• Webhooks : **${ar.max_webhooks_30s}** / 30s`,
        `• Action : **${actionLabel(ar.action)}** • Cooldown : **${ar.cooldown_seconds}s**`,
      ].join("\n"),
      inline: false,
    }
  );

  if (s.lockdown?.active) {
    e.addFields({
      name: "🔒 Lockdown",
      value: `Actif jusqu’à **${s.lockdown.until_ts ? `<t:${Math.floor(new Date(s.lockdown.until_ts).getTime() / 1000)}:R>` : "—"}**`,
      inline: false,
    });
  }

  e.setFooter({ text: "Mino Bot • Automod Panel • Boutons + Menus + Modals" });
  return e;
}

function buildMainRows(s) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("am:toggle")
      .setLabel(s.enabled ? "Désactiver" : "Activer")
      .setStyle(s.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("am:mode")
      .setLabel(`Mode: ${s.mode.toUpperCase()}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("am:status")
      .setLabel("Rafraîchir")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("am:lockdown_toggle")
      .setLabel(s.lockdown?.active ? "Stop Lockdown" : "Lockdown")
      .setStyle(s.lockdown?.active ? ButtonStyle.Success : ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("am:section")
      .setPlaceholder("Configurer un module…")
      .addOptions(
        { label: "Anti-Join", value: "anti_join", emoji: "🚪" },
        { label: "Anti-Mention", value: "anti_mention", emoji: "📣" },
        { label: "Anti-Link", value: "anti_link", emoji: "🔗" },
        { label: "Anti-Raid Admin", value: "admin_raid", emoji: "🧨" },
        { label: "Whitelist / Ignore / Roles", value: "meta", emoji: "⚙️" }
      )
  );

  return [row1, row2];
}

function buildSectionRows(s, section) {
  const rows = [];

  if (section === "anti_join") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("am:aj:toggle")
          .setLabel(s.anti_join.enabled ? "Anti-Join: ON" : "Anti-Join: OFF")
          .setStyle(s.anti_join.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("am:aj:edit").setLabel("Éditer seuils").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("am:aj:action").setLabel("Action").setStyle(ButtonStyle.Danger)
      )
    );
  }

  if (section === "anti_mention") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("am:am:toggle")
          .setLabel(s.anti_mention.enabled ? "Anti-Mention: ON" : "Anti-Mention: OFF")
          .setStyle(s.anti_mention.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("am:am:edit").setLabel("Éditer règles").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("am:am:action").setLabel("Action").setStyle(ButtonStyle.Danger)
      )
    );
  }

  if (section === "anti_link") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("am:al:toggle")
          .setLabel(s.anti_link.enabled ? "Anti-Link: ON" : "Anti-Link: OFF")
          .setStyle(s.anti_link.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("am:al:edit").setLabel("Éditer règles").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("am:al:lists").setLabel("Whitelist/Blacklist").setStyle(ButtonStyle.Danger)
      )
    );
  }

  if (section === "admin_raid") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("am:ar:toggle")
          .setLabel(s.admin_raid.enabled ? "Admin-Raid: ON" : "Admin-Raid: OFF")
          .setStyle(s.admin_raid.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("am:ar:edit").setLabel("Éditer seuils").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("am:ar:action").setLabel("Action").setStyle(ButtonStyle.Danger)
      )
    );
  }

  if (section === "meta") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("am:meta:log").setLabel("Salon logs Automod").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("am:meta:roles").setLabel("Rôles Trusted / Verified").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("am:meta:lists").setLabel("Whitelist rôles + salons ignorés").setStyle(ButtonStyle.Danger)
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("am:back").setLabel("← Retour").setStyle(ButtonStyle.Secondary)
    )
  );

  return rows;
}

function buildActionSelect(customId, current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(`Action actuelle: ${actionLabel(current)}`)
      .addOptions(
        { label: "Log", value: "log" },
        { label: "Delete", value: "delete" },
        { label: "Warn", value: "warn" },
        { label: "Timeout", value: "timeout" },
        { label: "Kick", value: "kick" },
        { label: "Ban", value: "ban" },
        { label: "Lockdown", value: "lockdown" }
      )
  );
}

function requireAdminPanel(interaction) {
  if (!interaction.inGuild()) return false;
  if (!isAdminLike(interaction)) return false;
  return true;
}

/** ----------------- Anti-raid runtime state (mémoire) ----------------- */
function createRuntimeState() {
  return {
    joinTimestamps: new Map(), // guildId => number[] (ms)
    adminCreateTimestamps: new Map(), // guildId => number[]
    adminDeleteTimestamps: new Map(), // guildId => number[]
    webhookTimestamps: new Map(), // guildId => number[]
    cooldownUntil: new Map(), // guildId => ms
  };
}

function pushWindow(arr, ts, windowMs) {
  arr.push(ts);
  while (arr.length && arr[0] < ts - windowMs) arr.shift();
}

/** ----------------- Lockdown helpers ----------------- */
async function applyLockdown(pool, guild, settings, seconds) {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  const locked = [];

  const everyone = guild.roles.everyone;
  const channels = await guild.channels.fetch().catch(() => null);
  if (channels) {
    for (const ch of channels.values()) {
      if (!ch || !ch.isTextBased?.()) continue;
      if (ch.type === ChannelType.GuildForum) continue; // safe
      if (ch.type === ChannelType.GuildCategory) continue;

      try {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: false });
        locked.push(ch.id);
      } catch {}
    }
  }

  const next = {
    ...settings,
    lockdown: {
      active: true,
      until_ts: until,
      locked_channel_ids: locked,
    },
  };
  await saveAutomodSettings(pool, guild.id, next);
  return next;
}

async function clearLockdown(pool, guild, settings) {
  const locked = settings.lockdown?.locked_channel_ids || [];
  const everyone = guild.roles.everyone;

  for (const chId of locked) {
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (!ch) continue;
    try {
      // reset overwrite for SendMessages (null => inherit)
      await ch.permissionOverwrites.edit(everyone, { SendMessages: null });
    } catch {}
  }

  const next = {
    ...settings,
    lockdown: { active: false, until_ts: null, locked_channel_ids: [] },
  };
  await saveAutomodSettings(pool, guild.id, next);
  return next;
}

/** ----------------- Core Automod actions ----------------- */
async function applyAutomodAction({
  pool,
  config,
  guild,
  settings,
  member,
  user,
  action,
  reason,
  durationMs,
  metadata,
  messageToDelete,
}) {
  const modSettings = await getModSettings(pool, config, guild.id);
  const logChannel = settings.log_channel_id || modSettings.modlog_channel_id;

  // delete if asked (safe)
  if (messageToDelete && (action === "delete" || action === "warn" || action === "timeout" || action === "ban")) {
    await messageToDelete.delete().catch(() => {});
  }

  // lock actions
  if (action === "lockdown") {
    const sec = clampInt(settings.anti_join?.lockdown_seconds ?? 600, 60, 7200, 600);
    const next = await applyLockdown(pool, guild, settings, sec);

    const logEmbed = redEmbed()
      .setTitle("🔒 AUTOMOD — LOCKDOWN")
      .setDescription(`Lockdown activé **${sec}s**`)
      .addFields({ name: "Raison", value: safeStr(reason, 800) });

    await sendLogToChannel(guild, logChannel, logEmbed);
    return { ok: true, caseId: null, settings: next };
  }

  // warn => écrit dans mod_cases (action WARN)
  const moderatorTag = "Automod";
  const moderatorId = null;

  // TIMEOUT
  if (action === "timeout") {
    if (member && member.moderatable) {
      await member.timeout(durationMs || 10 * 60 * 1000, `Automod | ${reason}`.slice(0, 480)).catch(() => {});
    }

    const embed = redEmbed()
      .setTitle("⏳ AUTOMOD — TIMEOUT")
      .addFields(
        { name: "Cible", value: user ? `<@${user.id}> (${user.id})` : member ? `<@${member.id}> (${member.id})` : "—" },
        { name: "Durée", value: formatDuration(durationMs || 0), inline: true },
        { name: "Raison", value: safeStr(reason, 800) }
      );

    const logMsg = await sendLogToChannel(guild, logChannel, embed);

    const caseId = await insertCase(pool, {
      guildId: guild.id,
      action: "TIMEOUT",
      targetId: user?.id || member?.id,
      targetTag: user?.tag || null,
      moderatorId,
      moderatorTag,
      reason,
      durationMs: durationMs || null,
      metadata: metadata || {},
      logChannelId: logMsg?.channelId || logChannel || null,
      logMessageId: logMsg?.id || null,
    });

    if (logMsg) {
      const updated = EmbedBuilder.from(embed).addFields({ name: "Case ID", value: `#${caseId}`, inline: true });
      await logMsg.edit({ embeds: [updated] }).catch(() => {});
    }

    return { ok: true, caseId, settings };
  }

  // WARN
  if (action === "warn") {
    const embed = redEmbed()
      .setTitle("⚠️ AUTOMOD — WARN")
      .addFields(
        { name: "Cible", value: user ? `<@${user.id}> (${user.id})` : member ? `<@${member.id}> (${member.id})` : "—" },
        { name: "Raison", value: safeStr(reason, 800) }
      );

    const logMsg = await sendLogToChannel(guild, logChannel, embed);

    const caseId = await insertCase(pool, {
      guildId: guild.id,
      action: "WARN",
      targetId: user?.id || member?.id,
      targetTag: user?.tag || null,
      moderatorId,
      moderatorTag,
      reason,
      durationMs: null,
      metadata: metadata || {},
      logChannelId: logMsg?.channelId || logChannel || null,
      logMessageId: logMsg?.id || null,
    });

    if (logMsg) {
      const updated = EmbedBuilder.from(embed).addFields({ name: "Case ID", value: `#${caseId}`, inline: true });
      await logMsg.edit({ embeds: [updated] }).catch(() => {});
    }

    return { ok: true, caseId, settings };
  }

  // BAN
  if (action === "ban") {
    if (user) {
      await guild.members.ban(user.id, { reason: `Automod | ${reason}`.slice(0, 480) }).catch(() => {});
    } else if (member) {
      await guild.members.ban(member.id, { reason: `Automod | ${reason}`.slice(0, 480) }).catch(() => {});
    }

    const embed = redEmbed()
      .setTitle("⛔ AUTOMOD — BAN")
      .addFields(
        { name: "Cible", value: user ? `<@${user.id}> (${user.id})` : member ? `<@${member.id}> (${member.id})` : "—" },
        { name: "Raison", value: safeStr(reason, 800) }
      );

    const logMsg = await sendLogToChannel(guild, logChannel, embed);

    const caseId = await insertCase(pool, {
      guildId: guild.id,
      action: "BAN",
      targetId: user?.id || member?.id,
      targetTag: user?.tag || null,
      moderatorId,
      moderatorTag,
      reason,
      durationMs: null,
      metadata: metadata || {},
      logChannelId: logMsg?.channelId || logChannel || null,
      logMessageId: logMsg?.id || null,
    });

    if (logMsg) {
      const updated = EmbedBuilder.from(embed).addFields({ name: "Case ID", value: `#${caseId}`, inline: true });
      await logMsg.edit({ embeds: [updated] }).catch(() => {});
    }

    return { ok: true, caseId, settings };
  }

  // DELETE only
  if (action === "delete") {
    const embed = redEmbed()
      .setTitle("🧹 AUTOMOD — DELETE")
      .addFields(
        { name: "Auteur", value: user ? `<@${user.id}> (${user.id})` : member ? `<@${member.id}> (${member.id})` : "—" },
        { name: "Raison", value: safeStr(reason, 800) }
      );

    await sendLogToChannel(guild, logChannel, embed);
    return { ok: true, caseId: null, settings };
  }

  // LOG only
  if (action === "log") {
    const embed = redEmbed()
      .setTitle("📌 AUTOMOD — LOG")
      .addFields(
        { name: "Cible", value: user ? `<@${user.id}> (${user.id})` : member ? `<@${member.id}> (${member.id})` : "—" },
        { name: "Raison", value: safeStr(reason, 800) }
      );

    await sendLogToChannel(guild, logChannel, embed);
    return { ok: true, caseId: null, settings };
  }

  // KICK (optionnel)
  if (action === "kick") {
    if (member && member.kickable) {
      await member.kick(`Automod | ${reason}`.slice(0, 480)).catch(() => {});
    }

    const embed = redEmbed()
      .setTitle("👢 AUTOMOD — KICK")
      .addFields(
        { name: "Cible", value: member ? `<@${member.id}> (${member.id})` : "—" },
        { name: "Raison", value: safeStr(reason, 800) }
      );

    await sendLogToChannel(guild, logChannel, embed);

    const caseId = await insertCase(pool, {
      guildId: guild.id,
      action: "KICK",
      targetId: member?.id,
      targetTag: member?.user?.tag || null,
      moderatorId,
      moderatorTag,
      reason,
      durationMs: null,
      metadata: metadata || {},
      logChannelId: logChannel || null,
      logMessageId: null,
    });

    return { ok: true, caseId, settings };
  }

  return { ok: false, caseId: null, settings };
}

/** ----------------- Service ----------------- */
function createAutomodService({ pool, config }) {
  const runtime = createRuntimeState();

  const commands = [
    new SlashCommandBuilder()
      .setName("automod")
      .setDescription("Automod / Anti-raid panel")
      .addSubcommand((sc) =>
        sc
          .setName("panel")
          .setDescription("Ouvrir le panel Automod (embed + boutons)")
          .addChannelOption((opt) =>
            opt
              .setName("salon")
              .setDescription("Salon où envoyer le panel (défaut: salon actuel)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(false)
          )
      )
      .addSubcommand((sc) => sc.setName("status").setDescription("Afficher le status Automod"))
      .addSubcommand((sc) =>
        sc
          .setName("preset")
          .setDescription("Appliquer un preset Soft/Hard")
          .addStringOption((opt) =>
            opt
              .setName("mode")
              .setDescription("Preset")
              .setRequired(true)
              .addChoices({ name: "SOFT", value: "soft" }, { name: "HARD", value: "hard" })
          )
      ),
  ];

  async function renderAndUpsertPanel(client, guild, channel, forceNew = false) {
    const modSettings = await getModSettings(pool, config, guild.id);
    const s = await getAutomodSettings(pool, guild.id);

    const effectiveLog = s.log_channel_id || modSettings.modlog_channel_id || null;

    const embed = buildPanelEmbed(guild, s, effectiveLog);

    const rows = buildMainRows(s);

    // si panel existant en DB et pas forceNew => edit
    if (!forceNew && s.panel?.channel_id && s.panel?.message_id) {
      const ch = await guild.channels.fetch(s.panel.channel_id).catch(() => null);
      if (ch && isTextChannelLike(ch)) {
        const msg = await ch.messages.fetch(s.panel.message_id).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed], components: rows }).catch(() => {});
          return { settings: s, message: msg };
        }
      }
    }

    const msg = await channel.send({ embeds: [embed], components: rows }).catch(() => null);
    if (!msg) return { settings: s, message: null };

    const next = {
      ...s,
      panel: { channel_id: msg.channelId, message_id: msg.id },
    };
    await saveAutomodSettings(pool, guild.id, next);

    return { settings: next, message: msg };
  }

  async function editPanelMessage(guild, s, section = null) {
    if (!s.panel?.channel_id || !s.panel?.message_id) return;
    const ch = await guild.channels.fetch(s.panel.channel_id).catch(() => null);
    if (!ch || !isTextChannelLike(ch)) return;

    const msg = await ch.messages.fetch(s.panel.message_id).catch(() => null);
    if (!msg) return;

    const modSettings = await getModSettings(pool, config, guild.id);
    const effectiveLog = s.log_channel_id || modSettings.modlog_channel_id || null;
    const embed = buildPanelEmbed(guild, s, effectiveLog);

    const components = section ? buildSectionRows(s, section) : buildMainRows(s);

    await msg.edit({ embeds: [embed], components }).catch(() => {});
  }

  /** -------------- Modals builders -------------- */
  function modalAntiJoin(s) {
    const aj = s.anti_join;
    const modal = new ModalBuilder().setCustomId("am:modal:aj").setTitle("Automod • Anti-Join");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("max_joins")
          .setLabel("Max joins")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(aj.max_joins))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("window_seconds")
          .setLabel("Fenêtre (secondes)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(aj.window_seconds))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("min_account_age_days")
          .setLabel("Âge min compte (jours)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(aj.min_account_age_days))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("timeout")
          .setLabel("Timeout (ex: 10m, 2h)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(formatDuration(aj.timeout_ms))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("cooldown_seconds")
          .setLabel("Cooldown (secondes)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(aj.cooldown_seconds))
      )
    );

    return modal;
  }

  function modalAntiMention(s) {
    const am = s.anti_mention;
    const modal = new ModalBuilder().setCustomId("am:modal:am").setTitle("Automod • Anti-Mention");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("max_mentions")
          .setLabel("Max mentions (users+roles)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(am.max_mentions))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("block_everyone")
          .setLabel("Bloquer @everyone/@here ? (true/false)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(!!am.block_everyone))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("timeout")
          .setLabel("Timeout (ex: 10m, 1h)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(formatDuration(am.timeout_ms))
      )
    );

    return modal;
  }

  function modalAntiLink(s) {
    const al = s.anti_link;
    const modal = new ModalBuilder().setCustomId("am:modal:al").setTitle("Automod • Anti-Link");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("block_invites")
          .setLabel("Bloquer invites ? (true/false)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(!!al.block_invites))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("no_links_under_account_age_days")
          .setLabel("No-links si compte < X jours")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(al.no_links_under_account_age_days))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("require_verified_role_for_invites")
          .setLabel("Invites require Verified role ? (true/false)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(!!al.require_verified_role_for_invites))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("timeout")
          .setLabel("Timeout (ex: 10m, 1h)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(formatDuration(al.timeout_ms))
      )
    );

    return modal;
  }

  function modalDomains(s) {
    const al = s.anti_link;
    const modal = new ModalBuilder().setCustomId("am:modal:domains").setTitle("Automod • Domains (Listes)");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("whitelist")
          .setLabel("Whitelist domains (1 par ligne)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setValue((al.whitelist_domains || []).join("\n").slice(0, 1800))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("blacklist")
          .setLabel("Blacklist domains (1 par ligne)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setValue((al.blacklist_domains || []).join("\n").slice(0, 1800))
      )
    );

    return modal;
  }

  function modalMetaLog(s) {
    const modal = new ModalBuilder().setCustomId("am:modal:meta_log").setTitle("Automod • Salon logs");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("log_channel_id")
          .setLabel("ID du salon logs Automod (vide = héritage /log set)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(s.log_channel_id || ""))
      )
    );

    return modal;
  }

  function modalMetaRoles(s) {
    const modal = new ModalBuilder().setCustomId("am:modal:meta_roles").setTitle("Automod • Rôles Trusted/Verified");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("trusted_role_id")
          .setLabel("Trusted role ID (vide = none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(s.trusted_role_id || ""))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("verified_role_id")
          .setLabel("Verified role ID (vide = none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(s.verified_role_id || ""))
      )
    );

    return modal;
  }

  function modalMetaLists(s) {
    const modal = new ModalBuilder().setCustomId("am:modal:meta_lists").setTitle("Automod • Whitelist/Ignore");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("whitelist_role_ids")
          .setLabel("Whitelist Role IDs (1 par ligne)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setValue((s.whitelist_role_ids || []).join("\n").slice(0, 1800))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ignored_channel_ids")
          .setLabel("Ignored Channel IDs (1 par ligne)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setValue((s.ignored_channel_ids || []).join("\n").slice(0, 1800))
      )
    );

    return modal;
  }

  /** -------------- Detection helpers -------------- */
  function memberHasWhitelistedRole(member, s) {
    if (!member) return false;
    const wl = s.whitelist_role_ids || [];
    if (!wl.length) return false;
    return wl.some((rid) => member.roles?.cache?.has(rid));
  }

  function isIgnoredChannel(channelId, s) {
    const ig = s.ignored_channel_ids || [];
    return ig.includes(channelId);
  }

  function isTrusted(member, s) {
    if (!member) return false;
    if (memberHasWhitelistedRole(member, s)) return true;
    if (s.trusted_role_id && member.roles?.cache?.has(s.trusted_role_id)) return true;
    return false;
  }

  function isVerified(member, s) {
    if (!member) return false;
    if (memberHasWhitelistedRole(member, s)) return true;
    if (s.verified_role_id && member.roles?.cache?.has(s.verified_role_id)) return true;
    return false;
  }

  async function handleGuildMemberAdd(member, client) {
    try {
      if (!member?.guild) return false;
      const guild = member.guild;

      const s = await getAutomodSettings(pool, guild.id);
      if (!s.enabled || !s.anti_join?.enabled) return false;

      // cooldown (anti spam lockdown)
      const cdUntil = runtime.cooldownUntil.get(guild.id) || 0;
      if (cdUntil > nowMs()) return false;

      const windowMs = clampInt(s.anti_join.window_seconds, 5, 600, 60) * 1000;
      const maxJoins = clampInt(s.anti_join.max_joins, 2, 100, 8);

      let arr = runtime.joinTimestamps.get(guild.id);
      if (!arr) {
        arr = [];
        runtime.joinTimestamps.set(guild.id, arr);
      }
      pushWindow(arr, nowMs(), windowMs);

      // compte récent
      const minAgeDays = clampInt(s.anti_join.min_account_age_days, 0, 365, 3);
      const accountAgeMs = nowMs() - member.user.createdTimestamp;
      const accountAgeDays = accountAgeMs / (1000 * 60 * 60 * 24);

      const raidDetected = arr.length >= maxJoins;
      const young = minAgeDays > 0 && accountAgeDays < minAgeDays;

      if (!raidDetected && !young) return false;

      const reason = raidDetected
        ? `Raid join détecté: ${arr.length} joins en ${s.anti_join.window_seconds}s`
        : `Compte trop récent: ${accountAgeDays.toFixed(1)}j (< ${minAgeDays}j)`;

      // action dépend mode/preset
      let action = s.anti_join.action;
      if (s.mode === "soft" && action === "kick") action = "timeout";
      if (s.mode === "soft" && action === "lockdown") action = "timeout";

      // apply
      if (action === "timeout") {
        const ms = clampInt(s.anti_join.timeout_ms, 30_000, 28 * 24 * 60 * 60 * 1000, 10 * 60 * 1000);
        await applyAutomodAction({
          pool,
          config,
          guild,
          settings: s,
          member,
          user: member.user,
          action: "timeout",
          reason,
          durationMs: ms,
          metadata: { type: "anti_join", raidDetected, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
        });
      } else if (action === "kick") {
        await applyAutomodAction({
          pool,
          config,
          guild,
          settings: s,
          member,
          user: member.user,
          action: "kick",
          reason,
          durationMs: null,
          metadata: { type: "anti_join", raidDetected, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
        });
      } else if (action === "lockdown") {
        await applyAutomodAction({
          pool,
          config,
          guild,
          settings: s,
          member,
          user: member.user,
          action: "lockdown",
          reason,
          durationMs: null,
          metadata: { type: "anti_join", raidDetected, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
        });
      } else {
        await applyAutomodAction({
          pool,
          config,
          guild,
          settings: s,
          member,
          user: member.user,
          action: "log",
          reason,
          durationMs: null,
          metadata: { type: "anti_join", raidDetected, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
        });
      }

      // cooldown anti-loop
      runtime.cooldownUntil.set(guild.id, nowMs() + clampInt(s.anti_join.cooldown_seconds, 10, 3600, 180) * 1000);
      return true;
    } catch (e) {
      console.error("automod guildMemberAdd error:", e);
      return false;
    }
  }

  async function handleMessage(message, client) {
    try {
      if (!message?.guild || !message.member || message.author?.bot) return false;

      const guild = message.guild;
      const s = await getAutomodSettings(pool, guild.id);
      if (!s.enabled) return false;
      if (isIgnoredChannel(message.channelId, s)) return false;

      // whitelist role => bypass
      if (isTrusted(message.member, s)) return false;

      // Anti-mention
      if (s.anti_mention?.enabled) {
        const mentionCount = (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0);
        const hasEveryone = message.mentions?.everyone || false;

        const tooMany = mentionCount >= clampInt(s.anti_mention.max_mentions, 2, 50, 6);
        const everyoneBlocked = !!s.anti_mention.block_everyone && hasEveryone && !hasPerm(message.member, PermissionsBitField.Flags.MentionEveryone);

        if (tooMany || everyoneBlocked) {
          let action = s.anti_mention.action;
          if (s.mode === "soft" && action === "ban") action = "timeout";

          const ms = clampInt(s.anti_mention.timeout_ms, 30_000, 28 * 24 * 60 * 60 * 1000, 10 * 60 * 1000);
          const reason = everyoneBlocked
            ? "@everyone/@here interdit (Automod)"
            : `Mass mention: ${mentionCount} mentions (>= ${s.anti_mention.max_mentions})`;

          if (action === "timeout") {
            await applyAutomodAction({
              pool,
              config,
              guild,
              settings: s,
              member: message.member,
              user: message.author,
              action: "timeout",
              reason,
              durationMs: ms,
              metadata: { type: "anti_mention", mentionCount, everyone: hasEveryone },
              messageToDelete: message,
            });
          } else if (action === "warn") {
            await applyAutomodAction({
              pool,
              config,
              guild,
              settings: s,
              member: message.member,
              user: message.author,
              action: "warn",
              reason,
              durationMs: null,
              metadata: { type: "anti_mention", mentionCount, everyone: hasEveryone },
              messageToDelete: message,
            });
          } else if (action === "ban") {
            await applyAutomodAction({
              pool,
              config,
              guild,
              settings: s,
              member: message.member,
              user: message.author,
              action: "ban",
              reason,
              durationMs: null,
              metadata: { type: "anti_mention", mentionCount, everyone: hasEveryone },
              messageToDelete: message,
            });
          } else {
            // delete/log
            await applyAutomodAction({
              pool,
              config,
              guild,
              settings: s,
              member: message.member,
              user: message.author,
              action: "delete",
              reason,
              durationMs: null,
              metadata: { type: "anti_mention", mentionCount, everyone: hasEveryone },
              messageToDelete: message,
            });
          }

          return true;
        }
      }

      // Anti-link
      if (s.anti_link?.enabled) {
        const domains = extractDomainsFromText(message.content || "");
        if (domains.length) {
          const accountAgeDays = (nowMs() - message.author.createdTimestamp) / (1000 * 60 * 60 * 24);

          const tooYoungNoLinks =
            clampInt(s.anti_link.no_links_under_account_age_days, 0, 365, 3) > 0 &&
            accountAgeDays < s.anti_link.no_links_under_account_age_days;

          const wl = (s.anti_link.whitelist_domains || []).map(normalizeDomain).filter(Boolean);
          const bl = (s.anti_link.blacklist_domains || []).map(normalizeDomain).filter(Boolean);

          const hasInvite = domains.includes("discord.gg");
          const allowInvite =
            !s.anti_link.block_invites ||
            isVerified(message.member, s) ||
            hasPerm(message.member, PermissionsBitField.Flags.CreateInstantInvite);

          const whitelistHit = domains.every((d) => wl.includes(d) || d === "discord.gg"); // accept invite separately
          const blacklistHit = domains.some((d) => bl.includes(d));

          const blocksInvite = hasInvite && !allowInvite && s.anti_link.block_invites;
          const blocksYoung = tooYoungNoLinks;
          const blocksBlacklist = blacklistHit;
          const blocksNotWhitelisted = !whitelistHit && wl.length > 0;

          const mustBlock =
            blocksInvite ||
            blocksYoung ||
            blocksBlacklist ||
            blocksNotWhitelisted ||
            (hasInvite && s.anti_link.require_verified_role_for_invites && !isVerified(message.member, s));

          if (mustBlock) {
            let action = s.anti_link.action;
            if (s.mode === "soft" && action === "ban") action = "timeout";

            const ms = clampInt(s.anti_link.timeout_ms, 30_000, 28 * 24 * 60 * 60 * 1000, 10 * 60 * 1000);

            const reason = blocksInvite
              ? "Invite Discord non autorisée"
              : blocksYoung
              ? `Lien interdit (compte trop récent: ${accountAgeDays.toFixed(1)}j)`
              : blocksBlacklist
              ? "Domaine blacklisté"
              : blocksNotWhitelisted
              ? "Domaine hors whitelist"
              : "Lien interdit (règles Automod)";

            if (action === "timeout") {
              await applyAutomodAction({
                pool,
                config,
                guild,
                settings: s,
                member: message.member,
                user: message.author,
                action: "timeout",
                reason,
                durationMs: ms,
                metadata: { type: "anti_link", domains, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
                messageToDelete: message,
              });
            } else if (action === "warn") {
              await applyAutomodAction({
                pool,
                config,
                guild,
                settings: s,
                member: message.member,
                user: message.author,
                action: "warn",
                reason,
                durationMs: null,
                metadata: { type: "anti_link", domains, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
                messageToDelete: message,
              });
            } else if (action === "ban") {
              await applyAutomodAction({
                pool,
                config,
                guild,
                settings: s,
                member: message.member,
                user: message.author,
                action: "ban",
                reason,
                durationMs: null,
                metadata: { type: "anti_link", domains, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
                messageToDelete: message,
              });
            } else {
              await applyAutomodAction({
                pool,
                config,
                guild,
                settings: s,
                member: message.member,
                user: message.author,
                action: "delete",
                reason,
                durationMs: null,
                metadata: { type: "anti_link", domains, accountAgeDays: Number(accountAgeDays.toFixed(2)) },
                messageToDelete: message,
              });
            }

            return true;
          }
        }
      }

      return false;
    } catch (e) {
      console.error("automod message error:", e);
      return false;
    }
  }

  /** -------------- Anti admin raid -------------- */
  async function handleChannelCreate(channel, client) {
    try {
      const guild = channel?.guild;
      if (!guild) return;

      const s = await getAutomodSettings(pool, guild.id);
      if (!s.enabled || !s.admin_raid?.enabled) return;

      const cdUntil = runtime.cooldownUntil.get(guild.id) || 0;
      if (cdUntil > nowMs()) return;

      let arr = runtime.adminCreateTimestamps.get(guild.id);
      if (!arr) {
        arr = [];
        runtime.adminCreateTimestamps.set(guild.id, arr);
      }
      pushWindow(arr, nowMs(), 10_000);

      if (arr.length < clampInt(s.admin_raid.max_channels_create_10s, 1, 50, 3)) return;

      // audit log best effort
      let executor = null;
      try {
        await new Promise((r) => setTimeout(r, 1200));
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 }).catch(() => null);
        executor = logs?.entries?.first()?.executor || null;
      } catch {}

      const reason = `Mass channel create détecté: ${arr.length} créations / 10s`;
      if (s.admin_raid.action === "lockdown") {
        await applyAutomodAction({ pool, config, guild, settings: s, user: executor, action: "lockdown", reason });
      } else {
        await applyAutomodAction({ pool, config, guild, settings: s, user: executor, action: "log", reason });
      }

      runtime.cooldownUntil.set(guild.id, nowMs() + clampInt(s.admin_raid.cooldown_seconds, 10, 3600, 180) * 1000);
    } catch (e) {
      console.error("automod channelCreate error:", e);
    }
  }

  async function handleChannelDelete(channel, client) {
    try {
      const guild = channel?.guild;
      if (!guild) return;

      const s = await getAutomodSettings(pool, guild.id);
      if (!s.enabled || !s.admin_raid?.enabled) return;

      const cdUntil = runtime.cooldownUntil.get(guild.id) || 0;
      if (cdUntil > nowMs()) return;

      let arr = runtime.adminDeleteTimestamps.get(guild.id);
      if (!arr) {
        arr = [];
        runtime.adminDeleteTimestamps.set(guild.id, arr);
      }
      pushWindow(arr, nowMs(), 10_000);

      if (arr.length < clampInt(s.admin_raid.max_channels_delete_10s, 1, 50, 2)) return;

      let executor = null;
      try {
        await new Promise((r) => setTimeout(r, 1200));
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 }).catch(() => null);
        executor = logs?.entries?.first()?.executor || null;
      } catch {}

      const reason = `Mass channel delete détecté: ${arr.length} suppressions / 10s`;
      if (s.admin_raid.action === "lockdown") {
        await applyAutomodAction({ pool, config, guild, settings: s, user: executor, action: "lockdown", reason });
      } else {
        await applyAutomodAction({ pool, config, guild, settings: s, user: executor, action: "log", reason });
      }

      runtime.cooldownUntil.set(guild.id, nowMs() + clampInt(s.admin_raid.cooldown_seconds, 10, 3600, 180) * 1000);
    } catch (e) {
      console.error("automod channelDelete error:", e);
    }
  }

  async function handleWebhooksUpdate(channel, client) {
    try {
      const guild = channel?.guild;
      if (!guild) return;

      const s = await getAutomodSettings(pool, guild.id);
      if (!s.enabled || !s.admin_raid?.enabled) return;

      const cdUntil = runtime.cooldownUntil.get(guild.id) || 0;
      if (cdUntil > nowMs()) return;

      let arr = runtime.webhookTimestamps.get(guild.id);
      if (!arr) {
        arr = [];
        runtime.webhookTimestamps.set(guild.id, arr);
      }
      pushWindow(arr, nowMs(), 30_000);

      if (arr.length < clampInt(s.admin_raid.max_webhooks_30s, 1, 50, 3)) return;

      let executor = null;
      try {
        await new Promise((r) => setTimeout(r, 1200));
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 1 }).catch(() => null);
        executor = logs?.entries?.first()?.executor || null;
      } catch {}

      const reason = `Webhook spam détecté: ${arr.length} updates / 30s`;

      if (s.admin_raid.action === "lockdown") {
        await applyAutomodAction({ pool, config, guild, settings: s, user: executor, action: "lockdown", reason });
      } else {
        await applyAutomodAction({ pool, config, guild, settings: s, user: executor, action: "log", reason });
      }

      runtime.cooldownUntil.set(guild.id, nowMs() + clampInt(s.admin_raid.cooldown_seconds, 10, 3600, 180) * 1000);
    } catch (e) {
      console.error("automod webhooksUpdate error:", e);
    }
  }

  /** -------------- Interaction handler -------------- */
  async function handleInteraction(interaction, client) {
    try {
      // Slash
      if (interaction.isChatInputCommand() && interaction.commandName === "automod") {
        if (!interaction.inGuild()) {
          await interaction.reply({ content: "⚠️ Utilisable uniquement sur un serveur.", flags: MessageFlags.Ephemeral });
          return true;
        }
        if (!isAdminLike(interaction)) {
          await interaction.reply({ content: "⛔ Admin requis pour configurer Automod.", flags: MessageFlags.Ephemeral });
          return true;
        }

        const sub = interaction.options.getSubcommand();

        if (sub === "panel") {
          const ch =
            interaction.options.getChannel("salon") || interaction.channel;
          if (!ch || !isTextChannelLike(ch)) {
            await interaction.reply({ content: "⚠️ Salon invalide.", flags: MessageFlags.Ephemeral });
            return true;
          }

          await interaction.reply({ content: "✅ Panel Automod envoyé / mis à jour.", flags: MessageFlags.Ephemeral });
          await renderAndUpsertPanel(client, interaction.guild, ch, false);
          return true;
        }

        if (sub === "status") {
          const s = await getAutomodSettings(pool, interaction.guildId);
          const modSettings = await getModSettings(pool, config, interaction.guildId);
          const effectiveLog = s.log_channel_id || modSettings.modlog_channel_id || null;
          const embed = buildPanelEmbed(interaction.guild, s, effectiveLog);
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          return true;
        }

        if (sub === "preset") {
          const mode = interaction.options.getString("mode", true);
          const next = await patchAutomodSettings(pool, interaction.guildId, (cur) => {
            const base = defaultAutomodSettings();
            const merged = { ...cur };
            merged.mode = mode;

            // presets
            if (mode === "soft") {
              merged.enabled = true;
              merged.anti_join.action = "timeout";
              merged.anti_join.max_joins = 8;
              merged.anti_join.window_seconds = 60;
              merged.anti_join.timeout_ms = 10 * 60 * 1000;

              merged.anti_mention.action = "warn";
              merged.anti_mention.max_mentions = 6;

              merged.anti_link.action = "warn";
              merged.anti_link.block_invites = true;

              merged.admin_raid.action = "log";
            } else {
              merged.enabled = true;
              merged.anti_join.action = "lockdown";
              merged.anti_join.max_joins = 8;
              merged.anti_join.window_seconds = 60;
              merged.anti_join.timeout_ms = 10 * 60 * 1000;

              merged.anti_mention.action = "timeout";
              merged.anti_mention.max_mentions = 6;

              merged.anti_link.action = "timeout";
              merged.anti_link.block_invites = true;

              merged.admin_raid.action = "lockdown";
            }
            return merged;
          });

          await interaction.reply({
            content: `✅ Preset appliqué: **${mode.toUpperCase()}**`,
            flags: MessageFlags.Ephemeral,
          });

          await editPanelMessage(interaction.guild, next, null);
          return true;
        }
      }

      // Components
      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        if (!interaction.inGuild()) return false;

        const guild = interaction.guild;
        const guildId = interaction.guildId;

        // sécurité panel
        if (String(interaction.customId || "").startsWith("am:") && !requireAdminPanel(interaction)) {
          await interaction.reply({ content: "⛔ Admin requis.", flags: MessageFlags.Ephemeral });
          return true;
        }

        // ----- Buttons main
        if (interaction.isButton() && interaction.customId === "am:toggle") {
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({ ...cur, enabled: !cur.enabled }));
          await interaction.reply({ content: `✅ Automod: ${next.enabled ? "Activé" : "Désactivé"}`, flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, null);
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:mode") {
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({ ...cur, mode: cur.mode === "soft" ? "hard" : "soft" }));
          await interaction.reply({ content: `✅ Mode: **${next.mode.toUpperCase()}**`, flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, null);
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:status") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.deferUpdate();
          await editPanelMessage(guild, s, null);
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:lockdown_toggle") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          let next = s;
          if (s.lockdown?.active) {
            next = await clearLockdown(pool, guild, s);
            await interaction.editReply("✅ Lockdown désactivé.");
          } else {
            const sec = clampInt(s.anti_join?.lockdown_seconds ?? 600, 60, 7200, 600);
            next = await applyLockdown(pool, guild, s, sec);
            await interaction.editReply(`✅ Lockdown activé (${sec}s).`);
          }

          await editPanelMessage(guild, next, null);
          return true;
        }

        // ----- Select section
        if (interaction.isStringSelectMenu() && interaction.customId === "am:section") {
          const section = interaction.values?.[0];
          const s = await getAutomodSettings(pool, guildId);
          await interaction.deferUpdate();
          await editPanelMessage(guild, s, section);
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:back") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.deferUpdate();
          await editPanelMessage(guild, s, null);
          return true;
        }

        // ----- Anti-join
        if (interaction.isButton() && interaction.customId === "am:aj:toggle") {
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_join: { ...cur.anti_join, enabled: !cur.anti_join.enabled },
          }));
          await interaction.reply({ content: `✅ Anti-Join: ${next.anti_join.enabled ? "ON" : "OFF"}`, flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_join");
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:aj:edit") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalAntiJoin(s));
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:aj:action") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.reply({ components: [buildActionSelect("am:aj:action_select", s.anti_join.action)], flags: MessageFlags.Ephemeral });
          return true;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === "am:aj:action_select") {
          const val = interaction.values?.[0];
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_join: { ...cur.anti_join, action: val },
          }));
          await interaction.update({ content: `✅ Anti-Join action: **${actionLabel(val)}**`, components: [] });
          await editPanelMessage(guild, next, "anti_join");
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:aj") {
          const max_joins = clampInt(interaction.fields.getTextInputValue("max_joins"), 2, 100, 8);
          const window_seconds = clampInt(interaction.fields.getTextInputValue("window_seconds"), 5, 600, 60);
          const min_account_age_days = clampInt(interaction.fields.getTextInputValue("min_account_age_days"), 0, 365, 3);
          const timeoutMs = parseDurationToMs(interaction.fields.getTextInputValue("timeout")) ?? 10 * 60 * 1000;
          const cooldown_seconds = clampInt(interaction.fields.getTextInputValue("cooldown_seconds"), 10, 3600, 180);

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_join: {
              ...cur.anti_join,
              max_joins,
              window_seconds,
              min_account_age_days,
              timeout_ms: timeoutMs,
              cooldown_seconds,
            },
          }));

          await interaction.reply({ content: "✅ Anti-Join mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_join");
          return true;
        }

        // ----- Anti-mention
        if (interaction.isButton() && interaction.customId === "am:am:toggle") {
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_mention: { ...cur.anti_mention, enabled: !cur.anti_mention.enabled },
          }));
          await interaction.reply({ content: `✅ Anti-Mention: ${next.anti_mention.enabled ? "ON" : "OFF"}`, flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_mention");
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:am:edit") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalAntiMention(s));
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:am:action") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.reply({ components: [buildActionSelect("am:am:action_select", s.anti_mention.action)], flags: MessageFlags.Ephemeral });
          return true;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === "am:am:action_select") {
          const val = interaction.values?.[0];
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_mention: { ...cur.anti_mention, action: val },
          }));
          await interaction.update({ content: `✅ Anti-Mention action: **${actionLabel(val)}**`, components: [] });
          await editPanelMessage(guild, next, "anti_mention");
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:am") {
          const max_mentions = clampInt(interaction.fields.getTextInputValue("max_mentions"), 2, 50, 6);
          const block_everyone = String(interaction.fields.getTextInputValue("block_everyone")).trim().toLowerCase() === "true";
          const timeoutMs = parseDurationToMs(interaction.fields.getTextInputValue("timeout")) ?? 10 * 60 * 1000;

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_mention: {
              ...cur.anti_mention,
              max_mentions,
              block_everyone,
              timeout_ms: timeoutMs,
            },
          }));

          await interaction.reply({ content: "✅ Anti-Mention mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_mention");
          return true;
        }

        // ----- Anti-link
        if (interaction.isButton() && interaction.customId === "am:al:toggle") {
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_link: { ...cur.anti_link, enabled: !cur.anti_link.enabled },
          }));
          await interaction.reply({ content: `✅ Anti-Link: ${next.anti_link.enabled ? "ON" : "OFF"}`, flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_link");
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:al:edit") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalAntiLink(s));
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:al:lists") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalDomains(s));
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:al") {
          const block_invites = String(interaction.fields.getTextInputValue("block_invites")).trim().toLowerCase() === "true";
          const no_links_under_account_age_days = clampInt(interaction.fields.getTextInputValue("no_links_under_account_age_days"), 0, 365, 3);
          const require_verified_role_for_invites =
            String(interaction.fields.getTextInputValue("require_verified_role_for_invites")).trim().toLowerCase() === "true";
          const timeoutMs = parseDurationToMs(interaction.fields.getTextInputValue("timeout")) ?? 10 * 60 * 1000;

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_link: {
              ...cur.anti_link,
              block_invites,
              no_links_under_account_age_days,
              require_verified_role_for_invites,
              timeout_ms: timeoutMs,
            },
          }));

          await interaction.reply({ content: "✅ Anti-Link mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_link");
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:domains") {
          const wlRaw = interaction.fields.getTextInputValue("whitelist") || "";
          const blRaw = interaction.fields.getTextInputValue("blacklist") || "";

          const wl = wlRaw
            .split("\n")
            .map(normalizeDomain)
            .filter(Boolean)
            .slice(0, 80);

          const bl = blRaw
            .split("\n")
            .map(normalizeDomain)
            .filter(Boolean)
            .slice(0, 80);

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            anti_link: { ...cur.anti_link, whitelist_domains: wl, blacklist_domains: bl },
          }));

          await interaction.reply({ content: "✅ Listes domains mises à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "anti_link");
          return true;
        }

        // ----- Admin raid
        if (interaction.isButton() && interaction.customId === "am:ar:toggle") {
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            admin_raid: { ...cur.admin_raid, enabled: !cur.admin_raid.enabled },
          }));
          await interaction.reply({ content: `✅ Admin-Raid: ${next.admin_raid.enabled ? "ON" : "OFF"}`, flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "admin_raid");
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:ar:edit") {
          const s = await getAutomodSettings(pool, guildId);

          const modal = new ModalBuilder().setCustomId("am:modal:ar").setTitle("Automod • Anti-Raid Admin");
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("max_create")
                .setLabel("Max channels CREATE / 10s")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(s.admin_raid.max_channels_create_10s))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("max_delete")
                .setLabel("Max channels DELETE / 10s")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(s.admin_raid.max_channels_delete_10s))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("max_webhooks")
                .setLabel("Max webhooks / 30s")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(s.admin_raid.max_webhooks_30s))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("cooldown")
                .setLabel("Cooldown (secondes)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(s.admin_raid.cooldown_seconds))
            )
          );

          await interaction.showModal(modal);
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:ar:action") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.reply({ components: [buildActionSelect("am:ar:action_select", s.admin_raid.action)], flags: MessageFlags.Ephemeral });
          return true;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === "am:ar:action_select") {
          const val = interaction.values?.[0];
          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            admin_raid: { ...cur.admin_raid, action: val },
          }));
          await interaction.update({ content: `✅ Admin-Raid action: **${actionLabel(val)}**`, components: [] });
          await editPanelMessage(guild, next, "admin_raid");
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:ar") {
          const max_channels_create_10s = clampInt(interaction.fields.getTextInputValue("max_create"), 1, 50, 3);
          const max_channels_delete_10s = clampInt(interaction.fields.getTextInputValue("max_delete"), 1, 50, 2);
          const max_webhooks_30s = clampInt(interaction.fields.getTextInputValue("max_webhooks"), 1, 50, 3);
          const cooldown_seconds = clampInt(interaction.fields.getTextInputValue("cooldown"), 10, 3600, 180);

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            admin_raid: {
              ...cur.admin_raid,
              max_channels_create_10s,
              max_channels_delete_10s,
              max_webhooks_30s,
              cooldown_seconds,
            },
          }));

          await interaction.reply({ content: "✅ Admin-Raid mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "admin_raid");
          return true;
        }

        // ----- Meta
        if (interaction.isButton() && interaction.customId === "am:meta:log") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalMetaLog(s));
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:meta_log") {
          const raw = (interaction.fields.getTextInputValue("log_channel_id") || "").trim();
          const log_channel_id = raw ? raw.replace(/[<#!>]/g, "").trim() : null;

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            log_channel_id,
          }));

          await interaction.reply({ content: "✅ Salon logs Automod mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "meta");
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:meta:roles") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalMetaRoles(s));
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:meta_roles") {
          const tr = (interaction.fields.getTextInputValue("trusted_role_id") || "").trim();
          const vr = (interaction.fields.getTextInputValue("verified_role_id") || "").trim();

          const trusted_role_id = tr ? tr.replace(/[<@&>]/g, "").trim() : null;
          const verified_role_id = vr ? vr.replace(/[<@&>]/g, "").trim() : null;

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            trusted_role_id,
            verified_role_id,
          }));

          await interaction.reply({ content: "✅ Rôles Trusted/Verified mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "meta");
          return true;
        }

        if (interaction.isButton() && interaction.customId === "am:meta:lists") {
          const s = await getAutomodSettings(pool, guildId);
          await interaction.showModal(modalMetaLists(s));
          return true;
        }

        if (interaction.isModalSubmit() && interaction.customId === "am:modal:meta_lists") {
          const wlRaw = interaction.fields.getTextInputValue("whitelist_role_ids") || "";
          const igRaw = interaction.fields.getTextInputValue("ignored_channel_ids") || "";

          const whitelist_role_ids = wlRaw
            .split("\n")
            .map((x) => x.trim().replace(/[<@&>]/g, "").trim())
            .filter((x) => /^\d{15,21}$/.test(x))
            .slice(0, 80);

          const ignored_channel_ids = igRaw
            .split("\n")
            .map((x) => x.trim().replace(/[<#!>]/g, "").trim())
            .filter((x) => /^\d{15,21}$/.test(x))
            .slice(0, 120);

          const next = await patchAutomodSettings(pool, guildId, (cur) => ({
            ...cur,
            whitelist_role_ids,
            ignored_channel_ids,
          }));

          await interaction.reply({ content: "✅ Whitelist/Ignore mis à jour.", flags: MessageFlags.Ephemeral });
          await editPanelMessage(guild, next, "meta");
          return true;
        }

        return false;
      }

      return false;
    } catch (e) {
      console.error("automod interaction fatal:", e);
      if (interaction?.isRepliable?.()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: "⚠️ Erreur interne Automod (voir logs).", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
      return true;
    }
  }

  return {
    commands,
    handleInteraction,
    handleMessage,
    handleGuildMemberAdd,
    handleChannelCreate,
    handleChannelDelete,
    handleWebhooksUpdate,
    // utile si tu veux régénérer panel au boot dans le futur:
    renderAndUpsertPanel,
  };
}

module.exports = { createAutomodService };
