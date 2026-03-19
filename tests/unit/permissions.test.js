const test = require('node:test');
const assert = require('node:assert/strict');
const { hasAnyPermission, hasPerm } = require('../../utils/permissions');

test('hasAnyPermission delegates to memberPermissions', () => {
  const interaction = { memberPermissions: { has: (input) => input === 'X' } };
  assert.equal(hasAnyPermission(interaction, 'X'), true);
  assert.equal(hasAnyPermission(interaction, 'Y'), false);
});

test('hasPerm supports permissions field', () => {
  const member = { permissions: { has: (input) => input === 'MANAGE_MESSAGES' } };
  assert.equal(hasPerm(member, 'MANAGE_MESSAGES'), true);
  assert.equal(hasPerm(member, 'BAN_MEMBERS'), false);
});
