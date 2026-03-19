// tickets.js (FULL) — Premium Setup Wizard + Premium Ticket Panel Builder + Panel Premium (Select/Buttons/Simple → Modal/Form (optional) → Ticket)
// ✅ Conserve: ticket-config, ticket-stats, tout le système ticket:* (claim/close/transcript/delete/feedback)
// ✅ Ajouts demandés (dans /ticket-panel builder):
//   - Toggle "Formulaire" ✅ Avec / ❌ Sans
//      -> Avec  : Catégorie → Modal → Ticket
//      -> Sans  : Catégorie → Ticket direct (sans modal)
//   - Mode Simple: possibilité de modifier le texte du bouton (via option après la modal, car modal Discord max 5 champs)
//
// Notes:
// - Fix Discord limit select options <= 25 (helper safeSliceForSelect)
// - /ticket-panel: si "mode" est fourni => comportement legacy (comme avant). Sinon => builder premium.
// - Discord modal = max 5 inputs => pour Mode Simple, la couleur + texte bouton sont réglés via actions après la modal.

const crypto = require("crypto");
const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");

/* ---------------- Presets ---------------- */

const PRESET_CATEGORIES = [
  { label: "Support", value: "support", description: "Aide / assistance", emoji: "🛠️" },
  { label: "Vente de Brainrot", value: "vente-brainrot", description: "Achat / vente", emoji: "🛒" },
  { label: "Recrutement", value: "recrutement", description: "Candidature / staff", emoji: "🧑‍💼" },
  { label: "Questions", value: "questions", description: "Questions générales", emoji: "❓" },
];

/* ---------------- Utils ---------------- */

function nowIso(ts) {
  const d = new Date(ts ?? Date.now());
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator));
}

function buildStars(n) {
  const v = clamp(Number(n) || 0, 1, 5);
  return "⭐".repeat(v);
}

function normalizeFreeReason(input) {
  const s = (input || "").toString().trim();
  if (!s) return null;
  return s.slice(0, 100);
}

function safeSliceForSelect(list, reserved = 0) {
  // Discord hard limit: 25 options per select
  return (list || []).slice(0, Math.max(0, 25 - reserved));
}

function parseCategories(input) {
  if (!input || !input.trim()) return null;

  const items = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25);

  const used = new Set();
  const out = [];

  for (const item of items) {
    const [labelRaw, descRaw] = item.split("|").map((x) => (x ?? "").trim());
    const label = (labelRaw || "").slice(0, 100);
    if (!label) continue;

    let value = label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    if (!value) value = "cat";
    let i = 2;
    while (used.has(value)) {
      const v2 = `${value}-${i++}`.slice(0, 50);
      if (!used.has(v2)) {
        value = v2;
        break;
      }
    }
    used.add(value);

    out.push({
      label,
      value,
      description: descRaw ? descRaw.slice(0, 100) : undefined,
    });
  }

  return out.length ? out : null;
}

/* ---- Mode Simple helpers ---- */

function slugValue(input) {
  const s = (input || "support")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return s || "support";
}

function parseButtonStyle(input) {
  const raw = (input || "").toString().trim().toLowerCase();
  if (!raw) return ButtonStyle.Primary;

  if (["primary", "blue", "bleu"].includes(raw)) return ButtonStyle.Primary;
  if (["success", "green", "vert"].includes(raw)) return ButtonStyle.Success;
  if (["danger", "red", "rouge"].includes(raw)) return ButtonStyle.Danger;
  if (["secondary", "grey", "gray", "gris"].includes(raw)) return ButtonStyle.Secondary;

  return ButtonStyle.Primary;
}

function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseComponentEmoji(raw) {
  const input = (raw || "").toString().trim();
  if (!input) return null;

  const custom = input.match(/^<(?:(a)?):([a-zA-Z0-9_]{2,32}):(\d{17,20})>$/);
  if (custom) {
    const [, animated, name, id] = custom;
    return { id, name, animated: Boolean(animated) };
  }

  if (/^\d{17,20}$/.test(input)) {
    return { id: input };
  }

  return { name: input };
}

function parseSimpleButtonVisual(rawLabel, guild) {
  const fallback = "Ouvrir un ticket";
  const input = (rawLabel || "").toString().trim();
  if (!input) return { label: fallback, emoji: null };

  // 1) Format complet Discord custom emoji: <a:name:id> / <:name:id>
  const fullCustom = input.match(/^(<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>)(?:\s+)?([\s\S]*)$/);
  if (fullCustom) {
    const [, token, rest] = fullCustom;
    return {
      label: (rest || fallback).trim().slice(0, 80) || fallback,
      emoji: parseComponentEmoji(token),
    };
  }

  // 2) Alias par nom Discord :nom: (on résout dans le serveur)
  const namedAlias = input.match(/^:([a-zA-Z0-9_]{2,32}):(?:\s+)?([\s\S]*)$/);
  if (namedAlias) {
    const [, name, rest] = namedAlias;
    const guildEmoji = guild?.emojis?.cache?.find((e) => e.name === name);
    if (guildEmoji) {
      return {
        label: (rest || fallback).trim().slice(0, 80) || fallback,
        emoji: { id: guildEmoji.id, name: guildEmoji.name, animated: guildEmoji.animated },
      };
    }
  }

  // 3) Emoji unicode placé au début du texte (ex: "🚀 Ouvrir un ticket")
  const unicodeFirst = input.match(/^(\p{Extended_Pictographic}(?:\uFE0F)?)(?:\s+)?([\s\S]*)$/u);
  if (unicodeFirst) {
    const [, uni, rest] = unicodeFirst;
    return {
      label: (rest || fallback).trim().slice(0, 80) || fallback,
      emoji: parseComponentEmoji(uni),
    };
  }

  // 4) Fallback: texte seul
  return { label: input.slice(0, 80), emoji: null };
}

function resolveNamedEmojiAliases(text, guild) {
  const input = (text || "").toString();
  if (!input) return input;
  return input.replace(/:([a-zA-Z0-9_]{2,32}):/g, (full, name) => {
    const found = guild?.emojis?.cache?.find((e) => e.name === name);
    if (!found) return full;
    return `<${found.animated ? "a" : ""}:${found.name}:${found.id}>`;
  });
}

/**
 * Réponse éphémère robuste:
 * - si interaction a deferReply -> editReply
 * - si interaction a deferUpdate ou reply déjà fait -> followUp éphémère
 */
async function replyEphemeral(interaction, payload) {
  const pReply = { ...payload, flags: MessageFlags.Ephemeral };
  delete pReply.ephemeral;

  const pEdit = { ...payload };
  delete pEdit.ephemeral;
  delete pEdit.flags;

  if (interaction.deferred || interaction.replied) {
    try {
      return await interaction.editReply(pEdit);
    } catch {
      return await interaction.followUp(pReply).catch(() => {});
    }
  }

  return await interaction.reply(pReply).catch(() => {});
}

async function safeDeferUpdate(interaction) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferUpdate().catch(() => {});
}

async function safeFollowUpEphemeral(interaction, payload) {
  const p = { ...payload, flags: MessageFlags.Ephemeral };
  delete p.ephemeral;
  await interaction.followUp(p).catch(() => {});
}

async function safeChannelSend(channel, content) {
  if (!channel?.isTextBased?.()) return;
  await channel.send({ content }).catch(() => {});
}

async function fetchAllMessages(channel, maxMessages = 1000) {
  const all = [];
  let before;

  while (all.length < maxMessages) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const arr = Array.from(batch.values());
    all.push(...arr);
    before = arr[arr.length - 1].id;
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all;
}

function renderTranscript(channel, messages) {
  const header = [
    `Transcript du salon #${channel.name}`,
    `Channel ID: ${channel.id}`,
    `Généré: ${nowIso()}`,
    `----------------------------------------`,
    ``,
  ].join("\n");

  const lines = messages.map((m) => {
    const author = m.author
      ? `${m.author.username}${
          m.author.discriminator && m.author.discriminator !== "0"
            ? `#${m.author.discriminator}`
            : ""
        } (${m.author.id})`
      : "Unknown";
    const ts = nowIso(m.createdTimestamp);
    const content = (m.content || "").replace(/\r/g, "");

    const att =
      m.attachments && m.attachments.size
        ? `\n[Attachments]\n${Array.from(m.attachments.values())
            .map((a) => `- ${a.url}`)
            .join("\n")}`
        : "";

    return `[${ts}] ${author}\n${content}${att}\n`;
  });

  return header + lines.join("\n");
}

/* ---------------- Lock anti-concurrence ---------------- */

const ticketLocks = new Map();

async function acquireTicketLock(ticketId, timeoutMs = 15000) {
  const key = String(ticketId || "unknown");

  while (ticketLocks.has(key)) {
    const entry = ticketLocks.get(key);
    if (!entry) break;
    await entry.promise.catch(() => {});
  }

  let released = false;
  let resolvePromise;
  const promise = new Promise((res) => (resolvePromise = res));

  const timer = setTimeout(() => {
    if (!released) {
      released = true;
      ticketLocks.delete(key);
      resolvePromise();
    }
  }, timeoutMs);

  ticketLocks.set(key, { promise });

  return () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const cur = ticketLocks.get(key);
    if (cur && cur.promise === promise) ticketLocks.delete(key);
    resolvePromise();
  };
}

/* ---------------- Naming ---------------- */

function short4ForChannel(username) {
  const base = (username || "user")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

  const s = (base || "user").slice(0, 4);
  return s || "user";
}

function slugCategory(label) {
  const s = (label || "support")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  return s || "support";
}

function buildTicketChannelName({ claimed, username, categoryLabel }) {
  const emoji = claimed ? "🔴" : "🟢";
  const short = short4ForChannel(username);
  const cat = slugCategory(categoryLabel);
  return `${emoji}-${short}-${cat}`.slice(0, 100);
}

async function tryRenameTicketChannel(channel, newName) {
  if (!channel || !channel.setName) return;
  if (!newName || channel.name === newName) return;
  await channel.setName(newName).catch(() => {});
}

/* ---------------- Premium UI Helpers ---------------- */

function premiumColor() {
  return 0xff2d2d; // rouge luxe
}
function buildPremiumAuthor(guild) {
  return {
    name: `${guild?.name || "Serveur"} • Ticket Center`,
    iconURL: guild?.iconURL?.({ size: 128 }) ?? undefined,
  };
}

function buildPremiumPanelEmbed({ guild, title, description, banner, bannerPosition }) {
  const safeTitle = resolveNamedEmojiAliases(title || "🎫 Support Center", guild);
  const safeDescription = resolveNamedEmojiAliases(
    description ||
      [
        "Sélectionne une catégorie pour ouvrir un ticket.",
        "",
        "✅ **Process premium** : *Catégorie → Formulaire → Ticket créé*",
        "⚠️ Merci d’être précis pour une réponse rapide.",
      ].join("\n"),
    guild
  );

  const embed = new EmbedBuilder()
    .setColor(premiumColor())
    .setAuthor(buildPremiumAuthor(guild))
    .setTitle(safeTitle)
    .setDescription(safeDescription)
    .setFooter({ text: "Tickets Premium • Mino Bot" })
    .setTimestamp();

  if (banner && isValidHttpUrl(banner) && (bannerPosition || "bottom") === "bottom") embed.setImage(banner);
  return embed;
}

function buildTopBannerEmbed(banner) {
  return new EmbedBuilder().setColor(premiumColor()).setImage(banner);
}

/* ---------------- Ticket UI ---------------- */

function buildTicketEmbed({ openerId, categoryLabel, ticketId, claimedBy, subject, details, guild }) {
  const priseEnCharge = claimedBy ? `<@${claimedBy}>` : "Non pris en charge.";

  const e = new EmbedBuilder()
    .setColor(premiumColor())
    .setAuthor(buildPremiumAuthor(guild))
    .setTitle("🎫 Ticket créé")
    .setDescription(
      [
        `**Auteur :** <@${openerId}>`,
        `**Raison :** ${categoryLabel || "Support"}`,
        `**Pris en charge :** ${priseEnCharge}`,
        ``,
        `Explique ton besoin ici. Un staff va te répondre.`,
      ].join("\n")
    )
    .setFooter({ text: `Ticket ID: ${ticketId}` })
    .setTimestamp();

  if (subject) e.addFields({ name: "Sujet", value: String(subject).slice(0, 256) });
  if (details) e.addFields({ name: "Détails", value: String(details).slice(0, 1024) });

  return e;
}

function buildTicketControls(ticketId, isClaimed) {
  const claimBtn = isClaimed
    ? new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel("Unclaim").setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel("Claim").setStyle(ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(
    claimBtn,
    new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel("Fermer").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket:transcript:${ticketId}`)
      .setLabel("Transcript (admin)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:delete:${ticketId}`).setLabel("Supprimer (admin)").setStyle(ButtonStyle.Danger)
  );
}

async function updateTicketMessage(interaction, data) {
  const channel = interaction.channel;
  const messageId = interaction.message?.id;

  if (!channel?.isTextBased?.() || !messageId) return;

  const msg = (await channel.messages.fetch(messageId).catch(() => null)) || interaction.message;
  if (!msg?.edit) return;

  const embed = buildTicketEmbed(data);
  const controls = buildTicketControls(data.ticketId, Boolean(data.claimedBy));

  await msg.edit({ content: msg.content ?? undefined, embeds: [embed], components: [controls] }).catch(() => {});
}

