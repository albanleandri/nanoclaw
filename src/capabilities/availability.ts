import type { CapabilityAdapter } from './capability-manifest.js';

export interface AvailabilityContext {
  configuredMcpServers: Set<string>;
  writableWorkspace: boolean;
  availableBinaries?: Set<string>;
}

export type AvailabilityCheckFn = (context: AvailabilityContext, adapter: CapabilityAdapter) => boolean;

const checks = new Map<string, AvailabilityCheckFn>();

export function registerAvailabilityCheck(name: string, check: AvailabilityCheckFn): void {
  if (checks.has(name)) throw new Error(`Availability check already registered: ${name}`);
  checks.set(name, check);
}

/** Availability checks are pure; unknown checks fail closed. */
export function runAvailabilityCheck(name: string, context: AvailabilityContext, adapter: CapabilityAdapter): boolean {
  return checks.get(name)?.(context, adapter) ?? false;
}

registerAvailabilityCheck('mcp-server-configured', (context, adapter) => {
  if (!adapter.entrypoint.startsWith('mcp:')) return false;
  return context.configuredMcpServers.has(adapter.entrypoint.slice('mcp:'.length));
});
