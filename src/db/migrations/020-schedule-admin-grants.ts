import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'schedule-admin-grants',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE schedule_admin_grants (
        admin_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        owner_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        created_by TEXT,
        PRIMARY KEY (admin_agent_group_id, owner_agent_group_id),
        CHECK (admin_agent_group_id <> owner_agent_group_id)
      );
      CREATE INDEX idx_schedule_admin_grants_owner
        ON schedule_admin_grants(owner_agent_group_id);
    `);
  },
};
