import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration027: Migration = {
  version: 27,
  name: 'orchestration-runs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE orchestration_runs (
        run_id          TEXT PRIMARY KEY,
        plan_id         TEXT NOT NULL UNIQUE,
        task_id         TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        pattern_id      TEXT NOT NULL,
        pattern_version INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        plan_json       TEXT NOT NULL,
        usage_json      TEXT,
        created_at      TEXT NOT NULL,
        started_at      TEXT,
        finished_at     TEXT,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_orchestration_runs_scope
        ON orchestration_runs(agent_group_id, created_at);

      CREATE TABLE orchestration_step_attempts (
        attempt_id       TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
        step_id          TEXT NOT NULL,
        role_id          TEXT,
        kind             TEXT NOT NULL,
        attempt          INTEGER NOT NULL,
        status           TEXT NOT NULL CHECK (status IN (
          'queued','running','succeeded','failed','cancelled','needs_input'
        )),
        idempotency_key  TEXT NOT NULL UNIQUE,
        input_message_id TEXT,
        usage_json       TEXT,
        error_class      TEXT,
        error_message    TEXT,
        queued_at        TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT,
        UNIQUE(run_id, step_id, attempt)
      );
      CREATE INDEX idx_orchestration_attempt_input
        ON orchestration_step_attempts(input_message_id);

      CREATE TABLE orchestration_events (
        event_id    TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        event_type  TEXT NOT NULL,
        step_id     TEXT,
        attempt     INTEGER,
        data_json   TEXT,
        created_at  TEXT NOT NULL,
        UNIQUE(run_id, seq)
      );
    `);
  },
};
