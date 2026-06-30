import { describe, expect, it } from 'vitest';

import type { CapabilityManifest } from './capability-manifest.js';
import { getCapability, listCapabilities, registerCapability, requireCapability } from './capability-registry.js';

const manifest: CapabilityManifest = {
  id: 'test.b2-cap',
  version: 1,
  description: 'Test capability.',
  requirements: {},
  sideEffects: 'none',
  approval: 'never',
  adapters: [{ kind: 'host-action', entrypoint: 'host:test' }],
};

describe('capability registry', () => {
  it('registers, normalizes lookup, and lists manifests', () => {
    registerCapability(manifest);
    expect(getCapability('TEST.B2-CAP')?.version).toBe(1);
    expect(listCapabilities().some((item) => item.id === manifest.id)).toBe(true);
  });

  it('rejects duplicates and explains unknown ids', () => {
    registerCapability({ ...manifest, id: 'test.b2-dup' });
    expect(() => registerCapability({ ...manifest, id: 'test.b2-dup' })).toThrow(/already/);
    expect(() => requireCapability('test.b2-missing')).toThrow(/Unknown capability/);
  });
});
