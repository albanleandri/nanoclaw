import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import Database from 'better-sqlite3';

/**
 * Smoke tests for the q.ts sqlite-CLI replacement wrapper.
 *
 * Verifies the two modes (SELECT prints rows in sqlite3 default "list"
 * format; mutation runs via db.exec) and a few edge cases that real
 * skill invocations rely on.
 */

const Q = path.resolve(__dirname, 'q.ts');

describe('scripts/q.ts', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    const rootTmp = path.resolve(__dirname, '..', 'data', '.tmp');
    fs.mkdirSync(rootTmp, { recursive: true });
    tempDir = fs.mkdtempSync(path.join(rootTmp, 'q-test-'));
    dbPath = path.join(tempDir, 'test.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE t (id INTEGER, name TEXT, note TEXT);
      INSERT INTO t (id, name, note) VALUES (1, 'alice', 'hi'), (2, 'bob', NULL);
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    sql: string,
    readonly = false,
    options: { dbPath?: string; limit?: number } = {},
  ): { stdout: string; stderr: string; status: number } {
    const args = ['exec', 'tsx', Q];
    if (readonly) args.push('--readonly');
    if (options.limit !== undefined) args.push('--limit', String(options.limit));
    args.push(options.dbPath ?? dbPath, sql);
    const r = spawnSync('pnpm', args, {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
  }

  it('SELECT prints pipe-separated rows in default order', () => {
    const r = run('SELECT id, name FROM t ORDER BY id');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1|alice\n2|bob');
  });

  it('SELECT renders NULL as empty string (matches sqlite3 default mode)', () => {
    const r = run('SELECT id, note FROM t ORDER BY id');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1|hi\n2|');
  });

  it('SELECT with no rows prints nothing', () => {
    const r = run("SELECT id FROM t WHERE name = 'nobody'");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('readonly SELECT prints rows', () => {
    const r = run('SELECT name FROM t ORDER BY id', true);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('alice\nbob');
  });

  it('readonly rejects mutations', () => {
    const r = run("INSERT INTO t (id, name) VALUES (3, 'carol')", true);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/--readonly/);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT name FROM t WHERE id = 3').get();
    db.close();
    expect(row).toBeUndefined();
  });

  it('readonly rejects compound SQL', () => {
    const r = run('SELECT id FROM t; DELETE FROM t WHERE id = 1', true);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/compound SQL/);

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT count(*) AS n FROM t').get() as { n: number };
    db.close();
    expect(count.n).toBe(2);
  });

  it('readonly rejects writable CTEs', () => {
    const r = run(
      "WITH stale AS (SELECT id FROM t WHERE name = 'alice') DELETE FROM t WHERE id IN (SELECT id FROM stale)",
      true,
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/--readonly/);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT name FROM t ORDER BY id').all() as { name: string }[];
    db.close();
    expect(rows).toEqual([{ name: 'alice' }, { name: 'bob' }]);
  });

  it('readonly fails instead of creating a missing DB', () => {
    const missingDb = path.join(tempDir, 'missing.db');
    const r = spawnSync('pnpm', ['exec', 'tsx', Q, '--readonly', missingDb, 'SELECT 1'], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(missingDb)).toBe(false);
  });

  it('readonly rejects database paths outside approved repo DB directories', () => {
    const outsideDir = fs.mkdtempSync(path.join('/tmp', 'q-outside-'));
    try {
      const outsideDb = path.join(outsideDir, 'outside.db');
      const db = new Database(outsideDb);
      db.exec('CREATE TABLE outside_t (id INTEGER); INSERT INTO outside_t VALUES (1);');
      db.close();

      const r = run('SELECT id FROM outside_t', true, { dbPath: outsideDb });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/outside approved database directories/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('readonly rejects symlinks that escape approved repo DB directories', () => {
    const outsideDir = fs.mkdtempSync(path.join('/tmp', 'q-outside-'));
    try {
      const outsideDb = path.join(outsideDir, 'outside.db');
      const db = new Database(outsideDb);
      db.exec('CREATE TABLE outside_t (id INTEGER); INSERT INTO outside_t VALUES (1);');
      db.close();
      const linkPath = path.join(tempDir, 'linked-outside.db');
      fs.symlinkSync(outsideDb, linkPath);

      const r = run('SELECT id FROM outside_t', true, { dbPath: linkPath });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/outside approved database directories/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('readonly allows read-only PRAGMA table_info', () => {
    const r = run('PRAGMA table_info(t)', true);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0|id|INTEGER');
  });

  it('readonly rejects writable PRAGMA statements', () => {
    const r = run('PRAGMA user_version = 7', true);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/only allows SELECT, WITH, or read-only PRAGMA/);

    const db = new Database(dbPath, { readonly: true });
    const version = db.pragma('user_version', { simple: true });
    db.close();
    expect(version).toBe(0);
  });

  it('readonly caps output rows and asks for a narrower query', () => {
    const r = run('SELECT id FROM t ORDER BY id', true, { limit: 1 });
    expect(r.status).toBe(4);
    expect(r.stdout.trim()).toBe('1');
    expect(r.stderr).toMatch(/returned more than 1 rows/);
  });

  it('INSERT runs via db.exec and persists', () => {
    const r = run("INSERT INTO t (id, name) VALUES (3, 'carol')");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT name FROM t WHERE id = 3').get() as { name: string };
    db.close();
    expect(row.name).toBe('carol');
  });

  it('compound mutation statements execute together', () => {
    const r = run("DELETE FROM t WHERE id = 1; INSERT INTO t (id, name) VALUES (9, 'zed');");
    expect(r.status).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const ids = (db.prepare('SELECT id FROM t ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    db.close();
    expect(ids).toEqual([2, 9]);
  });

  it('WITH...DELETE is treated as a mutation, not a query', () => {
    const r = run(
      "WITH stale AS (SELECT id FROM t WHERE name = 'alice') DELETE FROM t WHERE id IN (SELECT id FROM stale)",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT name FROM t').all() as { name: string }[];
    db.close();
    expect(rows).toEqual([{ name: 'bob' }]);
  });

  it('exits 2 with usage when args are missing', () => {
    const r = spawnSync('pnpm', ['exec', 'tsx', Q], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage/);
  });
});
