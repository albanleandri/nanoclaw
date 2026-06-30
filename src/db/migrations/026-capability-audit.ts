import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration026: Migration = {
  version: 26,
  name: 'capability-audit',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE capability_audit_events (
        event_id        TEXT PRIMARY KEY,
        invocation_id   TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        event_type      TEXT NOT NULL CHECK (event_type IN (
          'requested', 'authorized', 'denied', 'started',
          'succeeded', 'failed', 'cancelled'
        )),
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        runtime_id      TEXT,
        capability_id   TEXT NOT NULL,
        capability_version INTEGER NOT NULL,
        adapter         TEXT NOT NULL,
        entrypoint      TEXT NOT NULL,
        args_sha256     TEXT NOT NULL,
        decision        TEXT,
        result_class    TEXT,
        duration_ms     INTEGER,
        usage_json      TEXT,
        created_at      TEXT NOT NULL,
        UNIQUE(invocation_id, seq)
      );
      CREATE INDEX idx_capability_audit_scope
        ON capability_audit_events(agent_group_id, created_at);
      CREATE INDEX idx_capability_audit_capability
        ON capability_audit_events(capability_id, created_at);
    `);
  },
};
