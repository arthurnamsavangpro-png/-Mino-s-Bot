function normalizeDomain(d) {
  let s = String(d || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.split('/')[0];
  s = s.split('?')[0];
  return s;
}

function extractDomainsFromText(text) {
  const t = String(text || '');
  const out = new Set();

  const urlRe = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const bareRe = /\b([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s<>()"]*)?/gi;

  const urls = t.match(urlRe) || [];
  for (const u of urls) {
    try {
      const host = new URL(u).hostname;
      const d = normalizeDomain(host);
      if (d) out.add(d);
    } catch {}
  }

  const bare = t.match(bareRe) || [];
  for (const b of bare) {
    const d = normalizeDomain(b);
    if (d && d.includes('.')) out.add(d);
  }

  if (/\bdiscord\.gg\/[a-z0-9]+/i.test(t) || /\bdiscord\.com\/invite\/[a-z0-9]+/i.test(t)) {
    out.add('discord.gg');
  }

  return Array.from(out);
}

module.exports = { normalizeDomain, extractDomainsFromText };
