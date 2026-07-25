import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });

  it('fails provider creation when enabled memory has no delivery implementation', () => {
    expect(() =>
      createProvider('mock', {
        memory: { enabled: true, render: () => '<memory />' },
      }),
    ).toThrow('does not implement neutral memory delivery');
  });

  it('does not require a memory delivery implementation while memory is disabled', () => {
    expect(
      createProvider('mock', {
        memory: { enabled: false, render: () => '<memory />' },
      }),
    ).toBeInstanceOf(MockProvider);
  });
});
