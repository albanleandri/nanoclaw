import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { listRegisteredToolDefinitions } from '../mcp-tools/catalog.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { ProviderEvent, ProviderStateStore } from '../providers/types.js';
import { createProtocolToolBroker } from './broker.js';

const protocolToolContract = JSON.parse(
  readFileSync(new URL('../../../../contracts/protocol-tools.json', import.meta.url), 'utf8'),
) as Array<{ capabilityId: string; toolName: string }>;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY,
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT
    )`,
  );
  getInboundDb()
    .prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'telegram', 'chat-1', 'thread-1')`,
    )
    .run();
});
afterEach(() => closeSessionDb());

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
    headers: { 'content-type': 'text/event-stream' },
  });
}

function sendMessageBroker() {
  return createProtocolToolBroker(
    {
      runtime: { runtimeId: 'openai-protocol-loop' },
      capabilities: [{ id: 'nanoclaw.send-message', adapter: 'protocol-tool', entrypoint: 'tool:send_message' }],
    },
    listRegisteredToolDefinitions(),
  );
}

function externalMessages() {
  return getUndeliveredMessages().filter((message) => message.kind !== 'system');
}

async function collectToResult(provider: OpenAICompatibleProvider): Promise<ProviderEvent[]> {
  const query = provider.query({ prompt: 'send hello', cwd: '/' });
  const events: ProviderEvent[] = [];
  for await (const event of query.events) {
    events.push(event);
    if (event.type === 'result' || event.type === 'error') {
      query.end();
    }
  }
  return events;
}

describe('protocol tool conformance', () => {
  it('implements every host protocol-tool contract entry in the runner catalog', () => {
    const registered = new Set(listRegisteredToolDefinitions().map((definition) => definition.tool.name));
    for (const binding of protocolToolContract)
      expect(registered.has(binding.toolName), binding.capabilityId).toBe(true);
    const broker = createProtocolToolBroker(
      {
        runtime: { runtimeId: 'openai-protocol-loop' },
        capabilities: protocolToolContract.map((binding) => ({
          id: binding.capabilityId,
          adapter: 'protocol-tool',
          entrypoint: `tool:${binding.toolName}`,
        })),
      },
      listRegisteredToolDefinitions(),
    );
    expect(
      broker
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(protocolToolContract.map((binding) => binding.toolName).sort());
  });

  it('routes the compiled send-message capability through the existing handler', async () => {
    const broker = sendMessageBroker();
    await broker.execute({ id: 'call-1', name: 'send_message', argumentsJson: '{"text":"hello"}' });
    const [out] = externalMessages();
    expect(out).toMatchObject({ channel_type: 'telegram', platform_id: 'chat-1', thread_id: 'thread-1' });
    expect(JSON.parse(out.content).text).toBe('hello');
  });

  it('does not expose an ungranted registered tool', async () => {
    const broker = sendMessageBroker();
    expect(broker.list().map((tool) => tool.name)).not.toContain('schedule_task');
    await expect(
      broker.execute({ id: 'schedule', name: 'schedule_task', argumentsJson: '{"prompt":"x","processAfter":"x"}' }),
    ).rejects.toMatchObject({ classification: 'tool_unauthorized' });
  });

  for (const family of ['chat-completions', 'responses'] as const) {
    it(`executes the actual send_message handler through the ${family} provider loop`, async () => {
      const requests: any[] = [];
      const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length === 1) {
          return family === 'chat-completions'
            ? sse([
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call-1',
                            function: { name: 'send_message', arguments: '{"text":"hello"}' },
                          },
                        ],
                      },
                    },
                  ],
                },
              ])
            : sse([
                {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: {
                    type: 'function_call',
                    call_id: 'call-1',
                    name: 'send_message',
                    arguments: '{"text":"hello"}',
                  },
                },
              ]);
        }
        return family === 'chat-completions'
          ? sse([{ choices: [{ delta: { content: 'done' } }] }])
          : sse([{ type: 'response.output_text.delta', delta: 'done' }]);
      }) as typeof fetch;
      const provider = new OpenAICompatibleProvider({
        model: 'test',
        stateStore: memoryStore(),
        httpFetch: fetchMock,
        providerProfile: {
          id: 'test',
          name: 'test',
          protocol: 'openai-compatible',
          baseUrl: 'https://example.test',
          apiFamily: family,
          toolStrategy: 'native',
          authMode: 'none',
        },
        protocolToolBroker: sendMessageBroker(),
      });

      const events = await collectToResult(provider);
      expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'done' }]);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(requests[0].tools[0]).toBeDefined();
      const [out] = externalMessages();
      expect(out).toMatchObject({ channel_type: 'telegram', platform_id: 'chat-1', thread_id: 'thread-1' });
      expect(JSON.parse(out.content).text).toBe('hello');
    });
  }

  it('suppresses duplicate provider call IDs before the external write', async () => {
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'same', function: { name: 'send_message', arguments: '{"text":"once"}' } },
                      { index: 1, id: 'same', function: { name: 'send_message', arguments: '{"text":"once"}' } },
                    ],
                  },
                },
              ],
            },
          ])
        : sse([{ choices: [{ delta: { content: 'done' } }] }]);
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      model: 'test',
      stateStore: memoryStore(),
      httpFetch: fetchMock,
      providerProfile: {
        id: 'test',
        name: 'test',
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test',
        apiFamily: 'chat-completions',
        toolStrategy: 'native',
        authMode: 'none',
      },
      protocolToolBroker: sendMessageBroker(),
    });
    await collectToResult(provider);
    expect(externalMessages()).toHaveLength(1);
  });

  it('keeps an unverified generic profile schema-free and unable to execute tools', async () => {
    let requestBody: any;
    const provider = new OpenAICompatibleProvider({
      model: 'test',
      stateStore: memoryStore(),
      httpFetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return sse([{ choices: [{ delta: { content: 'text only' } }] }]);
      }) as typeof fetch,
      providerProfile: {
        id: 'test',
        name: 'test',
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test',
        apiFamily: 'chat-completions',
        toolStrategy: 'none',
        authMode: 'none',
      },
    });
    expect(await collectToResult(provider)).toContainEqual({ type: 'result', text: 'text only' });
    expect(requestBody.tools).toBeUndefined();
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
