import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { findSession } from './db/sessions.js';
import { outboundDbPath } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';

const { deliver } = vi.hoisted(() => ({ deliver: vi.fn().mockResolvedValue('platform-denial') }));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({
    channelType: 'discord',
    supportsThreads: true,
    deliver,
  }),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(true),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-command-denial' };
});

import { routeInbound } from './router.js';

const TEST_DIR = '/tmp/nanoclaw-test-command-denial';

describe('router command denial delivery', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    deliver.mockClear();

    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'channel-1',
      name: 'Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('delivers a denial through the adapter without writing container-owned outbound.db', async () => {
    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'channel-1',
      threadId: null,
      message: {
        id: 'msg-denied',
        kind: 'chat',
        content: JSON.stringify({ text: '/clear' }),
        timestamp: new Date().toISOString(),
      },
    };

    await routeInbound(event);

    expect(deliver).toHaveBeenCalledWith('channel-1', null, {
      kind: 'chat',
      content: { text: 'Permission denied: /clear requires admin access.' },
    });

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const outbound = new Database(outboundDbPath('ag-1', session!.id), { readonly: true });
    const rowCount = (outbound.prepare('SELECT COUNT(*) AS count FROM messages_out').get() as { count: number }).count;
    outbound.close();
    expect(rowCount).toBe(0);
  });
});
