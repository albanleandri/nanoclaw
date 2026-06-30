import { getRuntimeDescriptor } from '../providers/runtime-descriptor-registry.js';
import { getCapability } from '../capabilities/capability-registry.js';
import '../providers/runtime-descriptors/index.js';
import '../capabilities/builtins/index.js';

export interface SkillManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  source: { kind: 'builtin' | 'private-submodule' | 'local'; id: string };
  requiresCapabilities: string[];
  optionalCapabilities?: string[];
  requiredConfig?: string[];
  requiredSecrets?: string[];
  compatibleRuntimeIds?: string[];
}

const KEYS = new Set([
  'schemaVersion',
  'name',
  'version',
  'source',
  'requiresCapabilities',
  'optionalCapabilities',
  'requiredConfig',
  'requiredSecrets',
  'compatibleRuntimeIds',
]);

function stringSet(value: unknown, field: string, pattern: RegExp): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !pattern.test(item))) {
    throw new Error(`Invalid skill manifest field: ${field}`);
  }
  if (new Set(value).size !== value.length) throw new Error(`Duplicate skill manifest value: ${field}`);
  return [...value].sort();
}

export function validateSkillManifest(value: unknown): SkillManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill manifest must be an object');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new Error(`Unknown skill manifest field: ${key}`);
  if (raw.schemaVersion !== 1) throw new Error('Unsupported skill manifest schemaVersion');
  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.name)) throw new Error('Invalid skill name');
  if (typeof raw.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(raw.version)) {
    throw new Error('Invalid skill version');
  }
  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source))
    throw new Error('Invalid skill source');
  const source = raw.source as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== 'kind' && key !== 'id')) {
    throw new Error('Unknown skill source field');
  }
  if (
    !['builtin', 'private-submodule', 'local'].includes(String(source.kind)) ||
    typeof source.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(source.id) ||
    source.id.includes('..')
  ) {
    throw new Error('Invalid skill source');
  }
  if (!Array.isArray(raw.requiresCapabilities)) throw new Error('Invalid skill manifest field: requiresCapabilities');
  const capabilities = stringSet(raw.requiresCapabilities, 'requiresCapabilities', /^[a-z0-9][a-z0-9.-]*$/);
  const optional = stringSet(raw.optionalCapabilities, 'optionalCapabilities', /^[a-z0-9][a-z0-9.-]*$/);
  if (optional.some((id) => capabilities.includes(id))) {
    throw new Error('Capability cannot be both required and optional');
  }
  for (const id of [...capabilities, ...optional]) if (!getCapability(id)) throw new Error(`Unknown capability: ${id}`);
  const runtimes = stringSet(raw.compatibleRuntimeIds, 'compatibleRuntimeIds', /^[a-z0-9][a-z0-9-]*$/);
  for (const id of runtimes) if (!getRuntimeDescriptor(id)) throw new Error(`Unknown runtime: ${id}`);
  return {
    schemaVersion: 1,
    name: raw.name,
    version: raw.version,
    source: { kind: source.kind as SkillManifest['source']['kind'], id: source.id },
    requiresCapabilities: capabilities,
    ...(optional.length ? { optionalCapabilities: optional } : {}),
    requiredConfig: stringSet(raw.requiredConfig, 'requiredConfig', /^[A-Z][A-Z0-9_]*$/),
    requiredSecrets: stringSet(raw.requiredSecrets, 'requiredSecrets', /^[A-Z][A-Z0-9_]*$/),
    ...(runtimes.length ? { compatibleRuntimeIds: runtimes } : {}),
  };
}
