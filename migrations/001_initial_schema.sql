/* --- vouches --- */
    CREATE TABLE IF NOT EXISTS vouches (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      voucher_id TEXT NOT NULL,
      vouched_id TEXT NOT NULL,
      message TEXT NOT NULL,
      rating SMALLINT NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vouches_guild_vouched ON vouches (guild_id, vouched_id);
    CREATE INDEX IF NOT EXISTS idx_vouches_guild_voucher_vouched ON vouches (guild_id, voucher_id, vouched_id);

    CREATE TABLE IF NOT EXISTS vouchboard (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      limit_count INTEGER NOT NULL DEFAULT 10,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vouch_settings (
      guild_id TEXT PRIMARY KEY,
      vouch_channel_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* --- rankup (vouch) --- */
    CREATE TABLE IF NOT EXISTS rank_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      required_vouches INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rank_roles_guild_required ON rank_roles (guild_id, required_vouches);

    /* --- modrank --- */
    CREATE TABLE IF NOT EXISTS modrank_settings (
      guild_id TEXT PRIMARY KEY,
      announce_channel_id TEXT,
      log_channel_id TEXT,
      dm_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ping_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode TEXT NOT NULL DEFAULT 'highest',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS modrank_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_modrank_roles_guild_position ON modrank_roles (guild_id, position);

    CREATE TABLE IF NOT EXISTS modrank_counters (
      guild_id TEXT PRIMARY KEY,
      last_ref BIGINT NOT NULL DEFAULT 0
    );

    /* --- tickets --- */
    CREATE TABLE IF NOT EXISTS ticket_settings (
      guild_id TEXT PRIMARY KEY,
      category_id TEXT,
      staff_role_id TEXT,
      admin_feedback_channel_id TEXT,
      transcript_channel_id TEXT,
      max_open_per_user INTEGER NOT NULL DEFAULT 1,
      cooldown_seconds INTEGER NOT NULL DEFAULT 600,
      claim_exclusive BOOLEAN NOT NULL DEFAULT FALSE,
      delete_on_close BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticket_panels (
      panel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      categories JSONB,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_panels_guild ON ticket_panels (guild_id);

    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      opener_id TEXT NOT NULL,
      category_label TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_channel_unique ON tickets (channel_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_guild_opener_status ON tickets (guild_id, opener_id, status);
    CREATE INDEX IF NOT EXISTS idx_tickets_guild_created ON tickets (guild_id, created_at);

    CREATE TABLE IF NOT EXISTS ticket_feedback (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      opener_id TEXT NOT NULL,
      claimed_by TEXT,
      rating SMALLINT NOT NULL,
      comment TEXT,
      log_channel_id TEXT,
      log_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_feedback_guild_created ON ticket_feedback (guild_id, created_at);

    CREATE TABLE IF NOT EXISTS ticket_transcripts (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* --- giveaways --- */
    CREATE TABLE IF NOT EXISTS giveaways (
      giveaway_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      prize TEXT NOT NULL,
      host_id TEXT NOT NULL,
      winner_count INTEGER NOT NULL DEFAULT 1,
      end_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
      winners JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_giveaways_guild_status_endat ON giveaways (guild_id, status, end_at);

    CREATE TABLE IF NOT EXISTS giveaway_entries (
      giveaway_id TEXT NOT NULL REFERENCES giveaways(giveaway_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entries INTEGER NOT NULL DEFAULT 1,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (giveaway_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_giveaway_entries_guild_user ON giveaway_entries (guild_id, user_id);

    /* --- moderation --- */
    CREATE TABLE IF NOT EXISTS mod_settings (
      guild_id TEXT PRIMARY KEY,
      modlog_channel_id TEXT,
      staff_role_id TEXT,
      log_events JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autorole_settings (
      guild_id TEXT PRIMARY KEY,
      role_id TEXT,
      role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE autorole_settings ADD COLUMN IF NOT EXISTS role_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    UPDATE autorole_settings
    SET role_ids = jsonb_build_array(role_id)
    WHERE role_id IS NOT NULL
      AND (role_ids IS NULL OR role_ids = '[]'::jsonb);
    CREATE TABLE IF NOT EXISTS keyword_role_rules (
      guild_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      role_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'both' CHECK (source IN ('status', 'bio', 'both')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, keyword, role_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_keyword_role_rules_guild ON keyword_role_rules (guild_id);
    CREATE TABLE IF NOT EXISTS mod_case_counters (
      guild_id TEXT PRIMARY KEY,
      last_case BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mod_cases (
      guild_id TEXT NOT NULL,
      case_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT,
      target_tag TEXT,
      moderator_id TEXT,
      moderator_tag TEXT,
      reason TEXT,
      duration_ms BIGINT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      log_channel_id TEXT,
      log_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, case_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_target_created ON mod_cases (guild_id, target_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_created ON mod_cases (guild_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_action_created ON mod_cases (guild_id, action, created_at DESC);

    /* ✅ automod */
    CREATE TABLE IF NOT EXISTS automod_settings (
      guild_id TEXT PRIMARY KEY,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* ✅ updates / broadcast */
    CREATE TABLE IF NOT EXISTS updates_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* ✅ absence staff */
    CREATE TABLE IF NOT EXISTS absence_settings (
      guild_id TEXT PRIMARY KEY,
      staff_role_id TEXT,
      admin_role_id TEXT,
      absence_role_id TEXT,
      log_channel_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff_absences (
      absence_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      decision_reason TEXT,
      ended_at TIMESTAMPTZ,
      log_channel_id TEXT,
      log_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE staff_absences ADD COLUMN IF NOT EXISTS log_channel_id TEXT;
    ALTER TABLE staff_absences ADD COLUMN IF NOT EXISTS log_message_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_staff_absences_guild_user_status ON staff_absences (guild_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_staff_absences_guild_status_end ON staff_absences (guild_id, status, end_at);

    /* --- invitations --- */
    CREATE TABLE IF NOT EXISTS invite_settings (
      guild_id TEXT PRIMARY KEY,
      log_channel_id TEXT,
      announce_channel_id TEXT,
      fake_min_account_days INTEGER NOT NULL DEFAULT 7,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE invite_settings ADD COLUMN IF NOT EXISTS announce_channel_id TEXT;

    CREATE TABLE IF NOT EXISTS invite_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      regular INTEGER NOT NULL DEFAULT 0,
      fake INTEGER NOT NULL DEFAULT 0,
      left_count INTEGER NOT NULL DEFAULT 0,
      bonus INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_invite_stats_guild_total ON invite_stats (guild_id, total DESC);

    CREATE TABLE IF NOT EXISTS invite_joins (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      inviter_id TEXT,
      invite_code TEXT,
      is_fake BOOLEAN NOT NULL DEFAULT FALSE,
      is_ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'joined',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at TIMESTAMPTZ,
      PRIMARY KEY (guild_id, user_id)
    );
    ALTER TABLE invite_joins ADD COLUMN IF NOT EXISTS is_ambiguous BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_invite_joins_guild_inviter ON invite_joins (guild_id, inviter_id);

    CREATE TABLE IF NOT EXISTS invite_rewards (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      required_invites INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_invite_rewards_guild_required ON invite_rewards (guild_id, required_invites);

    /* --- welcome --- */
    CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      message_template TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* --- server stats vocaux --- */
    CREATE TABLE IF NOT EXISTS server_stats_settings (
      guild_id TEXT PRIMARY KEY,
      category_id TEXT,
      members_channel_id TEXT,
      bots_channel_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /* ✅ WorL */
    CREATE TABLE IF NOT EXISTS worl_polls (
      poll_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'trade',
      trade_text TEXT NOT NULL,
      contre_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_worl_polls_guild_status ON worl_polls (guild_id, status);

    CREATE TABLE IF NOT EXISTS worl_votes (
      poll_id TEXT NOT NULL REFERENCES worl_polls(poll_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('W','L')),
      voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (poll_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worl_votes_poll ON worl_votes (poll_id);
