import { createHash } from 'crypto';

import type { ContainerConfig } from '../container-config.js';
import { getProviderProfile } from '../db/provider-profiles.js';
import type { ProviderProfileRow, Session } from '../types.js';
import type { ProviderCapabilities, ProviderProtocol } from './provider-descriptor.js';
import '../providers/descriptors/index.js';
import { requireProviderDescriptor } from './provider-descriptor-registry.js';

export interface EffectiveProviderProfile {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  apiFamily?: 'responses' | 'chat-completions';
  toolStrategy: 'none';
  authMode: string;
  authRef?: string;
}

export interface EffectiveProviderConfig {
  provider: string;
  model?: string;
  effort?: string;
  runtimeStateKey: string;
  capabilities?: ProviderCapabilities;
  profile?: EffectiveProviderProfile;
}

function mergeCapabilities(defaults: ProviderCapabilities, rawOverrides: string): ProviderCapabilities {
  const overrides = JSON.parse(rawOverrides || '{}') as Partial<ProviderCapabilities>;
  return {
    ...defaults,
    ...overrides,
    media: { ...defaults.media, ...(overrides.media ?? {}) },
    reviewMode: { ...defaults.reviewMode, ...(overrides.reviewMode ?? {}) },
  };
}

function profileStateKey(profile: ProviderProfileRow, provider: string, model: string | undefined): string {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        provider,
        baseUrl: profile.base_url,
        apiFamily: profile.api_family,
        model,
        toolStrategy: profile.tool_strategy,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return `profile:${profile.id}:${fingerprint}`;
}

export function resolveEffectiveProviderConfig(
  session: Pick<Session, 'agent_provider' | 'provider_profile_id'>,
  containerConfig: ContainerConfig,
  lookupProfile: (id: string) => ProviderProfileRow | undefined = getProviderProfile,
): EffectiveProviderConfig {
  const profileId = session.provider_profile_id || containerConfig.providerProfileId;
  if (!profileId) {
    const provider = (session.agent_provider || containerConfig.provider || 'claude').toLowerCase();
    return {
      provider,
      model: containerConfig.model,
      effort: containerConfig.effort,
      runtimeStateKey: provider,
    };
  }

  const profile = lookupProfile(profileId);
  if (!profile) throw new Error(`Provider profile not found: ${profileId}`);
  if (profile.enabled !== 1) throw new Error(`Provider profile is disabled: ${profile.name}`);
  const descriptor = requireProviderDescriptor(profile.provider_name);
  if (profile.protocol !== descriptor.protocol) {
    throw new Error(`Provider profile protocol mismatch: ${profile.name}`);
  }
  const provider = descriptor.runtime.containerProviderName.toLowerCase();
  const model = containerConfig.model || profile.default_model || descriptor.models.defaultModel;
  return {
    provider,
    model: model || undefined,
    effort: containerConfig.effort || profile.default_effort || undefined,
    runtimeStateKey: profileStateKey(profile, provider, model || undefined),
    capabilities: mergeCapabilities(descriptor.capabilities, profile.capability_overrides),
    profile: {
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol as ProviderProtocol,
      baseUrl: profile.base_url || undefined,
      apiFamily: (profile.api_family as 'responses' | 'chat-completions' | null) || undefined,
      toolStrategy: 'none',
      authMode: profile.auth_mode,
      authRef: profile.auth_ref || undefined,
    },
  };
}
