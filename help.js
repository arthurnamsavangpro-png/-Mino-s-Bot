// help.js — /help interactif (EPHEMERAL) + Select Menu + Boutons (DM / Refresh / Home)

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");

function safeCmdName(cmdJson) {
  // cmdJson comes from SlashCommandBuilder.toJSON()
  return cmdJson?.name ? `/${cmdJson.name}` : null;
}

function prettyPermsForCategory(catKey) {
  // Affichage simple (tu peux ajuster)
  const staffCats = new Set(["tickets", "moderation", "automod", "updates", "sendmessage", "modrank", "absence", "welcome"]);
  return staffCats.has(catKey) ? "🔒 Staff / Admin recommandé" : "✅ Accessible à tous";
}

function buildHomeEmbed(guild, client) {
  const guildName = guild?.name || "Serveur";
  const icon = guild?.iconURL?.({ size: 128 }) || null;

  const e = new EmbedBuilder()
    .setTitle("📚 Centre d’aide — Mino Bot")
    .setDescription(
      [
        `Bienvenue sur le **/help** interactif.`,
        "",
        "➡️ **Choisis une catégorie** dans le menu ci-dessous pour voir les commandes + exemples.",
        "📩 Tu peux aussi **te l’envoyer en MP** (bouton).",
        "",
        "💡 Certaines catégories sont réservées au staff (modération/automod/tickets…).",
      ].join("\n")
    )
    .setFooter({ text: `Serveur: ${guildName}` });

  if (icon) e.setThumbnail(icon);
  if (client?.user?.avatarURL?.()) e.setAuthor({ name: client.user.username, iconURL: client.user.avatarURL() });

  return e;
}

function buildCategoryEmbed({ guild, client, category, commands }) {
  const guildName = guild?.name || "Serveur";
  const icon = guild?.iconURL?.({ size: 128 }) || null;

  const permLine = prettyPermsForCategory(category.key);

  // Affichage commandes (compact + propre)
  const cmdLines = commands.length
    ? commands.map((c) => `• **${c.name}** — ${c.description || "—"}`).join("\n")
    : "Aucune commande détectée pour cette catégorie.";

  const exampleLines = category.examples?.length ? category.examples.map((x) => `• \`${x}\``).join("\n") : "—";

  const e = new EmbedBuilder()
    .setTitle(`${category.emoji} ${category.label}`)
    .setDescription(category.description || "—")
    .addFields(
      { name: "🧾 Commandes", value: cmdLines.slice(0, 1024) || "—" },
      { name: "✨ Exemples", value: exampleLines.slice(0, 1024) || "—", inline: false },
      { name: "🔐 Permissions", value: permLine, inline: false }
    )
    .setFooter({ text: `Utilise le menu pour naviguer • ${guildName}` });

  if (icon) e.setThumbnail(icon);
  if (client?.user?.avatarURL?.()) e.setAuthor({ name: client.user.username, iconURL: client.user.avatarURL() });

  return e;
}

function buildComponents({ categories, currentKey }) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("help:menu")
    .setPlaceholder("Choisis une catégorie…")
    .addOptions(
      categories.map((c) => ({
        label: c.label,
        value: c.key,
        emoji: c.emoji,
        description: c.short || "Voir les commandes",
        default: c.key === currentKey,
      }))
    );

  const rowMenu = new ActionRowBuilder().addComponents(menu);

  const rowBtns = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`help:dm:${currentKey}`)
      .setLabel("Recevoir en MP")
      .setEmoji("📩")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`help:refresh:${currentKey}`)
      .setLabel("Rafraîchir")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help:home")
      .setLabel("Accueil")
      .setEmoji("🏠")
      .setStyle(ButtonStyle.Primary)
  );

  return [rowMenu, rowBtns];
}

function flattenCommands(service) {
  // service.commands is an array of SlashCommandBuilder
  const list = [];
  for (const b of service?.commands || []) {
    try {
      const j = b?.toJSON?.();
      const name = safeCmdName(j);
      if (!name) continue;
      list.push({
        name,
        description: j?.description || "",
      });
    } catch {
      // ignore malformed command builder
    }
  }
  return list;
}

