import type { ContainerConfig } from '../container-config.js';
import type { EffectiveProviderConfig } from '../providers/effective-provider.js';
import type { EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import type { AgentRuntimeDescriptor } from '../providers/runtime-descriptor.js';
import { applyToolGating, buildAvailabilityContext, deriveCapabilityProfile } from './spawn-gate.js';
import { compileSessionRuntimePlan, type SessionRuntimePlan } from './session-runtime-plan.js';

export interface CompiledSessionPlan {
  compiledPlan: SessionRuntimePlan;
  materializedPlan?: SessionRuntimePlan;
  gatedConfig: ContainerConfig;
}

export function compileEffectiveSessionPlan(input: {
  config: ContainerConfig;
  effectiveProvider: EffectiveProviderConfig;
  runtime: EffectiveRuntimeSelection;
  runtimeDescriptor: AgentRuntimeDescriptor;
  requiredCapabilities?: string[];
}): CompiledSessionPlan {
  const profile = deriveCapabilityProfile(input.config);
  for (const capability of input.requiredCapabilities ?? []) {
    if (!profile.requested.includes(capability)) profile.requested.push(capability);
  }
  const compiledPlan = compileSessionRuntimePlan({
    runtime: input.runtime,
    runtimeDescriptor: input.runtimeDescriptor,
    capabilityProfile: profile,
    availability: buildAvailabilityContext(input.config),
    endpointCapabilities: input.effectiveProvider.capabilities,
    policy: {
      cliScope: input.config.cliScope ?? 'group',
      approvalMode: 'default',
      writableWorkspace: true,
    },
  });
  let materializedPlan: SessionRuntimePlan | undefined;
  if (input.runtimeDescriptor.kind === 'protocol-loop' && input.effectiveProvider.profile?.toolStrategy === 'native') {
    const capabilities = compiledPlan.capabilities.filter((item) => item.adapter === 'protocol-tool');
    if (capabilities.length === 0) {
      throw new Error(`Verified protocol runtime ${input.runtimeDescriptor.id} compiled no protocol tool bindings`);
    }
    materializedPlan = { ...compiledPlan, capabilities };
  }
  return {
    compiledPlan,
    materializedPlan,
    gatedConfig: applyToolGating(input.config, input.runtimeDescriptor),
  };
}
