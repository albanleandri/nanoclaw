import { validateCapabilityManifest, type CapabilityManifest } from './capability-manifest.js';

const manifests = new Map<string, CapabilityManifest>();

export function registerCapability(manifest: CapabilityManifest): void {
  validateCapabilityManifest(manifest);
  if (manifests.has(manifest.id)) {
    throw new Error(`Capability already registered: ${manifest.id}`);
  }
  manifests.set(manifest.id, manifest);
}

export function getCapability(id: string): CapabilityManifest | undefined {
  return manifests.get(id.trim().toLowerCase());
}

export function requireCapability(id: string): CapabilityManifest {
  const manifest = getCapability(id);
  if (!manifest) {
    const registered = listCapabilities()
      .map((item) => item.id)
      .join(', ');
    throw new Error(`Unknown capability: ${id}. Registered: ${registered || '(none)'}`);
  }
  return manifest;
}

export function listCapabilities(): CapabilityManifest[] {
  return [...manifests.values()].sort((a, b) => a.id.localeCompare(b.id));
}
