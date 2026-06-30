import { describe, expect, it } from 'vitest';

import {
  runtimeCapabilitiesFromProvider,
  runtimeStateSemanticsFromProvider,
  type AgentRuntimeDescriptor,
} from './runtime-descriptor.js';
import {
  getRuntimeDescriptor,
  getRuntimeDescriptorByContainerFactory,
  listRuntimeDescriptors,
  registerRuntimeDescriptor,
  requireRuntimeDescriptor,
} from './runtime-descriptor-registry.js';

const CAPS = {
  streaming: true,
  mcp: 'native',
  toolCalling: 'native',
  continuation: 'durable',
  followUpMode: 'push-active-turn',
  structuredOutput: 'best-effort',
  media: { images: 'native', pdfs: 'native', audio: 'native' },
  reviewMode: { readOnly: true, isolatedWorkspace: false },
} as const;

function descriptor(id: string, containerFactory: string): AgentRuntimeDescriptor {
  return {
    id,
    kind: 'native-harness',
    containerFactory,
    acceptedProtocols: ['native'],
    capabilities: runtimeCapabilitiesFromProvider(CAPS),
    stateSemantics: runtimeStateSemanticsFromProvider(CAPS),
  };
}

describe('runtime descriptor registry', () => {
  it('registers and retrieves by id and container factory', () => {
    registerRuntimeDescriptor(descriptor('test-runtime-a2', 'factory-a2'));
    expect(getRuntimeDescriptor('TEST-RUNTIME-A2')?.containerFactory).toBe('factory-a2');
    expect(getRuntimeDescriptorByContainerFactory('FACTORY-A2')?.id).toBe('test-runtime-a2');
    expect(listRuntimeDescriptors().some((item) => item.id === 'test-runtime-a2')).toBe(true);
  });

  it('rejects duplicates and explains unknown ids', () => {
    registerRuntimeDescriptor(descriptor('dup-runtime-a2', 'factory-dup'));
    expect(() => registerRuntimeDescriptor(descriptor('dup-runtime-a2', 'factory-dup2'))).toThrow(/already/);
    expect(() => requireRuntimeDescriptor('no-such-runtime')).toThrow(/Unknown runtime descriptor/);
  });
});
