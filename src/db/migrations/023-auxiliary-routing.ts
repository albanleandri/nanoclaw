import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'auxiliary-routing',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE auxiliary_routes (
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        role                 TEXT NOT NULL CHECK (role IN (
          'context-compression', 'memory-extraction', 'vision',
          'classification', 'review', 'reference-analysis'
        )),
        target_kind          TEXT NOT NULL CHECK (target_kind IN (
          'main', 'endpoint-profile', 'agent', 'disabled'
        )),
        provider_profile_id  TEXT REFERENCES provider_profiles(id) ON DELETE CASCADE,
        target_agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE CASCADE,
        model                TEXT,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, role),
        CHECK (
          (target_kind = 'main' AND provider_profile_id IS NULL
            AND target_agent_group_id IS NULL AND model IS NULL)
          OR
          (target_kind = 'endpoint-profile' AND provider_profile_id IS NOT NULL
            AND target_agent_group_id IS NULL)
          OR
          (target_kind = 'agent' AND provider_profile_id IS NULL
            AND target_agent_group_id IS NOT NULL AND model IS NULL)
          OR
          (target_kind = 'disabled' AND provider_profile_id IS NULL
            AND target_agent_group_id IS NULL AND model IS NULL)
        )
      );

      CREATE TABLE auxiliary_invocations (
        job_id                 TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        role                   TEXT NOT NULL,
        target_kind            TEXT NOT NULL,
        provider_profile_id    TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
        target_agent_group_id  TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        target_model           TEXT,
        runtime_id             TEXT,
        isolated_session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        usage_json             TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX idx_auxiliary_invocations_target
        ON auxiliary_invocations(target_agent_group_id, created_at);
    `);
  },
};
