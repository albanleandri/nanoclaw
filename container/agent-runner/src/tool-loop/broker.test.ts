import { describe, expect, it } from 'bun:test';

import type { McpToolDefinition } from '../mcp-tools/types.js';
import { createProtocolToolBroker } from './broker.js';
import type { ProtocolToolError } from './types.js';

function definition(counter: { calls: number }): McpToolDefinition {
  return {
    tool: {
      name: 'send_message',
      description: 'Send',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    async handler(args) {
      counter.calls += 1;
      return { content: [{ type: 'text', text: `sent:${String(args.text)}` }] };
    },
  };
}

function namedDefinition(
  name: string,
  handler: McpToolDefinition['handler'],
  inputSchema: McpToolDefinition['tool']['inputSchema'] = { type: 'object', properties: {} },
): McpToolDefinition {
  return { tool: { name, description: name, inputSchema }, handler };
}

const plan = {
  runtime: { runtimeId: 'openai-protocol-loop' },
  capabilities: [{ id: 'nanoclaw.send-message', adapter: 'protocol-tool', entrypoint: 'tool:send_message' }],
};

describe('protocol tool broker', () => {
  it('lists only plan-granted definitions and executes valid arguments', async () => {
    const counter = { calls: 0 };
    const broker = createProtocolToolBroker(plan, [definition(counter)]);
    expect(broker.list()).toEqual([
      expect.objectContaining({ capabilityId: 'nanoclaw.send-message', name: 'send_message' }),
    ]);
    await expect(
      broker.execute({ id: 'call-1', name: 'send_message', argumentsJson: '{"text":"hello"}' }),
    ).resolves.toEqual({ callId: 'call-1', output: 'sent:hello', isError: false });
    expect(counter.calls).toBe(1);
  });

  it('rejects ungranted tools and invalid arguments', async () => {
    const broker = createProtocolToolBroker(plan, [definition({ calls: 0 })]);
    await expect(broker.execute({ id: 'x', name: 'other', argumentsJson: '{}' })).rejects.toMatchObject({
      classification: 'tool_unauthorized',
    } satisfies Partial<ProtocolToolError>);
    await expect(broker.execute({ id: 'y', name: 'send_message', argumentsJson: '{}' })).rejects.toMatchObject({
      classification: 'tool_invalid',
    } satisfies Partial<ProtocolToolError>);
  });

  it('executes duplicate call ids exactly once', async () => {
    const counter = { calls: 0 };
    const broker = createProtocolToolBroker(plan, [definition(counter)]);
    const call = { id: 'same', name: 'send_message', argumentsJson: '{"text":"hello"}' };
    expect(await broker.execute(call)).toEqual(await broker.execute(call));
    expect(counter.calls).toBe(1);
    broker.resetTurn?.();
    await broker.execute(call);
    expect(counter.calls).toBe(2);
  });

  it('fails construction for duplicate catalog names, duplicate grants, and unsupported schemas', () => {
    const first = definition({ calls: 0 });
    expect(() => createProtocolToolBroker(plan, [first, first])).toThrow(/Duplicate registered protocol tool/);
    expect(() =>
      createProtocolToolBroker(
        {
          ...plan,
          capabilities: [...plan.capabilities, { ...plan.capabilities[0], id: 'duplicate' }],
        },
        [first],
      ),
    ).toThrow(/Duplicate protocol tool grant/);
    expect(() =>
      createProtocolToolBroker(plan, [
        namedDefinition('send_message', async () => ({ content: [] }), {
          type: 'object',
          properties: { text: { type: 'string', pattern: 'x' } },
        }),
      ]),
    ).toThrow(/pattern/);
  });

  it('types malformed JSON, handler failures, and MCP error results', async () => {
    const throwingPlan = {
      runtime: { runtimeId: 'openai-protocol-loop' },
      capabilities: [{ id: 'test.throw', adapter: 'protocol-tool', entrypoint: 'tool:throwing' }],
    };
    const throwing = createProtocolToolBroker(throwingPlan, [
      namedDefinition('throwing', async () => {
        throw new Error('handler exploded');
      }),
    ]);
    await expect(throwing.execute({ id: 'bad-json', name: 'throwing', argumentsJson: '{' })).rejects.toMatchObject({
      classification: 'tool_invalid',
    });
    await expect(throwing.execute({ id: 'boom', name: 'throwing', argumentsJson: '{}' })).rejects.toMatchObject({
      classification: 'tool_execution',
    });

    const errorPlan = {
      runtime: { runtimeId: 'openai-protocol-loop' },
      capabilities: [{ id: 'test.error', adapter: 'protocol-tool', entrypoint: 'tool:error_result' }],
    };
    const errorResult = createProtocolToolBroker(errorPlan, [
      namedDefinition('error_result', async () => ({
        content: [{ type: 'text', text: 'rejected' }],
        isError: true,
      })),
    ]);
    await expect(errorResult.execute({ id: 'error', name: 'error_result', argumentsJson: '{}' })).resolves.toEqual({
      callId: 'error',
      output: 'rejected',
      isError: true,
    });
  });

  it('normalizes mixed content and caps the complete result at 64 KiB with a marker', async () => {
    const outputPlan = {
      runtime: { runtimeId: 'openai-protocol-loop' },
      capabilities: [{ id: 'test.output', adapter: 'protocol-tool', entrypoint: 'tool:large_output' }],
    };
    const broker = createProtocolToolBroker(outputPlan, [
      namedDefinition('large_output', async () => ({
        content: [
          { type: 'text', text: 'x'.repeat(70 * 1024) },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
        ],
      })),
    ]);
    const result = await broker.execute({ id: 'large', name: 'large_output', argumentsJson: '{}' });
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(result.output.endsWith('\n[truncated]')).toBe(true);
  });
});
