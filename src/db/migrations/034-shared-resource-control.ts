import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration034: Migration = {
  version: 34,
  name: 'shared-resource-control',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE shared_resource_control (
        resource_name TEXT PRIMARY KEY,
        owner_agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE RESTRICT,
        reconciliation_state TEXT NOT NULL DEFAULT 'pilot'
          CHECK (reconciliation_state IN ('pilot','reconciling','validated','reconciled')),
        classification_report_path TEXT,
        classification_report_sha256 TEXT,
        validation_report_json TEXT,
        approved_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        CHECK (
          reconciliation_state != 'reconciled'
          OR (owner_agent_group_id IS NOT NULL AND approved_at IS NOT NULL)
        )
      );
      CREATE INDEX idx_shared_resource_owner
        ON shared_resource_control(owner_agent_group_id);
    `);
  },
};
