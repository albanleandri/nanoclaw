import { randomUUID } from 'node:crypto';

import { createCredentialRef, parseCredentialRef, type CredentialRef } from '../integrations/credential-store.js';
import {
  requireHostIntegrationAdapter,
  requireHostIntegrationOperation,
  type HostIntegrationRegistry,
} from '../integrations/registry.js';
import type { IntegrationCredentialBackend, IntegrationProfileGrantRow, IntegrationProfileRow } from '../types.js';
import { getDb } from './connection.js';

const MAX_PROFILE_NAME_LENGTH = 80;
const MAX_CONFIG_JSON_BYTES = 64 * 1024;
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'bearer',
  'cookie',
  'authorization',
  'credential',
  'username',
  'userid',
  'accountid',
  'personid',
] as const;

type RegistryReader = Pick<HostIntegrationRegistry, 'require' | 'requireOperation'>;

const defaultRegistry: RegistryReader = {
  require: requireHostIntegrationAdapter,
  requireOperation: requireHostIntegrationOperation,
};

export interface IntegrationProfile<Config extends object = Record<string, unknown>> extends Omit<
  IntegrationProfileRow,
  'config_json' | 'credential_ref'
> {
  config: Config;
  credential_ref: CredentialRef;
}

export interface CreateIntegrationProfileInput {
  id?: string;
  name: string;
  adapterId: string;
  adapterVersion: number;
  config: unknown;
  credentialBackend: IntegrationCredentialBackend;
  createdAt?: string;
}

export interface UpdateIntegrationProfileInput {
  name?: string;
  config?: unknown;
  updatedAt?: string;
}

export function createIntegrationProfile(
  input: CreateIntegrationProfileInput,
  registry: RegistryReader = defaultRegistry,
): IntegrationProfile {
  const adapter = registry.require(input.adapterId, input.adapterVersion);
  const name = validateProfileName(input.name);
  const configJson = validateAndCanonicalizeConfig(input.config, adapter);
  const credentialRef = createCredentialRef();
  if (input.credentialBackend !== 'local-file' && input.credentialBackend !== 'systemd') {
    throw new Error('Invalid integration credential backend');
  }
  const timestamp = input.createdAt ?? new Date().toISOString();
  const id = input.id ?? `integration-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO integration_profiles (
        id, name, adapter_id, adapter_version, config_json,
        credential_backend, credential_ref, security_tier, enabled,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    )
    .run(
      id,
      name,
      adapter.id,
      adapter.version,
      configJson,
      input.credentialBackend,
      credentialRef,
      adapter.securityTier,
      timestamp,
      timestamp,
    );
  return requireIntegrationProfile(id, registry);
}

export function getIntegrationProfileRow(idOrName: string): IntegrationProfileRow | undefined {
  return getDb()
    .prepare('SELECT * FROM integration_profiles WHERE id = ? OR name = ? LIMIT 1')
    .get(idOrName, idOrName) as IntegrationProfileRow | undefined;
}

export function getIntegrationProfile(
  idOrName: string,
  registry: RegistryReader = defaultRegistry,
): IntegrationProfile | undefined {
  const row = getIntegrationProfileRow(idOrName);
  return row ? materializeProfile(row, registry) : undefined;
}

export function requireIntegrationProfile(
  idOrName: string,
  registry: RegistryReader = defaultRegistry,
): IntegrationProfile {
  const profile = getIntegrationProfile(idOrName, registry);
  if (!profile) throw new Error('Integration profile not found');
  return profile;
}

export function listIntegrationProfileRows(): IntegrationProfileRow[] {
  return getDb().prepare('SELECT * FROM integration_profiles ORDER BY name, id').all() as IntegrationProfileRow[];
}

export function updateIntegrationProfile(
  id: string,
  expectedVersion: number,
  input: UpdateIntegrationProfileInput,
  registry: RegistryReader = defaultRegistry,
): IntegrationProfile {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Invalid integration profile version');
  }
  if (input.name === undefined && input.config === undefined) {
    throw new Error('Integration profile update is empty');
  }
  const current = getIntegrationProfileRow(id);
  if (!current) throw new Error('Integration profile update conflict');
  const adapter = registry.require(current.adapter_id, current.adapter_version);
  const name = input.name === undefined ? current.name : validateProfileName(input.name);
  const configJson =
    input.config === undefined ? current.config_json : validateAndCanonicalizeConfig(input.config, adapter);
  const result = getDb()
    .prepare(
      `UPDATE integration_profiles
       SET name = ?, config_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(name, configJson, input.updatedAt ?? new Date().toISOString(), id, expectedVersion);
  if (result.changes !== 1) throw new Error('Integration profile update conflict');
  return requireIntegrationProfile(id, registry);
}

