import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';

/**
 * Any registered provider name. Kept as a named alias for readability; the
 * set of valid names is open and determined at runtime by whichever provider
 * modules the `providers/index.ts` barrel imports.
 */
export type ProviderName = string;

export function createProvider(name: ProviderName, options: ProviderOptions = {}): AgentProvider {
  const provider = getProviderFactory(name)(options);
  if (options.memory?.enabled && (!provider.memoryDeliveryMode || provider.memoryDeliveryMode === 'unsupported')) {
    throw new Error(`Provider does not implement neutral memory delivery: ${name}`);
  }
  return provider;
}
