import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'shared-resources',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN shared_resources TEXT NOT NULL DEFAULT '[]'").run();
  },
};
