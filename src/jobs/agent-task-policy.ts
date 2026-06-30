import { compileEffectiveSessionPlan } from '../capabilities/compile-session-plan.js';
import type { SessionRuntimePlan } from '../capabilities/session-runtime-plan.js';
import { configFromDb } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { hasDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import { resolveEffectiveProviderConfig } from '../providers/effective-provider.js';
import { assertRuntimeSelectionParity, resolveEffectiveRuntimeSelection } from '../providers/effective-runtime.js';
import type { EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import { getRuntimeDescriptorByContainerFactory } from '../providers/runtime-descriptor-registry.js';
import { validateAgentTaskEnvelope, type AgentTaskEnvelope } from './agent-task-envelope.js';

export interface AgentTaskAdmission {
  envelope: AgentTaskEnvelope;
  assigneeAgentGroupId: string;
  runtime: EffectiveRuntimeSelection;
  plan: SessionRuntimePlan;
  preferredRuntimeMatched: boolean | undefined;
}

export function authorizeAgentTask(input: {
  actorAgentGroupId: string;
  envelope: AgentTaskEnvelope;
}): AgentTaskAdmission {
  const envelope = validateAgentTaskEnvelope(input.envelope, {
    requesterAgentGroupId: input.actorAgentGroupId,
  });
  if (
    envelope.assigneeAgentGroupId !== input.actorAgentGroupId &&
    !hasDestination(input.actorAgentGroupId, 'agent', envelope.assigneeAgentGroupId)
  ) {
    throw new Error(`Requester has no agent destination for ${envelope.assigneeAgentGroupId}`);
  }
  const group = getAgentGroup(envelope.assigneeAgentGroupId);
  if (!group) throw new Error(`Assignee agent group not found: ${envelope.assigneeAgentGroupId}`);
  const row = getContainerConfig(group.id);
  if (!row) throw new Error(`Assignee container config not found: ${group.id}`);
  const config = configFromDb(row, group);
  const effectiveProvider = resolveEffectiveProviderConfig({ agent_provider: null, provider_profile_id: null }, config);
  const runtime = resolveEffectiveRuntimeSelection(effectiveProvider);
  assertRuntimeSelectionParity(effectiveProvider, runtime);
  const runtimeDescriptor = getRuntimeDescriptorByContainerFactory(effectiveProvider.provider);
  if (!runtimeDescriptor) throw new Error(`Assignee runtime is not installed: ${effectiveProvider.provider}`);
  const planned = compileEffectiveSessionPlan({
    config,
    effectiveProvider,
    runtime,
    runtimeDescriptor,
    requiredCapabilities: envelope.requiredCapabilities,
  });
  for (const required of envelope.requiredCapabilities) {
    if (!planned.compiledPlan.capabilities.some((item) => item.id === required)) {
      throw new Error(`Assignee runtime did not compile required capability ${required}`);
    }
  }
  return {
    envelope,
    assigneeAgentGroupId: group.id,
    runtime,
    plan: planned.compiledPlan,
    preferredRuntimeMatched: envelope.preferredRuntimeIds?.includes(runtime.runtimeId),
  };
}
