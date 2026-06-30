import type { ProviderProfileRow } from '../types.js';
import type { EffectiveProviderConfig } from './effective-provider.js';
import './runtime-descriptors/index.js';
import type { EffectiveRuntimeSelection, ModelEndpointProfile } from './runtime-descriptor.js';
import { getRuntimeDescriptorByContainerFactory } from './runtime-descriptor-registry.js';

/**
 * Map the resolved compatibility configuration onto the runtime/endpoint
 * model. Phase A computes this in shadow and does not drive container config.
 */
export function resolveEffectiveRuntimeSelection(config: EffectiveProviderConfig): EffectiveRuntimeSelection {
  const runtime = getRuntimeDescriptorByContainerFactory(config.provider);
  if (!runtime) {
    throw new Error(`No runtime descriptor maps to provider container factory: ${config.provider}`);
  }
  return {
    runtimeId: runtime.id,
    endpointProfileId: config.profile?.id,
    model: config.model,
    effort: config.effort,
    runtimeStateKey: config.runtimeStateKey,
  };
}

export function modelEndpointProfileFromRow(row: ProviderProfileRow): ModelEndpointProfile {
  return {
    id: row.id,
    providerFamily: row.provider_name,
    protocol: row.protocol as ModelEndpointProfile['protocol'],
    baseUrl: row.base_url || undefined,
    authMode: row.auth_mode,
    authRef: row.auth_ref || undefined,
    defaultModel: row.default_model || undefined,
  };
}

export function assertRuntimeSelectionParity(
  config: EffectiveProviderConfig,
  selection: EffectiveRuntimeSelection,
): void {
  const mismatches: string[] = [];
  if (selection.model !== config.model) mismatches.push(`model ${selection.model} != ${config.model}`);
  if (selection.effort !== config.effort) mismatches.push(`effort ${selection.effort} != ${config.effort}`);
  if (selection.runtimeStateKey !== config.runtimeStateKey) {
    mismatches.push(`runtimeStateKey ${selection.runtimeStateKey} != ${config.runtimeStateKey}`);
  }
  if (selection.endpointProfileId !== config.profile?.id) {
    mismatches.push(`endpointProfileId ${selection.endpointProfileId} != ${config.profile?.id}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`Runtime selection parity violation: ${mismatches.join('; ')}`);
  }
}