/* ---------------- Wizard Drafts (Admin) ---------------- */

// ticket-setup drafts
const setupDrafts = new Map();
function dKey(guildId, userId) {
  return `${guildId}:${userId}`;
}
function getDraft(guildId, userId) {
  return setupDrafts.get(dKey(guildId, userId)) || null;
}
function setDraft(guildId, userId, value) {
  setupDrafts.set(dKey(guildId, userId), { ...value, _t: Date.now() });
}

// /ticket-panel builder drafts (separate)
const panelDrafts = new Map();
function pKey(guildId, userId) {
  return `${guildId}:${userId}`;
}
function getPanelDraft(guildId, userId) {
  return panelDrafts.get(pKey(guildId, userId)) || null;
}
function setPanelDraft(guildId, userId, value) {
  panelDrafts.set(pKey(guildId, userId), { ...value, _t: Date.now() });
}

/* ---------------- Service ---------------- */

function createTicketsService({ pool, config }) {
  /* ---------------- Slash commands ---------------- */

  // /ticket-panel is now PREMIUM builder by default.
  // If "mode" is provided => legacy behavior (same as before).
  const ticketPanelCmd = new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("ADMIN: Interface premium pour créer & publier un panel de tickets")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("LEGACY: simple=bouton | categories=menu (si vide => builder premium)")
        .setRequired(false)
        .addChoices({ name: "simple", value: "simple" }, { name: "categories", value: "categories" })
    )
    .addChannelOption((opt) =>
      opt
        .setName("salon")
        .setDescription("LEGACY: Salon où poster le panel (sinon salon actuel)")
        .setRequired(false)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
    )
    .addStringOption((opt) =>
      opt.setName("titre").setDescription("LEGACY: Titre de l'embed").setRequired(false).setMaxLength(256)
    )
    .addStringOption((opt) =>
      opt.setName("description").setDescription("LEGACY: Texte de l'embed").setRequired(false).setMaxLength(1500)
    )
    .addStringOption((opt) =>
      opt
        .setName("categories")
        .setDescription("LEGACY: Simple=raison libre | Categories=liste (Support|Aide, Recrutement|Candidature)")
        .setRequired(false)
        .setMaxLength(1000)
    );

  const ticketConfigCmd = new SlashCommandBuilder()
    .setName("ticket-config")
    .setDescription("ADMIN: Configure le système de tickets")
    .addSubcommand((sub) => sub.setName("show").setDescription("Affiche la configuration actuelle"))
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Modifie la configuration")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("Catégorie où créer les tickets")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildCategory)
        )
        .addRoleOption((opt) => opt.setName("staff_role").setDescription("Rôle staff (optionnel)").setRequired(false))
        .addChannelOption((opt) =>
          opt
            .setName("admin_feedback_channel")
            .setDescription("Salon admin-only pour feedback ⭐")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addChannelOption((opt) =>
          opt
            .setName("transcript_channel")
            .setDescription("Salon admin-only pour transcripts (optionnel)")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("max_open")
            .setDescription("Tickets ouverts max par user")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(5)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("cooldown_minutes")
            .setDescription("Cooldown création ticket (minutes)")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(1440)
        )
        .addBooleanOption((opt) => opt.setName("claim_exclusive").setDescription("Claim exclusif").setRequired(false))
        .addBooleanOption((opt) =>
          opt.setName("delete_on_close").setDescription("Supprimer auto après close").setRequired(false)
        )
    );

  const ticketStatsCmd = new SlashCommandBuilder()
    .setName("ticket-stats")
    .setDescription("ADMIN: Stats tickets/feedback")
    .addIntegerOption((opt) =>
      opt
        .setName("days")
        .setDescription("Période en jours (défaut 30)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(365)
    );

  const ticketSetupCmd = new SlashCommandBuilder()
    .setName("ticket-setup")
    .setDescription("ADMIN: Interface premium pour config + publier un panel pro");

  const commands = [ticketPanelCmd, ticketConfigCmd, ticketStatsCmd, ticketSetupCmd];

  /* ---------------- Settings ---------------- */

  const DEFAULT_SETTINGS = {
    category_id: config.TICKET_CATEGORY_ID || null,
    staff_role_id: config.TICKET_STAFF_ROLE_ID || null,
    admin_feedback_channel_id: config.ADMIN_FEEDBACK_CHANNEL_ID || null,
    transcript_channel_id: config.TICKET_TRANSCRIPT_CHANNEL_ID || null,
    max_open_per_user: Number(config.TICKET_MAX_OPEN_PER_USER || 1),
    cooldown_seconds: Number(config.TICKET_COOLDOWN_SECONDS || 600),
    claim_exclusive: Boolean(config.TICKET_CLAIM_EXCLUSIVE),
    delete_on_close: Boolean(config.TICKET_DELETE_ON_CLOSE),
  };

  let ensuredExtraCols = false;
  async function ensureExtraColumns() {
    if (ensuredExtraCols) return;
    ensuredExtraCols = true;
    try {
      await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS subject TEXT;`);
      await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS details TEXT;`);
    } catch {}
  }

  async function getSettings(guildId) {
    const res = await pool.query(
      `SELECT category_id, staff_role_id, admin_feedback_channel_id, transcript_channel_id,
              max_open_per_user, cooldown_seconds, claim_exclusive, delete_on_close
       FROM ticket_settings WHERE guild_id=$1 LIMIT 1`,
      [guildId]
    );
    const row = res.rows[0] || {};
    const merged = { ...DEFAULT_SETTINGS };

    for (const k of Object.keys(merged)) {
      if (row[k] !== null && row[k] !== undefined) merged[k] = row[k];
    }

    merged.max_open_per_user = clamp(Number(merged.max_open_per_user || 1), 1, 5);
    merged.cooldown_seconds = clamp(Number(merged.cooldown_seconds || 0), 0, 86400);
    return merged;
  }

  async function upsertSettings(guildId, patch) {
    const cur = await getSettings(guildId);
    const next = { ...cur, ...patch };

    await pool.query(
      `INSERT INTO ticket_settings
        (guild_id, category_id, staff_role_id, admin_feedback_channel_id, transcript_channel_id,
         max_open_per_user, cooldown_seconds, claim_exclusive, delete_on_close)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (guild_id) DO UPDATE SET
         category_id=EXCLUDED.category_id,
         staff_role_id=EXCLUDED.staff_role_id,
         admin_feedback_channel_id=EXCLUDED.admin_feedback_channel_id,
         transcript_channel_id=EXCLUDED.transcript_channel_id,
         max_open_per_user=EXCLUDED.max_open_per_user,
         cooldown_seconds=EXCLUDED.cooldown_seconds,
         claim_exclusive=EXCLUDED.claim_exclusive,
         delete_on_close=EXCLUDED.delete_on_close,
         updated_at=NOW()`,
      [
        guildId,
        next.category_id,
        next.staff_role_id,
        next.admin_feedback_channel_id,
        next.transcript_channel_id,
        next.max_open_per_user,
        next.cooldown_seconds,
        next.claim_exclusive,
        next.delete_on_close,
      ]
    );

    return next;
  }

  function isStaff(interaction, settings) {
    if (isAdmin(interaction)) return true;
    if (!settings.staff_role_id) return false;
    return Boolean(interaction.member?.roles?.cache?.has?.(settings.staff_role_id));
  }

  /* ---------------- Panel creation (LEGACY) ---------------- */

  async function createPanelLegacy(interaction) {
    if (!isAdmin(interaction)) {
      await replyEphemeral(interaction, { content: "⛔ Admin uniquement." });
      return true;
    }

    const mode = interaction.options.getString("mode", true);
    const title = interaction.options.getString("titre") || "🎫 Ouvrir un ticket";
    const desc =
      interaction.options.getString("description") ||
      "Clique pour créer un ticket. Un staff te répondra dès que possible.";

    const targetChannel = interaction.options.getChannel("salon") || interaction.channel;
    if (!targetChannel || !targetChannel.isTextBased?.()) {
      await replyEphemeral(interaction, { content: "⚠️ Salon invalide." });
      return true;
    }

    const panelId = crypto.randomUUID();
    const rawCategoriesOrReason = interaction.options.getString("categories") || "";
    let modePayload = null;

    let components = [];
    if (mode === "simple") {
      const freeReason = normalizeFreeReason(rawCategoriesOrReason) || "Support";
      modePayload = { simple_reason: freeReason };

      components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket:open:${panelId}`)
            .setLabel("Ouvrir un ticket")
            .setStyle(ButtonStyle.Primary)
        ),
      ];
    } else {
      const categories = parseCategories(rawCategoriesOrReason) || PRESET_CATEGORIES;
      modePayload = { categories };

      const opts = safeSliceForSelect(
        categories.map((c) => ({
          label: c.label,
          value: c.value,
          description: c.description,
        }))
      );

      components = [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket:select:${panelId}`)
            .setPlaceholder("Choisis une raison…")
            .addOptions(opts)
        ),
      ];
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(desc)
      .setFooter({ text: `Panel ID: ${panelId}` })
      .setTimestamp();

    const msg = await targetChannel.send({ embeds: [embed], components });

    await pool.query(
      `INSERT INTO ticket_panels (panel_id, guild_id, channel_id, message_id, mode, categories, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (panel_id) DO NOTHING`,
      [
        panelId,
        interaction.guildId,
        msg.channel.id,
        msg.id,
        mode,
        modePayload ? JSON.stringify(modePayload) : null,
        interaction.user.id,
      ]
    );

    await replyEphemeral(interaction, { content: `✅ Panel posté dans <#${msg.channel.id}>.` });
    return true;
  }

  /* ---------------- Ticket creation rules ---------------- */

  async function ensureCanCreate(interaction, settings) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    const openRes = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM tickets
       WHERE guild_id=$1 AND opener_id=$2 AND status='open'`,
      [guildId, userId]
    );

    if ((openRes.rows[0]?.c || 0) >= settings.max_open_per_user) {
      return { ok: false, message: `⛔ Tu as déjà ${openRes.rows[0].c} ticket(s) ouvert(s).` };
    }

    const lastRes = await pool.query(
      `SELECT created_at
       FROM tickets
       WHERE guild_id=$1 AND opener_id=$2
       ORDER BY created_at DESC
       LIMIT 1`,
      [guildId, userId]
    );

    if (lastRes.rows.length && settings.cooldown_seconds > 0) {
      const last = new Date(lastRes.rows[0].created_at).getTime();
      const diffSec = Math.floor((Date.now() - last) / 1000);
      if (diffSec < settings.cooldown_seconds) {
        const left = settings.cooldown_seconds - diffSec;
        return { ok: false, message: `⏳ Cooldown: réessaie dans ${Math.ceil(left / 60)} min.` };
      }
    }

    return { ok: true };
  }

  async function createTicket(interaction, reasonLabel, subject = null, details = null) {
    await ensureExtraColumns();

    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, { content: "⚠️ Serveur introuvable." });
      return true;
    }

    const settings = await getSettings(guild.id);
    if (!settings.category_id) {
      await replyEphemeral(interaction, {
        content: "⚠️ Catégorie tickets non configurée. Fais `/ticket-config set category:...`.",
      });
      return true;
    }

    const check = await ensureCanCreate(interaction, settings);
    if (!check.ok) {
      await replyEphemeral(interaction, { content: check.message });
      return true;
    }

    const ticketId = crypto.randomUUID();
    const reason = (reasonLabel || "Support").toString().trim().slice(0, 100);

    const channelName = buildTicketChannelName({
      claimed: false,
      username: interaction.user.username,
      categoryLabel: reason,
    });

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.EmbedLinks,
        ],
      },
    ];

    if (settings.staff_role_id) {
      overwrites.push({
        id: settings.staff_role_id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
        ],
      });
    }

    const me = await guild.members.fetchMe().catch(() => null);
    if (me) {
      overwrites.push({
        id: me.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageMessages,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.EmbedLinks,
        ],
      });
    }

    let channel;
    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: settings.category_id,
        topic: `ticket_id=${ticketId} opener=${interaction.user.id}`,
        permissionOverwrites: overwrites,
        reason: "Ticket created",
      });
    } catch {
      await replyEphemeral(interaction, {
        content: "⚠️ Impossible de créer le salon ticket (permissions/catégorie invalide).",
      });
      return true;
    }

    await pool
      .query(
        `INSERT INTO tickets (ticket_id, guild_id, channel_id, opener_id, category_label, status, subject, details)
         VALUES ($1,$2,$3,$4,$5,'open',$6,$7)`,
        [ticketId, guild.id, channel.id, interaction.user.id, reason, subject, details]
      )
      .catch(async () => {
        await pool.query(
          `INSERT INTO tickets (ticket_id, guild_id, channel_id, opener_id, category_label, status)
           VALUES ($1,$2,$3,$4,$5,'open')`,
          [ticketId, guild.id, channel.id, interaction.user.id, reason]
        );
      });

    const embed = buildTicketEmbed({
      openerId: interaction.user.id,
      categoryLabel: reason,
      ticketId,
      claimedBy: null,
      subject,
      details,
      guild,
    });

    const controls = buildTicketControls(ticketId, false);

    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      components: [controls],
    });

    await replyEphemeral(interaction, { content: `✅ Ticket créé : <#${channel.id}>` });
    return true;
  }

  /* ---------------- DB helpers ---------------- */

  async function getTicket(ticketId) {
    const res = await pool
      .query(
        `SELECT ticket_id, guild_id, channel_id, opener_id, status, claimed_by, category_label, created_at, closed_at,
                subject, details
         FROM tickets WHERE ticket_id=$1 LIMIT 1`,
        [ticketId]
      )
      .catch(async () => {
        const r2 = await pool.query(
          `SELECT ticket_id, guild_id, channel_id, opener_id, status, claimed_by, category_label, created_at, closed_at
           FROM tickets WHERE ticket_id=$1 LIMIT 1`,
          [ticketId]
        );
        return r2;
      });
    return res.rows[0] || null;
  }

  async function getPanel(panelId) {
    const res = await pool.query(
      `SELECT panel_id, mode, categories FROM ticket_panels WHERE panel_id=$1 LIMIT 1`,
      [panelId]
    );
    return res.rows[0] || null;
  }

  function parsePanelPayload(categoriesField) {
    try {
      const obj = typeof categoriesField === "string" ? JSON.parse(categoriesField) : categoriesField;
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  async function fetchAdminChannel(guild, settings, kind) {
    const id =
      kind === "transcript"
        ? settings.transcript_channel_id || settings.admin_feedback_channel_id
        : settings.admin_feedback_channel_id;

    if (!id) return null;

    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return null;
    return ch;
  }

  async function fetchUsernameSafe(client, userId) {
    const u = await client.users.fetch(userId).catch(() => null);
    return u?.username || "user";
  }

  async function applyClaimExclusive(channel, settings, finalClaimedBy) {
    if (!settings.claim_exclusive || !settings.staff_role_id || !channel) return;

    if (finalClaimedBy) {
      await channel.permissionOverwrites.edit(settings.staff_role_id, { SendMessages: false }).catch(() => {});
      await channel.permissionOverwrites
        .edit(finalClaimedBy, { SendMessages: true, ViewChannel: true })
        .catch(() => {});
    } else {
      await channel.permissionOverwrites.edit(settings.staff_role_id, { SendMessages: true }).catch(() => {});
    }
  }

  /* ---------------- Actions (claim/close/delete/transcript/feedback/stats) ---------------- */

  async function doClaim(interaction, ticketId) {
    const release = await acquireTicketLock(ticketId);
    try {
      const ticket = await getTicket(ticketId);
      if (!ticket) {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
        return true;
      }

      const settings = await getSettings(ticket.guild_id);
      if (!isStaff(interaction, settings)) {
        await safeFollowUpEphemeral(interaction, { content: "⛔ Staff/Admin uniquement." });
        return true;
      }

      if (ticket.status !== "open") {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket déjà fermé." });
        return true;
      }

      const isAdm = isAdmin(interaction);
      let publicMsg = null;

      if (!ticket.claimed_by) {
        const upd = await pool.query(
          `UPDATE tickets SET claimed_by=$2
           WHERE ticket_id=$1 AND status='open' AND claimed_by IS NULL
           RETURNING claimed_by`,
          [ticketId, interaction.user.id]
        );

        if (upd.rowCount === 0) {
          const latest = await getTicket(ticketId);
          await safeFollowUpEphemeral(interaction, {
            content: latest?.claimed_by
              ? `⚠️ Déjà pris en charge par <@${latest.claimed_by}>.`
              : "⚠️ Impossible de claim (réessaie).",
          });
          return true;
        }
        publicMsg = `✅ Ticket pris en charge par <@${interaction.user.id}>.`;
      } else if (ticket.claimed_by === interaction.user.id) {
        const upd = await pool.query(
          `UPDATE tickets SET claimed_by=NULL
           WHERE ticket_id=$1 AND status='open' AND claimed_by=$2
           RETURNING claimed_by`,
          [ticketId, interaction.user.id]
        );

        if (upd.rowCount === 0) {
          const latest = await getTicket(ticketId);
          await safeFollowUpEphemeral(interaction, {
            content: latest?.claimed_by
              ? `⚠️ Déjà pris en charge par <@${latest.claimed_by}>.`
              : "⚠️ Déjà non pris en charge.",
          });
          return true;
        }
        publicMsg = `🟥 Ticket n'est plus pris en charge.`;
      } else {
        if (!isAdm) {
          await safeFollowUpEphemeral(interaction, { content: `⚠️ Déjà pris en charge par <@${ticket.claimed_by}>.` });
          return true;
        }

        const upd = await pool.query(
          `UPDATE tickets SET claimed_by=NULL
           WHERE ticket_id=$1 AND status='open' AND claimed_by IS NOT NULL
           RETURNING claimed_by`,
          [ticketId]
        );

        if (upd.rowCount === 0) {
          await safeFollowUpEphemeral(interaction, { content: "⚠️ Déjà non pris en charge." });
          return true;
        }
        publicMsg = `🟥 Ticket n'est plus pris en charge (action admin).`;
      }

      const finalTicket = await getTicket(ticketId);
      if (!finalTicket) {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
        return true;
      }

      await updateTicketMessage(interaction, {
        openerId: finalTicket.opener_id,
        categoryLabel: finalTicket.category_label || "Support",
        ticketId,
        claimedBy: finalTicket.claimed_by || null,
        subject: finalTicket.subject || null,
        details: finalTicket.details || null,
        guild: interaction.guild,
      });

      await applyClaimExclusive(interaction.channel, settings, finalTicket.claimed_by || null);

      const reason = finalTicket.category_label || "Support";
      if (interaction.channel) {
        if (finalTicket.claimed_by) {
          const uname =
            finalTicket.claimed_by === interaction.user.id
              ? interaction.user.username
              : await fetchUsernameSafe(interaction.client, finalTicket.claimed_by);

          await tryRenameTicketChannel(
            interaction.channel,
            buildTicketChannelName({ claimed: true, username: uname, categoryLabel: reason })
          );
        } else {
          const openerUsername = await fetchUsernameSafe(interaction.client, finalTicket.opener_id);
          await tryRenameTicketChannel(
            interaction.channel,
            buildTicketChannelName({ claimed: false, username: openerUsername, categoryLabel: reason })
          );
        }
      }

      if (publicMsg) await safeChannelSend(interaction.channel, publicMsg);
      return true;
    } catch {
      await safeFollowUpEphemeral(interaction, { content: "⚠️ Erreur claim (voir logs)." });
      return true;
    } finally {
      release();
    }
  }

  async function requestFeedback(interaction, client, ticketId, ticketRow) {
    const opener = await client.users.fetch(ticketRow.opener_id).catch(() => null);

    const embed = new EmbedBuilder()
      .setColor(premiumColor())
      .setTitle("⭐ Feedback ticket")
      .setDescription(
        [
          "Ton ticket vient d’être fermé.",
          "Clique sur une note (1 à 5) puis envoie un commentaire (facultatif).",
          "",
          "ℹ️ Visible **uniquement par les admins**.",
        ].join("\n")
      )
      .setFooter({ text: `Ticket ID: ${ticketId}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:1`).setLabel("⭐ 1").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:2`).setLabel("⭐ 2").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:3`).setLabel("⭐ 3").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:4`).setLabel("⭐ 4").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:5`).setLabel("⭐ 5").setStyle(ButtonStyle.Primary)
    );

    if (opener) {
      const dmOk = await opener.send({ embeds: [embed], components: [row] }).then(() => true).catch(() => false);
      if (dmOk) return;
    }

    if (interaction.channel?.isTextBased?.()) {
      await interaction.channel
        .send({ content: `<@${ticketRow.opener_id}>`, embeds: [embed], components: [row] })
        .catch(() => {});
    }
  }

  async function doClose(interaction, client, ticketId) {
    const release = await acquireTicketLock(ticketId);
    try {
      const ticket = await getTicket(ticketId);
      if (!ticket) {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
        return true;
      }

      const settings = await getSettings(ticket.guild_id);
      if (!isStaff(interaction, settings)) {
        await safeFollowUpEphemeral(interaction, { content: "⛔ Staff/Admin uniquement." });
        return true;
      }

      if (ticket.status !== "open") {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket déjà fermé." });
        return true;
      }

      await pool.query(`UPDATE tickets SET status='closed', closed_at=NOW() WHERE ticket_id=$1 AND status='open'`, [
        ticketId,
      ]);

      if (interaction.channel) {
        await interaction.channel.permissionOverwrites
          .edit(ticket.opener_id, { SendMessages: false, ViewChannel: true })
          .catch(() => {});
      }

      await safeChannelSend(interaction.channel, `🔒 Ticket fermé par <@${interaction.user.id}>.`);

      if (interaction.channel?.isTextBased?.()) {
        const messages = await fetchAllMessages(interaction.channel, 1000).catch(() => []);
        let content = renderTranscript(interaction.channel, messages);

        const maxBytes = 7 * 1024 * 1024;
        const buf = Buffer.from(content, "utf8");
        if (buf.length > maxBytes) {
          content =
            content.slice(0, Math.floor((maxBytes / buf.length) * content.length)) +
            `\n\n[TRUNCATED] Transcript trop long, coupé.\n`;
        }

        await pool.query(
          `INSERT INTO ticket_transcripts (ticket_id, content)
           VALUES ($1,$2)
           ON CONFLICT (ticket_id) DO UPDATE SET content=EXCLUDED.content, created_at=NOW()`,
          [ticketId, content]
        );

        const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
        if (guild) {
          const adminTranscriptChannel = await fetchAdminChannel(guild, settings, "transcript");
          if (adminTranscriptChannel) {
            const file = new AttachmentBuilder(Buffer.from(content, "utf8"), { name: `ticket-${ticketId}.txt` });

            const embed = new EmbedBuilder()
              .setColor(premiumColor())
              .setTitle("📄 Transcript")
              .addFields(
                { name: "Ticket", value: `\`${ticketId}\`` },
                { name: "Auteur", value: `<@${ticket.opener_id}>`, inline: true },
                { name: "Pris en charge", value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : "—", inline: true },
                { name: "Raison", value: ticket.category_label || "Support", inline: true }
              )
              .setTimestamp();

            await adminTranscriptChannel.send({ embeds: [embed], files: [file] }).catch(() => {});
          }
        }
      }

      await requestFeedback(interaction, client, ticketId, ticket);

      if (settings.delete_on_close && interaction.channel) {
        setTimeout(() => {
          interaction.channel.delete("Ticket auto-delete after close").catch(() => {});
        }, 10_000);
      }

      return true;
    } catch {
      await safeFollowUpEphemeral(interaction, { content: "⚠️ Erreur close (voir logs)." });
      return true;
    } finally {
      release();
    }
  }

  async function doDelete(interaction, client, ticketId) {
    const release = await acquireTicketLock(ticketId);
    try {
      if (!isAdmin(interaction)) {
        await safeFollowUpEphemeral(interaction, { content: "⛔ Admin uniquement." });
        return true;
      }

      const ticket = await getTicket(ticketId);
      if (!ticket) {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
        return true;
      }

      const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
      if (guild) {
        const ch = await guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (ch) await ch.delete("Ticket deleted by admin").catch(() => {});
      }

      await pool.query(`DELETE FROM tickets WHERE ticket_id=$1`, [ticketId]);
      await safeChannelSend(interaction.channel, `🗑️ Ticket supprimé par <@${interaction.user.id}>.`);
      return true;
    } catch {
      await safeFollowUpEphemeral(interaction, { content: "⚠️ Erreur delete (voir logs)." });
      return true;
    } finally {
      release();
    }
  }

  async function doTranscript(interaction, client, ticketId) {
    const release = await acquireTicketLock(ticketId);
    try {
      if (!isAdmin(interaction)) {
        await safeFollowUpEphemeral(interaction, { content: "⛔ Admin uniquement." });
        return true;
      }

      const ticket = await getTicket(ticketId);
      if (!ticket) {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
        return true;
      }

      const settings = await getSettings(ticket.guild_id);

      let content = null;
      const tRes = await pool.query(`SELECT content FROM ticket_transcripts WHERE ticket_id=$1 LIMIT 1`, [ticketId]);
      content = tRes.rows[0]?.content || null;

      const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
      if (!guild) {
        await safeFollowUpEphemeral(interaction, { content: "⚠️ Serveur introuvable." });
        return true;
      }

      if (!content) {
        const ch = await guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (ch?.isTextBased?.()) {
          const messages = await fetchAllMessages(ch, 1000).catch(() => []);
          content = renderTranscript(ch, messages);
          await pool.query(
            `INSERT INTO ticket_transcripts (ticket_id, content)
             VALUES ($1,$2)
             ON CONFLICT (ticket_id) DO UPDATE SET content=EXCLUDED.content, created_at=NOW()`,
            [ticketId, content]
          );
        }
      }

      const adminTranscriptChannel = await fetchAdminChannel(guild, settings, "transcript");
      if (!adminTranscriptChannel) {
        await safeFollowUpEphemeral(interaction, {
          content:
            "⚠️ Aucun salon transcript/admin configuré. Configure `admin_feedback_channel` ou `transcript_channel` via `/ticket-config set`.",
        });
        return true;
      }

      if (!content) {
        await safeFollowUpEphemeral(interaction, {
          content: "⚠️ Transcript indisponible (salon supprimé et pas de transcript en DB).",
        });
        return true;
      }

      const file = new AttachmentBuilder(Buffer.from(content, "utf8"), { name: `ticket-${ticketId}.txt` });

      const embed = new EmbedBuilder()
        .setColor(premiumColor())
        .setTitle("📄 Transcript (manuel)")
        .addFields(
          { name: "Ticket", value: `\`${ticketId}\`` },
          { name: "Auteur", value: `<@${ticket.opener_id}>`, inline: true },
          { name: "Pris en charge", value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : "—", inline: true },
          { name: "Raison", value: ticket.category_label || "Support", inline: true }
        )
        .setTimestamp();

      await adminTranscriptChannel.send({ embeds: [embed], files: [file] }).catch(() => {});
      await safeFollowUpEphemeral(interaction, { content: `✅ Transcript envoyé dans <#${adminTranscriptChannel.id}>.` });

      return true;
    } catch {
      await safeFollowUpEphemeral(interaction, { content: "⚠️ Erreur transcript (voir logs)." });
      return true;
    } finally {
      release();
    }
  }

  async function upsertFeedbackLogMessage(ticketId, channelId, messageId) {
    await pool.query(`UPDATE ticket_feedback SET log_channel_id=$2, log_message_id=$3 WHERE ticket_id=$1`, [
      ticketId,
      channelId,
      messageId,
    ]);
  }

  async function doRate(interaction, ticketId, rating) {
    const ticket = await getTicket(ticketId);
    if (!ticket) {
      await replyEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
      return true;
    }
    if (interaction.user.id !== ticket.opener_id) {
      await replyEphemeral(interaction, { content: "⛔ Seul l’auteur du ticket peut noter." });
      return true;
    }

    const r = clamp(Number(rating || 0), 1, 5);

    const modal = new ModalBuilder()
      .setCustomId(`ticket:comment:${ticketId}:${r}`)
      .setTitle(`Feedback (${r}/5) - Commentaire (facultatif)`);

    const input = new TextInputBuilder()
      .setCustomId("comment")
      .setLabel("Un mot sur la prise en charge ?")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(800);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    await interaction.showModal(modal).catch(async () => {
      await replyEphemeral(interaction, { content: "⚠️ Impossible d’ouvrir la modal. Réessaie." });
    });

    return true;
  }

  async function doComment(interaction, client, ticketId, rating) {
    const ticket = await getTicket(ticketId);
    if (!ticket) {
      await replyEphemeral(interaction, { content: "⚠️ Ticket introuvable." });
      return true;
    }

    if (interaction.user.id !== ticket.opener_id) {
      await replyEphemeral(interaction, { content: "⛔ Seul l’auteur du ticket peut commenter." });
      return true;
    }

    const comment = (interaction.fields.getTextInputValue("comment") || "").trim();
    const r = clamp(Number(rating || 0), 1, 5);
    const settings = await getSettings(ticket.guild_id);

    await pool.query(
      `INSERT INTO ticket_feedback (ticket_id, guild_id, opener_id, claimed_by, rating, comment)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ticket_id) DO UPDATE SET
         rating=EXCLUDED.rating,
         comment=EXCLUDED.comment,
         claimed_by=EXCLUDED.claimed_by,
         created_at=NOW()`,
      [ticketId, ticket.guild_id, ticket.opener_id, ticket.claimed_by, r, comment || null]
    );

    const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
    if (guild) {
      const adminFeedback = await fetchAdminChannel(guild, settings, "feedback");
      if (adminFeedback) {
        const fbRes = await pool.query(
          `SELECT log_channel_id, log_message_id FROM ticket_feedback WHERE ticket_id=$1 LIMIT 1`,
          [ticketId]
        );
        const fb = fbRes.rows[0] || {};

        const embed = new EmbedBuilder()
          .setColor(premiumColor())
          .setTitle("⭐ Ticket feedback (admin)")
          .addFields(
            { name: "Ticket", value: `\`${ticketId}\`` },
            { name: "Note", value: `${buildStars(r)} (${r}/5)`, inline: true },
            { name: "Auteur", value: `<@${ticket.opener_id}>`, inline: true },
            { name: "Pris en charge", value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : "—", inline: true },
            { name: "Raison", value: ticket.category_label || "Support", inline: true },
            { name: "Commentaire", value: comment ? comment.slice(0, 1024) : "—" }
          )
          .setTimestamp();

        if (fb.log_channel_id && fb.log_message_id) {
          const ch = await guild.channels.fetch(fb.log_channel_id).catch(() => null);
          const msg = ch?.isTextBased?.() ? await ch.messages.fetch(fb.log_message_id).catch(() => null) : null;

          if (msg) {
            await msg.edit({ embeds: [embed] }).catch(() => {});
          } else {
            const sent = await adminFeedback.send({ embeds: [embed] }).catch(() => null);
            if (sent) await upsertFeedbackLogMessage(ticketId, sent.channel.id, sent.id);
          }
        } else {
          const sent = await adminFeedback.send({ embeds: [embed] }).catch(() => null);
          if (sent) await upsertFeedbackLogMessage(ticketId, sent.channel.id, sent.id);
        }
      }
    }

    await replyEphemeral(interaction, { content: "✅ Merci ! Ton feedback a été enregistré." });
    return true;
  }

  async function doStats(interaction) {
    if (!isAdmin(interaction)) {
      await replyEphemeral(interaction, { content: "⛔ Admin uniquement." });
      return true;
    }

    const days = interaction.options.getInteger("days") ?? 30;

    const t1 = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM tickets
       WHERE guild_id=$1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [interaction.guildId, String(days)]
    );

    const t2 = await pool.query(
      `SELECT COUNT(*)::int AS total_closed
       FROM tickets
       WHERE guild_id=$1 AND status='closed' AND closed_at >= NOW() - ($2 || ' days')::interval`,
      [interaction.guildId, String(days)]
    );

    const f1 = await pool.query(
      `SELECT COUNT(*)::int AS total_feedback, AVG(rating)::float AS avg
       FROM ticket_feedback
       WHERE guild_id=$1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [interaction.guildId, String(days)]
    );

    const dist = await pool.query(
      `SELECT rating::int AS rating, COUNT(*)::int AS c
       FROM ticket_feedback
       WHERE guild_id=$1 AND created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY rating
       ORDER BY rating ASC`,
      [interaction.guildId, String(days)]
    );

    const distLine = [1, 2, 3, 4, 5]
      .map((r) => {
        const row = dist.rows.find((x) => Number(x.rating) === r);
        return `${r}⭐: ${row ? row.c : 0}`;
      })
      .join(" • ");

    const avg = f1.rows[0]?.avg ? f1.rows[0].avg.toFixed(2) : "N/A";

    const embed = new EmbedBuilder()
      .setColor(premiumColor())
      .setTitle("📊 Ticket stats (admin)")
      .addFields(
        { name: "Période", value: `${days} jours`, inline: true },
        { name: "Tickets créés", value: `${t1.rows[0]?.total || 0}`, inline: true },
        { name: "Tickets fermés", value: `${t2.rows[0]?.total_closed || 0}`, inline: true },
        { name: "Feedbacks", value: `${f1.rows[0]?.total_feedback || 0} • moyenne: **${avg}/5**`, inline: false },
        { name: "Répartition", value: distLine || "—", inline: false }
      )
      .setTimestamp();

    await replyEphemeral(interaction, { embeds: [embed] });
    return true;
  }

  /* ---------------- Premium Setup Wizard (/ticket-setup) ---------------- */
  // (inchangé)

  function buildSetupHomeEmbed(guild, settings, draft) {
    const types = draft?.types?.length || 0;
    return new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(guild))
      .setTitle("⚙️ Ticket Setup • Premium Wizard")
      .setDescription(
        [
          "Configure ton système de tickets et publie un panel premium **en quelques clics**.",
          "",
          `**Catégorie tickets :** ${settings.category_id ? `<#${settings.category_id}>` : "❌ Non définie"}`,
          `**Rôle staff :** ${settings.staff_role_id ? `<@&${settings.staff_role_id}>` : "❌ Non défini"}`,
          `**Salon feedback/transcripts :** ${
            settings.admin_feedback_channel_id ? `<#${settings.admin_feedback_channel_id}>` : "—"
          }`,
          "",
          `**Types (menu) :** **${types}**`,
          "",
          "✅ Le panel premium = *Catégorie → Formulaire → Ticket créé*",
        ].join("\n")
      )
      .setFooter({ text: "Tout se passe en éphémère (privé)" })
      .setTimestamp();
  }

  function buildSetupHomeComponents() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tsetup:config").setLabel("Configurer").setStyle(ButtonStyle.Primary).setEmoji("⚙️"),
        new ButtonBuilder().setCustomId("tsetup:types").setLabel("Types").setStyle(ButtonStyle.Secondary).setEmoji("🧩"),
        new ButtonBuilder().setCustomId("tsetup:preview").setLabel("Aperçu").setStyle(ButtonStyle.Secondary).setEmoji("👁️")
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tsetup:publish").setLabel("Publier").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId("tsetup:close").setLabel("Fermer").setStyle(ButtonStyle.Danger).setEmoji("✖️")
      ),
    ];
  }

  async function setupStart(interaction) {
    if (!isAdmin(interaction)) {
      await replyEphemeral(interaction, { content: "⛔ Admin uniquement." });
      return true;
    }

    const settings = await getSettings(interaction.guildId);
    const draft =
      getDraft(interaction.guildId, interaction.user.id) || {
        types: PRESET_CATEGORIES.map((c) => ({ ...c })),
        title: "🎫 Support Center",
        description: null,
      };

    setDraft(interaction.guildId, interaction.user.id, draft);

    const embed = buildSetupHomeEmbed(interaction.guild, settings, draft);
    await replyEphemeral(interaction, { embeds: [embed], components: buildSetupHomeComponents() });
    return true;
  }

  // setupConfig / setupLimitsModal / setupTypes / setupTypeModal / setupPickType / setupPreview / setupPublish / publishPanelToChannel
  // (inchangé) — je laisse tel quel pour ne pas casser ton wizard

  async function setupConfig(interaction) {
    if (!isAdmin(interaction)) return true;

    const settings = await getSettings(interaction.guildId);

    const cats = safeSliceForSelect(
      interaction.guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildCategory)
        .map((c) => ({ label: c.name.slice(0, 100), value: c.id }))
    );

    const roles = safeSliceForSelect(
      interaction.guild.roles.cache
        .filter((r) => !r.managed && r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ label: r.name.slice(0, 100), value: r.id }))
    );

    const textsRaw = interaction.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ label: `#${c.name}`.slice(0, 100), value: c.id }));

    const texts = safeSliceForSelect(textsRaw, 1); // reserve 1 for "Aucun"

    const embed = new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(interaction.guild))
      .setTitle("Configurer le système")
      .setDescription("Choisis les éléments via menus. Aucun ID à copier.")
      .addFields(
        { name: "Catégorie tickets", value: settings.category_id ? `<#${settings.category_id}>` : "—", inline: true },
        { name: "Rôle staff", value: settings.staff_role_id ? `<@&${settings.staff_role_id}>` : "—", inline: true },
        {
          name: "Salon admin (feedback/transcripts)",
          value: settings.admin_feedback_channel_id ? `<#${settings.admin_feedback_channel_id}>` : "—",
        }
      )
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tsetup:set_category")
        .setPlaceholder("📂 Choisir catégorie tickets…")
        .addOptions(cats.length ? cats : [{ label: "Aucune catégorie trouvée", value: "none" }])
    );

    const row2 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tsetup:set_staff")
        .setPlaceholder("👮 Choisir rôle staff…")
        .addOptions(roles.length ? roles : [{ label: "Aucun rôle trouvé", value: "none" }])
    );

    const row3 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tsetup:set_adminch")
        .setPlaceholder("🧾 Choisir salon admin (feedback/transcripts)…")
        .addOptions([{ label: "Aucun", value: "none", description: "Désactiver logs admin" }, ...texts])
    );

    const row4 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tsetup:limits").setLabel("Limites & Cooldown").setStyle(ButtonStyle.Secondary).setEmoji("⏱️"),
      new ButtonBuilder().setCustomId("tsetup:home").setLabel("Retour").setStyle(ButtonStyle.Danger).setEmoji("⬅️")
    );

    await interaction.update({ embeds: [embed], components: [row1, row2, row3, row4] });
    return true;
  }

  async function setupLimitsModal(interaction) {
    const settings = await getSettings(interaction.guildId);

    const modal = new ModalBuilder().setCustomId("tsetup:limits_modal").setTitle("Limites & Cooldown");

    const maxOpen = new TextInputBuilder()
      .setCustomId("max_open")
      .setLabel("Tickets ouverts max / utilisateur (1-5)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(settings.max_open_per_user ?? 1));

    const cooldownMin = new TextInputBuilder()
      .setCustomId("cooldown_min")
      .setLabel("Cooldown création (minutes)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(Math.floor((settings.cooldown_seconds ?? 600) / 60)));

    modal.addComponents(new ActionRowBuilder().addComponents(maxOpen), new ActionRowBuilder().addComponents(cooldownMin));

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function setupTypes(interaction) {
    if (!isAdmin(interaction)) return true;

    const draft =
      getDraft(interaction.guildId, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };
    setDraft(interaction.guildId, interaction.user.id, draft);

    const list =
      (draft.types || [])
        .slice(0, 15)
        .map((t, i) => `**${i + 1}.** ${t.emoji ? `${t.emoji} ` : ""}${t.label} — ${t.description || "—"}`)
        .join("\n") || "—";

    const embed = new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(interaction.guild))
      .setTitle("🧩 Types de tickets (menu)")
      .setDescription(
        [
          "Ces types apparaissent dans le panel premium (Select).",
          "",
          list,
          "",
          "➕ Ajouter / ✏️ Modifier / 🗑️ Supprimer via les boutons.",
        ].join("\n")
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tsetup:type_add").setLabel("Ajouter").setStyle(ButtonStyle.Success).setEmoji("➕"),
      new ButtonBuilder().setCustomId("tsetup:type_edit").setLabel("Modifier").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
      new ButtonBuilder().setCustomId("tsetup:type_del").setLabel("Supprimer").setStyle(ButtonStyle.Danger).setEmoji("🗑️"),
      new ButtonBuilder().setCustomId("tsetup:home").setLabel("Retour").setStyle(ButtonStyle.Secondary).setEmoji("⬅️")
    );

    await interaction.update({ embeds: [embed], components: [row] });
    return true;
  }

  async function setupTypeModal(interaction, mode, current) {
    const modal = new ModalBuilder()
      .setCustomId(mode === "add" ? "tsetup:type_modal_add" : `tsetup:type_modal_edit:${current.value}`)
      .setTitle(mode === "add" ? "Ajouter un type" : "Modifier un type");

    const name = new TextInputBuilder()
      .setCustomId("label")
      .setLabel("Nom (label)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)
      .setValue(current?.label || "");

    const value = new TextInputBuilder()
      .setCustomId("value")
      .setLabel("Identifiant (value)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50)
      .setValue(current?.value || "");

    const desc = new TextInputBuilder()
      .setCustomId("desc")
      .setLabel("Description")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(100)
      .setValue(current?.description || "");

    const emoji = new TextInputBuilder()
      .setCustomId("emoji")
      .setLabel("Emoji (optionnel)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(20)
      .setValue(current?.emoji || "");

    modal.addComponents(
      new ActionRowBuilder().addComponents(name),
      new ActionRowBuilder().addComponents(value),
      new ActionRowBuilder().addComponents(desc),
      new ActionRowBuilder().addComponents(emoji)
    );

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function setupPickType(interaction, kind) {
    const draft = getDraft(interaction.guildId, interaction.user.id);
    if (!draft?.types?.length) {
      await safeFollowUpEphemeral(interaction, { content: "➖ Aucun type." });
      return true;
    }

    const options = safeSliceForSelect(
      draft.types.map((t) => ({
        label: `${t.emoji ? `${t.emoji} ` : ""}${t.label}`.slice(0, 100),
        value: t.value,
        description: (t.description || "—").slice(0, 100),
      }))
    );

    const menu = new StringSelectMenuBuilder()
      .setCustomId(kind === "edit" ? "tsetup:pick_edit" : "tsetup:pick_del")
      .setPlaceholder(kind === "edit" ? "Quel type modifier ?" : "Quel type supprimer ?")
      .addOptions(options);

    await interaction
      .reply({
        content: "Sélectionne un type :",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  async function setupPreview(interaction) {
    const draft =
      getDraft(interaction.guildId, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };

    const embed = buildPremiumPanelEmbed({
      guild: interaction.guild,
      title: draft.title,
      description: draft.description,
    });

    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticketp:select:preview")
      .setPlaceholder("Choisis une catégorie…")
      .addOptions(
        safeSliceForSelect(
          (draft.types || PRESET_CATEGORIES).map((c) => ({
            label: c.label,
            value: c.value,
            description: c.description,
            emoji: parseComponentEmoji(c.emoji) || undefined,
          }))
        )
      );

    await interaction
      .reply({
        content: "👁️ Aperçu du panel premium :",
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  async function setupPublish(interaction) {
    const channelsRaw = interaction.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ label: `#${c.name}`.slice(0, 100), value: c.id }));

    const channels = safeSliceForSelect(channelsRaw);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("tsetup:publish_pick")
      .setPlaceholder("Choisis le salon où publier le panel premium…")
      .addOptions(channels.length ? channels : [{ label: "Aucun salon texte trouvé", value: "none" }]);

    await interaction
      .reply({
        content: "✅ Choisis un salon :",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  async function publishPanelToChannel(interaction, channelId, draftOverride = null) {
    const guild = interaction.guild;
    if (!guild) return true;

    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) {
      await replyEphemeral(interaction, { content: "⚠️ Salon invalide." });
      return true;
    }

    const settings = await getSettings(guild.id);
    if (!settings.category_id) {
      await replyEphemeral(interaction, {
        content: "⚠️ Configure d’abord la catégorie tickets (/ticket-config set category:...)",
      });
      return true;
    }

    const draft =
      draftOverride ||
      getDraft(guild.id, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };
    const types = draft.types?.length ? draft.types : PRESET_CATEGORIES;

    const panelId = crypto.randomUUID();
    const payload = { categories: types, premium: true, layout: "select" };

    const embed = buildPremiumPanelEmbed({
      guild,
      title: draft.title,
      description: draft.description,
      banner: draft.banner,
      bannerPosition: draft.banner_position,
    });

    const embeds = [];
    if (draft.banner && isValidHttpUrl(draft.banner) && draft.banner_position === "top") embeds.push(buildTopBannerEmbed(draft.banner));
    embeds.push(embed);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ticketp:select:${panelId}`)
      .setPlaceholder("Choisis une catégorie…")
      .addOptions(
        safeSliceForSelect(
          types.map((c) => ({
            label: c.label,
            value: c.value,
            description: c.description,
            emoji: parseComponentEmoji(c.emoji) || undefined,
          }))
        )
      );

    const msg = await ch.send({ embeds, components: [new ActionRowBuilder().addComponents(menu)] });

    await pool.query(
      `INSERT INTO ticket_panels (panel_id, guild_id, channel_id, message_id, mode, categories, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (panel_id) DO NOTHING`,
      [panelId, guild.id, msg.channel.id, msg.id, "premium", JSON.stringify(payload), interaction.user.id]
    );

    await replyEphemeral(interaction, { content: `✅ Panel premium publié dans <#${msg.channel.id}>.` });
    return true;
  }

  /* ---------------- Premium ticket: Select/Buttons/Simple -> (Modal optionnel) -> Create ---------------- */

  async function openPremiumModal(interaction, panelId, selectedValue, label) {
    const modal = new ModalBuilder()
      .setCustomId(`ticketp:modal:${panelId}:${selectedValue}:${encodeURIComponent(label || selectedValue)}`)
      .setTitle("Créer un ticket");

    const subject = new TextInputBuilder()
      .setCustomId("subject")
      .setLabel("Sujet (court)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)
      .setPlaceholder("Ex: Problème, question, support…");

    const details = new TextInputBuilder()
      .setCustomId("details")
      .setLabel("Détails (raison)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(600)
      .setPlaceholder("Explique clairement ta demande pour une réponse rapide.");

    modal.addComponents(new ActionRowBuilder().addComponents(subject), new ActionRowBuilder().addComponents(details));

    await interaction.showModal(modal).catch(async () => {
      await replyEphemeral(interaction, { content: "⚠️ Impossible d’ouvrir le formulaire. Réessaie." });
    });

    return true;
  }

  function shouldUseFormForPreview(interaction) {
    const pb = getPanelDraft(interaction.guildId, interaction.user.id);
    if (pb && typeof pb.form_enabled === "boolean") return pb.form_enabled;
    // défaut premium = avec formulaire
    return true;
  }

  async function shouldUseFormForPanel(panelId, interaction) {
    if (panelId === "preview") return shouldUseFormForPreview(interaction);

    const panel = await getPanel(panelId);
    const payload = parsePanelPayload(panel?.categories);
    if (payload && typeof payload.useForm === "boolean") return payload.useForm;

    // backward compatible: si absent => on considère "Avec"
    return true;
  }

  /* ---------------- /ticket-panel PREMIUM BUILDER ---------------- */

  function defaultPanelBuilderDraft(guild) {
    return {
      title: `🎫 ${guild?.name || "Support"} • Ticket Center`,
      description: [
        "Sélectionne une catégorie puis remplis le formulaire.",
        "",
        "✅ **Rapide** • 🧾 **Clair** • 🔒 **Sécurisé**",
      ].join("\n"),
      layout: "select", // "select" | "buttons"
      types: PRESET_CATEGORIES.map((c) => ({ ...c })),
      target_channel_id: null,

      // ✅ NEW: formulaire ON/OFF
      form_enabled: true,

      // Bannière panel premium
      banner: "",
      banner_position: "bottom", // "top" | "bottom"

      // Mode Simple
      simple: null, // { enabled, thumb, title, text, footer, category, btnStyle, btnLabel }
    };
  }

  function buildPanelBuilderHomeEmbed(guild, draft) {
    const tCount = draft?.types?.length || 0;
    const simpleOn = Boolean(draft?.simple?.enabled);
    const simpleLine = simpleOn
      ? `✅ **Mode Simple :** ON • **Catégorie :** ${draft.simple?.category || "Support"}`
      : `—`;

    const formLine = draft?.form_enabled ? "✅ Avec" : "❌ Sans";
    const bannerLine = draft?.banner && isValidHttpUrl(draft.banner) ? `✅ Configurée (${draft.banner_position === "top" ? "haut" : "bas"})` : "—";

    return new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(guild))
      .setTitle("🎨 Ticket Panel Builder • Premium")
      .setDescription(
        [
          "Crée un panel premium **sans options compliquées**.",
          "",
          `**Layout :** ${draft.layout === "buttons" ? "Boutons (max 5)" : "Select (jusqu’à 25)"}`,
          `**Types :** **${tCount}**`,
          `**Salon cible :** ${draft.target_channel_id ? `<#${draft.target_channel_id}>` : "—"}`,
          `**Formulaire :** ${formLine}`,
          `**Bannière :** ${bannerLine}`,
          `**Mode Simple :** ${simpleLine}`,
          "",
          "Utilise les boutons ci-dessous, puis **Aperçu** et **Publier**.",
        ].join("\n")
      )
      .setTimestamp();
  }

  function buildPanelBuilderHomeComponents(draft) {
    const formBtn = new ButtonBuilder()
      .setCustomId("tpnl:form_toggle")
      .setLabel(`Formulaire: ${draft?.form_enabled ? "Avec" : "Sans"}`)
      .setEmoji(draft?.form_enabled ? "✅" : "❌")
      .setStyle(draft?.form_enabled ? ButtonStyle.Success : ButtonStyle.Danger);

    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tpnl:style").setLabel("Style").setStyle(ButtonStyle.Primary).setEmoji("🎨"),
        new ButtonBuilder().setCustomId("tpnl:types").setLabel("Types").setStyle(ButtonStyle.Secondary).setEmoji("🧩"),
        new ButtonBuilder().setCustomId("tpnl:layout").setLabel("Layout").setStyle(ButtonStyle.Secondary).setEmoji("🧱"),
        new ButtonBuilder().setCustomId("tpnl:simple").setLabel("Mode Simple").setStyle(ButtonStyle.Secondary).setEmoji("🧊"),
        formBtn
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tpnl:channel").setLabel("Salon").setStyle(ButtonStyle.Secondary).setEmoji("📍"),
        new ButtonBuilder().setCustomId("tpnl:banner").setLabel("Bannière").setStyle(ButtonStyle.Secondary).setEmoji("🖼️"),
        new ButtonBuilder().setCustomId("tpnl:preview").setLabel("Aperçu").setStyle(ButtonStyle.Secondary).setEmoji("👁️"),
        new ButtonBuilder().setCustomId("tpnl:publish").setLabel("Publier").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId("tpnl:close").setLabel("Fermer").setStyle(ButtonStyle.Danger).setEmoji("✖️")
      ),
    ];
  }

  async function panelBuilderStart(interaction) {
    if (!isAdmin(interaction)) {
      await replyEphemeral(interaction, { content: "⛔ Admin uniquement." });
      return true;
    }

    const cur = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    if (typeof cur.form_enabled !== "boolean") cur.form_enabled = true;
    setPanelDraft(interaction.guildId, interaction.user.id, cur);

    const embed = buildPanelBuilderHomeEmbed(interaction.guild, cur);
    await replyEphemeral(interaction, { embeds: [embed], components: buildPanelBuilderHomeComponents(cur) });
    return true;
  }

  async function panelBuilderOpenStyleModal(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);

    const modal = new ModalBuilder().setCustomId("tpnl:style_modal").setTitle("Style du panel");

    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("Titre")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256)
      .setValue((draft.title || "🎫 Support Center").slice(0, 256));

    const desc = new TextInputBuilder()
      .setCustomId("desc")
      .setLabel("Description")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1500)
      .setValue((draft.description || "").slice(0, 1500));

    modal.addComponents(new ActionRowBuilder().addComponents(title), new ActionRowBuilder().addComponents(desc));
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function panelBuilderOpenBannerModal(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);

    const modal = new ModalBuilder().setCustomId("tpnl:banner_modal").setTitle("Bannière du panel");

    const banner = new TextInputBuilder()
      .setCustomId("banner")
      .setLabel("URL bannière (optionnel, vide = supprimer)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(500)
      .setValue((draft.banner || "").slice(0, 500))
      .setPlaceholder("https://.../image.png");

    const position = new TextInputBuilder()
      .setCustomId("position")
      .setLabel("Position (haut ou bas)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(10)
      .setValue((draft.banner_position === "top" ? "haut" : "bas").slice(0, 10))
      .setPlaceholder("haut");

    modal.addComponents(new ActionRowBuilder().addComponents(banner), new ActionRowBuilder().addComponents(position));
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function panelBuilderToggleLayout(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    draft.layout = draft.layout === "buttons" ? "select" : "buttons";
    setPanelDraft(interaction.guildId, interaction.user.id, draft);

    const embed = buildPanelBuilderHomeEmbed(interaction.guild, draft);
    await interaction
      .update({ embeds: [embed], components: buildPanelBuilderHomeComponents(draft), content: "" })
      .catch(() => {});
    return true;
  }

  async function panelBuilderToggleForm(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    draft.form_enabled = !Boolean(draft.form_enabled);
    setPanelDraft(interaction.guildId, interaction.user.id, draft);

    const embed = buildPanelBuilderHomeEmbed(interaction.guild, draft);
    await interaction
      .update({ embeds: [embed], components: buildPanelBuilderHomeComponents(draft), content: "" })
      .catch(() => {});
    return true;
  }

  async function panelBuilderTypesView(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    setPanelDraft(interaction.guildId, interaction.user.id, draft);

    const list =
      (draft.types || [])
        .slice(0, 15)
        .map((t, i) => `**${i + 1}.** ${t.emoji ? `${t.emoji} ` : ""}${t.label} — ${t.description || "—"}`)
        .join("\n") || "—";

    const embed = new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(interaction.guild))
      .setTitle("🧩 Types (Panel Builder)")
      .setDescription(
        [
          "Ces types seront affichés dans ton panel.",
          draft.layout === "buttons" ? "⚠️ Layout **Boutons**: max **5** types." : "✅ Layout **Select**: jusqu’à **25** types.",
          "",
          list,
        ].join("\n")
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tpnl:type_add").setLabel("Ajouter").setStyle(ButtonStyle.Success).setEmoji("➕"),
      new ButtonBuilder().setCustomId("tpnl:type_edit").setLabel("Modifier").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
      new ButtonBuilder().setCustomId("tpnl:type_del").setLabel("Supprimer").setStyle(ButtonStyle.Danger).setEmoji("🗑️"),
      new ButtonBuilder().setCustomId("tpnl:home").setLabel("Retour").setStyle(ButtonStyle.Secondary).setEmoji("⬅️")
    );

    await interaction.update({ embeds: [embed], components: [row] }).catch(() => {});
    return true;
  }

  async function panelBuilderTypeModal(interaction, mode, current) {
    const modal = new ModalBuilder()
      .setCustomId(mode === "add" ? "tpnl:type_modal_add" : `tpnl:type_modal_edit:${current.value}`)
      .setTitle(mode === "add" ? "Ajouter un type" : "Modifier un type");

    const name = new TextInputBuilder()
      .setCustomId("label")
      .setLabel("Nom (label)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)
      .setValue(current?.label || "");

    const value = new TextInputBuilder()
      .setCustomId("value")
      .setLabel("Identifiant (value)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50)
      .setValue(current?.value || "");

    const desc = new TextInputBuilder()
      .setCustomId("desc")
      .setLabel("Description")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(100)
      .setValue(current?.description || "");

    const emoji = new TextInputBuilder()
      .setCustomId("emoji")
      .setLabel("Emoji (optionnel)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(20)
      .setValue(current?.emoji || "");

    modal.addComponents(
      new ActionRowBuilder().addComponents(name),
      new ActionRowBuilder().addComponents(value),
      new ActionRowBuilder().addComponents(desc),
      new ActionRowBuilder().addComponents(emoji)
    );

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function panelBuilderPickType(interaction, kind) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id);
    if (!draft?.types?.length) {
      await safeFollowUpEphemeral(interaction, { content: "➖ Aucun type." });
      return true;
    }

    const options = safeSliceForSelect(
      draft.types.map((t) => ({
        label: `${t.emoji ? `${t.emoji} ` : ""}${t.label}`.slice(0, 100),
        value: t.value,
        description: (t.description || "—").slice(0, 100),
      }))
    );

    const menu = new StringSelectMenuBuilder()
      .setCustomId(kind === "edit" ? "tpnl:pick_edit" : "tpnl:pick_del")
      .setPlaceholder(kind === "edit" ? "Quel type modifier ?" : "Quel type supprimer ?")
      .addOptions(options);

    await interaction
      .reply({
        content: "Sélectionne un type :",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  async function panelBuilderPickChannel(interaction) {
    const raw = interaction.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ label: `#${c.name}`.slice(0, 100), value: c.id }));

    const options = safeSliceForSelect(raw);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("tpnl:set_channel")
      .setPlaceholder("Choisis le salon où publier…")
      .addOptions(options.length ? options : [{ label: "Aucun salon texte trouvé", value: "none" }]);

    await interaction
      .reply({
        content: "📍 Choisis un salon :",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  /* ---- Mode Simple (builder) ---- */

  async function panelBuilderOpenSimpleModal(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);

    const modal = new ModalBuilder().setCustomId("tpnl:simple_modal").setTitle("Mode Simple • Panel");

    const img = new TextInputBuilder()
      .setCustomId("thumb")
      .setLabel("Image à droite (URL)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(300)
      .setValue(draft.simple?.thumb || "");

    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("Titre")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256)
      .setValue((draft.simple?.title || draft.title || "🎫 Ticket Center").slice(0, 256));

    const text = new TextInputBuilder()
      .setCustomId("text")
      .setLabel("Texte")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1500)
      .setValue((draft.simple?.text || draft.description || "Clique pour ouvrir un ticket.").slice(0, 1500));

    const footer = new TextInputBuilder()
      .setCustomId("footer")
      .setLabel("Footer")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(2048)
      .setValue(draft.simple?.footer || "Tickets Premium • Mino Bot");

    const cat = new TextInputBuilder()
      .setCustomId("category")
      .setLabel("Catégorie (libre)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100)
      .setValue(draft.simple?.category || "Support");

    // ⚠️ Modal = max 5 champs => couleur + texte bouton gérés après la modal.
    modal.addComponents(
      new ActionRowBuilder().addComponents(img),
      new ActionRowBuilder().addComponents(title),
      new ActionRowBuilder().addComponents(text),
      new ActionRowBuilder().addComponents(footer),
      new ActionRowBuilder().addComponents(cat)
    );

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function panelBuilderAskSimpleOptions(interaction) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tpnl:simple_color_btn").setLabel("Couleur bouton").setStyle(ButtonStyle.Secondary).setEmoji("🎨"),
      new ButtonBuilder().setCustomId("tpnl:simple_label_btn").setLabel("Texte du bouton").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
      new ButtonBuilder().setCustomId("tpnl:home").setLabel("Retour").setStyle(ButtonStyle.Secondary).setEmoji("⬅️")
    );

    await interaction
      .followUp({
        content: "Options Mode Simple :",
        components: [row],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  async function panelBuilderAskButtonColor(interaction) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("tpnl:simple_color")
      .setPlaceholder("Choisis la couleur du bouton…")
      .addOptions([
        { label: "Bleu (Primary)", value: "primary", emoji: "🔵" },
        { label: "Vert (Success)", value: "success", emoji: "🟢" },
        { label: "Rouge (Danger)", value: "danger", emoji: "🔴" },
        { label: "Gris (Secondary)", value: "secondary", emoji: "⚪" },
      ]);

    await interaction
      .followUp({
        content: "🎨 Couleur du bouton :",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  async function panelBuilderOpenButtonLabelModal(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    const cur = (draft.simple?.btnLabel || "Ouvrir un ticket").slice(0, 80);

    const modal = new ModalBuilder().setCustomId("tpnl:simple_btnlabel_modal").setTitle("Texte du bouton (Simple)");

    const input = new TextInputBuilder()
      .setCustomId("btn_label")
      .setLabel("Texte affiché sur le bouton")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)
      .setValue(cur);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  function buildSimplePanelFromDraft(guild, draft, forPublishPanelId = null) {
    const s = draft.simple || {};
    const safeTitle = resolveNamedEmojiAliases((s.title || draft.title || "🎫 Ticket Center").slice(0, 256), guild);
    const safeText = resolveNamedEmojiAliases((s.text || draft.description || "Clique pour ouvrir un ticket.").slice(0, 1500), guild);
    const safeFooter = resolveNamedEmojiAliases((s.footer || "Tickets Premium • Mino Bot").slice(0, 2048), guild);

    const e = new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(guild))
      .setTitle(safeTitle)
      .setDescription(safeText)
      .setFooter({ text: safeFooter })
      .setTimestamp();

    if (s.thumb && isValidHttpUrl(s.thumb)) e.setThumbnail(s.thumb);
    if (draft.banner && isValidHttpUrl(draft.banner)) e.setImage(draft.banner);

    const embeds = [];
    if (draft.banner && isValidHttpUrl(draft.banner) && draft.banner_position === "top") embeds.push(buildTopBannerEmbed(draft.banner));
    if (draft.banner && isValidHttpUrl(draft.banner) && (draft.banner_position || "bottom") !== "top") e.setImage(draft.banner);
    embeds.push(e);

    const label = (s.category || "Support").slice(0, 100);
    const value = slugValue(label);

    const panelId = forPublishPanelId || "preview";
    const visual = parseSimpleButtonVisual(s.btnLabel || "Ouvrir un ticket", guild);

    const btn = new ButtonBuilder()
      .setCustomId(`ticketp:open:${panelId}:${value}:${encodeURIComponent(label)}`)
      .setLabel(visual.label)
      .setStyle(parseButtonStyle(s.btnStyle || "primary"));

    if (visual.emoji) {
      try {
        btn.setEmoji(visual.emoji);
      } catch {}
    }

    return { embeds, components: [new ActionRowBuilder().addComponents(btn)], label, value };
  }

  function buildPanelFromDraft(guild, draft) {
    // Mode Simple ON => force 1 bouton + embed custom
    if (draft?.simple?.enabled) {
      return buildSimplePanelFromDraft(guild, draft, null);
    }

    const embed = buildPremiumPanelEmbed({
      guild,
      title: draft.title,
      description: draft.description,
      banner: draft.banner,
      bannerPosition: draft.banner_position,
    });

    const embeds = [];
    if (draft.banner && isValidHttpUrl(draft.banner) && draft.banner_position === "top") embeds.push(buildTopBannerEmbed(draft.banner));
    embeds.push(embed);

    const types = draft.types?.length ? draft.types : PRESET_CATEGORIES;

    if (draft.layout === "buttons") {
      const limited = types.slice(0, 5);
      const row = new ActionRowBuilder();
      for (const t of limited) {
        const b = new ButtonBuilder()
          .setCustomId(`ticketp:open:preview:${t.value}:${encodeURIComponent(t.label)}`)
          .setLabel(t.label.slice(0, 80))
          .setStyle(ButtonStyle.Primary);
        const parsedEmoji = parseComponentEmoji(t.emoji);
        if (parsedEmoji) {
          try {
            b.setEmoji(parsedEmoji);
          } catch {}
        }
        row.addComponents(b);
      }
      return { embeds, components: [row], types };
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticketp:select:preview")
      .setPlaceholder("Choisis une catégorie…")
      .addOptions(
        safeSliceForSelect(
          types.map((t) => ({
            label: t.label,
            value: t.value,
            description: t.description,
            emoji: parseComponentEmoji(t.emoji) || undefined,
          }))
        )
      );

    return { embeds, components: [new ActionRowBuilder().addComponents(menu)], types };
  }

  async function panelBuilderPreview(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    const built = buildPanelFromDraft(interaction.guild, draft);

    await interaction
      .reply({
        content: draft?.simple?.enabled ? "👁️ Aperçu du panel (Mode Simple) :" : "👁️ Aperçu du panel (builder) :",
        embeds: built.embeds,
        components: built.components,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  async function panelBuilderPublish(interaction) {
    const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
    const channelId = draft.target_channel_id;

    if (!channelId) {
      await interaction
        .reply({ content: "⚠️ Choisis d’abord un salon (bouton **Salon**).", flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }

    const settings = await getSettings(interaction.guildId);
    if (!settings.category_id) {
      await interaction
        .reply({
          content: "⚠️ Configure d’abord la catégorie tickets via `/ticket-config set category:...`.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return true;
    }

    const guild = interaction.guild;
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) {
      await interaction.reply({ content: "⚠️ Salon invalide.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }

    const panelId = crypto.randomUUID();

    // Mode Simple publish
    if (draft?.simple?.enabled) {
      const built = buildSimplePanelFromDraft(guild, draft, panelId);
      const msg = await ch.send({ embeds: built.embeds, components: built.components });

      const payload = {
        premium: true,
        layout: "simple",

        // ✅ NEW
        useForm: Boolean(draft.form_enabled),
        banner: draft.banner || "",
        bannerPosition: draft.banner_position || "bottom",

        title: draft.simple?.title || draft.title,
        description: draft.simple?.text || draft.description,
        categories: [{ label: built.label, value: built.value, description: "Mode Simple" }],
        simple: {
          enabled: true,
          thumb: draft.simple?.thumb || "",
          title: draft.simple?.title || "",
          text: draft.simple?.text || "",
          footer: draft.simple?.footer || "",
          category: draft.simple?.category || "Support",
          btnStyle: draft.simple?.btnStyle || "primary",
          btnLabel: draft.simple?.btnLabel || "Ouvrir un ticket",
        },
      };

      await pool.query(
        `INSERT INTO ticket_panels (panel_id, guild_id, channel_id, message_id, mode, categories, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (panel_id) DO NOTHING`,
        [panelId, guild.id, msg.channel.id, msg.id, "premium", JSON.stringify(payload), interaction.user.id]
      );

      await interaction
        .reply({ content: `✅ Panel (Mode Simple) publié dans <#${msg.channel.id}>.`, flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }

    // Normal builder publish (select/buttons)
    const types = draft.types?.length ? draft.types : PRESET_CATEGORIES;

    const payload = {
      premium: true,
      layout: draft.layout,

      // ✅ NEW
      useForm: Boolean(draft.form_enabled),
      banner: draft.banner || "",
      bannerPosition: draft.banner_position || "bottom",

      categories: types,
      title: draft.title,
      description: draft.description,
    };

    const embed = buildPremiumPanelEmbed({
      guild,
      title: draft.title,
      description: draft.description,
      banner: draft.banner,
      bannerPosition: draft.banner_position,
    });

    const embeds = [];
    if (draft.banner && isValidHttpUrl(draft.banner) && draft.banner_position === "top") embeds.push(buildTopBannerEmbed(draft.banner));
    embeds.push(embed);

    let components = [];
    if (draft.layout === "buttons") {
      const limited = types.slice(0, 5);
      const row = new ActionRowBuilder();
      for (const t of limited) {
        const b = new ButtonBuilder()
          .setCustomId(`ticketp:open:${panelId}:${t.value}:${encodeURIComponent(t.label)}`)
          .setLabel(t.label.slice(0, 80))
          .setStyle(ButtonStyle.Primary);
        const parsedEmoji = parseComponentEmoji(t.emoji);
        if (parsedEmoji) {
          try {
            b.setEmoji(parsedEmoji);
          } catch {}
        }
        row.addComponents(b);
      }
      components = [row];
    } else {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`ticketp:select:${panelId}`)
        .setPlaceholder("Choisis une catégorie…")
        .addOptions(
          safeSliceForSelect(
            types.map((t) => ({
              label: t.label,
              value: t.value,
              description: t.description,
              emoji: parseComponentEmoji(t.emoji) || undefined,
            }))
          )
        );
      components = [new ActionRowBuilder().addComponents(menu)];
    }

    const msg = await ch.send({ embeds, components });

    await pool.query(
      `INSERT INTO ticket_panels (panel_id, guild_id, channel_id, message_id, mode, categories, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (panel_id) DO NOTHING`,
      [panelId, guild.id, msg.channel.id, msg.id, "premium", JSON.stringify(payload), interaction.user.id]
    );

    await interaction
      .reply({ content: `✅ Panel publié dans <#${msg.channel.id}>.`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return true;
  }

  /* ---------------- Router ---------------- */

  async function handleInteraction(interaction, client) {
    // MODALS
    if (interaction.isModalSubmit()) {
      // ticket-setup limits
      if (interaction.customId === "tsetup:limits_modal") {
        if (!isAdmin(interaction)) return true;

        const maxOpen = parseInt(interaction.fields.getTextInputValue("max_open"), 10);
        const cdMin = parseInt(interaction.fields.getTextInputValue("cooldown_min"), 10);

        if (!Number.isFinite(maxOpen) || maxOpen < 1 || maxOpen > 5) {
          await replyEphemeral(interaction, { content: "❌ max_open doit être entre 1 et 5." });
          return true;
        }
        if (!Number.isFinite(cdMin) || cdMin < 0 || cdMin > 1440) {
          await replyEphemeral(interaction, { content: "❌ cooldown (minutes) doit être entre 0 et 1440." });
          return true;
        }

        await upsertSettings(interaction.guildId, { max_open_per_user: maxOpen, cooldown_seconds: cdMin * 60 });
        await replyEphemeral(interaction, { content: "✅ Limites mises à jour." });
        return true;
      }

      // ticket-setup type add/edit
      if (interaction.customId === "tsetup:type_modal_add") {
        if (!isAdmin(interaction)) return true;
        const draft = getDraft(interaction.guildId, interaction.user.id) || { types: [] };

        const label = interaction.fields.getTextInputValue("label").trim().slice(0, 100);
        const value = interaction.fields.getTextInputValue("value").trim().slice(0, 50);
        const desc = (interaction.fields.getTextInputValue("desc") || "").trim().slice(0, 100);
        const emoji = (interaction.fields.getTextInputValue("emoji") || "").trim().slice(0, 20);

        if (!label || !value) return replyEphemeral(interaction, { content: "❌ Label & Value obligatoires." });

        if ((draft.types || []).some((t) => t.value === value)) {
          return replyEphemeral(interaction, { content: "❌ Value déjà utilisé. Choisis un identifiant unique." });
        }

        draft.types = draft.types || [];
        draft.types.push({ label, value, description: desc || undefined, emoji: emoji || undefined });
        setDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Type ajouté." });
        return true;
      }

      if (interaction.customId.startsWith("tsetup:type_modal_edit:")) {
        if (!isAdmin(interaction)) return true;

        const editValue = interaction.customId.split(":").pop();
        const draft = getDraft(interaction.guildId, interaction.user.id);
        if (!draft?.types?.length) return replyEphemeral(interaction, { content: "⚠️ Session expirée. Relance /ticket-setup" });

        const label = interaction.fields.getTextInputValue("label").trim().slice(0, 100);
        const value = interaction.fields.getTextInputValue("value").trim().slice(0, 50);
        const desc = (interaction.fields.getTextInputValue("desc") || "").trim().slice(0, 100);
        const emoji = (interaction.fields.getTextInputValue("emoji") || "").trim().slice(0, 20);

        const idx = draft.types.findIndex((t) => t.value === editValue);
        if (idx === -1) return replyEphemeral(interaction, { content: "⚠️ Type introuvable." });

        if (value !== editValue && draft.types.some((t) => t.value === value)) {
          return replyEphemeral(interaction, { content: "❌ Value déjà utilisé." });
        }

        draft.types[idx] = { label, value, description: desc || undefined, emoji: emoji || undefined };
        setDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Type modifié." });
        return true;
      }

      // /ticket-panel builder style modal
      if (interaction.customId === "tpnl:style_modal") {
        if (!isAdmin(interaction)) return true;

        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
        draft.title = interaction.fields.getTextInputValue("title").slice(0, 256);
        draft.description = interaction.fields.getTextInputValue("desc").slice(0, 1500);
        setPanelDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Style mis à jour." });
        return true;
      }

      if (interaction.customId === "tpnl:banner_modal") {
        if (!isAdmin(interaction)) return true;

        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
        const bannerRaw = (interaction.fields.getTextInputValue("banner") || "").trim();
        const positionRaw = (interaction.fields.getTextInputValue("position") || "").trim().toLowerCase();

        if (bannerRaw && !isValidHttpUrl(bannerRaw)) {
          await replyEphemeral(interaction, { content: "❌ URL invalide. Utilise un lien http(s)." });
          return true;
        }

        const positionMap = {
          haut: "top",
          top: "top",
          bas: "bottom",
          bottom: "bottom",
          "": draft.banner_position || "bottom",
        };
        const nextPosition = positionMap[positionRaw];
        if (!nextPosition) {
          await replyEphemeral(interaction, { content: "❌ Position invalide. Mets `haut` ou `bas`." });
          return true;
        }

        draft.banner = bannerRaw.slice(0, 500);
        draft.banner_position = nextPosition;
        setPanelDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, {
          content: draft.banner
            ? `✅ Bannière enregistrée (${draft.banner_position === "top" ? "haut" : "bas"}).`
            : "✅ Bannière supprimée.",
        });
        return true;
      }

      // /ticket-panel builder MODE SIMPLE modal
      if (interaction.customId === "tpnl:simple_modal") {
        if (!isAdmin(interaction)) return true;

        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);

        const thumbRaw = (interaction.fields.getTextInputValue("thumb") || "").trim();
        const title = (interaction.fields.getTextInputValue("title") || "").trim();
        const text = (interaction.fields.getTextInputValue("text") || "").trim();
        const footer = (interaction.fields.getTextInputValue("footer") || "").trim();
        const category = (interaction.fields.getTextInputValue("category") || "").trim();

        draft.simple = {
          enabled: true,
          thumb: thumbRaw && isValidHttpUrl(thumbRaw) ? thumbRaw : "",
          title: (title || "🎫 Ticket Center").slice(0, 256),
          text: (text || "Clique pour ouvrir un ticket.").slice(0, 1500),
          footer: (footer || "Tickets Premium • Mino Bot").slice(0, 2048),
          category: (category || "Support").slice(0, 100),
          btnStyle: draft.simple?.btnStyle || "primary",
          btnLabel: (draft.simple?.btnLabel || "Ouvrir un ticket").slice(0, 80),
        };

        // Align draft principal (cohérence)
        draft.title = draft.simple.title;
        draft.description = draft.simple.text;

        setPanelDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Mode Simple enregistré." });
        // options (couleur + texte bouton)
        await panelBuilderAskSimpleOptions(interaction);
        return true;
      }

      // ✅ NEW: simple button label modal
      if (interaction.customId === "tpnl:simple_btnlabel_modal") {
        if (!isAdmin(interaction)) return true;

        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
        draft.simple = draft.simple || { enabled: true };

        const label = (interaction.fields.getTextInputValue("btn_label") || "").trim();
        if (!label) {
          await replyEphemeral(interaction, { content: "❌ Le texte du bouton est obligatoire." });
          return true;
        }

        draft.simple.btnLabel = label.slice(0, 80);
        setPanelDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: `✅ Texte bouton enregistré: **${draft.simple.btnLabel}**` });
        return true;
      }

      // /ticket-panel builder type add/edit
      if (interaction.customId === "tpnl:type_modal_add") {
        if (!isAdmin(interaction)) return true;

        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);

        const label = interaction.fields.getTextInputValue("label").trim().slice(0, 100);
        const value = interaction.fields.getTextInputValue("value").trim().slice(0, 50);
        const desc = (interaction.fields.getTextInputValue("desc") || "").trim().slice(0, 100);
        const emoji = (interaction.fields.getTextInputValue("emoji") || "").trim().slice(0, 20);

        if (!label || !value) return replyEphemeral(interaction, { content: "❌ Label & Value obligatoires." });

        if ((draft.types || []).some((t) => t.value === value)) {
          return replyEphemeral(interaction, { content: "❌ Value déjà utilisé. Choisis un identifiant unique." });
        }

        draft.types = draft.types || [];
        draft.types.push({ label, value, description: desc || undefined, emoji: emoji || undefined });
        setPanelDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Type ajouté (Panel Builder)." });
        return true;
      }

      if (interaction.customId.startsWith("tpnl:type_modal_edit:")) {
        if (!isAdmin(interaction)) return true;

        const editValue = interaction.customId.split(":").pop();
        const draft = getPanelDraft(interaction.guildId, interaction.user.id);
        if (!draft?.types?.length) return replyEphemeral(interaction, { content: "⚠️ Session expirée. Relance /ticket-panel" });

        const label = interaction.fields.getTextInputValue("label").trim().slice(0, 100);
        const value = interaction.fields.getTextInputValue("value").trim().slice(0, 50);
        const desc = (interaction.fields.getTextInputValue("desc") || "").trim().slice(0, 100);
        const emoji = (interaction.fields.getTextInputValue("emoji") || "").trim().slice(0, 20);

        const idx = draft.types.findIndex((t) => t.value === editValue);
        if (idx === -1) return replyEphemeral(interaction, { content: "⚠️ Type introuvable." });

        if (value !== editValue && draft.types.some((t) => t.value === value)) {
          return replyEphemeral(interaction, { content: "❌ Value déjà utilisé." });
        }

        draft.types[idx] = { label, value, description: desc || undefined, emoji: emoji || undefined };
        setPanelDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Type modifié (Panel Builder)." });
        return true;
      }

      // ticket premium submit (modal)
      if (interaction.customId.startsWith("ticketp:modal:")) {
        const parts = interaction.customId.split(":");
        const panelId = parts[2];
        const selected = parts[3];
        const label = decodeURIComponent(parts.slice(4).join(":") || selected);

        const subject = interaction.fields.getTextInputValue("subject");
        const details = interaction.fields.getTextInputValue("details");

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        return await createTicket(interaction, label || selected || "Support", subject, details);
      }

      // existing feedback comment modal
      if (interaction.customId.startsWith("ticket:comment:")) {
        const parts = interaction.customId.split(":");
        return await doComment(interaction, client, parts[2], parts[3]);
      }

      return false;
    }

    // SELECT MENUS
    if (interaction.isStringSelectMenu()) {
      // ticket-setup config
      if (interaction.customId === "tsetup:set_category") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        if (v && v !== "none") await upsertSettings(interaction.guildId, { category_id: v });
        await replyEphemeral(interaction, { content: "✅ Catégorie tickets mise à jour." });
        return true;
      }
      if (interaction.customId === "tsetup:set_staff") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        if (v && v !== "none") await upsertSettings(interaction.guildId, { staff_role_id: v });
        await replyEphemeral(interaction, { content: "✅ Rôle staff mis à jour." });
        return true;
      }
      if (interaction.customId === "tsetup:set_adminch") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        await upsertSettings(interaction.guildId, { admin_feedback_channel_id: v === "none" ? null : v });
        await replyEphemeral(interaction, { content: "✅ Salon admin mis à jour." });
        return true;
      }

      // ticket-setup pick type edit/del
      if (interaction.customId === "tsetup:pick_edit") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getDraft(interaction.guildId, interaction.user.id);
        const cur = draft?.types?.find((t) => t.value === v);
        if (!cur) return replyEphemeral(interaction, { content: "⚠️ Type introuvable." });
        return await setupTypeModal(interaction, "edit", cur);
      }
      if (interaction.customId === "tsetup:pick_del") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getDraft(interaction.guildId, interaction.user.id);
        if (!draft?.types?.length) return replyEphemeral(interaction, { content: "⚠️ Session expirée. Relance /ticket-setup" });
        draft.types = draft.types.filter((t) => t.value !== v);
        setDraft(interaction.guildId, interaction.user.id, draft);
        await replyEphemeral(interaction, { content: "✅ Type supprimé." });
        return true;
      }
      if (interaction.customId === "tsetup:publish_pick") {
        if (!isAdmin(interaction)) return true;
        const chId = interaction.values?.[0];
        return await publishPanelToChannel(interaction, chId);
      }

      // panel builder selects
      if (interaction.customId === "tpnl:set_channel") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
        draft.target_channel_id = v === "none" ? null : v;
        setPanelDraft(interaction.guildId, interaction.user.id, draft);
        await replyEphemeral(interaction, { content: "✅ Salon cible mis à jour." });
        return true;
      }

      // mode simple: choose button color
      if (interaction.customId === "tpnl:simple_color") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0] || "primary";
        const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
        draft.simple = draft.simple || { enabled: true };
        draft.simple.enabled = true;
        draft.simple.btnStyle = v;
        setPanelDraft(interaction.guildId, interaction.user.id, draft);
        await replyEphemeral(interaction, { content: `✅ Couleur bouton enregistrée: **${v}**.` });
        return true;
      }

      if (interaction.customId === "tpnl:pick_edit") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getPanelDraft(interaction.guildId, interaction.user.id);
        const cur = draft?.types?.find((t) => t.value === v);
        if (!cur) return replyEphemeral(interaction, { content: "⚠️ Type introuvable." });
        return await panelBuilderTypeModal(interaction, "edit", cur);
      }
      if (interaction.customId === "tpnl:pick_del") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getPanelDraft(interaction.guildId, interaction.user.id);
        if (!draft?.types?.length) return replyEphemeral(interaction, { content: "⚠️ Session expirée. Relance /ticket-panel" });
        draft.types = draft.types.filter((t) => t.value !== v);
        setPanelDraft(interaction.guildId, interaction.user.id, draft);
        await replyEphemeral(interaction, { content: "✅ Type supprimé (Panel Builder)." });
        return true;
      }

      // ticket premium select => form OR direct
      if (interaction.customId.startsWith("ticketp:select:")) {
        const panelId = interaction.customId.split(":")[2];
        const value = interaction.values?.[0];

        // preview cases
        if (panelId === "preview") {
          const pb = getPanelDraft(interaction.guildId, interaction.user.id);
          const src = pb?.types?.length
            ? pb.types
            : getDraft(interaction.guildId, interaction.user.id)?.types || PRESET_CATEGORIES;
          const found = src.find((c) => c.value === value);
          const label = found?.label || value || "Support";

          const useForm = await shouldUseFormForPanel("preview", interaction);
          if (!useForm) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
            return await createTicket(interaction, label);
          }
          return await openPremiumModal(interaction, "preview", value, label);
        }

        const panel = await getPanel(panelId);
        const payload = parsePanelPayload(panel?.categories);

        const arr = payload?.categories;
        const found = Array.isArray(arr) ? arr.find((c) => c.value === value) : null;
        const label = found?.label || value || "Support";

        const useForm = await shouldUseFormForPanel(panelId, interaction);
        if (!useForm) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          return await createTicket(interaction, label);
        }

        return await openPremiumModal(interaction, panelId, value, label);
      }

      // legacy select
      if (interaction.customId.startsWith("ticket:select:")) {
        const panelId = interaction.customId.split(":")[2];
        const value = interaction.values?.[0];

        const panel = await getPanel(panelId);
        const payload = parsePanelPayload(panel?.categories);

        let label = null;
        const arr = payload?.categories;
        if (Array.isArray(arr)) {
          const found = arr.find((c) => c.value === value);
          label = found?.label || null;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        return await createTicket(interaction, label || value || "Support");
      }

      return false;
    }

    // BUTTONS
    if (interaction.isButton()) {
      // ticket-setup wizard buttons
      if (interaction.customId.startsWith("tsetup:")) {
        if (!isAdmin(interaction)) return true;

        if (interaction.customId === "tsetup:close") {
          await interaction.update({ content: "✅ Fermé.", embeds: [], components: [] }).catch(() => {});
          return true;
        }
        if (interaction.customId === "tsetup:home") {
          const settings = await getSettings(interaction.guildId);
          const draft = getDraft(interaction.guildId, interaction.user.id);
          const embed = buildSetupHomeEmbed(interaction.guild, settings, draft);
          await interaction.update({ embeds: [embed], components: buildSetupHomeComponents(), content: "" }).catch(() => {});
          return true;
        }
        if (interaction.customId === "tsetup:config") return await setupConfig(interaction);
        if (interaction.customId === "tsetup:types") return await setupTypes(interaction);
        if (interaction.customId === "tsetup:preview") return await setupPreview(interaction);
        if (interaction.customId === "tsetup:publish") return await setupPublish(interaction);
        if (interaction.customId === "tsetup:limits") return await setupLimitsModal(interaction);

        if (interaction.customId === "tsetup:type_add") return await setupTypeModal(interaction, "add", null);
        if (interaction.customId === "tsetup:type_edit") return await setupPickType(interaction, "edit");
        if (interaction.customId === "tsetup:type_del") return await setupPickType(interaction, "del");

        return true;
      }

      // /ticket-panel builder buttons
      if (interaction.customId.startsWith("tpnl:")) {
        if (!isAdmin(interaction)) return true;

        if (interaction.customId === "tpnl:close") {
          await interaction.update({ content: "✅ Fermé.", embeds: [], components: [] }).catch(() => {});
          return true;
        }

        if (interaction.customId === "tpnl:home") {
          const draft = getPanelDraft(interaction.guildId, interaction.user.id) || defaultPanelBuilderDraft(interaction.guild);
          if (typeof draft.form_enabled !== "boolean") draft.form_enabled = true;
          const embed = buildPanelBuilderHomeEmbed(interaction.guild, draft);
          await interaction
            .update({ embeds: [embed], components: buildPanelBuilderHomeComponents(draft), content: "" })
            .catch(() => {});
          return true;
        }

        if (interaction.customId === "tpnl:style") return await panelBuilderOpenStyleModal(interaction);
        if (interaction.customId === "tpnl:banner") return await panelBuilderOpenBannerModal(interaction);
        if (interaction.customId === "tpnl:layout") return await panelBuilderToggleLayout(interaction);
        if (interaction.customId === "tpnl:types") return await panelBuilderTypesView(interaction);
        if (interaction.customId === "tpnl:channel") return await panelBuilderPickChannel(interaction);
        if (interaction.customId === "tpnl:preview") return await panelBuilderPreview(interaction);
        if (interaction.customId === "tpnl:publish") return await panelBuilderPublish(interaction);

        if (interaction.customId === "tpnl:type_add") return await panelBuilderTypeModal(interaction, "add", null);
        if (interaction.customId === "tpnl:type_edit") return await panelBuilderPickType(interaction, "edit");
        if (interaction.customId === "tpnl:type_del") return await panelBuilderPickType(interaction, "del");

        // ✅ Mode Simple button
        if (interaction.customId === "tpnl:simple") return await panelBuilderOpenSimpleModal(interaction);

        // ✅ NEW: Formulaire toggle
        if (interaction.customId === "tpnl:form_toggle") return await panelBuilderToggleForm(interaction);

        // ✅ NEW: Mode Simple option buttons
        if (interaction.customId === "tpnl:simple_color_btn") {
          await safeDeferUpdate(interaction);
          await panelBuilderAskButtonColor(interaction);
          return true;
        }
        if (interaction.customId === "tpnl:simple_label_btn") {
          return await panelBuilderOpenButtonLabelModal(interaction);
        }

        return true;
      }

      // ticket premium button open => form OR direct
      if (interaction.customId.startsWith("ticketp:open:")) {
        const parts = interaction.customId.split(":");
        // ticketp:open:<panelId>:<value>:<labelEncoded>
        const panelId = parts[2];
        const value = parts[3];
        const label = decodeURIComponent(parts.slice(4).join(":") || value);

        const useForm = await shouldUseFormForPanel(panelId, interaction);
        if (!useForm) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          return await createTicket(interaction, label || value || "Support");
        }

        return await openPremiumModal(interaction, panelId, value, label);
      }

      // legacy ticket buttons
      if (interaction.customId.startsWith("ticket:")) {
        const parts = interaction.customId.split(":");
        const action = parts[1];

        if (action === "open") {
          const panelId = parts[2];
          const panel = await getPanel(panelId);
          const payload = parsePanelPayload(panel?.categories);
          const reason = normalizeFreeReason(payload?.simple_reason) || "Support";

          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          return await createTicket(interaction, reason);
        }

        if (action === "rate") {
          return await doRate(interaction, parts[2], parts[3]);
        }

        await safeDeferUpdate(interaction);

        if (action === "claim") return await doClaim(interaction, parts[2]);
        if (action === "close") return await doClose(interaction, client, parts[2]);
        if (action === "delete") return await doDelete(interaction, client, parts[2]);
        if (action === "transcript") return await doTranscript(interaction, client, parts[2]);

        return true;
      }

      return false;
    }

    // SLASH
    if (!interaction.isChatInputCommand()) return false;

    if (interaction.commandName === "ticket-setup") return await setupStart(interaction);

    if (interaction.commandName === "ticket-panel") {
      // If user provided legacy mode -> legacy behavior
      const maybeMode = interaction.options.getString("mode");
      if (maybeMode) return await createPanelLegacy(interaction);
      // else premium builder
      return await panelBuilderStart(interaction);
    }

    if (interaction.commandName === "ticket-config") {
      if (!isAdmin(interaction)) {
        await replyEphemeral(interaction, { content: "⛔ Admin uniquement." });
        return true;
      }

      const sub = interaction.options.getSubcommand(true);

      if (sub === "show") {
        const s = await getSettings(interaction.guildId);

        const embed = new EmbedBuilder()
          .setColor(premiumColor())
          .setTitle("⚙️ Ticket config (admin)")
          .addFields(
            { name: "Category", value: s.category_id ? `<#${s.category_id}>` : "—" },
            { name: "Staff role", value: s.staff_role_id ? `<@&${s.staff_role_id}>` : "—", inline: true },
            {
              name: "Admin feedback channel",
              value: s.admin_feedback_channel_id ? `<#${s.admin_feedback_channel_id}>` : "—",
              inline: true,
            },
            {
              name: "Transcript channel",
              value: s.transcript_channel_id ? `<#${s.transcript_channel_id}>` : "—",
              inline: true,
            },
            { name: "Max open/user", value: String(s.max_open_per_user), inline: true },
            { name: "Cooldown", value: `${Math.floor(s.cooldown_seconds / 60)} min`, inline: true },
            { name: "Claim exclusif", value: s.claim_exclusive ? "✅" : "❌", inline: true },
            { name: "Delete on close", value: s.delete_on_close ? "✅" : "❌", inline: true }
          )
          .setTimestamp();

        await replyEphemeral(interaction, { embeds: [embed] });
        return true;
      }

      if (sub === "set") {
        const category = interaction.options.getChannel("category");
        const staffRole = interaction.options.getRole("staff_role");
        const adminFb = interaction.options.getChannel("admin_feedback_channel");
        const transcriptCh = interaction.options.getChannel("transcript_channel");
        const maxOpen = interaction.options.getInteger("max_open");
        const cdMin = interaction.options.getInteger("cooldown_minutes");
        const claimExclusive = interaction.options.getBoolean("claim_exclusive");
        const deleteOnClose = interaction.options.getBoolean("delete_on_close");

        const patch = {};
        if (category) patch.category_id = category.id;
        if (staffRole) patch.staff_role_id = staffRole.id;
        if (adminFb) patch.admin_feedback_channel_id = adminFb.id;
        if (transcriptCh) patch.transcript_channel_id = transcriptCh.id;
        if (maxOpen !== null && maxOpen !== undefined) patch.max_open_per_user = maxOpen;
        if (cdMin !== null && cdMin !== undefined) patch.cooldown_seconds = cdMin * 60;
        if (claimExclusive !== null && claimExclusive !== undefined) patch.claim_exclusive = claimExclusive;
        if (deleteOnClose !== null && deleteOnClose !== undefined) patch.delete_on_close = deleteOnClose;

        const next = await upsertSettings(interaction.guildId, patch);

        await replyEphemeral(interaction, {
          content: `✅ Config mise à jour. (category: ${next.category_id ? `<#${next.category_id}>` : "—"}, feedback: ${
            next.admin_feedback_channel_id ? `<#${next.admin_feedback_channel_id}>` : "—"
          })`,
        });
        return true;
      }

      return true;
    }

    if (interaction.commandName === "ticket-stats") return await doStats(interaction);

    return false;
  }

  return { commands, handleInteraction };
}

module.exports = { createTicketsService };
