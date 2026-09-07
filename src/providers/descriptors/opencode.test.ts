import { describe, expect, it } from 'vitest';

import { requireProviderDescriptor } from '../provider-descriptor-registry.js';
import './index.js';

describe('OpenCode provider descriptor', () => {
  it('registers the native OpenCode runtime and its actual capabilities', () => {
    const descriptor = requireProviderDescriptor('opencode');
    expect(descriptor.runtime).toEqual({ containerProviderName: 'opencode', hostContributionName: 'opencode' });
    expect(descriptor.auth.modes).toContain('onecli-secret');
    expect(descriptor.capabilities.mcp).toBe('native');
    expect(descriptor.capabilities.followUpMode).toBe('push-active-turn');
  });
});
