import { describe, expect, it } from 'vitest';

import { validateCapabilityManifest, type CapabilityManifest } from './capability-manifest.js';

const manifest: CapabilityManifest = {
  id: 'nanoclaw.send-message',
  version: 1,
  description: 'Deliver a message through the host.',
  requirements: {},
  sideEffects: 'external-write',
  approval: 'never',
  adapters: [{ kind: 'host-action', entrypoint: 'host:send-message' }],
};

describe('validateCapabilityManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => validateCapabilityManifest(manifest)).not.toThrow();
  });

  it('rejects malformed identity, version, and adapter declarations', () => {
    expect(() => validateCapabilityManifest({ ...manifest, id: 'SendMessage' })).toThrow(/id/);
    expect(() => validateCapabilityManifest({ ...manifest, version: 0 })).toThrow(/version/);
    expect(() => validateCapabilityManifest({ ...manifest, adapters: [] })).toThrow(/adapter/);
  });
});
