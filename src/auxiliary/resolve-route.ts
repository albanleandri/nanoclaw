import { compileSessionRuntimePlan, type SessionRuntimePlan } from '../capabilities/session-runtime-plan.js';
import { configFromDb } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getAuxiliaryRoute } from '../db/auxiliary-routes.js';
import { getContainerConfig } from '../db/container-configs.js';
import { hasDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import { resolveEffectiveProviderConfig } from '../providers/effective-provider.js';
import { resolveEffectiveRuntimeSelection } from '../providers/effective-runtime.js';
import '../providers/runtime-descriptors/index.js';
import type { EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import { requireRuntimeDescriptor } from '../providers/runtime-descriptor-registry.js';
import type { AuxiliaryRequest, AuxiliaryTarget } from './types.js';

export interface AuxiliaryResolution {
  target: Exclude<AuxiliaryTarget, { kind: 'disabled' }>;
  runtime: EffectiveRuntimeSelection;
  plan: SessionRuntimePlan;
}

function restrictedPlan(runtime: EffectiveRuntimeSelection): SessionRuntimePlan {
  const descriptor = requireRuntimeDescriptor(runtime.runtimeId);
  return compileSessionRuntimePlan({
    runtime,
    runtimeDescriptor: descriptor,
    capabilityProfile: { requested: [], allowDegraded: [] },
    availability: { configuredMcpServers: new Set(), writableWorkspace: false },
    policy: { cliScope: 'disabled', approvalMode: 'deny', writableWorkspace: false },
  });
}

function resolveGroupRuntime(
  agentGroupId: string,
  providerProfileId?: string,
  model?: string,
): EffectiveRuntimeSelection {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Auxiliary agent group not found: ${agentGroupId}`);
  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Auxiliary container config not found: ${agentGroupId}`);
  const config = configFromDb(row, group);
  if (model) config.model = model;
  const effective = resolveEffectiveProviderConfig(
    { agent_provider: null, provider_profile_id: providerProfileId ?? null },
    config,
  );
  return resolveEffectiveRuntimeSelection(effective);
}

/**
 * Resolve the auxiliary target for a stamped request.
 *
 * The target is read ONLY from the operator-configured `auxiliary_routes` row
 * for the request's (stamped) source group and role. There is deliberately no
 * caller-supplied target override: an override would let a container select an
 * arbitrary provider profile or bypass its configured route.
 */
export function resolveAuxiliaryRoute(input: {
  request: AuxiliaryRequest;
  currentRuntime: EffectiveRuntimeSelection;
}): AuxiliaryResolution {
  const target = getAuxiliaryRoute(input.request.sourceAgentGroupId, input.request.role);
  if (target.kind === 'disabled') throw new Error(`Auxiliary role is disabled: ${input.request.role}`);
  if (target.kind === 'main') {
    return { target, runtime: input.currentRuntime, plan: restrictedPlan(input.currentRuntime) };
  }
  if (target.kind === 'endpoint-profile') {
    const runtime = resolveGroupRuntime(input.request.sourceAgentGroupId, target.providerProfileId, target.model);
    return { target, runtime, plan: restrictedPlan(runtime) };
  }
  if (target.agentGroupId === input.request.sourceAgentGroupId) {
    throw new Error('Auxiliary agent target must be a different agent group');
  }
  if (!hasDestination(input.request.sourceAgentGroupId, 'agent', target.agentGroupId)) {
    throw new Error(`No authorized agent destination for auxiliary target ${target.agentGroupId}`);
  }
  const runtime = resolveGroupRuntime(target.agentGroupId);
  return { target, runtime, plan: restrictedPlan(runtime) };
}
