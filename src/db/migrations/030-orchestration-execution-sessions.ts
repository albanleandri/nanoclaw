import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration030: Migration = {
  version: 30,
  name: 'orchestration-execution-sessions',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE orchestration_step_attempts ADD COLUMN execution_session_id TEXT
        REFERENCES sessions(id) ON DELETE SET NULL;

      UPDATE orchestration_step_attempts
      SET execution_session_id = (
        SELECT session_id FROM orchestration_runs
        WHERE orchestration_runs.run_id = orchestration_step_attempts.run_id
      )
      WHERE kind = 'model';

      CREATE INDEX idx_orchestration_attempt_execution_session
        ON orchestration_step_attempts(execution_session_id, input_message_id);
    `);
  },
};
