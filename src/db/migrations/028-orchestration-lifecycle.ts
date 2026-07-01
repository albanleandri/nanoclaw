import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration028: Migration = {
  version: 28,
  name: 'orchestration-lifecycle',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE orchestration_runs ADD COLUMN cancel_requested_at TEXT;
      ALTER TABLE orchestration_runs ADD COLUMN cancel_reason TEXT;

      ALTER TABLE orchestration_step_attempts ADD COLUMN lease_owner TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN lease_expires_at TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN batch_id TEXT;

      CREATE INDEX idx_orchestration_attempt_lease
        ON orchestration_step_attempts(status, lease_expires_at);
      CREATE INDEX idx_orchestration_attempt_batch
        ON orchestration_step_attempts(batch_id);
      CREATE INDEX idx_orchestration_runs_status_updated
        ON orchestration_runs(status, updated_at);

      CREATE TABLE orchestration_session_authorizations (
        session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        agent_group_id    TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        capabilities_json TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      ALTER TABLE capability_audit_events ADD COLUMN orchestration_run_id TEXT
        REFERENCES orchestration_runs(run_id) ON DELETE SET NULL;
      CREATE INDEX idx_capability_audit_orchestration
        ON capability_audit_events(orchestration_run_id);
    `);
  },
};
