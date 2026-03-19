function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createTicketSettingsRepository({ pool, config }) {
  const DEFAULT_SETTINGS = {
    category_id: config.TICKET_CATEGORY_ID || null,
    staff_role_id: config.TICKET_STAFF_ROLE_ID || null,
    staff_role_ids: config.TICKET_STAFF_ROLE_ID ? [config.TICKET_STAFF_ROLE_ID] : [],
    admin_feedback_channel_id: config.ADMIN_FEEDBACK_CHANNEL_ID || null,
    transcript_channel_id: config.TICKET_TRANSCRIPT_CHANNEL_ID || null,
    max_open_per_user: Number(config.TICKET_MAX_OPEN_PER_USER || 1),
    cooldown_seconds: Number(config.TICKET_COOLDOWN_SECONDS || 600),
    claim_exclusive: Boolean(config.TICKET_CLAIM_EXCLUSIVE),
    delete_on_close: Boolean(config.TICKET_DELETE_ON_CLOSE),
  };

  let ensuredExtraCols = false;
  async function ensureExtraColumns() {
    if (ensuredExtraCols) return;
    ensuredExtraCols = true;
    try {
      await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS subject TEXT;`);
      await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS details TEXT;`);
      await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_helpers TEXT[];`);
    } catch (error) {
      console.warn(`[tickets] ensureExtraColumns failed: ${error?.message || error}`);
    }
  }

  let ensuredSettingsCols = false;
  async function ensureSettingsColumns() {
    if (ensuredSettingsCols) return;
    ensuredSettingsCols = true;
    try {
      await pool.query(`ALTER TABLE ticket_settings ADD COLUMN IF NOT EXISTS staff_role_ids TEXT[];`);
    } catch (error) {
      console.warn(`[tickets] ensureSettingsColumns failed: ${error?.message || error}`);
    }
  }

  function uniqueRoleIds(list) {
    return Array.from(new Set((list || []).filter((id) => typeof id === "string" && /^\d{17,20}$/.test(id))));
  }

  function getStaffRoleIds(settings) {
    const fromArray = uniqueRoleIds(settings?.staff_role_ids);
    if (fromArray.length) return fromArray;
    if (settings?.staff_role_id && /^\d{17,20}$/.test(settings.staff_role_id)) return [settings.staff_role_id];
    return [];
  }

  function formatStaffRolesMention(settings) {
    const ids = getStaffRoleIds(settings);
    if (!ids.length) return "—";
    return ids.map((id) => `<@&${id}>`).join(", ");
  }

  async function getSettings(guildId) {
    await ensureSettingsColumns();
    const res = await pool.query(
      `SELECT category_id, staff_role_id, staff_role_ids, admin_feedback_channel_id, transcript_channel_id,
              max_open_per_user, cooldown_seconds, claim_exclusive, delete_on_close
       FROM ticket_settings WHERE guild_id=$1 LIMIT 1`,
      [guildId]
    );
    const row = res.rows[0] || {};
    const merged = { ...DEFAULT_SETTINGS };

    for (const k of Object.keys(merged)) {
      if (row[k] !== null && row[k] !== undefined) merged[k] = row[k];
    }

    merged.max_open_per_user = clampNumber(Number(merged.max_open_per_user || 1), 1, 5);
    merged.cooldown_seconds = clampNumber(Number(merged.cooldown_seconds || 0), 0, 86400);
    merged.staff_role_ids = getStaffRoleIds(merged);
    merged.staff_role_id = merged.staff_role_ids[0] || null;
    return merged;
  }

  async function upsertSettings(guildId, patch) {
    await ensureSettingsColumns();
    const cur = await getSettings(guildId);
    const next = { ...cur, ...patch };

    next.staff_role_ids = getStaffRoleIds(next);
    next.staff_role_id = next.staff_role_ids[0] || null;

    await pool.query(
      `INSERT INTO ticket_settings
        (guild_id, category_id, staff_role_id, staff_role_ids, admin_feedback_channel_id, transcript_channel_id,
         max_open_per_user, cooldown_seconds, claim_exclusive, delete_on_close)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (guild_id) DO UPDATE SET
         category_id=EXCLUDED.category_id,
         staff_role_id=EXCLUDED.staff_role_id,
         staff_role_ids=EXCLUDED.staff_role_ids,
         admin_feedback_channel_id=EXCLUDED.admin_feedback_channel_id,
         transcript_channel_id=EXCLUDED.transcript_channel_id,
         max_open_per_user=EXCLUDED.max_open_per_user,
         cooldown_seconds=EXCLUDED.cooldown_seconds,
         claim_exclusive=EXCLUDED.claim_exclusive,
         delete_on_close=EXCLUDED.delete_on_close,
         updated_at=NOW()`,
      [
        guildId,
        next.category_id,
        next.staff_role_id,
        next.staff_role_ids,
        next.admin_feedback_channel_id,
        next.transcript_channel_id,
        next.max_open_per_user,
        next.cooldown_seconds,
        next.claim_exclusive,
        next.delete_on_close,
      ]
    );
    return next;
  }

  return {
    ensureExtraColumns,
    getSettings,
    upsertSettings,
    getStaffRoleIds,
    formatStaffRolesMention,
  };
}

module.exports = { createTicketSettingsRepository };
