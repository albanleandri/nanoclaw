import type { InstructionSection } from '../instruction-sections.js';
import type { ProviderCapabilities } from '../providers/provider-descriptor.js';
import type { AgentRuntimeDescriptor, EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import type { AvailabilityContext } from './availability.js';
import './builtins/index.js';
import type { CapabilityAdapterKind } from './capability-manifest.js';
import { requireCapability } from './capability-registry.js';
import { resolveCapabilitySupport } from './resolve-support.js';

export interface AgentCapabilityProfile {
  requested: string[];
  allowDegraded: string[];
}

export interface SessionRuntimePlan {
  orchestration?: { runId: string; stepId: string; roleId: string };
  runtime: EffectiveRuntimeSelection;
  capabilities: Array<{ id: string; adapter: CapabilityAdapterKind; entrypoint: string }>;
  rejectedCapabilities: Array<{ id: string; reason: string; required: boolean }>;
  policy: {
    cliScope: 'disabled' | 'group' | 'global';
    approvalMode: string;
    writableWorkspace: boolean;
  };
  instructionSections: InstructionSection[];
}

export interface CompileInput {
  runtime: EffectiveRuntimeSelection;
  runtimeDescriptor: AgentRuntimeDescriptor;
  capabilityProfile: AgentCapabilityProfile;
  availability: AvailabilityContext;
  policy: SessionRuntimePlan['policy'];
  instructionSections?: InstructionSection[];
  orchestration?: SessionRuntimePlan['orchestration'];
  endpointCapabilities?: Pick<ProviderCapabilities, 'toolCalling'>;
}

export function compileSessionRuntimePlan(input: CompileInput): SessionRuntimePlan {
  const capabilities: SessionRuntimePlan['capabilities'] = [];
  const rejectedCapabilities: SessionRuntimePlan['rejectedCapabilities'] = [];
  const allowDegraded = new Set(input.capabilityProfile.allowDegraded);

  for (const id of input.capabilityProfile.requested) {
    const manifest = requireCapability(id);
    const resolved = resolveCapabilitySupport(
      manifest,
      input.runtimeDescriptor,
      input.availability,
      { writableWorkspace: input.policy.writableWorkspace },
      input.endpointCapabilities,
    );
    const optional = allowDegraded.has(id);

    if (resolved.support === 'native' || resolved.support === 'bridged') {
      capabilities.push({
        id,
        adapter: resolved.adapter!.kind,
        entrypoint: resolved.adapter!.entrypoint,
      });
      continue;
    }

    if (!optional) {
      throw new Error(
        `Capability ${id} is required but resolved to ${resolved.support} on runtime ${input.runtimeDescriptor.id}: ${resolved.reason ?? 'no reason'}`,
      );
    }
    rejectedCapabilities.push({
      id,
      reason: resolved.reason ?? `resolved ${resolved.support}`,
      required: false,
    });
  }

  return {
    orchestration: input.orchestration,
    runtime: input.runtime,
    capabilities,
    rejectedCapabilities,
    policy: input.policy,
    instructionSections: input.instructionSections ?? [],
  };
}
