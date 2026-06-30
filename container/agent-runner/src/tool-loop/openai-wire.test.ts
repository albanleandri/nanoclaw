import { describe, expect, it } from 'bun:test';

import { readProtocolIteration, toolResultItems, toolSchemasForFamily } from './openai-wire.js';

const tools = [{ capabilityId: 'x', name: 'send_message', description: 'Send', inputSchema: { type: 'object' } }];

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('OpenAI protocol wire codecs', () => {
  it('translates tool schemas for both API families', () => {
    expect(toolSchemasForFamily('responses', tools)[0]).toMatchObject({ type: 'function', name: 'send_message' });
    expect(toolSchemasForFamily('chat-completions', tools)[0]).toMatchObject({
      type: 'function',
      function: { name: 'send_message' },
    });
  });

  it('assembles streamed chat tool call deltas', async () => {
    const result = await readProtocolIteration(
      sse([
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'send_message', arguments: '{"te' } }] } },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] } }] },
      ]),
      'chat-completions',
    );
    expect(result).toMatchObject({
      kind: 'tool-calls',
      calls: [{ id: 'c1', name: 'send_message', argumentsJson: '{"text":"hi"}' }],
    });
    expect(result.kind === 'tool-calls' ? result.continuationItems : []).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'send_message', arguments: '{"text":"hi"}' },
          },
        ],
      },
    ]);
    expect(toolResultItems('chat-completions', [{ callId: 'c1', output: 'sent' }])).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ]);
  });

  it('prefers tool calls when chat content and calls arrive in separate chunks', async () => {
    const result = await readProtocolIteration(
      sse([
        { choices: [{ delta: { content: 'working' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c1', function: { name: 'send_message', arguments: '{}' } }],
              },
            },
          ],
        },
      ]),
      'chat-completions',
    );
    expect(result.kind).toBe('tool-calls');
  });

  it('assembles streamed Responses function calls', async () => {
    const result = await readProtocolIteration(
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'c1', name: 'send_message', arguments: '' },
        },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"text":"hi"}' },
      ]),
      'responses',
    );
    expect(result).toMatchObject({
      kind: 'tool-calls',
      calls: [{ id: 'c1', name: 'send_message', argumentsJson: '{"text":"hi"}' }],
    });
    expect(result.kind === 'tool-calls' ? result.continuationItems : []).toEqual([
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'send_message',
        arguments: '{"text":"hi"}',
      },
    ]);
    expect(toolResultItems('responses', [{ callId: 'c1', output: 'sent' }])).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'sent' },
    ]);
  });

  it('supports non-stream and completed-event Responses function calls', async () => {
    const responsePayload = {
      output: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'send_message',
          arguments: '{"text":"hi"}',
        },
      ],
    };
    const nonStream = await readProtocolIteration(
      new Response(JSON.stringify(responsePayload), { headers: { 'content-type': 'application/json' } }),
      'responses',
    );
    expect(nonStream).toMatchObject({ kind: 'tool-calls', calls: [{ id: 'c1' }] });

    const completed = await readProtocolIteration(
      sse([{ type: 'response.completed', response: responsePayload }]),
      'responses',
    );
    expect(completed).toMatchObject({ kind: 'tool-calls', calls: [{ id: 'c1' }] });
  });

  it('rejects malformed SSE, missing IDs, and invalid argument JSON as tool_invalid', async () => {
    const malformedJson = new Response('data: {broken}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    await expect(readProtocolIteration(malformedJson, 'chat-completions')).rejects.toMatchObject({
      classification: 'tool_invalid',
    });
    await expect(
      readProtocolIteration(
        sse([
          {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'send_message', arguments: '{}' } }] } }],
          },
        ]),
        'chat-completions',
      ),
    ).rejects.toMatchObject({ classification: 'tool_invalid' });
    await expect(
      readProtocolIteration(
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'c1', function: { name: 'send_message', arguments: '{' } }],
                },
              },
            ],
          },
        ]),
        'chat-completions',
      ),
    ).rejects.toMatchObject({ classification: 'tool_invalid' });
  });
});
