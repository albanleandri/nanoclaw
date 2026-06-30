import { describe, expect, it } from 'vitest';

import type { ProviderProfileRow } from '../types.js';
import type { EffectiveProviderConfig } from './effective-provider.js';
import {
  assertRuntimeSelectionParity,
  modelEndpointProfileFromRow,
  resolveEffectiveRuntimeSelection,
} from './effective-runtime.js';

describe('resolveEffectiveRuntimeSelection', () => {
  it('maps the provider factory while retaining model selection and state', () => {
    const config: EffectiveProviderConfig = { provider: 'claude', model: 'opus', runtimeStateKey: 'claude' };
    expect(resolveEffectiveRuntimeSelection(config)).toEqual({
      runtimeId: 'claude-sdk',
      endpointProfileId: undefined,
      model: 'opus',
      effort: undefined,
      runtimeStateKey: 'claude',
    });
  });

  it('carries endpoint profile identity and effort through', () => {
    const config: EffectiveProviderConfig = {
      provider: 'openai-compatible',
      model: 'gpt-x',
      effort: 'high',
      runtimeStateKey: 'profile:p1:abcd',
      profile: {
        id: 'p1',
        name: 'My endpoint',
        protocol: 'openai-compatible',
        toolStrategy: 'none',
        authMode: 'onecli-secret',
      },
    };
    const selection = resolveEffectiveRuntimeSelection(config);
    expect(selection.runtimeId).toBe('openai-protocol-loop');
    expect(selection.endpointProfileId).toBe('p1');
    expect(selection.effort).toBe('high');
  });

  it('throws when no runtime maps to the provider factory', () => {
    expect(() => resolveEffectiveRuntimeSelection({ provider: 'nonexistent', runtimeStateKey: 'nonexistent' })).toThrow(
      /no runtime descriptor/i,
    );
  });
});

describe('runtime selection compatibility helpers', () => {
  it('maps a DB profile to a model endpoint profile', () => {
    const row = {
      id: 'p1',
      name: 'Profile',
      provider_name: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: 'https://example.test/v1',
      default_model: 'gpt-x',
      auth_mode: 'onecli-secret',
      auth_ref: 'secret',
    } as ProviderProfileRow;
    expect(modelEndpointProfileFromRow(row)).toEqual({
      id: 'p1',
      providerFamily: 'openai-compatible',
      protocol: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      authMode: 'onecli-secret',
      authRef: 'secret',
      defaultModel: 'gpt-x',
    });
  });

  it('detects parity violations without rejecting matching selections', () => {
    const config: EffectiveProviderConfig = {
      provider: 'codex',
      model: 'gpt',
      effort: 'low',
      runtimeStateKey: 'codex',
    };
    expect(() => assertRuntimeSelectionParity(config, resolveEffectiveRuntimeSelection(config))).not.toThrow();
    expect(() =>
      assertRuntimeSelectionParity(config, {
        runtimeId: 'codex-app-server',
        model: 'WRONG',
        runtimeStateKey: 'codex',
      }),
    ).toThrow(/parity/i);
  });
});
