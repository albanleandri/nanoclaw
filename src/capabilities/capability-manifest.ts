export type CapabilityAdapterKind = 'native-runtime' | 'mcp' | 'protocol-tool' | 'runner-local' | 'host-action';

export interface CapabilityRequirements {
  toolCalling?: 'native-or-bridged';
  mcp?: boolean;
  workspace?: 'read' | 'write';
  network?: boolean;
  media?: Array<'image' | 'pdf' | 'audio'>;
  durableState?: boolean;
}

export interface CapabilityAdapter {
  kind: CapabilityAdapterKind;
  runtimeIds?: string[];
  entrypoint: string;
  availabilityCheck?: string;
}

export interface CapabilityManifest {
  id: string;
  version: number;
  description: string;
  requirements: CapabilityRequirements;
  sideEffects: 'none' | 'local-write' | 'external-write' | 'credentialed';
  approval: 'never' | 'policy' | 'always';
  adapters: CapabilityAdapter[];
}

export type CapabilitySupport = 'native' | 'bridged' | 'degraded' | 'unsupported';

const ADAPTER_KINDS = new Set<CapabilityAdapterKind>([
  'native-runtime',
  'mcp',
  'protocol-tool',
  'runner-local',
  'host-action',
]);

export function validateCapabilityManifest(manifest: CapabilityManifest): void {
  if (!manifest.id || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id)) {
    throw new Error(
      `Capability id must be dotted lowercase (for example nanoclaw.send-message): ${manifest.id || '(empty)'}`,
    );
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error(`Capability ${manifest.id} must declare a positive integer version`);
  }
  if (!manifest.description.trim()) throw new Error(`Capability ${manifest.id} has no description`);
  if (manifest.adapters.length === 0) {
    throw new Error(`Capability ${manifest.id} must declare at least one adapter`);
  }
  for (const adapter of manifest.adapters) {
    if (!ADAPTER_KINDS.has(adapter.kind)) {
      throw new Error(`Capability ${manifest.id} has invalid adapter kind: ${adapter.kind}`);
    }
    if (!adapter.entrypoint.trim()) {
      throw new Error(`Capability ${manifest.id} adapter has no entrypoint`);
    }
  }
}
