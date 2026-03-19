function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildStars(n) {
  const v = clamp(Number(n) || 0, 1, 5);
  return '⭐'.repeat(v);
}

function safeSliceForSelect(list, reserved = 0) {
  return (list || []).slice(0, Math.max(0, 25 - reserved));
}

function parseCategories(input) {
  if (!input || !input.trim()) return null;

  const items = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25);

  const used = new Set();
  const out = [];

  for (const item of items) {
    const [labelRaw, descRaw] = item.split('|').map((x) => (x ?? '').trim());
    const label = (labelRaw || '').slice(0, 100);
    if (!label) continue;

    let value = label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    if (!value) value = 'cat';
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

module.exports = { clamp, buildStars, safeSliceForSelect, parseCategories };
