import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, mockWakeContainer, mockIsContainerRunning } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-test-telegram-critical-path',
  mockWakeContainer: vi.fn(),
  mockIsContainerRunning: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { getSession, updateSession } from './db/sessions.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { _sweepSessionForTesting } from './host-sweep.js';
import { routeInbound } from './router.js';
import { inboundDbPath, outboundDbPath, resolveSession } from './session-manager.js';

function now(): string {
  return new Date().toISOString();
}

function seedTelegramMain(): void {
  createAgentGroup({
    id: 'ag-telegram',
    name: 'Telegram Main',
    folder: 'telegram-main',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-telegram',
    channel_type: 'telegram',
    platform_id: '6413334350',
    name: 'Main Telegram',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-telegram',
    messaging_group_id: 'mg-telegram',
    agent_group_id: 'ag-telegram',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  mockWakeContainer.mockReset();
  mockWakeContainer.mockResolvedValue(true);
  mockIsContainerRunning.mockReset();
  mockIsContainerRunning.mockReturnValue(false);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('Telegram main receive/reply critical path', () => {
  it('routes an inbound Telegram message into the session DB and wakes the agent', async () => {
    seedTelegramMain();

    await routeInbound({
      channelType: 'telegram',
      platformId: '6413334350',
      threadId: null,
      message: {
        id: '6413334350:2001',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: '/screen-market' }),
        timestamp: now(),
      },
    });

    const session = getSession((mockWakeContainer.mock.calls[0]?.[0] as { id: string }).id);
    expect(session).toBeDefined();
    expect(session?.thread_id).toBeNull();
    expect(mockWakeContainer).toHaveBeenCalledOnce();

    const db = new Database(inboundDbPath('ag-telegram', session!.id), { readonly: true });
    const row = db
      .prepare('SELECT id, kind, status, channel_type, platform_id, thread_id, trigger FROM messages_in')
      .get() as {
      id: string;
      kind: string;
      status: string;
      channel_type: string | null;
      platform_id: string | null;
      thread_id: string | null;
      trigger: number;
    };
    db.close();

    const outDb = new Database(outboundDbPath('ag-telegram', session!.id), { readonly: true });
    const ack = outDb.prepare('SELECT kind, channel_type, platform_id, thread_id, content FROM messages_out').get() as {
      kind: string;
      channel_type: string | null;
      platform_id: string | null;
      thread_id: string | null;
      content: string;
    };
    outDb.close();
    expect(ack).toMatchObject({
      kind: 'chat',
      channel_type: 'telegram',
      platform_id: '6413334350',
      thread_id: null,
    });
    expect(JSON.parse(ack.content).text).toBe('Opening screen-market options...');

    expect(row).toMatchObject({
      id: '6413334350:2001:ag-telegram',
      kind: 'chat-sdk',
      status: 'pending',
      channel_type: 'telegram',
      platform_id: '6413334350',
      thread_id: null,
      trigger: 1,
    });
  });

  it('does not write a host-side screen acknowledgement while the container is already running', async () => {
    seedTelegramMain();
    mockIsContainerRunning.mockReturnValue(true);

    await routeInbound({
      channelType: 'telegram',
      platformId: '6413334350',
      threadId: null,
      message: {
        id: '6413334350:2002',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: '/screen-market' }),
        timestamp: now(),
      },
    });

    const session = getSession((mockWakeContainer.mock.calls[0]?.[0] as { id: string }).id);
    expect(session).toBeDefined();

    const outDb = new Database(outboundDbPath('ag-telegram', session!.id), { readonly: true });
    const count = (outDb.prepare('SELECT COUNT(*) AS count FROM messages_out').get() as { count: number }).count;
    outDb.close();

    expect(count).toBe(0);
  });

  it('host sweep wakes due Telegram work even when central DB has stale container_status=running', async () => {
    seedTelegramMain();
    const { session } = resolveSession('ag-telegram', 'mg-telegram', null, 'shared');
    updateSession(session.id, { container_status: 'running' });

    const inDb = new Database(inboundDbPath('ag-telegram', session.id));
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger) VALUES ('tg-pending:ag-telegram', 2, 'chat-sdk', datetime('now'), 'pending', ?, 1)",
      )
      .run(JSON.stringify({ text: 'are you there?' }));
    inDb.close();

    const staleSession = getSession(session.id)!;
    expect(staleSession.container_status).toBe('running');
    mockIsContainerRunning.mockReturnValue(false);

    await _sweepSessionForTesting(staleSession);

    expect(mockIsContainerRunning).toHaveBeenCalledWith(session.id);
    expect(mockWakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
  });

  it('delivers a Telegram reply and records the platform message id to prevent duplicate sends', async () => {
    seedTelegramMain();
    const { session } = resolveSession('ag-telegram', 'mg-telegram', null, 'shared');
    const outDb = new Database(outboundDbPath('ag-telegram', session.id));
    outDb
      .prepare(
        "INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content) VALUES ('out-tg-1', datetime('now'), 'chat', '6413334350', 'telegram', NULL, ?)",
      )
      .run(JSON.stringify({ text: 'I am here' }));
    outDb.close();

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content) {
        delivered.push(JSON.stringify({ channelType, platformId, threadId, kind, content }));
        return '6413334350:2002';
      },
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(delivered).toHaveLength(1);
    const inDb = new Database(inboundDbPath('ag-telegram', session.id), { readonly: true });
    const delivery = inDb.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get('out-tg-1') as {
      platform_message_id: string;
      status: string;
    };
    inDb.close();
    expect(delivery).toMatchObject({ platform_message_id: '6413334350:2002', status: 'delivered' });
  });
});
