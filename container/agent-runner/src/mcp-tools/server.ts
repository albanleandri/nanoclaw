/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';
import { beginCapabilityAudit } from '../audit-emitter.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();
const CANONICAL_CAPABILITIES: Record<string, NonNullable<McpToolDefinition['audit']>> = {
  send_message: { capabilityId: 'nanoclaw.send-message', capabilityVersion: 1, sensitiveFields: ['text'] },
  send_file: { capabilityId: 'nanoclaw.send-message', capabilityVersion: 1, sensitiveFields: ['path', 'text'] },
  edit_message: { capabilityId: 'nanoclaw.send-message', capabilityVersion: 1, sensitiveFields: ['text'] },
  add_reaction: { capabilityId: 'nanoclaw.send-message', capabilityVersion: 1 },
  ask_user_question: {
    capabilityId: 'nanoclaw.send-message',
    capabilityVersion: 1,
    sensitiveFields: ['question', 'options'],
  },
  send_card: { capabilityId: 'nanoclaw.send-message', capabilityVersion: 1, sensitiveFields: ['card'] },
  schedule_task: {
    capabilityId: 'nanoclaw.schedule-task',
    capabilityVersion: 1,
    sensitiveFields: ['prompt'],
  },
  create_agent: {
    capabilityId: 'nanoclaw.manage-agents',
    capabilityVersion: 1,
    sensitiveFields: ['instructions'],
  },
  install_packages: { capabilityId: 'nanoclaw.self-modify', capabilityVersion: 1, sensitiveFields: ['packages'] },
  add_mcp_server: { capabilityId: 'nanoclaw.self-modify', capabilityVersion: 1, sensitiveFields: ['config'] },
  browse_web: { capabilityId: 'nanoclaw.browse-web', capabilityVersion: 1, sensitiveFields: ['url'] },
  start_job: { capabilityId: 'nanoclaw.manage-jobs', capabilityVersion: 1, sensitiveFields: ['params'] },
  get_job_status: { capabilityId: 'nanoclaw.manage-jobs', capabilityVersion: 1 },
  cancel_job: { capabilityId: 'nanoclaw.manage-jobs', capabilityVersion: 1 },
  request_agent_task: {
    capabilityId: 'nanoclaw.request-agent-task',
    capabilityVersion: 1,
    sensitiveFields: ['prompt', 'description', 'metadata'],
  },
  get_agent_task: { capabilityId: 'nanoclaw.get-agent-task', capabilityVersion: 1 },
  cancel_agent_task: {
    capabilityId: 'nanoclaw.cancel-agent-task',
    capabilityVersion: 1,
    sensitiveFields: ['reason'],
  },
  report_agent_task_progress: {
    capabilityId: 'nanoclaw.report-agent-task-progress',
    capabilityVersion: 1,
    sensitiveFields: ['message', 'metadata'],
  },
  block_agent_task: {
    capabilityId: 'nanoclaw.block-agent-task',
    capabilityVersion: 1,
    sensitiveFields: ['reason', 'metadata'],
  },
  complete_agent_task: {
    capabilityId: 'nanoclaw.complete-agent-task',
    capabilityVersion: 1,
    sensitiveFields: ['result', 'metadata'],
  },
  fail_agent_task: {
    capabilityId: 'nanoclaw.fail-agent-task',
    capabilityVersion: 1,
    sensitiveFields: ['error', 'reason', 'metadata'],
  },
  publish_agent_task_artifact: {
    capabilityId: 'nanoclaw.publish-agent-task-artifact',
    capabilityVersion: 1,
    sensitiveFields: ['content', 'path', 'metadata'],
  },
  session_search: {
    capabilityId: 'memory.session-search',
    capabilityVersion: 1,
    sensitiveFields: ['query'],
  },
};

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    const audit = t.audit ?? CANONICAL_CAPABILITIES[t.tool.name];
    const registered = audit
      ? {
          ...t,
          audit,
          handler: async (args: Record<string, unknown>) => {
            const invocation = beginCapabilityAudit(
              audit.capabilityId,
              audit.capabilityVersion,
              `tool:${t.tool.name}`,
              args,
              audit.sensitiveFields,
            );
            try {
              const result = await t.handler(args);
              invocation.emit(result.isError ? 'failed' : 'succeeded', 3, {
                resultClass: result.isError ? 'tool-error' : 'success',
                durationMs: Date.now() - invocation.startedAt,
              });
              return result;
            } catch (error) {
              invocation.emit('failed', 3, {
                resultClass: 'exception',
                durationMs: Date.now() - invocation.startedAt,
              });
              throw error;
            }
          },
        }
      : t;
    allTools.push(registered);
    toolMap.set(t.tool.name, registered);
  }
}

export function listRegisteredToolDefinitions(): McpToolDefinition[] {
  return [...allTools];
}

export function filterToolsByCapability(
  tools: McpToolDefinition[],
  allowedCapabilities: ReadonlySet<string>,
): McpToolDefinition[] {
  return tools.filter((tool) => tool.audit && allowedCapabilities.has(tool.audit.capabilityId));
}

export async function callRegisteredTool(name: string, args: Record<string, unknown>) {
  const tool = toolMap.get(name);
  if (!tool) return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  return tool.handler(args);
}

export async function startMcpServer(): Promise<void> {
  let allowedCapabilities = new Set<string>();
  try {
    const parsed = JSON.parse(process.env.NANOCLAW_CAPABILITIES ?? '[]') as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      allowedCapabilities = new Set(parsed);
    }
  } catch {
    log('Invalid NANOCLAW_CAPABILITIES; exposing no tools');
  }
  const exposedTools = filterToolsByCapability(allTools, allowedCapabilities);
  const exposedToolMap = new Map(exposedTools.map((tool) => [tool.tool.name, tool]));
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = exposedToolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Unauthorized tool: ${name}` }], isError: true };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${exposedTools.length} tools: ${exposedTools.map((t) => t.tool.name).join(', ')}`);
}
