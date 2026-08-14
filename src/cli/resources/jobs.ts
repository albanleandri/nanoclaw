import { cancelJob, startJob } from '../../jobs/runner.js';
import { getJob, listRecentJobs } from '../../db/jobs.js';
import { getJobType } from '../../jobs/registry.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function groupId(args: Record<string, unknown>, ctx: CallerContext): string {
  const requested = String(args.agent_group_id ?? '');
  if (ctx.caller === 'agent') {
    if (requested && requested !== ctx.agentGroupId) throw new Error('Cannot manage another agent group job');
    return ctx.agentGroupId;
  }
  if (!requested) throw new Error('--agent-group-id is required');
  return requested;
}

function params(value: unknown): unknown {
  if (value === undefined) return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error('--params must be valid JSON', { cause: error });
  }
}

function activeJob(agentGroupId: string, type: string) {
  return listRecentJobs({ agentGroupId, limit: 100 }).find(
    (job) => job.type === type && (job.status === 'queued' || job.status === 'running'),
  );
}

registerResource({
  name: 'job',
  plural: 'jobs',
  table: 'jobs',
  description: 'Durable host-managed background jobs.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Job ID.' },
    { name: 'agent_group_id', type: 'string', description: 'Owning agent group.' },
  ],
  operations: {},
  customOperations: {
    start: {
      access: 'open',
      description:
        'Start a durable host job. By default, return the existing active job of the same type instead of duplicating it.',
      args: [
        { name: 'type', type: 'string', description: 'Registered durable job type.', required: true },
        { name: 'params', type: 'json', description: 'Job parameters as JSON.', default: {} },
        { name: 'agent_group_id', type: 'string', description: 'Owning group; inferred for agent callers.' },
        { name: 'allow_duplicate', type: 'boolean', description: 'Permit another active job of the same type.' },
      ],
      examples: ['ncl jobs start --type stock_market_screen --params \'{"marketCaps":["Mega Cap","Large Cap"]}\''],
      handler: async (args, ctx) => {
        const agentGroupId = groupId(args, ctx);
        const type = String(args.type ?? '').trim();
        if (!type || !getJobType(type)) throw new Error(`Unknown job type: ${type}`);
        const allowDuplicate = args.allow_duplicate === true || args.allow_duplicate === 'true';
        const active = allowDuplicate ? undefined : activeJob(agentGroupId, type);
        if (active) return { ...active, reused: true };
        return {
          ...startJob({
            type,
            params: params(args.params),
            agentGroupId,
            sessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
            requestedBy: ctx.caller === 'agent' ? ctx.agentGroupId : 'host-cli',
          }),
          reused: false,
        };
      },
    },
    list: {
      access: 'open',
      description: 'List recent durable jobs for one agent group.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Owning group; inferred for agent callers.' },
        { name: 'limit', type: 'number', description: 'Maximum rows.' },
      ],
      handler: async (args, ctx) =>
        listRecentJobs({
          agentGroupId: groupId(args, ctx),
          limit: args.limit === undefined ? 20 : Number(args.limit),
        }),
    },
    get: {
      access: 'open',
      description: 'Get one durable job owned by the caller group.',
      args: [{ name: 'id', type: 'string', description: 'Job ID.', required: true }],
      handler: async (args, ctx) => {
        const job = getJob(String(args.id));
        if (!job || (ctx.caller === 'agent' && job.agent_group_id !== ctx.agentGroupId)) {
          throw new Error(`Job not found: ${String(args.id)}`);
        }
        return job;
      },
    },
    cancel: {
      access: 'open',
      description: 'Cancel one active durable job owned by the caller group.',
      args: [{ name: 'id', type: 'string', description: 'Job ID.', required: true }],
      handler: async (args, ctx) => {
        const id = String(args.id);
        const job = getJob(id);
        if (!job || (ctx.caller === 'agent' && job.agent_group_id !== ctx.agentGroupId)) {
          throw new Error(`Job not found: ${id}`);
        }
        return cancelJob(id);
      },
    },
  },
});
