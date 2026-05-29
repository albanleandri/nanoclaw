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
    description: 'Start a durable NanoClaw host-managed job. Returns after the host accepts the request.',
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
    return ok(`Job start requested for ${type}. The host will send the job id and progress updates.`);
  },
};

export const getJobStatus: McpToolDefinition = {
  tool: {
    name: 'get_job_status',
    description: 'Ask the host to report durable job status to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: { job_id: { type: 'string', description: 'Durable job id' } },
      required: ['job_id'],
    },
  },
  async handler(args) {
    const jobId = args.job_id as string | undefined;
    if (!jobId) return err('job_id is required');
    enqueueAction({ action: 'get_job_status', jobId });
    return ok(`Job status requested for ${jobId}.`);
  },
};

export const cancelJob: McpToolDefinition = {
  tool: {
    name: 'cancel_job',
    description: 'Ask the host to cancel a durable job.',
    inputSchema: {
      type: 'object' as const,
      properties: { job_id: { type: 'string', description: 'Durable job id' } },
      required: ['job_id'],
    },
  },
  async handler(args) {
    const jobId = args.job_id as string | undefined;
    if (!jobId) return err('job_id is required');
    enqueueAction({ action: 'cancel_job', jobId });
    return ok(`Cancellation requested for ${jobId}.`);
  },
};

registerTools([startJob, getJobStatus, cancelJob]);
