import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'provider-tool-verification',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE provider_profiles ADD COLUMN tool_verified_at TEXT;
      ALTER TABLE provider_profiles ADD COLUMN tool_verification_fingerprint TEXT;
    `);
  },
};
