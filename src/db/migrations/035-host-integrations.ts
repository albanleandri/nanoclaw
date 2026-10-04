import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration035: Migration = {
  version: 35,
  name: 'host-integrations',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE integration_profiles (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL UNIQUE,
        adapter_id         TEXT NOT NULL,
        adapter_version    INTEGER NOT NULL CHECK (adapter_version > 0),
        config_json        TEXT NOT NULL,
        credential_backend TEXT NOT NULL CHECK (
          credential_backend IN ('local-file', 'systemd')
        ),
        credential_ref     TEXT NOT NULL,
        security_tier      TEXT NOT NULL CHECK (security_tier = 'trusted-host'),
        enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_integration_profiles_adapter
        ON integration_profiles(adapter_id, adapter_version, enabled);

      CREATE TABLE integration_profile_grants (
        profile_id       TEXT NOT NULL REFERENCES integration_profiles(id)
                         ON DELETE CASCADE,
        agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id)
                         ON DELETE CASCADE,
        operation        TEXT NOT NULL,
        granted_at       TEXT NOT NULL,
        PRIMARY KEY (profile_id, agent_group_id, operation)
      );
      CREATE INDEX idx_integration_profile_grants_group
        ON integration_profile_grants(agent_group_id, operation, profile_id);

      CREATE TABLE integration_invocations (
        id                 TEXT PRIMARY KEY,
        profile_id         TEXT REFERENCES integration_profiles(id)
                           ON DELETE SET NULL,
        profile_name       TEXT NOT NULL,
        adapter_id         TEXT NOT NULL,
        adapter_version    INTEGER NOT NULL,
        operation          TEXT NOT NULL,
        caller_type        TEXT NOT NULL CHECK (caller_type IN ('host', 'agent')),
        agent_group_id     TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        session_id         TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        status             TEXT NOT NULL CHECK (
          status IN ('running', 'succeeded', 'failed', 'interrupted')
        ),
        result_class       TEXT,
        duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        started_at         TEXT NOT NULL,
        finished_at        TEXT
      );
      CREATE INDEX idx_integration_invocations_profile_started
        ON integration_invocations(profile_id, started_at);
      CREATE INDEX idx_integration_invocations_status_started
        ON integration_invocations(status, started_at);
    `);
  },
};
