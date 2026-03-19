const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDurationToMs, formatDuration } = require('../../utils/duration');

test('parseDurationToMs parse formats', () => {
  assert.equal(parseDurationToMs('10m'), 10 * 60 * 1000);
  assert.equal(parseDurationToMs('2 h'), 2 * 60 * 60 * 1000);
  assert.equal(parseDurationToMs('0'), 0);
  assert.equal(parseDurationToMs('invalid'), null);
});

test('formatDuration formatting', () => {
  assert.equal(formatDuration(null), 'N/A');
  assert.equal(formatDuration(0), '0');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(10 * 60 * 1000), '10m');
});
