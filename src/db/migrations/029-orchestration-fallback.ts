import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration029: Migration = {
  version: 29,
  name: 'orchestration-fallback-facts',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE orchestration_step_attempts ADD COLUMN runtime_id TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN endpoint_profile_id TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN protocol TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN continuation_semantics TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN capability_fingerprint TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN tool_schema_fingerprint TEXT;
      ALTER TABLE orchestration_step_attempts ADD COLUMN input_reconstructable INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orchestration_step_attempts ADD COLUMN side_effect_boundary_crossed INTEGER;
      ALTER TABLE orchestration_step_attempts ADD COLUMN result_emitted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orchestration_step_attempts ADD COLUMN artifact_emitted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orchestration_step_attempts ADD COLUMN delivery_emitted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orchestration_step_attempts ADD COLUMN error_retryable INTEGER;

      CREATE TABLE orchestration_fallback_decisions (
        decision_id       TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
        step_id           TEXT NOT NULL,
        source_attempt    INTEGER NOT NULL,
        candidate_id      TEXT NOT NULL,
        policy_version    TEXT NOT NULL,
        allowed           INTEGER NOT NULL,
        reasons_json      TEXT NOT NULL,
        candidate_json    TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        UNIQUE(run_id, step_id, source_attempt, candidate_id, policy_version)
      );
      CREATE INDEX idx_orchestration_fallback_run
        ON orchestration_fallback_decisions(run_id, step_id, source_attempt);
    `);
  },
};
