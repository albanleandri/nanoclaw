import { describe, expect, it } from 'vitest';

import './descriptors/index.js';
import { listProviderContainerConfigNames } from './provider-container-registry.js';
import {
  getProviderDescriptor,
  listProviderDescriptors,
  listSetupProviderDescriptors,
  registerProviderDescriptor,
  requireProviderDescriptor,
} from './provider-descriptor-registry.js';

describe('provider descriptor registry', () => {
  it('lists core descriptors independently from host contributions', () => {
    expect(listProviderDescriptors().map((item) => item.name)).toEqual([
      'claude',
      'codex',
      'mock',
      'openai-compatible',
    ]);
    expect(listProviderContainerConfigNames()).toEqual([]);
  });

  it('offers only explicitly selectable providers during setup', () => {
    expect(listSetupProviderDescriptors().map((item) => item.name)).toEqual(['claude', 'codex', 'openai-compatible']);
    expect(getProviderDescriptor('MOCK')?.setup?.selectable).toBe(false);
  });

  it('rejects duplicate and malformed descriptors', () => {
    const claude = requireProviderDescriptor('claude');
    expect(() => registerProviderDescriptor(claude)).toThrow(/already registered/);
    expect(() => registerProviderDescriptor({ ...claude, name: 'Not Normalized' })).toThrow(/normalized lowercase/);
  });

  it('reports installed descriptors for unknown names', () => {
    expect(() => requireProviderDescriptor('missing')).toThrow(/Installed: claude, codex, mock, openai-compatible/);
  });
});
