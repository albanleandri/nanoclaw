/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./run-log.js', () => ({
  appendRunLog: vi.fn(),
}));

import { TIMEZONE } from '../../config.js';
import { ensureSchema, openInboundDb, openOutboundDbRw } from '../../db/session-db.js';
import { insertTask, insertTaskRow } from './db.js';
import { failureBackoffMinutes, handleRecurrence } from './recurrence.js';
import { appendRunLog } from './run-log.js';
import type { Session } from '../../types.js';

const appendRunLogSpy = vi.mocked(appendRunLog);

const TEST_DIR = '/tmp/nanoclaw-recurrence-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function freshOutboundDb() {
  const dbPath = path.join(TEST_DIR, 'outbound.db');
  ensureSchema(dbPath, 'outbound');
  return openOutboundDbRw(dbPath);
}

function recordScriptError(outDb: ReturnType<typeof freshOutboundDb>, messageId: string): void {
  outDb
    .prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'script-skip:error', datetime('now'))",
    )
    .run(messageId);
}

function recordProviderError(outDb: ReturnType<typeof freshOutboundDb>, messageId: string): void {
  outDb
    .prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'provider-error', datetime('now'))",
    )
    .run(messageId);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleRecurrence', () => {
  it('clones a completed recurring task with a next-run in the future', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'one-off' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

// Seeds `fails` consecutive FAILED task occurrences sharing one series_id —
// the newest of them carries the recurrence (it's the row getCompletedRecurring
// hands to handleRecurrence). insertTaskRow assigns seq via nextEvenSeq on each
// call, so inserting in this order (oldest first) also gives increasing seq,
// which is what trailingFailedRuns' `ORDER BY seq DESC` streak-count relies on.
function seedFailedSeries(
  db: ReturnType<typeof freshDb>,
  seriesId: string,
  opts: { fails: number; recurrence: string },
): void {
  for (let i = 0; i < opts.fails - 1; i++) {
    const id = `${seriesId}-h${i}`;
    insertTaskRow(db, {
      id,
      seriesId,
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'history' }),
    });
    db.prepare(`UPDATE messages_in SET status = 'failed' WHERE id = ?`).run(id);
  }

  insertTaskRow(db, {
    id: seriesId,
    seriesId,
    processAfter: '2020-01-01T00:00:00.000Z',
    recurrence: opts.recurrence,
    content: JSON.stringify({ prompt: 'watch' }),
  });
  db.prepare(`UPDATE messages_in SET status = 'failed' WHERE id = ?`).run(seriesId);
}

// A healthy series: a single COMPLETED row carrying the recurrence, no
// trailing failures — trailingFailedRuns must read a streak of 0 for it.
function seedCompletedSeries(db: ReturnType<typeof freshDb>, seriesId: string, opts: { recurrence: string }): void {
  insertTaskRow(db, {
    id: seriesId,
    seriesId,
    processAfter: '2020-01-01T00:00:00.000Z',
    recurrence: opts.recurrence,
    content: JSON.stringify({ prompt: 'daily' }),
  });
  db.prepare(`UPDATE messages_in SET status = 'completed' WHERE id = ?`).run(seriesId);
}

describe('failureBackoffMinutes', () => {
  it('doubles from 2 minutes and caps at 60', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(failureBackoffMinutes)).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
  });
});

