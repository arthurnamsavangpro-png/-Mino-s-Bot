function parseDurationToMs(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (['off', 'remove', 'none', '0', '0s', '0m', '0h', '0d', '0w'].includes(s)) return 0;

  const m = s.match(/^\s*(\d+)\s*([smhdw])\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n < 0) return null;

  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60 * 1000
        : unit === 'h'
          ? 60 * 60 * 1000
          : unit === 'd'
            ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
  return n * mult;
}

function formatDuration(ms) {
  if (ms == null) return 'N/A';
  if (ms === 0) return '0';
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

module.exports = { parseDurationToMs, formatDuration };
