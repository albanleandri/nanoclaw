import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration024: Migration = {
  version: 24,
  name: 'session-search',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE session_search_documents (
        id              INTEGER PRIMARY KEY,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_kind     TEXT NOT NULL CHECK (source_kind IN ('inbound', 'outbound')),
        message_id      TEXT NOT NULL,
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        source_timestamp TEXT NOT NULL,
        content         TEXT NOT NULL,
        UNIQUE(session_id, source_kind, message_id)
      );
      CREATE INDEX idx_session_search_scope
        ON session_search_documents(agent_group_id, source_timestamp);

      CREATE VIRTUAL TABLE session_search_fts USING fts5(
        content,
        content='session_search_documents',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER session_search_ai AFTER INSERT ON session_search_documents BEGIN
        INSERT INTO session_search_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER session_search_ad AFTER DELETE ON session_search_documents BEGIN
        INSERT INTO session_search_fts(session_search_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER session_search_au AFTER UPDATE ON session_search_documents BEGIN
        INSERT INTO session_search_fts(session_search_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        INSERT INTO session_search_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  },
};
