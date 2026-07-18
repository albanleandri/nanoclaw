import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { writeMessageOut } from './messages-out.js';

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
