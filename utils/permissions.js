const { PermissionsBitField } = require('discord.js');

function isAdminLike(interactionOrMember) {
  const perms = interactionOrMember?.memberPermissions || interactionOrMember?.permissions;
  return perms?.has?.(PermissionsBitField.Flags.Administrator) || false;
}

function hasPerm(interactionOrMember, perm) {
  const perms = interactionOrMember?.memberPermissions || interactionOrMember?.permissions;
  return perms?.has?.(perm) || false;
}

function hasAnyPermission(interaction, perms) {
  if (!interaction?.memberPermissions) return false;
  return interaction.memberPermissions.has(perms);
}

module.exports = { isAdminLike, hasPerm, hasAnyPermission };
