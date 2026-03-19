const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDomain, extractDomainsFromText } = require('../../utils/domain');

test('normalizeDomain strips protocol and www', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
});

test('extractDomainsFromText finds urls and invite', () => {
  const values = extractDomainsFromText('go https://foo.bar/a and discord.gg/abc now');
  assert.ok(values.includes('foo.bar'));
  assert.ok(values.includes('discord.gg'));
});
