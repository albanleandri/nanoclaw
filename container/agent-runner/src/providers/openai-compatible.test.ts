import { describe, expect, it } from 'bun:test';

import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ProviderEvent, ProviderStateStore } from './types.js';
import { ProtocolToolError, type ProtocolToolBroker } from '../tool-loop/types.js';

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
  protocolToolBroker?: ProtocolToolBroker,
  requestTimeoutMs?: number,
  memory?: { enabled: boolean; render(): string },
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
      toolStrategy: protocolToolBroker ? 'native' : 'none',
      authMode: 'onecli-secret',
      authRef: 'Test',
    },
    protocolToolBroker,
    requestTimeoutMs,
    memory,
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

  it('renders memory once per logical request and never stores it in transcript state', async () => {
    const bodies: any[] = [];
    const store = memoryStore();
    let renders = 0;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const query = provider(fetchMock, store, 'chat-completions', undefined, undefined, {
      enabled: true,
      render: () => `MEMORY-${++renders}`,
    }).query({
      prompt: 'first',
      cwd: '/',
      systemContext: { instructions: 'contract' },
    });
    const iterator = query.events[Symbol.asyncIterator]();
    await nextOfType(iterator, 'result');
    query.push('second');
    await nextOfType(iterator, 'result');
    query.end();
    await iterator.next();

    expect(renders).toBe(2);
    expect(bodies[0].messages[0]).toEqual({ role: 'system', content: 'contract\n\nMEMORY-1' });
    expect(bodies[1].messages[0]).toEqual({ role: 'system', content: 'contract\n\nMEMORY-2' });
    expect(store.get('transcript-v1')).not.toContain('MEMORY-');
  });

  it('reuses one memory render across a transient retry', async () => {
    const bodies: any[] = [];
    let renders = 0;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return new Response('temporarily unavailable', { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const query = provider(fetchMock, memoryStore(), 'chat-completions', undefined, undefined, {
      enabled: true,
      render: () => `RETRY_MEMORY_${++renders}`,
    }).query({ prompt: 'retry me', cwd: '/' });

    await nextOfType(query.events[Symbol.asyncIterator](), 'result');

    expect(renders).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].messages[0].content).toBe('RETRY_MEMORY_1');
    expect(bodies[1].messages[0].content).toBe('RETRY_MEMORY_1');
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

  it('preserves provider-reported token usage on terminal results', async () => {
    const fetchMock = (async () =>
      sse([
        { choices: [{ delta: { content: 'ok' } }] },
        {
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
        },
      ])) as typeof fetch;
    const query = provider(fetchMock).query({ prompt: 'hi', cwd: '/' });
    expect(await nextOfType(query.events[Symbol.asyncIterator](), 'result')).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 3, cachedTokens: 4, source: 'provider' },
    });
    query.end();
  });

  it('preserves Responses usage when text was already streamed', async () => {
    const fetchMock = (async () =>
      sse([
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 2 } } },
      ])) as typeof fetch;
    const query = provider(fetchMock, memoryStore(), 'responses').query({ prompt: 'hi', cwd: '/' });
    expect(await nextOfType(query.events[Symbol.asyncIterator](), 'result')).toMatchObject({
      text: 'ok',
      usage: { inputTokens: 8, outputTokens: 2, source: 'provider' },
    });
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

  it('executes a bounded tool call and returns its result to chat completions', async () => {
    const requests: any[] = [];
    let executions = 0;
    let memoryRenders = 0;
    const broker: ProtocolToolBroker = {
      list: () => [
        {
          capabilityId: 'nanoclaw.send-message',
          name: 'send_message',
          description: 'Send',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
      execute: async (call) => {
        executions += 1;
        return { callId: call.id, output: 'sent', isError: false };
      },
    };
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call-1', function: { name: 'send_message', arguments: '{"text":"hi"}' } },
                  ],
                },
              },
            ],
          },
        ]);
      }
      return sse([{ choices: [{ delta: { content: '<message to="default">done</message>' } }] }]);
    }) as typeof fetch;
    const instance = provider(fetchMock, memoryStore(), 'chat-completions', broker, undefined, {
      enabled: true,
      render: () => `TOOL_MEMORY_${++memoryRenders}`,
    });
    const query = instance.query({ prompt: 'send it', cwd: '/' });
    const result = await nextOfType(query.events[Symbol.asyncIterator](), 'result');
    expect(result).toMatchObject({ text: '<message to="default">done</message>' });
    expect(executions).toBe(1);
    expect(memoryRenders).toBe(1);
    expect(requests[0].messages[0].content).toContain('TOOL_MEMORY_1');
    expect(requests[1].messages[0].content).toContain('TOOL_MEMORY_1');
    expect(requests[0].tools[0].function.name).toBe('send_message');
    expect(requests[1].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call-1' })]),
    );
  });

  it('returns correlated function outputs to the Responses API', async () => {
    const requests: any[] = [];
    const broker: ProtocolToolBroker = {
      list: () => [
        {
          capabilityId: 'nanoclaw.send-message',
          name: 'send_message',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
      execute: async (call) => ({ callId: call.id, output: 'sent', isError: false }),
    };
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? new Response(
            JSON.stringify({
              output: [
                {
                  type: 'function_call',
                  call_id: 'call-r',
                  name: 'send_message',
                  arguments: '{"text":"hi"}',
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ output_text: 'done' }), {
            headers: { 'content-type': 'application/json' },
          });
    }) as typeof fetch;
    const query = provider(fetchMock, memoryStore(), 'responses', broker).query({ prompt: 'send it', cwd: '/' });
    expect(await nextOfType(query.events[Symbol.asyncIterator](), 'result')).toMatchObject({ text: 'done' });
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call-r', output: 'sent' }),
      ]),
    );
  });

  it('preserves each protocol tool failure classification as exactly one terminal error', async () => {
    for (const classification of ['tool_invalid', 'tool_unauthorized', 'tool_execution'] as const) {
      const broker: ProtocolToolBroker = {
        list: () => [
          {
            capabilityId: 'nanoclaw.send-message',
            name: 'send_message',
            inputSchema: { type: 'object' },
          },
        ],
        execute: async () => {
          throw new ProtocolToolError(`failed: ${classification}`, classification);
        },
      };
      const fetchMock = (async () =>
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call-x', function: { name: 'send_message', arguments: '{}' } }],
                },
              },
            ],
          },
        ])) as typeof fetch;

      const query = provider(fetchMock, memoryStore(), 'chat-completions', broker).query({
        prompt: 'send it',
        cwd: '/',
      });
      const iterator = query.events[Symbol.asyncIterator]();
      expect(await nextOfType(iterator, 'error')).toMatchObject({ classification, retryable: false });
      expect((await iterator.next()).done).toBe(true);
    }
  });

  it('executes multiple calls sequentially, emits liveness, and persists only final text', async () => {
    const requests: any[] = [];
    const order: string[] = [];
    const store = memoryStore();
    const broker: ProtocolToolBroker = {
      list: () => [
        {
          capabilityId: 'nanoclaw.send-message',
          name: 'send_message',
          inputSchema: { type: 'object' },
        },
      ],
      execute: async (call) => {
        order.push(call.id);
        return { callId: call.id, output: `result:${call.id}`, isError: false };
      },
    };
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call-1', function: { name: 'send_message', arguments: '{}' } },
                      { index: 1, id: 'call-2', function: { name: 'send_message', arguments: '{}' } },
                    ],
                  },
                },
              ],
            },
          ])
        : sse([{ choices: [{ delta: { content: 'final' } }] }]);
    }) as typeof fetch;
    const query = provider(fetchMock, store, 'chat-completions', broker).query({ prompt: 'run both', cwd: '/' });
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'result') {
        query.end();
      }
    }

    expect(order).toEqual(['call-1', 'call-2']);
    expect(requests[1].messages.slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'result:call-1' },
      { role: 'tool', tool_call_id: 'call-2', content: 'result:call-2' },
    ]);
    expect(events.filter((event) => event.type === 'activity')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final' }]);
    expect(JSON.parse(store.get('transcript-v1') ?? '[]')).toEqual([
      { role: 'user', content: 'run both' },
      { role: 'assistant', content: 'final' },
    ]);
  });

  it('acknowledges a queued follow-up only after its final post-tool result', async () => {
    let request = 0;
    const broker: ProtocolToolBroker = {
      list: () => [{ capabilityId: 'test', name: 'run', inputSchema: { type: 'object' } }],
      execute: async (call) => ({ callId: call.id, output: 'ok', isError: false }),
    };
    const fetchMock = (async () => {
      request += 1;
      return request % 2 === 1
        ? sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: `call-${request}`, function: { name: 'run', arguments: '{}' } }],
                  },
                },
              ],
            },
          ])
        : sse([{ choices: [{ delta: { content: `final-${request / 2}` } }] }]);
    }) as typeof fetch;
    const query = provider(fetchMock, memoryStore(), 'chat-completions', broker).query({ prompt: 'first', cwd: '/' });
    const iterator = query.events[Symbol.asyncIterator]();
    expect(await nextOfType(iterator, 'result')).toMatchObject({ text: 'final-1' });
    let acknowledged = false;
    query.push('second', () => {
      acknowledged = true;
    });
    expect(acknowledged).toBe(false);
    expect(await nextOfType(iterator, 'result')).toMatchObject({ text: 'final-2' });
    expect(acknowledged).toBe(true);
    query.end();
    expect((await iterator.next()).done).toBe(true);
  });

  it('classifies malformed calls and call-count overflow as terminal tool-loop errors', async () => {
    const broker: ProtocolToolBroker = {
      list: () => [{ capabilityId: 'test', name: 'run', inputSchema: { type: 'object' } }],
      execute: async (call) => ({ callId: call.id, output: 'ok', isError: false }),
    };
    const malformed = provider(
      (async () =>
        sse([
          {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'run', arguments: '{}' } }] } }],
          },
        ])) as typeof fetch,
      memoryStore(),
      'chat-completions',
      broker,
    ).query({ prompt: 'bad', cwd: '/' });
    const malformedIterator = malformed.events[Symbol.asyncIterator]();
    expect(await nextOfType(malformedIterator, 'error')).toMatchObject({
      classification: 'tool_invalid',
      retryable: false,
    });
    expect((await malformedIterator.next()).done).toBe(true);

    const calls = Array.from({ length: 9 }, (_, index) => ({
      index,
      id: `call-${index}`,
      function: { name: 'run', arguments: '{}' },
    }));
    const overflow = provider(
      (async () => sse([{ choices: [{ delta: { tool_calls: calls } }] }])) as typeof fetch,
      memoryStore(),
      'chat-completions',
      broker,
    ).query({ prompt: 'too many', cwd: '/' });
    const overflowIterator = overflow.events[Symbol.asyncIterator]();
    expect(await nextOfType(overflowIterator, 'error')).toMatchObject({
      classification: 'tool_loop_limit',
      retryable: false,
    });
    expect((await overflowIterator.next()).done).toBe(true);
  });

  it('stops after the iteration limit with exactly one terminal error', async () => {
    let requests = 0;
    const broker: ProtocolToolBroker = {
      list: () => [{ capabilityId: 'test', name: 'run', inputSchema: { type: 'object' } }],
      execute: async (call) => ({ callId: call.id, output: 'again', isError: false }),
    };
    const query = provider(
      (async () => {
        requests += 1;
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: `call-${requests}`, function: { name: 'run', arguments: '{}' } }],
                },
              },
            ],
          },
        ]);
      }) as typeof fetch,
      memoryStore(),
      'chat-completions',
      broker,
    ).query({ prompt: 'loop', cwd: '/' });
    const iterator = query.events[Symbol.asyncIterator]();
    expect(await nextOfType(iterator, 'error')).toMatchObject({ classification: 'tool_loop_limit' });
    expect((await iterator.next()).done).toBe(true);
    expect(requests).toBe(8);
  });

  it('times out a request once and does not acknowledge a failed turn', async () => {
    let acknowledged = false;
    const fetchMock = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    const query = provider(fetchMock, memoryStore(), 'chat-completions', undefined, 5).query({
      prompt: 'timeout',
      cwd: '/',
    });
    query.push('queued', () => {
      acknowledged = true;
    });
    const iterator = query.events[Symbol.asyncIterator]();
    const emergencyAbort = setTimeout(() => query.abort(), 100);
    const event = await nextOfType(iterator, 'error');
    clearTimeout(emergencyAbort);
    expect(event).toMatchObject({ classification: 'transient', retryable: false });
    expect(event.type === 'error' ? event.message : '').toMatch(/timed out/);
    expect(acknowledged).toBe(false);
    expect((await iterator.next()).done).toBe(true);
  });

  it('does not start a second call after the query is aborted', async () => {
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executed: string[] = [];
    const broker: ProtocolToolBroker = {
      list: () => [{ capabilityId: 'test', name: 'run', inputSchema: { type: 'object' } }],
      execute: async (call) => {
        executed.push(call.id);
        if (call.id === 'call-1') {
          startedFirst();
          await firstBlocked;
        }
        return { callId: call.id, output: 'ok', isError: false };
      },
    };
    const query = provider(
      (async () =>
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call-1', function: { name: 'run', arguments: '{}' } },
                    { index: 1, id: 'call-2', function: { name: 'run', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        ])) as typeof fetch,
      memoryStore(),
      'chat-completions',
      broker,
    ).query({ prompt: 'abort', cwd: '/' });
    const iterator = query.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const blocked = iterator.next();
    await firstStarted;
    query.abort();
    releaseFirst();
    expect((await blocked).done).toBe(true);
    expect(executed).toEqual(['call-1']);
  });
});
