import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { getIntegrationProfileRow } from '../db/integration-profiles.js';
import { runMigrations } from '../db/migrations/index.js';
import type { CredentialRef, CredentialStatus, HostCredentialStore, StagedCredential } from './credential-store.js';
import { HostIntegrationAdministration } from './administration.js';
import { createHostIntegrationRegistry } from './registry.js';
import type { HostIntegrationAdapter } from './types.js';

interface TestConfig {
  tenant: string;
}

interface TestPayload {
  username: string;
  password: string;
  personId: string;
}

class MemoryCredentialStore implements HostCredentialStore {
  active: unknown;
  unsafe = false;
  failPromote = false;
  failRevoke = false;
  private readonly staged = new Map<string, unknown>();

  async status(_ref: CredentialRef): Promise<CredentialStatus> {
    if (this.unsafe) return 'unsafe';
    return this.active === undefined ? 'missing' : 'available';
  }

  async read(_ref: CredentialRef): Promise<unknown> {
    if (this.active === undefined) throw new Error('missing');
    return this.active;
  }

  async stage(_ref: CredentialRef, value: unknown): Promise<StagedCredential> {
    const token = `stage-${this.staged.size + 1}`;
    this.staged.set(token, value);
    return { token };
  }

  async promote(staged: StagedCredential): Promise<void> {
    if (this.failPromote) throw new Error('promotion failed');
    this.active = this.staged.get(staged.token);
    this.staged.delete(staged.token);
  }

  async discard(staged: StagedCredential): Promise<void> {
    this.staged.delete(staged.token);
  }

  async revoke(_ref: CredentialRef): Promise<void> {
    if (this.failRevoke) throw new Error('revoke failed');
    this.active = undefined;
  }
}

function adapter(): HostIntegrationAdapter<TestConfig, TestPayload> {
  return {
    id: 'admin-test',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'A test-only form and cookie flow requires host authentication.',
    validateConfig(value) {
      const record = value as Record<string, unknown>;
      if (!record || Object.keys(record).join(',') !== 'tenant' || typeof record.tenant !== 'string') {
        throw new Error('invalid config');
      }
      return { tenant: record.tenant.trim() };
    },
    validateProtectedPayload(value) {
      const record = value as Record<string, unknown>;
      if (
        !record ||
        typeof record.username !== 'string' ||
        typeof record.password !== 'string' ||
        typeof record.personId !== 'string'
      ) {
        throw new Error(`invalid payload ${JSON.stringify(value)}`);
      }
      return { username: record.username, password: record.password, personId: record.personId };
    },
    protectedFields: [
      { name: 'username', sensitivity: 'private', label: 'Username' },
      { name: 'password', sensitivity: 'secret', label: 'Password' },
      { name: 'personId', sensitivity: 'private', label: 'Person selector' },
    ],
    operations: {
      'records.read': {
        name: 'records.read',
        sideEffects: 'none',
        validateInput: (value) => value,
        validateOutput: (value) => value,
        totalDeadlineMs: 1_000,
        network: {
          maxRedirects: 0,
          requestDeadlineMs: 500,
          maxCookies: 4,
          retry: { methods: [], statuses: [], maxAttempts: 1, maxRetryAfterMs: 0 },
          destinations: [
            {
              origin: 'https://admin.example.test',
              methods: ['GET'],
              isAllowedUrl: (url) => url.origin === 'https://admin.example.test',
            },
          ],
        },
        responseLimits: {
          maxHeaderBytes: 1_024,
          maxCookieBytes: 1_024,
          maxBodyBytes: 4_096,
          maxNormalizedOutputBytes: 2_048,
        },
        execute: async () => ({ ok: true }),
      },
    },
  };
}

function setup() {
  const registry = createHostIntegrationRegistry();
  registry.register(adapter());
  const store = new MemoryCredentialStore();
  const administration = new HostIntegrationAdministration(registry, (backend) =>
    backend === 'local-file' ? store : undefined,
  );
  return { administration, store };
}

