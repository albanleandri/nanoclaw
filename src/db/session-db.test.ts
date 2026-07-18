/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  countDueMessages,
  getInboundSourceSessionId,
  getOldestDuePendingTimestamp,
  migrateMessagesInTable,
  markDelivered,
  markDeliveryFailed,
  retryWithBackoff,
  syncProcessingAcks,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');
    expect(cols).toContain('orchestration_run_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(
      (
        db.prepare('SELECT orchestration_run_id FROM messages_in WHERE id = ?').get('legacy-2') as {
          orchestration_run_id: string | null;
        }
      ).orchestration_run_id,
    ).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

function makeDueMessageDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      content       TEXT NOT NULL
    );
  `);
  return db;
}

describe('due trigger queries', () => {
  it('ignores pending system tool responses for wake and pending-stuck calculations', () => {
    const db = makeDueMessageDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES ('qr-old', 2, 'system', '2026-05-29T19:01:27.759Z', 'pending', 1, '{}')`,
    ).run();

    expect(countDueMessages(db)).toBe(0);
    expect(getOldestDuePendingTimestamp(db)).toBeNull();
    db.close();
  });

  it('still counts normal due trigger messages', () => {
    const db = makeDueMessageDb();
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content) VALUES ('chat-1', 2, 'chat', '2026-05-30T07:57:05.000Z', 'pending', 1, '{}')",
    ).run();

    expect(countDueMessages(db)).toBe(1);
    expect(getOldestDuePendingTimestamp(db)).toBe('2026-05-30T07:57:05.000Z');
    db.close();
  });

  it('ages due scheduled messages from process_after instead of creation timestamp', () => {
    const db = makeDueMessageDb();
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, trigger, content) VALUES ('task-1', 2, 'task', '2026-06-03 20:51:07', 'pending', datetime('now', '-2 minutes'), 1, '{}')",
    ).run();

    const row = db.prepare("SELECT process_after AS processAfter FROM messages_in WHERE id = 'task-1'").get() as {
      processAfter: string;
    };
    expect(countDueMessages(db)).toBe(1);
    expect(getOldestDuePendingTimestamp(db)).toBe(row.processAfter);
    db.close();
  });
});

describe('syncProcessingAcks', () => {
  it('preserves completed and failed terminal outcomes', () => {
    const inDb = makeDueMessageDb();
    const outDb = new Database(':memory:');
    outDb.exec(`
      CREATE TABLE processing_ack (
        message_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        status_changed TEXT NOT NULL
      );
    `);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, ?, 'chat', datetime('now'), 'pending', 1, '{}')`,
      )
      .run('completed-message', 2);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, ?, 'chat', datetime('now'), 'pending', 1, '{}')`,
      )
      .run('failed-message', 4);
    outDb.prepare("INSERT INTO processing_ack VALUES (?, 'completed', datetime('now'))").run('completed-message');
    outDb.prepare("INSERT INTO processing_ack VALUES (?, 'failed', datetime('now'))").run('failed-message');

    syncProcessingAcks(inDb, outDb);

    expect(inDb.prepare('SELECT id, status FROM messages_in ORDER BY seq').all()).toEqual([
      { id: 'completed-message', status: 'completed' },
      { id: 'failed-message', status: 'failed' },
    ]);
    inDb.close();
    outDb.close();
  });
});

describe('runtime timestamp storage', () => {
  it('stores retry deadlines as ISO UTC instants', () => {
    const db = makeDueMessageDb();
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content) VALUES ('retry-1', 2, 'chat', ?, 'pending', 1, '{}')",
    ).run(new Date().toISOString());

    retryWithBackoff(db, 'retry-1', 30);

    const row = db.prepare("SELECT tries, process_after FROM messages_in WHERE id = 'retry-1'").get() as {
      tries: number;
      process_after: string;
    };
    expect(row.tries).toBe(1);
    expect(row.process_after).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(row.process_after)).toBeGreaterThan(Date.now());
    db.close();
  });

  it('stores delivery receipts as ISO UTC instants', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE delivered (
      message_out_id TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status TEXT NOT NULL,
      delivered_at TEXT NOT NULL
    )`);

    markDelivered(db, 'delivered-1', 'platform-1');
    markDeliveryFailed(db, 'failed-1');

    const rows = db.prepare('SELECT status, delivered_at FROM delivered ORDER BY message_out_id').all() as Array<{
      status: string;
      delivered_at: string;
    }>;
    expect(rows.map((row) => row.status)).toEqual(['delivered', 'failed']);
    expect(rows.every((row) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.delivered_at))).toBe(true);
    db.close();
  });
});
