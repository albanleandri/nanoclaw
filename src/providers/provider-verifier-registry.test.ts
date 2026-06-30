import { describe, expect, it } from 'vitest';

import type { ProviderProfileRow } from '../types.js';
import {
  buildProviderToolProbe,
  registerProviderToolVerifier,
  registerProviderVerifier,
  verifyProviderProfile,
  verifyProviderTools,
  toolProbeAccepted,
} from './provider-verifier-registry.js';

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

  it('dispatches a separate structured tool verification probe', async () => {
    registerProviderToolVerifier('test-verifier', async (profile) => ({
      ok: true,
      toolCallingAccepted: true,
      fingerprint: `fp:${profile.id}`,
      verifiedAt: '2026-06-28T12:00:00.000Z',
    }));
    await expect(verifyProviderTools(base)).resolves.toMatchObject({
      ok: true,
      toolCallingAccepted: true,
      fingerprint: 'fp:profile',
    });
  });

  it('builds and validates family-specific no-side-effect tool probes', () => {
    const chat = { ...base, api_family: 'chat-completions', default_model: 'm' };
    const responses = { ...base, api_family: 'responses', default_model: 'm' };
    expect(buildProviderToolProbe(chat, 'nonce')).toMatchObject({ tool_choice: 'required' });
    expect(buildProviderToolProbe(responses, 'nonce')).toMatchObject({ tool_choice: 'required' });
    expect(
      toolProbeAccepted(
        chat,
        {
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'nanoclaw_capability_probe', arguments: '{"nonce":"nonce"}' } }],
              },
            },
          ],
        },
        'nonce',
      ),
    ).toBe(true);
    expect(
      toolProbeAccepted(
        responses,
        {
          output: [{ type: 'function_call', name: 'nanoclaw_capability_probe', arguments: '{"nonce":"nonce"}' }],
        },
        'nonce',
      ),
    ).toBe(true);
  });
});
