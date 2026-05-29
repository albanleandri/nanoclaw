import type { JobTypeDefinition } from './types.js';

const jobTypes = new Map<string, JobTypeDefinition>();

export function registerJobType<TParams>(definition: JobTypeDefinition<TParams>): void {
  if (!definition.type.trim()) throw new Error('Job type is required');
  if (jobTypes.has(definition.type)) throw new Error(`Job type already registered: ${definition.type}`);
  jobTypes.set(definition.type, definition as JobTypeDefinition);
}

export function getJobType(type: string): JobTypeDefinition | undefined {
  return jobTypes.get(type);
}

export function listJobTypes(): JobTypeDefinition[] {
  return [...jobTypes.values()];
}

export function clearJobTypesForTesting(): void {
  jobTypes.clear();
}
