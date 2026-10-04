/* eslint-disable no-catch-all/no-catch-all, preserve-caught-error -- protected values must never be attached to boundary errors */
import {
  createIntegrationProfile,
  grantIntegrationProfileOperation,
  listIntegrationProfileGrants,
  listIntegrationProfileRows,
  requireIntegrationProfile,
  revokeIntegrationProfileGrant,
  setIntegrationProfileEnabled,
  updateIntegrationProfile,
  type CreateIntegrationProfileInput,
  type IntegrationProfile,
} from '../db/integration-profiles.js';
import type { IntegrationCredentialBackend, IntegrationProfileGrantRow } from '../types.js';
import type { CredentialStatus, HostCredentialStore, StagedCredential } from './credential-store.js';
import { LocalFileCredentialStore } from './local-file-credential-store.js';
import { validateAndClassifyProtectedPayload } from './protected-payload.js';
import {
  requireHostIntegrationAdapter,
  requireHostIntegrationOperation,
  type HostIntegrationRegistry,
} from './registry.js';
import type { HostIntegrationAdapterLike, ProtectedField } from './types.js';

export type RedactedCredentialStatus = CredentialStatus | 'unsupported';

export interface RedactedIntegrationProfile {
  id: string;
  name: string;
  adapter_id: string;
  adapter_version: number;
  config: Record<string, unknown>;
  credential_backend: IntegrationCredentialBackend;
  credential_status: RedactedCredentialStatus;
  security_tier: 'trusted-host';
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface IntegrationCredentialSchema {
  profile_id: string;
  adapter_id: string;
  adapter_version: number;
  fields: readonly ProtectedField[];
}

type RegistryReader = Pick<HostIntegrationRegistry, 'require' | 'requireOperation'>;
type StoreResolver = (backend: IntegrationCredentialBackend) => HostCredentialStore | undefined;

const defaultRegistry: RegistryReader = {
  require: requireHostIntegrationAdapter,
  requireOperation: requireHostIntegrationOperation,
};
const localFileStore = new LocalFileCredentialStore();

function defaultStoreResolver(backend: IntegrationCredentialBackend): HostCredentialStore | undefined {
  return backend === 'local-file' ? localFileStore : undefined;
}

export class HostIntegrationAdministration {
  constructor(
    private readonly registry: RegistryReader = defaultRegistry,
    private readonly resolveStore: StoreResolver = defaultStoreResolver,
  ) {}

  async list(): Promise<RedactedIntegrationProfile[]> {
    const profiles = listIntegrationProfileRows().map((row) => requireIntegrationProfile(row.id, this.registry));
    return Promise.all(profiles.map((profile) => this.redact(profile)));
  }

  async get(idOrName: string): Promise<RedactedIntegrationProfile> {
    return this.redact(requireIntegrationProfile(idOrName, this.registry));
  }

  async create(input: Omit<CreateIntegrationProfileInput, 'id' | 'createdAt'>): Promise<RedactedIntegrationProfile> {
    return this.redact(createIntegrationProfile(input, this.registry));
  }

  async update(
    idOrName: string,
    expectedVersion: number,
    input: { name?: string; config?: unknown },
  ): Promise<RedactedIntegrationProfile> {
    const current = requireIntegrationProfile(idOrName, this.registry);
    return this.redact(updateIntegrationProfile(current.id, expectedVersion, input, this.registry));
  }

  async enable(idOrName: string, expectedVersion: number): Promise<RedactedIntegrationProfile> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    assertExpectedVersion(profile, expectedVersion);
    await this.validateStoredCredential(profile);
    return this.redact(setIntegrationProfileEnabled(profile.id, expectedVersion, true, this.registry));
  }

