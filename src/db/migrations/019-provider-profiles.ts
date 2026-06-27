import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'provider-profiles',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE provider_profiles (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL UNIQUE,
        provider_name        TEXT NOT NULL,
        protocol             TEXT NOT NULL,
        base_url             TEXT,
        api_family           TEXT,
        tool_strategy        TEXT NOT NULL DEFAULT 'none',
        default_model        TEXT,
        default_effort       TEXT,
        auth_mode            TEXT NOT NULL,
        auth_ref             TEXT,
        capability_overrides TEXT NOT NULL DEFAULT '{}',
        allow_insecure_http  INTEGER NOT NULL DEFAULT 0,
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX idx_provider_profiles_provider_name
        ON provider_profiles(provider_name);

      ALTER TABLE container_configs ADD COLUMN provider_profile_id TEXT
        REFERENCES provider_profiles(id) ON DELETE SET NULL;
      ALTER TABLE sessions ADD COLUMN provider_profile_id TEXT
        REFERENCES provider_profiles(id) ON DELETE SET NULL;
    `);
  },
};