describe('handleRecurrence script-failure backoff', () => {
  let db: ReturnType<typeof freshDb>;
  let session: Session;

  beforeEach(() => {
    db = freshDb();
    session = fakeSession();
    appendRunLogSpy.mockClear();
  });

  // Regression for the ncl-tasks port — a monitor whose gate script keeps
  // erroring must throttle, not spawn a container at raw cron cadence forever.
  it('pushes the next fire past the cron time while a failure streak is running', async () => {
    seedFailedSeries(db, 'watch-9f9f', { fails: 3, recurrence: '*/5 * * * *' });
    const outDb = freshOutboundDb();
    recordScriptError(outDb, 'watch-9f9f');
    await handleRecurrence(db, session, outDb);
    outDb.close();

    const next = db
      .prepare("SELECT process_after FROM messages_in WHERE status = 'pending' AND series_id = 'watch-9f9f'")
      .get() as { process_after: string };
    // 3 fails → 8 minutes, which is beyond the next */5 grid point.
    expect(Date.parse(next.process_after) - Date.now()).toBeGreaterThan(7 * 60_000);
  });

  it('re-arms paused and writes a run-log note after 8 consecutive failures', async () => {
    seedFailedSeries(db, 'watch-9f9f', { fails: 8, recurrence: '*/5 * * * *' });
    const outDb = freshOutboundDb();
    recordScriptError(outDb, 'watch-9f9f');
    await handleRecurrence(db, session, outDb);
    outDb.close();

    const row = db
      .prepare("SELECT status FROM messages_in WHERE series_id = 'watch-9f9f' AND status IN ('pending','paused')")
      .get() as { status: string };
    expect(row.status).toBe('paused');
    const note = appendRunLogSpy.mock.calls.at(-1)![2];
    expect(note).toContain('auto-paused after 8 consecutive failed runs');
    expect(note).toContain('fix the script');
    expect(note).toContain('ncl tasks resume watch-9f9f');
  });

  // A prolonged credential outage reaches the same pause cap as a broken gate
  // script. Telling the operator to "fix the script" sends them after code that
  // is not broken, so the note must name the cause it actually saw.
  it('names the provider as the cause when a credential outage pauses the series', async () => {
    seedFailedSeries(db, 'watch-9f9f', { fails: 8, recurrence: '*/5 * * * *' });
    const outDb = freshOutboundDb();
    recordProviderError(outDb, 'watch-9f9f');
    await handleRecurrence(db, session, outDb);
    outDb.close();

    const note = appendRunLogSpy.mock.calls.at(-1)![2];
    expect(note).toContain('auto-paused after 8 consecutive failed runs');
    expect(note).toContain('provider unreachable (credential or quota)');
    expect(note).toContain('restore provider access');
    expect(note).not.toContain('fix the script');
  });

  // A failed fire writes nothing to the run log on its own — the runner's
  // auto-append only covers a turn that produced result text, which an auth or
  // quota failure never does. Without a host-written line the series log shows
  // an unexplained gap where the occurrence should be.
  it('logs each re-armed failure with its cause and next attempt', async () => {
    seedFailedSeries(db, 'watch-9f9f', { fails: 2, recurrence: '*/5 * * * *' });
    const outDb = freshOutboundDb();
    recordProviderError(outDb, 'watch-9f9f');
    await handleRecurrence(db, session, outDb);
    outDb.close();

    const next = db
      .prepare("SELECT process_after FROM messages_in WHERE status = 'pending' AND series_id = 'watch-9f9f'")
      .get() as { process_after: string };
    expect(appendRunLogSpy).toHaveBeenCalledWith(
      session.agent_group_id,
      'watch-9f9f',
      `run failed (provider unreachable (credential or quota)); failure 2 in a row, next attempt ${next.process_after}`,
    );
  });

  it('does not write a failure note for a healthy run', async () => {
    seedCompletedSeries(db, 'daily-1a2b', { recurrence: '0 9 * * *' });
    const outDb = freshOutboundDb();

    await handleRecurrence(db, session, outDb);
    outDb.close();

    expect(appendRunLogSpy).not.toHaveBeenCalled();
  });

  it('does not back off a healthy series', async () => {
    seedCompletedSeries(db, 'daily-1a2b', { recurrence: '0 9 * * *' });
    await handleRecurrence(db, session);

    const next = db
      .prepare("SELECT process_after FROM messages_in WHERE status = 'pending' AND series_id = 'daily-1a2b'")
      .get() as { process_after: string };
    const expected = CronExpressionParser.parse('0 9 * * *', { tz: TIMEZONE }).next().toISOString();
    expect(next.process_after).toBe(expected);
  });
});
