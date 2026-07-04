/**
 * Tests for session-manager's direct outbound write path.
 *
 * Drives the real `writeOutboundDirect` entry against a real session folder
 * on disk. A previous implementation opened the outbound DB through
 * `openOutboundDb` (readonly: true), so every INSERT threw SQLITE_READONLY
 * and stopped-container host acknowledgements silently never delivered. Goes
 * red if the open call reverts to the readonly form.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import { inboundDbPath, initSessionFolder, outboundDbPath, writeOutboundDirect } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-write-outbound';
const AG = 'ag-test';
const SESS = 'sess-test';

/** Seed a container-written (odd-seq) outbound row. */
function seedOutbound(seq: number): void {
  const db = new Database(outboundDbPath(AG, SESS));
  try {
    db.prepare(
      "INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, datetime('now'), 'chat', '{}')",
    ).run(`container-${seq}`, seq);
  } finally {
    db.close();
  }
}

/** Seed a host-written inbound row (e.g. an accumulated message). */
function seedInbound(seq: number): void {
  const db = new Database(inboundDbPath(AG, SESS));
  try {
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run(`inbound-${seq}`, seq);
  } finally {
    db.close();
  }
}

function readMessagesOut(): Array<{ id: string; seq: number; kind: string; content: string }> {
  const db = new Database(outboundDbPath(AG, SESS), { readonly: true });
  try {
    return db.prepare('SELECT id, seq, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      seq: number;
      kind: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('writeOutboundDirect', () => {
  it('inserts into messages_out with an even host-side seq (requires a writable outbound.db)', () => {
    // With a readonly open this very call throws SQLITE_READONLY.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'Admin commands are restricted.' }),
    });

    const rows = readMessagesOut();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('denial-1');
    expect(rows[0].seq).toBe(2);
    expect(rows[0].seq % 2).toBe(0); // host uses even seq numbers
    expect(JSON.parse(rows[0].content).text).toBe('Admin commands are restricted.');
  });

  it('keeps host seq numbers even across multiple writes and ignores duplicate ids', () => {
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"first"}',
    });
    writeOutboundDirect(AG, SESS, {
      id: 'denial-2',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"second"}',
    });
    // INSERT OR IGNORE — a delivery retry with the same id must not throw or duplicate.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"retry"}',
    });

    const rows = readMessagesOut();
    expect(rows.map((r) => r.id)).toEqual(['denial-1', 'denial-2']);
    expect(rows.map((r) => r.seq)).toEqual([2, 4]);
  });

  it('stays in the even host lane above the container odd-seq max', () => {
    // Container has replied (odd seqs 1, 3). The old MAX(messages_out)+2 would
    // yield 5 — an ODD seq in the container's lane, violating host-even parity.
    seedOutbound(1);
    seedOutbound(3);

    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"denied"}',
    });

    const denial = readMessagesOut().find((r) => r.id === 'denial-1');
    expect(denial).toBeDefined();
    expect(denial!.seq % 2).toBe(0); // even, not the old odd 5
    expect(denial!.seq).toBe(4); // next even above global max 3
  });

  it('accounts for inbound seqs so it never collides with an inbound message id', () => {
    // An accumulated inbound message holds seq 2 while messages_out is empty.
    // The old MAX(messages_out)+2 = 2 collided with that inbound seq (both
    // tables share the agent-facing seq namespace); the new max-across-both
    // allocation skips to 4.
    seedInbound(2);

    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"denied"}',
    });

    const denial = readMessagesOut().find((r) => r.id === 'denial-1');
    expect(denial).toBeDefined();
    expect(denial!.seq).toBe(4);
  });
});
