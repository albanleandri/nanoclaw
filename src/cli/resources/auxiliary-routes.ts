import { getAuxiliaryRoute, listAuxiliaryRoutes, setAuxiliaryRoute } from '../../db/auxiliary-routes.js';
import type { AuxiliaryRole, AuxiliaryTarget } from '../../auxiliary/types.js';
import { AUXILIARY_ROLES } from '../../auxiliary/types.js';
import { countSessionSearchDocuments } from '../../session-search/store.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function scopedGroup(args: Record<string, unknown>, ctx: CallerContext): string {
  const requested = (args.agent_group_id ?? args['agent-group-id']) as string | undefined;
  if (ctx.caller === 'agent') {
    if (requested && requested !== ctx.agentGroupId) throw new Error('Cannot manage another agent group');
    return ctx.agentGroupId;
  }
  if (!requested) throw new Error('--agent-group-id is required');
  return requested;
}

function role(args: Record<string, unknown>): AuxiliaryRole {
  const value = args.role as AuxiliaryRole;
  if (!(AUXILIARY_ROLES as readonly string[]).includes(value)) {
    throw new Error(`--role must be one of: ${AUXILIARY_ROLES.join(', ')}`);
  }
  return value;
}

registerResource({
  name: 'auxiliary-route',
  plural: 'auxiliary-routes',
  table: 'auxiliary_routes',
  description: 'Explicit per-agent routing for bounded, tool-free auxiliary model roles.',
  idColumn: 'role',
  columns: [{ name: 'role', type: 'string', description: 'Auxiliary role.' }],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List configured auxiliary routes for an agent group.',
      handler: async (args, ctx) => listAuxiliaryRoutes(scopedGroup(args, ctx)),
    },
    get: {
      access: 'open',
      description: 'Resolve one route; missing routes are disabled.',
      handler: async (args, ctx) => getAuxiliaryRoute(scopedGroup(args, ctx), role(args)),
    },
    set: {
      access: 'approval',
      description: 'Set a route using --kind main|endpoint-profile|agent|disabled and target IDs as required.',
      handler: async (args, ctx) => {
        const group = scopedGroup(args, ctx);
        const kind = args.kind as AuxiliaryTarget['kind'];
        let target: AuxiliaryTarget;
        if (kind === 'endpoint-profile') {
          const providerProfileId = (args.provider_profile_id ?? args['provider-profile-id']) as string;
          if (!providerProfileId) throw new Error('--provider-profile-id is required');
          target = { kind, providerProfileId, model: args.model as string | undefined };
        } else if (kind === 'agent') {
          const agentGroupId = (args.target_agent_group_id ?? args['target-agent-group-id']) as string;
          if (!agentGroupId) throw new Error('--target-agent-group-id is required');
          target = { kind, agentGroupId };
        } else if (kind === 'main' || kind === 'disabled') {
          target = { kind };
        } else {
          throw new Error('--kind must be main, endpoint-profile, agent, or disabled');
        }
        const selectedRole = role(args);
        setAuxiliaryRoute(group, selectedRole, target);
        return { role: selectedRole, target };
      },
    },
    'search-status': {
      access: 'open',
      description: 'Show indexed session-document count for an agent group.',
      handler: async (args, ctx) => {
        const agentGroupId = scopedGroup(args, ctx);
        return { agent_group_id: agentGroupId, documents: countSessionSearchDocuments(agentGroupId) };
      },
    },
  },
});