export function setIntegrationProfileEnabled(
  id: string,
  expectedVersion: number,
  enabled: boolean,
  registry: RegistryReader = defaultRegistry,
  updatedAt = new Date().toISOString(),
): IntegrationProfile {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Invalid integration profile version');
  }
  const result = getDb()
    .prepare(
      `UPDATE integration_profiles
       SET enabled = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(enabled ? 1 : 0, updatedAt, id, expectedVersion);
  if (result.changes !== 1) throw new Error('Integration profile update conflict');
  return requireIntegrationProfile(id, registry);
}

export function grantIntegrationProfileOperation(
  profileId: string,
  agentGroupId: string,
  operation: string,
  registry: RegistryReader = defaultRegistry,
  grantedAt = new Date().toISOString(),
): IntegrationProfileGrantRow {
  const row = getIntegrationProfileRow(profileId);
  if (!row) throw new Error('Integration profile not found');
  if (!getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(agentGroupId)) {
    throw new Error('Agent group not found');
  }
  registry.requireOperation(row.adapter_id, row.adapter_version, operation);
  getDb()
    .prepare(
      `INSERT INTO integration_profile_grants
       (profile_id, agent_group_id, operation, granted_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(row.id, agentGroupId, operation, grantedAt);
  return { profile_id: row.id, agent_group_id: agentGroupId, operation, granted_at: grantedAt };
}

export function revokeIntegrationProfileGrant(profileId: string, agentGroupId: string, operation: string): boolean {
  return (
    getDb()
      .prepare(
        `DELETE FROM integration_profile_grants
         WHERE profile_id = ? AND agent_group_id = ? AND operation = ?`,
      )
      .run(profileId, agentGroupId, operation).changes === 1
  );
}

export function listIntegrationProfileGrants(profileId?: string): IntegrationProfileGrantRow[] {
  if (profileId) {
    return getDb()
      .prepare(
        `SELECT * FROM integration_profile_grants
         WHERE profile_id = ? ORDER BY agent_group_id, operation`,
      )
      .all(profileId) as IntegrationProfileGrantRow[];
  }
  return getDb()
    .prepare('SELECT * FROM integration_profile_grants ORDER BY profile_id, agent_group_id, operation')
    .all() as IntegrationProfileGrantRow[];
}

export function hasIntegrationProfileGrant(profileId: string, agentGroupId: string, operation: string): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 FROM integration_profile_grants
         WHERE profile_id = ? AND agent_group_id = ? AND operation = ?`,
      )
      .get(profileId, agentGroupId, operation),
  );
}

export function listGrantedIntegrationProfileRows(
  agentGroupId: string,
  adapterId: string,
  adapterVersion: number,
  operation: string,
): IntegrationProfileRow[] {
  return getDb()
    .prepare(
      `SELECT p.*
       FROM integration_profiles p
       JOIN integration_profile_grants g ON g.profile_id = p.id
       WHERE g.agent_group_id = ? AND p.adapter_id = ? AND p.adapter_version = ? AND g.operation = ?
       ORDER BY p.name, p.id`,
    )
    .all(agentGroupId, adapterId, adapterVersion, operation) as IntegrationProfileRow[];
}

function materializeProfile(row: IntegrationProfileRow, registry: RegistryReader): IntegrationProfile {
  const adapter = registry.require(row.adapter_id, row.adapter_version);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json) as unknown;
  } catch (error) {
    throw new Error('Integration profile configuration is invalid', { cause: error });
  }
  const canonical = validateAndCanonicalizeConfig(parsed, adapter);
  if (canonical !== row.config_json) {
    throw new Error('Integration profile configuration is not canonical');
  }
  const config = adapter.validateConfig(parsed);
  return {
    id: row.id,
    name: row.name,
    adapter_id: row.adapter_id,
    adapter_version: row.adapter_version,
    config,
    credential_backend: row.credential_backend,
    credential_ref: parseCredentialRef(row.credential_ref),
    security_tier: row.security_tier,
    enabled: row.enabled,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateAndCanonicalizeConfig(value: unknown, adapter: ReturnType<RegistryReader['require']>): string {
  assertConfigValue(value);
  assertNoSensitiveConfigKeys(
    value,
    adapter.protectedFields.map((field) => field.name),
  );
  const validated = adapter.validateConfig(value);
  assertConfigValue(validated);
  assertNoFieldsStripped(value, validated);
  assertNoSensitiveConfigKeys(
    validated,
    adapter.protectedFields.map((field) => field.name),
  );
  const canonical = canonicalJson(validated);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CONFIG_JSON_BYTES) {
    throw new Error('Integration profile configuration is too large');
  }
  return canonical;
}

function assertNoFieldsStripped(original: unknown, validated: unknown): void {
  if (Array.isArray(original)) {
    if (!Array.isArray(validated) || original.length !== validated.length) {
      throw new Error('Integration profile configuration contains an unknown field');
    }
    original.forEach((value, index) => assertNoFieldsStripped(value, validated[index]));
    return;
  }
  if (!original || typeof original !== 'object') return;
  if (!validated || typeof validated !== 'object' || Array.isArray(validated)) {
    throw new Error('Integration profile configuration contains an unknown field');
  }
  for (const [key, child] of Object.entries(original)) {
    if (!Object.prototype.hasOwnProperty.call(validated, key)) {
      throw new Error('Integration profile configuration contains an unknown field');
    }
    assertNoFieldsStripped(child, (validated as Record<string, unknown>)[key]);
  }
}

function validateProfileName(value: string): string {
  const name = value.trim();
  const hasControlCharacter = [...name].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
  if (!name || name.length > MAX_PROFILE_NAME_LENGTH || hasControlCharacter) {
    throw new Error('Integration profile name is invalid');
  }
  return name;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function assertNoSensitiveConfigKeys(value: unknown, protectedNames: readonly string[]): void {
  const protectedKeys = new Set(protectedNames.map(normalizeKey));
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = normalizeKey(key);
      if (protectedKeys.has(normalized) || SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))) {
        throw new Error('Integration profile configuration contains a protected or secret-like field');
      }
      visit(child);
    }
  };
  visit(value);
}

function assertConfigValue(value: unknown, seen = new Set<object>()): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('Integration profile configuration must be a plain object');
  }
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('Integration profile configuration is not JSON-safe');
      return;
    }
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new Error('Integration profile configuration is not JSON-safe');
      seen.add(candidate);
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== 'object' || Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new Error('Integration profile configuration is not JSON-safe');
    }
    if (seen.has(candidate)) throw new Error('Integration profile configuration is not JSON-safe');
    seen.add(candidate);
    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.some((key) => typeof key !== 'string') || ownKeys.length !== Object.keys(candidate).length) {
      throw new Error('Integration profile configuration is not JSON-safe');
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
