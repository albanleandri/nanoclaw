// Regression for upstream 1d5179b2: the pending list is chosen before any
// write lock is held, so a second migrator (another host process, or `ncl`
// run against the same central.db) could finish a migration in between and
// this caller would then re-run its up() on an already-migrated schema.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import { migrations, runMigrations } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('concurrent SQLite migrations', () => {
  it.each([
    ['fresh database', 0],
    ['existing database with pending migrations', migrations.length - 1],
  ])('does not reapply a migration completed by another connection: %s', (_name, appliedCount) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migrations-'));
    const databasePath = path.join(directory, 'central.db');
    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    const other = new Database(databasePath);

    try {
      runMigrations(db, migrations.slice(0, appliedCount));
      const applied: unknown[] = [];
      let inOther = false;
      vi.spyOn(log, 'info').mockImplementation((message, data) => {
        if (!inOther && message === 'Migration applied') applied.push(data);
      });
      const prepare = db.prepare.bind(db);
      let otherRan = false;

      vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        const stmt = prepare(sql);
        if (sql !== 'SELECT name FROM schema_version' || otherRan) return stmt;
        // Let this caller read its applied-migration snapshot, then have the
        // other connection finish all pending work before it resumes.
        const all = stmt.all.bind(stmt);
        return Object.assign(Object.create(stmt), {
          all: (...params: unknown[]) => {
            const rows = all(...params);
            otherRan = true;
            inOther = true;
            try {
              runMigrations(other);
            } finally {
              inOther = false;
            }
            return rows;
          },
        });
      }) as typeof db.prepare);

      runMigrations(db);

      expect(otherRan).toBe(true);
      expect(prepare('SELECT name FROM schema_version ORDER BY version').all()).toEqual(
        migrations.map(({ name }) => ({ name })),
      );
      expect(applied).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      other.close();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
