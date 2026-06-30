import { describe, expect, it } from 'vitest';

import { requireProviderDescriptor } from '../provider-descriptor-registry.js';
import { runtimeCapabilitiesFromProvider, runtimeStateSemanticsFromProvider } from '../runtime-descriptor.js';
import { getRuntimeDescriptor, getRuntimeDescriptorByContainerFactory } from '../runtime-descriptor-registry.js';
import './index.js';

const MAPPING: Array<[string, string, 'native-harness' | 'protocol-loop']> = [
  ['claude', 'claude-sdk', 'native-harness'],
  ['codex', 'codex-app-server', 'native-harness'],
  ['openai-compatible', 'openai-protocol-loop', 'protocol-loop'],
];

describe('core runtime descriptors', () => {
  it.each(MAPPING)('maps provider %s to runtime %s with matching capabilities', (providerName, runtimeId, kind) => {
    const provider = requireProviderDescriptor(providerName);
    const runtime = getRuntimeDescriptor(runtimeId);
    expect(runtime).toBeDefined();
    expect(runtime!.kind).toBe(kind);
    expect(runtime!.containerFactory).toBe(provider.runtime.containerProviderName);
    expect(runtime!.hostContribution).toBe(provider.runtime.hostContributionName);
    expect(runtime!.acceptedProtocols).toContain(provider.protocol);
    expect(runtime!.capabilities).toEqual(runtimeCapabilitiesFromProvider(provider.capabilities));
    expect(runtime!.stateSemantics).toEqual(runtimeStateSemanticsFromProvider(provider.capabilities));
  });

  it('resolves each runtime by provider container factory', () => {
    expect(getRuntimeDescriptorByContainerFactory('claude')?.id).toBe('claude-sdk');
    expect(getRuntimeDescriptorByContainerFactory('codex')?.id).toBe('codex-app-server');
    expect(getRuntimeDescriptorByContainerFactory('openai-compatible')?.id).toBe('openai-protocol-loop');
  });
});
