import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostIntegrationRegistry, type HostIntegrationRegistry } from '../integrations/registry.js';
import type { HostIntegrationAdapter } from '../integrations/types.js';
import { SCHEMA } from './schema.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import { createAgentGroup } from './agent-groups.js';
import {
  createIntegrationProfile,
  getIntegrationProfile,
  getIntegrationProfileRow,
  grantIntegrationProfileOperation,
  hasIntegrationProfileGrant,
  listGrantedIntegrationProfileRows,
  listIntegrationProfileGrants,
  revokeIntegrationProfileGrant,
  updateIntegrationProfile,
} from './integration-profiles.js';
import { runMigrations } from './migrations/index.js';

interface TestConfig {
  region: string;
  tenant: string;
}

interface TestProtectedPayload {
  username: string;
  password: string;
  personId: string;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`invalid ${label}`);
  return record;
}

function adapter(
  validateConfig?: (value: unknown) => TestConfig,
): HostIntegrationAdapter<TestConfig, TestProtectedPayload> {
  return {
    id: 'test-portal',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'The test portal requires a host-owned form login and cookie flow.',
    validateConfig:
      validateConfig ??
      ((value) => {
        const record = exactObject(value, ['region', 'tenant'], 'config');
        if (typeof record.region !== 'string' || typeof record.tenant !== 'string') throw new Error('invalid config');
        return { region: record.region.trim().toLowerCase(), tenant: record.tenant.trim() };
      }),
    validateProtectedPayload(value) {
      const record = exactObject(value, ['password', 'personId', 'username'], 'protected payload');
      if (
        typeof record.username !== 'string' ||
        typeof record.password !== 'string' ||
        typeof record.personId !== 'string'
      ) {
        throw new Error('invalid protected payload');
      }
      return record as unknown as TestProtectedPayload;
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
        totalDeadlineMs: 5_000,
        network: {
          maxRedirects: 0,
          destinations: [
            {
              origin: 'https://portal.example.test',
              methods: ['GET'],
              isAllowedUrl: (url) => url.origin === 'https://portal.example.test',
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

function registry(validateConfig?: (value: unknown) => TestConfig): HostIntegrationRegistry {
  const result = createHostIntegrationRegistry();
  result.register(adapter(validateConfig));
  return result;
}

function createProfile(registryValue: HostIntegrationRegistry = registry()) {
  return createIntegrationProfile(
    {
      id: 'profile-1',
      name: 'Household portal',
      adapterId: 'test-portal',
      adapterVersion: 1,
      config: { tenant: ' tenant-a ', region: 'CH' },
      credentialBackend: 'local-file',
      createdAt: '2026-10-03T08:00:00.000Z',
    },
    registryValue,
  );
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(closeDb);

describe('host integration migration', () => {
  it('matches the reference schema for all three tables and their indexes', () => {
    const start = SCHEMA.indexOf('-- Trusted-host integration metadata.');
    const end = SCHEMA.indexOf('-- Shared-resource ownership', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const reference = new Database(':memory:');
    try {
      reference.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY); CREATE TABLE sessions (id TEXT PRIMARY KEY);');
      reference.exec(SCHEMA.slice(start, end));
      const names = [
        'integration_profiles',
        'integration_profile_grants',
        'integration_invocations',
        'idx_integration_profiles_adapter',
        'idx_integration_profile_grants_group',
        'idx_integration_invocations_profile_started',
        'idx_integration_invocations_status_started',
      ];
      const readDefinitions = (db: Database.Database) =>
        db
          .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE name IN (${names.map(() => '?').join(',')}) ORDER BY type, name`,
          )
          .all(...names)
          .map((row) => ({
            ...(row as Record<string, unknown>),
            sql: String((row as { sql: string }).sql)
              .replace(/\s+/gu, ' ')
              .trim(),
          }));
      expect(readDefinitions(getDb())).toEqual(readDefinitions(reference));
    } finally {
      reference.close();
    }
  });
});

describe('integration profiles', () => {
  it('creates a disabled profile with adapter-canonicalized configuration', () => {
    const registryValue = registry();
    const profile = createProfile(registryValue);
    expect(profile).toMatchObject({
      id: 'profile-1',
      adapter_id: 'test-portal',
      adapter_version: 1,
      config: { region: 'ch', tenant: 'tenant-a' },
      enabled: 0,
      version: 1,
      security_tier: 'trusted-host',
    });
    expect(getIntegrationProfileRow(profile.id)?.config_json).toBe('{"region":"ch","tenant":"tenant-a"}');
    expect(profile.credential_ref).toMatch(/^cred_[0-9a-f]{32}$/u);
  });

  it('fails closed on unknown adapters, versions, fields, protected keys, and malformed stored JSON', () => {
    const registryValue = registry();
    const base = {
      name: 'Portal',
      adapterId: 'test-portal',
      adapterVersion: 1,
      config: { region: 'ch', tenant: 'tenant-a' },
      credentialBackend: 'local-file' as const,
    };
    expect(() => createIntegrationProfile({ ...base, adapterId: 'missing' }, registryValue)).toThrow(/Unknown/);
    expect(() => createIntegrationProfile({ ...base, adapterVersion: 2 }, registryValue)).toThrow(/Unknown/);
    expect(() => createIntegrationProfile({ ...base, config: { ...base.config, extra: true } }, registryValue)).toThrow(
      /config/,
    );
    expect(() =>
      createIntegrationProfile({ ...base, config: { ...base.config, password: 'sentinel-secret' } }, registryValue),
    ).toThrow(/protected|secret-like/);
    expect(() =>
      createIntegrationProfile({ ...base, config: { ...base.config, apiKey: 'sentinel-secret' } }, registryValue),
    ).toThrow(/protected|secret-like/);
    expect(() =>
      createIntegrationProfile({ ...base, config: { ...base.config, personId: 'private-selector' } }, registryValue),
    ).toThrow(/protected|secret-like/);

    const profile = createProfile(registryValue);
    getDb().prepare("UPDATE integration_profiles SET config_json = '{not-json' WHERE id = ?").run(profile.id);
    expect(() => getIntegrationProfile(profile.id, registryValue)).toThrow(/configuration is invalid/);
  });

  it('fails closed when persisted config is non-canonical or contains a stripped field', () => {
    const registryValue = registry((value) => {
      const record = value as Record<string, unknown>;
      return { region: String(record.region).toLowerCase(), tenant: String(record.tenant) };
    });
    const profile = createProfile(registryValue);
    getDb()
      .prepare('UPDATE integration_profiles SET config_json = ? WHERE id = ?')
      .run('{"tenant":"tenant-a","region":"ch"}', profile.id);
    expect(() => getIntegrationProfile(profile.id, registryValue)).toThrow(/not canonical/);
    getDb()
      .prepare('UPDATE integration_profiles SET config_json = ? WHERE id = ?')
      .run('{"ignored":true,"region":"ch","tenant":"tenant-a"}', profile.id);
    expect(() => getIntegrationProfile(profile.id, registryValue)).toThrow(/unknown field/);
  });

  it('rejects validators that silently strip unknown input fields', () => {
    const registryValue = registry((value) => {
      const record = value as Record<string, unknown>;
      return { region: String(record.region), tenant: String(record.tenant) };
    });
    expect(() =>
      createIntegrationProfile(
        {
          name: 'Portal',
          adapterId: 'test-portal',
          adapterVersion: 1,
          config: { region: 'ch', tenant: 'tenant-a', ignored: 'must-not-be-stripped' },
          credentialBackend: 'local-file',
        },
        registryValue,
      ),
    ).toThrow(/unknown field/);
  });

  it('uses optimistic version checks for non-secret updates', () => {
    const registryValue = registry();
    const profile = createProfile(registryValue);
    const updated = updateIntegrationProfile(
      profile.id,
      1,
      { name: 'Portal primary', config: { tenant: 'tenant-b', region: 'FR' }, updatedAt: '2026-10-03T09:00:00Z' },
      registryValue,
    );
    expect(updated).toMatchObject({
      name: 'Portal primary',
      config: { region: 'fr', tenant: 'tenant-b' },
      version: 2,
      enabled: 0,
    });
    expect(() => updateIntegrationProfile(profile.id, 1, { name: 'stale' }, registryValue)).toThrow(/conflict/);
  });
});

describe('integration profile grants', () => {
  it('accepts only registered read operations and existing agent groups', () => {
    const registryValue = registry();
    const profile = createProfile(registryValue);
    createAgentGroup({
      id: 'agent-a',
      name: 'Agent A',
      folder: 'agent-a',
      agent_provider: null,
      created_at: '2026-10-03T08:00:00Z',
    });
    expect(() => grantIntegrationProfileOperation(profile.id, 'missing-agent', 'records.read', registryValue)).toThrow(
      /Agent group/,
    );
    expect(() => grantIntegrationProfileOperation(profile.id, 'agent-a', 'records.write', registryValue)).toThrow(
      /Unknown host integration operation/,
    );

    grantIntegrationProfileOperation(profile.id, 'agent-a', 'records.read', registryValue, '2026-10-03T08:30:00Z');
    expect(hasIntegrationProfileGrant(profile.id, 'agent-a', 'records.read')).toBe(true);
    expect(listIntegrationProfileGrants(profile.id)).toHaveLength(1);
    expect(listGrantedIntegrationProfileRows('agent-a', 'test-portal', 'records.read')).toEqual([
      getIntegrationProfileRow(profile.id),
    ]);
    expect(revokeIntegrationProfileGrant(profile.id, 'agent-a', 'records.read')).toBe(true);
    expect(revokeIntegrationProfileGrant(profile.id, 'agent-a', 'records.read')).toBe(false);
  });

  it('cascades grants without placing credential material in grant rows', () => {
    const registryValue = registry();
    const profile = createProfile(registryValue);
    createAgentGroup({
      id: 'agent-a',
      name: 'Agent A',
      folder: 'agent-a',
      agent_provider: null,
      created_at: '2026-10-03T08:00:00Z',
    });
    grantIntegrationProfileOperation(profile.id, 'agent-a', 'records.read', registryValue);
    getDb().prepare('DELETE FROM integration_profiles WHERE id = ?').run(profile.id);
    expect(listIntegrationProfileGrants()).toEqual([]);
  });
});
