import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'screen-market-guided',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE screen_market_wizards (
        id                 TEXT PRIMARY KEY,
        status             TEXT NOT NULL,
        step               TEXT NOT NULL,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        messaging_group_id TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
        channel_type       TEXT NOT NULL,
        platform_id        TEXT NOT NULL,
        thread_id          TEXT,
        requested_by       TEXT,
        answers_json       TEXT NOT NULL DEFAULT '{}',
        preview_json       TEXT,
        job_id             TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        expires_at         TEXT NOT NULL
      );
      CREATE INDEX idx_screen_market_wizards_origin
        ON screen_market_wizards(channel_type, platform_id, thread_id, status);
      CREATE INDEX idx_screen_market_wizards_expiry
        ON screen_market_wizards(status, expires_at);

      CREATE TABLE screen_market_wizard_questions (
        question_id TEXT PRIMARY KEY,
        wizard_id   TEXT NOT NULL REFERENCES screen_market_wizards(id) ON DELETE CASCADE,
        step        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_screen_market_wizard_questions_wizard
        ON screen_market_wizard_questions(wizard_id, step);

      CREATE TABLE pending_host_questions (
        question_id  TEXT PRIMARY KEY,
        owner_type   TEXT NOT NULL,
        owner_id     TEXT NOT NULL,
        title        TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_pending_host_questions_owner
        ON pending_host_questions(owner_type, owner_id);
    `);
  },
};