async function createProfile(administration: HostIntegrationAdministration) {
  return administration.create({
    name: 'Portal',
    adapterId: 'admin-test',
    adapterVersion: 1,
    config: { tenant: 'example' },
    credentialBackend: 'local-file',
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(closeDb);

describe('host integration administration', () => {
  it('returns redacted profiles and field metadata without credential references', async () => {
    const { administration } = setup();
    const profile = await createProfile(administration);
    const schema = administration.credentialSchema(profile.id);
    const rendered = JSON.stringify({ profile, schema, list: await administration.list() });

    expect(profile).toMatchObject({ enabled: false, credential_status: 'missing', security_tier: 'trusted-host' });
    expect(schema.fields).toEqual(adapter().protectedFields);
    expect(rendered).not.toContain('credential_ref');
    expect(rendered).not.toMatch(/cred_[0-9a-f]{32}/u);
  });

  it('sets and rotates exact protected payloads without leaking sentinel values', async () => {
    const sentinel = 'SENTINEL_PHASE3_SECRET';
    const { administration, store } = setup();
    const profile = await createProfile(administration);
    const first = { username: 'private-user', password: sentinel, personId: 'private-person' };
    const result = await administration.setCredential(profile.id, first, 'set');

    expect(result).toEqual({ profile_id: profile.id, credential_status: 'available', action: 'set' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(getIntegrationProfileRow(profile.id)?.config_json).not.toContain(sentinel);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM integration_invocations').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_approvals').get()).toEqual({ count: 0 });

    const rotated = { ...first, password: 'replacement-secret' };
    expect(await administration.setCredential(profile.id, rotated, 'rotate')).toMatchObject({ action: 'rotated' });
    expect(store.active).toEqual(rotated);
  });

  it('uses fixed validation errors and rejects missing, extra, or stripped protected fields', async () => {
    const sentinel = 'SENTINEL_MUST_NOT_ESCAPE';
    const { administration } = setup();
    const profile = await createProfile(administration);
    const malformed = { username: 'u', password: sentinel, personId: 'p', [sentinel]: sentinel };

    await expect(administration.setCredential(profile.id, malformed, 'set')).rejects.toThrow(
      'Credential payload is invalid',
    );
    /* eslint-disable no-catch-all/no-catch-all -- test inspects the deliberately sanitized boundary error */
    try {
      await administration.setCredential(profile.id, { username: 'u', password: sentinel }, 'set');
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
    /* eslint-enable no-catch-all/no-catch-all */
  });

  it('preserves the active credential when rotation validation or promotion fails', async () => {
    const { administration, store } = setup();
    const profile = await createProfile(administration);
    const original = { username: 'u', password: 'old-secret', personId: 'p' };
    await administration.setCredential(profile.id, original, 'set');

    await expect(
      administration.setCredential(profile.id, { username: 'u', password: 'new-secret' }, 'rotate'),
    ).rejects.toThrow('Credential payload is invalid');
    expect(store.active).toEqual(original);

    store.failPromote = true;
    await expect(
      administration.setCredential(profile.id, { username: 'u', password: 'new-secret', personId: 'p' }, 'rotate'),
    ).rejects.toThrow(/inspect credential status/);
    expect(store.active).toEqual(original);
  });

  it('requires a valid stored payload before enabling and uses optimistic versions', async () => {
    const { administration } = setup();
    const profile = await createProfile(administration);
    await expect(administration.enable(profile.id, profile.version)).rejects.toThrow('Credential is unavailable');

    await administration.setCredential(profile.id, { username: 'u', password: 'secret', personId: 'p' }, 'set');
    const enabled = await administration.enable(profile.id, profile.version);
    expect(enabled).toMatchObject({ enabled: true, version: 2 });
    await expect(administration.disable(profile.id, profile.version)).rejects.toThrow(/conflict/);
  });

  it('disables before revocation and leaves the profile disabled when cleanup fails', async () => {
    const { administration, store } = setup();
    const profile = await createProfile(administration);
    await administration.setCredential(profile.id, { username: 'u', password: 'secret', personId: 'p' }, 'set');
    const enabled = await administration.enable(profile.id, profile.version);
    store.failRevoke = true;

    await expect(administration.revokeCredential(profile.id, enabled.version)).rejects.toThrow(/cleanup is required/);
    expect(getIntegrationProfileRow(profile.id)?.enabled).toBe(0);
    expect(store.active).toBeDefined();
  });

  it('reports externally managed backends without reading or exposing a reference', async () => {
    const { administration } = setup();
    const profile = await administration.create({
      name: 'External',
      adapterId: 'admin-test',
      adapterVersion: 1,
      config: { tenant: 'example' },
      credentialBackend: 'systemd',
    });
    expect(profile.credential_status).toBe('unsupported');
    await expect(administration.test(profile.id)).rejects.toThrow(/external operator management/);
    await expect(administration.revokeCredential(profile.id, profile.version)).rejects.toThrow(
      /disabled but external credential cleanup is required/,
    );
    expect(getIntegrationProfileRow(profile.id)).toMatchObject({ enabled: 0, version: 2 });
  });
});
