import { getContainerConfig } from '../../db/container-configs.js';
import { grantScheduleAdmin, listScheduleAdminGrants, revokeScheduleAdmin } from '../../db/schedule-admin-grants.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function requireGlobal(ctx: CallerContext): void {
  if (ctx.caller === 'host') return;
  if (getContainerConfig(ctx.agentGroupId)?.cli_scope !== 'global') {
    throw new Error('Schedule admin grants require global CLI scope');
  }
}

registerResource({
  name: 'schedule-admin-grant',
  plural: 'schedule-admin-grants',
  table: 'schedule_admin_grants',
  description: 'Authorize one agent group to administer recurring tasks owned by another group.',
  idColumn: 'admin_agent_group_id',
  columns: [
    { name: 'admin_agent_group_id', type: 'string', description: 'Administrative agent group.' },
    { name: 'owner_agent_group_id', type: 'string', description: 'Task-owning agent group.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List schedule admin grants (global operators only).',
      handler: async (_args, ctx) => {
        requireGlobal(ctx);
        return listScheduleAdminGrants();
      },
    },
    grant: {
      access: 'approval',
      description: 'Grant access. Requires --admin-agent-group-id and --owner-agent-group-id.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const admin = (args['admin-agent-group-id'] ?? args.admin_agent_group_id) as string;
        const owner = (args['owner-agent-group-id'] ?? args.owner_agent_group_id) as string;
        if (!admin || !owner) throw new Error('--admin-agent-group-id and --owner-agent-group-id are required');
        return grantScheduleAdmin(admin, owner, ctx.caller === 'agent' ? ctx.agentGroupId : 'host');
      },
    },
    revoke: {
      access: 'approval',
      description: 'Revoke access. Requires --admin-agent-group-id and --owner-agent-group-id.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const admin = (args['admin-agent-group-id'] ?? args.admin_agent_group_id) as string;
        const owner = (args['owner-agent-group-id'] ?? args.owner_agent_group_id) as string;
        if (!admin || !owner) throw new Error('--admin-agent-group-id and --owner-agent-group-id are required');
        return { revoked: revokeScheduleAdmin(admin, owner) };
      },
    },
  },
});
