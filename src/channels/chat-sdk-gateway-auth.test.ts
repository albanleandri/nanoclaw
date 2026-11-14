import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from 'chat';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createChatSdkBridge, gatewayTokenMatches } from './chat-sdk-bridge.js';

const BOT_TOKEN = 'test-bot-token';
const realFetch = globalThis.fetch;

const click = JSON.stringify({
  type: 'GATEWAY_INTERACTION_CREATE',
  data: {
    type: 3,
    id: 'interaction-1',
    token: 'interaction-token',
    channel_id: 'chan-1',
    data: { custom_id: 'ncq:q-1:approve' },
    member: { user: { id: 'clicker-1', username: 'clicker' } },
    message: { id: 'card-1', embeds: [] },
  },
});
const message = JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-1', content: 'hi' } });

async function startGateway(botToken?: string) {
  let webhookUrl = '';
  const handleWebhook = vi.fn(async () => new Response('ok'));
  const adapter = {
    name: 'discord',
    initialize: async () => {},
    handleWebhook,
    channelIdFromThreadId: (threadId: string) => threadId,
    startGatewayListener: async (_opts: unknown, _duration: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    },
  } as unknown as Adapter & {
    startGatewayListener(opts: unknown, duration: number, signal: AbortSignal, url: string): Promise<Response>;
  };
  const onAction = vi.fn();
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken });
  await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
  const post = (body: string, headers: Record<string, string> = {}) =>
    realFetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return { bridge, post, onAction, handleWebhook, webhookUrl };
}

beforeEach(() => {
  runMigrations(initTestDb());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
});

describe('Gateway webhook token comparison', () => {
  it('matches only the configured scalar token', () => {
    expect(gatewayTokenMatches(BOT_TOKEN, BOT_TOKEN)).toBe(true);
    expect(gatewayTokenMatches('wrong', BOT_TOKEN)).toBe(false);
    expect(gatewayTokenMatches(undefined, BOT_TOKEN)).toBe(false);
    expect(gatewayTokenMatches([BOT_TOKEN], BOT_TOKEN)).toBe(false);
    expect(gatewayTokenMatches('', undefined)).toBe(false);
  });
});

describe('local Gateway webhook authentication', () => {
  it.each([
    ['no token header', {}],
    ['a wrong token', { 'x-discord-gateway-token': 'wrong' }],
  ])('rejects %s before adapter or host dispatch', async (_label, headers) => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      expect((await post(click, headers)).status).toBe(401);
      expect((await post(message, headers)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('rejects before waiting for the request body', async () => {
    const { bridge, webhookUrl } = await startGateway(BOT_TOKEN);
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request(webhookUrl, { method: 'POST', headers: { 'Content-Length': '1000' } }, (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', reject);
        req.flushHeaders();
      });
      expect(status).toBe(401);
    } finally {
      await bridge.teardown();
    }
  });

  it('rejects every request when no bot token is configured', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway();
    try {
      expect((await post(click, { 'x-discord-gateway-token': '' })).status).toBe(401);
      expect((await post(message)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('dispatches clicks and forwards events only with the matching token', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      const auth = { 'x-discord-gateway-token': BOT_TOKEN };
      expect((await post(click, auth)).status).toBe(200);
      expect(onAction).toHaveBeenCalledWith('q-1', 'approve', 'clicker-1');
      expect((await post(message, auth)).status).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });

  it('closes the loopback server during bridge teardown', async () => {
    const { bridge, webhookUrl } = await startGateway(BOT_TOKEN);
    await bridge.teardown();
    await expect(
      realFetch(webhookUrl, {
        method: 'POST',
        headers: { 'x-discord-gateway-token': BOT_TOKEN },
        body: message,
      }),
    ).rejects.toThrow();
  });
});
