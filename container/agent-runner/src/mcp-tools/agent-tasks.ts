import fs from 'fs';
import path from 'path';

import { findByName } from '../destinations.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true });

function action(action: string, content: Record<string, unknown>, actionId = id('agent-task-action')): string {
  writeMessageOut({
    id: actionId,
    kind: 'system',
    content: JSON.stringify({ action, actionId, ...content }),
  });
  return actionId;
}

export const requestAgentTask: McpToolDefinition = {
  tool: {
    name: 'request_agent_task',
    description: 'Delegate durable work to an authorized named agent and receive correlated progress/results.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        goal: { type: 'string' },
        context: { type: 'string' },
        required_capabilities: { type: 'array', items: { type: 'string' } },
        preferred_runtime_ids: { type: 'array', items: { type: 'string' } },
        artifact_policy: { type: 'string', enum: ['summary-only', 'files', 'full-trace'] },
        parent_task_id: { type: 'string' },
        budget: {
          type: 'object',
          properties: {
            maxIterations: { type: 'integer', minimum: 1 },
            maxDurationMs: { type: 'number', minimum: 1 },
            maxCostUsd: { type: 'number', minimum: 0.000001 },
          },
        },
      },
      required: ['to', 'goal'],
    },
  },
  async handler(args) {
    const destination = findByName(String(args.to ?? ''));
    if (!destination || destination.type !== 'agent' || !destination.agentGroupId) {
      return err(`Unknown or unauthorized agent destination: ${String(args.to ?? '')}`);
    }
    const taskId = id('task');
    action(
      'request_agent_task',
      {
        taskId,
        assigneeAgentGroupId: destination.agentGroupId,
        goal: args.goal,
        context: args.context,
        requiredCapabilities: args.required_capabilities ?? [],
        preferredRuntimeIds: args.preferred_runtime_ids,
        artifactPolicy: args.artifact_policy ?? 'summary-only',
        parentTaskId: args.parent_task_id,
        budget: args.budget,
        scope: 'agent-delegation',
      },
      `agent-task-request:${taskId}`,
    );
    return ok(`Task requested (id: ${taskId}).`);
  },
};

function simpleTool(
  name: string,
  description: string,
  hostAction: string,
  properties: Record<string, object>,
  required: string[],
): McpToolDefinition {
  return {
    tool: { name, description, inputSchema: { type: 'object', properties, required } },
    async handler(args) {
      const taskId = String(args.task_id ?? '');
      if (!taskId) return err('task_id is required');
      action(hostAction, { taskId, ...args });
      return ok(`${hostAction} requested for ${taskId}.`);
    },
  };
}

export const getAgentTask = simpleTool(
  'get_agent_task',
  'Request the current status of a durable agent task.',
  'get_agent_task',
  { task_id: { type: 'string' } },
  ['task_id'],
);
export const cancelAgentTask = simpleTool(
  'cancel_agent_task',
  'Cancel a durable task requested by this agent.',
  'cancel_agent_task',
  { task_id: { type: 'string' } },
  ['task_id'],
);
export const reportAgentTaskProgress = simpleTool(
  'report_agent_task_progress',
  'Report progress for an assigned durable task.',
  'report_agent_task_progress',
  {
    task_id: { type: 'string' },
    message: { type: 'string' },
    current: { type: 'number' },
    total: { type: 'number' },
  },
  ['task_id', 'message'],
);
export const blockAgentTask = simpleTool(
  'block_agent_task',
  'Report that an assigned task is blocked.',
  'block_agent_task',
  { task_id: { type: 'string' }, reason: { type: 'string' } },
  ['task_id', 'reason'],
);
export const completeAgentTask = simpleTool(
  'complete_agent_task',
  'Complete an assigned task with a structured or textual result.',
  'complete_agent_task',
  { task_id: { type: 'string' }, result: {} },
  ['task_id'],
);
export const failAgentTask = simpleTool(
  'fail_agent_task',
  'Fail an assigned task with an explanation.',
  'fail_agent_task',
  { task_id: { type: 'string' }, error: { type: 'string' } },
  ['task_id', 'error'],
);

export const publishAgentTaskArtifact: McpToolDefinition = {
  tool: {
    name: 'publish_agent_task_artifact',
    description: 'Attach a workspace file to an assigned durable task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        path: { type: 'string' },
        filename: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['task_id', 'path'],
    },
  },
  async handler(args) {
    const source = path.isAbsolute(String(args.path))
      ? String(args.path)
      : path.resolve('/workspace/agent', String(args.path));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return err(`File not found: ${String(args.path)}`);
    const filename = String(args.filename || path.basename(source));
    if (!filename || filename !== path.basename(filename) || filename === '.' || filename === '..') {
      return err('filename is unsafe');
    }
    const actionId = id('agent-task-artifact');
    const outbox = path.join('/workspace/outbox', actionId);
    fs.mkdirSync(outbox, { recursive: true });
    fs.copyFileSync(source, path.join(outbox, filename));
    action('publish_agent_task_artifact', { taskId: args.task_id, filename, summary: args.summary }, actionId);
    return ok(`Artifact queued for task ${String(args.task_id)}.`);
  },
};

registerTools([
  requestAgentTask,
  getAgentTask,
  cancelAgentTask,
  reportAgentTaskProgress,
  blockAgentTask,
  completeAgentTask,
  failAgentTask,
  publishAgentTaskArtifact,
]);
