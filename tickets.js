// tickets.js (UPGRADE PREMIUM WIZARD + PANEL PREMIUM)
// Basé sur TON code (conserve ticket-panel / ticket-config / ticket-stats + ticket:* handlers)
// Ajoute:
// - /ticket-setup (wizard premium côté admin)
// - panel premium (ticketp:select / ticketp:open / ticketp:modal) => Select -> Modal -> Ticket créé

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

// ✅ Catégories prédéfinies (panel mode: categories)
const PRESET_CATEGORIES = [
  { label: "Support", value: "support", description: "Aide / assistance" },
  { label: "Vente de Brainrot", value: "vente-brainrot", description: "Achat / vente" },
  { label: "Recrutement", value: "recrutement", description: "Candidature / staff" },
  { label: "Questions", value: "questions", description: "Questions générales" },
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

function buildPremiumPanelEmbed({ guild, title, description }) {
  return new EmbedBuilder()
    .setColor(premiumColor())
    .setAuthor(buildPremiumAuthor(guild))
    .setTitle(title || "🎫 Support Center")
    .setDescription(
      description ||
        [
          "Sélectionne une catégorie pour ouvrir un ticket.",
          "",
          "✅ **Process premium** : *Catégorie → Formulaire → Ticket créé*",
          "⚠️ Merci d’être précis pour une réponse rapide.",
        ].join("\n")
    )
    .setFooter({ text: "Tickets Premium • Mino Bot" })
    .setTimestamp();
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
    ? new ButtonBuilder()
        .setCustomId(`ticket:claim:${ticketId}`)
        .setLabel("Unclaim")
        .setStyle(ButtonStyle.Danger)
    : new ButtonBuilder()
        .setCustomId(`ticket:claim:${ticketId}`)
        .setLabel("Claim")
        .setStyle(ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(
    claimBtn,
    new ButtonBuilder()
      .setCustomId(`ticket:close:${ticketId}`)
      .setLabel("Fermer")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket:transcript:${ticketId}`)
      .setLabel("Transcript (admin)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ticket:delete:${ticketId}`)
      .setLabel("Supprimer (admin)")
      .setStyle(ButtonStyle.Danger)
  );
}

async function updateTicketMessage(interaction, data) {
  const channel = interaction.channel;
  const messageId = interaction.message?.id;

  if (!channel?.isTextBased?.() || !messageId) return;

  const msg =
    (await channel.messages.fetch(messageId).catch(() => null)) || interaction.message;
  if (!msg?.edit) return;

  const embed = buildTicketEmbed(data);
  const controls = buildTicketControls(data.ticketId, Boolean(data.claimedBy));

  await msg
    .edit({
      content: msg.content ?? undefined,
      embeds: [embed],
      components: [controls],
    })
    .catch(() => {});
}

/* ---------------- Wizard Drafts (Admin) ---------------- */

const setupDrafts = new Map(); // key guildId:userId -> { cfg, types, panelStyle, title, desc }
function dKey(guildId, userId) {
  return `${guildId}:${userId}`;
}
function getDraft(guildId, userId) {
  return setupDrafts.get(dKey(guildId, userId)) || null;
}
function setDraft(guildId, userId, value) {
  setupDrafts.set(dKey(guildId, userId), { ...value, _t: Date.now() });
}
function clearDraft(guildId, userId) {
  setupDrafts.delete(dKey(guildId, userId));
}

/* ---------------- Service ---------------- */

function createTicketsService({ pool, config }) {
  /* ---------------- Slash commands ---------------- */

  const ticketPanelCmd = new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("ADMIN: Poste un panel de tickets (bouton / catégories)")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("simple = bouton | categories = menu")
        .setRequired(true)
        .addChoices(
          { name: "simple", value: "simple" },
          { name: "categories", value: "categories" }
        )
    )
    .addChannelOption((opt) =>
      opt
        .setName("salon")
        .setDescription("Salon où poster le panel (sinon salon actuel)")
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
      opt.setName("titre").setDescription("Titre de l'embed").setRequired(false).setMaxLength(256)
    )
    .addStringOption((opt) =>
      opt
        .setName("description")
        .setDescription("Texte de l'embed")
        .setRequired(false)
        .setMaxLength(1500)
    )
    .addStringOption((opt) =>
      opt
        .setName("categories")
        .setDescription("Simple: raison libre. Categories: liste (Support|Aide, Recrutement|Candidature)")
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
        .addRoleOption((opt) =>
          opt.setName("staff_role").setDescription("Rôle staff (optionnel)").setRequired(false)
        )
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
        .addBooleanOption((opt) =>
          opt.setName("claim_exclusive").setDescription("Claim exclusif").setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("delete_on_close")
            .setDescription("Supprimer auto après close")
            .setRequired(false)
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

  // ✅ NOUVEAU: Wizard premium
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

  // ✅ optionnel: ajouter colonnes sujet/détails si tu veux les stocker (safe)
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

  /* ---------------- Panel creation (legacy) ---------------- */

  async function createPanel(interaction) {
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

      components = [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket:select:${panelId}`)
            .setPlaceholder("Choisis une raison…")
            .addOptions(
              categories.map((c) => ({
                label: c.label,
                value: c.value,
                description: c.description,
              }))
            )
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

    await pool.query(
      `INSERT INTO tickets (ticket_id, guild_id, channel_id, opener_id, category_label, status, subject, details)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$7)`,
      [ticketId, guild.id, channel.id, interaction.user.id, reason, subject, details]
    ).catch(async () => {
      // fallback si colonnes non ajoutées (au cas où)
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
    const res = await pool.query(
      `SELECT ticket_id, guild_id, channel_id, opener_id, status, claimed_by, category_label, created_at, closed_at,
              subject, details
       FROM tickets WHERE ticket_id=$1 LIMIT 1`,
      [ticketId]
    ).catch(async () => {
      // fallback si colonnes pas là
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
  // ⬇️ JE CONSERVE TES FONCTIONS telles quelles, juste je réutilise buildTicketEmbed amélioré (inclut sujet/détails si présents)

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
          `UPDATE tickets
             SET claimed_by=$2
           WHERE ticket_id=$1
             AND status='open'
             AND claimed_by IS NULL
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
          `UPDATE tickets
             SET claimed_by=NULL
           WHERE ticket_id=$1
             AND status='open'
             AND claimed_by=$2
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
          await safeFollowUpEphemeral(interaction, {
            content: `⚠️ Déjà pris en charge par <@${ticket.claimed_by}>.`,
          });
          return true;
        }

        const upd = await pool.query(
          `UPDATE tickets
             SET claimed_by=NULL
           WHERE ticket_id=$1
             AND status='open'
             AND claimed_by IS NOT NULL
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
            buildTicketChannelName({
              claimed: false,
              username: openerUsername,
              categoryLabel: reason,
            })
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

      await pool.query(
        `UPDATE tickets SET status='closed', closed_at=NOW()
         WHERE ticket_id=$1 AND status='open'`,
        [ticketId]
      );

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
            const file = new AttachmentBuilder(Buffer.from(content, "utf8"), {
              name: `ticket-${ticketId}.txt`,
            });

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

  /* ---------------- Premium Setup Wizard ---------------- */

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
    const draft = getDraft(interaction.guildId, interaction.user.id) || {
      types: PRESET_CATEGORIES.map((c) => ({ ...c })), // base premium
      title: "🎫 Support Center",
      description: null,
    };
    setDraft(interaction.guildId, interaction.user.id, draft);

    const embed = buildSetupHomeEmbed(interaction.guild, settings, draft);
    await replyEphemeral(interaction, { embeds: [embed], components: buildSetupHomeComponents() });
    return true;
  }

  async function setupConfig(interaction) {
    if (!isAdmin(interaction)) return true;

    const settings = await getSettings(interaction.guildId);

    // select category
    const cats = interaction.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((c) => ({ label: c.name.slice(0, 100), value: c.id }))
      .slice(0, 25);

    const roles = interaction.guild.roles.cache
      .filter((r) => !r.managed && r.id !== interaction.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ label: r.name.slice(0, 100), value: r.id }))
      .slice(0, 25);

    const texts = interaction.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ label: `#${c.name}`.slice(0, 100), value: c.id }))
      .slice(0, 24);

    const embed = new EmbedBuilder()
      .setColor(premiumColor())
      .setAuthor(buildPremiumAuthor(interaction.guild))
      .setTitle("Configurer le système")
      .setDescription("Choisis les éléments via menus. Aucun ID à copier.")
      .addFields(
        { name: "Catégorie tickets", value: settings.category_id ? `<#${settings.category_id}>` : "—", inline: true },
        { name: "Rôle staff", value: settings.staff_role_id ? `<@&${settings.staff_role_id}>` : "—", inline: true },
        { name: "Salon admin (feedback/transcripts)", value: settings.admin_feedback_channel_id ? `<#${settings.admin_feedback_channel_id}>` : "—" }
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

    modal.addComponents(
      new ActionRowBuilder().addComponents(maxOpen),
      new ActionRowBuilder().addComponents(cooldownMin)
    );

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  async function setupTypes(interaction) {
    if (!isAdmin(interaction)) return true;

    const draft = getDraft(interaction.guildId, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };
    setDraft(interaction.guildId, interaction.user.id, draft);

    const list = (draft.types || [])
      .slice(0, 15)
      .map((t, i) => `**${i + 1}.** ${t.label} — ${t.description || "—"}`)
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

    modal.addComponents(
      new ActionRowBuilder().addComponents(name),
      new ActionRowBuilder().addComponents(value),
      new ActionRowBuilder().addComponents(desc)
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

    const options = draft.types.slice(0, 25).map((t) => ({
      label: t.label.slice(0, 100),
      value: t.value,
      description: (t.description || "—").slice(0, 100),
    }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId(kind === "edit" ? "tsetup:pick_edit" : "tsetup:pick_del")
      .setPlaceholder(kind === "edit" ? "Quel type modifier ?" : "Quel type supprimer ?")
      .addOptions(options);

    await interaction.reply({
      content: "Sélectionne un type :",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  async function setupPreview(interaction) {
    const draft = getDraft(interaction.guildId, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };

    const embed = buildPremiumPanelEmbed({
      guild: interaction.guild,
      title: draft.title,
      description: draft.description,
    });

    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticketp:select:preview")
      .setPlaceholder("Choisis une catégorie…")
      .addOptions(
        (draft.types || PRESET_CATEGORIES).slice(0, 25).map((c) => ({
          label: c.label,
          value: c.value,
          description: c.description,
        }))
      );

    await interaction.reply({
      content: "👁️ Aperçu du panel premium :",
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  async function setupPublish(interaction) {
    const draft = getDraft(interaction.guildId, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };

    const channels = interaction.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ label: `#${c.name}`.slice(0, 100), value: c.id }))
      .slice(0, 25);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("tsetup:publish_pick")
      .setPlaceholder("Choisis le salon où publier le panel premium…")
      .addOptions(channels.length ? channels : [{ label: "Aucun salon texte trouvé", value: "none" }]);

    await interaction.reply({
      content: "✅ Choisis un salon :",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  async function publishPanelToChannel(interaction, channelId) {
    const guild = interaction.guild;
    if (!guild) return true;

    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) {
      await replyEphemeral(interaction, { content: "⚠️ Salon invalide." });
      return true;
    }

    const settings = await getSettings(guild.id);
    if (!settings.category_id) {
      await replyEphemeral(interaction, { content: "⚠️ Configure d’abord la catégorie tickets (/ticket-config set category:...)" });
      return true;
    }

    const draft = getDraft(guild.id, interaction.user.id) || { types: PRESET_CATEGORIES.map((c) => ({ ...c })) };
    const types = draft.types?.length ? draft.types : PRESET_CATEGORIES;

    const panelId = crypto.randomUUID();
    const payload = { categories: types, premium: true };

    const embed = buildPremiumPanelEmbed({ guild, title: draft.title, description: draft.description });

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ticketp:select:${panelId}`)
      .setPlaceholder("Choisis une catégorie…")
      .addOptions(
        types.slice(0, 25).map((c) => ({
          label: c.label,
          value: c.value,
          description: c.description,
        }))
      );

    const msg = await ch.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });

    await pool.query(
      `INSERT INTO ticket_panels (panel_id, guild_id, channel_id, message_id, mode, categories, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (panel_id) DO NOTHING`,
      [panelId, guild.id, msg.channel.id, msg.id, "premium", JSON.stringify(payload), interaction.user.id]
    );

    await replyEphemeral(interaction, { content: `✅ Panel premium publié dans <#${msg.channel.id}>.` });
    return true;
  }

  /* ---------------- Premium ticket: Select -> Modal -> Create ---------------- */

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

    modal.addComponents(
      new ActionRowBuilder().addComponents(subject),
      new ActionRowBuilder().addComponents(details)
    );

    await interaction.showModal(modal).catch(async () => {
      await replyEphemeral(interaction, { content: "⚠️ Impossible d’ouvrir le formulaire. Réessaie." });
    });

    return true;
  }

  /* ---------------- Router ---------------- */

  async function handleInteraction(interaction, client) {
    // PREMIUM MODALS
    if (interaction.isModalSubmit()) {
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

        await upsertSettings(interaction.guildId, {
          max_open_per_user: maxOpen,
          cooldown_seconds: cdMin * 60,
        });

        await replyEphemeral(interaction, { content: "✅ Limites mises à jour." });
        return true;
      }

      if (interaction.customId === "tsetup:type_modal_add") {
        if (!isAdmin(interaction)) return true;

        const draft = getDraft(interaction.guildId, interaction.user.id) || { types: [] };

        const label = interaction.fields.getTextInputValue("label").trim().slice(0, 100);
        const value = interaction.fields.getTextInputValue("value").trim().slice(0, 50);
        const desc = (interaction.fields.getTextInputValue("desc") || "").trim().slice(0, 100);

        if (!label || !value) {
          await replyEphemeral(interaction, { content: "❌ Label & Value obligatoires." });
          return true;
        }

        const exists = (draft.types || []).some((t) => t.value === value);
        if (exists) {
          await replyEphemeral(interaction, { content: "❌ Value déjà utilisé. Choisis un identifiant unique." });
          return true;
        }

        draft.types = draft.types || [];
        draft.types.push({ label, value, description: desc || undefined });

        setDraft(interaction.guildId, interaction.user.id, draft);
        await replyEphemeral(interaction, { content: "✅ Type ajouté." });
        return true;
      }

      if (interaction.customId.startsWith("tsetup:type_modal_edit:")) {
        if (!isAdmin(interaction)) return true;

        const editValue = interaction.customId.split(":").pop();
        const draft = getDraft(interaction.guildId, interaction.user.id);
        if (!draft?.types?.length) {
          await replyEphemeral(interaction, { content: "⚠️ Session expirée. Relance /ticket-setup" });
          return true;
        }

        const label = interaction.fields.getTextInputValue("label").trim().slice(0, 100);
        const value = interaction.fields.getTextInputValue("value").trim().slice(0, 50);
        const desc = (interaction.fields.getTextInputValue("desc") || "").trim().slice(0, 100);

        const idx = draft.types.findIndex((t) => t.value === editValue);
        if (idx === -1) {
          await replyEphemeral(interaction, { content: "⚠️ Type introuvable." });
          return true;
        }

        // prevent duplicate value if changed
        if (value !== editValue && draft.types.some((t) => t.value === value)) {
          await replyEphemeral(interaction, { content: "❌ Value déjà utilisé." });
          return true;
        }

        draft.types[idx] = { label, value, description: desc || undefined };
        setDraft(interaction.guildId, interaction.user.id, draft);

        await replyEphemeral(interaction, { content: "✅ Type modifié." });
        return true;
      }

      if (interaction.customId.startsWith("ticketp:modal:")) {
        // ticket premium submit
        const parts = interaction.customId.split(":"); // ticketp modal panelId selected labelEncoded
        const panelId = parts[2];
        const selected = parts[3];
        const label = decodeURIComponent(parts.slice(4).join(":") || selected);

        const subject = interaction.fields.getTextInputValue("subject");
        const details = interaction.fields.getTextInputValue("details");

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        return await createTicket(interaction, label || selected || "Support", subject, details);
      }

      // EXISTING COMMENT MODAL
      if (!interaction.customId.startsWith("ticket:comment:")) return false;
      const parts = interaction.customId.split(":");
      return await doComment(interaction, client, parts[2], parts[3]);
    }

    // PREMIUM SELECT (panel premium)
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("tsetup:set_category")) {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        if (v && v !== "none") await upsertSettings(interaction.guildId, { category_id: v });
        await replyEphemeral(interaction, { content: "✅ Catégorie tickets mise à jour." });
        return true;
      }

      if (interaction.customId.startsWith("tsetup:set_staff")) {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        if (v && v !== "none") await upsertSettings(interaction.guildId, { staff_role_id: v });
        await replyEphemeral(interaction, { content: "✅ Rôle staff mis à jour." });
        return true;
      }

      if (interaction.customId.startsWith("tsetup:set_adminch")) {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        await upsertSettings(interaction.guildId, { admin_feedback_channel_id: v === "none" ? null : v });
        // transcript_channel_id reste géré via /ticket-config si tu veux, sinon on peut l'ajouter au wizard aussi
        await replyEphemeral(interaction, { content: "✅ Salon admin mis à jour." });
        return true;
      }

      if (interaction.customId === "tsetup:pick_edit") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getDraft(interaction.guildId, interaction.user.id);
        const cur = draft?.types?.find((t) => t.value === v);
        if (!cur) {
          await replyEphemeral(interaction, { content: "⚠️ Type introuvable." });
          return true;
        }
        return await setupTypeModal(interaction, "edit", cur);
      }

      if (interaction.customId === "tsetup:pick_del") {
        if (!isAdmin(interaction)) return true;
        const v = interaction.values?.[0];
        const draft = getDraft(interaction.guildId, interaction.user.id);
        if (!draft?.types?.length) {
          await replyEphemeral(interaction, { content: "⚠️ Session expirée. Relance /ticket-setup" });
          return true;
        }
        draft.types = draft.types.filter((t) => t.value !== v);
        setDraft(interaction.guildId, interaction.user.id, draft);
        await replyEphemeral(interaction, { content: "✅ Type supprimé." });
        return true;
      }

      if (interaction.customId === "tsetup:publish_pick") {
        if (!isAdmin(interaction)) return true;
        const chId = interaction.values?.[0];
        await publishPanelToChannel(interaction, chId);
        return true;
      }

      // ticket premium select => modal
      if (interaction.customId.startsWith("ticketp:select:")) {
        const panelId = interaction.customId.split(":")[2];
        const value = interaction.values?.[0];

        // preview case
        if (panelId === "preview") {
          const draft = getDraft(interaction.guildId, interaction.user.id) || { types: PRESET_CATEGORIES };
          const found = (draft.types || PRESET_CATEGORIES).find((c) => c.value === value);
          return await openPremiumModal(interaction, "preview", value, found?.label || value);
        }

        const panel = await getPanel(panelId);
        const payload = parsePanelPayload(panel?.categories);
        const arr = payload?.categories;
        const found = Array.isArray(arr) ? arr.find((c) => c.value === value) : null;
        const label = found?.label || value || "Support";

        return await openPremiumModal(interaction, panelId, value, label);
      }

      // EXISTING SELECT (legacy)
      if (!interaction.customId.startsWith("ticket:select:")) return false;

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

    // BUTTONS
    if (interaction.isButton()) {
      // wizard buttons
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

      // legacy ticket buttons
      if (!interaction.customId.startsWith("ticket:")) return false;

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

    // SLASH
    if (!interaction.isChatInputCommand()) return false;

    if (interaction.commandName === "ticket-setup") return await setupStart(interaction);

    if (interaction.commandName === "ticket-panel") return await createPanel(interaction);

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
          content: `✅ Config mise à jour. (category: ${
            next.category_id ? `<#${next.category_id}>` : "—"
          }, feedback: ${next.admin_feedback_channel_id ? `<#${next.admin_feedback_channel_id}>` : "—"})`,
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
