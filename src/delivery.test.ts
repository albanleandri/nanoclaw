/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

const mockDeliverViaPool =
  vi.fn<(agentGroupId: string, platformId: string, content: Record<string, unknown>) => Promise<string | undefined>>();
vi.mock('./channels/telegram-pool.js', () => ({
  hasPoolBots: () => true,
  deliverViaPool: (a: string, b: string, c: Record<string, unknown>) => mockDeliverViaPool(a, b, c),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

// task_log routing (ncl-tasks port, Task 13): appendRunLog is spied so tests
// can assert a run-log append happened without touching the filesystem —
// appendRunLog's own file-writing behavior is covered by
// modules/scheduling/run-log.test.ts.
const { appendRunLogSpy, directDeliveryDecisionSpy, recordDirectDeliverySpy, pauseTypingRefreshAfterDeliverySpy } =
  vi.hoisted(() => ({
    appendRunLogSpy: vi.fn(),
    directDeliveryDecisionSpy: vi.fn(),
    recordDirectDeliverySpy: vi.fn(),
    pauseTypingRefreshAfterDeliverySpy: vi.fn(),
  }));

vi.mock('./modules/scheduling/run-log.js', () => ({
  appendRunLog: appendRunLogSpy,
}));

// Wrap (not replace) the real implementations so every pre-existing test in
// this file keeps its real behavior — only add a spy on top, to observe
// whether task_log rows reach these orchestration/typing code paths.
vi.mock('./orchestration/run-store.js', async () => {
  const actual = await vi.importActual<typeof import('./orchestration/run-store.js')>('./orchestration/run-store.js');
  return {
    ...actual,
    directDeliveryDecision: (...args: Parameters<typeof actual.directDeliveryDecision>) => {
      directDeliveryDecisionSpy(...args);
      return actual.directDeliveryDecision(...args);
    },
    recordDirectDelivery: (...args: Parameters<typeof actual.recordDirectDelivery>) => {
      recordDirectDeliverySpy(...args);
      return actual.recordDirectDelivery(...args);
    },
  };
});

vi.mock('./modules/typing/index.js', async () => {
  const actual = await vi.importActual<typeof import('./modules/typing/index.js')>('./modules/typing/index.js');
  return {
    ...actual,
    pauseTypingRefreshAfterDelivery: (...args: Parameters<typeof actual.pauseTypingRefreshAfterDelivery>) => {
      pauseTypingRefreshAfterDeliverySpy(...args);
      return actual.pauseTypingRefreshAfterDelivery(...args);
    },
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveredIds } from './db/session-db.js';
import { resolveSession, outboundDbPath, openInboundDb } from './session-manager.js';
import {
  deliverSessionMessages,
  deliverMessage,
  setDeliveryAdapter,
  clearDeliveryAdapterForTesting,
} from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

/** Insert an outbound row with an explicit kind and in_reply_to — used for
 * task_log rows (no channel destination) and for the guard-exclusion
 * contrast tests below. */
function insertOutboundKind(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  opts: {
    kind: string;
    content: object;
    inReplyTo: string | null;
    channelType?: string | null;
    platformId?: string | null;
  },
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content, in_reply_to)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    opts.kind,
    opts.platformId ?? null,
    opts.channelType ?? null,
    JSON.stringify(opts.content),
    opts.inReplyTo,
  );
  db.close();
}

/** A task session — no messaging group, thread under the tasks system prefix. */
function taskSession(agentGroupId: string, threadId: string) {
  const { session } = resolveSession(agentGroupId, null, threadId, 'per-thread');
  return session;
}

/** A normal chat session. */
function chatSession(agentGroupId: string, messagingGroupId: string, threadId: string) {
  const { session } = resolveSession(agentGroupId, messagingGroupId, threadId, 'per-thread');
  return session;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  appendRunLogSpy.mockClear();
  directDeliveryDecisionSpy.mockClear();
  recordDirectDeliverySpy.mockClear();
  pauseTypingRefreshAfterDeliverySpy.mockClear();
});

afterEach(() => {
  clearDeliveryAdapterForTesting();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  it('retries missing routing data and records failure instead of false delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
         VALUES ('out-no-route', datetime('now'), 'chat', NULL, NULL, '{"text":"hello"}')`,
      )
      .run();
    outDb.close();

    const deliver = vi.fn();
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(deliver).not.toHaveBeenCalled();
    const inDb = openInboundDb('ag-1', session.id);
    const result = inDb.prepare("SELECT status FROM delivered WHERE message_out_id = 'out-no-route'").get() as {
      status: string;
    };
    inDb.close();
    expect(result.status).toBe('failed');
  });

  it('retries on adapter failure and marks failed after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('network timeout');
      },
    });

    // Attempt 1
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — should mark as permanently failed
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Attempt 4 — message is now in delivered (as failed), adapter not called
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Verify the message is in the delivered table with 'failed' status
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-flaky')).toBe(true);
  });

  it('does not mark delivered when no delivery adapter is configured', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-no-adapter');

    clearDeliveryAdapterForTesting();

    await deliverSessionMessages(session);
    let inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-no-adapter')).toBe(false);
    inDb.close();

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-no-adapter')).toBe(true);
    inDb.close();
  });

  it('clears attempt counter on successful delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry-ok');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return 'plat-ok';
      },
    });

    // Attempt 1 — fails
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2 — succeeds
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — not called, message already delivered
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);
  });
});

describe('deliverSessionMessages — telegram pool bot routing guard', () => {
  beforeEach(() => {
    mockDeliverViaPool.mockReset();
    mockDeliverViaPool.mockResolvedValue('pool-msg-1');
  });

  function insertOutboundWith(agentGroupId: string, sessionId: string, msgId: string, content: object): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
    ).run(msgId, JSON.stringify(content));
    db.close();
  }

  it('routes to pool bot when bot_index is provided', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundWith('ag-1', session.id, 'out-pool-1', { text: 'hi', bot_index: 2, sender: 'Bedtime Story' });

    const mainCalls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        mainCalls.push(content);
        return 'main-msg';
      },
    });

    await deliverSessionMessages(session);
    expect(mockDeliverViaPool).toHaveBeenCalledOnce();
    expect(mainCalls).toHaveLength(0);
  });

  it('does NOT route to pool bot when sender is provided but bot_index is absent', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundWith('ag-1', session.id, 'out-sender-only', { text: 'hi', sender: 'Weekend Ideas' });

    const mainCalls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        mainCalls.push(content);
        return 'main-msg';
      },
    });

    await deliverSessionMessages(session);
    expect(mockDeliverViaPool).not.toHaveBeenCalled();
    expect(mainCalls).toHaveLength(1);
  });

  it('does NOT route to pool bot when neither sender nor bot_index is present', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundWith('ag-1', session.id, 'out-plain', { text: 'plain reply' });

    const mainCalls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        mainCalls.push(content);
        return 'main-msg';
      },
    });

    await deliverSessionMessages(session);
    expect(mockDeliverViaPool).not.toHaveBeenCalled();
    expect(mainCalls).toHaveLength(1);
  });

  it('falls through to main adapter when pool bot returns undefined', async () => {
    mockDeliverViaPool.mockResolvedValue(undefined);
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundWith('ag-1', session.id, 'out-pool-fallback', { text: 'hi', bot_index: 0 });

    const mainCalls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        mainCalls.push(content);
        return 'main-msg';
      },
    });

    await deliverSessionMessages(session);
    expect(mockDeliverViaPool).toHaveBeenCalledOnce();
    expect(mainCalls).toHaveLength(1);
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (discord) — not the origin chat
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:456', 'discord', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Deliver 3 times to exhaust retries
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-unauth')).toBe(true);
  });
});

describe('deliverMessage — task_log routing', () => {
  // Regression for the ncl-tasks port — one-door delivery: a task fire's final
  // text becomes a run-log line, never a chat message. Delivering it would leak
  // scratchpad reasoning to the user.
  it('appends a task_log row to the series run log and sends nothing', async () => {
    seedAgentAndChannel();
    const session = taskSession('ag-1', 'system:tasks:daily-1a2b');
    const adapterSendSpy = vi.fn().mockResolvedValue('plat-msg');
    setDeliveryAdapter({ deliver: adapterSendSpy });
    const inDb = openInboundDb('ag-1', session.id);

    await deliverMessage(
      {
        id: 'm1',
        timestamp: now(),
        kind: 'task_log',
        platform_id: null,
        channel_type: null,
        thread_id: session.thread_id,
        content: JSON.stringify({ text: 'posted the digest' }),
        in_reply_to: null,
      },
      session,
      inDb,
    );
    inDb.close();

    expect(appendRunLogSpy).toHaveBeenCalledWith('ag-1', 'daily-1a2b', 'posted the digest');
    expect(adapterSendSpy).not.toHaveBeenCalled();
  });

  // Regression for the ncl-tasks port — a task_log row must never be
  // guessed at a channel destination outside its own task session; that
  // would risk leaking scratchpad reasoning to a user.
  it('drops a task_log row that arrives outside a task session', async () => {
    seedAgentAndChannel();
    const session = chatSession('ag-1', 'mg-1', 'thread-1');
    const adapterSendSpy = vi.fn().mockResolvedValue('plat-msg');
    setDeliveryAdapter({ deliver: adapterSendSpy });
    const inDb = openInboundDb('ag-1', session.id);

    await deliverMessage(
      {
        id: 'm2',
        timestamp: now(),
        kind: 'task_log',
        platform_id: null,
        channel_type: null,
        thread_id: session.thread_id,
        content: JSON.stringify({ text: 'x' }),
        in_reply_to: null,
      },
      session,
      inDb,
    );
    inDb.close();

    expect(appendRunLogSpy).not.toHaveBeenCalled();
    expect(adapterSendSpy).not.toHaveBeenCalled();
  });
});

describe('deliverSessionMessages — task_log is excluded from the orchestration/typing guards', () => {
  // Regression for the ncl-tasks port — writeMessageOut auto-stamps
  // in_reply_to from getCurrentInReplyTo() when the caller omits it
  // (container/agent-runner/src/db/messages-out.ts), and the task_log writer
  // (Task 22) does omit it. So a task_log row WILL carry a non-null
  // in_reply_to and would otherwise satisfy the drainSession guards that
  // gate orchestration-correlation, delivery telemetry, and the typing
  // pause. None of those apply to a run-log append: there is no chat
  // attached to a task session, so consulting cancelled-run state could
  // wrongly suppress a run-log line, and recording it as a "delivery" or
  // pausing a nonexistent typing indicator would corrupt telemetry for a
  // channel event that never happened.
  it('does not consult orchestration correlation, delivery telemetry, or the typing pause for a task_log row', async () => {
    seedAgentAndChannel();
    const session = taskSession('ag-1', 'system:tasks:daily-1a2b');
    setDeliveryAdapter({ deliver: vi.fn().mockResolvedValue('plat-msg') });
    insertOutboundKind('ag-1', session.id, 'out-tasklog-1', {
      kind: 'task_log',
      content: { text: 'ran ok' },
      inReplyTo: 'inbound-unrelated',
    });

    await deliverSessionMessages(session);

    expect(appendRunLogSpy).toHaveBeenCalledWith('ag-1', 'daily-1a2b', 'ran ok');
    expect(directDeliveryDecisionSpy).not.toHaveBeenCalled();
    expect(recordDirectDeliverySpy).not.toHaveBeenCalled();
    expect(pauseTypingRefreshAfterDeliverySpy).not.toHaveBeenCalled();

    const inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-tasklog-1')).toBe(true);
    inDb.close();
  });

  // Contrast case: proves the spies above are actually wired to the real
  // guards, and that the task_log exclusion is kind-specific rather than a
  // side effect of some other change — a normal chat reply with the same
  // in_reply_to shape still goes through the orchestration/typing guards.
  it('still consults orchestration correlation and the typing pause for a normal chat row with in_reply_to', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({ deliver: vi.fn().mockResolvedValue('plat-msg') });
    insertOutboundKind('ag-1', session.id, 'out-chat-1', {
      kind: 'chat',
      content: { text: 'hi' },
      inReplyTo: 'inbound-unrelated',
      channelType: 'telegram',
      platformId: 'telegram:123',
    });

    await deliverSessionMessages(session);

    expect(directDeliveryDecisionSpy).toHaveBeenCalledWith(session.id, 'inbound-unrelated');
    expect(recordDirectDeliverySpy).toHaveBeenCalled();
    expect(pauseTypingRefreshAfterDeliverySpy).toHaveBeenCalledWith(session.id);
  });
});
