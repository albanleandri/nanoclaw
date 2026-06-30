import '../descriptors/index.js';

import { requireProviderDescriptor } from '../provider-descriptor-registry.js';
import {
  runtimeCapabilitiesFromProvider,
  runtimeStateSemanticsFromProvider,
  type AgentRuntimeKind,
} from '../runtime-descriptor.js';
import { registerRuntimeDescriptor } from '../runtime-descriptor-registry.js';

// This fixed compatibility mapping is derived from provider descriptors so
// capability facts remain single-sourced during the migration.
const MAPPING: Array<{ provider: string; runtimeId: string; kind: AgentRuntimeKind }> = [
  { provider: 'claude', runtimeId: 'claude-sdk', kind: 'native-harness' },
  { provider: 'codex', runtimeId: 'codex-app-server', kind: 'native-harness' },
  { provider: 'openai-compatible', runtimeId: 'openai-protocol-loop', kind: 'protocol-loop' },
];

for (const { provider, runtimeId, kind } of MAPPING) {
  const descriptor = requireProviderDescriptor(provider);
  registerRuntimeDescriptor({
    id: runtimeId,
    kind,
    containerFactory: descriptor.runtime.containerProviderName,
    hostContribution: descriptor.runtime.hostContributionName,
    acceptedProtocols: [descriptor.protocol],
    capabilities: runtimeCapabilitiesFromProvider(descriptor.capabilities),
    stateSemantics: runtimeStateSemanticsFromProvider(descriptor.capabilities),
  });
}
