import type { ProviderCapabilities, ProviderProtocol } from './provider-descriptor.js';

export type AgentRuntimeKind = 'native-harness' | 'protocol-loop';

export interface RuntimeCapabilities {
  streaming: boolean;
  mcp: 'native' | 'stdio-adapter' | 'none';
  toolCalling: 'native' | 'prompt-mediated' | 'none';
  structuredOutput: 'strict' | 'best-effort' | 'none';
  media: ProviderCapabilities['media'];
  reviewMode: ProviderCapabilities['reviewMode'];
}

export interface RuntimeStateSemantics {
  continuation: 'runtime-thread' | 'transcript' | 'none';
  followUps: 'push-active-turn' | 'queue-turns' | 'unsupported';
}

export interface AgentRuntimeDescriptor {
  id: string;
  kind: AgentRuntimeKind;
  containerFactory: string;
  hostContribution?: string;
  acceptedProtocols: ProviderProtocol[];
  capabilities: RuntimeCapabilities;
  stateSemantics: RuntimeStateSemantics;
}

export interface ModelEndpointProfile {
  id: string;
  providerFamily: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  authMode: string;
  authRef?: string;
  defaultModel?: string;
}

export interface EffectiveRuntimeSelection {
  runtimeId: string;
  endpointProfileId?: string;
  model?: string;
  effort?: string;
  runtimeStateKey: string;
}

/** Derive runtime-owned facts without duplicating provider descriptor data. */
export function runtimeCapabilitiesFromProvider(capabilities: ProviderCapabilities): RuntimeCapabilities {
  return {
    streaming: capabilities.streaming,
    mcp: capabilities.mcp,
    toolCalling: capabilities.toolCalling,
    structuredOutput: capabilities.structuredOutput,
    media: { ...capabilities.media },
    reviewMode: { ...capabilities.reviewMode },
  };
}

export function runtimeStateSemanticsFromProvider(capabilities: ProviderCapabilities): RuntimeStateSemantics {
  const continuation: RuntimeStateSemantics['continuation'] =
    capabilities.continuation === 'provider-thread'
      ? 'runtime-thread'
      : capabilities.continuation === 'none'
        ? 'none'
        : 'transcript';
  return { continuation, followUps: capabilities.followUpMode };
}

export function validateRuntimeDescriptor(descriptor: AgentRuntimeDescriptor): void {
  if (
    !descriptor.id ||
    descriptor.id !== descriptor.id.trim().toLowerCase() ||
    !/^[a-z0-9][a-z0-9-]*$/.test(descriptor.id)
  ) {
    throw new Error(`Runtime descriptor id must be normalized lowercase: ${descriptor.id || '(empty)'}`);
  }
  if (descriptor.kind !== 'native-harness' && descriptor.kind !== 'protocol-loop') {
    throw new Error(`Runtime descriptor ${descriptor.id} has invalid kind: ${descriptor.kind}`);
  }
  if (!descriptor.containerFactory.trim()) {
    throw new Error(`Runtime descriptor ${descriptor.id} has no container factory`);
  }
  if (descriptor.acceptedProtocols.length === 0) {
    throw new Error(`Runtime descriptor ${descriptor.id} must accept at least one protocol`);
  }
}
