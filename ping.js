const { SlashCommandBuilder } = require('discord.js');

function createPingService() {
  const commands = [new SlashCommandBuilder().setName('ping').setDescription('Répond pong + latence')];

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'ping') return false;

    const sent = await interaction.reply({ content: 'pong ', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`pong (latence: ${latency}ms)`);
    return true;
  }

  return { commands, handleInteraction };
}

module.exports = { createPingService };
