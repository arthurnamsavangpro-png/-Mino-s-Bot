const STATUS_EMOJIS = {
  green: { name: "greentick", id: "1484036660030078977", fallback: "✅" },
  red: { name: "redtick", id: "1484036135876431903", fallback: "❌" },
  ticket: { name: "ticket_1", id: "1483662269966716949", fallback: "🎫" },
};

function resolveStatusEmoji(guild, key) {
  const meta = STATUS_EMOJIS[key];
  if (!meta) return "";
  const found = guild?.emojis?.cache?.get?.(meta.id);
  if (found?.id && found?.name) return `<:${found.name}:${found.id}>`;
  return meta.fallback;
}

module.exports = { resolveStatusEmoji };
