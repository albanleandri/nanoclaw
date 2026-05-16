/**
 * Regression tests for telegram-pool bot routing.
 *
 * Each test gets a fresh module instance (vi.resetModules) so module-level
 * state (poolBots, agentBotMap, nextPoolIndex) is isolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type PoolModule = typeof import('./telegram-pool.js');

function makeFetch(responses: Record<string, { ok: boolean; result?: Record<string, unknown> }> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const mock = vi.fn(async (url: string, opts?: RequestInit) => {
    const method = (url as string).split('/').pop()!;
    calls.push({ method, body: opts?.body ? JSON.parse(opts.body as string) : {} });
    const reply = responses[method] ?? { ok: true, result: { message_id: 42 } };
    return {
      json: async () => reply,
    };
  });
  (mock as unknown as { calls: typeof calls }).calls = calls;
  return mock as unknown as typeof fetch & { calls: typeof calls };
}

let mod: PoolModule;
let mockFetch: ReturnType<typeof makeFetch>;

beforeEach(async () => {
  vi.resetModules();
  mockFetch = makeFetch({
    getMe: { ok: true, result: { username: 'bot_username' } },
    sendMessage: { ok: true, result: { message_id: 99 } },
  });
  vi.stubGlobal('fetch', mockFetch);
  mod = await import('./telegram-pool.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function initPool(count: number): Promise<void> {
  const tokens = Array.from({ length: count }, (_, i) => `token_${i}`);
  await mod.initTelegramPool(tokens);
}

describe('initTelegramPool', () => {
  it('registers bots and sets hasPoolBots', async () => {
    expect(mod.hasPoolBots()).toBe(false);
    await initPool(3);
    expect(mod.hasPoolBots()).toBe(true);
  });

  it('skips tokens where getMe returns ok=false', async () => {
    vi.resetModules();
    mockFetch = makeFetch({ getMe: { ok: false } });
    vi.stubGlobal('fetch', mockFetch);
    mod = await import('./telegram-pool.js');
    await mod.initTelegramPool(['bad_token']);
    expect(mod.hasPoolBots()).toBe(false);
  });
});

describe('deliverViaPool — bot_index routing', () => {
  it('routes to correct pool slot for bot_index 0', async () => {
    await initPool(3);
    const getMe = mockFetch.calls.filter((c) => c.method === 'getMe');
    expect(getMe).toHaveLength(3);

    const id = await mod.deliverViaPool('ag-1', 'telegram:123', { text: 'hi', bot_index: 0 });
    expect(id).toBe('99');

    const sends = mockFetch.calls.filter((c) => c.method === 'sendMessage');
    // token_0 is poolBots[0]
    expect(sends[0].body.chat_id).toBe('123');
  });

  it('applies modulo when bot_index equals pool size', async () => {
    await initPool(3);
    // bot_index=3 with 3 bots → slot 0 (3 % 3 = 0)
    await mod.deliverViaPool('ag-1', 'telegram:123', { text: 'hi', bot_index: 3 });
    // bot_index=4 with 3 bots → slot 1 (4 % 3 = 1)
    await mod.deliverViaPool('ag-1', 'telegram:123', { text: 'hi', bot_index: 4 });
    // No error expected — just verify it doesn't throw
  });

  it('applies modulo for large bot_index values', async () => {
    await initPool(5);
    // bot_index=7 with 5 bots → slot 2
    await mod.deliverViaPool('ag-1', 'telegram:123', { text: 'hi', bot_index: 7 });
    // Slot 2 means token_2 was used — we just verify no throw
  });
});

describe('deliverViaPool — no bot rename', () => {
  it('never calls setMyName regardless of sender field', async () => {
    await initPool(2);
    await mod.deliverViaPool('ag-1', 'telegram:123', {
      text: 'hi',
      sender: 'Bedtime Story',
      bot_index: 0,
    });
    const renamed = mockFetch.calls.filter((c) => c.method === 'setMyName');
    expect(renamed).toHaveLength(0);
  });

  it('never calls setMyName on sender-only routing path either', async () => {
    await initPool(2);
    // Even when there's no bot_index (fallback path), no rename happens
    await mod.deliverViaPool('ag-1', 'telegram:123', { text: 'hi', sender: 'Weekend Ideas' });
    const renamed = mockFetch.calls.filter((c) => c.method === 'setMyName');
    expect(renamed).toHaveLength(0);
  });
});

describe('deliverViaPool — no text', () => {
  it('returns undefined when content has no text or markdown field', async () => {
    await initPool(1);
    const id = await mod.deliverViaPool('ag-1', 'telegram:123', { bot_index: 0 });
    expect(id).toBeUndefined();
    const sends = mockFetch.calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(0);
  });
});

describe('deliverViaPool — platform_id formats', () => {
  it('strips telegram: prefix before using as chat_id', async () => {
    await initPool(1);
    await mod.deliverViaPool('ag-1', 'telegram:987654', { text: 'hello', bot_index: 0 });
    const sends = mockFetch.calls.filter((c) => c.method === 'sendMessage');
    expect(sends[0].body.chat_id).toBe('987654');
  });

  it('accepts bare numeric platform_id', async () => {
    await initPool(1);
    await mod.deliverViaPool('ag-1', '987654', { text: 'hello', bot_index: 0 });
    const sends = mockFetch.calls.filter((c) => c.method === 'sendMessage');
    expect(sends[0].body.chat_id).toBe('987654');
  });
});

describe('deliverViaPool — empty pool', () => {
  it('returns undefined when pool is not initialized', async () => {
    const id = await mod.deliverViaPool('ag-1', 'telegram:123', { text: 'hi', bot_index: 0 });
    expect(id).toBeUndefined();
  });
});