function createHelpService({ services }) {
  // Catégories (basées sur TON index.js / modules existants)
  const categories = [
    {
      key: "vouches",
      emoji: "📩",
      label: "Vouches",
      short: "Avis / réputation",
      description: "Système de vouches : ajouter un avis, voir les stats, top, etc.",
      examples: ["/vouch", "/vouches", "/vouchboard"],
      serviceKeys: ["vouches"],
    },
    {
      key: "rankup",
      emoji: "⬆️",
      label: "Rank-up",
      short: "Progression / rôles",
      description: "Système de rank-up (ex: lié aux vouches ou progression).",
      examples: ["/rankup", "/rank-roles", "/rankup-config"],
      serviceKeys: ["rankup"],
    },
    {
      key: "modrank",
      emoji: "👑",
      label: "ModRank",
      short: "Promotion staff",
      description: "Système de promotion/rank-up staff (embeds luxury, logs, DM, etc.).",
      examples: ["/modrank", "/modrank-setup", "/modrank-addrole"],
      serviceKeys: ["modrank"],
    },
    {
      key: "tickets",
      emoji: "🎟️",
      label: "Tickets (Premium)",
      short: "Support & panels",
      description: "Création et gestion de tickets premium (panel builder, claim, close, transcript…).",
      examples: ["/ticket-setup", "/ticket-panel", "/ticket-config"],
      serviceKeys: ["tickets"],
    },
    {
      key: "giveaway",
      emoji: "🎉",
      label: "Giveaway",
      short: "Concours",
      description: "Créer / gérer des giveaways avec sweep automatique.",
      examples: ["/giveaway", "/giveaway-end", "/giveaway-reroll"],
      serviceKeys: ["giveaways"],
    },
    {
      key: "moderation",
      emoji: "🛡️",
      label: "Modération",
      short: "Actions modération",
      description: "Commandes de modération : clear, ban/unban, timeout, logs, etc.",
      examples: ["/clear", "/ban", "/unban", "/timeout"],
      serviceKeys: ["moderation"],
    },
    {
      key: "automod",
      emoji: "🤖",
      label: "AutoMod / Anti-raid",
      short: "Protection serveur",
      description: "Protection automatique : anti-spam/anti-raid, blocage liens/invites, lockdown…",
      examples: ["/automod", "/automod-panel", "/lockdown"],
      serviceKeys: ["automod"],
    },
    {
      key: "updates",
      emoji: "📣",
      label: "Updates / Broadcast",
      short: "Annonces multi-serveurs",
      description: "Diffuser des annonces / embeds sur tous tes serveurs configurés.",
      examples: ["/updates", "/updates-config", "/broadcast"],
      serviceKeys: ["updates"],
    },
    {
      key: "welcome",
      emoji: "👋",
      label: "Bienvenue",
      short: "Onboarding auto",
      description: "Messages automatiques de bienvenue avec template et salon dédié.",
      examples: ["/welcome set", "/welcome info", "/welcome test"],
      serviceKeys: ["welcome"],
    },
    {
      key: "worl",
      emoji: "⚖️",
      label: "WorL",
      short: "Sondage W/L",
      description: "Système de sondage W/L style trading (Je trade : contre :), votes W ou L.",
      examples: ["/worl"],
      serviceKeys: ["worl"],
    },
    {
      key: "sendmessage",
      emoji: "✉️",
      label: "Send Message",
      short: "Embed / message",
      description: "Envoi de messages / embeds via modal (outil d’annonce/communication).",
      examples: ["/send-message"],
      serviceKeys: ["sendMessage"],
    },
    {
      key: "invitations",
      emoji: "📨",
      label: "Invitations",
      short: "Tracking & rewards",
      description: "Système d'invites avancé : profil, leaderboard, rewards, logs et actions admin.",
      examples: ["/invite profil", "/invite leaderboard", "/invite rewards", "/invite setreward"],
      serviceKeys: ["invitations"],
    },
    {
      key: "absence",
      emoji: "🛫",
      label: "Absences Staff",
      short: "Demandes + validation admin",
      description: "Déclaration d'absence staff avec validation administrateur et rôle absence automatique.",
      examples: ["/absence set", "/absence declare", "/absence approve", "/absence retour"],
      serviceKeys: ["absence"],
    },
    {
      key: "all",
      emoji: "🧩",
      label: "Tout afficher",
      short: "Liste complète",
      description: "Affiche une vue compacte de toutes les commandes détectées.",
      examples: ["/help"],
      serviceKeys: ["vouches", "rankup", "modrank", "tickets", "giveaways", "moderation", "automod", "updates", "welcome", "invitations", "absence", "worl", "sendMessage"],
    },
  ];

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Centre d’aide interactif (éphémère)"),
  ];

  function getCommandsForCategory(catKey) {
    const cat = categories.find((c) => c.key === catKey) || categories[0];
    const all = [];
    for (const k of cat.serviceKeys || []) {
      const svc = services[k];
      const list = flattenCommands(svc);
      for (const it of list) all.push(it);
    }

    // dédoublonnage par nom
    const seen = new Set();
    const uniq = [];
    for (const c of all) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      uniq.push(c);
    }

    // tri alpha
    uniq.sort((a, b) => a.name.localeCompare(b.name));
    return { cat, cmds: uniq };
  }

  async function replyHelp(interaction, client, key = "vouches") {
    const guild = interaction.guild;
    const { cat, cmds } = getCommandsForCategory(key);

    // HOME
    if (key === "home") {
      const embed = buildHomeEmbed(guild, client);
      const comps = buildComponents({ categories, currentKey: "vouches" });
      return interaction.reply({
        embeds: [embed],
        components: comps,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ALL => embed spécial compact
    if (key === "all") {
      const guildName = guild?.name || "Serveur";
      const icon = guild?.iconURL?.({ size: 128 }) || null;

      const lines = cmds.length
        ? cmds.map((c) => `• **${c.name}** — ${c.description || "—"}`).join("\n")
        : "Aucune commande détectée.";

      const e = new EmbedBuilder()
        .setTitle("🧩 Toutes les commandes")
        .setDescription(`Vue compacte de toutes les commandes détectées.`)
        .addFields({ name: "📌 Liste", value: lines.slice(0, 3900) || "—" })
        .setFooter({ text: `Serveur: ${guildName}` });

      if (icon) e.setThumbnail(icon);
      if (client?.user?.avatarURL?.()) e.setAuthor({ name: client.user.username, iconURL: client.user.avatarURL() });

      const comps = buildComponents({ categories, currentKey: "all" });

      return interaction.reply({
        embeds: [e],
        components: comps,
        flags: MessageFlags.Ephemeral,
      });
    }

    // CATEGORY
    const embed = buildCategoryEmbed({ guild, client, category: cat, commands: cmds });
    const comps = buildComponents({ categories, currentKey: key });

    return interaction.reply({
      embeds: [embed],
      components: comps,
      flags: MessageFlags.Ephemeral,
    });
  }

  async function updateHelp(interaction, client, key) {
    const guild = interaction.guild;
    const { cat, cmds } = getCommandsForCategory(key);

    if (key === "all") {
      const guildName = guild?.name || "Serveur";
      const icon = guild?.iconURL?.({ size: 128 }) || null;

      const lines = cmds.length
        ? cmds.map((c) => `• **${c.name}** — ${c.description || "—"}`).join("\n")
        : "Aucune commande détectée.";

      const e = new EmbedBuilder()
        .setTitle("🧩 Toutes les commandes")
        .setDescription(`Vue compacte de toutes les commandes détectées.`)
        .addFields({ name: "📌 Liste", value: lines.slice(0, 3900) || "—" })
        .setFooter({ text: `Serveur: ${guildName}` });

      if (icon) e.setThumbnail(icon);
      if (client?.user?.avatarURL?.()) e.setAuthor({ name: client.user.username, iconURL: client.user.avatarURL() });

      const comps = buildComponents({ categories, currentKey: "all" });

      return interaction.update({
        embeds: [e],
        components: comps,
      });
    }

    const embed = buildCategoryEmbed({ guild, client, category: cat, commands: cmds });
    const comps = buildComponents({ categories, currentKey: key });

    return interaction.update({
      embeds: [embed],
      components: comps,
    });
  }

  async function handleInteraction(interaction, client) {
    // Boutons / Select Menu (pas forcément chat input)
    if (interaction.isStringSelectMenu() && interaction.customId === "help:menu") {
      const key = interaction.values?.[0] || "vouches";
      await updateHelp(interaction, client, key);
      return true;
    }

    if (interaction.isButton() && interaction.customId?.startsWith("help:")) {
      const [_, action, key] = interaction.customId.split(":");

      if (action === "home") {
        const embed = buildHomeEmbed(interaction.guild, client);
        const comps = buildComponents({ categories, currentKey: "vouches" });
        await interaction.update({ embeds: [embed], components: comps });
        return true;
      }

      if (action === "refresh") {
        await updateHelp(interaction, client, key || "vouches");
        return true;
      }

      if (action === "dm") {
        const targetKey = key || "vouches";
        const { cat, cmds } = getCommandsForCategory(targetKey);

        // Embed DM similaire à la catégorie
        const dmEmbed = buildCategoryEmbed({
          guild: interaction.guild,
          client,
          category: cat,
          commands: cmds,
        });

        try {
          await interaction.user.send({ embeds: [dmEmbed] });
          await interaction.reply({
            content: "✅ Je t’ai envoyé le help en MP.",
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          await interaction.reply({
            content: "⚠️ Impossible de t’envoyer un MP (MP désactivés).",
            flags: MessageFlags.Ephemeral,
          });
        }
        return true;
      }
    }

    // Slash command /help
    if (interaction.isChatInputCommand() && interaction.commandName === "help") {
      // On démarre sur l’accueil ou directement une catégorie
      // Ici: accueil
      await replyHelp(interaction, client, "home");
      return true;
    }

    return false;
  }

  return { commands, handleInteraction };
}

module.exports = { createHelpService };
