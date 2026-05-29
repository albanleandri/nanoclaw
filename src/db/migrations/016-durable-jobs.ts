import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'durable-jobs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE jobs (
        id                 TEXT PRIMARY KEY,
        type               TEXT NOT NULL,
        status             TEXT NOT NULL,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id         TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        messaging_group_id TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
        channel_type       TEXT,
        platform_id        TEXT,
        thread_id          TEXT,
        requested_by       TEXT,
        params_json        TEXT NOT NULL,
        result_json        TEXT,
        error              TEXT,
        progress_current   INTEGER,
        progress_total     INTEGER,
        started_at         TEXT,
        finished_at        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_status_updated ON jobs(status, updated_at);
      CREATE INDEX idx_jobs_agent_group_created ON jobs(agent_group_id, created_at);

      CREATE TABLE job_events (
        id         TEXT PRIMARY KEY,
        job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        level      TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message    TEXT,
        data_json  TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(job_id, seq)
      );
      CREATE INDEX idx_job_events_job_seq ON job_events(job_id, seq);

      CREATE TABLE job_deliveries (
        job_id              TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        event_seq           INTEGER NOT NULL,
        message_out_id      TEXT,
        platform_message_id TEXT,
        delivered_at        TEXT NOT NULL,
        PRIMARY KEY (job_id, event_seq)
      );
    `);
  },
};
