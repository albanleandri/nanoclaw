import { validateRuntimeDescriptor, type AgentRuntimeDescriptor } from './runtime-descriptor.js';

const descriptors = new Map<string, AgentRuntimeDescriptor>();

export function registerRuntimeDescriptor(descriptor: AgentRuntimeDescriptor): void {
  validateRuntimeDescriptor(descriptor);
  if (descriptors.has(descriptor.id)) {
    throw new Error(`Runtime descriptor already registered: ${descriptor.id}`);
  }
  descriptors.set(descriptor.id, descriptor);
}

export function getRuntimeDescriptor(id: string): AgentRuntimeDescriptor | undefined {
  return descriptors.get(id.trim().toLowerCase());
}

export function requireRuntimeDescriptor(id: string): AgentRuntimeDescriptor {
  const descriptor = getRuntimeDescriptor(id);
  if (!descriptor) {
    const installed = listRuntimeDescriptors()
      .map((item) => item.id)
      .join(', ');
    throw new Error(`Unknown runtime descriptor: ${id}. Installed: ${installed || '(none)'}`);
  }
  return descriptor;
}

export function getRuntimeDescriptorByContainerFactory(name: string): AgentRuntimeDescriptor | undefined {
  const target = name.trim().toLowerCase();
  return listRuntimeDescriptors().find((descriptor) => descriptor.containerFactory.toLowerCase() === target);
}

export function listRuntimeDescriptors(): AgentRuntimeDescriptor[] {
  return [...descriptors.values()].sort((a, b) => a.id.localeCompare(b.id));
}
