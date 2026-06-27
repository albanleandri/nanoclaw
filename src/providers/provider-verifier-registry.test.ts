import { describe, expect, it } from 'vitest';

import type { ProviderProfileRow } from '../types.js';
import { registerProviderVerifier, verifyProviderProfile } from './provider-verifier-registry.js';

const base: ProviderProfileRow = {
  id: 'profile',
  name: 'Profile',
  provider_name: 'test-verifier',
  protocol: 'native',
  base_url: null,
  api_family: null,
  tool_strategy: 'none',
  default_model: null,
  default_effort: null,
  auth_mode: 'none',
  auth_ref: null,
  capability_overrides: '{}',
  allow_insecure_http: 0,
  enabled: 1,
  created_at: '',
  updated_at: '',
};

describe('provider verifier registry', () => {
  it('dispatches structured verification independently from descriptor metadata', async () => {
    registerProviderVerifier('test-verifier', async () => ({
      ok: true,
      reachable: true,
      authenticated: true,
      modelAccepted: true,
      protocolAccepted: true,
    }));
    await expect(verifyProviderProfile(base)).resolves.toMatchObject({ ok: true, authenticated: true });
  });

  it('fails clearly when no verifier is installed', async () => {
    await expect(verifyProviderProfile({ ...base, provider_name: 'missing-verifier' })).resolves.toMatchObject({
      ok: false,
      classification: 'unsupported',
    });
  });
});
