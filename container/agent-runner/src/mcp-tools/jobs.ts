/** Provider-neutral durable job tools. */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `job-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function enqueueAction(content: Record<string, unknown>): void {
  const routing = getSessionRouting();
  writeMessageOut({
    id: generateId(),
    kind: 'system',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({
      ...content,
      platformId: routing.platform_id,
      channelType: routing.channel_type,
      threadId: routing.thread_id,
    }),
  });
}

export const startJob: McpToolDefinition = {
  tool: {
    name: 'start_job',
    description:
      'Start a durable NanoClaw host-managed job. The host sends the user-facing confirmation/progress; do not send a separate launch message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Registered job type, e.g. stock_market_screen' },
        params: { type: 'object', description: 'Job-type-specific parameters' },
      },
      required: ['type'],
    },
  },
  async handler(args) {
    const type = args.type as string | undefined;
    if (!type) return err('type is required');
    enqueueAction({ action: 'start_job', type, params: (args.params as Record<string, unknown> | undefined) ?? {} });
    return ok(
      `Job start requested for ${type}. The host will notify the user; do not send a separate launch confirmation.`,
    );
  },
};

export const getJobStatus: McpToolDefinition = {
  tool: {
    name: 'get_job_status',
    description:
      'Ask the host to report durable job status to the current conversation. job_id is optional; omit it for the latest active job in this chat.',
    inputSchema: {
      type: 'object' as const,
      properties: { job_id: { type: 'string', description: 'Optional durable job id' } },
    },
  },
  async handler(args) {
    const jobId = args.job_id as string | undefined;
    enqueueAction({ action: 'get_job_status', ...(jobId ? { jobId } : {}) });
    return ok('Job status requested. The host will reply to the user.');
  },
};

export const cancelJob: McpToolDefinition = {
  tool: {
    name: 'cancel_job',
    description:
      'Ask the host to cancel a durable job. job_id is optional; omit it for the latest active job in this chat.',
    inputSchema: {
      type: 'object' as const,
      properties: { job_id: { type: 'string', description: 'Optional durable job id' } },
    },
  },
  async handler(args) {
    const jobId = args.job_id as string | undefined;
    enqueueAction({ action: 'cancel_job', ...(jobId ? { jobId } : {}) });
    return ok('Cancellation requested. The host will reply to the user.');
  },
};

registerTools([startJob, getJobStatus, cancelJob]);