  async disable(idOrName: string, expectedVersion: number): Promise<RedactedIntegrationProfile> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    return this.redact(setIntegrationProfileEnabled(profile.id, expectedVersion, false, this.registry));
  }

  async grant(idOrName: string, agentGroupId: string, operation: string): Promise<IntegrationProfileGrantRow> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    return grantIntegrationProfileOperation(profile.id, agentGroupId, operation, this.registry);
  }

  async revokeGrant(idOrName: string, agentGroupId: string, operation: string): Promise<{ revoked: boolean }> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    this.registry.requireOperation(profile.adapter_id, profile.adapter_version, operation);
    return { revoked: revokeIntegrationProfileGrant(profile.id, agentGroupId, operation) };
  }

  async grants(idOrName: string): Promise<IntegrationProfileGrantRow[]> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    return listIntegrationProfileGrants(profile.id);
  }

  credentialSchema(idOrName: string): IntegrationCredentialSchema {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    const adapter = this.registry.require(profile.adapter_id, profile.adapter_version);
    return {
      profile_id: profile.id,
      adapter_id: adapter.id,
      adapter_version: adapter.version,
      fields: adapter.protectedFields.map((field) => ({ ...field })),
    };
  }

  async setCredential(
    idOrName: string,
    candidate: unknown,
    mode: 'set' | 'rotate',
  ): Promise<{ profile_id: string; credential_status: 'available'; action: 'set' | 'rotated' }> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    const store = this.requireStore(profile);
    const status = await store.status(profile.credential_ref);
    if (status === 'unsafe') throw new Error('Credential storage requires operator cleanup');
    if (mode === 'set' && status === 'available') {
      throw new Error('Credential is already configured; use credential rotate');
    }
    if (mode === 'rotate' && status !== 'available') {
      throw new Error('Credential is unavailable; use credential set');
    }

    const adapter = this.registry.require(profile.adapter_id, profile.adapter_version);
    const validated = validateCandidate(adapter, candidate);
    let staged: StagedCredential;
    try {
      staged = await store.stage(profile.credential_ref, validated);
    } catch {
      throw new Error('Credential could not be staged');
    }
    try {
      await store.promote(staged);
    } catch {
      await discardBestEffort(store, staged);
      throw new Error('Credential promotion failed; inspect credential status before retrying');
    }
    return {
      profile_id: profile.id,
      credential_status: 'available',
      action: mode === 'set' ? 'set' : 'rotated',
    };
  }

  async test(idOrName: string): Promise<{
    profile_id: string;
    credential_status: 'available';
    validation: 'protected-payload-valid';
    upstream_checked: false;
  }> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    await this.validateStoredCredential(profile);
    return {
      profile_id: profile.id,
      credential_status: 'available',
      validation: 'protected-payload-valid',
      upstream_checked: false,
    };
  }

  async revokeCredential(
    idOrName: string,
    expectedVersion: number,
  ): Promise<{ profile_id: string; enabled: false; credential_status: 'missing' }> {
    const profile = requireIntegrationProfile(idOrName, this.registry);
    const disabled = setIntegrationProfileEnabled(profile.id, expectedVersion, false, this.registry);
    const store = this.resolveStore(profile.credential_backend);
    if (!store) throw new Error('Profile is disabled but external credential cleanup is required');
    try {
      await store.revoke(disabled.credential_ref);
    } catch {
      throw new Error('Profile is disabled but credential cleanup is required');
    }
    return { profile_id: profile.id, enabled: false, credential_status: 'missing' };
  }

  private async validateStoredCredential(profile: IntegrationProfile): Promise<void> {
    const store = this.requireStore(profile);
    const status = await store.status(profile.credential_ref);
    if (status === 'missing') throw new Error('Credential is unavailable');
    if (status === 'unsafe') throw new Error('Credential storage requires operator cleanup');
    let candidate: unknown;
    try {
      candidate = await store.read(profile.credential_ref);
    } catch {
      throw new Error('Credential is unavailable');
    }
    const adapter = this.registry.require(profile.adapter_id, profile.adapter_version);
    validateCandidate(adapter, candidate);
  }

  private requireStore(profile: IntegrationProfile): HostCredentialStore {
    const store = this.resolveStore(profile.credential_backend);
    if (!store) throw new Error('Credential backend requires external operator management');
    return store;
  }

  private async redact(profile: IntegrationProfile): Promise<RedactedIntegrationProfile> {
    const store = this.resolveStore(profile.credential_backend);
    const credentialStatus = store ? await store.status(profile.credential_ref) : 'unsupported';
    return {
      id: profile.id,
      name: profile.name,
      adapter_id: profile.adapter_id,
      adapter_version: profile.adapter_version,
      config: profile.config,
      credential_backend: profile.credential_backend,
      credential_status: credentialStatus,
      security_tier: profile.security_tier,
      enabled: profile.enabled === 1,
      version: profile.version,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  }
}

function assertExpectedVersion(profile: IntegrationProfile, expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || profile.version !== expectedVersion) {
    throw new Error('Integration profile update conflict');
  }
}

function validateCandidate(adapter: HostIntegrationAdapterLike, value: unknown): Record<string, unknown> {
  try {
    if (!isExactProtectedObject(adapter, value)) throw new Error('invalid protected object');
    return validateAndClassifyProtectedPayload(adapter, value);
  } catch {
    // Adapter validators are trusted code, but their error strings are not
    // allowed to echo protected field values onto the CLI response surface.
    throw new Error('Credential payload is invalid');
  }
}

function isExactProtectedObject(adapter: HostIntegrationAdapterLike, value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== Object.keys(value).length) return false;
  const expected = adapter.protectedFields.map((field) => field.name).sort();
  return (keys as string[]).sort().join('\0') === expected.join('\0');
}

async function discardBestEffort(store: HostCredentialStore, staged: Parameters<HostCredentialStore['promote']>[0]) {
  try {
    await store.discard(staged);
  } catch {
    // A staged file is never active. The original promotion failure is safer
    // and more useful than replacing it with a cleanup error.
  }
}

export const hostIntegrationAdministration = new HostIntegrationAdministration();
/* eslint-enable no-catch-all/no-catch-all, preserve-caught-error */
