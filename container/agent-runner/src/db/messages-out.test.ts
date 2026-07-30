import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { hasAppendLogRequestSince, maxSeq, writeMessageOut } from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedInbound(seq: number): void {
  getInboundDb()
    .prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', 't', '{}')")
    .run(`in-${seq}`, seq);
}

function seedOutbound(seq: number): void {
  getOutboundDb()
    .prepare("INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', 't', '{}')")
    .run(`pre-${seq}`, seq);
}

describe('writeMessageOut — seq allocation', () => {
  test('assigns increasing odd seqs and persists the row (transaction commits)', () => {
    const s1 = writeMessageOut({ id: 'a', kind: 'chat', content: '{}' });
    const s2 = writeMessageOut({ id: 'b', kind: 'chat', content: '{}' });
    expect(s1 % 2).toBe(1);
    expect(s2 % 2).toBe(1);
    expect(s2).toBeGreaterThan(s1);
    const row = getOutboundDb().prepare('SELECT seq, timestamp FROM messages_out WHERE id = ?').get('a') as {
      seq: number;
      timestamp: string;
    };
    expect(row.seq).toBe(s1);
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('stays in the odd lane above an inbound (even) global max', () => {
    seedInbound(4);
    const s = writeMessageOut({ id: 'a', kind: 'chat', content: '{}' });
    expect(s).toBe(5);
  });

  test('does not reuse an existing odd outbound max', () => {
    seedOutbound(3);
    const s = writeMessageOut({ id: 'a', kind: 'chat', content: '{}' });
    expect(s).toBe(5);
  });

  test('accounts for both DBs when computing the global max', () => {
    seedOutbound(3);
    seedInbound(8);
    const s = writeMessageOut({ id: 'a', kind: 'chat', content: '{}' });
    expect(s).toBe(9); // next odd above max(3, 8)
  });
});

// Regression for the ncl-tasks port — a fire logs EXACTLY once. The agent's own
// `ncl tasks append-log` suppresses the final-text auto-log; without the guard,
// old tasks whose baked-in prompt still mandates append-log double-log.
// NOTE: the brief's sample used a `created_at` column; this fork's messages_out
// schema (see connection.ts) has no such column — it uses `timestamp`, same as
// every other write in this file. Adjusted accordingly.
function cliRequest(seq: number, command: string, requestId: string) {
  getOutboundDb()
    .prepare(
      `INSERT INTO messages_out (id, seq, kind, content, timestamp)
       VALUES (?, ?, 'system', ?, datetime('now'))`,
    )
    .run(`o${seq}`, seq, JSON.stringify({ action: 'cli_request', command, requestId }));
}

describe('hasAppendLogRequestSince — exactly-once run-log guard', () => {
  it('is false when the fire made no append-log call', () => {
    const since = maxSeq();
    cliRequest(since + 2, 'tasks-list', 'r1');
    expect(hasAppendLogRequestSince(since)).toBe(false);
  });

  it('is true for a dash-joined positional append-log invocation', () => {
    const since = maxSeq();
    cliRequest(since + 2, 'tasks-append-log-posted-the-digest', 'r2');
    expect(hasAppendLogRequestSince(since)).toBe(true);
  });

  it('ignores an append-log made before the watermark', () => {
    cliRequest(2, 'tasks-append-log', 'r3');
    expect(hasAppendLogRequestSince(maxSeq())).toBe(false);
  });

  it('suppresses when the response has not landed yet', () => {
    const since = maxSeq();
    cliRequest(since + 2, 'tasks-append-log', 'r4');
    // No response row: double-logging is worse than a rare missed line.
    expect(hasAppendLogRequestSince(since)).toBe(true);
  });

  it('does not suppress when the request definitively failed', () => {
    const since = maxSeq();
    cliRequest(since + 2, 'tasks-append-log', 'r5');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content)
         VALUES ('i1', ?, datetime('now'), 'pending', 0, 'system', ?)`,
      )
      .run(since + 3, JSON.stringify({ requestId: 'r5', frame: { ok: false } }));
    expect(hasAppendLogRequestSince(since)).toBe(false);
  });
});
