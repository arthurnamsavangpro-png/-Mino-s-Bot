const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;   // Application ID
const GUILD_ID = process.env.GUILD_ID;     // ID du serveur (pour enregistrer vite)

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Variables manquantes. Ajoute DISCORD_TOKEN, CLIENT_ID, GUILD_ID dans l'hébergeur.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Répond pong + latence")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // Enregistrement GUILD (instantané). Global peut prendre du temps.
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });

  console.log("✅ Slash commands enregistrées sur le serveur.");
}

client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error("Erreur enregistrement commandes:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    const sent = await interaction.reply({ content: "pong 🏓", fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`pong 🏓 (latence: ${latency}ms)`);
  }
});

client.login(TOKEN);
