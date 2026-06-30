import { describe, expect, it } from 'vitest';

import type { ContainerConfig } from '../container-config.js';
import { providerToolFingerprint } from '../db/provider-profiles.js';
import type { ProviderProfileRow, Session } from '../types.js';
import { resolveEffectiveProviderConfig } from './effective-provider.js';

const config: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: 'all',
  provider: 'claude',
  model: 'group-model',
};

const session: Pick<Session, 'agent_provider' | 'provider_profile_id'> = {
  agent_provider: 'codex',
  provider_profile_id: null,
};

describe('effective provider resolution', () => {
  it('preserves legacy session, group, and default precedence', () => {
    expect(resolveEffectiveProviderConfig(session, config).provider).toBe('codex');
    expect(resolveEffectiveProviderConfig({ agent_provider: null }, config).provider).toBe('claude');
    expect(resolveEffectiveProviderConfig({ agent_provider: null }, { ...config, provider: undefined }).provider).toBe(
      'claude',
    );
  });

  it('uses a profile ahead of legacy fields and fingerprints conversation settings', () => {
    const profile: ProviderProfileRow = {
      id: 'profile-1',
      name: 'Claude profile',
      provider_name: 'claude',
      protocol: 'native',
      base_url: 'https://api.example.test',
      api_family: null,
      tool_strategy: 'none',
      default_model: 'profile-model',
      default_effort: 'high',
      auth_mode: 'oauth',
      auth_ref: 'Claude',
      capability_overrides: '{}',
      allow_insecure_http: 0,
      enabled: 1,
      created_at: '',
      updated_at: '',
    };
    const lookup = () => profile;
    const result = resolveEffectiveProviderConfig(
      { agent_provider: 'codex', provider_profile_id: profile.id },
      config,
      lookup,
    );
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('group-model');
    expect(result.runtimeStateKey).toMatch(/^profile:profile-1:[0-9a-f]{16}$/);

    const otherModel = resolveEffectiveProviderConfig(
      { agent_provider: 'codex', provider_profile_id: profile.id },
      { ...config, model: 'other-model' },
      lookup,
    );
    expect(otherModel.runtimeStateKey).not.toBe(result.runtimeStateKey);
  });

  it('fails closed for missing and disabled profiles', () => {
    expect(() =>
      resolveEffectiveProviderConfig({ agent_provider: null, provider_profile_id: 'missing' }, config, () => undefined),
    ).toThrow(/not found/);
    const disabled = {
      id: 'disabled',
      name: 'Disabled',
      provider_name: 'claude',
      protocol: 'native',
      enabled: 0,
    } as ProviderProfileRow;
    expect(() =>
      resolveEffectiveProviderConfig(
        { agent_provider: null, provider_profile_id: disabled.id },
        config,
        () => disabled,
      ),
    ).toThrow(/disabled/);
  });

  it('enables endpoint tools only for matching verification metadata', () => {
    const profile: ProviderProfileRow = {
      id: 'tools',
      name: 'Tools',
      provider_name: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: 'https://models.example.test/v1',
      api_family: 'responses',
      tool_strategy: 'native',
      tool_verified_at: '2026-06-28T12:00:00.000Z',
      tool_verification_fingerprint: null,
      default_model: 'model',
      default_effort: null,
      auth_mode: 'none',
      auth_ref: null,
      capability_overrides: '{}',
      allow_insecure_http: 0,
      enabled: 1,
      created_at: '',
      updated_at: '',
    };
    profile.tool_verification_fingerprint = providerToolFingerprint(profile);
    const result = resolveEffectiveProviderConfig(
      { agent_provider: null, provider_profile_id: profile.id },
      { ...config, model: undefined },
      () => profile,
    );
    expect(result.profile?.toolStrategy).toBe('native');
    expect(result.capabilities?.toolCalling).toBe('native');

    profile.tool_verification_fingerprint = 'stale';
    const stale = resolveEffectiveProviderConfig(
      { agent_provider: null, provider_profile_id: profile.id },
      { ...config, model: undefined },
      () => profile,
    );
    expect(stale.profile?.toolStrategy).toBe('none');
    expect(stale.capabilities?.toolCalling).toBe('none');
  });
});
