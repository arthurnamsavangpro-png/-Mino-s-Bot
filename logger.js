const { randomUUID } = require('crypto');

function createLogger() {
  const errorCounts = new Map();

  function emit(level, payload = {}) {
    const out = {
      ts: new Date().toISOString(),
      level,
      ...payload,
    };

    if (level === 'error') {
      const mod = String(payload.module || 'unknown');
      errorCounts.set(mod, (errorCounts.get(mod) || 0) + 1);
    }

    const line = JSON.stringify(out);
    if (level === 'error') return console.error(line);
    if (level === 'warn') return console.warn(line);
    return console.log(line);
  }

  return {
    info: (payload) => emit('info', payload),
    warn: (payload) => emit('warn', payload),
    error: (payload) => emit('error', payload),
    nextRequestId: () => randomUUID(),
    getTopErrorModules(limit = 5) {
      return [...errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, limit))
        .map(([module, count]) => ({ module, count }));
    },
  };
}

module.exports = { createLogger };
