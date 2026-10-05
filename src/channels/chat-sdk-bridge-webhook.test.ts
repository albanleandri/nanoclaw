/**
 * Webhook-route registration in the Chat SDK bridge (ported from upstream
 * 000c079e).
 *
 * Polling adapters (Telegram) must not register a route on the shared
 * webhook server: registration lazily binds 0.0.0.0:WEBHOOK_PORT, and the
 * Telegram adapter accepts unsigned updates when no webhook secret is set,
 * so a stray route lets anyone who can reach the port forge inbound
 * messages under any sender id. Deleting the `runtimeMode === 'polling'`
 * branch in setup() turns the polling case red; reading runtimeMode before
 * initialize() does too, because the stub only assigns it there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

const hostConfig = {
  onInbound: async () => {},
  onInboundEvent: async () => {},
  onMetadata: () => {},
  onAction: () => {},
} as unknown as ChannelSetup;

function stubAdapter(runtimeMode?: 'webhook' | 'polling'): Adapter {
  const adapter = {
    name: 'stub',
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
  } as unknown as Adapter & { runtimeMode?: string };
  // Assigned inside initialize(), as the Telegram adapter does when mode
  // 'auto' resolves — a guard that reads it earlier sees undefined.
  adapter.initialize = async () => {
    adapter.runtimeMode = runtimeMode;
  };
  return adapter;
}

beforeEach(() => {
  vi.mocked(registerWebhookAdapter).mockClear();
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('createChatSdkBridge.setup — webhook route', () => {
  it('polling adapter registers no webhook route', async () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter('polling'), supportsThreads: false });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('webhook adapter registers the route', async () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter('webhook'), supportsThreads: false });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('adapter without runtimeMode registers the route', async () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter(), supportsThreads: false });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });
});
