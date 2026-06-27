import { validateProviderDescriptor, type ProviderDescriptor } from './provider-descriptor.js';

const descriptors = new Map<string, ProviderDescriptor>();

export function registerProviderDescriptor(descriptor: ProviderDescriptor): void {
  validateProviderDescriptor(descriptor);
  if (descriptors.has(descriptor.name)) {
    throw new Error(`Provider descriptor already registered: ${descriptor.name}`);
  }
  descriptors.set(descriptor.name, descriptor);
}

export function getProviderDescriptor(name: string): ProviderDescriptor | undefined {
  return descriptors.get(name.trim().toLowerCase());
}

export function requireProviderDescriptor(name: string): ProviderDescriptor {
  const descriptor = getProviderDescriptor(name);
  if (!descriptor) {
    const installed = listProviderDescriptors()
      .map((item) => item.name)
      .join(', ');
    throw new Error(`Unknown provider descriptor: ${name}. Installed: ${installed || '(none)'}`);
  }
  return descriptor;
}

export function listProviderDescriptors(): ProviderDescriptor[] {
  return [...descriptors.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listSetupProviderDescriptors(): ProviderDescriptor[] {
  return listProviderDescriptors().filter((descriptor) => descriptor.setup?.selectable === true);
}
