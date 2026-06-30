import type { McpToolDefinition } from '../mcp-tools/types.js';
import { assertSupportedToolSchema, validateToolArguments } from './schema-validator.js';
import {
  ProtocolToolError,
  type ProtocolToolBroker,
  type ProtocolToolCall,
  type ProtocolToolDefinition,
  type ProtocolToolResult,
} from './types.js';

interface RunnerPlan {
  runtime: { runtimeId: string };
  capabilities: Array<{ id: string; adapter: string; entrypoint: string }>;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

export function createProtocolToolBroker(plan: RunnerPlan, catalog: McpToolDefinition[]): ProtocolToolBroker {
  const registered = new Map<string, McpToolDefinition>();
  for (const item of catalog) {
    if (registered.has(item.tool.name)) throw new Error(`Duplicate registered protocol tool: ${item.tool.name}`);
    registered.set(item.tool.name, item);
  }
  const grants = new Map<string, { capabilityId: string; definition: McpToolDefinition }>();
  for (const binding of plan.capabilities) {
    if (binding.adapter !== 'protocol-tool' || !binding.entrypoint.startsWith('tool:')) continue;
    const name = binding.entrypoint.slice('tool:'.length);
    const definition = registered.get(name);
    if (!definition) throw new Error(`Compiled protocol tool is not registered: ${name}`);
    if (grants.has(name)) throw new Error(`Duplicate protocol tool grant: ${name}`);
    assertSupportedToolSchema(definition.tool.inputSchema as Record<string, unknown>);
    grants.set(name, { capabilityId: binding.id, definition });
  }
  const completed = new Map<string, Promise<ProtocolToolResult>>();
  return {
    resetTurn(): void {
      completed.clear();
    },
    list(): ProtocolToolDefinition[] {
      return [...grants.entries()].map(([name, grant]) => ({
        capabilityId: grant.capabilityId,
        name,
        description: grant.definition.tool.description,
        inputSchema: grant.definition.tool.inputSchema as Record<string, unknown>,
      }));
    },
    execute(call: ProtocolToolCall): Promise<ProtocolToolResult> {
      const prior = completed.get(call.id);
      if (prior) return prior;
      const execution = (async () => {
        const grant = grants.get(call.name);
        if (!grant) throw new ProtocolToolError(`Protocol tool is not granted: ${call.name}`, 'tool_unauthorized');
        let raw: unknown;
        try {
          raw = JSON.parse(call.argumentsJson);
        } catch {
          throw new ProtocolToolError(`Invalid JSON arguments for ${call.name}`, 'tool_invalid');
        }
        let args: Record<string, unknown>;
        try {
          args = validateToolArguments(grant.definition.tool.inputSchema as Record<string, unknown>, raw);
        } catch (error) {
          throw new ProtocolToolError(
            error instanceof Error ? error.message : `Invalid arguments for ${call.name}`,
            'tool_invalid',
            { cause: error },
          );
        }
        let result;
        try {
          result = await grant.definition.handler(args);
        } catch (error) {
          throw new ProtocolToolError(
            error instanceof Error ? error.message : `Protocol tool failed: ${call.name}`,
            'tool_execution',
            { cause: error },
          );
        }
        let output = result.content.map((item) => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n');
        if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
          const marker = '\n[truncated]';
          const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(marker, 'utf8');
          output =
            Buffer.from(output)
              .subarray(0, budget)
              .toString('utf8')
              .replace(/\uFFFD$/, '') + marker;
        }
        return { callId: call.id, output, isError: result.isError === true };
      })();
      completed.set(call.id, execution);
      return execution;
    },
  };
}
