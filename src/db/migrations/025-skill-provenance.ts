import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'skill-provenance',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE skill_installations (
        name            TEXT PRIMARY KEY,
        source_kind     TEXT NOT NULL CHECK (source_kind IN ('builtin', 'private-submodule', 'local')),
        source_id       TEXT NOT NULL,
        manifest_version TEXT NOT NULL,
        approved_hash   TEXT,
        observed_hash   TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('active', 'drifted', 'quarantined', 'disabled')),
        approved_by     TEXT,
        approved_at     TEXT,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE skill_provenance_events (
        id          TEXT PRIMARY KEY,
        skill_name  TEXT NOT NULL,
        event_type  TEXT NOT NULL CHECK (event_type IN ('observed', 'approved', 'drifted', 'quarantined', 'disabled')),
        content_hash TEXT NOT NULL,
        actor       TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_skill_provenance_events_name
        ON skill_provenance_events(skill_name, created_at);
    `);
  },
};
