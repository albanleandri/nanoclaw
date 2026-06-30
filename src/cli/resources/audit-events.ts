import { listCapabilityAuditEvents } from '../../audit/capability-events.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function scope(args: Record<string, unknown>, ctx: CallerContext): string {
  const requested = String(args.agent_group_id ?? args['agent-group-id'] ?? '');
  if (ctx.caller === 'agent') {
    if (requested && requested !== ctx.agentGroupId) throw new Error('Cannot inspect another agent audit stream');
    return ctx.agentGroupId;
  }
  if (!requested) throw new Error('--agent-group-id is required');
  return requested;
}

registerResource({
  name: 'audit-event',
  plural: 'audit-events',
  table: 'capability_audit_events',
  description: 'Redacted append-only canonical capability invocation events.',
  idColumn: 'event_id',
  columns: [{ name: 'event_id', type: 'string', description: 'Stable event ID.' }],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List bounded redacted audit events for one agent group.',
      handler: async (args, ctx) =>
        listCapabilityAuditEvents({
          agentGroupId: scope(args, ctx),
          sessionId: args.session_id as string | undefined,
          capabilityId: args.capability_id as string | undefined,
          decision: args.decision as string | undefined,
          resultClass: args.result_class as string | undefined,
          after: args.after as string | undefined,
          before: args.before as string | undefined,
          limit: args.limit === undefined ? undefined : Number(args.limit),
        }),
    },
  },
});
