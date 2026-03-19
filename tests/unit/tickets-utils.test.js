const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCategories, buildStars, safeSliceForSelect } = require('../../utils/tickets');

test('parseCategories sanitizes and limits categories', () => {
  const parsed = parseCategories('Support|Aide, Recrutement|Staff');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].value, 'support');
});

test('buildStars clamps between 1 and 5', () => {
  assert.equal(buildStars(0), '⭐');
  assert.equal(buildStars(7), '⭐⭐⭐⭐⭐');
});

test('safeSliceForSelect enforces discord max options 25', () => {
  const list = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(safeSliceForSelect(list).length, 25);
  assert.equal(safeSliceForSelect(list, 3).length, 22);
});
