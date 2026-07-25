import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration033: Migration = {
  version: 33,
  name: 'agent-group-memory-control',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_group_memory_control (
        agent_group_id          TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        mode                    TEXT NOT NULL DEFAULT 'disabled'
                                CHECK (mode IN ('disabled','shadow','active')),
        migration_state         TEXT NOT NULL DEFAULT 'none'
                                CHECK (migration_state IN ('none','staging','validated','migrated')),
        writer_session_id       TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
        maintenance_fence_owner TEXT,
        maintenance_fence_token TEXT,
        maintenance_fenced_at   TEXT,
        version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        last_transition_at      TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        CHECK (
          (mode = 'disabled' AND migration_state = 'none') OR
          (mode = 'shadow' AND migration_state IN ('staging','validated')) OR
          (mode = 'active' AND migration_state = 'migrated')
        ),
        CHECK (mode <> 'active' OR writer_session_id IS NOT NULL),
        CHECK (
          (maintenance_fence_owner IS NULL AND maintenance_fence_token IS NULL AND maintenance_fenced_at IS NULL) OR
          (maintenance_fence_owner IS NOT NULL AND maintenance_fence_token IS NOT NULL AND maintenance_fenced_at IS NOT NULL)
        )
      );

      INSERT INTO agent_group_memory_control (
        agent_group_id, mode, migration_state, version, last_transition_at, updated_at
      )
      SELECT id, 'disabled', 'none', 1, created_at, created_at
      FROM agent_groups;

      CREATE TRIGGER agent_group_memory_control_create
      AFTER INSERT ON agent_groups
      BEGIN
        INSERT INTO agent_group_memory_control (
          agent_group_id, mode, migration_state, writer_session_id, version, last_transition_at, updated_at
        ) VALUES (NEW.id, 'disabled', 'none', NULL, 1, NEW.created_at, NEW.created_at);
      END;

      CREATE TRIGGER agent_group_memory_writer_scope_insert
      BEFORE INSERT ON agent_group_memory_control
      WHEN NEW.writer_session_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE id = NEW.writer_session_id
           AND agent_group_id = NEW.agent_group_id
       )
      BEGIN
        SELECT RAISE(ABORT, 'memory writer session must belong to agent group');
      END;

      CREATE TRIGGER agent_group_memory_writer_scope_update
      BEFORE UPDATE OF writer_session_id, agent_group_id ON agent_group_memory_control
      WHEN NEW.writer_session_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE id = NEW.writer_session_id
           AND agent_group_id = NEW.agent_group_id
       )
      BEGIN
        SELECT RAISE(ABORT, 'memory writer session must belong to agent group');
      END;
    `);
  },
};
