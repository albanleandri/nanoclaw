import { describe, expect, it } from 'vitest';

import type { ProviderCapabilities } from './provider-descriptor.js';
import {
  runtimeCapabilitiesFromProvider,
  runtimeStateSemanticsFromProvider,
  validateRuntimeDescriptor,
  type AgentRuntimeDescriptor,
} from './runtime-descriptor.js';

const CLAUDE_CAPS: ProviderCapabilities = {
  streaming: true,
  mcp: 'native',
  toolCalling: 'native',
  continuation: 'durable',
  followUpMode: 'push-active-turn',
  structuredOutput: 'best-effort',
  media: { images: 'native', pdfs: 'native', audio: 'native' },
  reviewMode: { readOnly: true, isolatedWorkspace: false },
};

describe('runtime capability derivation', () => {
  it('keeps continuation and follow-up behavior in state semantics', () => {
    const capabilities = runtimeCapabilitiesFromProvider(CLAUDE_CAPS);
    expect(capabilities).toEqual({
      streaming: true,
      mcp: 'native',
      toolCalling: 'native',
      structuredOutput: 'best-effort',
      media: { images: 'native', pdfs: 'native', audio: 'native' },
      reviewMode: { readOnly: true, isolatedWorkspace: false },
    });
    expect('continuation' in capabilities).toBe(false);

    expect(runtimeStateSemanticsFromProvider(CLAUDE_CAPS)).toEqual({
      continuation: 'transcript',
      followUps: 'push-active-turn',
    });
    expect(
      runtimeStateSemanticsFromProvider({
        ...CLAUDE_CAPS,
        continuation: 'provider-thread',
        followUpMode: 'queue-turns',
      }),
    ).toEqual({ continuation: 'runtime-thread', followUps: 'queue-turns' });
    expect(runtimeStateSemanticsFromProvider({ ...CLAUDE_CAPS, continuation: 'none' }).continuation).toBe('none');
  });
});

describe('validateRuntimeDescriptor', () => {
  const base: AgentRuntimeDescriptor = {
    id: 'claude-sdk',
    kind: 'native-harness',
    containerFactory: 'claude',
    acceptedProtocols: ['native'],
    capabilities: runtimeCapabilitiesFromProvider(CLAUDE_CAPS),
    stateSemantics: runtimeStateSemanticsFromProvider(CLAUDE_CAPS),
  };

  it('accepts a well-formed descriptor', () => {
    expect(() => validateRuntimeDescriptor(base)).not.toThrow();
  });

  it('rejects invalid identity, factory, and protocol declarations', () => {
    expect(() => validateRuntimeDescriptor({ ...base, id: 'Claude_SDK' })).toThrow(/normalized/);
    expect(() => validateRuntimeDescriptor({ ...base, containerFactory: '' })).toThrow(/container factory/);
    expect(() => validateRuntimeDescriptor({ ...base, acceptedProtocols: [] })).toThrow(/protocol/);
  });
});
