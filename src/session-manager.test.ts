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

import {
  inboundDbPath,
  initSessionFolder,
  outboundDbPath,
  resolveTaskSession,
  sessionDir,
  withInboundDb,
  writeOutboundDirect,
  writeSessionMessage,
} from './session-manager.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';

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

function readMessagesOut(): Array<{ id: string; seq: number; timestamp: string; kind: string; content: string }> {
  const db = new Database(outboundDbPath(AG, SESS), { readonly: true });
  try {
    return db.prepare('SELECT id, seq, timestamp, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      seq: number;
      timestamp: string;
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
    expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
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

describe('writeSessionMessage', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG,
      name: 'Reset test',
      folder: 'reset-test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => closeDb());

  it('re-provisions a deleted session folder before writing', () => {
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });

    expect(() =>
      writeSessionMessage(AG, SESS, {
        id: 'after-reset',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ text: 'still here?' }),
      }),
    ).not.toThrow();

    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      expect(db.prepare('SELECT id FROM messages_in WHERE id = ?').get('after-reset')).toMatchObject({
        id: 'after-reset',
      });
    } finally {
      db.close();
    }
  });
});

describe('resolveTaskSession / withInboundDb', () => {
  const TASK_AG = 'ag-1';

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: TASK_AG,
      name: 'Task session test',
      folder: 'task-session-test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => closeDb());

  // Regression for the ncl-tasks port — each series gets its OWN session so a
  // backlog in one series cannot queue behind another series or a live chat.
  it('creates one isolated session per series and reuses it on the second call', () => {
    const first = resolveTaskSession(TASK_AG, 'daily-1a2b');
    expect(first.created).toBe(true);
    expect(first.session.thread_id).toBe('system:tasks:daily-1a2b');
    expect(first.session.messaging_group_id).toBeNull();

    const again = resolveTaskSession(TASK_AG, 'daily-1a2b');
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(first.session.id);

    const other = resolveTaskSession(TASK_AG, 'weekly-3c4d');
    expect(other.session.id).not.toBe(first.session.id);
  });

  it('closes the inbound db even when the callback throws', () => {
    const { session } = resolveTaskSession(TASK_AG, 'probe-5e6f');
    expect(() =>
      withInboundDb(TASK_AG, session.id, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // A leaked handle would make this second open fail on some platforms.
    expect(withInboundDb(TASK_AG, session.id, (db) => db.prepare('SELECT 1 AS ok').get())).toEqual({ ok: 1 });
  });
});
