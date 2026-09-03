/**
 * Tests for the scheduling module's task DB helpers — focused on the
 * series_id invariant that lets cancel/pause/resume/update reach the live
 * next occurrence of a recurring task, even after the row the agent
 * remembers has completed and been replaced by a follow-up.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { ensureSchema, nextEvenSeq, openInboundDb } from '../../db/session-db.js';
import {
  insertTask,
  insertTaskRow,
  insertRecurrence,
  cancelTask,
  cancelAllTasks,
  pauseTask,
  resumeTask,
  deleteTask,
  updateTask,
  getCompletedRecurring,
  trailingFailedRuns,
  type RecurringMessage,
} from './db.js';

const NOW = '2026-07-28T09:00:00.000Z';
const TEST_DIR = '/tmp/nanoclaw-scheduling-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function insertBasicTask(db: ReturnType<typeof openInboundDb>, id: string, recurrence: string | null) {
  insertTask(db, {
    id,
    processAfter: new Date().toISOString(),
    recurrence,
    content: JSON.stringify({ prompt: 'noop' }),
  });
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('insertTask', () => {
  it('stamps series_id = id on insert', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', null);
    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-1') as { series_id: string };
    expect(row.series_id).toBe('task-1');
    db.close();
  });

  // Behaviour change from the ncl-tasks port: insertTaskRow stamps the
  // timestamp with SQL `datetime('now')` (UTC, 'YYYY-MM-DD HH:MM:SS') instead
  // of a JS `new Date().toISOString()` string. Was asserting the old ISO
  // 'T'/'Z' shape; updated to match the new SQLite-generated format.
  it('stores a SQLite UTC datetime', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-iso', null);
    const row = db.prepare('SELECT timestamp FROM messages_in WHERE id = ?').get('task-iso') as {
      timestamp: string;
    };
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    db.close();
  });
});

describe('cancelTask / pauseTask / resumeTask series matching', () => {
  // Simulates the recurrence chain that used to survive cancellation:
  // the original task completes → handleRecurrence spawns a follow-up
  // row → agent calls cancel_task(originalId) → historically only hit
  // the completed row, leaving the live one running.
  function seedRecurringChain(db: ReturnType<typeof openInboundDb>) {
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    // Mark the original as completed (as syncProcessingAcks would do).
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      content: JSON.stringify({ prompt: 'noop' }),
      recurrence: '0 9 * * *',
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());
  }

  it('cancel by original id reaches the live follow-up via series_id', () => {
    const db = freshDb();
    seedRecurringChain(db);

    cancelTask(db, 'task-orig');

    const live = db.prepare("SELECT id, status, recurrence FROM messages_in WHERE status = 'pending'").all();
    expect(live).toHaveLength(0);

    const followUp = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'task-next'").get() as {
      status: string;
      recurrence: string | null;
    };
    // A cancelled occurrence never fired: it's marked 'cancelled', not
    // 'completed', so it never inflates the run history `ncl tasks list`
    // reports. Regression for the ncl-tasks port.
    expect(followUp.status).toBe('cancelled');
    // Recurrence cleared so the sweep doesn't spawn another clone.
    expect(followUp.recurrence).toBeNull();
    db.close();
  });

  it('cancelled task is not picked up by getCompletedRecurring', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', '0 9 * * *');
    cancelTask(db, 'task-1');

    const recurring = getCompletedRecurring(db);
    expect(recurring).toHaveLength(0);
    db.close();
  });

  it('pause by original id pauses the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    pauseTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('paused');
    db.close();
  });

  it('resume by original id resumes the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = 'task-next'").run();
    resumeTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('pending');
    db.close();
  });
});

describe('updateTask', () => {
  it('merges supplied fields into content JSON without clobbering others', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'old', script: 'echo old', extra: 'keep me' }),
    });

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(1);

    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-1') as { content: string };
    const parsed = JSON.parse(row.content);
    expect(parsed.prompt).toBe('new');
    expect(parsed.script).toBe('echo old');
    expect(parsed.extra).toBe('keep me');
  });

  it('updates recurrence and process_after when supplied', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: '0 18 * * *', processAfter: '2026-02-01T00:00:00Z' });

    const row = db.prepare('SELECT recurrence, process_after FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string;
      process_after: string;
    };
    expect(row.recurrence).toBe('0 18 * * *');
    expect(row.process_after).toBe('2026-02-01T00:00:00Z');
  });

  it('clears recurrence when null is passed', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: null });

    const row = db.prepare('SELECT recurrence FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();
  });

  it('reaches the live follow-up via series_id when called with the original id', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-orig',
      processAfter: new Date().toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'old' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      content: JSON.stringify({ prompt: 'old' }),
      recurrence: '0 9 * * *',
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());

    const touched = updateTask(db, 'task-orig', { prompt: 'new' });
    // Only the live follow-up should be touched — completed rows are excluded.
    expect(touched).toBe(1);

    const live = db.prepare("SELECT content FROM messages_in WHERE id = 'task-next'").get() as { content: string };
    expect(JSON.parse(live.content).prompt).toBe('new');

    // Original (completed) row left alone.
    const orig = db.prepare("SELECT content FROM messages_in WHERE id = 'task-orig'").get() as { content: string };
    expect(JSON.parse(orig.content).prompt).toBe('old');
  });

  it('returns 0 when no live task matches', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'p' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-1'").run();

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(0);
  });
});

describe('insertRecurrence', () => {
  it('copies series_id forward', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      content: '{}',
      recurrence: '0 9 * * *',
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date().toISOString());

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-next') as {
      series_id: string;
    };
    expect(row.series_id).toBe('task-orig');
    db.close();
  });
});

describe('ncl-tasks port: series-aware task row API', () => {
  let db: ReturnType<typeof openInboundDb>;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  // Regression for the ncl-tasks port — cancel must mark 'cancelled', not
  // 'completed'. A cancelled occurrence never fired; counting it as a run
  // inflates the run history `ncl tasks list` reports.
  it('cancels to the cancelled status and clears the recurrence', () => {
    insertTaskRow(db, {
      id: 'daily-1a2b',
      seriesId: 'daily-1a2b',
      processAfter: NOW,
      recurrence: '0 9 * * *',
      content: '{}',
    });
    expect(cancelTask(db, 'daily-1a2b')).toBe(1);
    const row = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'daily-1a2b'").get();
    expect(row).toEqual({ status: 'cancelled', recurrence: null });
  });

  it('returns 0 when no live row matches, so the caller can report not-found', () => {
    expect(cancelTask(db, 'nope-0000')).toBe(0);
    expect(pauseTask(db, 'nope-0000')).toBe(0);
    expect(resumeTask(db, 'nope-0000')).toBe(0);
    expect(deleteTask(db, 'nope-0000')).toBe(0);
  });

  it('counts only the trailing failed run streak, stopping at the first completed run', () => {
    const mk = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, content, series_id)
           VALUES (?, ?, datetime('now'), ?, 0, NULL, NULL, 'task', '{}', 'watch-9f9f')`,
        )
        .run(id, nextEvenSeq(db), status);
    mk('r1', 'failed');
    mk('r2', 'completed');
    mk('r3', 'failed');
    mk('r4', 'failed');
    expect(trailingFailedRuns(db, 'watch-9f9f')).toBe(2);
  });

  it('re-arms only failed occurrences proven to be retryable task errors', () => {
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, content, series_id)
       VALUES ('f1', ?, datetime('now'), 'failed', 0, NULL, '*/15 * * * *', 'task', '{}', 'watch-9f9f')`,
    ).run(nextEvenSeq(db));
    expect(getCompletedRecurring(db).map((m) => m.id)).not.toContain('f1');
    expect(getCompletedRecurring(db, new Set(['f1'])).map((m) => m.id)).toContain('f1');
  });

  it('cancelAllTasks clears every live row and reports the count', () => {
    insertTaskRow(db, { id: 'a-1111', seriesId: 'a-1111', processAfter: NOW, recurrence: null, content: '{}' });
    insertTaskRow(db, { id: 'b-2222', seriesId: 'b-2222', processAfter: NOW, recurrence: null, content: '{}' });
    expect(cancelAllTasks(db)).toBe(2);
  });

  it('inserts a paused occurrence when asked, for the auto-pause path', () => {
    insertTaskRow(db, {
      id: 'p-3333',
      seriesId: 'p-3333',
      processAfter: NOW,
      recurrence: '0 9 * * *',
      content: '{}',
      status: 'paused',
    });
    expect(db.prepare("SELECT status FROM messages_in WHERE id = 'p-3333'").get()).toEqual({ status: 'paused' });
  });
});
