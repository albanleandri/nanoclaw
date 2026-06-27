import { describe, expect, it } from 'bun:test';

import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ProviderEvent, ProviderStateStore } from './types.js';

function memoryStore(): ProviderStateStore {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  };
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function provider(
  httpFetch: typeof fetch,
  store = memoryStore(),
  apiFamily: 'responses' | 'chat-completions' = 'chat-completions',
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    model: 'test-model',
    runtimeStateKey: 'profile:test:abc',
    stateStore: store,
    httpFetch,
    providerProfile: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiFamily,
      toolStrategy: 'none',
      authMode: 'onecli-secret',
      authRef: 'Test',
    },
  });
}

async function nextOfType(iterator: AsyncIterator<ProviderEvent>, type: ProviderEvent['type']): Promise<ProviderEvent> {
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error(`stream ended before ${type}`);
    if (next.value.type === type) return next.value;
  }
}

describe('OpenAICompatibleProvider', () => {
  it('streams chat completions, sends system context, and acknowledges queued follow-ups after results', async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const text = bodies.length === 1 ? 'first' : 'second';
      return sse([{ choices: [{ delta: { content: `<message to="default">${text}</message>` } }] }]);
    }) as typeof fetch;
    const query = provider(fetchMock).query({
      prompt: 'hello',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'system contract' },
    });
    const iterator = query.events[Symbol.asyncIterator]();
    const first = await nextOfType(iterator, 'result');
    expect(first).toMatchObject({ type: 'result', text: '<message to="default">first</message>' });
    let acknowledged = false;
    query.push('again', () => {
      acknowledged = true;
    });
    expect(acknowledged).toBe(false);
    await nextOfType(iterator, 'result');
    expect(acknowledged).toBe(true);
    query.end();
    await iterator.next();

    expect(bodies[0].messages[0]).toEqual({ role: 'system', content: 'system contract' });
    expect(bodies[1].messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '<message to="default">first</message>' },
        { role: 'user', content: 'again' },
      ]),
    );
  });

  it('replays bounded transcript state after provider recreation', async () => {
    const store = memoryStore();
    const requests: any[] = [];
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const firstQuery = provider(fetchMock, store).query({ prompt: 'one', cwd: '/' });
    const firstIterator = firstQuery.events[Symbol.asyncIterator]();
    await nextOfType(firstIterator, 'result');
    firstQuery.end();
    await firstIterator.next();

    const secondQuery = provider(fetchMock, store).query({ prompt: 'two', cwd: '/' });
    const secondIterator = secondQuery.events[Symbol.asyncIterator]();
    await nextOfType(secondIterator, 'result');
    secondQuery.end();
    expect(requests[1].messages.slice(0, 3)).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
    ]);
  });

  it('supports Responses API deltas', async () => {
    const fetchMock = (async () =>
      sse([
        { type: 'response.output_text.delta', delta: 'hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
      ])) as typeof fetch;
    const query = provider(fetchMock, memoryStore(), 'responses').query({ prompt: 'hi', cwd: '/' });
    const iterator = query.events[Symbol.asyncIterator]();
    expect(await nextOfType(iterator, 'result')).toMatchObject({ text: 'hello' });
    query.end();
  });

  it('classifies authentication errors without storing a transcript', async () => {
    const store = memoryStore();
    const fetchMock = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as typeof fetch;
    const query = provider(fetchMock, store).query({ prompt: 'hi', cwd: '/' });
    const iterator = query.events[Symbol.asyncIterator]();
    expect(await nextOfType(iterator, 'error')).toMatchObject({
      type: 'error',
      classification: 'auth',
      retryable: false,
    });
    expect(store.get('transcript-v1')).toBeUndefined();
  });

  it('treats an empty successful response as a terminal error', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const query = provider(fetchMock).query({ prompt: 'hi', cwd: '/' });
    expect(await nextOfType(query.events[Symbol.asyncIterator](), 'error')).toMatchObject({
      classification: 'invalid_request',
    });
  });
});
