// help.js — /help interactif (EPHEMERAL) + Select Menu + Boutons (DM / Refresh / Home)

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");

function safeCmdName(cmdJson) {
  return cmdJson?.name ? `/${cmdJson.name}` : null;
}

function isStaffCategory(catKey) {
  const staffCats = new Set([
    "tickets",
    "moderation",
    "automod",
    "updates",
    "sendmessage",
    "modrank",
    "absence",
    "welcome",
    "invitations",
    "serverstats",
    "startnewserver",
  ]);
  return staffCats.has(catKey);
}

function prettyPermsForCategory(catKey) {
  return isStaffCategory(catKey) ? "🔒 Staff / Admin recommandé" : "✅ Accessible à tous";
}

function flattenCommands(service) {
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
  const categories = [
    {
      key: "startnewserver",
      emoji: "🚀",
      label: "Start New Server",
      short: "Setup guidé",
      description: "Assistant ultra-rapide pour lancer la config initiale d’un serveur Discord.",
      examples: ["/startnewserver"],
      serviceKeys: ["startnewserver"],
    },
    {
      key: "vouches",
      emoji: "📩",
      label: "Vouches",
      short: "Avis & réputation",
      description: "Gère la réputation du serveur : ajout d’avis, profils, classement et vouchboard.",
      examples: ["/vouch", "/vouches", "/topvouches", "/setvouchboard"],
      serviceKeys: ["vouches"],
    },
    {
      key: "rankup",
      emoji: "⬆️",
      label: "Rank-up",
      short: "Progression par vouches",
      description: "Configure les rôles de progression et applique les promotions/rétrogradations.",
      examples: ["/rank-add", "/rank-list", "/rankup", "/rankdown"],
      serviceKeys: ["rankup"],
    },
    {
      key: "modrank",
      emoji: "👑",
      label: "ModRank",
      short: "Échelle staff",
      description: "Système d’évolution staff complet : rôles, ordre, promotions, logs et annonces.",
      examples: ["/modrank config", "/modrank add", "/modrank up", "/modrank info"],
      serviceKeys: ["modrank"],
    },
    {
      key: "tickets",
      emoji: "🎟️",
      label: "Tickets",
      short: "Support premium",
      description: "Panels de tickets, configuration avancée, stats, feedback et transcripts.",
      examples: ["/ticket-setup", "/ticket-panel", "/ticket-config show", "/ticket-stats"],
      serviceKeys: ["tickets"],
    },
    {
      key: "giveaway",
      emoji: "🎉",
      label: "Giveaways",
      short: "Concours complets",
      description: "Crée et administre des giveaways (création, fin, reroll, règles, liste).",
      examples: ["/giveaway create", "/giveaway end", "/giveaway reroll", "/giveaway list"],
      serviceKeys: ["giveaways"],
    },
    {
      key: "moderation",
      emoji: "🛡️",
      label: "Modération",
      short: "Actions & logs",
      description: "Ban, timeout, warn, purge, auto-rôles, logs détaillés et historique des sanctions.",
      examples: ["/ban", "/timeout", "/warn add", "/log status"],
      serviceKeys: ["moderation"],
    },
    {
      key: "automod",
      emoji: "🤖",
      label: "AutoMod",
      short: "Protection serveur",
      description: "Protection anti-spam/anti-raid avec panel, presets et statut en temps réel.",
      examples: ["/automod panel", "/automod preset", "/automod status"],
      serviceKeys: ["automod"],
    },
    {
      key: "updates",
      emoji: "📣",
      label: "Updates & Broadcast",
      short: "Annonces multi-serveurs",
      description: "Définit les salons d’annonce et diffuse messages/embeds sur les serveurs connectés.",
      examples: ["/updateschannel set", "/updateschannel info", "/broadcast", "/broadcastembed"],
      serviceKeys: ["updates"],
    },
    {
      key: "welcome",
      emoji: "👋",
      label: "Bienvenue",
      short: "Onboarding auto",
      description: "Configure les messages de bienvenue personnalisés (set, test, info, disable).",
      examples: ["/welcome set", "/welcome test", "/welcome info"],
      serviceKeys: ["welcome"],
    },
    {
      key: "invitations",
      emoji: "📨",
      label: "Invitations",
      short: "Tracking & récompenses",
      description: "Suit les invites, classements, bonus et paliers de rôles automatiques.",
      examples: ["/invite profil", "/invite leaderboard", "/invite rewards", "/invite setreward"],
      serviceKeys: ["invitations"],
    },
    {
      key: "absence",
      emoji: "🛫",
      label: "Absences Staff",
      short: "Workflow d’absence",
      description: "Déclaration, validation admin, rôle temporaire et suivi des absences staff.",
      examples: ["/absence set", "/absence declare", "/absence approve", "/absence retour"],
      serviceKeys: ["absence"],
    },
    {
      key: "worl",
      emoji: "⚖️",
      label: "WorL",
      short: "Sondages W/L",
      description: "Lance des sondages W ou L (ex: trade checks) avec votes interactifs.",
      examples: ["/worl"],
      serviceKeys: ["worl"],
    },
    {
      key: "sendmessage",
      emoji: "✉️",
      label: "Send Message",
      short: "Messages & embeds",
      description: "Outils d’envoi pour communication staff : messages simples et embeds enrichis.",
      examples: ["/send", "/sendembed"],
      serviceKeys: ["sendMessage"],
    },
    {
      key: "serverstats",
      emoji: "📊",
      label: "Server Stats",
      short: "Compteurs vocaux",
      description: "Crée/actualise les salons de statistiques vocales pour mettre en valeur le serveur.",
      examples: ["/serverstats setup", "/serverstats refresh", "/serverstats disable"],
      serviceKeys: ["serverstats"],
    },
    {
      key: "all",
      emoji: "🧩",
      label: "Tout afficher",
      short: "Vue complète",
      description: "Liste compacte de toutes les commandes détectées sur le bot.",
      examples: ["/help"],
      serviceKeys: [
        "vouches",
        "startnewserver",
        "rankup",
        "modrank",
        "tickets",
        "giveaways",
        "moderation",
        "automod",
        "updates",
        "welcome",
        "invitations",
        "absence",
        "worl",
        "sendMessage",
        "serverstats",
      ],
    },
  ];

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Centre d’aide interactif et pro (éphémère)"),
  ];

  function getCommandsForCategory(catKey) {
    const cat = categories.find((c) => c.key === catKey) || categories[0];
    const all = [];

    for (const k of cat.serviceKeys || []) {
      const svc = services[k];
      const list = flattenCommands(svc);
      for (const it of list) all.push(it);
    }

    const seen = new Set();
    const uniq = [];
    for (const c of all) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      uniq.push(c);
    }

    uniq.sort((a, b) => a.name.localeCompare(b.name));
    return { cat, cmds: uniq };
  }

  function buildHomeEmbed(guild, client) {
    const guildName = guild?.name || "Serveur";
    const icon = guild?.iconURL?.({ size: 128 }) || null;

    const allCommandsCount = new Set(
      Object.values(services)
        .flatMap((svc) => flattenCommands(svc))
        .map((c) => c.name)
    ).size;

    const publicCategories = categories.filter((c) => !isStaffCategory(c.key) && c.key !== "all").length;
    const staffCategories = categories.filter((c) => isStaffCategory(c.key)).length;

    const e = new EmbedBuilder()
      .setTitle("📚 Centre d’aide — Mino Bot")
      .setDescription(
        [
          "Bienvenue dans le **centre d’aide interactif** de Mino Bot.",
          "",
          "➡️ Sélectionne une catégorie pour voir ses commandes, cas d’usage et exemples.",
          "📩 Besoin d’une copie ? Clique sur **Recevoir en MP**.",
          "",
          "### 🚀 Démarrage rapide",
          "1. Configure d’abord les modules staff (tickets, logs, automod, invites).",
          "0. Lance `/startnewserver` pour suivre la checklist de base.",
          "2. Active ensuite les modules communautaires (vouches, giveaways, worl).",
          "3. Utilise `/help` à tout moment pour retrouver les commandes.",
        ].join("\n")
      )
      .addFields(
        { name: "🧠 Commandes détectées", value: `**${allCommandsCount}**`, inline: true },
        { name: "🌍 Modules publics", value: `**${publicCategories}**`, inline: true },
        { name: "🔒 Modules staff", value: `**${staffCategories}**`, inline: true }
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
    const cmdLines = commands.length
      ? commands.map((c) => `• **${c.name}** — ${c.description || "—"}`).join("\n")
      : "Aucune commande détectée pour cette catégorie.";

    const exampleLines = category.examples?.length ? category.examples.map((x) => `• \`${x}\``).join("\n") : "—";

    const e = new EmbedBuilder()
      .setTitle(`${category.emoji} ${category.label}`)
      .setDescription(category.description || "—")
      .addFields(
        { name: `🧾 Commandes (${commands.length})`, value: cmdLines.slice(0, 1024) || "—" },
        { name: "✨ Exemples", value: exampleLines.slice(0, 1024) || "—", inline: false },
        { name: "🔐 Permissions", value: permLine, inline: false }
      )
      .setFooter({ text: `Navigation /help • ${guildName}` });

    if (icon) e.setThumbnail(icon);
    if (client?.user?.avatarURL?.()) e.setAuthor({ name: client.user.username, iconURL: client.user.avatarURL() });

    return e;
  }

  function buildAllCommandsEmbed(guild, client, cmds) {
    const guildName = guild?.name || "Serveur";
    const icon = guild?.iconURL?.({ size: 128 }) || null;

    const chunks = [];
    let current = "";
    for (const line of cmds.map((c) => `• **${c.name}** — ${c.description || "—"}`)) {
      if ((current + "\n" + line).length > 950) {
        chunks.push(current || "—");
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current) chunks.push(current);

    const e = new EmbedBuilder()
      .setTitle("🧩 Toutes les commandes")
      .setDescription("Vue complète et compacte de toutes les commandes disponibles.")
      .setFooter({ text: `Serveur: ${guildName}` });

    if (!chunks.length) {
      e.addFields({ name: "📌 Liste", value: "Aucune commande détectée." });
    } else {
      chunks.slice(0, 4).forEach((chunk, i) => {
        e.addFields({ name: i === 0 ? "📌 Liste" : `📌 Suite ${i + 1}`, value: chunk, inline: false });
      });
    }

    if (icon) e.setThumbnail(icon);
    if (client?.user?.avatarURL?.()) e.setAuthor({ name: client.user.username, iconURL: client.user.avatarURL() });

    return e;
  }

  function buildComponents({ currentKey }) {
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
      new ButtonBuilder().setCustomId("help:home").setLabel("Accueil").setEmoji("🏠").setStyle(ButtonStyle.Primary)
    );

    return [rowMenu, rowBtns];
  }

  async function replyHelp(interaction, client, key = "vouches") {
    const guild = interaction.guild;
    const { cmds } = getCommandsForCategory(key);

    if (key === "home") {
      const embed = buildHomeEmbed(guild, client);
      const comps = buildComponents({ currentKey: "vouches" });
      return interaction.reply({ embeds: [embed], components: comps, flags: MessageFlags.Ephemeral });
    }

    if (key === "all") {
      const embed = buildAllCommandsEmbed(guild, client, cmds);
      const comps = buildComponents({ currentKey: "all" });
      return interaction.reply({ embeds: [embed], components: comps, flags: MessageFlags.Ephemeral });
    }

    const { cat } = getCommandsForCategory(key);
    const embed = buildCategoryEmbed({ guild, client, category: cat, commands: cmds });
    const comps = buildComponents({ currentKey: key });

    return interaction.reply({ embeds: [embed], components: comps, flags: MessageFlags.Ephemeral });
  }

  async function updateHelp(interaction, client, key) {
    const guild = interaction.guild;
    const { cat, cmds } = getCommandsForCategory(key);

    if (key === "all") {
      const embed = buildAllCommandsEmbed(guild, client, cmds);
      const comps = buildComponents({ currentKey: "all" });
      return interaction.update({ embeds: [embed], components: comps });
    }

    const embed = buildCategoryEmbed({ guild, client, category: cat, commands: cmds });
    const comps = buildComponents({ currentKey: key });
    return interaction.update({ embeds: [embed], components: comps });
  }

  async function handleInteraction(interaction, client) {
    if (interaction.isStringSelectMenu() && interaction.customId === "help:menu") {
      const key = interaction.values?.[0] || "vouches";
      await updateHelp(interaction, client, key);
      return true;
    }

    if (interaction.isButton() && interaction.customId?.startsWith("help:")) {
      const [_, action, key] = interaction.customId.split(":");

      if (action === "home") {
        const embed = buildHomeEmbed(interaction.guild, client);
        const comps = buildComponents({ currentKey: "vouches" });
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
        const dmEmbed =
          targetKey === "all"
            ? buildAllCommandsEmbed(interaction.guild, client, cmds)
            : buildCategoryEmbed({ guild: interaction.guild, client, category: cat, commands: cmds });

        try {
          await interaction.user.send({ embeds: [dmEmbed] });
          await interaction.reply({ content: "✅ Je t’ai envoyé le help en MP.", flags: MessageFlags.Ephemeral });
        } catch {
          await interaction.reply({
            content: "⚠️ Impossible de t’envoyer un MP (MP désactivés).",
            flags: MessageFlags.Ephemeral,
          });
        }
        return true;
      }
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "help") {
      await replyHelp(interaction, client, "home");
      return true;
    }

    return false;
  }

  return { commands, handleInteraction };
}

module.exports = { createHelpService };
