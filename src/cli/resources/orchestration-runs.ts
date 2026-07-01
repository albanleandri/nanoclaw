import { cancelOrchestrationExecution } from '../../orchestration/cancellation.js';
import { advancedFeatureEvalReport } from '../../orchestration/evals/report.js';
import { listOrchestrationRuns } from '../../orchestration/run-store.js';
import type { OrchestrationStatus } from '../../orchestration/types.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function scope(args: Record<string, unknown>, ctx: CallerContext): string {
  const requested = String(args.agent_group_id ?? args['agent-group-id'] ?? '');
  if (ctx.caller === 'agent') {
    if (requested && requested !== ctx.agentGroupId) throw new Error('Cannot inspect another agent orchestration run');
    return ctx.agentGroupId;
  }
  if (!requested) throw new Error('--agent-group-id is required');
  return requested;
}

registerResource({
  name: 'orchestration-run',
  plural: 'orchestration-runs',
  table: 'orchestration_runs',
  description: 'Durable runner-neutral ExecutionPlan runs.',
  idColumn: 'run_id',
  columns: [{ name: 'run_id', type: 'string', description: 'Stable orchestration run ID.' }],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List bounded orchestration run summaries for one agent group.',
      handler: async (args, ctx) => {
        const status = args.status === undefined ? undefined : String(args.status);
        if (status && !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)) {
          throw new Error('Invalid orchestration run status');
        }
        return listOrchestrationRuns({
          agentGroupId: scope(args, ctx),
          status: status as OrchestrationStatus | undefined,
          limit: args.limit === undefined ? undefined : Number(args.limit),
        });
      },
    },
    cancel: {
      access: 'open',
      description: 'Cancel an active orchestration run and all unfinished attempts.',
      args: [
        { name: 'id', type: 'string', description: 'Orchestration run ID.', required: true },
        { name: 'reason', type: 'string', description: 'Bounded operator cancellation reason.' },
      ],
      handler: async (args, ctx) => {
        const runId = String(args.id ?? '');
        if (!runId) throw new Error('--id is required');
        return cancelOrchestrationExecution({
          runId,
          agentGroupId: ctx.caller === 'agent' ? ctx.agentGroupId : undefined,
          reason: args.reason === undefined ? undefined : String(args.reason),
        });
      },
    },
    eval: {
      access: 'open',
      description: 'Show the default-off advanced-feature policy, direct baseline, and safety fixtures.',
      handler: async (args, ctx) =>
        advancedFeatureEvalReport(scope(args, ctx), args.limit === undefined ? undefined : Number(args.limit)),
    },
  },
});
