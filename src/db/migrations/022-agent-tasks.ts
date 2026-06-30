import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'agent-tasks',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_tasks (
        job_id                     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        requester_agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        requester_session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        assignee_agent_group_id    TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        assignee_session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        parent_task_id             TEXT REFERENCES agent_tasks(job_id) ON DELETE SET NULL,
        scope                      TEXT NOT NULL CHECK (scope IN ('agent-delegation', 'plan-role')),
        orchestration_run_id       TEXT,
        orchestration_step_id      TEXT,
        role_id                    TEXT,
        dispatch_message_id        TEXT NOT NULL UNIQUE,
        cancel_message_id          TEXT NOT NULL UNIQUE,
        CHECK (
          (scope = 'agent-delegation' AND orchestration_run_id IS NULL
            AND orchestration_step_id IS NULL AND role_id IS NULL)
          OR
          (scope = 'plan-role' AND orchestration_run_id IS NOT NULL
            AND orchestration_step_id IS NOT NULL AND role_id IS NOT NULL)
        )
      );
      CREATE INDEX idx_agent_tasks_requester ON agent_tasks(requester_agent_group_id, job_id);
      CREATE INDEX idx_agent_tasks_assignee ON agent_tasks(assignee_agent_group_id, job_id);
      CREATE INDEX idx_agent_tasks_assignee_session ON agent_tasks(assignee_session_id);
    `);
  },
};
